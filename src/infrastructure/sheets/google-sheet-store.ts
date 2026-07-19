/**
 * Google Sheets store — real Sheets API v4 over fetch (no googleapis dep).
 * Implements schema provisioning, reads/writes, and race-free row claiming
 * using a hidden `_Locks` tab (optimistic token protocol).
 */
import type { AnalyticsSnapshot, BrandProfile, GeneratedContent, Publication } from '../../domain/entities.ts';
import type { Platform, ProductStatus } from '../../domain/enums.ts';
import { ALL_PRODUCT_STATUSES } from '../../domain/enums.ts';
import type { ISheetStore, SheetLogInput } from '../../domain/ports.ts';
import {
  ANALYTICS_HEADERS,
  BRAND_SETTINGS_HEADERS,
  GENERATED_CONTENT_HEADERS,
  LOCKS_HEADERS,
  LOGS_HEADERS,
  PRODUCTS_HEADERS,
  PUBLISHING_SCHEDULE_HEADERS,
  SHEET_TABS,
  cellsToProductRow,
  productRowToCells,
  type ProductRow,
} from '../../domain/sheet-schema.ts';
import { nowIso, sleep } from '../../shared/clock.ts';
import { ConfigError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { prefixedId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { GoogleAuth, GOOGLE_SHEETS_SCOPES, loadServiceAccount } from './google-auth.ts';

const log = createLogger({ mod: 'google-sheets' });
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

const TAB_HEADERS: Record<string, readonly string[]> = {
  [SHEET_TABS.products]: PRODUCTS_HEADERS,
  [SHEET_TABS.brandSettings]: BRAND_SETTINGS_HEADERS,
  [SHEET_TABS.publishingSchedule]: PUBLISHING_SCHEDULE_HEADERS,
  [SHEET_TABS.generatedContent]: GENERATED_CONTENT_HEADERS,
  [SHEET_TABS.logs]: LOGS_HEADERS,
  [SHEET_TABS.analytics]: ANALYTICS_HEADERS,
  [SHEET_TABS.locks]: LOCKS_HEADERS,
};

export class GoogleSheetsStore implements ISheetStore {
  readonly kind = 'google' as const;
  private auth: GoogleAuth;
  private spreadsheetId: string;
  private sheetIdByTitle: Record<string, number> = {};

  constructor(opts: { spreadsheetId: string; serviceAccountFile?: string; serviceAccountJson?: string }) {
    if (!opts.spreadsheetId) throw new ConfigError('GOOGLE_SHEETS_SPREADSHEET_ID is required for the Google sheet store');
    this.spreadsheetId = opts.spreadsheetId;
    const sa = loadServiceAccount({ file: opts.serviceAccountFile, inlineJson: opts.serviceAccountJson });
    this.auth = new GoogleAuth(sa, GOOGLE_SHEETS_SCOPES);
  }

  async init(): Promise<void> {
    await this.ensureSchema();
  }

  private async headers(): Promise<Record<string, string>> {
    return { ...(await this.auth.authHeader()), 'content-type': 'application/json' };
  }

  private async loadMeta(): Promise<void> {
    const meta = await httpJson<{ sheets: { properties: { sheetId: number; title: string } }[] }>(
      `${API}/${this.spreadsheetId}`,
      { provider: 'google-sheets', query: { fields: 'sheets.properties(sheetId,title)' }, headers: await this.headers() },
    );
    this.sheetIdByTitle = {};
    for (const s of meta.sheets ?? []) this.sheetIdByTitle[s.properties.title] = s.properties.sheetId;
  }

  async ensureSchema(): Promise<void> {
    await this.loadMeta();
    const requests: unknown[] = [];
    for (const title of Object.values(SHEET_TABS)) {
      if (this.sheetIdByTitle[title] === undefined) {
        requests.push({ addSheet: { properties: { title, hidden: title === SHEET_TABS.locks } } });
      }
    }
    if (requests.length) {
      await this.batchUpdate(requests);
      await this.loadMeta();
    }

    // Write headers where the first row is empty.
    for (const [title, hdrs] of Object.entries(TAB_HEADERS)) {
      const existing = await this.valuesGet(`${title}!A1:1`);
      if (!existing.length || !existing[0]?.length) {
        await this.valuesUpdate(`${title}!A1`, [hdrs as string[]]);
      }
    }

    // Status dropdown + header freeze on Products.
    const productsSheetId = this.sheetIdByTitle[SHEET_TABS.products];
    if (productsSheetId !== undefined) {
      await this.batchUpdate([
        {
          setDataValidation: {
            range: { sheetId: productsSheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
            rule: {
              condition: { type: 'ONE_OF_LIST', values: ALL_PRODUCT_STATUSES.map((v) => ({ userEnteredValue: v })) },
              strict: false,
              showCustomUi: true,
            },
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: productsSheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ]);
    }
    log.info('google sheet schema ensured', { spreadsheetId: this.spreadsheetId });
  }

  /* --------------------------- low-level REST --------------------------- */

  private async valuesGet(range: string): Promise<string[][]> {
    const res = await httpJson<{ values?: string[][] }>(
      `${API}/${this.spreadsheetId}/values/${encodeURIComponent(range)}`,
      { provider: 'google-sheets', headers: await this.headers(), query: { valueRenderOption: 'FORMATTED_VALUE' } },
    );
    return res.values ?? [];
  }

  private async valuesUpdate(range: string, values: string[][]): Promise<void> {
    await httpJson(`${API}/${this.spreadsheetId}/values/${encodeURIComponent(range)}`, {
      method: 'PUT',
      provider: 'google-sheets',
      headers: await this.headers(),
      query: { valueInputOption: 'RAW' },
      body: { values },
    });
  }

  private async valuesAppend(range: string, values: string[][]): Promise<void> {
    await httpJson(`${API}/${this.spreadsheetId}/values/${encodeURIComponent(range)}:append`, {
      method: 'POST',
      provider: 'google-sheets',
      headers: await this.headers(),
      query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
      body: { values },
    });
  }

  private async batchUpdate(requests: unknown[]): Promise<void> {
    await httpJson(`${API}/${this.spreadsheetId}:batchUpdate`, {
      method: 'POST',
      provider: 'google-sheets',
      headers: await this.headers(),
      body: { requests },
    });
  }

  private async findRowNumber(tab: string, colIndex0: number, value: string): Promise<number | null> {
    const values = await this.valuesGet(`${tab}!A2:Z`);
    for (let i = 0; i < values.length; i++) {
      if ((values[i]?.[colIndex0] ?? '') === value) return i + 2;
    }
    return null;
  }

  /* ----------------------------- ISheetStore ---------------------------- */

  async listProducts(opts: { status?: ProductStatus; limit?: number } = {}): Promise<ProductRow[]> {
    const values = await this.valuesGet(`${SHEET_TABS.products}!A2:Q`);
    const rows = values.map((cells, i) => cellsToProductRow(cells, i + 2));
    const filtered = opts.status ? rows.filter((r) => r.status === opts.status) : rows;
    return filtered.filter((r) => r.id).slice(0, opts.limit ?? filtered.length);
  }

  async getProduct(id: string): Promise<ProductRow | null> {
    const rows = await this.listProducts();
    return rows.find((r) => r.id === id) ?? null;
  }

  async appendProduct(input: Partial<ProductRow>): Promise<ProductRow> {
    const now = nowIso();
    const row: ProductRow = {
      ...cellsToProductRow([]),
      ...input,
      id: input.id && input.id.trim() ? input.id : prefixedId('prd'),
      status: (input.status as ProductStatus) ?? 'NEW',
      createdTime: input.createdTime || now,
      updatedTime: now,
    };
    await this.valuesAppend(`${SHEET_TABS.products}!A1`, [productRowToCells(row)]);
    return row;
  }

  async findClaimableRows(limit: number): Promise<ProductRow[]> {
    return (await this.listProducts({ status: 'NEW' })).slice(0, limit);
  }

  async claimRow(row: ProductRow, workerId: string, ttlMs: number): Promise<boolean> {
    const current = await this.getProduct(row.id);
    if (!current || current.status !== 'NEW') return false;

    const token = prefixedId('lock');
    const expires = new Date(Date.now() + ttlMs).toISOString();
    await this.valuesAppend(`${SHEET_TABS.locks}!A1`, [[row.id, token, workerId, expires]]);

    // Let concurrent claims land, then determine the winner (earliest non-expired lock).
    await sleep(300);
    const locks = await this.valuesGet(`${SHEET_TABS.locks}!A2:D`);
    const now = Date.now();
    const active = locks.filter((l) => l[0] === row.id && new Date(l[3] ?? 0).getTime() > now);
    const winner = active[0];
    if (!winner || winner[1] !== token) return false;

    // Final status re-check, then flip to PROCESSING.
    const recheck = await this.getProduct(row.id);
    if (!recheck || recheck.status !== 'NEW') return false;
    await this.setStatus(row.id, 'PROCESSING');
    return true;
  }

  async updateRow(id: string, patch: Partial<ProductRow>): Promise<void> {
    const rowNum = await this.findRowNumber(SHEET_TABS.products, 0, id);
    if (!rowNum) throw new ConfigError(`Row ${id} not found in Products`);
    const existingRows = await this.valuesGet(`${SHEET_TABS.products}!A${rowNum}:Q${rowNum}`);
    const current = cellsToProductRow(existingRows[0] ?? [], rowNum);
    const merged: ProductRow = { ...current, ...patch, id, updatedTime: nowIso() };
    await this.valuesUpdate(`${SHEET_TABS.products}!A${rowNum}:Q${rowNum}`, [productRowToCells(merged)]);
  }

  async setStatus(id: string, status: ProductStatus, patch: Partial<ProductRow> = {}): Promise<void> {
    await this.updateRow(id, { ...patch, status });
  }

  async appendLog(input: SheetLogInput): Promise<void> {
    await this.valuesAppend(`${SHEET_TABS.logs}!A1`, [
      [nowIso(), input.level, input.productId ?? '', input.jobId ?? '', input.stage, input.message, input.data ? JSON.stringify(input.data) : ''],
    ]);
  }

  async getBrandSettings(brand?: string): Promise<Partial<BrandProfile> | null> {
    const values = await this.valuesGet(`${SHEET_TABS.brandSettings}!A2:I`);
    if (!values.length) return null;
    const match = brand ? values.find((r) => (r[0] ?? '').toLowerCase() === brand.toLowerCase()) : values[0];
    if (!match) return null;
    return {
      name: match[0] ?? '',
      primaryColor: match[1] || undefined,
      accentColor: match[2] || undefined,
      textColor: match[3] || undefined,
      font: match[4] || undefined,
      logoUrl: match[5] || undefined,
      watermarkText: match[6] || undefined,
      cta: match[7] || undefined,
      language: match[8] || undefined,
    };
  }

  async upsertBrandSettings(p: BrandProfile): Promise<void> {
    const rowNum = await this.findRowNumber(SHEET_TABS.brandSettings, 0, p.name);
    const cells = [p.name, p.primaryColor, p.accentColor, p.textColor, p.font, p.logoUrl ?? '', p.watermarkText ?? '', p.cta, p.language];
    if (rowNum) await this.valuesUpdate(`${SHEET_TABS.brandSettings}!A${rowNum}:I${rowNum}`, [cells]);
    else await this.valuesAppend(`${SHEET_TABS.brandSettings}!A1`, [cells]);
  }

  async appendGeneratedContent(content: GeneratedContent, platform: Platform, caption: string): Promise<void> {
    await this.valuesAppend(`${SHEET_TABS.generatedContent}!A1`, [
      [prefixedId('gc'), content.productId, platform, content.tone, caption, content.hashtags.join(' '), content.hooks.join(' | '), content.ctas.join(' | '), content.createdAt],
    ]);
  }

  async upsertSchedule(pub: Publication): Promise<void> {
    const rowNum = await this.findRowNumber(SHEET_TABS.publishingSchedule, 0, pub.id);
    const cells = [pub.id, pub.productId, pub.platform, pub.scheduledAt ?? '', pub.status, pub.publishedAt ?? '', pub.permalink ?? '', pub.error ?? ''];
    if (rowNum) await this.valuesUpdate(`${SHEET_TABS.publishingSchedule}!A${rowNum}:H${rowNum}`, [cells]);
    else await this.valuesAppend(`${SHEET_TABS.publishingSchedule}!A1`, [cells]);
  }

  async writeAnalytics(s: AnalyticsSnapshot): Promise<void> {
    const rowNum = await this.findRowNumber(SHEET_TABS.analytics, 0, s.date);
    const cells = [s.date, String(s.productsProcessed), String(s.postsPublished), String(s.videosCreated), String(s.queueSize), String(s.failedJobs), s.successRate.toFixed(3), String(s.avgProcessingMs)];
    if (rowNum) await this.valuesUpdate(`${SHEET_TABS.analytics}!A${rowNum}:H${rowNum}`, [cells]);
    else await this.valuesAppend(`${SHEET_TABS.analytics}!A1`, [cells]);
  }
}
