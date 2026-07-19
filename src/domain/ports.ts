/**
 * Ports (interfaces) — the boundaries of the clean architecture.
 * Application services depend only on these; infrastructure provides adapters.
 *
 * Note: core-DB repositories are synchronous (node:sqlite is synchronous).
 * Network/IO adapters (sources, publishers, AI, storage, sheet) are async.
 */
import type {
  AnalyticsSnapshot,
  BrandProfile,
  GeneratedAsset,
  GeneratedContent,
  GeneratedVideo,
  Job,
  LogEntry,
  NormalizedProduct,
  ProductImage,
  Publication,
  SocialAccount,
} from './entities.ts';
import type { AssetType, JobStatus, Platform, ProductSourceType, ProductStatus, Tone } from './enums.ts';
import type { ProductRow } from './sheet-schema.ts';

/* ============================ Product Sources ============================ */

export interface ProductSourceInput {
  url?: string;
  productId?: string;
  brand?: string;
  language?: string;
  /** Raw fields for CSV / Manual sources (header-keyed). */
  raw?: Record<string, string>;
}

export interface RawProduct {
  source: ProductSourceType;
  sourceUrl?: string;
  sourceProductId?: string;
  title: string;
  brand?: string;
  category?: string;
  description: string;
  features: string[];
  priceAmount?: number;
  currency?: string;
  compareAtAmount?: number;
  imageUrls: string[];
  rating?: { value: number; count: number };
  availability?: string;
  language?: string;
  raw?: unknown;
}

export interface IProductSource {
  readonly type: ProductSourceType;
  /** True when required credentials/config are present. */
  isConfigured(): boolean;
  /** Establish/verify connectivity (token check, ping). No-op for offline sources. */
  connect(): Promise<void>;
  /** Validate input shape; throws ValidationError when unusable. */
  validate(input: ProductSourceInput): void;
  /** Fetch the raw product from the source. */
  importProduct(input: ProductSourceInput): Promise<RawProduct>;
  /** Download + persist product images to storage. */
  downloadImages(raw: RawProduct, productId: string): Promise<ProductImage[]>;
  /** Map a RawProduct + downloaded images into the canonical NormalizedProduct. */
  normalize(raw: RawProduct, images: ProductImage[]): NormalizedProduct;
}

export interface ISourceRegistry {
  register(source: IProductSource): void;
  get(type: ProductSourceType | string): IProductSource;
  has(type: string): boolean;
  list(): IProductSource[];
}

/* ================================= AI ==================================== */

