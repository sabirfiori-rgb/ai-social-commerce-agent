/**
 * Run Postgres migrations.
 * Usage: node scripts/migrate-postgres.ts
 */
import { config } from '../src/config/index.ts';
import { PgDb } from '../src/infrastructure/db/postgres.ts';
import { logger } from '../src/shared/logger.ts';

async function main(): Promise<void> {
  const cfg = config();
  const url = cfg.db.url;
  if (!url) {
    logger.error('DATABASE_URL not set; set DATABASE_URL to point at your Postgres instance');
    process.exit(1);
  }

  const db = new PgDb(url);
  try {
    await db.migrate();
    logger.info('Postgres migrated');
  } catch (e) {
    logger.error('Postgres migrate failed', { error: (e as Error).message });
    process.exit(1);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  logger.error('migrate-postgres crashed', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
