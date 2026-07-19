/**
 * Worker — claims NEW sheet rows (race-free), enqueues jobs, and drains the
 * DB-backed job queue with bounded concurrency, retries with backoff, stale-lock
 * recovery, and a global rate limit.
 */
import os from 'node:os';
import type { Job } from '../domain/entities.ts';
import { PipelineOrchestrator } from '../application/pipeline.ts';
import type { Container } from '../boot/container.ts';
import { nowIso } from '../shared/clock.ts';
import { randomHex } from '../shared/crypto.ts';
import { createLogger } from '../shared/logger.ts';
import { RateLimiter } from '../shared/rate-limiter.ts';

const log = createLogger({ mod: 'worker' });

export class Worker {
  private c: Container;
  readonly workerId: string;
  private limiter: RateLimiter;

  constructor(c: Container) {
    this.c = c;
    this.workerId = `w-${os.hostname()}-${process.pid}-${randomHex(3)}`;
    this.limiter = new RateLimiter(c.config.automation.rateLimitPerMinute);
  }

  /** Scan the sheet for NEW rows, claim them atomically, and enqueue jobs. */
  async pollSheet(): Promise<number> {
    const rows = await this.c.sheet.findClaimableRows(50);
    let enqueued = 0;
    for (const row of rows) {
      const won = await this.c.sheet.claimRow(row, this.workerId, this.c.config.automation.jobLockTtlMs);
      if (!won) continue;
      this.c.repos.jobs.enqueue({
        type: 'process_product',
        productRowId: row.id,
        productId: row.id,
        maxAttempts: this.c.config.automation.retryMax,
        availableAt: nowIso(),
        payload: {},
      });
      enqueued++;
    }
    if (enqueued) log.info('claimed + enqueued products', { enqueued, workerId: this.workerId });
    return enqueued;
  }

  private backoffMs(attempt: number): number {
    const { retryMinDelayMs, retryMaxDelayMs } = this.c.config.automation;
    return Math.min(retryMaxDelayMs, retryMinDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
  }

  async processJob(job: Job): Promise<void> {
    const row = await this.c.sheet.getProduct(job.productRowId);
    if (!row) {
      this.c.repos.jobs.markDead(job.id, 'sheet row not found');
      return;
    }
    try {
      await this.limiter.acquire();
      await this.c.orchestrator.process(row, job.id);
      this.c.repos.jobs.markSucceeded(job.id);
    } catch (e) {
      const err = e as Error;
      const canRetry = PipelineOrchestrator.isRetryable(e) && job.attempts < job.maxAttempts;
      if (canRetry) {
        const delay = this.backoffMs(job.attempts);
        this.c.repos.jobs.markFailed(job.id, err.message, delay);
        log.warn('job failed; scheduled retry', { jobId: job.id, attempt: job.attempts, delayMs: delay, error: err.message });
      } else {
        this.c.repos.jobs.markDead(job.id, err.message);
        log.error('job dead (no more retries)', { jobId: job.id, attempts: job.attempts, error: err.message });
      }
    }
  }

  /** Claim and run up to `concurrency` jobs, resolving when the batch finishes. */
  async drainOnce(concurrency: number): Promise<number> {
    this.c.repos.jobs.requeueStale(this.c.config.automation.jobLockTtlMs);
    const inFlight: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      const job = this.c.repos.jobs.claimNext(this.workerId, this.c.config.automation.jobLockTtlMs);
      if (!job) break;
      inFlight.push(this.processJob(job));
    }
    await Promise.all(inFlight);
    return inFlight.length;
  }

  /** Drain the queue until empty (used by run-once and tests). */
  async drainToEmpty(concurrency: number, maxBatches = 1000): Promise<number> {
    let total = 0;
    for (let b = 0; b < maxBatches; b++) {
      const n = await this.drainOnce(concurrency);
      if (n === 0) break;
      total += n;
    }
    return total;
  }
}
