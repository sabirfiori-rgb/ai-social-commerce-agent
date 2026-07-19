/**
 * SQLite connection wrapper built on the Node.js built-in `node:sqlite` module
 * (no native compilation, no external dependency). Provides migrations, a
 * transaction helper, and typed prepared-statement access.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL } from './schema.ts';
import { logger } from '../../shared/logger.ts';

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
  }

  migrate(): void {
    this.raw.exec(SCHEMA_SQL);
    logger.debug('database migrated', { path: this.path });
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.raw.prepare(sql);
    const res = stmt.run(...(params as never[]));
    return { changes: Number(res.changes), lastInsertRowid: res.lastInsertRowid };
  }

  get<T = Row>(sql: string, params: unknown[] = []): T | null {
    const stmt = this.raw.prepare(sql);
    return (stmt.get(...(params as never[])) as T) ?? null;
  }

  all<T = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.raw.prepare(sql);
    return stmt.all(...(params as never[])) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run `fn` inside a transaction; rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

let instance: Db | null = null;
export function getDb(path: string): Db {
  if (!instance) {
    instance = new Db(path);
    instance.migrate();
  }
  return instance;
}

export function boolToInt(b: boolean): number {
  return b ? 1 : 0;
}
export function intToBool(n: unknown): boolean {
  return Number(n) === 1;
}
export function json<T>(value: T): string {
  return JSON.stringify(value ?? null);
}
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
