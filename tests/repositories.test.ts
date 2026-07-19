/**
 * Unit tests for src/infrastructure/db/repositories.ts against a fresh
 * in-memory SQLite database per test (fast, hermetic, no filesystem I/O).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../src/infrastructure/db/database.ts';
import {
  JobRepository,
  DedupeRepository,
  AnalyticsRepository,
  PublicationRepository,
  ContentRepository,
} from '../src/infrastructure/db/repositories.ts';
import { nowIso } from '../src/shared/clock.ts';

let db: Db;

beforeEach(() => {
  db = new Db(':memory:');
  db.migrate();
});

afterEach(() => {
  db.close();
});

/* ------------------------------- Jobs ----------------------------------- */

describe('JobRepository', () => {
  test('enqueue defaults status=QUEUED, attempts=0, maxAttempts=3', () => {
    const repo = new JobRepository(db);
    const job = repo.enqueue({ type: 'process_product', productRowId: 'row-1' });
    assert.equal(job.status, 'QUEUED');
    assert.equal(job.attempts, 0);
    assert.equal(job.maxAttempts, 3);
    assert.ok(job.id.length > 0);

    const fetched = repo.byId(job.id);
    assert.ok(fetched);
    assert.equal(fetched!.productRowId, 'row-1');
  });

  test('claimNext atomically claims the oldest available QUEUED job and a second claim returns null', () => {
    const repo = new JobRepository(db);
    const job = repo.enqueue({ type: 'process_product', productRowId: 'row-1' });

    const claimed = repo.claimNext('worker-a', 60_000);
    assert.ok(claimed);
    assert.equal(claimed!.id, job.id);
    assert.equal(claimed!.status, 'RUNNING');
    assert.equal(claimed!.attempts, 1);

    // Second claim attempt (simulating a racing worker) must not double-claim.
    const secondClaim = repo.claimNext('worker-b', 60_000);
    assert.equal(secondClaim, null);
  });

  test('claimNext ignores jobs whose available_at is in the future', () => {
    const repo = new JobRepository(db);
    const future = new Date(Date.now() + 60_000).toISOString();
    repo.enqueue({ type: 'process_product', productRowId: 'row-1', availableAt: future });
    const claimed = repo.claimNext('worker-a', 60_000);
    assert.equal(claimed, null);
  });

  test('markSucceeded sets status to SUCCEEDED', () => {
    const repo = new JobRepository(db);
    const job = repo.enqueue({ type: 'process_product', productRowId: 'row-1' });
    repo.claimNext('worker-a', 60_000);
    repo.markSucceeded(job.id);
    assert.equal(repo.byId(job.id)!.status, 'SUCCEEDED');
  });

  test('markFailed requeues to QUEUED with a future availableAt', () => {
    const repo = new JobRepository(db);
    const job = repo.enqueue({ type: 'process_product', productRowId: 'row-1' });
    repo.claimNext('worker-a', 60_000);

    const before = Date.now();
    repo.markFailed(job.id, 'boom', 30_000);
    const after = repo.byId(job.id)!;
    assert.equal(after.status, 'QUEUED');
    assert.equal(after.lastError, 'boom');
    assert.ok(new Date(after.availableAt).getTime() >= before + 29_000);
  });

  test('requeueStale recovers RUNNING jobs whose lock has expired', () => {
    const repo = new JobRepository(db);
    const job = repo.enqueue({ type: 'process_product', productRowId: 'row-1' });
    repo.claimNext('worker-a', 60_000);

    // Force locked_at into the past so it looks stale relative to a short ttl.
    db.run(`UPDATE jobs SET locked_at = ? WHERE id = ?`, [new Date(Date.now() - 120_000).toISOString(), job.id]);

    const changed = repo.requeueStale(60_000);
    assert.equal(changed, 1);
    assert.equal(repo.byId(job.id)!.status, 'QUEUED');
  });

  test('requeueStale leaves fresh RUNNING jobs untouched', () => {
    const repo = new JobRepository(db);
    repo.enqueue({ type: 'process_product', productRowId: 'row-1' });
    repo.claimNext('worker-a', 60_000);
    const changed = repo.requeueStale(60_000);
    assert.equal(changed, 0);
  });

  test('countByStatus always includes all five statuses, defaulted to 0', () => {
    const repo = new JobRepository(db);
    repo.enqueue({ type: 'process_product', productRowId: 'row-1' });
    const counts = repo.countByStatus();
    assert.deepEqual(Object.keys(counts).sort(), ['DEAD', 'FAILED', 'QUEUED', 'RUNNING', 'SUCCEEDED'].sort());
    assert.equal(counts.QUEUED, 1);
    assert.equal(counts.RUNNING, 0);
  });
});

/* ------------------------------ Dedupe ----------------------------------- */

describe('DedupeRepository', () => {
  test('seen() is false until mark() is called, then true', () => {
    const repo = new DedupeRepository(db);
    assert.equal(repo.seen('abc123'), false);
    repo.mark('abc123', 'prd-1');
    assert.equal(repo.seen('abc123'), true);
  });

  test('mark() is idempotent (ON CONFLICT DO NOTHING, no throw on duplicate)', () => {
    const repo = new DedupeRepository(db);
    repo.mark('key-1', 'prd-1');
    assert.doesNotThrow(() => repo.mark('key-1', 'prd-2'));
    assert.equal(repo.seen('key-1'), true);
  });
});

/* ---------------------------- Analytics ----------------------------------- */

