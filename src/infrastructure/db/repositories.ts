/**
 * Concrete repository implementations backed by SQLite (node:sqlite).
 * Synchronous by design — node:sqlite is synchronous and the worker benefits
 * from deterministic, lock-free-in-process access.
 */
import type {
  AnalyticsSnapshot,
  GeneratedAsset,
  GeneratedContent,
  GeneratedVideo,
  Job,
  LogEntry,
  Publication,
  SocialAccount,
} from '../../domain/entities.ts';
import type {
  AnalyticsEventInput,
  IAccountRepository,
  IAnalyticsRepository,
  IAssetRepository,
  IContentRepository,
  IDedupeRepository,
  IJobRepository,
  ILogRepository,
  IPublicationRepository,
  ISettingsRepository,
  IVideoRepository,
  JobListOptions,
} from '../../domain/ports.ts';
import type { JobStatus, Platform } from '../../domain/enums.ts';
import { JobStatus as JS } from '../../domain/enums.ts';
import { nowIso } from '../../shared/clock.ts';
import { prefixedId } from '../../shared/ids.ts';
import { boolToInt, type Db, intToBool, json, parseJson, type Row } from './database.ts';

/* ------------------------------- Jobs ---------------------------------- */

function rowToJob(r: Row): Job {
  return {
    id: String(r.id),
    type: String(r.type),
    productRowId: String(r.product_row_id),
    productId: r.product_id ? String(r.product_id) : undefined,
    status: String(r.status) as JobStatus,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    lockedBy: r.locked_by ? String(r.locked_by) : undefined,
    lockedAt: r.locked_at ? String(r.locked_at) : undefined,
    availableAt: String(r.available_at),
    lastError: r.last_error ? String(r.last_error) : undefined,
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class JobRepository implements IJobRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  enqueue(
    input: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'attempts'> &
      Partial<Pick<Job, 'status' | 'attempts'>>,
  ): Job {
    const now = nowIso();
    const job: Job = {
      id: prefixedId('job'),
      type: input.type,
      productRowId: input.productRowId,
      productId: input.productId,
      status: input.status ?? JS.QUEUED,
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      availableAt: input.availableAt ?? now,
      payload: input.payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO jobs (id,type,product_row_id,product_id,status,attempts,max_attempts,available_at,payload,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        job.id,
        job.type,
        job.productRowId,
        job.productId ?? null,
        job.status,
        job.attempts,
        job.maxAttempts,
        job.availableAt,
        json(job.payload),
        job.createdAt,
        job.updatedAt,
      ],
    );
    return job;
  }

  claimNext(workerId: string, _ttlMs: number): Job | null {
    return this.db.tx(() => {
      const now = nowIso();
      const row = this.db.get<Row>(
        `SELECT * FROM jobs WHERE status = ? AND available_at <= ? ORDER BY available_at ASC, created_at ASC LIMIT 1`,
        [JS.QUEUED, now],
      );
      if (!row) return null;
      const res = this.db.run(
        `UPDATE jobs SET status = ?, locked_by = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = ?`,
        [JS.RUNNING, workerId, now, now, String(row.id), JS.QUEUED],
      );
      if (res.changes !== 1) return null;
      return rowToJob({ ...row, status: JS.RUNNING, locked_by: workerId, locked_at: now, attempts: Number(row.attempts) + 1 });
    });
  }

  markSucceeded(id: string): void {
    this.db.run(`UPDATE jobs SET status = ?, updated_at = ?, locked_by = NULL WHERE id = ?`, [JS.SUCCEEDED, nowIso(), id]);
  }

  markFailed(id: string, error: string, retryDelayMs: number): void {
    const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
    this.db.run(
      `UPDATE jobs SET status = ?, last_error = ?, available_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?`,
      [JS.QUEUED, error.slice(0, 2000), availableAt, nowIso(), id],
    );
  }

  markDead(id: string, error: string): void {
    this.db.run(`UPDATE jobs SET status = ?, last_error = ?, locked_by = NULL, updated_at = ? WHERE id = ?`, [
      JS.DEAD,
      error.slice(0, 2000),
      nowIso(),
      id,
    ]);
  }

  heartbeat(id: string, workerId: string): void {
    this.db.run(`UPDATE jobs SET locked_at = ?, updated_at = ? WHERE id = ? AND locked_by = ?`, [
      nowIso(),
      nowIso(),
      id,
      workerId,
    ]);
  }

  byId(id: string): Job | null {
    const r = this.db.get<Row>(`SELECT * FROM jobs WHERE id = ?`, [id]);
    return r ? rowToJob(r) : null;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.all<Row>(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`);
    const out: Record<string, number> = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, DEAD: 0 };
    for (const r of rows) out[String(r.status)] = Number(r.n);
    return out;
  }

  list(opts: JobListOptions = {}): Job[] {
    const where = opts.status ? `WHERE status = ?` : '';
    const params = opts.status ? [opts.status] : [];
    const rows = this.db.all<Row>(
      `SELECT * FROM jobs ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, opts.limit ?? 100, opts.offset ?? 0],
    );
    return rows.map(rowToJob);
  }

  /** Recover jobs whose lock expired (worker crashed mid-run). */
  requeueStale(ttlMs: number): number {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const res = this.db.run(
      `UPDATE jobs SET status = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
       WHERE status = ? AND (locked_at IS NULL OR locked_at < ?)`,
      [JS.QUEUED, nowIso(), JS.RUNNING, cutoff],
    );
    return res.changes;
  }
}

