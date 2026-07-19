/**
 * Local sheet store — a SQLite-backed mirror of the six sheet tabs.
 * Lets the entire pipeline run end-to-end with ZERO external credentials,
 * while behaving identically to the Google store (including race-free row
 * claiming via an atomic conditional UPDATE).
 */
import type { AnalyticsSnapshot, BrandProfile, GeneratedContent, Publication } from '../../domain/entities.ts';
import type { Platform, ProductStatus } from '../../domain/enums.ts';
import type { ISheetStore, SheetLogInput } from '../../domain/ports.ts';
import { type ProductRow, emptyProductRow } from '../../domain/sheet-schema.ts';
import { nowIso } from '../../shared/clock.ts';
import { prefixedId } from '../../shared/ids.ts';
import { json, type Db, type Row } from '../db/database.ts';

const COL: Record<keyof ProductRow, string> = {
  id: 'id',
  status: 'status',
  productSource: 'product_source',
  productUrl: 'product_url',
  productId: 'product_id',
  brand: 'brand',
  platform: 'platform',
  language: 'language',
  category: 'category',
  scheduleDate: 'schedule_date',
  scheduleTime: 'schedule_time',
  generatedCaption: 'generated_caption',
  generatedVideo: 'generated_video',
  publishedUrl: 'published_url',
  error: 'error',
  createdTime: 'created_time',
  updatedTime: 'updated_time',
  rowNumber: 'seq',
};

function toRow(r: Row): ProductRow {
  const row = emptyProductRow();
  row.id = String(r.id ?? '');
  row.status = String(r.status ?? 'NEW') as ProductStatus;
  row.productSource = String(r.product_source ?? '');
  row.productUrl = String(r.product_url ?? '');
  row.productId = String(r.product_id ?? '');
  row.brand = String(r.brand ?? '');
  row.platform = String(r.platform ?? '');
  row.language = String(r.language ?? '');
  row.category = String(r.category ?? '');
  row.scheduleDate = String(r.schedule_date ?? '');
  row.scheduleTime = String(r.schedule_time ?? '');
  row.generatedCaption = String(r.generated_caption ?? '');
  row.generatedVideo = String(r.generated_video ?? '');
  row.publishedUrl = String(r.published_url ?? '');
  row.error = String(r.error ?? '');
  row.createdTime = String(r.created_time ?? '');
  row.updatedTime = String(r.updated_time ?? '');
  row.rowNumber = r.seq === null || r.seq === undefined ? undefined : Number(r.seq);
  return row;
}

export class LocalSheetStore implements ISheetStore {
  readonly kind = 'local' as const;
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async init(): Promise<void> {
    await this.ensureSchema();
  }

  async ensureSchema(): Promise<void> {
    // Tables are created by the central migration; nothing extra needed.
  }

  async listProducts(opts: { status?: ProductStatus; limit?: number } = {}): Promise<ProductRow[]> {
    const where = opts.status ? `WHERE status = ?` : '';
    const params = opts.status ? [opts.status] : [];
    return this.db
      .all<Row>(`SELECT * FROM sheet_products ${where} ORDER BY seq ASC LIMIT ?`, [...params, opts.limit ?? 1000])
      .map(toRow);
  }

  async getProduct(id: string): Promise<ProductRow | null> {
    const r = this.db.get<Row>(`SELECT * FROM sheet_products WHERE id = ?`, [id]);
    return r ? toRow(r) : null;
  }

