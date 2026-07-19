/**
 * Instagram publisher — Meta Graph API (Instagram Graph API via a connected
 * Business/Creator account). Two-step publish flow:
 *   1. POST /{igUserId}/media           → create a media container (returns creation_id)
 *   2. POST /{igUserId}/media_publish   → publish that container
 * Video containers (Reels) process asynchronously on Meta's side, so we poll
 * GET /{containerId}?fields=status_code until FINISHED (bounded retries)
 * before publishing.
 *
 * Requires a Business/Creator IG account connected to a Facebook Page, and a
 * User/Page access token with instagram_content_publish permission.
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
import type { Platform } from '../../domain/enums.ts';
import { Platform as P } from '../../domain/enums.ts';
import type { PublishRequest, PublishResult } from '../../domain/ports.ts';
import { ExternalApiError, ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { sleep } from '../../shared/clock.ts';
import { BasePublisher, type BasePublisherOptions } from './base-publisher.ts';

export interface InstagramConfig {
  accessToken: string;
  igUserId: string;
}

export interface InstagramPublisherOptions extends BasePublisherOptions {
  graphVersion?: string;
  /** Video container processing poll settings. */
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

interface MediaContainerResponse {
  id: string;
}
interface ContainerStatusResponse {
  status_code?: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  id?: string;
}
interface MediaPublishResponse {
  id: string;
}
interface PermalinkResponse {
  permalink?: string;
}

export class InstagramPublisher extends BasePublisher {
  readonly platform: Platform = P.instagram;
  private cfg: InstagramConfig;
  private graphVersion: string;
  private pollIntervalMs: number;
  private maxPollAttempts: number;

  constructor(cfg: InstagramConfig, opts: InstagramPublisherOptions = {}) {
    super(opts);
    this.cfg = cfg;
    this.graphVersion = opts.graphVersion ?? 'v21.0';
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.maxPollAttempts = opts.maxPollAttempts ?? 20;
  }

  isConfigured(): boolean {
    return !!(this.cfg.accessToken && this.cfg.igUserId);
  }

  private base(): string {
    return `https://graph.facebook.com/${this.graphVersion}`;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.dryRun || !this.isConfigured()) return this.dryRunResult(req);

    const video = this.primaryVideo(req);
    const asset = this.primaryImageAsset(req);
    const caption = this.composeCaption(req);

    let creationId: string;
    if (video?.url) {
      creationId = await this.createVideoContainer(video.url, caption);
      await this.waitForContainerReady(creationId);
    } else if (asset?.url) {
      creationId = await this.createImageContainer(asset.url, caption);
    } else {
      throw new ValidationError('no public media URL for instagram');
    }

    const published = await httpJson<MediaPublishResponse>(`${this.base()}/${this.cfg.igUserId}/media_publish`, {
      method: 'POST',
      provider: 'instagram',
      body: new URLSearchParams({ creation_id: creationId, access_token: this.cfg.accessToken }),
      timeoutMs: 30_000,
    });

    const permalink = await this.fetchPermalink(published.id);
    return { status: 'published', remoteId: published.id, permalink, raw: { creationId, published } };
  }

  private async createImageContainer(imageUrl: string, caption: string): Promise<string> {
    const res = await httpJson<MediaContainerResponse>(`${this.base()}/${this.cfg.igUserId}/media`, {
      method: 'POST',
      provider: 'instagram',
      body: new URLSearchParams({ image_url: imageUrl, caption, access_token: this.cfg.accessToken }),
      timeoutMs: 30_000,
    });
    return res.id;
  }

  private async createVideoContainer(videoUrl: string, caption: string): Promise<string> {
    const res = await httpJson<MediaContainerResponse>(`${this.base()}/${this.cfg.igUserId}/media`, {
      method: 'POST',
      provider: 'instagram',
      body: new URLSearchParams({
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        access_token: this.cfg.accessToken,
      }),
      timeoutMs: 30_000,
    });
    return res.id;
  }

  private async waitForContainerReady(containerId: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt++) {
      const status = await httpJson<ContainerStatusResponse>(`${this.base()}/${containerId}`, {
        provider: 'instagram',
        query: { fields: 'status_code', access_token: this.cfg.accessToken },
        timeoutMs: 15_000,
      });
      if (status.status_code === 'FINISHED') return;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new ExternalApiError('instagram', `media container ${containerId} failed: ${status.status_code}`, {
          responseBody: status,
        });
      }
      await sleep(this.pollIntervalMs);
    }
    throw new ExternalApiError('instagram', `media container ${containerId} did not finish processing in time`);
  }

  private async fetchPermalink(mediaId: string): Promise<string | undefined> {
    try {
      const res = await httpJson<PermalinkResponse>(`${this.base()}/${mediaId}`, {
        provider: 'instagram',
        query: { fields: 'permalink', access_token: this.cfg.accessToken },
        timeoutMs: 15_000,
      });
      return res.permalink;
    } catch {
      return undefined;
    }
  }

  /**
   * Native scheduling via the Graph API is only supported for Facebook Page
   * posts, not Instagram media containers — IG has no `published=false`
   * option on /media. Fall back to the generic base-class scheduler.
   */
  override async schedule(req: PublishRequest, whenIso: string): Promise<PublishResult> {
    return super.schedule(req, whenIso);
  }

  override async analytics(remoteId: string): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) return {};
    try {
      const res = await httpJson<Record<string, unknown>>(`${this.base()}/${remoteId}/insights`, {
        provider: 'instagram',
        query: {
          metric: 'impressions,reach,likes,comments,saved,shares',
          access_token: this.cfg.accessToken,
        },
        timeoutMs: 15_000,
      });
      return res;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  override async delete(remoteId: string): Promise<void> {
    if (!this.isConfigured()) return;
    await httpJson(`${this.base()}/${remoteId}`, {
      method: 'DELETE',
      provider: 'instagram',
      query: { access_token: this.cfg.accessToken },
      timeoutMs: 15_000,
    });
  }
}
