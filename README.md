# AI Social Commerce Agent

**Your AI marketing employee: products in, social content out.**

Drop a product into a Google Sheet (or the built-in dashboard, or the REST
API) and the agent takes it the rest of the way — importing product data,
writing platform-native copy, rendering branded images and a vertical promo
video, and publishing or scheduling the result across six social platforms.
Every step is logged back to the Sheet so a non-technical operator can watch
the whole pipeline from a spreadsheet they already know how to read.

It is built to run **anywhere Node.js runs**, with **zero npm runtime
dependencies**. There is no build step, no bundler, no Redis, and no cloud
lock-in unless you opt into one. The only two prerequisites are a
Node.js 22.6+ runtime and `ffmpeg`/`ffprobe` on `PATH`.

```
Google Sheet row (Status = NEW)
        │
        ▼
   Worker polls every POLL_INTERVAL_MINUTES, claims the row atomically
        │
        ▼
┌──────────────────────────── Pipeline ────────────────────────────┐
│  1. Import product      (source adapter: manual/csv/amazon/...)  │
│  2. Generate copy        (6 platforms × captions, hooks, CTAs,   │
│                            hashtags — template or LLM)           │
│  3. Render creatives      (branded PNGs via SVG + resvg)         │
│  4. Render promo video    (1080×1920 MP4 via ffmpeg)             │
│  5. Publish / schedule    (Instagram, Facebook, LinkedIn,        │
│                            Pinterest, Threads, X — or dry-run)   │
│  6. Write results back    (captions, media links, permalinks,    │
│                            errors — into the Sheet + dashboard)  │
└────────────────────────────────────────────────────────────────────┘
```

## Contents