/* ----------------------------- Content --------------------------------- */

function rowToContent(r: Row): GeneratedContent {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    tone: String(r.tone) as GeneratedContent['tone'],
    language: String(r.language),
    provider: String(r.provider),
    captions: parseJson(r.captions, []),
    hooks: parseJson(r.hooks, []),
    ctas: parseJson(r.ctas, []),
    hashtags: parseJson(r.hashtags, []),
    seoKeywords: parseJson(r.seo_keywords, []),
    emojis: parseJson(r.emojis, []),
    createdAt: String(r.created_at),
  };
}

export class ContentRepository implements IContentRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  save(c: GeneratedContent): void {
    this.db.run(
      `INSERT INTO generated_content (id,product_id,tone,language,provider,captions,hooks,ctas,hashtags,seo_keywords,emojis,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET captions=excluded.captions, hooks=excluded.hooks, ctas=excluded.ctas,
         hashtags=excluded.hashtags, seo_keywords=excluded.seo_keywords, emojis=excluded.emojis`,
      [
        c.id,
        c.productId,
        c.tone,
        c.language,
        c.provider,
        json(c.captions),
        json(c.hooks),
        json(c.ctas),
        json(c.hashtags),
        json(c.seoKeywords),
        json(c.emojis),
        c.createdAt,
      ],
    );
  }
  byProduct(productId: string): GeneratedContent | null {
    const r = this.db.get<Row>(`SELECT * FROM generated_content WHERE product_id = ? ORDER BY created_at DESC LIMIT 1`, [productId]);
    return r ? rowToContent(r) : null;
  }
  byId(id: string): GeneratedContent | null {
    const r = this.db.get<Row>(`SELECT * FROM generated_content WHERE id = ?`, [id]);
    return r ? rowToContent(r) : null;
  }
  list(opts: { limit?: number; offset?: number } = {}): GeneratedContent[] {
    return this.db
      .all<Row>(`SELECT * FROM generated_content ORDER BY created_at DESC LIMIT ? OFFSET ?`, [opts.limit ?? 100, opts.offset ?? 0])
      .map(rowToContent);
  }
  count(): number {
    return Number(this.db.get<Row>(`SELECT COUNT(*) AS n FROM generated_content`)?.n ?? 0);
  }
}

/* ------------------------------ Assets --------------------------------- */

function rowToAsset(r: Row): GeneratedAsset {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    type: String(r.type) as GeneratedAsset['type'],
    platform: r.platform ? (String(r.platform) as Platform) : undefined,
    index: r.idx === null || r.idx === undefined ? undefined : Number(r.idx),
    path: String(r.path),
    storageKey: r.storage_key ? String(r.storage_key) : undefined,
    url: r.url ? String(r.url) : undefined,
    width: Number(r.width),
    height: Number(r.height),
    bytes: Number(r.bytes),
    createdAt: String(r.created_at),
  };
}

