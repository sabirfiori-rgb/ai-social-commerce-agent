import { Pool } from 'pg';
import { logger } from '../../shared/logger.ts';
import { SCHEMA_SQL } from './schema.ts';

/**
 * Minimal Postgres-backed DB adapter that mirrors the SQLite Db API used in
 * the codebase. It's intentionally small and synchronous-looking via await
 * because the rest of the code expects run/get/all/tx/close helpers.
 *
 * This file is a scaffold to be extended: SQL types and slightly different
 * DDL (SERIAL vs TEXT primary keys, TIMESTAMP types) may be adjusted as
 * needed. Migrations use the same SCHEMA_SQL but Postgres-compatible DDL may
 * be substituted in a later PR.
 */

export type Row = Record<string, unknown>;

export class PgDb {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    // For now run the same SCHEMA_SQL; some minor syntax differences are
    // tolerated by Postgres for the subset used. In future replace with
    // Postgres-specific migration SQL files.
    await this.pool.query(SCHEMA_SQL);
    logger.debug('postgres database migrated');
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const res = await this.pool.query(sql, params as any[]);
    return { changes: (res.rowCount ?? 0), lastInsertRowid: (res.rows[0]?.id ?? 0) };
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const res = await this.pool.query(sql, params as any[]);
    return (res.rows[0] as T) ?? null;
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params as any[]);
    return res.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
