/**
 * Unit tests for src/infrastructure/ai/template-generator.ts — the deterministic,
 * zero-key ICopyGenerator. No network calls involved; pure data transformation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TemplateCopyGenerator } from '../src/infrastructure/ai/template-generator.ts';
import { ALL_TONES, ALL_PLATFORMS } from '../src/domain/enums.ts';
import type { NormalizedProduct, BrandProfile } from '../src/domain/entities.ts';
import type { Tone, Platform } from '../src/domain/enums.ts';

function makeProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    id: 'prd-1',
    dedupeKey: 'dedupe-1',
    source: 'manual',
    title: 'Wireless Noise-Cancelling Headphones',
    brand: 'Acme',
    category: 'Audio',
    description: 'Premium wireless headphones with active noise cancellation.',
    features: ['40-hour battery life', 'Active noise cancellation', 'Bluetooth 5.3'],
    price: { amount: 129.99, currency: 'USD', formatted: '$129.99' },
    images: [],
    language: 'en',
    importedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBrand(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    name: 'Acme',
    primaryColor: '#111111',
    accentColor: '#E63946',
    textColor: '#ffffff',
    font: 'Poppins',
    cta: 'Shop now',
    language: 'en',
    ...overrides,
  };
}

const generator = new TemplateCopyGenerator();

describe('TemplateCopyGenerator.generate — exact counts', () => {
  for (const tone of ALL_TONES as Tone[]) {
    test(`tone=${tone}: hooks=10, ctas=5, hashtags=30`, async () => {
      const content = await generator.generate({
        product: makeProduct(),
        brand: makeBrand(),
        tone,
        platforms: ['instagram'],
        language: 'en',
      });
      assert.equal(content.hooks.length, 10);
      assert.equal(content.ctas.length, 5);
      assert.equal(content.hashtags.length, 30);
    });
  }

  test('produces a CaptionSet per requested platform: 6 captions when all 6 platforms requested', async () => {
    const content = await generator.generate({
      product: makeProduct(),
      brand: makeBrand(),
      tone: 'friendly',
      platforms: [...ALL_PLATFORMS] as Platform[],
      language: 'en',
    });
    assert.equal(content.captions.length, 6);
    const platformsSeen = content.captions.map((c) => c.platform).sort();
    assert.deepEqual(platformsSeen, [...ALL_PLATFORMS].sort());
  });

  test('produces exactly N captions for N requested platforms (subset)', async () => {
    const content = await generator.generate({
      product: makeProduct(),
      brand: makeBrand(),
      tone: 'professional',
      platforms: ['instagram', 'x', 'linkedin'],
      language: 'en',
    });
    assert.equal(content.captions.length, 3);
  });
});

describe('TemplateCopyGenerator.generate — hashtags', () => {
  test('hashtags are all lowercase, #-prefixed, and unique', async () => {
    const content = await generator.generate({
      product: makeProduct(),
      brand: makeBrand(),
      tone: 'sales',
      platforms: ['instagram'],
      language: 'en',
    });
    for (const tag of content.hashtags) {
      assert.match(tag, /^#[a-z0-9]+$/, `hashtag "${tag}" should be lowercase and #-prefixed`);
    }
    const unique = new Set(content.hashtags.map((t) => t.toLowerCase()));
    assert.equal(unique.size, content.hashtags.length, 'hashtags should be deduplicated');
  });
});

describe('TemplateCopyGenerator.generate — X (Twitter) caption length', () => {
  for (const tone of ALL_TONES as Tone[]) {
    test(`tone=${tone}: X caption stays within 280 characters`, async () => {
      const content = await generator.generate({
        product: makeProduct(),
        brand: makeBrand(),
        tone,
        platforms: ['x'],
        language: 'en',
      });
      const xCaption = content.captions.find((c) => c.platform === 'x');
      assert.ok(xCaption);
      assert.ok(xCaption!.primary.length <= 280, `expected <=280 chars, got ${xCaption!.primary.length}`);
      for (const variation of xCaption!.variations) {
        assert.ok(variation.length <= 280, `variation exceeded 280 chars: ${variation.length}`);
      }
    });
  }

  test('a long product title + urgent (uppercased) tone still stays within 280 chars', async () => {
    const product = makeProduct({
      title: 'The All-New Ultra Premium Ergonomic Ambient-Sound Wireless Bluetooth Studio Headphones Collection',
      category: 'Consumer Electronics and Portable Audio Accessories',
    });
    const content = await generator.generate({
      product,
      brand: makeBrand(),
      tone: 'urgent',
      platforms: ['x'],
      language: 'en',
    });
    const xCaption = content.captions.find((c) => c.platform === 'x');
    assert.ok(xCaption!.primary.length <= 280);
  });
});

describe('TemplateCopyGenerator.generate — tone differentiation', () => {
  test('every tone produces a distinct Instagram primary caption for the same product/brand', async () => {
    const primaries = new Map<Tone, string>();
    for (const tone of ALL_TONES as Tone[]) {
      const content = await generator.generate({
        product: makeProduct(),
        brand: makeBrand(),
        tone,
        platforms: ['instagram'],
        language: 'en',
      });
      const ig = content.captions.find((c) => c.platform === 'instagram');
      assert.ok(ig);
      primaries.set(tone, ig!.primary);
    }
    const values = [...primaries.values()];
    const unique = new Set(values);
    assert.equal(unique.size, values.length, 'expected all 7 tones to produce distinct Instagram captions');
  });
});

describe('TemplateCopyGenerator.generate — misc content shape', () => {
  test('language falls back through ctx.language -> product.language -> brand.language -> "en"', async () => {
    const content = await generator.generate({
      product: makeProduct({ language: 'fr' }),
      brand: makeBrand({ language: 'de' }),
      tone: 'friendly',
      platforms: ['instagram'],
      language: '',
    });
    assert.equal(content.language, 'fr');
  });

  test('seoKeywords has at least 10 entries and emojis has at least 8', async () => {
    const content = await generator.generate({
      product: makeProduct(),
      brand: makeBrand(),
      tone: 'minimal',
      platforms: ['instagram'],
      language: 'en',
    });
    assert.ok(content.seoKeywords.length >= 10);
    assert.ok(content.emojis.length >= 8);
  });

  test('provider is "template" and productId matches the input product', async () => {
    const product = makeProduct({ id: 'prd-xyz' });
    const content = await generator.generate({
      product,
      brand: makeBrand(),
      tone: 'friendly',
      platforms: ['instagram'],
      language: 'en',
    });
    assert.equal(content.provider, 'template');
    assert.equal(content.productId, 'prd-xyz');
  });
});
