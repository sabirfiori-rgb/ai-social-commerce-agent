/**
 * Run-once script — processes all currently-NEW product rows through the full
 * pipeline a single time (no long-running loop). Ideal for the live demo and CI.
 *
 * Usage: node scripts/run-once.ts
 */
import { buildContainer } from '../src/boot/container.ts';
import { logger } from '../src/shared/logger.ts';

async function main(): Promise<void> {
  const c = buildContainer();
  await c.init();

  const rows = await c.sheet.findClaimableRows(25);
  if (rows.length === 0) {
    logger.warn('No NEW rows to process. Run `node scripts/seed.ts` first, or add a product with Status=NEW.');
    c.close();
    return;
  }

  logger.info(`processing ${rows.length} NEW row(s)`, { dryRun: c.config.publishing.dryRun });
  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const claimed = await c.sheet.claimRow(row, 'run-once', c.config.automation.jobLockTtlMs);
    if (!claimed) continue;
    try {
      const res = await c.orchestrator.process(row);
      ok++;
      logger.info('✓ processed', {
        title: res.title,
        durationMs: res.durationMs,
        platforms: res.publications.map((p) => `${p.platform}:${p.status}`).join(', '),
      });
    } catch (e) {
      failed++;
      logger.error('✗ failed', { rowId: row.id, error: (e as Error).message });
    }
  }

  await c.services.analytics.writeDailySnapshot();
  logger.info('run-once complete', { ok, failed, dashboard: c.services.analytics.dashboard() });
  c.close();
}

main().catch((e) => {
  logger.error('run-once crashed', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
