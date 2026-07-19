/**
 * Integration test for src/application/pipeline.ts — wires a real
 * PipelineOrchestrator by hand (no config/index.ts import, to avoid its
 * module-load-time loadDotenv() side effect) against:
 *   - an in-memory SQLite Db (fast, hermetic)
 *   - LocalSheetStore (SHEET_STORE=local equivalent)
 *   - SourceRegistry + ManualEntrySource (settings-payload-backed, no network)
 *   - TemplateCopyGenerator (deterministic, zero-key)
 *   - a real CreativeEngine + ResvgRasterizer (fast, WASM, no native compile)
 *   - a STUB IVideoRenderer (no ffmpeg spawn)
 *   - PublisherRegistry with all 6 real publishers in dryRun:true (no network —
 *     every publisher short-circuits to dryRunResult() before any HTTP call)
 *   - NoopNotifier (no webhook call)
 *
 * Exercises the full PROCESSING -> ... -> POSTED happy path plus the
 * duplicate-detection (ConflictError) failure path.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../src/infrastructure/db/database.ts';
import {
  AnalyticsRepository,
  AssetRepository,
  ContentRepository,
  DedupeRepository,
  LogRepository,
  PublicationRepository,
  SettingsRepository,
  VideoRepository,
} from '../src/infrastructure/db/repositories.ts';
import { LocalSheetStore } from '../src/infrastructure/sheets/local-sheet-store.ts';
import { LocalStorage } from '../src/infrastructure/storage/local-storage.ts';
import { SourceRegistry } from '../src/infrastructure/sources/registry.ts';
import { ManualEntrySource, type ManualProductPayload } from '../src/infrastructure/sources/manual-source.ts';
import { PublisherRegistry } from '../src/infrastructure/publishers/registry.ts';
import { InstagramPublisher } from '../src/infrastructure/publishers/instagram-publisher.ts';
import { FacebookPublisher } from '../src/infrastructure/publishers/facebook-publisher.ts';
import { LinkedInPublisher } from '../src/infrastructure/publishers/linkedin-publisher.ts';
import { PinterestPublisher } from '../src/infrastructure/publishers/pinterest-publisher.ts';
import { ThreadsPublisher } from '../src/infrastructure/publishers/threads-publisher.ts';
import { XPublisher } from '../src/infrastructure/publishers/x-publisher.ts';
import { TemplateCopyGenerator } from '../src/infrastructure/ai/template-generator.ts';
import { ResvgRasterizer } from '../src/infrastructure/image/resvg-rasterizer.ts';
import { CreativeEngine } from '../src/infrastructure/image/creative-engine.ts';
import { NoopNotifier } from '../src/infrastructure/notify/notifier.ts';
import { BrandService } from '../src/application/brand-service.ts';
import { ImportService } from '../src/application/import-service.ts';
import { SchedulerService } from '../src/application/scheduler-service.ts';
import { PublishService } from '../src/application/publish-service.ts';
import { PipelineOrchestrator } from '../src/application/pipeline.ts';
import { ConflictError } from '../src/shared/errors.ts';
import { prefixedId } from '../src/shared/ids.ts';
import type { IVideoRenderer, VideoBuildContext } from '../src/domain/ports.ts';
import type { GeneratedVideo } from '../src/domain/entities.ts';
import type { AppConfig } from '../src/config/index.ts';

/** Fake IVideoRenderer — satisfies the full port but never spawns ffmpeg. */
class StubVideoRenderer implements IVideoRenderer {
  calls = 0;
  async generate(ctx: VideoBuildContext): Promise<GeneratedVideo> {
    this.calls++;
    return {
      id: prefixedId('vid'),
      productId: ctx.product.id,
      path: '/tmp/stub-video.mp4',
      storageKey: `videos/${ctx.product.id}/stub.mp4`,
      url: undefined,
      width: 1080,
      height: 1920,
      durationSec: ctx.durationSec,
      fps: ctx.fps,
      bytes: 123_456,
      createdAt: new Date().toISOString(),
    };
  }
  async render(_ctx: VideoBuildContext, _workDir: string): Promise<string> {
    return '/tmp/stub-video.mp4';
  }
  async compress(_inputPath: string, outputPath: string): Promise<string> {
    return outputPath;
  }
  async upload(_localPath: string, _productId: string): Promise<{ url?: string; storageKey?: string; bytes: number }> {
    return { bytes: 123_456 };
  }
}

