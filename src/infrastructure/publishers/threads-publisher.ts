/**
 * Threads publisher — Meta's Threads API. Two-step publish flow mirroring
 * Instagram's Graph API pattern:
 *   1. POST https://graph.threads.net/v1.0/{userId}/threads
 *        media_type=IMAGE + image_url + text   (or media_type=TEXT + text)
 *   2. POST https://graph.threads.net/v1.0/{userId}/threads_publish
 *        creation_id=<id from step 1>
 * Docs: https://developers.facebook.com/docs/threads/posts
 */
import type { Platform } from '../../domain/enums.ts';
import { Platform as P } from '../../domain/enums.ts';
import type { PublishRequest, PublishResult } from '../../domain/ports.ts';
import { httpJson } from '../../shared/http.ts';
import { BasePublisher, type BasePublisherOptions } from './base-publisher.ts';

export interface ThreadsConfig {
  accessToken: string;
  userId: string;
}

export interface ThreadsPublisherOptions extends BasePublisherOptions {
  apiVersion?: string;
}

interface ThreadsContainerResponse {
  id: string;
}
interface ThreadsPublishResponse {
  id: string;
}

export class ThreadsPublisher extends BasePublisher {
  readonly platform: Platform = P.threads;
  private cfg: ThreadsConfig;
  private apiVersion: string;

  constructor(cfg: ThreadsConfig, opts: ThreadsPublisherOptions = {}) {
    super(opts);
    this.cfg = cfg;
    this.apiVersion = opts.apiVersion ?? 'v1.0';
  }

  isConfigured(): boolean {
    return !!(this.cfg.accessToken && this.cfg.userId);
  }

  private base(): string {
    return `https://graph.threads.net/${this.apiVersion}`;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.dryRun || !this.isConfigured()) return this.dryRunResult(req);

    const caption = this.composeCaption(req);
    const video = this.primaryVideo(req);
    const asset = this.primaryImageAsset(req);

    const params = new URLSearchParams({ text: caption, access_token: this.cfg.accessToken });
    if (video?.url) {
      params.set('media_type', 'VIDEO');
      params.set('video_url', video.url);
    } else if (asset?.url) {
      params.set('media_type', 'IMAGE');
      params.set('image_url', asset.url);
    } else {
      params.set('media_type', 'TEXT');
    }

    const container = await httpJson<ThreadsContainerResponse>(`${this.base()}/${this.cfg.userId}/threads`, {
      method: 'POST',
      provider: 'threads',
      body: params,
      timeoutMs: 30_000,
    });

    const published = await httpJson<ThreadsPublishResponse>(`${this.base()}/${this.cfg.userId}/threads_publish`, {
      method: 'POST',
      provider: 'threads',
      body: new URLSearchParams({ creation_id: container.id, access_token: this.cfg.accessToken }),
      timeoutMs: 30_000,
    });

    return {
      status: 'published',
      remoteId: published.id,
      permalink: `https://www.threads.net/@${this.cfg.userId}/post/${published.id}`,
      raw: { container, published },
    };
  }

  override async analytics(remoteId: string): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) return {};
    try {
      return await httpJson<Record<string, unknown>>(`${this.base()}/${remoteId}/insights`, {
        provider: 'threads',
        query: { metric: 'views,likes,replies,reposts,quotes', access_token: this.cfg.accessToken },
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
      provider: 'threads',
      query: { access_token: this.cfg.accessToken },
      timeoutMs: 15_000,
    });
  }
}
