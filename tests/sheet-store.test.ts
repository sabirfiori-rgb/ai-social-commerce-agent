/**
 * Unit tests for src/infrastructure/sheets/local-sheet-store.ts against a
 * fresh in-memory SQLite database per test.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../src/infrastructure/db/database.ts';
import { LocalSheetStore } from '../src/infrastructure/sheets/local-sheet-store.ts';
import { nowIso } from '../src/shared/clock.ts';

let db: Db;
let store: LocalSheetStore;

beforeEach(async () => {
  db = new Db(':memory:');
  db.migrate();
  store = new LocalSheetStore(db);
  await store.init();
});

afterEach(() => {
  db.close();
});

describe('LocalSheetStore.appendProduct', () => {
  test('defaults status to NEW and assigns an id + sequential rowNumber', async () => {
    const row = await store.appendProduct({ productSource: 'manual', brand: 'Acme' });
    assert.equal(row.status, 'NEW');
    assert.ok(row.id.length > 0);
    assert.equal(row.rowNumber, 1);
    assert.ok(row.createdTime.length > 0);
    assert.ok(row.updatedTime.length > 0);
  });

  test('increments rowNumber (seq) across multiple appends', async () => {
    const a = await store.appendProduct({ brand: 'Acme' });
    const b = await store.appendProduct({ brand: 'Acme' });
    assert.equal(a.rowNumber, 1);
    assert.equal(b.rowNumber, 2);
  });

  test('honors a caller-supplied id instead of generating one', async () => {
    const row = await store.appendProduct({ id: 'prd_custom_123', brand: 'Acme' });
    assert.equal(row.id, 'prd_custom_123');
    const fetched = await store.getProduct('prd_custom_123');
    assert.ok(fetched);
  });
});

describe('LocalSheetStore.findClaimableRows', () => {
  test('returns only rows in NEW status, ordered by seq ascending', async () => {
    const a = await store.appendProduct({ brand: 'A' });
    const b = await store.appendProduct({ brand: 'B' });
    await store.updateRow(a.id, { status: 'POSTED' as never });

    const claimable = await store.findClaimableRows(10);
    assert.equal(claimable.length, 1);
    assert.equal(claimable[0]!.id, b.id);
  });

  test('respects the limit parameter', async () => {
    await store.appendProduct({ brand: 'A' });
    await store.appendProduct({ brand: 'B' });
    await store.appendProduct({ brand: 'C' });
    const claimable = await store.findClaimableRows(2);
    assert.equal(claimable.length, 2);
  });
});

describe('LocalSheetStore.claimRow', () => {
  test('first claim succeeds (returns true), racing second claim fails (returns false)', async () => {
    const row = await store.appendProduct({ brand: 'Acme' });

    const first = await store.claimRow(row, 'worker-a', 60_000);
    assert.equal(first, true);

    const second = await store.claimRow(row, 'worker-b', 60_000);
    assert.equal(second, false);

    const fetched = await store.getProduct(row.id);
    assert.equal(fetched!.status, 'PROCESSING');
  });

  test('a stale (expired) PROCESSING lock can be reclaimed', async () => {
    const row = await store.appendProduct({ brand: 'Acme' });
    await store.claimRow(row, 'worker-a', 60_000);

    // Force the lock to appear expired.
    db.run(`UPDATE sheet_products SET lock_expires = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      row.id,
    ]);

    const reclaimed = await store.claimRow(row, 'worker-b', 60_000);
    assert.equal(reclaimed, true);
  });
});

describe('LocalSheetStore.setStatus', () => {
  test('transitions status and applies an additional patch in the same update', async () => {
    const row = await store.appendProduct({ brand: 'Acme' });
    await store.setStatus(row.id, 'CONTENT_CREATED' as never, { generatedCaption: 'Hello!' });
    const fetched = await store.getProduct(row.id);
    assert.equal(fetched!.status, 'CONTENT_CREATED');
    assert.equal(fetched!.generatedCaption, 'Hello!');
  });

  test('updates updatedTime on every transition', async () => {
    const row = await store.appendProduct({ brand: 'Acme' });
    const before = row.updatedTime;
    await new Promise((r) => setTimeout(r, 5));
    await store.setStatus(row.id, 'FAILED' as never, { error: 'boom' });
    const fetched = await store.getProduct(row.id);
    assert.notEqual(fetched!.updatedTime, before);
  });
});

describe('LocalSheetStore.getBrandSettings / upsertBrandSettings', () => {
  const profile = {
    name: 'Acme',
    primaryColor: '#112233',
    accentColor: '#ff0000',
    textColor: '#ffffff',
    font: 'Poppins',
    logoUrl: 'https://example.com/logo.png',
    watermarkText: '@acme',
    cta: 'Shop now',
    language: 'en',
  };

  test('round-trips a brand profile', async () => {
    await store.upsertBrandSettings(profile as never);
    const fetched = await store.getBrandSettings('Acme');
    assert.ok(fetched);
    assert.equal(fetched!.name, 'Acme');
    assert.equal(fetched!.primaryColor, '#112233');
    assert.equal(fetched!.cta, 'Shop now');
  });

  test('brand lookup is case-insensitive', async () => {
    await store.upsertBrandSettings(profile as never);
    const fetched = await store.getBrandSettings('ACME');
    assert.ok(fetched);
    assert.equal(fetched!.name, 'Acme');
  });

  test('upsert updates the existing row rather than duplicating it', async () => {
    await store.upsertBrandSettings(profile as never);
    await store.upsertBrandSettings({ ...profile, primaryColor: '#000000' } as never);
    const fetched = await store.getBrandSettings('Acme');
    assert.equal(fetched!.primaryColor, '#000000');
    const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sheet_brand_settings WHERE brand = 'Acme'`);
    assert.equal(count!.n, 1);
  });

  test('returns null for an unknown brand', async () => {
    const fetched = await store.getBrandSettings('NoSuchBrand');
    assert.equal(fetched, null);
  });
});

describe('LocalSheetStore.appendGeneratedContent / upsertSchedule', () => {
  test('appendGeneratedContent writes a row with joined hashtags/hooks/ctas', async () => {
    const content = {
      id: 'content_1',
      productId: 'prd-1',
      tone: 'friendly' as const,
      language: 'en',
      provider: 'template',
      captions: [],
      hooks: ['Hook A', 'Hook B'],
      ctas: ['Buy now'],
      hashtags: ['#deal', '#sale'],
      seoKeywords: [],
      emojis: [],
      createdAt: nowIso(),
    };
    await store.appendGeneratedContent(content as never, 'instagram' as never, 'Full caption text');

    const row = db.get<Record<string, unknown>>(`SELECT * FROM sheet_generated WHERE product_id = ?`, ['prd-1']);
    assert.ok(row);
    assert.equal(row!.platform, 'instagram');
    assert.equal(row!.caption, 'Full caption text');
    assert.equal(row!.hashtags, '#deal #sale');
    assert.equal(row!.hooks, 'Hook A | Hook B');
    assert.equal(row!.ctas, 'Buy now');
  });

  test('upsertSchedule writes a schedule row keyed by publication id', async () => {
    const pub = {
      id: 'pub_1',
      productId: 'prd-1',
      platform: 'instagram' as const,
      status: 'dry_run' as const,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await store.upsertSchedule(pub as never);
    const row = db.get<Record<string, unknown>>(`SELECT * FROM sheet_schedule WHERE id = ?`, ['pub_1']);
    assert.ok(row);
    assert.equal(row!.status, 'dry_run');
    assert.equal(row!.product_id, 'prd-1');
  });

  test('upsertSchedule updates the same row (by id) rather than duplicating on repeated calls', async () => {
    const base = { id: 'pub_2', productId: 'prd-1', platform: 'x' as const, createdAt: nowIso(), updatedAt: nowIso() };
    await store.upsertSchedule({ ...base, status: 'scheduled' as const } as never);
    await store.upsertSchedule({ ...base, status: 'published' as const, permalink: 'https://x.com/1' } as never);

    const rows = db.all<Record<string, unknown>>(`SELECT * FROM sheet_schedule WHERE id = ?`, ['pub_2']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'published');
    assert.equal(rows[0]!.permalink, 'https://x.com/1');
  });
});
