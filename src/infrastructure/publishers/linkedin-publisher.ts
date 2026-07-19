/**
 * LinkedIn publisher — LinkedIn Posts API (rest/posts), the current
 * (Marketing/Community Management) surface replacing the legacy
 * ugcPosts/shares APIs. Every request needs:
 *   Authorization: Bearer <accessToken>
 *   LinkedIn-Version: <YYYYMM>
 *   X-Restli-Protocol-Version: 2.0.0
 *
 * Image publish flow:
 *   1. POST /rest/images?action=initializeUpload  → { uploadUrl, image (URN) }
 *   2. PUT the raw image bytes to uploadUrl (no additional LinkedIn auth
 *      headers are required on the upload PUT per LinkedIn's docs — the
 *      uploadUrl itself is a signed, single-use endpoint)
 *   3. POST /rest/posts  with content.media.id = the image URN from step 1
 * Text-only posts skip straight to step 3.
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/images-api
 *       https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/posts-api
 */
import type { Platform } from '../../domain/enums.ts';
import { Platform as P } from '../../domain/enums.ts';
import type { PublishRequest, PublishResult } from '../../domain/ports.ts';
import { ExternalApiError, ValidationError } from '../../shared/errors.ts';
import { httpJson, httpDownload, httpRequest } from '../../shared/http.ts';
import { BasePublisher, type BasePublisherOptions } from './base-publisher.ts';

export interface LinkedInConfig {
  accessToken: string;
  /** e.g. "urn:li:person:abc123" or "urn:li:organization:12345" */
  authorUrn: string;
}

export interface LinkedInPublisherOptions extends BasePublisherOptions {
  /** LinkedIn API version header, format YYYYMM. */
  apiVersion?: string;
}

interface InitializeUploadResponse {
  value: {
    uploadUrl: string;
    image: string; // image URN
  };
}
interface CreatePostResponse {
  id?: string;
}

export class LinkedInPublisher extends BasePublisher {
  readonly platform: Platform = P.linkedin;
  private cfg: LinkedInConfig;
  private apiVersion: string;

  constructor(cfg: LinkedInConfig, opts: LinkedInPublisherOptions = {}) {
    super(opts);
    this.cfg = cfg;
    this.apiVersion = opts.apiVersion ?? '202410';
  }

  isConfigured(): boolean {
    return !!(this.cfg.accessToken && this.cfg.authorUrn);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.accessToken}`,
      'linkedin-version': this.apiVersion,
      'x-restli-protocol-version': '2.0.0',
      ...extra,
    };
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.dryRun || !this.isConfigured()) return this.dryRunResult(req);

    const caption = this.composeCaption(req);
    const asset = this.primaryImageAsset(req);
    const video = this.primaryVideo(req);
    if (video?.url && !asset?.url) {
      // LinkedIn video requires a separate videos initializeUpload flow with
      // chunked byte-range PUTs; without a real public asset image fallback
      // we still require *some* public media URL when a video was requested.
      throw new ValidationError('no public media URL for linkedin');
    }

    let imageUrn: string | undefined;
    if (asset?.url) {
      imageUrn = await this.uploadImage(asset.url);
    }

    const body: Record<string, unknown> = {
      author: this.cfg.authorUrn,
      commentary: caption,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (imageUrn) {
      body.content = { media: { id: imageUrn } };
    }

    const res = await httpRequest<CreatePostResponse>('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      provider: 'linkedin',
      headers: this.headers(),
      body,
      timeoutMs: 30_000,
    });

    // LinkedIn returns the post URN in the `x-restli-id` response header,
    // not the JSON body, for /rest/posts creates.
    const postUrn = res.headers.get('x-restli-id') ?? res.data?.id;
    if (!postUrn) {
      throw new ExternalApiError('linkedin', 'LinkedIn did not return a post id', { responseBody: res.data });
    }
    return {
      status: 'published',
      remoteId: postUrn,
      permalink: `https://www.linkedin.com/feed/update/${postUrn}`,
      raw: { imageUrn, response: res.data },
    };
  }

  private async uploadImage(imageUrl: string): Promise<string> {
    const init = await httpJson<InitializeUploadResponse>('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      provider: 'linkedin',
      headers: this.headers(),
      body: { initializeUploadRequest: { owner: this.cfg.authorUrn } },
      timeoutMs: 30_000,
    });
    const { uploadUrl, image } = init.value;

    const bytes = await httpDownload(imageUrl, { provider: 'linkedin-media-fetch', timeoutMs: 30_000 });
    await httpRequest(uploadUrl, {
      method: 'PUT',
      provider: 'linkedin-upload',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
      responseType: 'text',
      // The uploadUrl already validates the caller via a signed token; some
      // LinkedIn upload endpoints reject a bearer header that isn't expected.
      timeoutMs: 60_000,
    });

    return image;
  }

  override async analytics(remoteId: string): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) return {};
    try {
      return await httpJson<Record<string, unknown>>('https://api.linkedin.com/rest/socialActions/' + encodeURIComponent(remoteId), {
        provider: 'linkedin',
        headers: this.headers(),
        timeoutMs: 15_000,
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  override async delete(remoteId: string): Promise<void> {
    if (!this.isConfigured()) return;
    await httpRequest(`https://api.linkedin.com/rest/posts/${encodeURIComponent(remoteId)}`, {
      method: 'DELETE',
      provider: 'linkedin',
      headers: this.headers(),
      timeoutMs: 15_000,
      responseType: 'text',
    });
  }
}
