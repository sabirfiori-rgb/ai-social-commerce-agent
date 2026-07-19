/**
 * Scheduling policy: computes when a product should be published from the row's
 * Schedule Date/Time, falling back to configured posting-time slots.
 */
import { localWallClockToIso, nextSlot } from '../shared/clock.ts';
import type { ProductRow } from '../domain/sheet-schema.ts';

export class SchedulerService {
  private postingTimes: string[];
  private timezone: string;

  constructor(postingTimes: string[], timezone: string) {
    this.postingTimes = postingTimes;
    this.timezone = timezone;
  }

  /**
   * Returns an ISO timestamp for the intended publish time, or null to publish
   * immediately (no schedule specified).
   */
  computeScheduledAt(row: ProductRow, from = new Date()): string | null {
    const date = (row.scheduleDate || '').trim();
    const time = (row.scheduleTime || '').trim();
    if (date && time) return localWallClockToIso(date, time, this.timezone);
    if (date && this.postingTimes[0]) return localWallClockToIso(date, this.postingTimes[0], this.timezone);
    if (!date && time) {
      // time-only → today (or next day if already past) at that time
      return nextSlot([time], from, this.timezone);
    }
    return null;
  }

  isDue(scheduledAtIso: string | null, now = new Date()): boolean {
    if (!scheduledAtIso) return true;
    return new Date(scheduledAtIso).getTime() <= now.getTime() + 30_000;
  }

  nextPostingSlot(from = new Date()): string {
    return nextSlot(this.postingTimes, from, this.timezone);
  }
}
