/**
 * Create a backup (SQLite snapshot + generated assets) as a .tgz under
 * data/backups/. Safe to run while the app is live.
 *
 * Usage: node scripts/backup.ts
 */
import { buildContainer } from '../src/boot/container.ts';
import { logger } from '../src/shared/logger.ts';

async function main(): Promise<void> {
  const c = buildContainer();
  await c.init();
  const info = await c.services.backup.createBackup();
  logger.info('backup created', info);
  console.log(`\nBackup: data/backups/${info.name}  (${Math.round(info.bytes / 1024)} KB)`);
  c.close();
}

main().catch((e) => {
  logger.error('backup failed', { error: (e as Error).message });
  process.exit(1);
});
