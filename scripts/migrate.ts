/**
 * Apply the SQLite schema migration. The database migrates automatically on
 * first use, so this is mainly for CI/provisioning and to verify DB access.
 *
 * Usage: node scripts/migrate.ts
 */
import { getDb } from '../src/infrastructure/db/database.ts';
import { loadConfig } from '../src/config/index.ts';
import { logger } from '../src/shared/logger.ts';

const config = loadConfig();
const db = getDb(config.db.sqlitePath); // constructor runs migrate()
db.migrate();
logger.info('database migrated', { path: config.db.sqlitePath });
db.close();
