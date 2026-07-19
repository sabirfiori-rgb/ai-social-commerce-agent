/**
 * Pipeline orchestrator — the core "AI marketing employee" workflow for one
 * product row:
 *   PROCESSING → import → PRODUCT_IMPORTED → copy → CONTENT_CREATED →
 *   images → video → VIDEO_CREATED → publish/schedule → POSTED
 * Every stage updates the sheet, logs activity, and records analytics. Failures
 * set FAILED with the error and rethrow so the worker can retry (except
 * non-retryable duplicates/validation).
 */
import type {
  GeneratedContent,
  NormalizedProduct,
  Publication,
} from '../domain/entities.ts';
import { ProductStatus } from '../domain/enums.ts';
import type {
  IAnalyticsRepository,
  IAssetRepository,
  IContentRepository,
  ICopyGenerator,
  ICreativeEngine,
  IDedupeRepository,
  ILogRepository,
  INotifier,
  IPublisherRegistry,
  ISheetStore,
  IVideoRepository,
  IVideoRenderer,
} from '../domain/ports.ts';
import type { ProductRow } from '../domain/sheet-schema.ts';
import { nowIso } from '../shared/clock.ts';
import { ConflictError, ValidationError } from '../shared/errors.ts';
import { createLogger } from '../shared/logger.ts';
import type { BrandService } from './brand-service.ts';
import type { ImportService } from './import-service.ts';
import type { PublishService } from './publish-service.ts';
import { pickCaption, resolvePlatforms, resolveTone, truncate } from './selectors.ts';

const log = createLogger({ mod: 'pipeline' });

export interface PipelineDeps {
  sheet: ISheetStore;
  importService: ImportService;
  brandService: BrandService;
  copyGenerator: ICopyGenerator;
  creativeEngine: ICreativeEngine;
  videoRenderer: IVideoRenderer;
  publishService: PublishService;
  publishers: IPublisherRegistry;
  dedupe: IDedupeRepository;
  contentRepo: IContentRepository;
  assetRepo: IAssetRepository;
  videoRepo: IVideoRepository;
  logRepo: ILogRepository;
  analytics: IAnalyticsRepository;
  notifier: INotifier;
  options: { defaultTone: string; videoDurationSec: number; videoFps: number; dryRun: boolean };
}

export interface PipelineResult {
  productId: string;
  title: string;
  platforms: string[];
  publications: Publication[];
  durationMs: number;
}

export class PipelineOrchestrator {
  private d: PipelineDeps;
  constructor(deps: PipelineDeps) {
    this.d = deps;
  }

  private async logStage(row: ProductRow, level: 'info' | 'warn' | 'error', stage: string, message: string, data?: Record<string, unknown>, jobId?: string): Promise<void> {
    this.d.logRepo.append({ ts: nowIso(), level, stage, message, productId: row.id, jobId, data });
    log[level](message, { stage, productId: row.id });
    try {
      await this.d.sheet.appendLog({ level, stage, message, productId: row.id, jobId, data });
    } catch (e) {
      log.warn('sheet log append failed', { error: (e as Error).message });
    }
  }

