/**
 * Analytics service — records pipeline events and computes the dashboard KPIs
 * (products processed, posts published, videos created, queue size, failures,
 * success rate, average processing time). Also writes daily snapshots to sheet.
 */
import type { AnalyticsSnapshot } from '../domain/entities.ts';
import type { AnalyticsEventInput, IAnalyticsRepository, IJobRepository, IPublicationRepository, ISheetStore } from '../domain/ports.ts';
import { nowIso } from '../shared/clock.ts';

export interface DashboardStats {
  productsProcessed: number;
  postsPublished: number;
  videosCreated: number;
  failedJobs: number;
  successRate: number;
  avgProcessingMs: number;
  queue: { queued: number; running: number; succeeded: number; failed: number; dead: number };
  queueSize: number;
  publications: Record<string, number>;
}

export class AnalyticsService {
  private analytics: IAnalyticsRepository;
  private jobs: IJobRepository;
  private pubs: IPublicationRepository;
  private sheet: ISheetStore;

  constructor(analytics: IAnalyticsRepository, jobs: IJobRepository, pubs: IPublicationRepository, sheet: ISheetStore) {
    this.analytics = analytics;
    this.jobs = jobs;
    this.pubs = pubs;
    this.sheet = sheet;
  }

  record(event: AnalyticsEventInput): void {
    this.analytics.record(event);
  }

  dashboard(): DashboardStats {
    const base = this.analytics.dashboard();
    const jobCounts = this.jobs.countByStatus();
    return {
      ...base,
      queue: {
        queued: jobCounts.QUEUED ?? 0,
        running: jobCounts.RUNNING ?? 0,
        succeeded: jobCounts.SUCCEEDED ?? 0,
        failed: jobCounts.FAILED ?? 0,
        dead: jobCounts.DEAD ?? 0,
      },
      queueSize: (jobCounts.QUEUED ?? 0) + (jobCounts.RUNNING ?? 0),
      publications: this.pubs.countByStatus(),
    };
  }

  async writeDailySnapshot(): Promise<AnalyticsSnapshot> {
    const jobCounts = this.jobs.countByStatus();
    const queueSize = (jobCounts.QUEUED ?? 0) + (jobCounts.RUNNING ?? 0);
    const snap = this.analytics.snapshot(nowIso(), queueSize);
    try {
      await this.sheet.writeAnalytics(snap);
    } catch {
      /* sheet analytics write is best-effort */
    }
    return snap;
  }
}
