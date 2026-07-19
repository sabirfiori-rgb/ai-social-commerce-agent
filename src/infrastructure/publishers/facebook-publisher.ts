/**
 * Facebook publisher — Meta Graph API, Page-scoped.
 *   - Image: POST /{pageId}/photos      (url, caption, access_token)
 *   - Video: POST /{pageId}/videos      (file_url, description, access_token)
 *   - Text/link only: POST /{pageId}/feed (message, link?, access_token)
 * The Graph API supports native scheduling on /feed and /photos/videos via
 * `published=false` + `scheduled_publish_time` (unix seconds, 10 min–75 days
 * in the future), so schedule() uses that instead of the generic fallback.
 * Docs: https://developers.facebook.com/docs/pages-api/posts
 */
import type { Platform } from '../../domain/enums.ts';
import { Platform as P } from '../../domain/enums.ts';
import type { PublishRequest, PublishResult } from '../../domain/ports.ts';
import { ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { BasePublisher, type BasePublisherOptions } from './base-publisher.ts';

export interface FacebookConfig {
  pageId: string;
  pageAccessToken: string;
}

export interface FacebookPublisherOptions extends BasePublisherOptions {
  graphVersion?: string;
}

interface FbPostResponse {
  id: string;
  post_id?: string;
}

export class FacebookPublisher extends BasePublisher {
  readonly platform: Platform = P.facebook;
  private cfg: FacebookConfig;
  private graphVersion: string;

  constructor(cfg: FacebookConfig, opts: FacebookPublisherOptions = {}) {
    super(opts);
    this.cfg = cfg;
    this.graphVersion = opts.graphVersion ?? 'v21.0';
  }

  isConfigured(): boolean {
    return !!(this.cfg.pageId && this.cfg.pageAccessToken);
  }

  private base(): string {
    return `https://graph.facebook.com/${this.graphVersion}`;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.dryRun || !this.isConfigured()) return this.dryRunResult(req);

    const caption = this.composeCaption(req);
    const video = this.primaryVideo(req);
    const asset = this.primaryImageAsset(req);

    let res: FbPostResponse;
    if (video?.url) {
      res = await httpJson<FbPostResponse>(`${this.base()}/${this.cfg.pageId}/videos`, {
        method: 'POST',
        provider: 'facebook',
        body: new URLSearchParams({
          file_url: video.url,
          description: caption,
          access_token: this.cfg.pageAccessToken,
        }),
        timeoutMs: 60_000,
      });
    } else if (asset?.url) {
      res = await httpJson<FbPostResponse>(`${this.base()}/${this.cfg.pageId}/photos`, {
        method: 'POST',
        provider: 'facebook',
        body: new URLSearchParams({
          url: asset.url,
          caption,
          access_token: this.cfg.pageAccessToken,
        }),
        timeoutMs: 30_000,
      });
    } else {
      res = await httpJson<FbPostResponse>(`${this.base()}/${this.cfg.pageId}/feed`, {
        method: 'POST',
        provider: 'facebook',
        body: new URLSearchParams({
          message: caption,
          access_token: this.cfg.pageAccessToken,
        }),
        timeoutMs: 30_000,
      });
    }

    const remoteId = res.post_id ?? res.id;
    return {
      status: 'published',
      remoteId,
      permalink: `https://www.facebook.com/${remoteId}`,
      raw: res,
    };
  }

  /** Native Graph API scheduling: published=false + scheduled_publish_time. */
  override async schedule(req: PublishRequest, whenIso: string): Promise<PublishResult> {
    if (this.dryRun || !this.isConfigured()) return this.dryRunResult(req);

    const scheduledUnix = Math.floor(new Date(whenIso).getTime() / 1000);
    if (!Number.isFinite(scheduledUnix)) {
      throw new ValidationError(`invalid schedule time for facebook: ${whenIso}`);
    }

    const caption = this.composeCaption(req);
    const video = this.primaryVideo(req);
    const asset = this.primaryImageAsset(req);

    const params = new URLSearchParams({
      published: 'false',
      scheduled_publish_time: String(scheduledUnix),
      access_token: this.cfg.pageAccessToken,
    });

    let endpoint: string;
    if (video?.url) {
      endpoint = `${this.base()}/${this.cfg.pageId}/videos`;
      params.set('file_url', video.url);
      params.set('description', caption);
    } else if (asset?.url) {
      endpoint = `${this.base()}/${this.cfg.pageId}/photos`;
      params.set('url', asset.url);
      params.set('caption', caption);
    } else {
      endpoint = `${this.base()}/${this.cfg.pageId}/feed`;
      params.set('message', caption);
    }

    const res = await httpJson<FbPostResponse>(endpoint, {
      method: 'POST',
      provider: 'facebook',
      body: params,
      timeoutMs: 30_000,
    });
    const remoteId = res.post_id ?? res.id;
    return { status: 'scheduled', remoteId, raw: { ...res, scheduledAt: whenIso } };
  }

  override async analytics(remoteId: string): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) return {};
    try {
      return await httpJson<Record<string, unknown>>(`${this.base()}/${remoteId}/insights`, {
        provider: 'facebook',
        query: { access_token: this.cfg.pageAccessToken },
        timeoutMs: 15_000,
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  override async delete(remoteId: string): Promise<void> {
    if (!this.isConfigured()) return;
    await httpJson(`${this.base()}/${remoteId}`, {
      method: 'DELETE',
      provider: 'facebook',
      query: { access_token: this.cfg.pageAccessToken },
      timeoutMs: 15_000,
    });
  }
}