/** Minimal AppConfig.brand shape — hand-built to avoid importing config/index.ts
 * (which fires loadDotenv() as a module-load-time side effect). */
const fakeConfig = {
  brand: {
    name: 'Acme',
    primaryColor: '#111111',
    accentColor: '#E63946',
    textColor: '#ffffff',
    font: 'Poppins',
    logoUrl: '',
    watermarkText: '',
    defaultCta: 'Shop now',
    defaultLanguage: 'en',
  },
} as unknown as AppConfig;

interface Harness {
  db: Db;
  tmpDir: string;
  sheet: LocalSheetStore;
  repos: {
    settings: SettingsRepository;
    dedupe: DedupeRepository;
    content: ContentRepository;
    assets: AssetRepository;
    videos: VideoRepository;
    logs: LogRepository;
    analytics: AnalyticsRepository;
    publications: PublicationRepository;
  };
  videoRenderer: StubVideoRenderer;
  orchestrator: PipelineOrchestrator;
}

function buildHarness(): Harness {
  const db = new Db(':memory:');
  db.migrate();

  const tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
  const storage = new LocalStorage({ baseDir: tmpDir, publicBaseUrl: 'https://cdn.example.test' });

  const repos = {
    settings: new SettingsRepository(db),
    dedupe: new DedupeRepository(db),
    content: new ContentRepository(db),
    assets: new AssetRepository(db),
    videos: new VideoRepository(db),
    logs: new LogRepository(db),
    analytics: new AnalyticsRepository(db),
    publications: new PublicationRepository(db),
  };

  const sheet = new LocalSheetStore(db);

  const sources = new SourceRegistry();
  sources.register(new ManualEntrySource(storage, repos.settings));

  const publishers = new PublisherRegistry();
  publishers.register(new InstagramPublisher({ accessToken: '', igUserId: '' }, { dryRun: true }));
  publishers.register(new FacebookPublisher({ pageId: '', pageAccessToken: '' }, { dryRun: true }));
  publishers.register(new LinkedInPublisher({ accessToken: '', authorUrn: '' }, { dryRun: true }));
  publishers.register(new PinterestPublisher({ accessToken: '', boardId: '' }, { dryRun: true }));
  publishers.register(new ThreadsPublisher({ accessToken: '', userId: '' }, { dryRun: true }));
  publishers.register(
    new XPublisher({ apiKey: '', apiSecret: '', accessToken: '', accessTokenSecret: '' }, { dryRun: true }),
  );

  const copyGenerator = new TemplateCopyGenerator();
  const rasterizer = new ResvgRasterizer({ brandFont: 'Poppins' });
  const creativeEngine = new CreativeEngine(rasterizer, storage, { brandFont: 'Poppins' });
  const videoRenderer = new StubVideoRenderer();
  const notifier = new NoopNotifier();

  const brandService = new BrandService(sheet, fakeConfig);
  const importService = new ImportService(sources);
  const scheduler = new SchedulerService([], 'UTC');
  const publishService = new PublishService(publishers, repos.publications, sheet, scheduler);

  const orchestrator = new PipelineOrchestrator({
    sheet,
    importService,
    brandService,
    copyGenerator,
    creativeEngine,
    videoRenderer,
    publishService,
    publishers,
    dedupe: repos.dedupe,
    contentRepo: repos.content,
    assetRepo: repos.assets,
    videoRepo: repos.videos,
    logRepo: repos.logs,
    analytics: repos.analytics,
    notifier,
    options: { defaultTone: 'friendly', videoDurationSec: 15, videoFps: 30, dryRun: true },
  });

  return { db, tmpDir, sheet, repos, videoRenderer, orchestrator };
}

function seedManualProduct(
  h: Harness,
  productId: string,
  payload: Partial<ManualProductPayload> = {},
): Promise<Awaited<ReturnType<LocalSheetStore['appendProduct']>>> {
  const fullPayload: ManualProductPayload = {
    title: 'Wireless Noise-Cancelling Headphones',
    description: 'Premium wireless headphones with active noise cancellation.',
    features: ['40-hour battery life', 'Active noise cancellation', 'Bluetooth 5.3'],
    price: 129.99,
    currency: 'USD',
    brand: 'Acme',
    category: 'Audio',
    imageUrls: [],
    language: 'en',
    ...payload,
  };
  h.repos.settings.setJson(ManualEntrySource.settingsKey(productId), fullPayload);
  return h.sheet.appendProduct({ productId, brand: fullPayload.brand, category: fullPayload.category, status: 'NEW' as never });
}

