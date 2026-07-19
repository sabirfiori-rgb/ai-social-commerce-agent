/**
 * BaseProductSource — shared behavior for every product source adapter:
 * connectivity default, input validation, generic image download+store, and
 * RawProduct → NormalizedProduct normalization (dedupe key, price formatting).
 * Concrete sources implement importProduct() and set their `type`/isConfigured().
 */
import type { Money, NormalizedProduct, ProductImage } from '../../domain/entities.ts';
import type { ProductSourceType } from '../../domain/enums.ts';
import type { IProductSource, IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { nowIso } from '../../shared/clock.ts';
import { ValidationError } from '../../shared/errors.ts';
import { httpDownload } from '../../shared/http.ts';
import { prefixedId, productDedupeKey, slugify } from '../../shared/ids.ts';
import { createLogger, type Logger } from '../../shared/logger.ts';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export interface BaseSourceOptions {
  maxImages?: number;
  defaultLanguage?: string;
}

export abstract class BaseProductSource implements IProductSource {
  abstract readonly type: ProductSourceType;
  protected storage: IStorage;
  protected maxImages: number;
  protected defaultLanguage: string;
  protected log: Logger;

  constructor(storage: IStorage, opts: BaseSourceOptions = {}) {
    this.storage = storage;
    this.maxImages = opts.maxImages ?? 6;
    this.defaultLanguage = opts.defaultLanguage ?? 'en';
    this.log = createLogger({ source: 'pending' });
  }

  isConfigured(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    // Default: nothing to connect (offline sources). API sources override.
  }

  validate(input: ProductSourceInput): void {
    if (!input.url && !input.productId && !input.raw) {
      throw new ValidationError(`${this.type}: provide a Product URL, Product ID, or raw fields`);
    }
  }

  abstract importProduct(input: ProductSourceInput): Promise<RawProduct>;

  async downloadImages(raw: RawProduct, productId: string): Promise<ProductImage[]> {
    const urls = (raw.imageUrls ?? []).filter(Boolean).slice(0, this.maxImages);
    const images: ProductImage[] = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;
      try {
        if (url.startsWith('data:')) {
          const parsed = parseDataUrl(url);
          if (!parsed) continue;
          const ext = MIME_EXT[parsed.mime] ?? 'png';
          const key = `products/${productId}/img-${i}.${ext}`;
          const stored = await this.storage.put(key, parsed.data, parsed.mime);
          images.push(imageFrom(stored, url, i));
          continue;
        }
        const buf = await httpDownload(url, { provider: this.type, timeoutMs: 20_000, retries: 2 });
        const mime = sniffMime(buf, url);
        const ext = MIME_EXT[mime] ?? 'jpg';
        const key = `products/${productId}/img-${i}.${ext}`;
        const stored = await this.storage.put(key, buf, mime);
        images.push({
          url: stored.url ?? url,
          localPath: stored.path,
          storageKey: stored.key,
          role: i === 0 ? 'primary' : 'gallery',
          bytes: stored.bytes,
          mimeType: mime,
        });
      } catch (e) {
        this.log.warn('image download failed; skipping', { url, error: (e as Error).message });
      }
    }
    return images;
  }

  normalize(raw: RawProduct, images: ProductImage[]): NormalizedProduct {
    const language = raw.language || this.defaultLanguage;
    const price = this.buildMoney(raw.priceAmount, raw.currency, raw.compareAtAmount);
    const dedupeKey = productDedupeKey({
      source: raw.source,
      productId: raw.sourceProductId,
      url: raw.sourceUrl,
      title: raw.title,
    });
    return {
      id: `${slugify(raw.title, 24)}-${prefixedId('p').slice(2, 12)}`,
      dedupeKey,
      source: raw.source,
      sourceUrl: raw.sourceUrl,
      sourceProductId: raw.sourceProductId,
      title: raw.title.trim(),
      brand: raw.brand?.trim() || undefined,
      category: raw.category?.trim() || undefined,
      description: (raw.description ?? '').trim(),
      features: (raw.features ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 12),
      price,
      images,
      rating: raw.rating,
      availability: raw.availability,
      language,
      raw: raw.raw,
      importedAt: nowIso(),
    };
  }

  protected buildMoney(amount?: number, currency?: string, compareAt?: number): Money | undefined {
    if (amount === undefined || amount === null || Number.isNaN(amount)) return undefined;
    const cur = (currency || 'USD').toUpperCase();
    return {
      amount,
      currency: cur,
      formatted: formatMoney(amount, cur),
      compareAtAmount: compareAt,
      compareAtFormatted: compareAt !== undefined ? formatMoney(compareAt, cur) : undefined,
    };
  }
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function imageFrom(stored: { url?: string; path: string; key: string; bytes: number }, fallbackUrl: string, i: number): ProductImage {
  return {
    url: stored.url ?? fallbackUrl,
    localPath: stored.path,
    storageKey: stored.key,
    role: i === 0 ? 'primary' : 'gallery',
    bytes: stored.bytes,
  };
}

function parseDataUrl(url: string): { mime: string; data: Buffer } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || 'image/png';
  const isB64 = !!m[2];
  const data = isB64 ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
  return { mime, data };
}

function sniffMime(buf: Buffer, url: string): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  const ext = url.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}
