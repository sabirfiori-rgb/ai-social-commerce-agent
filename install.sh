#!/usr/bin/env bash
# ============================================================================
# AI Social Commerce Agent — one-click installer for Debian/Ubuntu hosts.
#
#   - installs Docker Engine + Compose plugin if missing
#   - creates .env with a freshly generated ENCRYPTION_KEY (if missing)
#   - prepares data/ + credentials/ with correct ownership (container uid 1001)
#   - builds and starts the stack, then waits for the health check
#
# Local / dev (API on http://<host>:8080, no TLS):
#   ./install.sh
#
# Production (HTTPS + basic auth via Caddy):
#   PROD=1 SITE_ADDRESS=agent.example.com [email protected] ./install.sh
#   (ADMIN_PASSWORD optional — generated and printed if unset)
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

log() { printf '\033[36m▶ %s\033[0m\n' "$*"; }
err() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

# --- 1. Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine…"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker || true
else
  log "Docker already installed: $(docker --version)"
fi
if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose plugin not found. Install 'docker-compose-plugin' and re-run."
  exit 1
fi

# --- 2. .env ---------------------------------------------------------------
gen_key() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
if [ ! -f .env ]; then
  log "Creating .env with a generated ENCRYPTION_KEY…"
  cp .env.example .env
  KEY="$(gen_key)"
  sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${KEY}|" .env && rm -f .env.bak
else
  log ".env already exists — leaving it untouched."
fi

# --- 3. data / credentials dirs (container runs as uid 1001) ---------------
log "Preparing data/ and credentials/ …"
mkdir -p data credentials
$SUDO chown -R 1001:1001 data

COMPOSE_ARGS=(-f docker-compose.yml)

# --- 4. Production TLS + auth (optional) -----------------------------------
if [ "${PROD:-0}" = "1" ]; then
  : "${SITE_ADDRESS:?Set SITE_ADDRESS=your.domain for PROD=1}"
  ADMIN_USER="${ADMIN_USER:-admin}"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(gen_key | cut -c1-20)}"
  log "Generating Caddy basic-auth hash for user '${ADMIN_USER}'…"
  HASH="$(docker run --rm caddy caddy hash-password --plaintext "${ADMIN_PASSWORD}")"
  # upsert prod vars in .env
  set_env() { grep -q "^$1=" .env && sed -i.bak "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; rm -f .env.bak; }
  set_env SITE_ADDRESS "${SITE_ADDRESS}"
  set_env BASIC_AUTH_USER "${ADMIN_USER}"
  set_env BASIC_AUTH_HASH "${HASH}"
  set_env PUBLIC_BASE_URL "https://${SITE_ADDRESS}"
  set_env STORAGE_PUBLIC_BASE_URL "https://${SITE_ADDRESS}/files"
  COMPOSE_ARGS+=(-f deploy/docker-compose.prod.yml)
  log "Production mode: HTTPS + basic auth via Caddy at https://${SITE_ADDRESS}"
fi

# --- 5. Build + start ------------------------------------------------------
log "Building and starting containers…"
docker compose "${COMPOSE_ARGS[@]}" up -d --build

# --- 6. Wait for health ----------------------------------------------------
log "Waiting for the app to become healthy…"
for i in $(seq 1 30); do
  if docker compose "${COMPOSE_ARGS[@]}" exec -T app node -e "require('http').get({host:'127.0.0.1',port:process.env.HTTP_PORT||8080,path:'/api/health'},r=>process.exit(r.statusCode<300?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 2
done

echo
log "Done. The AI Social Commerce Agent is running."
if [ "${PROD:-0}" = "1" ]; then
  echo "   URL:      https://${SITE_ADDRESS}"
  echo "   Login:    ${ADMIN_USER} / ${ADMIN_PASSWORD}"
else
  echo "   URL:      http://localhost:${HTTP_PORT:-8080}"
fi
echo "   Seed a demo:   docker compose ${COMPOSE_ARGS[*]} exec app node scripts/seed.ts"
echo "   Process now:   curl -X POST http://localhost:${HTTP_PORT:-8080}/api/actions/run"
