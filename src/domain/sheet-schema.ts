/**
 * The Google Sheet is the user's control surface. This module defines the exact
 * six-tab layout, column order, and the mapping between sheet rows and typed
 * ProductRow objects. Both the Local and Google sheet stores share this schema.
 */
import type { ProductStatus } from './enums.ts';
import { ALL_PRODUCT_STATUSES } from './enums.ts';

export const SHEET_TABS = {
  products: 'Products',
  brandSettings: 'Brand Settings',
  publishingSchedule: 'Publishing Schedule',
  generatedContent: 'Generated Content',
  logs: 'Logs',
  analytics: 'Analytics',
  locks: '_Locks', // internal, hidden — used for race-free row claiming on Google Sheets
} as const;

/** Products tab columns, in exact order (matches the specification). */
export const PRODUCTS_HEADERS = [
  'ID',
  'Status',
  'Product Source',
  'Product URL',
  'Product ID',
  'Brand',
  'Platform',
  'Language',
  'Category',
  'Schedule Date',
  'Schedule Time',
  'Generated Caption',
  'Generated Video',
  'Published URL',
  'Error',
  'Created Time',
  'Updated Time',
] as const;

export const BRAND_SETTINGS_HEADERS = [
  'Brand',
  'Primary Color',
  'Accent Color',
  'Text Color',
  'Font',
  'Logo URL',
  'Watermark',
  'CTA',
  'Language',
] as const;

export const PUBLISHING_SCHEDULE_HEADERS = [
  'ID',
  'Product ID',
  'Platform',
  'Scheduled At',
  'Status',
  'Published At',
  'Permalink',
  'Error',
] as const;

export const GENERATED_CONTENT_HEADERS = [
  'ID',
  'Product ID',
  'Platform',
  'Tone',
  'Caption',
  'Hashtags',
  'Hooks',
  'CTAs',
  'Created At',
] as const;

export const LOGS_HEADERS = ['Time', 'Level', 'Product ID', 'Job ID', 'Stage', 'Message', 'Data'] as const;

export const ANALYTICS_HEADERS = [
  'Date',
  'Products Processed',
  'Posts Published',
  'Videos Created',
  'Queue Size',
  'Failed Jobs',
  'Success Rate',
  'Avg Processing Ms',
] as const;

export const LOCKS_HEADERS = ['Row ID', 'Token', 'Worker', 'Expires At'] as const;

/** Typed representation of a Products-tab row. */
export interface ProductRow {
  id: string;
  status: ProductStatus;
  productSource: string;
  productUrl: string;
  productId: string;
  brand: string;
  platform: string; // comma-separated platform list, or blank = all configured
  language: string;
  category: string;
  scheduleDate: string;
  scheduleTime: string;
  generatedCaption: string;
  generatedVideo: string;
  publishedUrl: string;
  error: string;
  createdTime: string;
  updatedTime: string;
  /** 1-based row number in the sheet (present when read back). */
  rowNumber?: number;
}

const HEADER_TO_KEY: Record<string, keyof ProductRow> = {
  ID: 'id',
  Status: 'status',
  'Product Source': 'productSource',
  'Product URL': 'productUrl',
  'Product ID': 'productId',
  Brand: 'brand',
  Platform: 'platform',
  Language: 'language',
  Category: 'category',
  'Schedule Date': 'scheduleDate',
  'Schedule Time': 'scheduleTime',
  'Generated Caption': 'generatedCaption',
  'Generated Video': 'generatedVideo',
  'Published URL': 'publishedUrl',
  Error: 'error',
  'Created Time': 'createdTime',
  'Updated Time': 'updatedTime',
};

const KEY_TO_HEADER: Record<keyof ProductRow, string> = Object.fromEntries(
  Object.entries(HEADER_TO_KEY).map(([h, k]) => [k, h]),
) as Record<keyof ProductRow, string>;

export function emptyProductRow(): ProductRow {
  return {
    id: '',
    status: 'NEW',
    productSource: '',
    productUrl: '',
    productId: '',
    brand: '',
    platform: '',
    language: '',
    category: '',
    scheduleDate: '',
    scheduleTime: '',
    generatedCaption: '',
    generatedVideo: '',
    publishedUrl: '',
    error: '',
    createdTime: '',
    updatedTime: '',
  };
}

/** Convert an array of cell values (aligned to PRODUCTS_HEADERS) into a ProductRow. */
export function cellsToProductRow(cells: string[], rowNumber?: number): ProductRow {
  const row = emptyProductRow();
  PRODUCTS_HEADERS.forEach((header, i) => {
    const key = HEADER_TO_KEY[header];
    if (key) (row as Record<string, unknown>)[key] = (cells[i] ?? '').toString();
  });
  if (rowNumber) row.rowNumber = rowNumber;
  return row;
}

/** Convert a header-keyed object (from Sheets `headerRow` reads) into a ProductRow. */
export function recordToProductRow(record: Record<string, unknown>, rowNumber?: number): ProductRow {
  const row = emptyProductRow();
  for (const header of PRODUCTS_HEADERS) {
    const key = HEADER_TO_KEY[header];
    if (key) (row as Record<string, unknown>)[key] = (record[header] ?? '').toString();
  }
  if (rowNumber) row.rowNumber = rowNumber;
  return row;
}

/** Convert a ProductRow into an ordered cell array (aligned to PRODUCTS_HEADERS). */
export function productRowToCells(row: ProductRow): string[] {
  return PRODUCTS_HEADERS.map((header) => {
    const key = HEADER_TO_KEY[header];
    return key ? String((row as Record<string, unknown>)[key] ?? '') : '';
  });
}

/** Build a header-keyed object for a partial patch (only changed columns). */
export function patchToRecord(patch: Partial<ProductRow>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'rowNumber') continue;
    const header = KEY_TO_HEADER[key as keyof ProductRow];
    if (header) out[header] = value === undefined || value === null ? '' : String(value);
  }
  return out;
}

export function columnLetter(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function isValidStatus(value: string): value is ProductStatus {
  return (ALL_PRODUCT_STATUSES as string[]).includes(value);
}
