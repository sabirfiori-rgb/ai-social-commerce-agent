/**
 * Admin / ops API surface: health, readiness, system info, Prometheus metrics,
 * setup wizard, backups, update check, and worker controls.
 *
 *   GET  /api/health            rich health report (200 ready / 503 not-ready)
 *   GET  /api/health/live       liveness (always 200 if process is up)
 *   GET  /api/health/ready      readiness (503 if a critical dependency is down)
 *   GET  /api/system            uptime, memory, disk, versions, config
 *   GET  /api/metrics           Prometheus text exposition
 *   GET  /api/setup/status      setup-wizard state
 *   POST /api/setup/complete    mark setup complete
 *   POST /api/setup/dismiss     dismiss the wizard
 *   POST /api/setup/test        { target: 'sheet'|'ai'|'publisher', platform? }
 *   GET  /api/admin/backups     list backups
 *   POST /api/admin/backups     create a backup
 *   GET  /api/admin/backups/:name/download
 *   POST /api/admin/backups/prune
 *   GET  /api/admin/update/check
 *   POST /api/admin/requeue-stale
 */
import type { ServerResponse } from 'node:http';
import type { Container } from '../../boot/container.ts';
import type { Router } from '../http/router.ts';
import { httpJson } from '../../shared/http.ts';
import { ValidationError } from '../../shared/errors.ts';
import { appVersion } from '../../version.ts';

function send(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function registerAdminRoutes(router: Router, container: Container): void {
  const { services, repos, config } = container;
  const system = services.system;

  // ---- Authentication (public: status + login) ----
  router.get('/api/auth/status', () => ({ authEnabled: container.auth.enabled }));
  router.post('/api/auth/login', ({ body, res }) => {
    if (!container.auth.enabled) return { ok: true, authEnabled: false };
    const token = (body as { token?: string } | undefined)?.token ?? '';
    if (container.auth.validate(token)) return { ok: true };
    send(res, 401, { ok: false, error: 'invalid token' });
    return undefined;
  });

  router.get('/api/health', async ({ res }) => {
    const report = await system.health();
    send(res, report.ready ? 200 : 503, report);
  });
  router.get('/api/health/live', ({ res }) => send(res, 200, { status: 'alive', version: appVersion() }));
  router.get('/api/health/ready', async ({ res }) => {
    const report = await system.health();
    send(res, report.ready ? 200 : 503, { ready: report.ready, checks: report.checks });
  });

  router.get('/api/system', () => system.system());

  router.get('/api/metrics', ({ res }) => {
    const text = system.metrics();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(text);
  });

  // ---- Setup wizard ----
  router.get('/api/setup/status', () => services.setup.status());
  router.post('/api/setup/complete', () => {
    services.setup.markComplete();
    return { ok: true };
  });
  router.post('/api/setup/dismiss', () => {
    services.setup.dismiss();
    return { ok: true };
  });
  router.post('/api/setup/test', async ({ body }) => {
    const b = (body ?? {}) as { target?: string; platform?: string };
    if (b.target === 'sheet') return services.setup.testSheet();
    if (b.target === 'ai') return services.setup.testAi();
    if (b.target === 'publisher') {
      if (!b.platform) throw new ValidationError('platform is required for publisher test');
      return services.setup.testPublisher(b.platform);
    }
    throw new ValidationError('target must be one of sheet | ai | publisher');
  });

  // ---- Backups ----
  router.get('/api/admin/backups', () => ({ backups: services.backup.list() }));
  router.post('/api/admin/backups', async () => {
    const info = await services.backup.createBackup();
    return { ...info, downloadUrl: `/api/admin/backups/${encodeURIComponent(info.name)}/download` };
  });
  router.get('/api/admin/backups/:name/download', ({ params, res }) => {
    const buf = services.backup.read(params.name!);
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${params.name}"`,
      'content-length': String(buf.length),
    });
    res.end(buf);
  });
  router.post('/api/admin/backups/prune', ({ body }) => {
    const keep = Number((body as { keep?: number })?.keep ?? 10);
    return { removed: services.backup.prune(keep) };
  });

  // ---- Update check ----
  router.get('/api/admin/update/check', async () => {
    const manifestUrl = process.env.UPDATE_MANIFEST_URL ?? '';
    const current = appVersion();
    if (!manifestUrl) {
      return {
        current,
        updateAvailable: false,
        mode: 'managed',
        message: 'Updates are applied via Docker (compose pull/build or Watchtower) or scripts/update.sh. Set UPDATE_MANIFEST_URL to enable in-app version checks.',
      };
    }
    try {
      const manifest = await httpJson<{ version: string; url?: string; notes?: string }>(manifestUrl, { provider: 'update-manifest', timeoutMs: 10_000 });
      return {
        current,
        latest: manifest.version,
        updateAvailable: manifest.version !== current,
        url: manifest.url,
        notes: manifest.notes,
        mode: 'manifest',
      };
    } catch (e) {
      return { current, updateAvailable: false, mode: 'manifest', error: (e as Error).message };
    }
  });

  // ---- Worker controls ----
  router.post('/api/admin/requeue-stale', () => {
    const n = repos.jobs.requeueStale(config.automation.jobLockTtlMs);
    return { requeued: n };
  });
}
