# ============================================================================
# AI Social Commerce Agent — production image
#
# This app is plain TypeScript executed directly by Node's native type-stripping
# (Node >=22.6). There is NO build/transpile step and ZERO npm runtime
# dependencies (only devDependencies used for optional local typechecking), so
# this is a single-stage image: install the OS-level runtime deps (ffmpeg),
# copy the source tree as-is, and run it with `node`.
# ============================================================================

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="AI Social Commerce Agent" \
      org.opencontainers.image.description="Autonomous AI marketing employee: Google Sheet product rows -> published social media content" \
      org.opencontainers.image.licenses="MIT"

# --- OS-level runtime dependencies ------------------------------------------
# ffmpeg provides both the `ffmpeg` and `ffprobe` binaries required by the
# video rendering engine (src/infrastructure/video). ca-certificates and
# tini are pulled in for TLS trust and clean PID-1 signal handling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       ca-certificates \
       tini \
    && rm -rf /var/lib/apt/lists/*

# Node >=22.6 is required by package.json engines; verify the base image
# satisfies it and fail fast at build time if it ever doesn't.
RUN node -e "const [maj,min]=process.versions.node.split('.').map(Number); if (maj<22||(maj===22&&min<6)) { console.error('Node >=22.6 required, found '+process.versions.node); process.exit(1); }"

# Silence node:sqlite's ExperimentalWarning for every process started in this
# image (CMD below repeats the flag explicitly for clarity/overridability).
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning" \
    NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8080

WORKDIR /app

# --- Dependencies ------------------------------------------------------------
# Zero runtime deps: package.json only lists devDependencies (typescript,
# @types/node) used for `npm run typecheck`, which we don't run in the image.
# `npm ci` is skipped entirely — there is nothing to install for runtime, and
# skipping it keeps the image small and the build fast. package-lock.json is
# still copied so the layer is present and reproducible if that ever changes.
COPY package.json ./
COPY package-lock.json* ./

# --- Application source -----------------------------------------------------
# Copied as separate layers (least-to-most volatile) so edits to app code
# don't invalidate the vendored-asset layers on rebuild.
COPY tsconfig.json ./
COPY vendor ./vendor
COPY assets ./assets
COPY web ./web
COPY scripts ./scripts
COPY src ./src

# Fetch vendored runtime assets (resvg WASM + fonts) that are not committed to git.
# Idempotent: skips anything already copied in from the build context.
RUN node scripts/fetch-vendor.mjs

# --- Non-root runtime user ---------------------------------------------------
RUN groupadd --system --gid 1001 appuser \
    && useradd --system --uid 1001 --gid appuser --home-dir /app --shell /usr/sbin/nologin appuser \
    && mkdir -p /app/data/output /app/data/tmp /app/credentials \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "const http=require('http');const req=http.get({host:process.env.HTTP_HOST==='0.0.0.0'?'127.0.0.1':process.env.HTTP_HOST,port:process.env.HTTP_PORT||8080,path:'/api/health',timeout:4000},(res)=>{process.exit(res.statusCode>=200&&res.statusCode<300?0:1)});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1)});"

ENTRYPOINT ["tini", "--"]

# Combined server+worker process (single container running both the HTTP API
# and the background pipeline worker in one Node process). Use
# `node src/boot/api.ts` / `node src/boot/worker.ts` as the command overrides
# to split them into separate containers (see docker-compose.yml "split" profile).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
