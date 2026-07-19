# Operations Guide

The v1.1 "admin & ops" layer turns the AI Social Commerce Agent from a
pipeline you run and watch into a service you can actually operate: a
first-run setup wizard, a full admin panel, layered health/readiness
probes, Prometheus-compatible metrics, structured logging, backup/restore
tooling, and one-command install/update scripts. This guide covers all of
it. Everything here is additive — the core pipeline, the dashboard's
product/content/queue pages, and the REST API described in
[`docs/API.md`](API.md) are unchanged.

## Contents

- [Admin panel](#admin-panel)
- [Setup wizard](#setup-wizard)
- [Health & readiness](#health--readiness)
- [Monitoring & metrics](#monitoring--metrics)
- [Logging](#logging)
- [Backup & restore](#backup--restore)
- [One-click install](#one-click-install)
- [Auto-updates](#auto-updates)
- [Cron examples](#cron-examples)

## Admin panel

Open **`/#admin`** in the dashboard (the "Admin" entry in the left nav) for
a single operator-facing view of the running service, backed entirely by
the endpoints below. It has four sections:

- **System health** — a status badge (`ok`/`degraded`) plus one pill per
  dependency check (`database`, `storage`, `ffmpeg`, `sheet`), sourced from
  `GET /api/health`.
- **System info** — version, uptime, memory (RSS), and free disk space on
  the data volume, sourced from `GET /api/system`. A link to
  `/api/metrics` is provided for scraping.
- **Backups** — a table of existing backups (name, size, created-at) with
  per-row **Download** links, plus **Create backup** and **Prune old**
  buttons. Backed by `services.backup` (`src/application/backup-service.ts`)
  via the `/api/admin/backups*` endpoints.
- **Worker controls** — a **Run now** button (`POST /api/actions/run`,
  the same action available elsewhere in the dashboard) and a **Requeue
  stale jobs** button (`POST /api/admin/requeue-stale`) that reclaims jobs
  whose lock has expired without the worker reporting back — useful after
  a container was killed mid-job.
- **Setup wizard** — a **Run setup wizard** button that reopens the
  first-run wizard on demand (see below), for revisiting configuration or
  re-testing a connection after rotating a credential.

The admin panel calls the same JSON API documented in
[`docs/API.md`](API.md#admin--operations) — there is nothing in it that
isn't also scriptable from the command line with `curl`.

## Setup wizard

The setup wizard is a modal that walks a new install through the six
things worth checking before the pipeline is trusted with real traffic. It
is implemented by `src/application/setup-service.ts`
(`SetupService.status()`) and rendered client-side in `web/app.js`.

**Checklist** (`GET /api/setup/status`), each with a `done` flag and a
human-readable `detail`:

| Step | `done` when |
|---|---|
| Encryption key set | `ENCRYPTION_KEY` is 64 hex characters and not the all-zero placeholder |
| Brand configured | a `Brand Settings` row (or sheet equivalent) has a `name` |
| AI copy provider | `AI_PROVIDER=template` (always ready), or the selected provider's API key is present |
| Product source (sheet) | always `true` — reports which sheet backend (`local`/`google`) is active |
| Store integrations | at least one non-`manual`/`csv` source (Amazon, Shopify, WooCommerce, Etsy, Flipkart, Meesho) is configured |
| Social publishers | at least one publisher has credentials configured (otherwise everything runs in dry-run) |

**Test connections.** Three live checks are exposed through a single
endpoint, `POST /api/setup/test` with `{ "target": "sheet" | "ai" | "publisher", "platform"?: string }`:

- `sheet` — calls `listProducts({ limit: 1 })` against the active sheet
  store with a 15-second timeout; confirms the Sheet (or local mirror) is
  actually reachable, not just configured.
- `ai` — for `AI_PROVIDER=template`, always succeeds (no key needed); for
  `openai`/`gemini`/`anthropic`, checks that the provider's API key is
  present (it does not spend a token making a live call).
- `publisher` — requires `platform`; if the publisher has credentials, it
  calls `connect()` against the live platform API with a 15-second
  timeout; if not, it reports back that the platform will run in dry-run.

Each test returns `{ ok: boolean, detail: string }` and never throws — a
failed connection is reported in `detail`, not as an HTTP error.

**Completion state.** `POST /api/setup/complete` and `POST /api/setup/dismiss`
each set a boolean flag (`setup_complete` / `setup_dismissed`) in the
`settings` table; both are permanent until manually cleared. On every page
load, the dashboard calls `openSetupWizard()` without forcing it open —
if `status.complete` or `status.dismissed` is already `true`, it skips
silently. This is what makes it a **first-run** wizard: it appears
automatically until you finish or dismiss it, then never again on its own.

**Re-opening it.** The Admin panel's **Run setup wizard** button calls the
same modal with `force=true`, bypassing the completed/dismissed check —
this is the supported way to revisit configuration or re-run a connection
test after rotating a credential, any time after first run.

## Health & readiness

Three endpoints, all implemented in `src/application/system-service.ts`
(`SystemService`) and registered in `src/interface/controllers/admin-routes.ts`:

### `GET /api/health`

The rich health report. Runs four dependency checks and returns **200**
when every *critical* check passes, or **503** when at least one does not
(the HTTP status itself is the fast machine-readable signal; the body
gives you the detail).

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

The four checks:

| Check | Critical | What it verifies |
|---|---|---|
| `database` | yes | `SELECT 1` succeeds and a write (`UPSERT` into `settings`) round-trips against the live SQLite connection |
| `storage` | yes | a small probe file can be written to the active storage backend (local filesystem or Google Drive) |
| `ffmpeg` | yes | the configured `ffmpeg` binary is resolvable and runnable (checked once, then cached for the process lifetime) |
| `sheet` | no | reports the configured sheet backend (`local`/`google`); this is a shallow check by design — a deep round-trip is skipped to keep `/api/health` fast |

`status` is `"degraded"` if *any* check fails (including the non-critical
`sheet` check) even when `ready` is still `true` — use `ready`/HTTP status
for automated failover decisions, and `status`/`checks` for human
diagnosis.

This is the exact endpoint the Docker `HEALTHCHECK` and the `docker-compose.yml` /
`deploy/docker-compose.prod.yml` `healthcheck:` blocks poll, and what
`fly.toml`'s `[[http_service.checks]]` targets — see
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md#health-checks) for those specifics.
Point any external load balancer or orchestrator probe at this same path.

### `GET /api/health/live`

A liveness probe with no dependency checks at all — it returns 200 as
long as the Node process is up and able to answer HTTP requests:

```json
{ "status": "alive", "version": "1.0.0" }
```

Use this where a probe should only restart the container if the process
itself is wedged, not because a downstream dependency (e.g. the sheet API)
is temporarily unreachable.

### `GET /api/health/ready`

A slimmer version of `/api/health` for orchestrators that want a readiness
gate without the full check detail — same underlying logic (200 when no
*critical* check has failed, 503 otherwise), trimmed to just:

```json
{
  "ready": true,
  "checks": [ { "name": "database", "ok": true, "critical": true }, "..." ]
}
```

Use `/live` for liveness probes and `/ready` (or the full `/api/health`)
for readiness probes if your orchestrator distinguishes the two (e.g.
Kubernetes `livenessProbe` vs. `readinessProbe`); for Docker Compose /
plain `HEALTHCHECK` setups that only have one probe slot, `/api/health` is
the right single endpoint since it doubles as both.

## Monitoring & metrics

### `GET /api/system`

Point-in-time process and host info for dashboards or a quick `curl`
during an incident — not a time series, just the current values:

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

`data.freeMb`/`data.totalMb` come from `statfs` on the storage directory
and are `null` on platforms where `statfs` isn't available — don't alert
on a `null` here, treat it as "unknown," not "zero."

### `GET /api/metrics`

Prometheus text exposition format (`content-type: text/plain; version=0.0.4`),
generated by `SystemService.metrics()` from the same analytics rollup that
powers `GET /api/analytics` and the dashboard's stat cards. Every counter
is cumulative since process start (there is no persisted metrics history —
restart the process and counters reset, which is standard Prometheus
counter semantics: rate()/increase() across a restart is handled by
Prometheus itself, not by this endpoint).

Exported metrics:

| Metric | Type | Meaning |
|---|---|---|
| `ascagent_uptime_seconds` | gauge | seconds since this process started |
| `ascagent_products_processed_total` | counter | products successfully processed end to end |
| `ascagent_posts_published_total` | counter | posts published live (excludes dry-run) |
| `ascagent_videos_created_total` | counter | promo videos rendered |
| `ascagent_failed_total` | counter | pipeline runs that failed |
| `ascagent_success_rate` | gauge | 0–1 success rate |
| `ascagent_avg_processing_ms` | gauge | average end-to-end pipeline duration, milliseconds |
| `ascagent_queue_size` | gauge | queued + running jobs right now |
| `ascagent_jobs{status="..."}` | gauge | one series per job-queue status (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `DEAD`) |
| `ascagent_memory_rss_bytes` | gauge | process resident set size, bytes |

Sample output:

```
# HELP ascagent_uptime_seconds Process uptime in seconds
# TYPE ascagent_uptime_seconds gauge
ascagent_uptime_seconds 41285
# HELP ascagent_products_processed_total Products successfully processed
# TYPE ascagent_products_processed_total counter
ascagent_products_processed_total 12
# HELP ascagent_posts_published_total Posts published (live)
# TYPE ascagent_posts_published_total counter
ascagent_posts_published_total 34
# HELP ascagent_success_rate Pipeline success rate (0..1)
# TYPE ascagent_success_rate gauge
ascagent_success_rate 0.92
ascagent_jobs{status="QUEUED"} 0
ascagent_jobs{status="RUNNING"} 0
ascagent_jobs{status="SUCCEEDED"} 45
ascagent_jobs{status="FAILED"} 2
ascagent_jobs{status="DEAD"} 1
# HELP ascagent_memory_rss_bytes Resident set size
# TYPE ascagent_memory_rss_bytes gauge
ascagent_memory_rss_bytes 123731968
```

**Scraping with Prometheus.** Add a job pointed at the app's port and
`/api/metrics` path:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'ai-social-commerce-agent'
    scrape_interval: 30s
    metrics_path: /api/metrics
    static_configs:
      - targets: ['agent.yourdomain.com:8080']
        # or, scraping the container directly on its Docker network:
        # targets: ['ai-social-commerce-agent:8080']
```

If the app sits behind the Caddy overlay from
[`deploy/docker-compose.prod.yml`](../deploy/README.md) with basic auth
enabled, either scrape it from inside the Docker network (bypassing
Caddy and its auth entirely, which is the simplest option since `/api/metrics`
carries no secrets) or configure Prometheus's `basic_auth:` scrape option
with the same credentials.

## Logging

The logger (`src/shared/logger.ts`) is zero-dependency and writes either
pretty console lines or JSON lines, controlled by two env vars:

- **`LOG_LEVEL`** — `debug` | `info` | `warn` | `error` (default `info`).
  Anything below the configured level is dropped before formatting, so
  raising it to `error` in a noisy environment costs nothing extra.
- **`LOG_PRETTY`** — `true` (default) for human-readable colored console
  lines, or `false` for newline-delimited JSON — set this to `false`
  whenever a log aggregator (Loki, CloudWatch, Datadog, etc.) is parsing
  stdout, since structured JSON is far easier for those tools to index
  than ANSI-colored text.

**Secret redaction is automatic and unconditional** — it runs in both
formats, on every log call. Before a log line is written, every object key
matching a token/secret/password/authorization/cookie/API-key-shaped
pattern (see the `SECRET_KEY_RE` regex in `src/shared/logger.ts`) has its
value replaced with `***` (or `***xxxx`, keeping only the last four
characters, for strings longer than 8 characters) — recursively, through
nested objects and arrays, with a depth limit and circular-reference
guard. This means it is safe to pass raw request bodies or credential
objects into a log call's `extra` field; you do not need to manually strip
secrets before logging.

**Where logs go, beyond stdout/stderr:**

- Every pipeline stage also writes a row to the SQLite **`logs`** table
  (`ts`, `level`, `stage`, `message`, `product_id`, `job_id`, `data`),
  queryable via `GET /api/logs` and shown on the dashboard's **Logs**
  page — this is a structured, filterable history independent of whatever
  the process's stdout retention policy is.
- When `SHEET_STORE=google`, the same events are also mirrored to the
  **Logs** tab of the Google Sheet, so a non-technical operator can see
  pipeline activity without leaving the spreadsheet they already use for
  products.

**Viewing container logs:**

```bash
docker compose logs -f app
# split topology:
docker compose --profile split logs -f api worker
```

**Rotation.** `docker-compose.yml`, `deploy/docker-compose.prod.yml`
(the `caddy` service), and the root `Dockerfile`'s implicit expectations
all use the `json-file` log driver capped at `max-size: 10m` and
`max-file: 3` — a 30 MB rolling cap per container, so logs never grow
unbounded on disk. If you run a log shipper with its own retention, either
raise these caps (there is more headroom to keep locally) or leave them as
a sane last-resort ceiling on top of the shipper's own copy.

## Backup & restore

### How backups work

`src/application/backup-service.ts` (`BackupService.createBackup()`)
produces a single self-contained `.tgz` per backup:

1. It runs `VACUUM INTO '<path>/app.db'` against the live SQLite
   connection — a **safe, consistent snapshot even while the app is
   running** (including under WAL / concurrent writes), because
   `VACUUM INTO` reads a transactionally consistent view without holding a
   long-lived lock against ongoing traffic.
2. It stages that snapshot alongside the entire generated-assets directory
   (`STORAGE_LOCAL_DIR`, `data/output/` by default — images and videos)
   and packages both into one archive: `data/backups/backup-<timestamp>.tgz`.
3. It cleans up its staging directory and returns
   `{ name, bytes, createdAt }`.

Because step 1 doesn't require stopping the app, **backups are safe to
take at any time**, including on a schedule against a live production
instance — no maintenance window needed.

### Creating a backup

Three equivalent ways:

- **Admin panel** — click **Create backup** on `/#admin`. This calls
  `POST /api/admin/backups`, which returns the new backup's name, size,
  and a ready-to-use `downloadUrl`.
- **Script, inside the container or on the host** —
  ```bash
  docker compose exec -T app node scripts/backup.ts
  # or, running directly on a host without Docker:
  node scripts/backup.ts
  ```
  Prints the backup's path and size to stdout and exits 0/1 on
  success/failure — this is the form used by `update.sh`'s pre-update
  backup step and is the right one to put in a cron job (see
  [Cron examples](#cron-examples)).
- **`POST /api/admin/backups`** directly, if you're scripting against the
  API instead of the CLI or the panel.

### Listing and downloading

- `GET /api/admin/backups` lists every backup under `data/backups/`
  (name, size in bytes, created-at), newest first — this is what
  populates the admin panel's Backups table.
- `GET /api/admin/backups/:name/download` streams the raw `.tgz` bytes
  (`content-type: application/gzip`, with a `content-disposition` header
  so it downloads with the correct filename). The admin panel's per-row
  **Download** link points straight at this URL. `:name` is validated
  against the strict pattern the backup service itself generates
  (`backup-<timestamp>.tgz`) — arbitrary filenames are rejected before any
  filesystem access happens, so this endpoint can't be used for path
  traversal outside `data/backups/`.

### Pruning old backups

`POST /api/admin/backups/prune` with an optional `{ "keep": <n> }` body
(default `10`) deletes every backup beyond the `n` most recent, sorted by
creation time. The admin panel's **Prune old** button calls this with the
default of 10. Run this on the same cadence as your backup job (or right
after it) so `data/backups/` doesn't grow without bound on a host with
frequent scheduled backups.

### Restoring

Restore is **deliberately not exposed over HTTP** — it's destructive, so
it's a script you run intentionally with the app stopped, not a button an
operator can click by accident from a browser tab.

```bash
# 1. Stop the app so nothing is writing to the database mid-restore
docker compose stop app          # or: docker compose down

# 2. Restore (DESTRUCTIVE — overwrites data/app.db and data/output)
node scripts/restore.ts data/backups/backup-2026-07-18T02-00-00-000Z.tgz --yes

# 3. Start the app again
docker compose up -d
```

`scripts/restore.ts` extracts the archive directly on top of the data
directory derived from `SQLITE_PATH`, replacing `app.db` and `output/`
in place. Without `--yes` it prompts interactively (`Proceed with
restore? [y/N]`) and refuses to proceed at all in a non-interactive shell
(no TTY) unless `--yes` is passed — this is intentional friction against
running it by accident inside a script or CI job. There is no dry-run
mode and no automatic pre-restore snapshot of the *current* state, so if
you want to be able to undo a restore, take a fresh backup first, before
restoring an older one.

### Recommended cadence

Run `scripts/backup.ts` on a schedule (see [Cron examples](#cron-examples))
and keep it paired with a `prune` call so the backups directory has a
bounded size. A nightly backup with `keep: 14` gives you two weeks of
daily recovery points at a predictable disk cost (`.tgz` size scales with
your SQLite file + generated-assets directory, both of which are visible
in the admin panel's System info card).

## One-click install

`./install.sh` is a single idempotent script for a fresh Debian/Ubuntu
host (VPS, EC2, etc.). It is safe to re-run — every step checks for the
existing state first.

**Local / dev** (API on `http://<host>:8080`, no TLS):

```bash
./install.sh
```

**Production** (HTTPS + HTTP basic auth in front, via Caddy):

```bash
PROD=1 SITE_ADDRESS=agent.example.com [email protected] ./install.sh
```

(`ADMIN_PASSWORD` is optional — if you don't set it, a random 20-character
password is generated and printed at the end, alongside the URL.)

### What it does, step by step

1. **Docker.** If `docker` isn't already on `PATH`, installs Docker Engine
   via `get.docker.com` and enables the `docker` systemd service. Verifies
   the Compose plugin (`docker compose version`) is present, failing with a
   clear message if it isn't (rather than silently trying to proceed).
2. **`.env`.** If `.env` doesn't already exist, copies it from
   `.env.example` and generates a fresh, cryptographically random 32-byte
   `ENCRYPTION_KEY` (via `openssl rand -hex 32`, or `/dev/urandom` if
   `openssl` isn't available) directly into it. If `.env` already exists,
   it's left completely untouched — safe to re-run without clobbering
   configuration you've already made.
3. **Data directories.** Creates `data/` and `credentials/` and
   `chown`s `data/` to uid/gid `1001:1001` — the non-root user the
   container runs as (per the `Dockerfile`) — so the container can write
   to it without a permissions error on first boot.
4. **Production mode (`PROD=1` only).** Requires `SITE_ADDRESS` (fails
   fast with a clear error if unset). Generates a Caddy `bcrypt` hash for
   HTTP basic auth (via `docker run --rm caddy caddy hash-password`),
   generates `ADMIN_PASSWORD` if you didn't supply one, and writes/updates
   four vars into `.env`: `SITE_ADDRESS`, `BASIC_AUTH_USER`,
   `BASIC_AUTH_HASH`, `PUBLIC_BASE_URL`, and `STORAGE_PUBLIC_BASE_URL` (the
   last two set to `https://$SITE_ADDRESS` and `https://$SITE_ADDRESS/files`
   respectively). Adds `-f deploy/docker-compose.prod.yml` to the compose
   invocation, which is what actually brings up the Caddy reverse proxy —
   see [`deploy/README.md`](../deploy/README.md) for what that overlay
   changes.
5. **Build + start.** Runs `docker compose <args> up -d --build`.
6. **Wait for health.** Polls `/api/health` from inside the container
   (via `docker compose exec`) every 2 seconds for up to 60 seconds,
   moving on once it responds with a non-error status.
7. **Prints next steps** — the URL (and generated login, in `PROD=1`
   mode), a demo-seed command, and a curl to trigger an immediate pipeline
   run.

`PROD=1` requires ports `80` and `443` to be reachable from the internet
(Caddy needs both to obtain and renew a Let's Encrypt certificate) and a
DNS `A`/`AAAA` record for `SITE_ADDRESS` already pointed at the host — see
[`deploy/README.md`](../deploy/README.md) for the full Caddy/DNS
prerequisites.

## Auto-updates

Two supported paths, plus an in-app check. This project **builds the
Docker image locally from source** (there's no published registry image
by default — see the [`README`](../README.md#why-zero-dependencies) on
the zero-dependency, no-build-step design), so the default and
recommended update path is the bundled script, not an image-pulling tool
like Watchtower.

### `./update.sh` — the default path

```bash
./update.sh                 # base stack
PROD=1 ./update.sh          # include the Caddy/HTTPS overlay
./update.sh --no-backup     # skip the pre-update backup
```

Step by step:

1. **Pre-update backup (best effort).** Runs
   `docker compose exec -T app node scripts/backup.ts` inside the running
   container. If the container isn't running yet (first-ever update, or
   after a crash), this step fails gracefully with a log line instead of
   aborting the whole script. Skip it entirely with `--no-backup` if
   you're confident and want a faster update loop.
2. **Pull latest code.** If `.git` is present (this is a git checkout),
   runs `git pull --ff-only` — a fast-forward-only pull, so it will not
   silently create a merge commit or clobber local changes; it fails
   loudly instead. If there's no `.git` directory, it skips this step and
   rebuilds whatever source is currently on disk (useful if you deploy by
   copying files rather than `git clone`).
3. **Rebuild + restart.** Runs `docker compose <args> up -d --build`
   again — Docker's layer cache keeps this fast when only application
   code changed (the `vendor/`/OS-package layers are unaffected).
4. **Cleanup.** Runs `docker image prune -f` to remove the now-dangling
   previous image layers, keeping disk usage from creeping up update over
   update.

Run this by hand whenever you want to update, or put it on a schedule —
see [Cron examples](#cron-examples) for a weekly cadence.

### Watchtower — only if you publish the image to a registry

Watchtower auto-updates containers by polling a **registry** for a newer
image tag and swapping the running container — it has nothing to update
against as long as the image is only ever built locally (which is this
project's default). If you push your build to a registry (Docker Hub,
GHCR, ECR, etc.) as part of your own CI, Watchtower becomes a viable
alternative to a cron'd `update.sh`. Add it as an extra service in your
compose file:

```yaml
services:
  watchtower:
    image: containrrr/watchtower
    container_name: ai-social-commerce-agent-watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 3600 --cleanup ai-social-commerce-agent
    restart: unless-stopped
```

This polls hourly (`--interval 3600`) for a new image with the same tag as
the running `ai-social-commerce-agent` container, pulls it, recreates the
container, and removes the old image (`--cleanup`). Watchtower has no
concept of "take a backup first," so if you go this route, pair it with a
separate cron'd `node scripts/backup.ts` (see below) rather than relying
on `update.sh`'s built-in backup step, since Watchtower bypasses that
script entirely.

### In-app update checks

`GET /api/admin/update/check` (surfaced nowhere in the UI yet beyond the
raw endpoint) reports whether a newer version is available, in one of two
modes:

- **`managed`** (default, no configuration) — `UPDATE_MANIFEST_URL` isn't
  set, so the endpoint just returns the current version and a message
  pointing at `update.sh`/Docker/Watchtower as the actual update
  mechanisms:
  ```json
  {
    "current": "1.0.0",
    "updateAvailable": false,
    "mode": "managed",
    "message": "Updates are applied via Docker (compose pull/build or Watchtower) or scripts/update.sh. Set UPDATE_MANIFEST_URL to enable in-app version checks."
  }
  ```
- **`manifest`** — set `UPDATE_MANIFEST_URL` to a URL that serves a small
  JSON document `{ "version": "1.1.0", "url"?: "...", "notes"?: "..." }`
  (e.g. a raw file in your own repo, or a release-manifest endpoint you
  control) and the endpoint fetches it (10-second timeout) and compares
  versions:
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
  If the fetch fails (network error, bad JSON, timeout), it degrades to
  `{ current, updateAvailable: false, mode: "manifest", error: "<message>" }`
  rather than throwing — safe to poll from a script or a future dashboard
  widget without special-casing failures.

`UPDATE_MANIFEST_URL` is read directly from the process environment (it is
not part of the typed `.env.example` config block), so set it as a plain
environment variable or add it to `.env` yourself if you want this check
active.

## Cron examples

Add these to the host's crontab (`crontab -e`) running as the user that
owns the checked-out repo (so relative paths resolve correctly), or adapt
them into systemd timers if you prefer those.

**Nightly backup at 02:00, keeping the last 14:**

```cron
0 2 * * * cd /opt/ai-social-commerce-agent && docker compose exec -T app node scripts/backup.ts >> /var/log/asca-backup.log 2>&1
15 2 * * * cd /opt/ai-social-commerce-agent && curl -s -X POST -H 'content-type: application/json' -d '{"keep":14}' http://localhost:8080/api/admin/backups/prune >> /var/log/asca-backup.log 2>&1
```

(Running directly on a host without Docker: replace the first line's
`docker compose exec -T app node scripts/backup.ts` with plain
`node scripts/backup.ts`.)

**Weekly update, Sunday at 03:00:**

```cron
0 3 * * 0 cd /opt/ai-social-commerce-agent && ./update.sh >> /var/log/asca-update.log 2>&1
```

Add `PROD=1` in front of `./update.sh` in that line if you're running the
production Caddy overlay. Since `update.sh` already takes a backup as its
first step, the nightly backup job above and the weekly update job are
complementary, not redundant — the update's backup is a same-moment safety
net immediately before a code change, while the nightly job is your
general-purpose recovery point.

## Authentication (bearer token / API key)

The REST API, dashboard, and admin panel can be protected with one or more bearer tokens so the instance is safe to expose publicly.

- **Enable** by setting `API_TOKENS` (comma-separated) — or `API_TOKEN` — in `.env`. When empty, the API is **open** (fine for localhost only); the server logs a warning at startup.
- **Send credentials** as `Authorization: Bearer <token>` or `X-API-Key: <token>`.
- **Always public** (no token): `/api/health`, `/api/health/live`, `/api/health/ready`, `/api/auth/status`, `/api/auth/login`, generated media under `/files/*` (publishers must fetch media by URL), and the static dashboard shell. Everything else under `/api/*` returns `401 Unauthorized` without a valid token.

Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

**Dashboard:** when auth is enabled, a sign-in screen prompts for the token; it is stored in the browser and sent on every request. Use **Sign out** in the sidebar to clear it.

**Apps Script trigger:** set the `BACKEND_TOKEN` script property (AI Agent → *Set Backend URL…*) to one of your `API_TOKENS`; the time-based trigger sends it as `Authorization: Bearer`.

**Layering:** tokens gate the application. For network-level protection (TLS, rate limiting, IP allow-lists) keep the Caddy reverse proxy from `deploy/` in front — the two are complementary.
