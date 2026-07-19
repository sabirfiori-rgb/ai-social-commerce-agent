# Architecture

This document describes how the AI Social Commerce Agent is put together:
the layering, the ports each layer depends on, the pipeline's state machine,
the SQLite data model, the concurrency/locking design, and how to extend the
system with a new product source or social publisher.

## Contents

- [Layers](#layers)
- [The dependency-injection container](#the-dependency-injection-container)
- [The adapter/registry pattern](#the-adapterregistry-pattern)
- [Ports](#ports)
- [The pipeline](#the-pipeline)
- [Product status state machine](#product-status-state-machine)
- [Job status state machine](#job-status-state-machine)
- [Data model](#data-model)
- [Concurrency, locking, and the job queue](#concurrency-locking-and-the-job-queue)
- [Two ways to run the queue](#two-ways-to-run-the-queue)
- [Extensibility: adding a new source or publisher](#extensibility-adding-a-new-source-or-publisher)

## Layers

The codebase follows a clean/hexagonal architecture. Dependencies only ever
point inward — the domain layer has no imports from anywhere else in the
project, and every adapter exists to satisfy an interface ("port") the
domain or application layer defines.

```
interface (HTTP)  ─┐
worker (queue)      ├──► application (services, orchestrator) ──► domain (entities, enums, ports)
infrastructure ─────┘                                                     ▲
   (adapters implementing domain ports) ────────────────────────────────┘
boot (DI container, entrypoints) — wires everything above together
```

| Layer | Path | Responsibility |
|---|---|---|
| `domain` | `src/domain/` | Entities (`entities.ts`), enums (`enums.ts`), the Sheet's column schema (`sheet-schema.ts`), and every port/interface (`ports.ts`) the rest of the system implements or depends on. No dependencies on any other layer. |
| `application` | `src/application/` | `PipelineOrchestrator` (the six-stage workflow) plus application services: brand resolution, product import, copy/scheduling orchestration, publishing, settings, analytics, and small pure-function selectors. Depends only on domain ports, never on concrete infrastructure classes. |
| `infrastructure` | `src/infrastructure/` | Concrete adapters implementing the domain ports: product sources, social publishers, AI copy generators/LLM clients, the SVG/resvg image pipeline, the ffmpeg video renderer, the two Sheet store implementations, the two storage backends, the SQLite schema/repositories, and the webhook notifier. |
| `interface` | `src/interface/` | The HTTP surface: a raw `node:http` server (`http/server.ts`), a small path-matching router (`http/router.ts`), and the route handlers (`controllers/routes.ts`). |
| `worker` | `src/worker/` | `Worker` (polls the Sheet, claims rows, enqueues/executes jobs) and `WorkerRunner` (the interval-based scheduler around it). |
| `boot` | `src/boot/` | The composition root: `container.ts` builds and wires every concrete adapter behind its port, and `api.ts`/`worker.ts`/(`src/main.ts` for the combined process) are the process entrypoints. |
| `shared` | `src/shared/` | Cross-cutting, dependency-free utilities used by every layer: crypto, logging, retry/backoff, rate limiting, ID generation, clock/timezone math, CSV parsing, `.env` parsing, validation, typed errors, and an HTTP client wrapper. |
| `config` | `src/config/` | Typed environment-variable loading (`loadConfig()`), the single source of truth for every setting described in `.env.example`. |

## The dependency-injection container

There is no DI framework. `src/boot/container.ts` exports a `Container`
interface and a `buildContainer(configOverride?)` function that constructs
every adapter in dependency order and exposes them as one object:

```ts
interface Container {
  config: AppConfig;
  db: Database;
  sheet: ISheetStore;
  storage: IStorage;
  repos: { jobs, content, assets, videos, publications, logs, settings, accounts, dedupe, analytics };
  sources: ISourceRegistry;
  publishers: IPublisherRegistry;
  copyGenerator: ICopyGenerator;
  creativeEngine: ICreativeEngine;
  videoRenderer: IVideoRenderer;
  services: { brand, import, scheduler, publish, settings, analytics };
  orchestrator: PipelineOrchestrator;
  init(): Promise<void>;
  close(): void;
}
```

`buildContainer()` picks concrete implementations based on config — for
example `sheet` is a `GoogleSheetsStore` when `SHEET_STORE=google` and a
`LocalSheetStore` otherwise, `storage` is `GoogleDriveStorage` or
`LocalStorage`, and `copyGenerator` is `TemplateCopyGenerator` or an
`LlmCopyGenerator` wrapping whichever `ILlmClient` matches `AI_PROVIDER`.
Every process entrypoint (`src/main.ts`, `src/boot/api.ts`,
`src/boot/worker.ts`, and every script under `scripts/`) starts by calling
`buildContainer()` then `await container.init()`, which calls
`sheet.init()`/`ensureSchema()` and logs a one-line summary of what's wired
up (sheet kind, storage kind, AI provider, registered sources/publishers,
dry-run state).

## The adapter/registry pattern

Product sources and social publishers are looked up through small registries
— `Map<string, T>` keyed by a lowercase, normalized type/platform string —
rather than through `if`/`switch` statements scattered through the pipeline.

```ts
interface ISourceRegistry {
  register(source: IProductSource): void;
  get(type: string): IProductSource;     // throws NotFoundError, lists available types
  has(type: string): boolean;
  list(): IProductSource[];
}
// IPublisherRegistry is the same shape, keyed by platform instead of type.
```

`buildContainer()` registers exactly 8 sources (manual, csv, amazon,
shopify, woocommerce, etsy, flipkart, meesho) and exactly 6 publishers
(instagram, facebook, linkedin, pinterest, threads, x). The pipeline,
routes, and worker never reference a concrete source/publisher class by
name — they call `sources.get(row.productSource)` or
`publishers.get(platform)` and work entirely through the `IProductSource`
/`IPublisher` port. This is what makes adding a ninth source or a seventh
publisher a self-contained change (see
[Extensibility](#extensibility-adding-a-new-source-or-publisher) below).

Two base classes remove boilerplate from every concrete adapter:

- **`BaseProductSource`** — shared `downloadImages()` (up to 6 images per
  product, 20s timeout with 2 retries, content-type sniffing from magic
  bytes or the URL extension), dedupe-key computation, a default
  `isConfigured() = true` for sources that need no credentials, and a
  default no-op `connect()`.
- **`BasePublisher`** — `dryRunResult(req)` (returns
  `{status: 'dry_run', raw: {wouldPost: true, ...}}`), `composeCaption(req)`
  (appends hashtags up to each platform's own limit — e.g. 30 for
  Instagram, 4 for X — and truncates to that platform's character cap), and
  a generic fallback `schedule()` for platforms with no native scheduling
  API.

## Ports

Every port below is defined in `src/domain/ports.ts` and is the contract
that both the application layer (as a consumer) and one or more
infrastructure adapters (as implementers) agree on.

| Port | Purpose | Implementations |
|---|---|---|
| `IProductSource` | Import a normalized product from an external catalog/source | `ManualEntrySource`, `CsvSource`, `AmazonSource`, `ShopifySource`, `WooCommerceSource`, `EtsySource`, `FlipkartSource`, `MeeshoSource` |
| `ISourceRegistry` | Look up a product source by type | one instance, built by the container |
| `ILlmClient` | Send a completion request to an LLM and get text/JSON back | `OpenAiClient`, `GeminiClient`, `AnthropicClient` |
| `ICopyGenerator` | Produce a `GeneratedContent` object (captions/hooks/CTAs/hashtags/etc.) for a product | `TemplateCopyGenerator`, `LlmCopyGenerator` (wraps any `ILlmClient`) |
| `IImageRasterizer` | Rasterize an SVG string to PNG bytes | `ResvgRasterizer` |
| `ICreativeEngine` | Produce the full set of `GeneratedAsset`s for a product | the SVG-based creative engine (uses `IImageRasterizer`) |
| `IVideoRenderer` | Produce a `GeneratedVideo` for a product | `FfmpegVideoRenderer` |
| `IPublisher` | Publish or schedule a post on one platform | `InstagramPublisher`, `FacebookPublisher`, `LinkedInPublisher`, `PinterestPublisher`, `ThreadsPublisher`, `XPublisher` |
| `IPublisherRegistry` | Look up a publisher by platform | one instance, built by the container |
| `IStorage` | Persist a generated asset/video and return a fetchable URL | `LocalStorage`, `GoogleDriveStorage` |
| `ISheetStore` | Read/write the Sheet's 6 tabs (products, brand settings, schedule, content, logs, analytics) and claim rows atomically | `LocalSheetStore` (SQLite mirror), `GoogleSheetsStore` (Sheets API v4) |
| `IJobRepository` | The durable job queue: enqueue, claim, mark succeeded/failed/dead, requeue stale locks | SQLite-backed `JobRepository` |
| `IContentRepository` | Persist/read `GeneratedContent` | SQLite-backed `ContentRepository` |
| `IAssetRepository` | Persist/read `GeneratedAsset`s | SQLite-backed `AssetRepository` |
| `IVideoRepository` | Persist/read `GeneratedVideo`s | SQLite-backed `VideoRepository` |
| `IPublicationRepository` | Persist/read `Publication` records | SQLite-backed `PublicationRepository` |
| `ILogRepository` | Persist/read structured pipeline log lines | SQLite-backed `LogRepository` |
| `ISettingsRepository` | Generic key/value + JSON settings storage | SQLite-backed `SettingsRepository` |
| `IAccountRepository` | Persist/read encrypted `SocialAccount` credentials | SQLite-backed `AccountRepository` |
| `IDedupeRepository` | Track which products have already been imported, to reject re-imports | SQLite-backed `DedupeRepository` |
| `IAnalyticsRepository` | Record analytics events and compute dashboard rollups/daily snapshots | SQLite-backed `AnalyticsRepository` |
| `INotifier` | Fire a best-effort notification on pipeline events | `WebhookNotifier`, `NoopNotifier` |

`ISheetStore`'s key methods are worth calling out because they carry the
system's most important invariant — atomic claiming:

```ts
interface ISheetStore {
  init(): Promise<void>;
  ensureSchema(): Promise<void>;
  listProducts(opts): Promise<ProductRow[]>;
  getProduct(id): Promise<ProductRow | null>;
  appendProduct(row): Promise<ProductRow>;
  findClaimableRows(limit): Promise<ProductRow[]>;
  claimRow(row, workerId, ttlMs): Promise<{ won: boolean; row?: ProductRow }>;
  updateRow(id, patch): Promise<void>;
  setStatus(id, status, patch?): Promise<void>;
  appendLog(input): Promise<void>;
  getBrandSettings(brand?): Promise<BrandProfile | null>;
  upsertBrandSettings(profile): Promise<void>;
  appendGeneratedContent(content, platform, caption): Promise<void>;
  upsertSchedule(pub): Promise<void>;
  writeAnalytics(snapshot): Promise<void>;
}
```

## The pipeline

`PipelineOrchestrator.process(row, jobId?)` in `src/application/pipeline.ts`
is the heart of the system. It runs six numbered stages against a single
product row, updating the row's status in the Sheet and appending a log
entry at each step:

1. **Resolve brand** — `brandService.resolve(row)` merges the Sheet's
   `Brand Settings` tab (matched by the row's `Brand` column) over the
   configured brand defaults (`BRAND_NAME`, `BRAND_PRIMARY_COLOR`, etc.),
   Sheet values taking precedence.
2. **Import product** — `importService.import(row)` looks up the source
   adapter named in the row's `Product Source` column, fetches/normalizes
   the product, and downloads its images. A duplicate check
   (`dedupe.seen(product.dedupeKey)`) throws `ConflictError` if this exact
   product has already been imported, which stops the pipeline without
   retrying. Status becomes `PRODUCT_IMPORTED`.
3. **Generate copy** — `copyGenerator.generate(...)` produces captions,
   hooks, CTAs, hashtags, SEO keywords, and emojis for every requested
   platform and the resolved tone; each platform's caption is mirrored into
   the Sheet's `Generated Content` tab. Status becomes `CONTENT_CREATED`.
4. **Generate creative assets** — `creativeEngine.generate(...)` renders
   the branded image set and saves each one through the asset repository.
5. **Generate video** — `videoRenderer.generate(...)` renders the vertical
   promo video and saves it through the video repository. Status becomes
   `VIDEO_CREATED`.
6. **Publish** — `publishService.publishAll(...)` calls each requested
   platform's publisher (publishing immediately or scheduling, per the
   row's `Schedule Date`/`Schedule Time`), records an analytics
   `post_published` event per successful platform, and sets status to
   `POSTED` with either live permalinks or a dry-run summary.

If any stage throws, the orchestrator records a `pipeline_failed` analytics
event, sets the row's status to `FAILED` with a truncated error message,
logs the error, fires a best-effort notification, and rethrows — the caller
(the worker) decides whether to retry based on
`PipelineOrchestrator.isRetryable(err)`, which returns `false` (no retry,
go straight to dead-letter) for `ConflictError` and `ValidationError`, and
`true` for everything else (transient network/API failures).

## Product status state machine

Defined in `src/domain/enums.ts` as `ProductStatus`, with the happy-path
sequence captured in `STATUS_PROGRESSION`:

```
        ┌─────────────────────────────────────────────────────────────┐
        │                                                              │
  NEW ──►  PROCESSING ──►  PRODUCT_IMPORTED ──►  CONTENT_CREATED ──►  VIDEO_CREATED ──►  POSTED
        │       │                  │                    │                    │
        └───────┴──────────────────┴────────────────────┴────────────────────┘
                                          │
                                          ▼
                                       FAILED
```

- `NEW` — a row waiting to be claimed. This is the only status a worker
  will pick up via `findClaimableRows`.
- `PROCESSING` — claimed by a worker; the pipeline is running.
- `PRODUCT_IMPORTED` → `CONTENT_CREATED` → `VIDEO_CREATED` — intermediate
  checkpoints written after each corresponding pipeline stage completes,
  so the Sheet always reflects real progress even mid-run.
- `POSTED` — the terminal success state; the row's `Published URL`,
  `Generated Caption`, and `Generated Video` cells are filled in.
- `FAILED` — the terminal failure state after retries are exhausted (or
  immediately, for non-retryable errors); the `Error` cell holds the
  reason. `POST /api/products/:id/retry` (or the Apps Script "Mark Selected
  as NEW" menu item) resets a `FAILED` row back to `NEW` to try again.

## Job status state machine

Defined in `src/domain/enums.ts` as `JobStatus`, this tracks the **queue
entry** for a product row (distinct from the row's own `ProductStatus`):

```
QUEUED ──► RUNNING ──► SUCCEEDED
              │
              ├──► FAILED  (attempts < maxAttempts, retryable) ──► back to QUEUED after backoff
              │
              └──► DEAD    (retries exhausted, or a non-retryable error)
```

`JobRepository.requeueStale(ttlMs)` recovers jobs stuck in `RUNNING` past
their lock's TTL (e.g. because the worker process that claimed them
crashed), moving them back to `QUEUED` so another worker can pick them up.

## Data model

All persistent state lives in one SQLite database (`SQLITE_PATH`, default
`./data/app.db`), opened with `node:sqlite`'s `DatabaseSync` and configured
with `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, and
`synchronous=NORMAL`. Schema DDL lives in
`src/infrastructure/db/schema.ts` and is applied idempotently
(`CREATE TABLE IF NOT EXISTS`) on every boot.

**Operational tables** (used regardless of which Sheet store is active):

| Table | Purpose |
|---|---|
| `jobs` | The durable job queue — id, type, product row/id, status, attempts/max_attempts, lock owner/expiry, `available_at` (for backoff scheduling), last_error, payload |
| `generated_content` | One row per product: captions, hooks, ctas, hashtags, seo_keywords, emojis, tone, language, provider |
| `assets` | One row per rendered image: type, platform, index (for carousel slides), storage path/key/url, dimensions, size |
| `videos` | One row per rendered promo video: path/storage key/url, dimensions, duration, fps, size |
| `publications` | One row per (product, platform) publish attempt: status, scheduled/published timestamps, remote id, permalink, caption, error |
| `logs` | Structured pipeline log lines: timestamp, level, stage, message, product id, job id, arbitrary JSON data |
| `settings` | Generic key/value store (also used to stash JSON payloads like manual-entry product data) |
| `social_accounts` | Encrypted publisher credentials: platform, label, `encrypted_credentials` (AES-256-GCM), is_default |
| `dedupe` | Product dedupe keys already seen, to reject duplicate imports |
| `analytics_events` | Raw event log (`type`, product/platform, value, duration) that dashboard rollups and daily snapshots are computed from |

**Sheet-mirror tables** (`sheet_*`, used only by `LocalSheetStore` when
`SHEET_STORE=local`) — a faithful local mirror of the same six tabs a real
Google Sheet would have, plus the row-locking columns needed for atomic
claiming:

| Table | Mirrors |
|---|---|
| `sheet_products` | The `Products` tab, plus `lock_token`/`lock_worker`/`lock_expires` columns used only by `LocalSheetStore`'s claim logic |
| `sheet_brand_settings` | The `Brand Settings` tab |
| `sheet_schedule` | The `Publishing Schedule` tab |
| `sheet_generated` | The `Generated Content` tab |
| `sheet_logs` | The `Logs` tab |
| `sheet_analytics` | The `Analytics` tab |

When `SHEET_STORE=google`, none of the `sheet_*` tables are used — the real
Sheet is the source of truth, and a hidden `_Locks` tab (created by
`ensureSchema()`) plays the role that the `lock_*` columns play locally.

The Sheet's own column layout (identical whether it's the real Google Sheet
or the local mirror) is defined once in `src/domain/sheet-schema.ts`:

| Tab | Columns |
|---|---|
| `Products` (17 cols) | ID, Status, Product Source, Product URL, Product ID, Brand, Platform, Language, Category, Schedule Date, Schedule Time, Generated Caption, Generated Video, Published URL, Error, Created Time, Updated Time |
| `Brand Settings` (9 cols) | Brand, Primary Color, Accent Color, Text Color, Font, Logo URL, Watermark, CTA, Language |
| `Publishing Schedule` (8 cols) | ID, Product ID, Platform, Scheduled At, Status, Published At, Permalink, Error |
| `Generated Content` (9 cols) | ID, Product ID, Platform, Tone, Caption, Hashtags, Hooks, CTAs, Created At |
| `Logs` (7 cols) | Time, Level, Product ID, Job ID, Stage, Message, Data |
| `Analytics` (8 cols) | Date, Products Processed, Posts Published, Videos Created, Queue Size, Failed Jobs, Success Rate, Avg Processing Ms |
| `_Locks` (hidden, Google-Sheets-mode only, 4 cols) | Row ID, Token, Worker, Expires At |

## Concurrency, locking, and the job queue

Multiple workers (in-process or across separate processes/containers) can
poll and drain the same queue safely because every claim is a single atomic
operation, never a read-then-write pair:

- **Claiming a Sheet row locally** (`LocalSheetStore`) is one SQL statement:
  ```sql
  UPDATE sheet_products
  SET status = 'PROCESSING', lock_token = ?, lock_worker = ?, lock_expires = ?
  WHERE id = ? AND (status = 'NEW' OR (status = 'PROCESSING' AND lock_expires < ?))
  ```
  Exactly one worker's `UPDATE` matches and changes a row; every other
  concurrent attempt affects zero rows and knows it lost the race. Stale
  locks (a worker that crashed mid-processing) are recovered by the same
  statement's `lock_expires < ?` clause — no separate sweep needed.
- **Claiming a Sheet row on Google Sheets** (`GoogleSheetsStore`) can't rely
  on a single atomic statement, since the Sheets API has no transactions.
  Instead it uses an optimistic-lock protocol against the hidden `_Locks`
  tab: write a lock record for the row, wait ~300ms, re-read the `_Locks`
  tab, and only proceed if this worker's token is the earliest non-expired
  one recorded for that row. This tolerates the eventual-consistency nature
  of the Sheets API while still converging on exactly one winner in
  practice.
- **Claiming a queue job** (`JobRepository.claimNext`) runs inside a
  `db.tx()` transaction: `SELECT` a candidate job, then `UPDATE ... WHERE
  status = 'QUEUED'` and check `changes === 1` before treating the claim as
  successful — the same "single conditional UPDATE" pattern as the local
  Sheet claim, just scoped to the `jobs` table.
- **Retries use exponential backoff**:
  `delay = min(RETRY_MAX_DELAY_MS, RETRY_MIN_DELAY_MS * 2^(attempt-1))`,
  recomputed on every failure and stored as the job's `available_at`.
- **Rate limiting** is a token-bucket (`RateLimiter`, refilled continuously
  based on elapsed time) sized by `RATE_LIMIT_PER_MINUTE`, acquired once per
  job before the orchestrator runs — this throttles pipeline throughput,
  independent of any per-platform API rate limits the publishers themselves
  may hit.
- **Stale-lock recovery**: `JobRepository.requeueStale(ttlMs)` runs at the
  start of every drain cycle, moving any job whose lock has expired
  (crashed worker) back to `QUEUED`.

## Two ways to run the queue

There are two distinct code paths that move a product row through the
pipeline, and it's worth knowing which is which:

- **The worker/job-queue path** (`Worker` + `WorkerRunner`, used by
  `node src/main.ts` and `node src/boot/worker.ts`) — `pollSheet()` claims
  `NEW` rows and *enqueues a job* for each one; a separate drain loop then
  claims and executes queued jobs with retry/backoff/dead-lettering. This
  is the production path: durable, retryable, and safe to run with multiple
  worker processes.
- **The direct/synchronous path** (`scripts/run-once.ts`) — claims
  claimable rows and calls `orchestrator.process(row)` directly, with no job
  queue involved at all. This is a single-pass tool for smoke-testing and
  manual verification, not a substitute for the worker in production (see
  [`docs/TESTING.md`](TESTING.md)).

`POST /api/actions/run` is a hybrid: it uses the real `Worker` class to
poll and enqueue immediately, then kicks off `drainToEmpty()` in the
background without awaiting it, so the HTTP response returns right away
while processing continues asynchronously.

## Extensibility: adding a new source or publisher

Because everything routes through `IProductSource`/`IPublisher` and the two
registries, adding a ninth product source or a seventh publisher never
requires touching the pipeline, the routes, or the worker.

**Adding a product source:**

1. Create `src/infrastructure/sources/your-source.ts` implementing
   `IProductSource` (extend `BaseProductSource` to get image downloading,
   dedupe-key computation, and a default `isConfigured()`/`connect()` for
   free). Implement `type`, `isConfigured()` (check whatever credentials
   your source needs), and `importProduct(input)` returning a
   `NormalizedProduct`.
2. Add any new environment variables it needs to `.env.example` and read
   them in `src/config/index.ts`.
3. Register an instance in `src/boot/container.ts`:
   `sources.register(new YourSource(config, ...))`.

**Adding a social publisher:**

1. Create `src/infrastructure/publishers/your-platform.ts` implementing
   `IPublisher` (extend `BasePublisher` for `dryRunResult()` and
   `composeCaption()` with your platform's hashtag/character limits).
   Implement `platform`, `isConfigured()`, `publish(req)`, and — if the
   platform supports it — `schedule(req, whenIso)`; otherwise rely on
   `BasePublisher`'s generic fallback.
2. Add its credential environment variables to `.env.example`/config.
3. Register it in `src/boot/container.ts`:
   `publishers.register(new YourPlatformPublisher(config, ...))`.
4. Add the platform name to the `Platform` union in `src/domain/enums.ts`
   so it's accepted in the Sheet's `Platform` column and the API's
   `platform`/`platforms` fields.

In both cases the new adapter is immediately available everywhere the
existing eight sources/six publishers are: the Sheet's `Product Source`/
`Platform` columns, the `POST /api/products` API, the dashboard's settings
page (via `GET /api/health`/`GET /api/settings`, which list every
registered source/publisher and whether it's configured), and the
pipeline's own `import`/`publish` stages.
