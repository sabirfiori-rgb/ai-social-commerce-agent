/**
 * Unit test for src/infrastructure/image/resvg-rasterizer.ts — renders a small
 * SVG produced by buildTemplate() into a real PNG buffer via the vendored
 * resvg WASM build. No network, no ffmpeg; should complete in well under a
 * second even including one-time WASM module initialization.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ResvgRasterizer } from '../src/infrastructure/image/resvg-rasterizer.ts';
import { buildTemplate } from '../src/infrastructure/image/templates.ts';
import type { NormalizedProduct, BrandProfile } from '../src/domain/entities.ts';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function makeTinyProduct(): NormalizedProduct {
  return {
    id: 'prd-tiny',
    dedupeKey: 'dedupe-tiny',
    source: 'manual',
    title: 'Tiny Widget',
    brand: 'Acme',
    category: 'Gadgets',
    description: 'A small test widget.',
    features: ['Compact'],
    images: [],
    language: 'en',
    importedAt: new Date().toISOString(),
  };
}

function makeBrand(): BrandProfile {
  return {
    name: 'Acme',
    primaryColor: '#111111',
    accentColor: '#E63946',
    textColor: '#ffffff',
    font: 'Poppins',
    cta: 'Shop now',
    language: 'en',
  };
}

describe('ResvgRasterizer.render', () => {
  test('rasterizes an instagram_post SVG (no product image) into a valid PNG buffer', async () => {
    const svg = buildTemplate('instagram_post', {
      product: makeTinyProduct(),
      brand: makeBrand(),
      family: 'Poppins',
      width: 1080,
      height: 1350,
    });
    assert.ok(svg.includes('<svg'));

    const rasterizer = new ResvgRasterizer({ brandFont: 'Poppins' });
    const png = await rasterizer.render({ svg });

    assert.ok(Buffer.isBuffer(png));
    assert.ok(png.length > 1000, `expected PNG to be larger than 1000 bytes, got ${png.length}`);
    assert.deepEqual([...png.subarray(0, 4)], PNG_MAGIC);
  });

  test('rasterizes consistently across repeated calls on the same rasterizer instance (module cache reuse)', async () => {
    const svg = buildTemplate('instagram_post', {
      product: makeTinyProduct(),
      brand: makeBrand(),
      family: 'Poppins',
      width: 400,
      height: 500,
    });
    const rasterizer = new ResvgRasterizer({ brandFont: 'Poppins' });
    const first = await rasterizer.render({ svg });
    const second = await rasterizer.render({ svg });
    assert.deepEqual([...first.subarray(0, 4)], PNG_MAGIC);
    assert.deepEqual([...second.subarray(0, 4)], PNG_MAGIC);
  });
});