describe('AnalyticsRepository', () => {
  test('record() inserts an event and dashboard() reflects it', () => {
    const repo = new AnalyticsRepository(db);
    repo.record({ type: 'pipeline_completed', productId: 'prd-1', durationMs: 1000 });
    repo.record({ type: 'video_created', productId: 'prd-1' });
    repo.record({ type: 'post_published', productId: 'prd-1', platform: 'instagram' });

    const dash = repo.dashboard();
    assert.equal(dash.productsProcessed, 1);
    assert.equal(dash.postsPublished, 1);
    assert.equal(dash.videosCreated, 1);
    assert.equal(dash.failedJobs, 0);
    assert.equal(dash.successRate, 1);
    assert.equal(dash.avgProcessingMs, 1000);
  });

  test('dashboard() successRate math: completed/(completed+failed)', () => {
    const repo = new AnalyticsRepository(db);
    repo.record({ type: 'pipeline_completed', productId: 'p1' });
    repo.record({ type: 'pipeline_completed', productId: 'p2' });
    repo.record({ type: 'pipeline_completed', productId: 'p3' });
    repo.record({ type: 'pipeline_failed', productId: 'p4' });

    const dash = repo.dashboard();
    assert.equal(dash.productsProcessed, 3);
    assert.equal(dash.failedJobs, 1);
    assert.equal(dash.successRate, 0.75);
  });

  test('dashboard() successRate is 0 when there is no activity at all', () => {
    const repo = new AnalyticsRepository(db);
    const dash = repo.dashboard();
    assert.equal(dash.successRate, 0);
    assert.equal(dash.avgProcessingMs, 0);
  });

  test('snapshot() scopes counts to the given date prefix', () => {
    const repo = new AnalyticsRepository(db);
    repo.record({ type: 'pipeline_completed', productId: 'p1', durationMs: 500 });
    const today = nowIso();
    const snap = repo.snapshot(today, 7);
    assert.equal(snap.date, today.slice(0, 10));
    assert.equal(snap.productsProcessed, 1);
    assert.equal(snap.queueSize, 7);
  });
});

/* --------------------------- Publications --------------------------------- */

describe('PublicationRepository', () => {
  function makePub(overrides: Partial<Record<string, unknown>> = {}) {
    const ts = nowIso();
    return {
      id: `pub_${Math.random().toString(36).slice(2)}`,
      productId: 'prd-1',
      platform: 'instagram' as const,
      status: 'dry_run' as const,
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    };
  }

  test('save() persists and byProduct() retrieves it', () => {
    const repo = new PublicationRepository(db);
    const pub = makePub();
    repo.save(pub as never);
    const rows = repo.byProduct('prd-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, pub.id);
    assert.equal(rows[0]!.status, 'dry_run');
  });

  test('update() patches only the provided fields', () => {
    const repo = new PublicationRepository(db);
    const pub = makePub();
    repo.save(pub as never);
    repo.update(pub.id, { status: 'published', permalink: 'https://instagram.com/p/xyz' });
    const [row] = repo.byProduct('prd-1');
    assert.equal(row!.status, 'published');
    assert.equal(row!.permalink, 'https://instagram.com/p/xyz');
  });

  test('countByStatus() only includes statuses that actually occurred', () => {
    const repo = new PublicationRepository(db);
    repo.save(makePub({ platform: 'instagram', status: 'dry_run' }) as never);
    repo.save(makePub({ platform: 'facebook', status: 'dry_run' }) as never);
    repo.save(makePub({ platform: 'x', status: 'published' }) as never);

    const counts = repo.countByStatus();
    assert.equal(counts.dry_run, 2);
    assert.equal(counts.published, 1);
    assert.equal(counts.failed, undefined);
  });
});

/* ----------------------------- Content ------------------------------------ */

describe('ContentRepository', () => {
  function makeContent(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: `content_${Math.random().toString(36).slice(2)}`,
      productId: 'prd-1',
      tone: 'friendly' as const,
      language: 'en',
      provider: 'template',
      captions: [{ platform: 'instagram', primary: 'Hello world', variations: ['a', 'b'] }],
      hooks: ['Hook 1'],
      ctas: ['Buy now'],
      hashtags: ['#deal'],
      seoKeywords: ['widget'],
      emojis: ['sparkles'],
      createdAt: nowIso(),
      ...overrides,
    };
  }

  test('save() then byProduct() round-trips full structured content (JSON columns)', () => {
    const repo = new ContentRepository(db);
    const content = makeContent();
    repo.save(content as never);
    const fetched = repo.byProduct('prd-1');
    assert.ok(fetched);
    assert.equal(fetched!.id, content.id);
    assert.deepEqual(fetched!.hooks, ['Hook 1']);
    assert.deepEqual(fetched!.captions, content.captions);
  });

  test('byProduct() returns the most recently created content for that product', async () => {
    const repo = new ContentRepository(db);
    const first = makeContent({ id: 'content_a', hooks: ['first'] });
    repo.save(first as never);
    // Ensure a distinguishable created_at ordering.
    await new Promise((r) => setTimeout(r, 5));
    const second = makeContent({ id: 'content_b', hooks: ['second'], createdAt: nowIso() });
    repo.save(second as never);

    const fetched = repo.byProduct('prd-1');
    assert.equal(fetched!.id, 'content_b');
  });

  test('byProduct() returns null when nothing exists for that product', () => {
    const repo = new ContentRepository(db);
    assert.equal(repo.byProduct('does-not-exist'), null);
  });
});