export class AssetRepository implements IAssetRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  saveMany(assets: GeneratedAsset[]): void {
    this.db.tx(() => {
      for (const a of assets) {
        this.db.run(
          `INSERT INTO assets (id,product_id,type,platform,idx,path,storage_key,url,width,height,bytes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
          [a.id, a.productId, a.type, a.platform ?? null, a.index ?? null, a.path, a.storageKey ?? null, a.url ?? null, a.width, a.height, a.bytes, a.createdAt],
        );
      }
    });
  }
  byProduct(productId: string): GeneratedAsset[] {
    return this.db.all<Row>(`SELECT * FROM assets WHERE product_id = ? ORDER BY idx ASC, created_at ASC`, [productId]).map(rowToAsset);
  }
  list(opts: { limit?: number; offset?: number } = {}): GeneratedAsset[] {
    return this.db.all<Row>(`SELECT * FROM assets ORDER BY created_at DESC LIMIT ? OFFSET ?`, [opts.limit ?? 100, opts.offset ?? 0]).map(rowToAsset);
  }
  count(): number {
    return Number(this.db.get<Row>(`SELECT COUNT(*) AS n FROM assets`)?.n ?? 0);
  }
}

/* ------------------------------ Videos --------------------------------- */

function rowToVideo(r: Row): GeneratedVideo {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    path: String(r.path),
    storageKey: r.storage_key ? String(r.storage_key) : undefined,
    url: r.url ? String(r.url) : undefined,
    width: Number(r.width),
    height: Number(r.height),
    durationSec: Number(r.duration_sec),
    fps: Number(r.fps),
    bytes: Number(r.bytes),
    createdAt: String(r.created_at),
  };
}

export class VideoRepository implements IVideoRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  save(v: GeneratedVideo): void {
    this.db.run(
      `INSERT INTO videos (id,product_id,path,storage_key,url,width,height,duration_sec,fps,bytes,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url, storage_key=excluded.storage_key`,
      [v.id, v.productId, v.path, v.storageKey ?? null, v.url ?? null, v.width, v.height, v.durationSec, v.fps, v.bytes, v.createdAt],
    );
  }
  byProduct(productId: string): GeneratedVideo | null {
    const r = this.db.get<Row>(`SELECT * FROM videos WHERE product_id = ? ORDER BY created_at DESC LIMIT 1`, [productId]);
    return r ? rowToVideo(r) : null;
  }
  byId(id: string): GeneratedVideo | null {
    const r = this.db.get<Row>(`SELECT * FROM videos WHERE id = ?`, [id]);
    return r ? rowToVideo(r) : null;
  }
  list(opts: { limit?: number; offset?: number } = {}): GeneratedVideo[] {
    return this.db.all<Row>(`SELECT * FROM videos ORDER BY created_at DESC LIMIT ? OFFSET ?`, [opts.limit ?? 100, opts.offset ?? 0]).map(rowToVideo);
  }
  count(): number {
    return Number(this.db.get<Row>(`SELECT COUNT(*) AS n FROM videos`)?.n ?? 0);
  }
}

/* --------------------------- Publications ------------------------------ */

function rowToPub(r: Row): Publication {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    platform: String(r.platform) as Platform,
    accountId: r.account_id ? String(r.account_id) : undefined,
    status: String(r.status) as Publication['status'],
    scheduledAt: r.scheduled_at ? String(r.scheduled_at) : undefined,
    publishedAt: r.published_at ? String(r.published_at) : undefined,
    remoteId: r.remote_id ? String(r.remote_id) : undefined,
    permalink: r.permalink ? String(r.permalink) : undefined,
    caption: r.caption ? String(r.caption) : undefined,
    error: r.error ? String(r.error) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class PublicationRepository implements IPublicationRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  save(p: Publication): void {
    this.db.run(
      `INSERT INTO publications (id,product_id,platform,account_id,status,scheduled_at,published_at,remote_id,permalink,caption,error,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.id, p.productId, p.platform, p.accountId ?? null, p.status, p.scheduledAt ?? null, p.publishedAt ?? null, p.remoteId ?? null, p.permalink ?? null, p.caption ?? null, p.error ?? null, p.createdAt, p.updatedAt],
    );
  }
  update(id: string, patch: Partial<Publication>): void {
    const fields: string[] = [];
    const params: unknown[] = [];
    const map: Record<string, string> = {
      status: 'status',
      scheduledAt: 'scheduled_at',
      publishedAt: 'published_at',
      remoteId: 'remote_id',
      permalink: 'permalink',
      caption: 'caption',
      error: 'error',
    };
    for (const [k, col] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[k];
      if (value !== undefined) {
        fields.push(`${col} = ?`);
        params.push(value ?? null);
      }
    }
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    this.db.run(`UPDATE publications SET ${fields.join(', ')} WHERE id = ?`, params);
  }
  byProduct(productId: string): Publication[] {
    return this.db.all<Row>(`SELECT * FROM publications WHERE product_id = ? ORDER BY created_at DESC`, [productId]).map(rowToPub);
  }
  list(opts: { status?: string; limit?: number; offset?: number } = {}): Publication[] {
    const where = opts.status ? `WHERE status = ?` : '';
    const params = opts.status ? [opts.status] : [];
    return this.db
      .all<Row>(`SELECT * FROM publications ${where} ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ? OFFSET ?`, [...params, opts.limit ?? 100, opts.offset ?? 0])
      .map(rowToPub);
  }
  countByStatus(): Record<string, number> {
    const rows = this.db.all<Row>(`SELECT status, COUNT(*) AS n FROM publications GROUP BY status`);
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.status)] = Number(r.n);
    return out;
  }
  count(): number {
    return Number(this.db.get<Row>(`SELECT COUNT(*) AS n FROM publications`)?.n ?? 0);
  }
}

/* ------------------------------- Logs ---------------------------------- */

export class LogRepository implements ILogRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  append(e: LogEntry): void {
    this.db.run(`INSERT INTO logs (ts,level,stage,message,product_id,job_id,data) VALUES (?,?,?,?,?,?,?)`, [
      e.ts,
      e.level,
      e.stage,
      e.message,
      e.productId ?? null,
      e.jobId ?? null,
      e.data ? json(e.data) : null,
    ]);
  }
  list(opts: { level?: string; productId?: string; limit?: number; offset?: number } = {}): LogEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.level) {
      clauses.push('level = ?');
      params.push(opts.level);
    }
    if (opts.productId) {
      clauses.push('product_id = ?');
      params.push(opts.productId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .all<Row>(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, opts.limit ?? 200, opts.offset ?? 0])
      .map((r) => ({
        id: String(r.id),
        ts: String(r.ts),
        level: String(r.level) as LogEntry['level'],
        stage: String(r.stage),
        message: String(r.message),
        productId: r.product_id ? String(r.product_id) : undefined,
        jobId: r.job_id ? String(r.job_id) : undefined,
        data: parseJson(r.data, undefined as unknown as Record<string, unknown>),
      }));
  }
  count(): number {
    return Number(this.db.get<Row>(`SELECT COUNT(*) AS n FROM logs`)?.n ?? 0);
  }
}

