/**
 * v1.1 admin/ops coverage: SystemService (health/system/metrics),
 * BackupService (create/list/read), SetupService (status/complete).
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/infrastructure/db/database.ts';
import { LocalSheetStore } from '../src/infrastructure/sheets/local-sheet-store.ts';
import { LocalStorage } from '../src/infrastructure/storage/local-storage.ts';
import { AnalyticsRepository, JobRepository, PublicationRepository, SettingsRepository } from '../src/infrastructure/db/repositories.ts';
import { AnalyticsService } from '../src/application/analytics-service.ts';
import { SystemService } from '../src/application/system-service.ts';
import { BackupService } from '../src/application/backup-service.ts';
import { SetupService } from '../src/application/setup-service.ts';
import { SourceRegistry } from '../src/infrastructure/sources/registry.ts';
import { PublisherRegistry } from '../src/infrastructure/publishers/registry.ts';
import { TemplateCopyGenerator } from '../src/infrastructure/ai/template-generator.ts';
import { loadConfig } from '../src/config/index.ts';

let system: SystemService;
let backup: BackupService;
let setup: SetupService;
let settings: SettingsRepository;

before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'asc-admin-'));
  const db = new Db(':memory:');
  db.migrate();
  const config = loadConfig();
  config.db.sqlitePath = join(tmp, 'app.db');
  config.storage.localDir = join(tmp, 'output');

  const storage = new LocalStorage({ baseDir: config.storage.localDir });
  const sheet = new LocalSheetStore(db);
  await sheet.init();
  settings = new SettingsRepository(db);
  const analytics = new AnalyticsService(new AnalyticsRepository(db), new JobRepository(db), new PublicationRepository(db), sheet);

  system = new SystemService({ db, config, storage, sheet, analytics, ffmpegPath: 'ffmpeg' });
  backup = new BackupService(db, config);
  setup = new SetupService({ settings, sheet, config, sources: new SourceRegistry(), publishers: new PublisherRegistry(), copyGenerator: new TemplateCopyGenerator() });
});

describe('SystemService', () => {
  test('health reports critical dependency checks and readiness', async () => {
    const h = await system.health();
    const names = h.checks.map((c) => c.name);
    assert.ok(names.includes('database') && names.includes('storage') && names.includes('ffmpeg') && names.includes('sheet'));
    assert.equal(typeof h.ready, 'boolean');
    assert.ok(h.checks.find((c) => c.name === 'database')!.ok, 'database check should pass');
  });

  test('system() returns version + memory + config', () => {
    const s = system.system();
    assert.equal(typeof s.version, 'string');
    assert.ok(s.memory.rssMb > 0);
    assert.ok(s.uptimeSec >= 0);
    assert.ok(['local', 'gdrive'].includes(s.config.storage));
  });

  test('metrics() emits Prometheus exposition', () => {
    const m = system.metrics();
    assert.match(m, /ascagent_uptime_seconds/);
    assert.match(m, /ascagent_products_processed_total/);
    assert.match(m, /# TYPE ascagent_queue_size gauge/);
  });
});

describe('BackupService', () => {
  test('creates a gzip backup and lists it', async () => {
    const info = await backup.createBackup();
    assert.ok(info.bytes > 0);
    assert.match(info.name, /^backup-.*\.tgz$/);
    const list = backup.list();
    assert.ok(list.some((b) => b.name === info.name));
    const buf = backup.read(info.name);
    assert.equal(buf[0], 0x1f); // gzip magic
    assert.equal(buf[1], 0x8b);
  });

  test('rejects unsafe backup names', () => {
    assert.throws(() => backup.read('../../etc/passwd'));
  });
});

describe('SetupService', () => {
  test('status lists steps and completion is persisted', async () => {
    const before = await setup.status();
    assert.ok(before.steps.length >= 5);
    assert.equal(before.complete, false);
    setup.markComplete();
    const after = await setup.status();
    assert.equal(after.complete, true);
  });

  test('ai test passes for the template provider', async () => {
    const r = await setup.testAi();
    assert.equal(r.ok, true);
  });
});
