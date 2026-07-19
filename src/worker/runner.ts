/**
 * WorkerRunner — the long-running loops:
 *  - every POLL_INTERVAL_MINUTES: scan the sheet + enqueue NEW rows
 *  - every few seconds: drain the job queue (bounded concurrency)
 * Overlapping drains are prevented with a re-entrancy guard.
 */
import type { Container } from '../boot/container.ts';
import { createLogger } from '../shared/logger.ts';
import { Worker } from './worker.ts';

const log = createLogger({ mod: 'runner' });

export class WorkerRunner {
  private c: Container;
  private worker: Worker;
  private pollTimer?: ReturnType<typeof setInterval>;
  private drainTimer?: ReturnType<typeof setInterval>;
  private snapshotTimer?: ReturnType<typeof setInterval>;
  private draining = false;
  private concurrency: number;

  constructor(c: Container) {
    this.c = c;
    this.worker = new Worker(c);
    this.concurrency = Math.max(1, c.config.automation.concurrency);
  }

  async start(): Promise<void> {
    const pollMs = Math.max(30_000, this.c.config.automation.pollIntervalMinutes * 60_000);
    log.info('worker runner starting', { workerId: this.worker.workerId, pollMs, concurrency: this.concurrency });

    const safePoll = () => this.worker.pollSheet().catch((e) => log.error('poll failed', { error: (e as Error).message }));
    const safeDrain = () => {
      if (this.draining) return;
      this.draining = true;
      this.worker
        .drainOnce(this.concurrency)
        .catch((e) => log.error('drain failed', { error: (e as Error).message }))
        .finally(() => {
          this.draining = false;
        });
    };

    // Kick off immediately, then on intervals.
    await safePoll();
    safeDrain();
    this.pollTimer = setInterval(safePoll, pollMs);
    this.drainTimer = setInterval(safeDrain, 2500);
    this.snapshotTimer = setInterval(
      () => this.c.services.analytics.writeDailySnapshot().catch(() => undefined),
      5 * 60_000,
    );
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    log.info('worker runner stopped');
  }
}
