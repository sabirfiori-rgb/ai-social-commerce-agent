/**
 * Backup service — creates consistent, restorable backups of the SQLite database
 * (via `VACUUM INTO`, safe while the app is running) plus the generated-asset
 * directory, packaged as a single .tgz. Restore is performed by scripts/restore.ts
 * (destructive; run with the worker stopped).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppConfig } from '../config/index.ts';
import type { Db } from '../infrastructure/db/database.ts';
import { AppError, NotFoundError, ValidationError } from '../shared/errors.ts';
import { createLogger } from '../shared/logger.ts';

const log = createLogger({ mod: 'backup' });

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

function tar(args: string[]): Promise<void> {
  return new Promise((resolveTar, reject) => {
    const p = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => reject(new AppError(`tar failed to spawn: ${e.message}`, { code: 'BACKUP_TAR' })));
    p.on('close', (code) => (code === 0 ? resolveTar() : reject(new AppError(`tar exited ${code}: ${err.slice(-500)}`, { code: 'BACKUP_TAR' }))));
  });
}

export class BackupService {
  private db: Db;
  private dataRoot: string;
  private outputDir: string;
  private backupsDir: string;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.dataRoot = resolve(process.cwd(), dirname(config.db.sqlitePath));
    this.outputDir = resolve(process.cwd(), config.storage.localDir);
    this.backupsDir = join(this.dataRoot, 'backups');
  }

  private safeName(name: string): string {
    if (!/^backup-[\w.\-:]+\.tgz$/.test(name)) throw new ValidationError('invalid backup name');
    return name;
  }

  async createBackup(): Promise<BackupInfo> {
    mkdirSync(this.backupsDir, { recursive: true });
    if (!existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const stageDir = join(this.backupsDir, `.stage-${ts}`);
    mkdirSync(stageDir, { recursive: true });
    const snapshot = join(stageDir, 'app.db');

    // Consistent DB snapshot even under WAL / concurrent writes.
    this.db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);

    const archiveName = `backup-${ts}.tgz`;
    const archivePath = join(this.backupsDir, archiveName);
    // Archive contains top-level: app.db + output/
    await tar([
      '-czf',
      archivePath,
      '-C',
      stageDir,
      'app.db',
      '-C',
      dirname(this.outputDir),
      basename(this.outputDir),
    ]);
    rmSync(stageDir, { recursive: true, force: true });

    const bytes = statSync(archivePath).size;
    log.info('backup created', { archiveName, bytes });
    return { name: archiveName, bytes, createdAt: new Date().toISOString() };
  }

  list(): BackupInfo[] {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => {
        const st = statSync(join(this.backupsDir, f));
        return { name: f, bytes: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  read(name: string): Buffer {
    const safe = this.safeName(name);
    const path = join(this.backupsDir, safe);
    if (!existsSync(path)) throw new NotFoundError('backup not found', { name });
    return readFileSync(path);
  }

  prune(keep = 10): number {
    const all = this.list();
    let removed = 0;
    for (const b of all.slice(keep)) {
      rmSync(join(this.backupsDir, b.name), { force: true });
      removed++;
    }
    return removed;
  }
}
