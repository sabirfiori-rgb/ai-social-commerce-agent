/**
 * Token-bucket rate limiter for outbound work (global API-call ceiling).
 */
import { sleep } from './clock.ts';

export class RateLimiter {
  private capacity: number;
  private tokens: number;
  private refillPerMs: number;
  private last: number;

  constructor(perMinute: number) {
    this.capacity = Math.max(1, perMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60_000;
    this.last = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }

  async acquire(n = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const need = n - this.tokens;
      const waitMs = Math.max(50, Math.min(5000, Math.ceil(need / this.refillPerMs)));
      await sleep(waitMs);
    }
  }
}
