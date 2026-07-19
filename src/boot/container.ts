/**
 * Composition root (hand-rolled DI container). Builds every adapter, repository,
 * engine, and service from configuration and wires them together. This is the
 * ONLY place that knows concrete implementations — the rest of the app depends
 * on ports. New sources/publishers/providers are registered here with no core
 * changes elsewhere.
 */
import { type AppConfig, loadConfig } from '../config/index.ts';
import { getDb, type Db } from '../infrastructure/db/database.ts';
import {
  AccountRepository,
  AnalyticsRepository,
  AssetRepository,
  ContentRepository,
  DedupeRepository,
  JobRepository,
  LogRepository,
  PublicationRepository,
  SettingsRepository,
  VideoRepository,
} from '../infrastructure/db/repositories.ts';
import { LocalSheetStore } from '../infrastructure/sheets/local-sheet-store.ts';
import { GoogleSheetsStore } from '../infrastructure/sheets/google-sheet-store.ts';
import { createStorage } from '../infrastructure/storage/index.ts';
import { SourceRegistry } from '../infrastructure/sources/registry.ts';
import { ManualEntrySource } from '../infrastructure/sources/manual-source.ts';
import { CsvSource } from '../infrastructure/sources/csv-source.ts';
import { AmazonSource } from '../infrastructure/sources/amazon-source.ts';
import { ShopifySource } from '../infrastructure/sources/shopify-source.ts';
import { WooCommerceSource } from '../infrastructure/sources/woocommerce-source.ts';
import { EtsySource } from '../infrastructure/sources/etsy-source.ts';
import { FlipkartSource } from '../infrastructure/sources/flipkart-source.ts';
import { MeeshoSource } from '../infrastructure/sources/meesho-source.ts';
import { PublisherRegistry } from '../infrastructure/publishers/registry.ts';
import { InstagramPublisher } from '../infrastructure/publishers/instagram-publisher.ts';
import { FacebookPublisher } from '../infrastructure/publishers/facebook-publisher.ts';
import { LinkedInPublisher } from '../infrastructure/publishers/linkedin-publisher.ts';
import { PinterestPublisher } from '../infrastructure/publishers/pinterest-publisher.ts';
import { ThreadsPublisher } from '../infrastructure/publishers/threads-publisher.ts';
import { XPublisher } from '../infrastructure/publishers/x-publisher.ts';
import { createCopyGenerator } from '../infrastructure/ai/registry.ts';
import { ResvgRasterizer } from '../infrastructure/image/resvg-rasterizer.ts';
import { CreativeEngine } from '../infrastructure/image/creative-engine.ts';
import { FfmpegVideoRenderer } from '../infrastructure/video/video-renderer.ts';
import { createNotifier } from '../infrastructure/notify/notifier.ts';
import { BrandService } from '../application/brand-service.ts';
import { ImportService } from '../application/import-service.ts';
import { SchedulerService } from '../application/scheduler-service.ts';
import { PublishService } from '../application/publish-service.ts';
import { SettingsService } from '../application/settings-service.ts';
import { AnalyticsService } from '../application/analytics-service.ts';
import { SystemService } from '../application/system-service.ts';
import { BackupService } from '../application/backup-service.ts';
import { SetupService } from '../application/setup-service.ts';
import { PipelineOrchestrator } from '../application/pipeline.ts';
import type { ICopyGenerator, ICreativeEngine, ISheetStore, IStorage, IVideoRenderer } from '../domain/ports.ts';
import { createAuth, type Authenticator } from '../interface/http/auth.ts';
import { logger } from '../shared/logger.ts';

function env(name: string, def = ''): string {
  return process.env[name] ?? def;
}

