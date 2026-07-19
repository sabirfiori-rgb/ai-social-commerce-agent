# Deployment

How to run the AI Social Commerce Agent in Docker, in production, and how
to scale it up as load grows. Everything here assumes you've already set
up `.env` per [`docs/SETUP.md`](SETUP.md).

## Contents

- [Running with Docker directly](#running-with-docker-directly)
- [Running with Docker Compose](#running-with-docker-compose)
- [Volumes](#volumes)
- [Health checks](#health-checks)
- [Running as a systemd service (no Docker)](#running-as-a-systemd-service-no-docker)
- [Scaling](#scaling)
- [Logging](#logging)

## Why the image looks the way it does

The `Dockerfile` is a single stage built on `node:22-bookworm-slim`. There
is no multi-stage build, no `npm ci`, and no compile step, because this
project has zero runtime npm dependencies and Node executes the
TypeScript source directly. The image:

- installs `ffmpeg` (providing both `ffmpeg` and `ffprobe`), `ca-certificates`,
  and `tini` via `apt-get`;
- verifies at build time that the base image's Node version satisfies the
  `>=22.6` engine requirement, failing the build immediately if it doesn't;
- sets `NODE_OPTIONS="--disable-warning=ExperimentalWarning"` so the
  `node:sqlite` experimental-API warning doesn't spam every process's
  stderr;
- copies `package.json`/`package-lock.json*` for a stable, reproducible
  layer, but deliberately never runs `npm ci` — there is nothing to
  install for runtime;
- copies `tsconfig.json`, `vendor/`, `assets/`, `web/`, `scripts/`, and
  `src/` as separate layers (least-to-most volatile) so an application
  code change doesn't invalidate the `vendor/` (resvg-wasm + fonts) layer
  on rebuild;
- creates a non-root `appuser` (uid/gid 1001), pre-creates
  `/app/data/output`, `/app/data/tmp`, and `/app/credentials`, and runs as
  that user;
- declares `VOLUME ["/app/data"]` so the SQLite database and generated
  assets survive container recreation;
- exposes `8080` and defines a `HEALTHCHECK` that hits `GET /api/health`
  using a small inline `node -e` script (no `curl`/`wget` needed in the
  image);
- uses `tini` as PID 1 for correct signal forwarding, and defaults its
  `CMD` to the **combined** process (`node src/main.ts` — API + worker in
  one container).

## Running with Docker directly

```bash
docker build -t ai-social-commerce-agent:latest .

docker run -d \
  --name ai-social-commerce-agent \
  --env-file .env \
  -p 8080:8080 \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/credentials:/app/credentials:ro" \
  ai-social-commerce-agent:latest
```

To run the API and worker as separate containers instead (sharing the
same image and the same `./data` volume), override the command:

```bash
docker run -d --name asca-api  --env-file .env -p 8080:8080 \
  -v "$(pwd)/data:/app/data" -v "$(pwd)/credentials:/app/credentials:ro" \
  ai-social-commerce-agent:latest node --disable-warning=ExperimentalWarning src/boot/api.ts

docker run -d --name asca-worker --env-file .env \
  -v "$(pwd)/data:/app/data" -v "$(pwd)/credentials:/app/credentials:ro" \
  ai-social-commerce-agent:latest node --disable-warning=ExperimentalWarning src/boot/worker.ts
```

**Never run the combined container and the split containers against the
same `./data` volume at the same time** — pick one topology or the other.
Running both simultaneously means two independent processes would be
polling and claiming Sheet rows/jobs against the same SQLite file, which
the locking design tolerates for *multiple workers of the same topology*
but is simply redundant (and confusing to reason about) if you also have
the combined process's own worker loop running against the same data.

## Running with Docker Compose

`docker-compose.yml` ships with two topologies, selected at invocation
time — never run both against the same `./data` at once:

**Default — one combined `app` service:**

```bash
docker compose up -d --build
```

This builds the image, tags it `ai-social-commerce-agent:latest`, and runs
one container executing `node --disable-warning=ExperimentalWarning src/main.ts`
(API + worker together), with `.env` loaded via `env_file`, port `8080`
published, `./data` and `./credentials` (read-only) mounted, `restart:
unless-stopped`, the same HTTP healthcheck as the Dockerfile, and
`json-file` logging capped at 10MB × 3 files.

**Alternative — split `api` + `worker` services, via the `split` profile:**

```bash
docker compose --profile split up -d --build
```

This starts two containers instead — `api` (`src/boot/api.ts`, port `8080`
published, HTTP healthcheck) and `worker` (`src/boot/worker.ts`, no
published port, no HTTP healthcheck since it has no HTTP listener — Docker
falls back to plain "container is running" liveness for it). Both build
from the same `Dockerfile`, share the image tag, and mount the same
`./data` volume. Use this topology once you want to restart or resource-limit
the API and the worker independently.

Stop whichever topology you started with `docker compose down` (add
`--profile split` if that's what you started) before switching to the
other one.

## Volumes

| Mount | Purpose | Required |
|---|---|---|
| `./data:/app/data` | SQLite database (`data/app.db`), generated assets/videos when `STORAGE_DRIVER=local` (`data/output/`), and temp files (`data/tmp/`) | Yes — without it, all state is lost on container recreation |
| `./credentials:/app/credentials:ro` | Google service-account JSON key file, if you use `GOOGLE_SERVICE_ACCOUNT_FILE` rather than the inline `GOOGLE_SERVICE_ACCOUNT_JSON` env var | Only if `SHEET_STORE=google`/`STORAGE_DRIVER=gdrive` and you chose the file-based credential option |

Both are already declared with sensible bind-mount paths in
`docker-compose.yml`; adjust the host-side paths (left of the colon) to
taste for your environment. The `credentials` mount is read-only (`:ro`)
since the app only ever needs to read that key, never write to it.

## Health checks

Both the `Dockerfile`'s `HEALTHCHECK` and the compose file's
`healthcheck:` blocks run the same check: an inline Node script performs a
plain HTTP GET against `http://127.0.0.1:${HTTP_PORT:-8080}/api/health`
with a 4-second per-request timeout, treating any 2xx response as healthy.
Defaults: `interval: 30s`, `timeout: 5s`, `start_period: 15s`, `retries: 3`.
Use this same endpoint for any external load-balancer or orchestrator
liveness/readiness probe — see [`docs/API.md`](API.md) for its exact
response shape (it also reports which sources/publishers are currently
configured, which is useful context in a failed-probe alert).

## Running as a systemd service (no Docker)

If you'd rather run the app directly on a host without Docker, a minimal
unit file works because there's no build step — `node` just needs to be
able to find the checked-out source tree:

```ini
[Unit]
Description=AI Social Commerce Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-social-commerce-agent
EnvironmentFile=/opt/ai-social-commerce-agent/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/main.ts
Restart=on-failure
RestartSec=5
User=asca
Group=asca

[Install]
WantedBy=multi-user.target
```

Make sure the `asca` user can write to `data/` and, if applicable, read
`credentials/`. Install with `systemctl enable --now ai-social-commerce-agent`.
Ensure the host's `node --version` is `>=22.6` and that `ffmpeg`/`ffprobe`
are on `PATH` for that user (or set `FFMPEG_PATH`/`FFPROBE_PATH` in `.env`
to an absolute path).

## Scaling

The system is designed to scale incrementally, without a rewrite, along
three independent axes:

1. **More worker concurrency within one process.** Raise
   `WORKER_CONCURRENCY` (how many jobs one worker drains at once) and, if
   needed, shorten `POLL_INTERVAL_MINUTES`. This is the first, cheapest
   lever and requires no topology change.
2. **Multiple worker processes/containers against the same database.**
   Because every row claim and job claim is a single atomic
   conditional-UPDATE (see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#concurrency-locking-and-the-job-queue)),
   you can run several `node src/boot/worker.ts` processes — in separate
   containers, or on separate hosts if they share the same database — and
   they will never double-process the same row or job. This is exactly
   what the compose file's `split` profile sets up for a single host; for
   multiple hosts, point `DATABASE_DRIVER=postgres`/`DATABASE_URL` at a
   shared Postgres instance instead of a per-host SQLite file (SQLite's
   single-writer model doesn't extend across hosts).
3. **Move off SQLite to Postgres.** `docker-compose.yml` includes a
   commented-out `postgres` service (`postgres:16-alpine`) with the exact
   environment variables and a matching `.env` snippet
   (`DATABASE_DRIVER=postgres`, `DATABASE_URL=postgres://...`) to uncomment
   when a single SQLite file on a single box stops being enough — most
   commonly once you're running the API on more than one instance and need
   a database that itself handles concurrent writers over the network.

A fourth axis is explicitly **not** wired up out of the box: the job queue
is in-process/SQLite-backed by design, with no Redis dependency. A
commented-out `redis` service is present in `docker-compose.yml` purely as
a documented **future** path — the comment is explicit that using it
"requires adding a redis-backed queue driver to the codebase — not
implemented by default." Don't uncomment it expecting it to do anything on
its own; treat axes 1-3 above as the supported scaling story today, and
Redis/BullMQ as a possible next engineering project if you outgrow them.

## Logging

Both the default `app` service and the `split` profile's `api`/`worker`
services configure Docker's `json-file` log driver with `max-size: 10m`
and `max-file: 3` (a 30MB rolling cap per container) — adjust these in
`docker-compose.yml` if you have a log shipper with different retention
needs, or set `LOG_PRETTY=false` in `.env` to emit structured JSON lines
instead of human-formatted console output (useful when a log aggregator
is parsing stdout). The application logger redacts anything that looks
like a token/secret/password/API key before it's ever written, in either
format — see the [Security section of the README](../README.md#security).