export interface LlmCompleteRequest {
  system?: string;
  prompt: string;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface ILlmClient {
  readonly name: string;
  isConfigured(): boolean;
  complete(req: LlmCompleteRequest): Promise<string>;
}

export interface CopyGenerationContext {
  product: NormalizedProduct;
  brand: BrandProfile;
  tone: Tone;
  platforms: Platform[];
  language: string;
  variationsPerPlatform?: number;
}

export interface ICopyGenerator {
  readonly name: string;
  generate(ctx: CopyGenerationContext): Promise<GeneratedContent>;
}

/* ============================ Creative / Image =========================== */

export interface RasterizeSpec {
  svg: string;
  /** Optional additional font buffers beyond the engine defaults. */
  extraFonts?: Buffer[];
}

export interface IImageRasterizer {
  /** Render an SVG document to a PNG buffer. */
  render(spec: RasterizeSpec): Promise<Buffer>;
}

export interface CreativeContext {
  product: NormalizedProduct;
  brand: BrandProfile;
  content: GeneratedContent;
  assetTypes?: AssetType[];
  carouselSlides?: number;
}

export interface ICreativeEngine {
  generate(ctx: CreativeContext): Promise<GeneratedAsset[]>;
}

/* ================================ Video ================================== */

export interface VideoBuildContext {
  product: NormalizedProduct;
  brand: BrandProfile;
  content: GeneratedContent;
  assets: GeneratedAsset[];
  durationSec: number;
  fps: number;
}

export interface IVideoRenderer {
  /** Full pipeline: build scenes → render → compress → upload. */
  generate(ctx: VideoBuildContext): Promise<GeneratedVideo>;
  /** Render composed scenes to an MP4, returning its local path. */
  render(ctx: VideoBuildContext, workDir: string): Promise<string>;
  /** Re-encode/compress an MP4 to web-optimized H.264. */
  compress(inputPath: string, outputPath: string): Promise<string>;
  /** Persist the MP4 to storage, returning url/key. */
  upload(localPath: string, productId: string): Promise<{ url?: string; storageKey?: string; bytes: number }>;
}

/* ============================== Publishers =============================== */

export interface PublishRequest {
  platform: Platform;
  product: NormalizedProduct;
  content: GeneratedContent;
  assets: GeneratedAsset[];
  video?: GeneratedVideo;
  caption: string;
  hashtags: string[];
  accountId?: string;
  scheduledAt?: string;
}

export interface PublishResult {
  status: 'published' | 'scheduled' | 'dry_run' | 'failed' | 'skipped';
  remoteId?: string;
  permalink?: string;
  raw?: unknown;
  error?: string;
}

export interface IPublisher {
  readonly platform: Platform;
  isConfigured(): boolean;
  connect(): Promise<void>;
  publish(req: PublishRequest): Promise<PublishResult>;
  schedule(req: PublishRequest, whenIso: string): Promise<PublishResult>;
  delete(remoteId: string): Promise<void>;
  analytics(remoteId: string): Promise<Record<string, unknown>>;
}

export interface IPublisherRegistry {
  register(publisher: IPublisher): void;
  get(platform: Platform | string): IPublisher;
  has(platform: string): boolean;
  list(): IPublisher[];
}

/* =============================== Storage ================================= */

export interface StoredObject {
  key: string;
  path: string;
  url?: string;
  bytes: number;
  contentType: string;
}

export interface IStorage {
  readonly kind: 'local' | 'gdrive';
  put(key: string, data: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  publicUrl(key: string): string | undefined;
  localPathFor(key: string): string;
}

/* ============================== Sheet Store ============================== */

export interface SheetLogInput {
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  productId?: string;
  jobId?: string;
  data?: Record<string, unknown>;
}

export interface ISheetStore {
  readonly kind: 'local' | 'google';
  init(): Promise<void>;
  ensureSchema(): Promise<void>;
  listProducts(opts?: { status?: ProductStatus; limit?: number }): Promise<ProductRow[]>;
  getProduct(id: string): Promise<ProductRow | null>;
  appendProduct(row: Partial<ProductRow>): Promise<ProductRow>;
  /** Rows currently in NEW status, eligible to be claimed. */
  findClaimableRows(limit: number): Promise<ProductRow[]>;
  /** Atomically transition NEW → PROCESSING; returns true if this worker won the claim. */
  claimRow(row: ProductRow, workerId: string, ttlMs: number): Promise<boolean>;
  updateRow(id: string, patch: Partial<ProductRow>): Promise<void>;
  setStatus(id: string, status: ProductStatus, patch?: Partial<ProductRow>): Promise<void>;
  appendLog(input: SheetLogInput): Promise<void>;
  getBrandSettings(brand?: string): Promise<Partial<BrandProfile> | null>;
  upsertBrandSettings(profile: BrandProfile): Promise<void>;
  appendGeneratedContent(content: GeneratedContent, platform: Platform, caption: string): Promise<void>;
  upsertSchedule(pub: Publication): Promise<void>;
  writeAnalytics(snapshot: AnalyticsSnapshot): Promise<void>;
}

/* ============================= Repositories ============================== */

export interface JobListOptions {
  status?: JobStatus;
  limit?: number;
  offset?: number;
}

export interface IJobRepository {
  enqueue(input: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'attempts'> & Partial<Pick<Job, 'status' | 'attempts'>>): Job;
  claimNext(workerId: string, ttlMs: number): Job | null;
  markSucceeded(id: string): void;
  markFailed(id: string, error: string, retryDelayMs: number): void;
  markDead(id: string, error: string): void;
  heartbeat(id: string, workerId: string): void;
  byId(id: string): Job | null;
  countByStatus(): Record<string, number>;
  list(opts?: JobListOptions): Job[];
  requeueStale(ttlMs: number): number;
}

export interface IContentRepository {
  save(content: GeneratedContent): void;
  byProduct(productId: string): GeneratedContent | null;
  byId(id: string): GeneratedContent | null;
  list(opts?: { limit?: number; offset?: number }): GeneratedContent[];
  count(): number;
}

export interface IAssetRepository {
  saveMany(assets: GeneratedAsset[]): void;
  byProduct(productId: string): GeneratedAsset[];
  list(opts?: { limit?: number; offset?: number }): GeneratedAsset[];
  count(): number;
}

export interface IVideoRepository {
  save(video: GeneratedVideo): void;
  byProduct(productId: string): GeneratedVideo | null;
  byId(id: string): GeneratedVideo | null;
  list(opts?: { limit?: number; offset?: number }): GeneratedVideo[];
  count(): number;
}

export interface IPublicationRepository {
  save(pub: Publication): void;
  update(id: string, patch: Partial<Publication>): void;
  byProduct(productId: string): Publication[];
  list(opts?: { status?: string; limit?: number; offset?: number }): Publication[];
  countByStatus(): Record<string, number>;
  count(): number;
}

export interface ILogRepository {
  append(entry: LogEntry): void;
  list(opts?: { level?: string; productId?: string; limit?: number; offset?: number }): LogEntry[];
  count(): number;
}

export interface ISettingsRepository {
  get(key: string): string | null;
  getJson<T>(key: string): T | null;
  set(key: string, value: string): void;
  setJson(key: string, value: unknown): void;
  all(): Record<string, string>;
}

export interface IAccountRepository {
  list(platform?: Platform): SocialAccount[];
  getDefault(platform: Platform): SocialAccount | null;
  byId(id: string): SocialAccount | null;
  save(account: SocialAccount): void;
  remove(id: string): void;
}

export interface IDedupeRepository {
  seen(key: string): boolean;
  mark(key: string, productId: string): void;
}

export interface AnalyticsEventInput {
  type: string;
  productId?: string;
  platform?: Platform;
  value?: number;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface IAnalyticsRepository {
  record(event: AnalyticsEventInput): void;
  snapshot(dateIso: string, queueSize: number): AnalyticsSnapshot;
  dashboard(): {
    productsProcessed: number;
    postsPublished: number;
    videosCreated: number;
    failedJobs: number;
    successRate: number;
    avgProcessingMs: number;
  };
}

/* ============================== Notifier ================================= */

export interface NotifyEvent {
  type: 'failure' | 'posted' | 'started' | 'completed' | 'info';
  message: string;
  productId?: string;
  data?: Record<string, unknown>;
}

export interface INotifier {
  notify(event: NotifyEvent): Promise<void>;
}