export interface Container {
  config: AppConfig;
  auth: Authenticator;
  db: Db;
  sheet: ISheetStore;
  storage: IStorage;
  repos: {
    jobs: JobRepository;
    content: ContentRepository;
    assets: AssetRepository;
    videos: VideoRepository;
    publications: PublicationRepository;
    logs: LogRepository;
    settings: SettingsRepository;
    accounts: AccountRepository;
    dedupe: DedupeRepository;
    analytics: AnalyticsRepository;
  };
  sources: SourceRegistry;
  publishers: PublisherRegistry;
  copyGenerator: ICopyGenerator;
  creativeEngine: ICreativeEngine;
  videoRenderer: IVideoRenderer;
  services: {
    brand: BrandService;
    import: ImportService;
    scheduler: SchedulerService;
    publish: PublishService;
    settings: SettingsService;
    analytics: AnalyticsService;
    system: SystemService;
    backup: BackupService;
    setup: SetupService;
  };
  orchestrator: PipelineOrchestrator;
  init(): Promise<void>;
  close(): void;
}

export function buildContainer(configOverride?: AppConfig): Container {
  const config = configOverride ?? loadConfig();
  const auth = createAuth(config.auth);
  const db = getDb(config.db.sqlitePath);

  const repos = {
    jobs: new JobRepository(db),
    content: new ContentRepository(db),
    assets: new AssetRepository(db),
    videos: new VideoRepository(db),
    publications: new PublicationRepository(db),
    logs: new LogRepository(db),
    settings: new SettingsRepository(db),
    accounts: new AccountRepository(db),
    dedupe: new DedupeRepository(db),
    analytics: new AnalyticsRepository(db),
  };

  const storage = createStorage(config);

  const sheet: ISheetStore =
    config.sheets.store === 'google'
      ? new GoogleSheetsStore({
          spreadsheetId: config.sheets.spreadsheetId,
          serviceAccountFile: config.sheets.serviceAccountFile,
          serviceAccountJson: config.sheets.serviceAccountJson,
        })
      : new LocalSheetStore(db);

  // ---- Product sources ----
  const sources = new SourceRegistry();
  sources.register(new ManualEntrySource(storage, repos.settings));
  sources.register(new CsvSource(storage));
  sources.register(
    new AmazonSource(storage, {
      accessKey: env('AMAZON_PAAPI_ACCESS_KEY'),
      secretKey: env('AMAZON_PAAPI_SECRET_KEY'),
      partnerTag: env('AMAZON_PAAPI_PARTNER_TAG'),
      host: env('AMAZON_PAAPI_HOST', 'webservices.amazon.com'),
      region: env('AMAZON_PAAPI_REGION', 'us-east-1'),
      marketplace: 'www.amazon.com',
    }),
  );
  sources.register(new ShopifySource(storage, { storeDomain: env('SHOPIFY_STORE_DOMAIN'), adminToken: env('SHOPIFY_ADMIN_TOKEN'), apiVersion: env('SHOPIFY_API_VERSION', '2024-10') }));
  sources.register(new WooCommerceSource(storage, { baseUrl: env('WOOCOMMERCE_BASE_URL'), consumerKey: env('WOOCOMMERCE_CONSUMER_KEY'), consumerSecret: env('WOOCOMMERCE_CONSUMER_SECRET') }));
  sources.register(new EtsySource(storage, { apiKey: env('ETSY_API_KEY'), accessToken: env('ETSY_ACCESS_TOKEN'), shopId: env('ETSY_SHOP_ID') }));
  sources.register(new FlipkartSource(storage, { affiliateId: env('FLIPKART_AFFILIATE_ID'), affiliateToken: env('FLIPKART_AFFILIATE_TOKEN') }));
  sources.register(new MeeshoSource(storage, { baseUrl: env('MEESHO_BASE_URL'), apiToken: env('MEESHO_API_TOKEN') }));

  // ---- Publishers ----
  const dryRun = config.publishing.dryRun;
  const publishers = new PublisherRegistry();
  publishers.register(new InstagramPublisher({ accessToken: env('INSTAGRAM_ACCESS_TOKEN'), igUserId: env('INSTAGRAM_BUSINESS_ACCOUNT_ID') }, { dryRun }));
  publishers.register(new FacebookPublisher({ pageId: env('FACEBOOK_PAGE_ID'), pageAccessToken: env('FACEBOOK_PAGE_ACCESS_TOKEN') }, { dryRun }));
  publishers.register(new LinkedInPublisher({ accessToken: env('LINKEDIN_ACCESS_TOKEN'), authorUrn: env('LINKEDIN_AUTHOR_URN') }, { dryRun }));
  publishers.register(new PinterestPublisher({ accessToken: env('PINTEREST_ACCESS_TOKEN'), boardId: env('PINTEREST_DEFAULT_BOARD_ID') }, { dryRun }));
  publishers.register(new ThreadsPublisher({ accessToken: env('THREADS_ACCESS_TOKEN'), userId: env('THREADS_USER_ID') }, { dryRun }));
  publishers.register(
    new XPublisher(
      { apiKey: env('X_API_KEY'), apiSecret: env('X_API_SECRET'), accessToken: env('X_ACCESS_TOKEN'), accessTokenSecret: env('X_ACCESS_TOKEN_SECRET') },
      { dryRun },
    ),
  );

  // ---- Engines ----
  const copyGenerator = createCopyGenerator({
    provider: config.ai.provider,
    openai: config.ai.openai,
    gemini: config.ai.gemini,
    anthropic: config.ai.anthropic,
  });
  const rasterizer = new ResvgRasterizer({ brandFont: config.brand.font });
  const creativeEngine = new CreativeEngine(rasterizer, storage, { brandFont: config.brand.font });
  const videoRenderer = new FfmpegVideoRenderer(rasterizer, storage, {
    ffmpegPath: config.video.ffmpegPath,
    ffprobePath: config.video.ffprobePath,
    fps: config.video.fps,
    durationSeconds: config.video.durationSeconds,
    musicFile: config.video.musicFile || undefined,
    musicEnabled: config.video.musicEnabled,
  });

  // ---- Services ----
  const notifier = createNotifier(config.notify.webhookUrl);
  const scheduler = new SchedulerService(config.automation.postingTimes, config.automation.timezone);
  const analytics = new AnalyticsService(repos.analytics, repos.jobs, repos.publications, sheet);
  const services = {
    brand: new BrandService(sheet, config),
    import: new ImportService(sources),
    scheduler,
    publish: new PublishService(publishers, repos.publications, sheet, scheduler),
    settings: new SettingsService(repos.settings, repos.accounts, sheet, config.security.encryptionKey),
    analytics,
    system: new SystemService({ db, config, storage, sheet, analytics, ffmpegPath: config.video.ffmpegPath }),
    backup: new BackupService(db, config),
    setup: new SetupService({ settings: repos.settings, sheet, config, sources, publishers, copyGenerator }),
  };

  const orchestrator = new PipelineOrchestrator({
    sheet,
    importService: services.import,
    brandService: services.brand,
    copyGenerator,
    creativeEngine,
    videoRenderer,
    publishService: services.publish,
    publishers,
    dedupe: repos.dedupe,
    contentRepo: repos.content,
    assetRepo: repos.assets,
    videoRepo: repos.videos,
    logRepo: repos.logs,
    analytics: repos.analytics,
    notifier,
    options: {
      defaultTone: env('DEFAULT_TONE', 'friendly'),
      videoDurationSec: config.video.durationSeconds,
      videoFps: config.video.fps,
      dryRun: config.publishing.dryRun,
    },
  });

  return {
    config,
    auth,
    db,
    sheet,
    storage,
    repos,
    sources,
    publishers,
    copyGenerator,
    creativeEngine,
    videoRenderer,
    services,
    orchestrator,
    async init() {
      await sheet.init();
      logger.info('container initialized', {
        sheet: sheet.kind,
        storage: storage.kind,
        aiProvider: config.ai.provider,
        copyGenerator: copyGenerator.name,
        sources: sources.list().map((s) => s.type),
        publishers: publishers.list().map((p) => p.platform),
        dryRun: config.publishing.dryRun,
        authEnabled: auth.enabled,
      });
      if (!auth.enabled) {
        logger.warn('API authentication is DISABLED — set API_TOKENS before exposing this instance publicly');
      }
    },
    close() {
      db.close();
    },
  };
}
