/**
 * X (Twitter) publisher — X API v2 for posting, signed with OAuth 1.0a user
 * context (the only auth flow that both authenticates as a specific user AND
 * is authorized to call the v1.1 media upload endpoint used below).
 *
 * Flow:
 *   1. (If an image asset is available) fetch its bytes and upload via the
 *      legacy v1.1 simple media upload endpoint:
 *        POST https://upload.twitter.com/1.1/media/upload.json
 *        multipart/form-data, field `media` = raw image bytes
 *      → returns media_id_string
 *   2. POST https://api.twitter.com/2/tweets
 *        { text, media: { media_ids: [id] } }   (or text-only if no media)
 *
 * OAuth 1.0a signing (RFC 5849, HMAC-SHA1) is implemented locally here using
 * only the crypto primitives already exposed by src/shared/crypto.ts
 * (hmacSha1Base64, randomHex) — no new shared module is added per the task's
 * "only create files under publishers/" constraint. Percent-encoding follows
 * RFC 3986 exactly (encodeURIComponent plus escaping !*'() ), which is the
 * variant OAuth 1.0a mandates and differs from the plain encodeURIComponent.
 *
 * Docs:
 *  https://developer.x.com/en/docs/authentication/oauth-1-0a
 *  https://developer.x.com/en/docs/x-api/v1/media/upload-media/api-reference/post-media-upload
 *  https://developer.x.com/en/docs/x-api/tweets/manage-tweets/api-reference/post-tweets
 */
import type { Platform } from '../../domain/enums.ts';
import { Platform as P } from '../../domain/enums.ts';
import type { PublishRequest, PublishResult } from '../../domain/ports.ts';
import { ExternalApiError } from '../../shared/errors.ts';
import { httpDownload, httpRequest } from '../../shared/http.ts';
import { hmacSha1Base64, randomHex } from '../../shared/crypto.ts';
import { BasePublisher, type BasePublisherOptions } from './base-publisher.ts';

export interface XConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

interface MediaUploadResponse {
  media_id_string: string;
}
interface CreateTweetResponse {
  data?: { id: string; text: string };
}

/** RFC 3986 percent-encoding, as OAuth 1.0a requires (stricter than encodeURIComponent). */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export class XPublisher extends BasePublisher {
  readonly platform: Platform = P.x;
  private cfg: XConfig;

  constructor(cfg: XConfig, opts: BasePublisherOptions = {}) {
    super(opts);
    this.cfg = cfg;
  }

  isConfigured(): boolean {
    return !!(this.cfg.apiKey && this.cfg.apiSecret && this.cfg.accessToken && this.cfg.accessTokenSecret);
  }

  /**
   * Build the OAuth 1.0a `Authorization` header for a request. `extraParams`
   * covers any non-oauth request parameters that must be included in the
   * signature base string (form-encoded body params for the classic upload
   * endpoint; none for the JSON v2 tweet-create call).
   */
  private oauth1Header(method: string, url: string, extraParams: Record<string, string> = {}): string {
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.cfg.apiKey,
      oauth_nonce: randomHex(16),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: this.cfg.accessToken,
      oauth_version: '1.0',
    };

    const allParams: Record<string, string> = { ...oauthParams, ...extraParams };
    const baseUrl = url.split('?')[0]!;
    const paramString = Object.keys(allParams)
      .sort()
      .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(allParams[k]!)}`)
      .join('&');

    const signatureBase = [method.toUpperCase(), rfc3986Encode(baseUrl), rfc3986Encode(paramString)].join('&');
    const signingKey = `${rfc3986Encode(this.cfg.apiSecret)}&${rfc3986Encode(this.cfg.accessTokenSecret)}`;
    const signature = hmacSha1Base64(signingKey, signatureBase);

    const headerParams = { ...oauthParams, oauth_signature: signature };
    const header = Object.keys(headerParams)
      .sort()
      .map((k) => `${rfc3986Encode(k)}="${rfc3986Encode(headerParams[k]!)}"`)
      .join(', ');
    return `OAuth ${header}`;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.dryRun || !this.isConfigured()) return this.dryRunResult(req);

    const caption = this.composeCaption(req);
    const asset = this.primaryImageAsset(req);

    let mediaId: string | undefined;
    if (asset?.url) {
      try {
        mediaId = await this.uploadImage(asset.url);
      } catch (e) {
        // Media upload failure shouldn't block posting entirely; fall back
        // to a real text-only tweet rather than aborting the publish.
        this.log.warn('x media upload failed; posting text-only tweet', { error: (e as Error).message });
      }
    }

    const tweetBody: Record<string, unknown> = { text: caption };
    if (mediaId) tweetBody.media = { media_ids: [mediaId] };

    const tweetUrl = 'https://api.twitter.com/2/tweets';
    const res = await httpRequest<CreateTweetResponse>(tweetUrl, {
      method: 'POST',
      provider: 'x',
      headers: {
        authorization: this.oauth1Header('POST', tweetUrl),
        'content-type': 'application/json',
      },
      body: tweetBody,
      timeoutMs: 30_000,
    });

    const id = res.data.data?.id;
    if (!id) {
      throw new ExternalApiError('x', 'X did not return a tweet id', { responseBody: res.data });
    }
    return {
      status: 'published',
      remoteId: id,
      permalink: `https://x.com/i/web/status/${id}`,
      raw: { mediaId, response: res.data },
    };
  }

  /** Simple (non-chunked) media upload via the v1.1 endpoint, base64 form field. */
  private async uploadImage(imageUrl: string): Promise<string> {
    const bytes = await httpDownload(imageUrl, { provider: 'x-media-fetch', timeoutMs: 30_000 });
    const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
    const form = new URLSearchParams({ media_data: bytes.toString('base64') });

    const res = await httpRequest<MediaUploadResponse>(uploadUrl, {
      method: 'POST',
      provider: 'x-media-upload',
      headers: {
        authorization: this.oauth1Header('POST', uploadUrl, { media_data: bytes.toString('base64') }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
      timeoutMs: 60_000,
    });
    return res.data.media_id_string;
  }

  override async analytics(remoteId: string): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) return {};
    try {
      const url = `https://api.twitter.com/2/tweets/${remoteId}`;
      const res = await httpRequest<Record<string, unknown>>(url, {
        provider: 'x',
        headers: { authorization: this.oauth1Header('GET', url, { 'tweet.fields': 'public_metrics' }) },
        query: { 'tweet.fields': 'public_metrics' },
        timeoutMs: 15_000,
      });
      return res.data;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  override async delete(remoteId: string): Promise<void> {
    if (!this.isConfigured()) return;
    const url = `https://api.twitter.com/2/tweets/${remoteId}`;
    await httpRequest(url, {
      method: 'DELETE',
      provider: 'x',
      headers: { authorization: this.oauth1Header('DELETE', url) },
      timeoutMs: 15_000,
    });
  }
}
