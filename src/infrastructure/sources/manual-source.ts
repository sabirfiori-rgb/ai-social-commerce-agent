/**
 * Manual Entry source — the product details are provided by the operator
 * (via the dashboard "Add Product" form / API, which persists a payload keyed
 * by product id), or inline as JSON in the sheet's Product URL cell, or as raw
 * sheet fields. No external credentials required.
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { ISettingsRepository, IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { ValidationError } from '../../shared/errors.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export interface ManualProductPayload {
  title: string;
  description?: string;
  features?: string[] | string;
  price?: number | string;
  currency?: string;
  compareAt?: number | string;
  brand?: string;
  category?: string;
  imageUrls?: string[] | string;
  language?: string;
  availability?: string;
  rating?: { value: number; count: number };
}

export const MANUAL_SETTINGS_PREFIX = 'manual_product:';

function toList(value: string[] | string | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value)
    .split(/[\n|,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNumber(value: number | string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export class ManualEntrySource extends BaseProductSource {
  readonly type: ProductSourceType = PST.manual;
  private settings: ISettingsRepository;

  constructor(storage: IStorage, settings: ISettingsRepository, opts: BaseSourceOptions = {}) {
    super(storage, opts);
    this.settings = settings;
  }

  static settingsKey(productId: string): string {
    return `${MANUAL_SETTINGS_PREFIX}${productId}`;
  }

  private resolvePayload(input: ProductSourceInput): ManualProductPayload | null {
    // 1) stored payload by product id
    if (input.productId) {
      const stored = this.settings.getJson<ManualProductPayload>(ManualEntrySource.settingsKey(input.productId));
      if (stored) return stored;
    }
    // 2) inline JSON in the URL cell
    if (input.url && input.url.trim().startsWith('{')) {
      try {
        return JSON.parse(input.url) as ManualProductPayload;
      } catch {
        /* fall through */
      }
    }
    // 3) raw sheet fields (header-keyed)
    if (input.raw && (input.raw.Title || input.raw.title)) {
      const r = input.raw;
      return {
        title: r.Title ?? r.title ?? '',
        description: r.Description ?? r.description,
        features: r.Features ?? r.features,
        price: r.Price ?? r.price,
        currency: r.Currency ?? r.currency,
        brand: r.Brand ?? r.brand,
        category: r.Category ?? r.category,
        imageUrls: r.Images ?? r.images ?? r.ImageUrls,
        language: r.Language ?? r.language,
      };
    }
    return null;
  }

  validate(input: ProductSourceInput): void {
    const payload = this.resolvePayload(input);
    if (!payload || !payload.title) {
      throw new ValidationError('Manual source requires a product payload with at least a title', {
        hint: 'Add the product via the dashboard, inline JSON in Product URL, or Title/Description/Price fields',
      });
    }
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    const payload = this.resolvePayload(input);
    if (!payload || !payload.title) throw new ValidationError('Manual product payload not found or missing title');
    return {
      source: PST.manual,
      sourceUrl: input.url && !input.url.startsWith('{') ? input.url : undefined,
      sourceProductId: input.productId,
      title: payload.title,
      brand: payload.brand,
      category: payload.category,
      description: payload.description ?? '',
      features: toList(payload.features),
      priceAmount: toNumber(payload.price),
      currency: payload.currency,
      compareAtAmount: toNumber(payload.compareAt),
      imageUrls: toList(payload.imageUrls),
      rating: payload.rating,
      availability: payload.availability,
      language: payload.language,
      raw: payload,
    };
  }
}