let h: Harness;

beforeEach(async () => {
  h = buildHarness();
  await h.sheet.init();
});

afterEach(() => {
  h.db.close();
  rmSync(h.tmpDir, { recursive: true, force: true });
});

describe('PipelineOrchestrator.process — happy path (manual source, dry-run publishers)', () => {
  test('processes a NEW row end-to-end to POSTED with content, assets, 6 dry_run publications, and dedupe marked', async () => {
    const productId = 'manual-1';
    const row = await seedManualProduct(h, productId);

    const result = await h.orchestrator.process(row);

    // Pipeline result shape
    assert.equal(result.title, 'Wireless Noise-Cancelling Headphones');
    assert.equal(result.platforms.length, 6, 'blank row.platform should resolve to all 6 registered publishers');
    assert.equal(result.publications.length, 6);
    assert.ok(result.durationMs >= 0);

    // Row status
    const finalRow = await h.sheet.getProduct(row.id);
    assert.ok(finalRow);
    assert.equal(finalRow!.status, 'POSTED');
    assert.equal(finalRow!.error, '');

    // Content saved
    const content = h.repos.content.byProduct(row.id);
    assert.ok(content, 'generated content should be saved keyed by product id (= row id)');
    assert.equal(content!.hooks.length, 10);
    assert.equal(content!.hashtags.length, 30);
    assert.equal(content!.captions.length, 6);

    // Assets saved (5 default types + carousel slides, all > 0 bytes)
    const assets = h.repos.assets.byProduct(row.id);
    assert.ok(assets.length > 0, 'expected at least one rendered asset');
    assert.ok(assets.length >= 8, `expected >=8 assets (5 formats + >=3 carousel slides), got ${assets.length}`);
    for (const a of assets) assert.ok(a.bytes > 0);

    // Video saved via the stub renderer
    assert.equal(h.videoRenderer.calls, 1);
    const video = h.repos.videos.byProduct(row.id);
    assert.ok(video);
    assert.equal(video!.durationSec, 15);
    assert.equal(video!.fps, 30);

    // Publications: exactly 6, all dry_run
    const pubs = h.repos.publications.byProduct(row.id);
    assert.equal(pubs.length, 6);
    for (const p of pubs) assert.equal(p.status, 'dry_run');
    const platformsSeen = pubs.map((p) => p.platform).sort();
    assert.deepEqual(platformsSeen, ['facebook', 'instagram', 'linkedin', 'pinterest', 'threads', 'x'].sort());

    // Dedupe marking is asserted end-to-end in the next test: re-processing a
    // second row backed by the same manual settings payload/productId must
    // be rejected with ConflictError, which only happens if dedupe.mark()
    // ran here.
  });

  test('a second process() of the SAME manual product id rejects with ConflictError (dedupe)', async () => {
    const productId = 'manual-dup';
    const rowA = await seedManualProduct(h, productId);
    await h.orchestrator.process(rowA);

    // Second row pointing at the SAME settings payload/productId -> same
    // recomputed dedupeKey inside ImportService.import() -> dedupe.seen() true.
    const rowB = await seedManualProduct(h, productId);
    await assert.rejects(
      () => h.orchestrator.process(rowB),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError, `expected ConflictError, got ${(err as Error)?.constructor?.name}`);
        assert.equal((err as ConflictError).code, 'CONFLICT');
        return true;
      },
    );

    // The duplicate row should be marked FAILED (pipeline catch-block behavior).
    const finalRowB = await h.sheet.getProduct(rowB.id);
    assert.equal(finalRowB!.status, 'FAILED');
    assert.ok(finalRowB!.error.length > 0);

    // The first row is unaffected and still POSTED.
    const finalRowA = await h.sheet.getProduct(rowA.id);
    assert.equal(finalRowA!.status, 'POSTED');
  });

  test('PipelineOrchestrator.isRetryable is false for ConflictError and true for a generic Error', () => {
    assert.equal(PipelineOrchestrator.isRetryable(new ConflictError('dup')), false);
    assert.equal(PipelineOrchestrator.isRetryable(new Error('boom')), true);
  });
});
