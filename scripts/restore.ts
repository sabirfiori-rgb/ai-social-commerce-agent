/**
 * Restore from a backup .tgz produced by scripts/backup.ts (or the admin panel).
 * DESTRUCTIVE: replaces data/app.db and data/output. Stop the worker/app first
 * (e.g. `docker compose stop` or Ctrl-C the process) so the DB isn't in use.
 *
 * Usage:
 *   node scripts/restore.ts /path/to/backup-XXXX.tgz --yes
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { logger } from '../src/shared/logger.ts';

function tarExtract(file: string, dest: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('tar', ['-xzf', file, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`tar exited ${code}: ${err}`))));
  });
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const yes = args.includes('--yes');
  if (!file) {
    console.error('Usage: node scripts/restore.ts /path/to/backup.tgz --yes');
    process.exit(2);
  }
  const abs = resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    console.error(`Backup file not found: ${abs}`);
    process.exit(2);
  }

  const config = loadConfig();
  const dataRoot = resolve(process.cwd(), dirname(config.db.sqlitePath));

  console.log(`This will OVERWRITE ${dataRoot}/app.db and ${dataRoot}/output from:\n  ${abs}\n`);
  console.log('Make sure the app/worker is stopped before continuing.\n');
  if (!yes && !(await confirm('Proceed with restore? [y/N] '))) {
    console.error('Aborted (pass --yes to skip this prompt in non-interactive shells).');
    process.exit(1);
  }

  await tarExtract(abs, dataRoot);
  logger.info('restore complete', { dataRoot, from: abs });
  console.log('\nRestore complete. Start the app again (e.g. `docker compose up -d` or `node src/main.ts`).');
}

main().catch((e) => {
  logger.error('restore failed', { error: (e as Error).message });
  process.exit(1);
});
