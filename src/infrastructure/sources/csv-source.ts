/**
 * CSV source — imports a product from a CSV file (local path or HTTP(S) URL)
 * referenced by the sheet's Product URL. The Product ID selects a row by an
 * id/sku column; otherwise the first data row is used. No credentials required.
 */
import { readFileSync } from 'node:fs';
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { ValidationError } from '../../shared/errors.ts';
import { httpRequest } from '../../shared/http.ts';
import { parseCsvObjects, pick } from '../../shared/csv.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export class CsvSource extends BaseProductSource {
  readonly type: ProductSourceType = PST.csv;

  constructor(storage: IStorage, opts: BaseSourceOptions = {}) {
    super(storage, opts);
  }

  validate(input: ProductSourceInput): void {
    if (!input.url && !input.raw) {
      throw new ValidationError('CSV source requires a Product URL pointing to a CSV file (local path or https URL)');
    }
  }

  private async readText(url: string): Promise<string> {
    if (/^https?:\/\//i.test(url)) {
      const res = await httpRequest<string>(url, { provider: 'csv', responseType: 'text', timeoutMs: 20_000, retries: 2 });
      return res.data;
    }
    return readFileSync(url, 'utf8');
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    // Allow a single-row inline CSV via raw as well.
    const text = input.url ? await this.readText(input.url) : Object.values(input.raw ?? {}).join(',');
    const rows = parseCsvObjects(text);
    if (rows.length === 0) throw new ValidationError('CSV contained no data rows');

    const wanted = input.productId?.trim();
    const row =
      (wanted
        ? rows.find(
            (r) =>
              pick(r, 'id', 'sku', 'product id', 'productid', 'handle', 'variant sku') === wanted,
          )
        : undefined) ?? rows[0]!;

    const title = pick(row, 'title', 'name', 'product name', 'product_title');
    if (!title) throw new ValidationError('CSV row is missing a title/name column');

    const features = pick(row, 'features', 'bullet points', 'highlights')
      .split(/[\n|;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const images = pick(row, 'images', 'image', 'image urls', 'image_url', 'image_link', 'photos')
      .split(/[\n|,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s) || s.startsWith('data:'));

    const priceRaw = pick(row, 'price', 'sale price', 'amount');
    const priceAmount = priceRaw ? Number(priceRaw.replace(/[^0-9.]/g, '')) : undefined;
    const compareRaw = pick(row, 'compare at price', 'mrp', 'list price', 'was');
    const compareAt = compareRaw ? Number(compareRaw.replace(/[^0-9.]/g, '')) : undefined;

    return {
      source: PST.csv,
      sourceUrl: input.url,
      sourceProductId: wanted || pick(row, 'id', 'sku'),
      title,
      brand: pick(row, 'brand', 'vendor', 'manufacturer') || input.brand,
      category: pick(row, 'category', 'type', 'product type', 'google_product_category'),
      description: pick(row, 'description', 'body', 'details', 'summary'),
      features,
      priceAmount: Number.isFinite(priceAmount) ? priceAmount : undefined,
      currency: pick(row, 'currency', 'currency code') || 'USD',
      compareAtAmount: Number.isFinite(compareAt) ? compareAt : undefined,
      imageUrls: images,
      availability: pick(row, 'availability', 'stock', 'in stock'),
      language: pick(row, 'language', 'lang') || input.language,
      raw: row,
    };
  }
}
