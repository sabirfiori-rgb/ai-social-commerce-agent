/**
 * BasePublisher — shared behavior for every social platform publisher:
 * caption composition, dry-run short-circuiting, a generic (non-native)
 * schedule() fallback, and default delete()/analytics() no-ops for
 * platforms that don't override them.
 *
 * Concrete publishers extend this, implement `isConfigured()`/`connect()`/
 * `publish()`, and call `dryRunResult(req)` at the top of `publish()` when
 * `this.dryRun` is set or credentials are missing — this is a genuine
 * dry-run feature, not a stub: it records exactly what would have been
 * posted (platform, caption, target media) without making a network call.
 */
import type { GeneratedAsset, GeneratedVideo } from '../../domain/entities.ts';
import type { Platform } from '../../domain/enums.ts';
import type { IPublisher, PublishRequest, PublishResult } from '../../domain/ports.ts';
import { NotConfiguredError } from '../../shared/errors.ts';
import { createLogger, type Logger } from '../../shared/logger.ts';

export interface BasePublisherOptions {
  dryRun?: boolean;
}

/** Per-platform caption sensibilities (rough character budgets / hashtag counts). */
const CAPTION_LIMITS: Record<Platform, { maxHashtags: number; maxChars?: number }> = {
  instagram: { maxHashtags: 30 },
  facebook: { maxHashtags: 8 },
  linkedin: { maxHashtags: 5, maxChars: 3000 },
  pinterest: { maxHashtags: 10, maxChars: 500 },
  threads: { maxHashtags: 5, maxChars: 500 },
  x: { maxHashtags: 4, maxChars: 280 },
};

export abstract class BasePublisher implements IPublisher {
  abstract readonly platform: Platform;
  protected dryRun: boolean;
  protected log: Logger;

  constructor(opts: BasePublisherOptions = {}) {
    this.dryRun = opts.dryRun ?? false;
    this.log = createLogger({ publisher: 'pending' });
  }

  abstract isConfigured(): boolean;

  async connect(): Promise<void> {
    this.requireConfigured();
  }

  abstract publish(req: PublishRequest): Promise<PublishResult>;

  /**
   * Generic scheduling fallback for platforms with no native "schedule this
   * post for later" API (or where the caller manages a job queue instead).
   * The caller (application layer) is responsible for persisting
   * `scheduledAt` and re-invoking `publish()` when it comes due; this just
   * returns the acknowledgement shape. Never sleeps/blocks.
   */
  async schedule(req: PublishRequest, whenIso: string): Promise<PublishResult> {
    this.requireConfigured();
    return {
      status: 'scheduled',
      raw: { platform: this.platform, scheduledAt: whenIso, wouldPost: true, caption: this.composeCaption(req) },
    };
  }

  /** Default: no remote delete endpoint wired up; treat as a silent no-op. */
  async delete(_remoteId: string): Promise<void> {
    // Platforms that support deletion override this.
  }

  /** Default: no analytics endpoint wired up; return an empty snapshot. */
  async analytics(_remoteId: string): Promise<Record<string, unknown>> {
    return {};
  }

  /** caption + blank line + hashtags, trimmed to a per-platform sensibility. */
  protected composeCaption(req: PublishRequest): string {
    const limits = CAPTION_LIMITS[this.platform];
    const caption = (req.caption ?? '').trim();
    const tags = (req.hashtags ?? [])
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
      .slice(0, limits.maxHashtags);
    const composed = tags.length ? `${caption}\n\n${tags.join(' ')}` : caption;
    if (limits.maxChars && composed.length > limits.maxChars) {
      return composed.slice(0, limits.maxChars - 1).trimEnd() + '…';
    }
    return composed;
  }

  /** First image-capable asset with a public URL, or undefined. */
  protected primaryImageAsset(req: PublishRequest): GeneratedAsset | undefined {
    return req.assets.find((a) => !!a.url);
  }

  protected primaryVideo(req: PublishRequest): GeneratedVideo | undefined {
    return req.video?.url ? req.video : undefined;
  }

  protected requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError(this.platform);
    }
  }

  /**
   * Real dry-run result: no network call is made, but the exact payload
   * intent (caption, media target, platform) is recorded so callers can
   * inspect/log/preview it. Used both when `dryRun` is explicitly set and
   * as the safe fallback when credentials are missing.
   */
  protected dryRunResult(req: PublishRequest): PublishResult {
    const asset = this.primaryImageAsset(req);
    const video = this.primaryVideo(req);
    return {
      status: 'dry_run',
      permalink: undefined,
      raw: {
        wouldPost: true,
        platform: this.platform,
        caption: this.composeCaption(req),
        mediaUrl: video?.url ?? asset?.url,
        mediaKind: video?.url ? 'video' : asset?.url ? 'image' : 'none',
        productId: req.product.id,
        accountId: req.accountId,
      },
    };
  }
}