  async process(row: ProductRow, jobId?: string): Promise<PipelineResult> {
    const startedAt = Date.now();
    this.d.analytics.record({ type: 'pipeline_started', productId: row.id });
    await this.d.sheet.setStatus(row.id, ProductStatus.PROCESSING, { error: '' });

    try {
      // 1) Brand
      const brand = await this.d.brandService.resolve(row);

      // 2) Import product
      const product: NormalizedProduct = await this.d.importService.import(row);
      if (this.d.dedupe.seen(product.dedupeKey)) {
        throw new ConflictError('Duplicate product — already processed', { dedupeKey: product.dedupeKey });
      }
      await this.d.sheet.setStatus(row.id, ProductStatus.PRODUCT_IMPORTED, {
        brand: product.brand ?? row.brand,
        category: product.category ?? row.category,
        productId: product.sourceProductId ?? row.productId,
      });
      await this.logStage(row, 'info', 'import', `Imported "${product.title}" from ${product.source} (${product.images.length} image(s))`, undefined, jobId);

      // 3) Copy
      const platforms = resolvePlatforms(row, this.d.publishers.list().map((p) => p.platform));
      const tone = resolveTone(row, this.d.options.defaultTone);
      const content: GeneratedContent = await this.d.copyGenerator.generate({ product, brand, tone, platforms, language: brand.language });
      this.d.contentRepo.save(content);
      const heroCaption = pickCaption(content, platforms[0] ?? 'instagram');
      await this.d.sheet.setStatus(row.id, ProductStatus.CONTENT_CREATED, { generatedCaption: truncate(heroCaption, 480) });
      for (const platform of platforms) {
        try {
          await this.d.sheet.appendGeneratedContent(content, platform, pickCaption(content, platform));
        } catch {
          /* best-effort sheet mirror */
        }
      }
      await this.logStage(row, 'info', 'copy', `Generated ${tone} copy for ${platforms.length} platform(s): ${content.hooks.length} hooks, ${content.hashtags.length} hashtags`, undefined, jobId);

      // 4) Creative assets
      const assets = await this.d.creativeEngine.generate({ product, brand, content });
      this.d.assetRepo.saveMany(assets);
      await this.logStage(row, 'info', 'images', `Rendered ${assets.length} branded asset(s)`, undefined, jobId);

      // 5) Video
      const video = await this.d.videoRenderer.generate({
        product,
        brand,
        content,
        assets,
        durationSec: this.d.options.videoDurationSec,
        fps: this.d.options.videoFps,
      });
      this.d.videoRepo.save(video);
      this.d.analytics.record({ type: 'video_created', productId: product.id });
      await this.d.sheet.setStatus(row.id, ProductStatus.VIDEO_CREATED, { generatedVideo: video.url ?? video.storageKey ?? video.path });
      await this.logStage(row, 'info', 'video', `Rendered ${video.durationSec}s promo video (${Math.round(video.bytes / 1024)}KB)`, undefined, jobId);

      // 6) Publish / schedule
      const publications = await this.d.publishService.publishAll({ product, content, assets, video, platforms, row });
      for (const p of publications) {
        if (p.status === 'published') this.d.analytics.record({ type: 'post_published', productId: product.id, platform: p.platform });
      }
      const permalinks = publications.map((p) => p.permalink).filter((x): x is string => !!x);
      const summary =
        permalinks.length > 0
          ? permalinks.join('  ')
          : `${publications.length} platform(s) ${this.d.options.dryRun ? '(dry-run)' : ''} — ${publications.map((p) => `${p.platform}:${p.status}`).join(', ')}`;
      await this.d.sheet.setStatus(row.id, ProductStatus.POSTED, { publishedUrl: truncate(summary, 480), error: '' });

      this.d.dedupe.mark(product.dedupeKey, product.id);
      const durationMs = Date.now() - startedAt;
      this.d.analytics.record({ type: 'pipeline_completed', productId: product.id, durationMs });
      await this.logStage(row, 'info', 'done', `Completed in ${(durationMs / 1000).toFixed(1)}s across ${publications.length} platform(s)`, undefined, jobId);
      await this.d.notifier.notify({ type: 'completed', message: `Processed "${product.title}"`, productId: product.id });

      return { productId: product.id, title: product.title, platforms, publications, durationMs };
    } catch (e) {
      const err = e as Error;
      this.d.analytics.record({ type: 'pipeline_failed', productId: row.id });
      await this.d.sheet.setStatus(row.id, ProductStatus.FAILED, { error: truncate(err.message, 480) });
      await this.logStage(row, 'error', 'error', err.message, { name: err.name }, jobId);
      await this.d.notifier.notify({ type: 'failure', message: err.message, productId: row.id });
      throw e;
    }
  }

  /** Whether a failure should be retried by the worker. */
  static isRetryable(err: unknown): boolean {
    return !(err instanceof ConflictError || err instanceof ValidationError);
  }
}
