/**
 * Pinterest publisher — Pinterest API v5.
 *   POST https://api.pinterest.com/v5/pins
 *     { board_id, title, description, media_source: { source_type: 'image_url', url } }
 * Bearer token (OAuth2 user token with pins:write, boards:read scopes).
 * Docs: https://developers.pinterest.com/docs/api/v5/#operation/pins/create
 */
import type { Platform } from '../../domain/enums.ts';
import { Platform as P } from '../../domain/enums.ts';
import type { PublishRequest, PublishResult } from '../../domain/ports.ts';
import { ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { BasePublisher, type BasePublisherOptions } from './base-publisher.ts';

export interface PinterestConfig {
  accessToken: string;
  boardId: string;
}

interface CreatePinResponse {
  id: string;
  link?: string;
}

export class PinterestPublisher extends BasePublisher {
  readonly platform: Platform = P.pinterest;
  private cfg: PinterestConfig;

  constructor(cfg: PinterestConfig, opts: BasePublisherOptions = {}) {
    super(opts);
    this.cfg = cfg;
  }

  isConfigured(): boolean {
    return !!(this.cfg.accessToken && this.cfg.boardId);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.accessToken}`,
      'content-type': 'application/json',
    };
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.dryRun || !this.isConfigured()) return this.dryRunResult(req);

    const asset = this.primaryImageAsset(req);
    if (!asset?.url) {
      // Pinterest v5 pins require an image_url (or video) media source; a
      // video-only asset without a thumbnail image isn't supported here.
      throw new ValidationError('no public media URL for pinterest');
    }

    const caption = this.composeCaption(req);
    const title = req.product.title.slice(0, 100);

    const res = await httpJson<CreatePinResponse>('https://api.pinterest.com/v5/pins', {
      method: 'POST',
      provider: 'pinterest',
      headers: this.headers(),
      body: {
        board_id: this.cfg.boardId,
        title,
        description: caption.slice(0, 500),
        link: req.product.sourceUrl,
        media_source: {
          source_type: 'image_url',
          url: asset.url,
        },
      },
      timeoutMs: 30_000,
    });

    return {
      status: 'published',
      remoteId: res.id,
      permalink: res.link ?? `https://www.pinterest.com/pin/${res.id}/`,
      raw: res,
    };
  }

  override async analytics(remoteId: string): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) return {};
    try {
      return await httpJson<Record<string, unknown>>(`https://api.pinterest.com/v5/pins/${remoteId}/analytics`, {
        provider: 'pinterest',
        headers: this.headers(),
        query: {
          start_date: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
          end_date: new Date().toISOString().slice(0, 10),
          metric_types: 'IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE',
        },
        timeoutMs: 15_000,
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  override async delete(remoteId: string): Promise<void> {
    if (!this.isConfigured()) return;
    await httpJson(`https://api.pinterest.com/v5/pins/${remoteId}`, {
      method: 'DELETE',
      provider: 'pinterest',
      headers: this.headers(),
      timeoutMs: 15_000,
    });
  }
}