- [Features](#features)
- [Architecture at a glance](#architecture-at-a-glance)
- [Why zero dependencies](#why-zero-dependencies)
- [Quick start](#quick-start)
- [Connecting a real Google Sheet](#connecting-a-real-google-sheet)
- [Product sources](#product-sources)
- [Social publishers](#social-publishers)
- [AI copy providers](#ai-copy-providers)
- [Configuration reference](#configuration-reference)
- [The dashboard](#the-dashboard)
- [Admin & Operations](#admin--operations)
- [Security](#security)
- [What works out of the box vs. what needs your keys](#what-works-out-of-the-box-vs-what-needs-your-keys)
- [Further reading](#further-reading)
- [License](#license)

## Features

- **Sheet-native control surface.** The Google Sheet (or a local SQLite
  mirror of the same schema) *is* the product queue, the brand-settings
  panel, the publishing calendar, the content log, and the analytics tab —
  six tabs, no separate admin database to learn.
- **Eight product sources.** Manual entry, CSV (local file or URL), Amazon
  (official Product Advertising API v5, not scraping), Shopify, WooCommerce,
  Etsy, Flipkart, and Meesho.
- **Six-platform copy generation.** Instagram, Facebook, LinkedIn, Pinterest,
  Threads, and X, each with a platform-shaped caption plus 2 variations, 10
  hooks, 5 CTAs, 30 hashtags, 10-15 SEO keywords, and a curated emoji set —
  generated deterministically for free, or via OpenAI/Gemini/Anthropic for
  more original copy.
- **Seven brand tones.** Professional, friendly, luxury, minimal, funny,
  sales, and urgent — selectable per product or per brand.
- **Branded creative rendering.** Six asset types (feed post, story,
  carousel, Pinterest pin, Facebook image, LinkedIn image) rendered as SVG
  and rasterized to PNG with your brand colors, logo, and watermark — no
  headless browser, no Canvas native module.
- **Vertical promo video.** A 1080×1920 MP4 with Ken Burns zoom/pan across
  the product's hero and feature shots, scene transitions, a CTA closer, and
  an ambient synthesized audio bed (or your own music track) — rendered by
  `ffmpeg`.
- **Six-platform publishing, with real dry-run safety.** Every publisher
  refuses to make a live API call — and instead returns a structured
  `dry_run` result — whenever `DRY_RUN=true` *or* its credentials are
  missing. Nothing goes out live by accident.
- **Durable, DB-backed job queue.** SQLite-backed queue with atomic row
  claiming, exponential-backoff retries, stale-lock recovery, and a
  dead-letter status after retries are exhausted. No Redis required.
- **Encrypted credential storage.** Social account tokens saved through the
  dashboard/API are encrypted at rest with AES-256-GCM; nothing sensitive is
  ever written to logs.
- **A real dashboard**, not just an API — 8 pages covering products,
  generated content, videos, the publishing queue, analytics, logs, and
  settings, served as a dependency-free single-page app.
- **An optional Google Apps Script bundle** (`apps-script/`) that adds an
  "AI Agent" menu directly inside the Sheet for operators who never want to
  leave it.
- **An admin panel** (`/#admin`) with system health, live system info,
  Prometheus-metrics link, backup management, and worker controls
  (run-now, requeue-stale-jobs) in one operator-facing view.
- **A first-run setup wizard** — a checklist of what's configured
  (encryption key, brand, AI provider, sheet, store integrations, social
  publishers) plus one-click live connection tests, re-openable from the
  admin panel any time after first run.
- **Layered health checks** — `GET /api/health` (200/503 readiness with
  per-dependency detail), `/api/health/live`, and `/api/health/ready`,
  wired into the Docker/Compose `HEALTHCHECK` and the Fly.io health check.
- **Monitoring & Prometheus metrics** — `GET /api/system` for point-in-time
  process/host info, and `GET /api/metrics` exporting job-queue, success-rate,
  and throughput counters in Prometheus text exposition format.
- **Backup & restore** — consistent `.tgz` snapshots (SQLite `VACUUM INTO`
  + generated assets) taken safely while the app is live, from the admin
  panel or `node scripts/backup.ts`, with download, pruning, and a
  deliberately separate, explicit `node scripts/restore.ts` for the
  destructive restore path.
- **A one-click installer** (`./install.sh`) that installs Docker if
  needed, generates a secure `.env`, and — optionally — stands up HTTPS +
  basic auth via Caddy for a production host in one command.
- **Auto-update tooling** (`./update.sh`) that backs up, pulls the latest
  code, rebuilds, restarts, and prunes old images — plus an optional
  Watchtower path for registry-based deployments.

## Architecture at a glance

The codebase follows a clean/hexagonal layering. Business rules live in the
center and never import from the edges; adapters at the edges implement
interfaces ("ports") defined at the center.

```
src/
├── domain/            entities, enums, ports (interfaces) — no dependencies
├── application/       pipeline orchestrator + application services
├── infrastructure/     adapters that implement the domain ports
│   ├── sources/        manual, csv, amazon, shopify, woocommerce, etsy,
│   │                   flipkart, meesho
│   ├── publishers/      instagram, facebook, linkedin, pinterest, threads, x
│   ├── ai/              template generator + openai/gemini/anthropic clients
│   ├── image/           SVG creative kit + resvg-wasm rasterizer
│   ├── video/           ffmpeg-based promo video renderer
│   ├── sheets/           LocalSheetStore (SQLite) + GoogleSheetsStore
│   ├── storage/         local filesystem + Google Drive
│   ├── db/               SQLite schema + repositories
│   └── notify/          webhook notifier
├── interface/http/     raw node:http server, router, controllers
├── worker/              job queue runner (polling, claiming, retrying)
├── boot/                dependency-injection container + entrypoints
├── shared/              crypto, logger, retry, rate limiter, ids, clock,
│                        csv, dotenv, validation, errors, http client
└── config/              typed env-var loader
apps-script/             optional Apps Script bundle for the Sheet itself
scripts/                 seed.ts, run-once.ts, provision-sheet.ts, migrate.ts
web/                     the dashboard SPA (HTML/CSS/JS, no framework)
vendor/                  vendored resvg-wasm binary + Poppins font files
tests/                   node:test suite
```

Adapters are wired through a hand-rolled dependency-injection container
(`src/boot/container.ts`) and looked up through small `Map`-backed registries
keyed by source type or platform — adding a new source or publisher never
touches the pipeline itself. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full breakdown,
including the port list, the product status state machine, and the SQLite
data model.

## Why zero dependencies

This project deliberately ships with **no runtime npm packages** — only
`typescript` and `@types/node` as dev-only tooling for type-checking. That is
possible because Node.js 22.6+ now ships, natively, everything this kind of
service used to need a library for:

| Need | Traditionally | Here |
|---|---|---|
| Run TypeScript | `ts-node`, `tsx`, a `tsc` build step | Node's native type-stripping runs `.ts` files directly — `node src/main.ts` |
| SQL database | `better-sqlite3`, `pg`, an ORM | `node:sqlite` (`DatabaseSync`), Node's built-in synchronous SQLite driver |
| HTTP server | Express / Fastify | `node:http` with a small hand-rolled router |
| HTTP client | `axios`/`node-fetch` | the global `fetch` |
| Encryption / JWT | `jsonwebtoken`, a crypto wrapper | `node:crypto` directly (AES-256-GCM, manual RS256 JWT signing) |
| `.env` loading | `dotenv` | a ~60-line hand-rolled parser |
| CSV parsing | `csv-parse` | a hand-rolled RFC-4180-ish parser |
| Image rendering | `sharp`, `canvas`, a headless browser | hand-written SVG + the vendored `resvg-wasm` binary (WebAssembly, no native build) |
| Video rendering | a Node video library | the external `ffmpeg`/`ffprobe` binaries, invoked as a child process |

The result is a service with a `node_modules` folder containing nothing but
`typescript`, no lockfile drift risk from transitive dependencies, no native
module rebuilds across platforms, and a Docker image that never runs
`npm ci`. The only two things you cannot get from Node itself are
`ffmpeg`/`ffprobe` (an OS-level binary, installed via `apt`/`brew`/the
official Docker image) and the vendored `resvg-wasm` + Poppins font files
already committed under `vendor/`.

## Quick start

Requirements: **Node.js 22.6 or newer** (for `node:sqlite` and native
TypeScript execution) and **`ffmpeg`/`ffprobe` on `PATH`** (for video
rendering only — everything else works without it).

On a Docker-capable Linux host, the fastest path is the one-click
installer, which installs Docker if needed, generates a secure `.env`,
and builds + starts the whole stack:

```bash
./install.sh
```

See [Admin & Operations](#admin--operations) below (and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md)) for what it does and for the
`PROD=1` variant that adds HTTPS + basic auth via Caddy. To run without
Docker, or to understand each step individually, continue with the manual
walkthrough:

```bash
# 1. Clone and enter the project — there is no `npm install` step for
#    runtime dependencies (there are none). If you want type-checking or
#    to run the test suite, install the two dev tools:
npm install

# 2. Copy the environment template
cp .env.example .env

# 3. Generate an encryption key (used to encrypt stored social credentials)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste the output into ENCRYPTION_KEY= in .env

# 4. Seed a demo brand and two demo products (zero credentials required —
#    this uses the local SQLite-backed Sheet mirror by default)
node scripts/seed.ts

# 5. Run the pipeline once, synchronously, against whatever is queued
#    (great for a first smoke test — no server, no worker loop)
node scripts/run-once.ts

# 6. Start the full service (API + polling worker in one process)
node src/main.ts
```

Then open **http://localhost:8080** for the dashboard, or:

```bash
curl http://localhost:8080/api/health
```

By default `SHEET_STORE=local`, so steps 4-6 above run entirely against a
local SQLite database (`./data/app.db`) with a schema that mirrors the
6-tab Google Sheet exactly — no Google credentials needed to try the whole
pipeline end to end. Publishing defaults to `DRY_RUN=true`, so nothing is
posted to a real social account until you deliberately configure it
otherwise.

Two more entrypoints exist for running the API and the worker as separate
processes (e.g. to scale worker capacity independently):

```bash
node src/boot/api.ts      # HTTP API + dashboard only
node src/boot/worker.ts   # polling worker only, no HTTP server
```

## Connecting a real Google Sheet

Local mode is the default and the fastest way to try the agent, but the
intended production setup is a real Google Sheet as the operator-facing
control surface.

1. **Create a Google Cloud service account** with the Sheets API (and Drive
   API, if you'll use Drive for storage) enabled, and download its JSON key.
2. **Create a Google Sheet** (or reuse one) and **share it** with the service
   account's `client_email` as an **Editor**.
3. Set the following in `.env`:
   ```
   SHEET_STORE=google
   GOOGLE_SHEETS_SPREADSHEET_ID=<the sheet's ID from its URL>
   GOOGLE_SERVICE_ACCOUNT_FILE=./credentials/service-account.json
   ```
   (or set `GOOGLE_SERVICE_ACCOUNT_JSON` with the key contents inline instead
   of a file path — useful for container/secret-manager deployments).
4. Start the app. On boot it calls `ensureSchema()`, which creates any of the
   six tabs that don't already exist (`Products`, `Brand Settings`,
   `Publishing Schedule`, `Generated Content`, `Logs`, `Analytics`) plus a
   hidden `_Locks` tab used internally for atomic row claiming, and writes
   header rows where missing — it never overwrites data that's already
   there.
5. Optionally install the **Apps Script bundle** in `apps-script/` for an
   "AI Agent" menu inside the Sheet itself (add products via a sidebar form,
   trigger an immediate poll, reset failed rows to `NEW`) — see
   [`apps-script/README.md`](apps-script/README.md). This is entirely
   optional; the backend polls the Sheet on its own schedule regardless.

Authentication to the Sheets (and Drive) API is done with a hand-rolled
RS256-signed JWT bearer flow against the service account's private key —
there is no dependency on `google-auth-library`.

To switch back to local mode at any time, set `SHEET_STORE=local`. The two
stores implement the same `ISheetStore` port, so the rest of the pipeline is
unaffected by which one is active.

## Product sources

Selected per product via the `Product Source` column (or the `source` field
when adding a product through the API/dashboard).

| Source | Credentials required | Notes |
|---|---|---|
| `manual` | none | Product fields supplied directly (dashboard form, API body, or inline JSON) |
| `csv` | none | Reads a local file path or an `https://` URL; flexible, case-insensitive header matching |
| `amazon` | `AMAZON_PAAPI_ACCESS_KEY`, `AMAZON_PAAPI_SECRET_KEY`, `AMAZON_PAAPI_PARTNER_TAG` | Official Product Advertising API v5 only, AWS SigV4-signed — no scraping |
| `shopify` | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | Admin REST API |
| `woocommerce` | `WOOCOMMERCE_BASE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET` | REST API v3, Basic Auth |
| `etsy` | `ETSY_API_KEY`, `ETSY_ACCESS_TOKEN` | Open API v3 |
| `flipkart` | `FLIPKART_AFFILIATE_ID`, `FLIPKART_AFFILIATE_TOKEN` | Affiliate API |
| `meesho` | `MEESHO_API_TOKEN`, `MEESHO_BASE_URL` | Partner catalogue API |

A source with missing credentials fails fast with a clear "not configured"
error rather than silently degrading — check `GET /api/health` or
`GET /api/settings` to see which sources are currently configured.

## Social publishers

Selected per product via the `Platform` column (comma-separated for
multiple platforms). Every publisher is **dry-run by default** — it returns
a structured `{status: 'dry_run', raw: {wouldPost: true, ...}}` result
instead of calling the real API whenever `DRY_RUN=true` or its own
credentials are missing, so you can exercise the entire pipeline safely
before connecting a live account.

| Platform | Credentials required | Media | Native scheduling |
|---|---|---|---|
| `instagram` | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID` | image or video (Meta Graph API container flow) | no |
| `facebook` | `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` | image or video | yes |
| `linkedin` | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN` | image only | no |
| `pinterest` | `PINTEREST_ACCESS_TOKEN`, `PINTEREST_DEFAULT_BOARD_ID` | image only | no |
| `threads` | `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID` | image or video | no |
| `x` | `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | image (falls back to text-only tweet if media upload fails) | no |

Platforms without native scheduling still get scheduled in the sense that
the pipeline holds the post until its `Schedule Date`/`Schedule Time` are
due, then publishes immediately at that point via the worker's own polling
loop.

## AI copy providers

Set `AI_PROVIDER` to choose how captions, hooks, CTAs, hashtags, SEO
keywords, and emojis are generated. All four providers produce the exact
same `GeneratedContent` shape, so downstream rendering and publishing code
never needs to know which one ran.

| Provider | Requires | Behavior |
|---|---|---|
| `template` (default) | nothing | Deterministic, rule-based generator: 7 selectable tones, always 10 hooks / 5 CTAs / 30 hashtags, 10-15 SEO keywords, 8-12 emojis, and platform-shaped captions (1 primary + 2 variations) for each of the 6 platforms |
| `openai` | `OPENAI_API_KEY` | Chat Completions API (`gpt-4o-mini` by default), JSON mode |
| `gemini` | `GEMINI_API_KEY` | `generateContent` API (`gemini-1.5-flash` by default), JSON response mode |
| `anthropic` | `ANTHROPIC_API_KEY` | Messages API (`claude-3-5-sonnet-latest` by default) |

The LLM-backed providers ask the model for structured JSON and then
backfill any field the model omits or malforms from the same template
generator — so an LLM hiccup degrades gracefully to good, on-brand copy
rather than a pipeline failure.

## Configuration reference

Every setting lives in environment variables, documented with defaults and
comments in [`.env.example`](.env.example). Copy it to `.env` and edit; the
main sections are:

- **Core** — `NODE_ENV`, `LOG_LEVEL`, `HTTP_PORT`, `HTTP_HOST`, `PUBLIC_BASE_URL`
- **Security** — `ENCRYPTION_KEY` (32-byte hex, required)
- **Persistence** — `SQLITE_PATH`, `DATABASE_DRIVER`, `DATABASE_URL`
- **Google Sheet** — `SHEET_STORE`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_FILE` / `_JSON`
- **Storage** — `STORAGE_DRIVER` (`local` or `gdrive`), `STORAGE_LOCAL_DIR`, `GDRIVE_FOLDER_ID`
- **AI copy** — `AI_PROVIDER` and each provider's API key/model/base URL
- **Product sources** — one block of credentials per source, see the table above
- **Social publishers** — `DRY_RUN`, `META_GRAPH_VERSION`, and one block of credentials per platform
- **Automation** — `POLL_INTERVAL_MINUTES`, `WORKER_CONCURRENCY`, `RETRY_MAX`, `RETRY_MIN_DELAY_MS`/`RETRY_MAX_DELAY_MS`, `JOB_LOCK_TTL_MS`, `RATE_LIMIT_PER_MINUTE`, `POSTING_TIMES`, `TIMEZONE`
- **Brand defaults** — `BRAND_NAME`, `BRAND_PRIMARY_COLOR`, `BRAND_ACCENT_COLOR`, `BRAND_TEXT_COLOR`, `BRAND_FONT`, `BRAND_LOGO_URL`, `WATERMARK_TEXT`, `DEFAULT_CTA`, `DEFAULT_LANGUAGE`
- **Video** — `FFMPEG_PATH`, `FFPROBE_PATH`, `VIDEO_DURATION_SECONDS` (clamped 15-30), `VIDEO_FPS`, `VIDEO_MUSIC_FILE`, `VIDEO_MUSIC_ENABLED`
- **Notifications** — `NOTIFY_WEBHOOK_URL` (optional webhook fired on pipeline events)

See [`docs/SETUP.md`](docs/SETUP.md) for step-by-step credential acquisition
for every integration, and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for
running it in Docker.

## The dashboard

A dependency-free single-page app served at `/` (plain HTML/CSS/JS, no
framework, no build step) covering 9 pages, all backed by the REST API
documented in [`docs/API.md`](docs/API.md):

- **Dashboard** — processing stats, queue snapshot by status, system health
  (sheet backend, storage backend, AI provider, dry-run state)
- **Products** — every row from the Sheet, its status, and a detail view
  with its generated captions, creative assets, video, and publication
  results, plus a "re-queue" action
- **Generated Content** — captions/hooks/CTAs/hashtags produced per product
- **Video Library** — every rendered promo video
- **Publishing Queue** — the job queue by status (queued/running/succeeded/failed/dead)
- **Analytics** — the same rollups as `GET /api/analytics`
- **Logs** — the pipeline's structured log stream, filterable by level/product
- **Settings** — brand colors/logo/CTA, posting-time slots, connected social
  accounts (add/remove — credentials are encrypted before storage and never
  returned by the API), and at-a-glance configuration status for every
  source and publisher
- **Admin** — system health, system info, metrics, backups, and worker
  controls; see [Admin & Operations](#admin--operations) below

## Admin & Operations

Beyond the pipeline itself, the agent ships with an operator-facing admin
layer: a `/#admin` panel, a first-run setup wizard, layered health/readiness
probes, Prometheus-compatible metrics, structured logging with automatic
secret redaction, backup/restore tooling, and one-command install/update
scripts. The full walkthrough — including the exact health-check
semantics, the Prometheus metric list and a sample scrape config, how
backups stay consistent while the app is live, and cron examples for
scheduled backups/updates — lives in
**[`docs/OPERATIONS.md`](docs/OPERATIONS.md)**. In short:

- **Admin panel** (`/#admin`) — system health and system info at a
  glance, a link to `/api/metrics`, a backups table with create/download/prune,
  and worker controls (run now, requeue stale jobs).
- **Setup wizard** — a first-run checklist (encryption key, brand, AI
  provider, sheet, store integrations, publishers) with live connection
  tests; auto-opens until completed or dismissed, and is always
  re-openable from the admin panel afterward.
- **Health checks** — `GET /api/health` (200 ready / 503 not-ready, with
  per-dependency detail), plus `/api/health/live` and `/api/health/ready`
  for orchestrators that separate the two concerns. This is the same
  endpoint the Docker/Compose `HEALTHCHECK` and the Fly.io health check
  poll.
- **Monitoring** — `GET /api/system` for point-in-time process/host info,
  and `GET /api/metrics` for Prometheus scraping (queue depth, success
  rate, throughput counters, memory).
- **Backup & restore** — `node scripts/backup.ts` (or the admin panel)
  takes a consistent `.tgz` snapshot safely while the app is live; restore
  with `node scripts/restore.ts <file> --yes` after stopping the app
  (destructive by design, so it is a deliberate script, not a button).
- **One-click install** — `./install.sh` for a local/dev instance, or
  `PROD=1 SITE_ADDRESS=your.domain [email protected] ./install.sh`
  for a production host with HTTPS + basic auth via Caddy.
- **Auto-updates** — `./update.sh` backs up, pulls, rebuilds, and
  restarts; cron it for a hands-off update cadence, or swap in Watchtower
  if you publish the image to a registry.

## Security

- **Credentials at rest are encrypted.** Social account tokens saved via
  `POST /api/settings/accounts` are encrypted with **AES-256-GCM**
  (`node:crypto`, keyed by `ENCRYPTION_KEY`) before being written to SQLite;
  the API never echoes credentials back, even on the same request that
  saved them.
- **Google service-account auth uses a manually signed RS256 JWT**
  (bearer-token flow against `oauth2.googleapis.com/token`) — the private
  key never leaves the process and is not sent anywhere except in that
  signed assertion.
- **Secrets never appear in logs.** The logger recursively redacts any
  object key matching a token/secret/password/authorization/cookie/API-key
  pattern before writing a log line.
- **All secrets live in environment variables** (or the encrypted
  `social_accounts` table) — never hardcoded, never committed.
- **Dry-run is the fail-safe default.** Any publisher missing its
  credentials — regardless of the global `DRY_RUN` flag — automatically
  short-circuits to a dry-run result instead of erroring or silently
  skipping.

## What works out of the box vs. what needs your keys

**Works with zero credentials**, using `SHEET_STORE=local` and
`AI_PROVIDER=template` (both defaults):

- The full pipeline end to end: importing a manual/CSV product, generating
  platform copy, rendering all six branded image types, rendering the
  1080×1920 promo video, and "publishing" in dry-run mode
- The dashboard, the REST API, the job queue, retries, analytics, and logs
- `node scripts/seed.ts` + `node scripts/run-once.ts` as a complete smoke test

**Needs your own credentials:**

- A **real Google Sheet** as the control surface (`SHEET_STORE=google`) —
  needs a Google service account
- **Any product source other than `manual`/`csv`** — Amazon, Shopify,
  WooCommerce, Etsy, Flipkart, and Meesho all require that platform's API
  credentials
- **Actually posting to social media** — every publisher needs its
  platform's access token(s); without them (or with `DRY_RUN=true`) posting
  stays in dry-run mode indefinitely
- **LLM-generated copy** (`openai`/`gemini`/`anthropic`) instead of the
  free, deterministic template generator — needs that provider's API key
- **Google Drive as the storage backend** instead of the local filesystem —
  reuses the same Google service account as the Sheet

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, ports, the
  product status state machine, the data model, and how to add a new
  source or publisher
- [`docs/SETUP.md`](docs/SETUP.md) — installation and per-integration
  credential setup
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Docker, docker-compose,
  scaling, and running as a service
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — the admin panel, setup
  wizard, health checks, metrics, logging, backup/restore, and
  install/update scripts
- [`docs/TESTING.md`](docs/TESTING.md) — the test suite and manual
  verification workflow
- [`docs/API.md`](docs/API.md) — the full REST endpoint reference
- [`deploy/README.md`](deploy/README.md) — the production Caddy overlay
  and the Fly.io deployment files
- [`apps-script/README.md`](apps-script/README.md) — the optional in-Sheet
  operator UI

## License

MIT — see the `license` field in [`package.json`](package.json).
