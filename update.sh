#!/usr/bin/env bash
# ============================================================================
# AI Social Commerce Agent — update to the latest version.
#   - takes a backup first (best effort, via the running container)
#   - pulls latest code (if this is a git checkout)
#   - rebuilds the image and restarts, then prunes old images
#
# Usage:
#   ./update.sh                 # base stack
#   PROD=1 ./update.sh          # include the prod (Caddy) overlay
#   ./update.sh --no-backup     # skip the pre-update backup
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\033[36m▶ %s\033[0m\n' "$*"; }

COMPOSE_ARGS=(-f docker-compose.yml)
[ "${PROD:-0}" = "1" ] && COMPOSE_ARGS+=(-f deploy/docker-compose.prod.yml)

# --- 1. Pre-update backup (best effort) ------------------------------------
if [[ "${*:-}" != *"--no-backup"* ]]; then
  log "Taking a pre-update backup…"
  docker compose "${COMPOSE_ARGS[@]}" exec -T app node scripts/backup.ts || log "(backup skipped — app not running yet)"
fi

# --- 2. Pull latest code ---------------------------------------------------
if [ -d .git ]; then
  log "Pulling latest code…"
  git pull --ff-only
else
  log "Not a git checkout — update the source files, then re-run. (Rebuilding current tree.)"
fi

# --- 3. Rebuild + restart --------------------------------------------------
log "Rebuilding and restarting…"
docker compose "${COMPOSE_ARGS[@]}" up -d --build

# --- 4. Cleanup ------------------------------------------------------------
log "Pruning dangling images…"
docker image prune -f >/dev/null || true

log "Update complete. Check status: docker compose ${COMPOSE_ARGS[*]} ps"