/* ----------------------------- Settings -------------------------------- */

export class SettingsRepository implements ISettingsRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  get(key: string): string | null {
    const r = this.db.get<Row>(`SELECT value FROM settings WHERE key = ?`, [key]);
    return r ? String(r.value) : null;
  }
  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    return raw ? (parseJson<T | null>(raw, null) as T | null) : null;
  }
  set(key: string, value: string): void {
    this.db.run(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  }
  setJson(key: string, value: unknown): void {
    this.set(key, json(value));
  }
  all(): Record<string, string> {
    const rows = this.db.all<Row>(`SELECT key, value FROM settings`);
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r.key)] = String(r.value);
    return out;
  }
}

/* ----------------------------- Accounts -------------------------------- */

function rowToAccount(r: Row): SocialAccount {
  return {
    id: String(r.id),
    platform: String(r.platform) as Platform,
    label: String(r.label),
    encryptedCredentials: String(r.encrypted_credentials),
    isDefault: intToBool(r.is_default),
    createdAt: String(r.created_at),
  };
}

export class AccountRepository implements IAccountRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  list(platform?: Platform): SocialAccount[] {
    const where = platform ? `WHERE platform = ?` : '';
    const params = platform ? [platform] : [];
    return this.db.all<Row>(`SELECT * FROM social_accounts ${where} ORDER BY created_at DESC`, params).map(rowToAccount);
  }
  getDefault(platform: Platform): SocialAccount | null {
    const r =
      this.db.get<Row>(`SELECT * FROM social_accounts WHERE platform = ? AND is_default = 1 LIMIT 1`, [platform]) ??
      this.db.get<Row>(`SELECT * FROM social_accounts WHERE platform = ? ORDER BY created_at ASC LIMIT 1`, [platform]);
    return r ? rowToAccount(r) : null;
  }
  byId(id: string): SocialAccount | null {
    const r = this.db.get<Row>(`SELECT * FROM social_accounts WHERE id = ?`, [id]);
    return r ? rowToAccount(r) : null;
  }
  save(a: SocialAccount): void {
    this.db.tx(() => {
      if (a.isDefault) this.db.run(`UPDATE social_accounts SET is_default = 0 WHERE platform = ?`, [a.platform]);
      this.db.run(
        `INSERT INTO social_accounts (id,platform,label,encrypted_credentials,is_default,created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, encrypted_credentials=excluded.encrypted_credentials, is_default=excluded.is_default`,
        [a.id, a.platform, a.label, a.encryptedCredentials, boolToInt(a.isDefault), a.createdAt],
      );
    });
  }
  remove(id: string): void {
    this.db.run(`DELETE FROM social_accounts WHERE id = ?`, [id]);
  }
}

