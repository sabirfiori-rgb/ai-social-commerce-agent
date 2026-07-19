/**
 * System service — health checks, system info, and Prometheus metrics.
 * Powers the admin panel's monitoring view and the /api/health,
 * /api/system, /api/metrics endpoints.
 */
import { statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../config/index.ts';
import type { Db } from '../infrastructure/db/database.ts';
import type { ISheetStore, IStorage } from '../domain/ports.ts';
import { checkFfmpeg } from '../infrastructure/video/ffmpeg.ts';
import { nowIso } from '../shared/clock.ts';
import { appVersion } from '../version.ts';
import type { AnalyticsService } from './analytics-service.ts';

export interface HealthCheck {
  name: string;
  ok: boolean;
  critical: boolean;
  detail?: string;
}
export interface HealthReport {
  status: 'ok' | 'degraded';
  ready: boolean;
  version: string;
  uptimeSec: number;
  timestamp: string;
  checks: HealthCheck[];
}

export interface SystemInfo {
  version: string;
  node: string;
  platform: string;
  arch: string;
  pid: number;
  uptimeSec: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  data: { dir: string; freeMb: number | null; totalMb: number | null };
  config: { sheet: string; storage: string; aiProvider: string; dryRun: boolean; pollIntervalMinutes: number; concurrency: number };
}

export interface SystemDeps {
  db: Db;
  config: AppConfig;
  storage: IStorage;
  sheet: ISheetStore;
  analytics: AnalyticsService;
  ffmpegPath: string;
}

export class SystemService {
  private d: SystemDeps;
  private startedAtMs = Date.now();
  private ffmpegOk: boolean | null = null;

  constructor(deps: SystemDeps) {
    this.d = deps;
  }

  uptimeSec(): number {
    return Math.round((Date.now() - this.startedAtMs) / 1000);
  }

  private checkDb(): HealthCheck {
    try {
      this.d.db.get('SELECT 1 AS ok');
      this.d.db.run(`INSERT INTO settings (key,value) VALUES ('_healthcheck', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [nowIso()]);
      return { name: 'database', ok: true, critical: true };
    } catch (e) {
      return { name: 'database', ok: false, critical: true, detail: (e as Error).message };
    }
  }

  private async checkStorage(): Promise<HealthCheck> {
    try {
      const key = `.health/probe-${Date.now()}.txt`;
      await this.d.storage.put(key, Buffer.from('ok'), 'text/plain');
      return { name: 'storage', ok: true, critical: true, detail: this.d.storage.kind };
    } catch (e) {
      return { name: 'storage', ok: false, critical: true, detail: (e as Error).message };
    }
  }

  private async checkFfmpeg(): Promise<HealthCheck> {
    if (this.ffmpegOk === null) this.ffmpegOk = await checkFfmpeg(this.d.ffmpegPath);
    return { name: 'ffmpeg', ok: this.ffmpegOk, critical: true, detail: this.ffmpegOk ? 'available' : 'not found on PATH' };
  }

  private checkSheet(): HealthCheck {
    // Report the configured mode; a deep round-trip is avoided to keep health fast.
    return { name: 'sheet', ok: true, critical: false, detail: `${this.d.sheet.kind} store` };
  }

  async health(): Promise<HealthReport> {
    const checks = [this.checkDb(), await this.checkStorage(), await this.checkFfmpeg(), this.checkSheet()];
    const criticalFail = checks.some((c) => c.critical && !c.ok);
    const anyFail = checks.some((c) => !c.ok);
    return {
      status: anyFail ? 'degraded' : 'ok',
      ready: !criticalFail,
      version: appVersion(),
      uptimeSec: this.uptimeSec(),
      timestamp: nowIso(),
      checks,
    };
  }

  system(): SystemInfo {
    const mem = process.memoryUsage();
    const dataDir = resolve(process.cwd(), this.d.config.storage.localDir);
    let freeMb: number | null = null;
    let totalMb: number | null = null;
    try {
      const s = statfsSync(dataDir);
      freeMb = Math.round((Number(s.bavail) * Number(s.bsize)) / 1_048_576);
      totalMb = Math.round((Number(s.blocks) * Number(s.bsize)) / 1_048_576);
    } catch {
      /* statfs unavailable */
    }
    return {
      version: appVersion(),
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: this.uptimeSec(),
      memory: {
        rssMb: Math.round(mem.rss / 1_048_576),
        heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
        heapTotalMb: Math.round(mem.heapTotal / 1_048_576),
      },
      data: { dir: dataDir, freeMb, totalMb },
      config: {
        sheet: this.d.sheet.kind,
        storage: this.d.storage.kind,
        aiProvider: this.d.config.ai.provider,
        dryRun: this.d.config.publishing.dryRun,
        pollIntervalMinutes: this.d.config.automation.pollIntervalMinutes,
        concurrency: this.d.config.automation.concurrency,
      },
    };
  }

  /** Prometheus text exposition format. */
  metrics(): string {
    const dash = this.d.analytics.dashboard();
    const mem = process.memoryUsage();
    const lines: string[] = [];
    const m = (name: string, help: string, type: string, value: number, labels = '') => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labels} ${value}`);
    };
    m('ascagent_uptime_seconds', 'Process uptime in seconds', 'gauge', this.uptimeSec());
    m('ascagent_products_processed_total', 'Products successfully processed', 'counter', dash.productsProcessed);
    m('ascagent_posts_published_total', 'Posts published (live)', 'counter', dash.postsPublished);
    m('ascagent_videos_created_total', 'Promo videos created', 'counter', dash.videosCreated);
    m('ascagent_failed_total', 'Failed pipeline runs', 'counter', dash.failedJobs);
    m('ascagent_success_rate', 'Pipeline success rate (0..1)', 'gauge', Number(dash.successRate.toFixed(4)));
    m('ascagent_avg_processing_ms', 'Average pipeline duration (ms)', 'gauge', dash.avgProcessingMs);
    m('ascagent_queue_size', 'Queued + running jobs', 'gauge', dash.queueSize);
    for (const [status, n] of Object.entries(dash.queue)) {
      lines.push(`ascagent_jobs{status="${status}"} ${n}`);
    }
    m('ascagent_memory_rss_bytes', 'Resident set size', 'gauge', mem.rss);
    return lines.join('\n') + '\n';
  }
}
