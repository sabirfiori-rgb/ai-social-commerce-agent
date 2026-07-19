#!/bin/sh
# Fly.io (and any platform that mounts a root-owned volume into a non-root
# container) entrypoint: ensure the persistent data dir is writable by the app
# user (uid 1001), then drop root and exec the app as that user.
set -e

mkdir -p /app/data/output /app/data/tmp
chown -R 1001:1001 /app/data 2>/dev/null || true

# setpriv (util-linux) exec's the target directly as uid/gid 1001 — no wrapper
# process, so tini (PID 1) still reaps and signals still forward cleanly.
exec setpriv --reuid=1001 --regid=1001 --init-groups "$@"