/* ------------------------------ Dedupe --------------------------------- */

export class DedupeRepository implements IDedupeRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  seen(key: string): boolean {
    return !!this.db.get<Row>(`SELECT 1 AS x FROM dedupe WHERE key = ?`, [key]);
  }
  mark(key: string, productId: string): void {
    this.db.run(`INSERT INTO dedupe (key,product_id,created_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING`, [key, productId, nowIso()]);
  }
}

/* ---------------------------- Analytics -------------------------------- */

export class AnalyticsRepository implements IAnalyticsRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  record(e: AnalyticsEventInput): void {
    this.db.run(`INSERT INTO analytics_events (ts,type,product_id,platform,value,duration_ms,data) VALUES (?,?,?,?,?,?,?)`, [
      nowIso(),
      e.type,
      e.productId ?? null,
      e.platform ?? null,
      e.value ?? null,
      e.durationMs ?? null,
      e.data ? json(e.data) : null,
    ]);
  }
  private countType(type: string, datePrefix?: string): number {
    const where = datePrefix ? `WHERE type = ? AND ts LIKE ?` : `WHERE type = ?`;
    const params = datePrefix ? [type, `${datePrefix}%`] : [type];
    return Number(this.db.get<Row>(`SELECT COUNT(*) AS n FROM analytics_events ${where}`, params)?.n ?? 0);
  }
  dashboard() {
    const completed = this.countType('pipeline_completed');
    const failed = this.countType('pipeline_failed');
    const avg = Number(
      this.db.get<Row>(`SELECT AVG(duration_ms) AS a FROM analytics_events WHERE type = 'pipeline_completed' AND duration_ms IS NOT NULL`)?.a ?? 0,
    );
    const total = completed + failed;
    return {
      productsProcessed: completed,
      postsPublished: this.countType('post_published'),
      videosCreated: this.countType('video_created'),
      failedJobs: failed,
      successRate: total > 0 ? completed / total : 0,
      avgProcessingMs: Math.round(avg),
    };
  }
  snapshot(dateIso: string, queueSize: number): AnalyticsSnapshot {
    const date = dateIso.slice(0, 10);
    const completed = this.countType('pipeline_completed', date);
    const failed = this.countType('pipeline_failed', date);
    const total = completed + failed;
    const avg = Number(
      this.db.get<Row>(
        `SELECT AVG(duration_ms) AS a FROM analytics_events WHERE type = 'pipeline_completed' AND duration_ms IS NOT NULL AND ts LIKE ?`,
        [`${date}%`],
      )?.a ?? 0,
    );
    return {
      date,
      productsProcessed: completed,
      postsPublished: this.countType('post_published', date),
      videosCreated: this.countType('video_created', date),
      queueSize,
      failedJobs: failed,
      successRate: total > 0 ? completed / total : 0,
      avgProcessingMs: Math.round(avg),
    };
  }
}
