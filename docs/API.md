# REST API Reference

All routes are registered in `src/interface/controllers/routes.ts` and
served over plain `node:http` (no Express/Fastify). Requests and responses
are JSON except where noted. There is no authentication layer built into
the API itself — if you expose it beyond localhost, put it behind your own
reverse proxy/auth (see the note in [Security](#security-note) below).

Base URL in local development: `http://localhost:8080`. The dashboard SPA
(served at `/`) is a plain client of this same API — every page you see in
the browser is backed by one or more of the endpoints below.

## Contents

- [Conventions](#conventions)
- [Health & dashboard](#health--dashboard)
- [Products](#products)
- [Generated content](#generated-content)
- [Assets & videos](#assets--videos)
- [Queue](#queue)
- [Publications](#publications)
- [Analytics](#analytics)
- [Logs](#logs)
- [Settings](#settings)
- [Actions](#actions)
- [Admin & operations](#admin--operations)
- [Errors](#errors)
- [Security note](#security-note)

## Conventions

- All `POST`/`PUT` request bodies are JSON (`content-type: application/json`).
- List endpoints accept `limit`/`offset` query parameters where noted; all
  numeric query parameters fall back to a sensible default if omitted,
  non-numeric, or non-positive.
- Every product/content/asset/video/publication object mirrors the
  entities defined in `src/domain/entities.ts` and, for product rows
  specifically, the Sheet's own `Products` tab columns
  (`src/domain/sheet-schema.ts`) — see
  [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#data-model) for the authoritative
  column/field list.
- `version` reported by `/api/health`, `/api/health/live`, and `/api/system`
  is read from `package.json` at runtime (currently `1.0.0`).
- `/api/health`, `/api/health/live`, `/api/health/ready`, `/api/system`,
  `/api/metrics`, every `/api/setup/*` route, and every `/api/admin/*` route
  are registered separately from the rest of this file, in
  `src/interface/controllers/admin-routes.ts` — see
  [Admin & operations](#admin--operations) for the full reference, and
  [`docs/OPERATIONS.md`](OPERATIONS.md) for the operator-facing walkthrough
  (admin panel, setup wizard, backups, metrics, logging, install/update).

## Health & dashboard

### `GET /api/health`

The primary health/readiness probe — also what the Docker/Compose
`HEALTHCHECK`, the `deploy/docker-compose.prod.yml` overlay, and
`deploy/fly.toml`'s `[[http_service.checks]]` all poll. Runs four
dependency checks (database, storage, ffmpeg, sheet) and returns **200**
when every *critical* check passes, or **503** otherwise.

```
GET /api/health
```

```json
{
  "status": "ok",
  "ready": true,
  "version": "1.0.0",
  "uptimeSec": 41285,
  "timestamp": "2026-07-19T09:12:03.441Z",
  "checks": [
    { "name": "database", "ok": true, "critical": true },
    { "name": "storage", "ok": true, "critical": true, "detail": "local" },
    { "name": "ffmpeg", "ok": true, "critical": true, "detail": "available" },
    { "name": "sheet", "ok": true, "critical": false, "detail": "local store" }
  ]
}
```

`status` is `"degraded"` whenever any check fails, even a non-critical one
(only `sheet` is non-critical); `ready` (and the HTTP status) reflect only
the critical checks, so `ready: true` with `status: "degraded"` is a valid
combination — treat `ready`/HTTP status as the automated go/no-go signal,
and `status`/`checks` as the human-readable detail. Full semantics,
including what each check verifies, are in
[`docs/OPERATIONS.md`](OPERATIONS.md#health--readiness).

To check what sources/publishers are currently configured (the previous
`/api/health` behavior in this project), use `GET /api/settings` or
`GET /api/dashboard`, both of which still include that breakdown.

### `GET /api/dashboard`

Aggregated stats for the dashboard's home page: analytics rollups, product
counts by status, and a system health summary.

```
GET /api/dashboard
```

```json
{
  "stats": {
    "productsProcessed": 12,
    "postsPublished": 34,
    "videosCreated": 12,
    "queueSize": 0,
    "failedJobs": 1,
    "successRate": 0.92,
    "avgProcessingMs": 8400
  },
  "products": {
    "total": 12,
    "waiting": 0,
    "processing": 0,
    "posted": 11,
    "failed": 1,
    "byStatus": {
      "NEW": 0,
      "PROCESSING": 0,
      "PRODUCT_IMPORTED": 0,
      "CONTENT_CREATED": 0,
      "VIDEO_CREATED": 0,
      "POSTED": 11,
      "FAILED": 1
    }
  },
  "health": { "sheet": "local", "storage": "local", "dryRun": true, "ai": "template" }
}
```

`products.processing` sums every in-flight intermediate status
(`PROCESSING` + `PRODUCT_IMPORTED` + `CONTENT_CREATED` + `VIDEO_CREATED`)
into one figure.

## Products

### `GET /api/products`

List product rows from the Sheet.

```
GET /api/products?status=NEW
```

| Query param | Default | Notes |
|---|---|---|
| `status` | (all) | One of `NEW`, `PROCESSING`, `PRODUCT_IMPORTED`, `CONTENT_CREATED`, `VIDEO_CREATED`, `POSTED`, `FAILED` |
| `limit` | `500` | |

```json
{ "products": [ { "id": "01J...", "status": "POSTED", "productSource": "manual", "brand": "Acme Audio", "platform": "instagram,facebook", "...": "..." } ] }
```

### `POST /api/products`

Add a new product row with `Status = NEW`. Works for any registered
source; for `manual` products, the payload is stored server-side (via the
settings repository) and referenced by a generated product id.

```
POST /api/products
content-type: application/json
```

| Field | Required | Notes |
|---|---|---|
| `source` | no (`manual` default) | one of the 8 registered source types |
| `platform` or `platforms` | no | comma-separated string, or an array of platform names |
| `productId` | no | for non-manual sources, the id/SKU the source adapter should import; for manual, slugified from `title` if omitted |
| `title` | **required for `source: "manual"`** | |
| `description`, `features`, `price`, `currency`, `compareAt`, `brand`, `category`, `imageUrls`, `language`, `rating` | no | manual product fields, stored as-is |
| `url` | no | product URL, written to the `Product URL` column |
| `scheduleDate`, `scheduleTime` | no | if set, the row is held until this date/time before publishing |

Example — manual product:

```json
{
  "source": "manual",
  "title": "Aurora Wireless Headphones",
  "description": "Studio-grade sound for everyday listening.",
  "features": ["Active Noise Cancelling", "40-Hour Battery Life"],
  "price": 149.99,
  "currency": "USD",
  "brand": "Acme Audio",
  "category": "Premium Audio",
  "platforms": ["instagram", "facebook", "pinterest"]
}
```

Example — importing from a connected source:

```json
{ "source": "shopify", "productId": "8675309", "platform": "instagram,x" }
```

Response:

```json
{ "row": { "id": "01J...", "status": "NEW", "productSource": "manual", "productId": "aurora-wireless-headphones", "...": "..." } }
```

### `GET /api/products/:id`

Full detail for one product: the row itself plus everything generated for
it so far.

```
GET /api/products/01J...
```

```json
{
  "product": { "id": "01J...", "status": "POSTED", "...": "..." },
  "content": { "productId": "01J...", "captions": [ { "platform": "instagram", "primary": "...", "variations": ["...", "..."] } ], "hooks": ["...", "... (10 total)"], "ctas": ["...", "... (5 total)"], "hashtags": ["...", "... (30 total)"], "...": "..." },
  "assets": [ { "type": "instagram_post", "url": "...", "width": 1080, "height": 1350 } ],
  "video": { "url": "...", "durationSec": 20, "width": 1080, "height": 1920 },
  "publications": [ { "platform": "instagram", "status": "dry_run", "permalink": null } ]
}
```

Throws a `400 ValidationError` if no row matches `:id`.

### `POST /api/products/:id/retry`

Resets a row's `Status` back to `NEW` and clears its `Error` cell, so the
next poll picks it up again. Used by the dashboard's "Re-queue" action and
the Apps Script "Mark Selected as NEW" menu item.

```
POST /api/products/01J.../retry
```

```json
{ "ok": true, "id": "01J..." }
```

## Generated content

### `GET /api/content`

```
GET /api/content?limit=100&offset=0
```

```json
{ "content": [ { "productId": "01J...", "captions": [...], "...": "..." } ], "total": 12 }
```

### `GET /api/content/:productId`

```
GET /api/content/01J...
```

```json
{ "content": [ { "productId": "01J...", "captions": [...], "...": "..." } ] }
```

## Assets & videos

### `GET /api/assets`

```
GET /api/assets?productId=01J...
```

If `productId` is omitted, returns the most recent assets across all
products (`limit`, default `200`).

```json
{ "assets": [ { "productId": "01J...", "type": "story", "url": "...", "width": 1080, "height": 1920 } ] }
```

### `GET /api/videos`

```
GET /api/videos?limit=100
```

```json
{ "videos": [ { "productId": "01J...", "url": "...", "durationSec": 20, "fps": 30, "width": 1080, "height": 1920 } ], "total": 12 }
```

## Queue

### `GET /api/queue`

The job queue's current state — every job's status plus a summary count
per status.

```
GET /api/queue
```

```json
{
  "counts": { "QUEUED": 0, "RUNNING": 0, "SUCCEEDED": 45, "FAILED": 2, "DEAD": 1 },
  "jobs": [ { "id": "job_...", "type": "process_product", "status": "SUCCEEDED", "attempts": 1, "productId": "01J...", "...": "..." } ]
}
```

## Publications

### `GET /api/publications`

```
GET /api/publications?status=published&limit=200
```

| Query param | Default |
|---|---|
| `status` | (all) — one of `scheduled`, `published`, `dry_run`, `failed`, `skipped` |
| `limit` | `200` |

```json
{
  "publications": [ { "productId": "01J...", "platform": "instagram", "status": "dry_run", "permalink": null, "scheduledAt": null } ],
  "counts": { "scheduled": 0, "published": 30, "dry_run": 12, "failed": 1, "skipped": 0 }
}
```

## Analytics

### `GET /api/analytics`

Same rollup object embedded as `stats` in `/api/dashboard`, returned
directly.

```
GET /api/analytics
```

```json
{
  "productsProcessed": 12,
  "postsPublished": 34,
  "videosCreated": 12,
  "queueSize": 0,
  "failedJobs": 1,
  "successRate": 0.92,
  "avgProcessingMs": 8400
}
```

## Logs

### `GET /api/logs`

```
GET /api/logs?level=error&productId=01J...&limit=200
```

| Query param | Default |
|---|---|
| `level` | (all) |
| `productId` | (all) |
| `limit` | `200` |

```json
{ "logs": [ { "time": "2026-07-19T12:00:00.000Z", "level": "info", "stage": "publish", "message": "posted to instagram", "productId": "01J...", "jobId": "job_...", "data": {} } ] }
```

## Settings

### `GET /api/settings`

Everything the dashboard's Settings page needs in one call: brand
defaults, posting-time slots, connected accounts (credentials never
included), masked secret names, dry-run state, the active AI provider, and
every registered source/publisher with its configured state.

```
GET /api/settings
```

```json
{
  "brand": { "name": "Acme", "primaryColor": "#0F2027", "accentColor": "#E63946", "textColor": "#FFFFFF", "font": "Poppins", "watermarkText": "@acme", "cta": "Shop now", "language": "en" },
  "postingTimes": ["09:00", "13:00", "18:00"],
  "timezone": "UTC",
  "accounts": [ { "id": "acct_...", "platform": "instagram", "label": "Main IG", "isDefault": true } ],
  "secretNames": ["INSTAGRAM_ACCESS_TOKEN"],
  "dryRun": true,
  "aiProvider": "template",
  "sources": [ { "type": "manual", "configured": true } ],
  "publishers": [ { "platform": "instagram", "configured": false } ]
}
```

If no `Brand Settings` row exists yet, `brand` falls back to the
`BRAND_*` environment defaults from `.env`.

### `PUT /api/settings/brand`

```
PUT /api/settings/brand
content-type: application/json
```

| Field | Required | Falls back to |
|---|---|---|
| `name` | **yes** | — |
| `primaryColor`, `accentColor`, `textColor`, `font`, `cta`, `language` | no | the corresponding `BRAND_*`/`DEFAULT_*` config value |
| `logoUrl`, `watermarkText` | no | unset |

```json
{ "name": "Acme Audio", "primaryColor": "#141E30", "accentColor": "#E63946", "watermarkText": "ACME AUDIO", "cta": "Shop Now" }
```

```json
{ "ok": true }
```

### `PUT /api/settings/posting-times`

```
PUT /api/settings/posting-times
content-type: application/json
```

```json
{ "times": ["09:00", "13:00", "18:00"] }
```

`times` must be an array (of `HH:mm` strings) or the request is rejected
with a `400 ValidationError`.

```json
{ "ok": true, "times": ["09:00", "13:00", "18:00"] }
```

### `POST /api/settings/accounts`

Save a social account's credentials. Credentials are encrypted
(AES-256-GCM) before being written to storage and are **never** included
in the response — the response only echoes non-sensitive fields.

```
POST /api/settings/accounts
content-type: application/json
```

| Field | Required |
|---|---|
| `platform` | **yes** — one of `instagram`, `facebook`, `linkedin`, `pinterest`, `threads`, `x` |
| `credentials` | **yes** — an object; shape depends on `platform` (e.g. `{accessToken, businessAccountId}` for Instagram) |
| `label` | no — defaults to the platform name |
| `isDefault` | no — if `true`, this account becomes the default for that platform (unsetting any prior default) |

```json
{
  "platform": "instagram",
  "label": "Main IG account",
  "credentials": { "accessToken": "...", "businessAccountId": "..." },
  "isDefault": true
}
```

```json
{ "id": "acct_...", "platform": "instagram", "label": "Main IG account", "isDefault": true }
```

### `DELETE /api/settings/accounts/:id`

```
DELETE /api/settings/accounts/acct_...
```

```json
{ "ok": true }
```

## Actions

### `POST /api/actions/run`

Triggers an immediate poll of the Sheet for `NEW` rows and starts draining
the job queue. This is what the dashboard's "Run now" button calls, and
what `apps-script/`'s "Trigger Processing Now" menu item calls remotely.

```
POST /api/actions/run
```

The Sheet poll (claiming `NEW` rows and enqueueing jobs for them) happens
synchronously before the response is returned; the actual job **draining**
then continues in the background after the response is sent — the request
does not block until every enqueued product finishes processing.

```json
{ "enqueued": 2, "message": "Enqueued 2 product(s); processing in the background." }
```

or, if nothing was waiting:

```json
{ "enqueued": 0, "message": "No NEW products to process." }
```

## Admin & operations

Everything in this section is registered by
`src/interface/controllers/admin-routes.ts` and powers the `/#admin`
dashboard page and the first-run setup wizard. See
[`docs/OPERATIONS.md`](OPERATIONS.md) for the full operator-facing
walkthrough of each feature; this section is the endpoint-level reference.

### `GET /api/health/live`

Bare liveness probe — no dependency checks, 200 as long as the process can
answer HTTP requests at all.

```json
{ "status": "alive", "version": "1.0.0" }
```

### `GET /api/health/ready`

Readiness probe with the same pass/fail logic as `GET /api/health`
(described above), trimmed to just the fields an orchestrator needs to
gate traffic — 200 when `ready` is `true`, 503 otherwise.

```json
{
  "ready": true,
  "checks": [
    { "name": "database", "ok": true, "critical": true },
    { "name": "storage", "ok": true, "critical": true, "detail": "local" },
    { "name": "ffmpeg", "ok": true, "critical": true, "detail": "available" },
    { "name": "sheet", "ok": true, "critical": false, "detail": "local store" }
  ]
}
```

### `GET /api/system`

Point-in-time process/host info: version, Node version, platform/arch,
pid, uptime, memory (RSS/heap), free/total disk on the data volume, and
the active config summary. Used by the admin panel's "System info" card.

```json
{
  "version": "1.0.0",
  "node": "22.9.0",
  "platform": "linux",
  "arch": "x64",
  "pid": 1,
  "uptimeSec": 41285,
  "memory": { "rssMb": 118, "heapUsedMb": 54, "heapTotalMb": 82 },
  "data": { "dir": "/app/data/output", "freeMb": 20480, "totalMb": 30720 },
  "config": {
    "sheet": "local",
    "storage": "local",
    "aiProvider": "template",
    "dryRun": true,
    "pollIntervalMinutes": 5,
    "concurrency": 2
  }
}
```

### `GET /api/metrics`

Prometheus text exposition (`content-type: text/plain; version=0.0.4`).
Exports `ascagent_uptime_seconds`, `ascagent_products_processed_total`,
`ascagent_posts_published_total`, `ascagent_videos_created_total`,
`ascagent_failed_total`, `ascagent_success_rate`,
`ascagent_avg_processing_ms`, `ascagent_queue_size`, one
`ascagent_jobs{status="..."}` series per queue status, and
`ascagent_memory_rss_bytes`. See
[`docs/OPERATIONS.md`](OPERATIONS.md#monitoring--metrics) for a sample
`prometheus.yml` scrape config and the full metric table.

```
# HELP ascagent_uptime_seconds Process uptime in seconds
# TYPE ascagent_uptime_seconds gauge
ascagent_uptime_seconds 41285
# HELP ascagent_success_rate Pipeline success rate (0..1)
# TYPE ascagent_success_rate gauge
ascagent_success_rate 0.92
ascagent_jobs{status="QUEUED"} 0
ascagent_jobs{status="SUCCEEDED"} 45
```

### `GET /api/setup/status`

Reports the first-run setup wizard's checklist: encryption key strength,
brand configuration, AI provider readiness, sheet backend, connected
store integrations, and connected social publishers — plus whether the
wizard has already been completed or dismissed.

```json
{
  "complete": false,
  "dismissed": false,
  "steps": [
    { "id": "encryption", "label": "Encryption key set", "done": true },
    { "id": "brand", "label": "Brand configured", "done": false, "detail": "Add your brand name, colors, and logo" },
    { "id": "ai", "label": "AI copy provider", "done": true, "detail": "template" },
    { "id": "sheet", "label": "Product source (sheet)", "done": true, "detail": "local store" },
    { "id": "sources", "label": "Store integrations", "done": false, "detail": "Manual + CSV ready; connect stores optionally" },
    { "id": "publishers", "label": "Social publishers", "done": false, "detail": "Dry-run until you add tokens" }
  ]
}
```

### `POST /api/setup/complete`

Marks the wizard permanently complete (persisted in the `settings` table
as `setup_complete=true`) — after this, the wizard no longer auto-opens on
page load, though it can still be reopened manually from the admin panel.

```
POST /api/setup/complete
```

```json
{ "ok": true }
```

### `POST /api/setup/dismiss`

Marks the wizard dismissed (`setup_dismissed=true`) without requiring
every step to be `done` — same auto-open suppression as `complete`, for an
operator who wants to skip the checklist entirely.

```
POST /api/setup/dismiss
```

```json
{ "ok": true }
```

### `POST /api/setup/test`

Runs a live connection test against one of three targets, returning
`{ ok, detail }` and never throwing — a failed test is reported in the
body, not as an HTTP error.

```
POST /api/setup/test
content-type: application/json
```

| Field | Required | Notes |
|---|---|---|
| `target` | **yes** | one of `sheet`, `ai`, `publisher` |
| `platform` | only when `target: "publisher"` | one of the six registered platforms |

```json
{ "target": "publisher", "platform": "instagram" }
```

```json
{ "ok": false, "detail": "credentials not set (runs in dry-run)" }
```

Omitting `platform` when `target: "publisher"` returns a
`400 ValidationError` ("platform is required for publisher test"); an
unrecognized `target` returns a `400 ValidationError` ("target must be one
of sheet | ai | publisher").

### `GET /api/admin/backups`

Lists existing backups under `data/backups/`, newest first.

```json
{
  "backups": [
    { "name": "backup-2026-07-19T02-00-00-000Z.tgz", "bytes": 4213556, "createdAt": "2026-07-19T02:00:03.112Z" }
  ]
}
```

### `POST /api/admin/backups`

Creates a new backup: a `VACUUM INTO` snapshot of the SQLite database plus
the generated-assets directory, packaged as one `.tgz`. Safe to call
against a live instance — no need to stop the app first.

```
POST /api/admin/backups
```

```json
{
  "name": "backup-2026-07-19T02-00-00-000Z.tgz",
  "bytes": 4213556,
  "createdAt": "2026-07-19T02:00:03.112Z",
  "downloadUrl": "/api/admin/backups/backup-2026-07-19T02-00-00-000Z.tgz/download"
}
```

### `GET /api/admin/backups/:name/download`

Streams the raw `.tgz` bytes for one backup
(`content-type: application/gzip`, with a `content-disposition:
attachment` header). `:name` is validated against the exact filename
pattern the backup service generates; any other value is rejected before
touching the filesystem (protects against path traversal). Returns a
`404 NotFoundError` if the named backup doesn't exist.

```
GET /api/admin/backups/backup-2026-07-19T02-00-00-000Z.tgz/download
```

### `POST /api/admin/backups/prune`

Deletes every backup beyond the `keep` most recent (sorted by creation
time). `keep` defaults to `10` when omitted.

```
POST /api/admin/backups/prune
content-type: application/json
```

```json
{ "keep": 14 }
```

```json
{ "removed": 3 }
```

### `GET /api/admin/update/check`

Reports whether a newer version is available. With no configuration
(`UPDATE_MANIFEST_URL` unset), returns `mode: "managed"` and points at the
non-HTTP update mechanisms (`update.sh`, Docker rebuild, Watchtower):

```json
{
  "current": "1.0.0",
  "updateAvailable": false,
  "mode": "managed",
  "message": "Updates are applied via Docker (compose pull/build or Watchtower) or scripts/update.sh. Set UPDATE_MANIFEST_URL to enable in-app version checks."
}
```

With `UPDATE_MANIFEST_URL` set to a JSON manifest endpoint you control
(`{ "version", "url"?, "notes"? }`), returns `mode: "manifest"` with the
comparison result:

```json
{
  "current": "1.0.0",
  "latest": "1.1.0",
  "updateAvailable": true,
  "url": "https://example.com/releases/1.1.0",
  "notes": "Adds admin/ops layer",
  "mode": "manifest"
}
```

A failed manifest fetch (network error, timeout, bad JSON) degrades to
`{ current, updateAvailable: false, mode: "manifest", error: "<message>" }`
rather than a 5xx response.

### `POST /api/admin/requeue-stale`

Reclaims jobs whose lock has expired (older than
`JOB_LOCK_TTL_MS`, default 10 minutes) without the worker reporting a
result — typically after a container was killed or crashed mid-job. Resets
them back to `QUEUED` so the next poll picks them up again.

```
POST /api/admin/requeue-stale
```

```json
{ "requeued": 2 }
```

## Errors

Every route throws a typed `AppError` subclass on failure, which the
server maps to an HTTP status code and a JSON error body:

```json
{ "error": "product not found", "details": { "id": "01J..." } }
```

| Error type | Status |
|---|---|
| `ValidationError` | 400 |
| `AuthError` | 401 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `NotConfiguredError` | 412 |
| `RateLimitError` | 429 |
| `ExternalApiError` | 502 |
| `TimeoutError` | 504 |
| `ConfigError` (and any unhandled error) | 500 |

## Security note

This API has **no built-in authentication** — any client that can reach
`HTTP_HOST:HTTP_PORT` can read every product/log/setting and can save or
delete social account credentials (though never read them back, since
saved credentials are encrypted and never echoed). The same applies to the
admin surface: `GET /api/admin/backups/:name/download` returns a full
database snapshot (including encrypted credential ciphertext) to any
caller who can reach the port, and `POST /api/admin/requeue-stale`/backup
creation are likewise ungated. If you expose this service beyond
`localhost`/a private network, put it behind your own authenticating
reverse proxy, VPN, or firewall rule — the app itself does not gate any
route behind a token or session. `deploy/docker-compose.prod.yml` +
`deploy/Caddyfile` (see [`deploy/README.md`](../deploy/README.md)) is the
supported way to add HTTPS + HTTP basic auth in front of the whole app,
including the admin endpoints, without changing application code. See
[the README's Security section](../README.md#security) for what *is*
handled internally (credential encryption at rest, redacted logs, RS256
JWT for Google auth).

## Authentication

When `API_TOKENS` (or `API_TOKEN`) is set, all `/api/*` routes require a token via `Authorization: Bearer <token>` or `X-API-Key: <token>`, except the public routes below. Missing/invalid tokens return `401 { "error": "Unauthorized", "code": "UNAUTHORIZED" }`. `/files/*` (generated media) stays public.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/auth/status` | public | `{ "authEnabled": true|false }` — dashboard uses it to decide whether to show sign-in |
| POST | `/api/auth/login` | public | Body `{ "token": "..." }` → `200 { "ok": true }` when valid, else `401`. Validation helper for the dashboard sign-in |

Example:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8080/api/dashboard
```