  async appendProduct(input: Partial<ProductRow>): Promise<ProductRow> {
    const now = nowIso();
    const id = input.id && input.id.trim() ? input.id : prefixedId('prd');
    const seq = Number(this.db.get<Row>(`SELECT COALESCE(MAX(seq),0) + 1 AS s FROM sheet_products`)?.s ?? 1);
    const row: ProductRow = {
      ...emptyProductRow(),
      ...input,
      id,
      status: (input.status as ProductStatus) ?? 'NEW',
      createdTime: input.createdTime || now,
      updatedTime: now,
      rowNumber: seq,
    };
    this.db.run(
      `INSERT INTO sheet_products
        (id,seq,status,product_source,product_url,product_id,brand,platform,language,category,schedule_date,schedule_time,generated_caption,generated_video,published_url,error,created_time,updated_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, seq, row.status, row.productSource, row.productUrl, row.productId, row.brand, row.platform, row.language,
        row.category, row.scheduleDate, row.scheduleTime, row.generatedCaption, row.generatedVideo, row.publishedUrl,
        row.error, row.createdTime, row.updatedTime,
      ],
    );
    return row;
  }

  async findClaimableRows(limit: number): Promise<ProductRow[]> {
    return this.db
      .all<Row>(`SELECT * FROM sheet_products WHERE status = 'NEW' ORDER BY seq ASC LIMIT ?`, [limit])
      .map(toRow);
  }

  async claimRow(row: ProductRow, workerId: string, ttlMs: number): Promise<boolean> {
    const now = nowIso();
    const expires = new Date(Date.now() + ttlMs).toISOString();
    // Atomic: claim only if still NEW, or if a previous PROCESSING lock has expired.
    const res = this.db.run(
      `UPDATE sheet_products
         SET status = 'PROCESSING', lock_token = ?, lock_worker = ?, lock_expires = ?, updated_time = ?
       WHERE id = ? AND (status = 'NEW' OR (status = 'PROCESSING' AND lock_expires < ?))`,
      [prefixedId('lock'), workerId, expires, now, row.id, now],
    );
    return res.changes === 1;
  }

  async updateRow(id: string, patch: Partial<ProductRow>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'rowNumber') continue;
      const col = COL[key as keyof ProductRow];
      if (!col) continue;
      sets.push(`${col} = ?`);
      params.push(value ?? '');
    }
    sets.push('updated_time = ?');
    params.push(nowIso(), id);
    if (sets.length === 1) return;
    this.db.run(`UPDATE sheet_products SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async setStatus(id: string, status: ProductStatus, patch: Partial<ProductRow> = {}): Promise<void> {
    await this.updateRow(id, { ...patch, status });
  }

  async appendLog(input: SheetLogInput): Promise<void> {
    this.db.run(`INSERT INTO sheet_logs (time,level,product_id,job_id,stage,message,data) VALUES (?,?,?,?,?,?,?)`, [
      nowIso(),
      input.level,
      input.productId ?? '',
      input.jobId ?? '',
      input.stage,
      input.message,
      input.data ? json(input.data) : '',
    ]);
  }

  async getBrandSettings(brand?: string): Promise<Partial<BrandProfile> | null> {
    const r = brand
      ? this.db.get<Row>(`SELECT * FROM sheet_brand_settings WHERE brand = ? COLLATE NOCASE`, [brand])
      : this.db.get<Row>(`SELECT * FROM sheet_brand_settings LIMIT 1`);
    if (!r) return null;
    return {
      name: String(r.brand),
      primaryColor: r.primary_color ? String(r.primary_color) : undefined,
      accentColor: r.accent_color ? String(r.accent_color) : undefined,
      textColor: r.text_color ? String(r.text_color) : undefined,
      font: r.font ? String(r.font) : undefined,
      logoUrl: r.logo_url ? String(r.logo_url) : undefined,
      watermarkText: r.watermark ? String(r.watermark) : undefined,
      cta: r.cta ? String(r.cta) : undefined,
      language: r.language ? String(r.language) : undefined,
    };
  }

  async upsertBrandSettings(p: BrandProfile): Promise<void> {
    this.db.run(
      `INSERT INTO sheet_brand_settings (brand,primary_color,accent_color,text_color,font,logo_url,watermark,cta,language)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(brand) DO UPDATE SET primary_color=excluded.primary_color, accent_color=excluded.accent_color,
         text_color=excluded.text_color, font=excluded.font, logo_url=excluded.logo_url, watermark=excluded.watermark,
         cta=excluded.cta, language=excluded.language`,
      [p.name, p.primaryColor, p.accentColor, p.textColor, p.font, p.logoUrl ?? '', p.watermarkText ?? '', p.cta, p.language],
    );
  }

  async appendGeneratedContent(content: GeneratedContent, platform: Platform, caption: string): Promise<void> {
    this.db.run(
      `INSERT INTO sheet_generated (id,product_id,platform,tone,caption,hashtags,hooks,ctas,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        prefixedId('gc'),
        content.productId,
        platform,
        content.tone,
        caption,
        content.hashtags.join(' '),
        content.hooks.join(' | '),
        content.ctas.join(' | '),
        content.createdAt,
      ],
    );
  }

  async upsertSchedule(pub: Publication): Promise<void> {
    this.db.run(
      `INSERT INTO sheet_schedule (id,product_id,platform,scheduled_at,status,published_at,permalink,error)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, scheduled_at=excluded.scheduled_at,
         published_at=excluded.published_at, permalink=excluded.permalink, error=excluded.error`,
      [pub.id, pub.productId, pub.platform, pub.scheduledAt ?? '', pub.status, pub.publishedAt ?? '', pub.permalink ?? '', pub.error ?? ''],
    );
  }

  async writeAnalytics(s: AnalyticsSnapshot): Promise<void> {
    this.db.run(
      `INSERT INTO sheet_analytics (date,products_processed,posts_published,videos_created,queue_size,failed_jobs,success_rate,avg_processing_ms)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET products_processed=excluded.products_processed, posts_published=excluded.posts_published,
         videos_created=excluded.videos_created, queue_size=excluded.queue_size, failed_jobs=excluded.failed_jobs,
         success_rate=excluded.success_rate, avg_processing_ms=excluded.avg_processing_ms`,
      [s.date, s.productsProcessed, s.postsPublished, s.videosCreated, s.queueSize, s.failedJobs, s.successRate, s.avgProcessingMs],
    );
  }
}
