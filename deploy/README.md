# `deploy/` — production overlays and platform-specific configs

Everything under `docker-compose.yml` and the root `Dockerfile` at the
repo root is enough to run the agent. The files in this directory are
**optional overlays and alternative targets** for two specific situations:
putting the base stack behind HTTPS + auth on a plain Linux host (VPS/EC2),
or deploying to Fly.io instead of a self-managed host. Use exactly one of
the two paths below — they are independent, not layered on each other.

## Contents

- [`docker-compose.prod.yml`](#docker-composeprodyml) — VPS/EC2 production overlay
- [`Caddyfile`](#caddyfile) — the reverse proxy config the overlay mounts
- [`fly.toml`](#flytoml) — Fly.io app/deploy configuration
- [`Dockerfile.fly`](#dockerfilefly) — Fly.io-specific image
- [`fly-entrypoint.sh`](#fly-entrypointsh) — Fly.io volume-permission fixup
- [Choosing a path](#choosing-a-path)

## `docker-compose.prod.yml`

A **Compose override file**, not a standalone Compose file — it's applied
on top of the root `docker-compose.yml`, never on its own. It makes two
changes:

1. Re-publishes the `app` service's port as `127.0.0.1:8080:8080` instead
   of `8080:8080` — the API is no longer reachable directly from the
   internet, only from the host loopback and the Compose network.
2. Adds a `caddy` service (`caddy:2`) that publishes `80`/`443`
   (+ `443/udp` for HTTP/3), mounts `./deploy/Caddyfile` read-only, and
   proxies to `app:8080` over the internal Compose network. It reads
   `SITE_ADDRESS`, `BASIC_AUTH_USER`, and `BASIC_AUTH_HASH` from `.env` via
   `env_file`, and persists its ACME account/certificates in two named
   volumes (`caddy-data`, `caddy-config`) so certificates survive
   container recreation.

**Usage:**

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

**Required `.env` additions** before starting (or let `./install.sh
PROD=1 ...` generate them for you — see [`docs/OPERATIONS.md`](../docs/OPERATIONS.md#one-click-install)):

```env
SITE_ADDRESS=agent.yourdomain.com
BASIC_AUTH_USER=admin
BASIC_AUTH_HASH=<output of: docker run --rm caddy caddy hash-password --plaintext 'yourpassword'>
PUBLIC_BASE_URL=https://agent.yourdomain.com
STORAGE_PUBLIC_BASE_URL=https://agent.yourdomain.com/files
```

**Prerequisites on the host:**

- A DNS `A`/`AAAA` record for `SITE_ADDRESS` pointed at the host's public
  IP, set up *before* starting the stack — Caddy requests a Let's Encrypt
  certificate on first request and needs the domain to resolve for the
  ACME HTTP-01 challenge to succeed.
- Ports `80` and `443` open and unused by anything else on the host (no
  other process bound to them — Caddy needs both for cert issuance/renewal
  and for serving HTTPS).

Stopping/restarting: use the same two `-f` flags on every `docker compose`
invocation against this stack (`down`, `logs`, `ps`, etc.), or export
`COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.prod.yml` in your
shell so you can drop the flags for the rest of the session.

## `Caddyfile`

The reverse-proxy config `docker-compose.prod.yml` mounts into the
`caddy` service. It is driven entirely by the three environment variables
above (`{$SITE_ADDRESS}`, `{$BASIC_AUTH_USER}`, `{$BASIC_AUTH_HASH}` —
Caddy's env-var interpolation syntax) rather than hardcoded values, so the
file itself never needs to be edited per-deployment:

```caddyfile
{$SITE_ADDRESS} {
    encode zstd gzip
    basic_auth {
        {$BASIC_AUTH_USER} {$BASIC_AUTH_HASH}
    }
    reverse_proxy app:8080
    log {
        output stdout
        format console
    }
}
```

It gzip/zstd-compresses responses, gates the **entire app** (dashboard,
REST API, admin panel, metrics endpoint — everything) behind HTTP basic
auth, proxies to the `app` service by its Compose service name on the
internal network, and logs access lines to stdout (captured by Docker's
`json-file` driver like every other service in this stack).

Generate the password hash referenced by `BASIC_AUTH_HASH`:

```bash
docker run --rm caddy caddy hash-password --plaintext 'your-strong-password'
```

You should not need to edit this file directly — `./install.sh PROD=1`
generates the hash and writes the three variables into `.env`
automatically. Edit it only if you want different behavior (e.g.
per-path auth exemptions, a different compression policy, or additional
`reverse_proxy` blocks for other services on the same host).

## `fly.toml`

Fly.io's app manifest — used by every `fly` CLI command (`fly launch`,
`fly deploy`, `fly status`, etc.) run from the repo root. Key settings and
why they're set this way:

- **`[build].dockerfile = "deploy/Dockerfile.fly"`** — Fly needs a
  variant of the standard image that starts as root and fixes ownership
  of the mounted volume before dropping privileges (see
  [`Dockerfile.fly`](#dockerfilefly) below); the plain root `Dockerfile`
  assumes a bind-mounted host directory you `chown` yourself, which isn't
  how Fly volumes work.
- **`DRY_RUN = "true"`** in `[env]` — ships safe by default; flip to
  `"false"` via `fly secrets set DRY_RUN=false` once you've connected real
  publisher credentials and are ready to go live, rather than editing
  `fly.toml` and redeploying.
- **`[[http_service.checks]]` hits `/api/health`** every 30 seconds — the
  same endpoint documented in
  [`docs/OPERATIONS.md`](../docs/OPERATIONS.md#health--readiness) and used
  by the Docker/Compose `HEALTHCHECK`.
- **`auto_stop_machines = false`, `min_machines_running = 1`** — this app
  runs a background polling worker in the same process as the HTTP API
  (`src/main.ts`), so it must not be scaled to zero on idle the way a
  pure request/response app could be; the worker needs to keep running
  even with no incoming HTTP traffic.
- **A single persistent volume (`agent_data`) mounted at `/app/data`** —
  holds the SQLite database and generated assets, exactly like the
  `./data` bind mount in the root `docker-compose.yml`.
- **`size = "shared-cpu-1x"`, `memory = "1024mb"`** — sized for `ffmpeg`
  video rendering plus the `resvg-wasm` image renderer; reduce only if you
  disable video rendering, and increase if you run higher
  `WORKER_CONCURRENCY`.

This app is explicitly **single-machine by design** (SQLite on a local
volume + an in-process job queue) — see the comment block at the top of
the file. Do not run `fly scale count` above `1` without first moving to
Postgres (`DATABASE_DRIVER=postgres`/`DATABASE_URL`, per the scaling
section of [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md#scaling)); running
multiple Fly machines against the same SQLite file is not supported.

**First-time deploy:**

```bash
fly launch --no-deploy --copy-config --name <your-unique-app-name>
fly volumes create agent_data --size 3 --region <region>
fly secrets set ENCRYPTION_KEY=$(openssl rand -hex 32)
fly deploy
fly scale count 1
fly open
```

`fly launch --copy-config` picks up this `fly.toml` as-is rather than
generating a new one; `--no-deploy` lets you create the volume and set
secrets before the first deploy actually runs. Fly provisions HTTPS and a
`<name>.fly.dev` hostname automatically — there's no Caddy step here,
unlike the VPS path. Add your own auth (the app has none built in — see
[the API security note](../docs/API.md#security-note)) before sharing the
URL widely; the compose-based `docker-compose.prod.yml` + `Caddyfile`
combo is not used on Fly.

**Redeploying after code changes:**

```bash
fly deploy
```

**Updating a secret/config value:**

```bash
fly secrets set SOME_KEY=value    # for anything sensitive
# or edit fly.toml's [env] block for non-sensitive values, then:
fly deploy
```

## `Dockerfile.fly`

Nearly identical to the root `Dockerfile` — same base image
(`node:22-bookworm-slim`), same `ffmpeg`/`ca-certificates`/`tini`
packages, same Node-version guard, same layer ordering, same non-root
`appuser` (uid/gid `1001`). The one structural difference: it does **not**
switch to `USER appuser` before `ENTRYPOINT`. Instead it stays root and
delegates the privilege drop to [`fly-entrypoint.sh`](#fly-entrypointsh),
because Fly mounts its persistent volume owned by root — a plain
`USER appuser` (as in the root `Dockerfile`, which assumes you `chown`
the bind-mounted `./data` directory yourself before `docker compose up`)
would leave the app unable to write to `/app/data` on first boot.

Use the root `Dockerfile` for any plain Docker/Compose host (you control
and `chown` the bind mount yourself, as `./install.sh` and
`docker-compose.yml` already do). Use `Dockerfile.fly` only via
`fly.toml`'s `[build].dockerfile` setting — it is not intended to be built
or run standalone outside Fly.

## `fly-entrypoint.sh`

The container's `ENTRYPOINT` on Fly (invoked by `tini` as PID 1, per
`Dockerfile.fly`). Three steps, run as root before anything else starts:

```sh
mkdir -p /app/data/output /app/data/tmp
chown -R 1001:1001 /app/data 2>/dev/null || true
exec setpriv --reuid=1001 --regid=1001 --init-groups "$@"
```

1. Ensures the expected subdirectories exist on the mounted volume.
2. Recursively `chown`s the volume to `1001:1001` (the `appuser` uid/gid)
   — this re-runs on every boot, which is cheap and idempotent, and is
   what lets the volume be root-owned by default on a fresh Fly volume
   while still being writable by the non-root app process.
3. `exec`s into the real command (`node ... src/main.ts`, from
   `Dockerfile.fly`'s `CMD`) as uid/gid `1001` using `setpriv`
   (util-linux) — `exec` (not a subshell/wrapper) means `tini` still
   directly supervises the actual Node process, so signals (`SIGTERM` on
   `fly deploy`/restart) reach it and get handled cleanly, and zombie
   processes still get reaped correctly.

You should not need to modify this file — it is infrastructure plumbing
specific to Fly's volume-mounting model, not application configuration.

## Choosing a path

| You want... | Use |
|---|---|
| A quick local/dev instance | root `docker-compose.yml` alone — see the main [README Quick start](../README.md#quick-start) or `./install.sh` with no flags |
| A production VPS/EC2 box with your own domain, HTTPS, and basic auth | `docker-compose.prod.yml` + `Caddyfile`, via `./install.sh PROD=1 SITE_ADDRESS=... [email protected]` (see [`docs/OPERATIONS.md`](../docs/OPERATIONS.md#one-click-install)) or the manual `docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build` command above |
| A managed platform with automatic HTTPS and no server to patch | Fly.io, via `fly.toml` + `Dockerfile.fly` + `fly-entrypoint.sh` — follow the first-time deploy steps under [`fly.toml`](#flytoml) |

Both production paths still write to the same SQLite-backed data model, so
the same [backup/restore tooling](../docs/OPERATIONS.md#backup--restore)
applies to either — for Fly specifically, run `scripts/backup.ts` via
`fly ssh console -C 'node scripts/backup.ts'` and pull the resulting file
off the volume with `fly sftp get`, since there's no Caddy layer to expose
the admin panel's download endpoint through your own domain unless you've
added your own auth in front of it first.
