#!/usr/bin/env node
/**
 * Fetch vendored runtime assets that are intentionally NOT committed to git:
 *   - resvg WebAssembly build (the SVG -> PNG rasterizer)
 *   - Poppins font family (OFL) used by the image/video engines
 *
 * Run after cloning:  node scripts/fetch-vendor.mjs
 * Idempotent: skips assets already present (pass --force to re-download).
 * Never hard-fails (so `npm install` / Docker builds don't break offline).
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.');
const FORCE = process.argv.includes('--force');
const RESVG_VERSION = '2.6.2';

const assets = [
  { url: `https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@${RESVG_VERSION}/index_bg.wasm`, path: 'vendor/resvg/resvg.wasm' },
  { url: `https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@${RESVG_VERSION}/index.mjs`, path: 'vendor/resvg/resvg.mjs' },
];
const POPPINS = 'https://raw.githubusercontent.com/google/fonts/main/ofl/poppins';
for (const weight of ['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black']) {
  assets.push({ url: `${POPPINS}/Poppins-${weight}.ttf`, path: `vendor/fonts/Poppins-${weight}.ttf` });
}

let fetched = 0;
let skipped = 0;
let failed = 0;

for (const asset of assets) {
  const dest = resolve(ROOT, asset.path);
  if (!FORCE && existsSync(dest) && statSync(dest).size > 0) {
    skipped++;
    continue;
  }
  try {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    console.log(`  fetched ${asset.path} (${Math.round(buf.length / 1024)} KB)`);
    fetched++;
  } catch (e) {
    console.warn(`  WARN could not fetch ${asset.path}: ${(e && e.message) || e}`);
    failed++;
  }
}

console.log(`vendor assets: ${fetched} fetched, ${skipped} present, ${failed} failed`);
if (failed > 0 && fetched === 0 && skipped === 0) {
  console.warn('No vendored assets available — the image/video engines need these to run.');
}
process.exitCode = 0;
