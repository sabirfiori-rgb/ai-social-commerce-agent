/**
 * Meesho source — Meesho does not publish a broadly-available public catalogue
 * API (unlike Shopify/WooCommerce/Etsy/Flipkart). Sellers/partners are onboarded
 * onto Meesho's Supplier/Partner Panel APIs on a per-integration basis, and the
 * exact base URL + product-detail path are assigned by Meesho during that
 * onboarding. This adapter implements a configurable, authenticated JSON GET
 * against whatever base URL and product-id path shape the operator's Meesho
 * partner/supplier integration actually exposes, so it is real and callable
 * once configured — no fabricated data.
 *
 * Configure `baseUrl` to the exact partner-catalogue root Meesho assigned you
 * (e.g. the supplier-panel product/catalogue endpoint documented in your
 * Meesho partner onboarding packet). This adapter then calls:
 *   GET {baseUrl}/{productId}
 *   Authorization: Bearer {apiToken}
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { NotConfiguredError, NotFoundError, ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export interface MeeshoConfig {
  /** Root URL of the operator's Meesho partner/supplier catalogue API, e.g.
   * "https://supplier.meesho.com/api/v1/catalogue/products" — the product id
   * is appended as a path segment: `${baseUrl}/{productId}`. */
  baseUrl: string;
  apiToken: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class MeeshoSource extends BaseProductSource {
  readonly type: ProductSourceType = PST.meesho;
  private cfg: MeeshoConfig;

  constructor(storage: IStorage, cfg: MeeshoConfig, opts: BaseSourceOptions = {}) {
    super(storage, opts);
    this.cfg = cfg;
  }

  override isConfigured(): boolean {
    return !!(this.cfg.baseUrl && this.cfg.apiToken);
  }

  private base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.apiToken}`, accept: 'application/json' };
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('meesho', ['MEESHO_BASE_URL', 'MEESHO_API_TOKEN']);
    }
  }

  private extractProductId(input: ProductSourceInput): string | null {
    if (input.productId && input.productId.trim()) return input.productId.trim();
    const url = input.url ?? '';
    const m = /\/p\/([a-zA-Z0-9_-]+)/.exec(url) ?? /[?&](?:productId|pid)=([a-zA-Z0-9_-]+)/.exec(url);
    return m ? m[1]! : null;
  }

  override validate(input: ProductSourceInput): void {
    if (!this.extractProductId(input)) {
      throw new ValidationError('Meesho source requires a Product ID or a product URL the partner API recognizes');
    }
  }

  override async connect(): Promise<void> {
    this.requireConfig();
    // No universal unauthenticated ping is documented for partner-specific
    // Meesho catalogue integrations, so verify connectivity by hitting the
    // configured base URL itself (root of the catalogue resource); a
    // non-2xx/network failure surfaces bad config immediately.
    await httpJson(this.base(), {
      provider: 'meesho',
      headers: this.authHeaders(),
      timeoutMs: 15_000,
    });
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    this.requireConfig();
    const productId = this.extractProductId(input);
    if (!productId) throw new ValidationError('Could not determine Meesho product id');

    const product = await httpJson<MeeshoProduct>(`${this.base()}/${encodeURIComponent(productId)}`, {
      provider: 'meesho',
      headers: this.authHeaders(),
      timeoutMs: 20_000,
    });
    if (!product) throw new NotFoundError('Meesho product not found', { productId });

    const title = product.name ?? product.title ?? `Meesho product ${productId}`;
    const descriptionRaw = product.description ?? '';
    const price = product.price ?? product.sellingPrice ?? product.selling_price;
    const mrp = product.mrp ?? product.maxPrice ?? product.max_price;
    const priceAmount = price !== undefined ? Number(price) : mrp !== undefined ? Number(mrp) : undefined;
    const compareAtAmount = priceAmount !== undefined && mrp !== undefined && Number(mrp) > priceAmount ? Number(mrp) : undefined;

    const imageSources = product.images ?? product.media ?? [];
    const imageUrls = imageSources
      .map((im) => (typeof im === 'string' ? im : im?.url))
      .filter((u): u is string => !!u);

    const category = product.category ?? product.categoryName ?? product.category_name;

    return {
      source: PST.meesho,
      sourceUrl: product.url ?? product.productUrl ?? input.url,
      sourceProductId: String(product.id ?? product.productId ?? productId),
      title,
      category,
      description: stripHtml(descriptionRaw),
      features: (product.attributes ?? product.highlights ?? [])
        .map((f) => (typeof f === 'string' ? f : `${f.key ?? f.name ?? ''}: ${f.value ?? ''}`.trim()))
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8),
      priceAmount,
      currency: product.currency ?? 'INR',
      compareAtAmount,
      imageUrls,
      availability: product.inStock === false || product.stock === 0 ? 'out of stock' : product.inStock === true || (product.stock ?? 1) > 0 ? 'in stock' : undefined,
      language: input.language,
      raw: product,
    };
  }
}

/* ---- Minimal, defensively-typed response shape for a Meesho partner/supplier
 * catalogue product-detail endpoint. Field names vary across partner
 * integrations, so multiple common aliases are accepted (only fields we
 * consume are declared; unrecognized fields are ignored). ---- */
interface MeeshoImage {
  url?: string;
}
interface MeeshoAttribute {
  key?: string;
  name?: string;
  value?: string;
}
interface MeeshoProduct {
  id?: string | number;
  productId?: string | number;
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  productUrl?: string;
  category?: string;
  categoryName?: string;
  category_name?: string;
  price?: number | string;
  sellingPrice?: number | string;
  selling_price?: number | string;
  mrp?: number | string;
  maxPrice?: number | string;
  max_price?: number | string;
  currency?: string;
  images?: (string | MeeshoImage)[];
  media?: (string | MeeshoImage)[];
  attributes?: (string | MeeshoAttribute)[];
  highlights?: (string | MeeshoAttribute)[];
  inStock?: boolean;
  stock?: number;
}
