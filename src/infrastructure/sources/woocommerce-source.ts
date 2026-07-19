/**
 * WooCommerce source — WooCommerce REST API v3 (self-hosted WordPress/WooCommerce
 * stores). Requires a store base URL + REST API consumer key/secret (generated
 * under WooCommerce > Settings > Advanced > REST API). Imports a product by
 * numeric id.
 *
 * Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/#products
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { NotConfiguredError, NotFoundError, ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export interface WooCommerceConfig {
  baseUrl: string; // https://my-store.example.com (no trailing slash required)
  consumerKey: string;
  consumerSecret: string;
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

export class WooCommerceSource extends BaseProductSource {
  readonly type: ProductSourceType = PST.woocommerce;
  private cfg: WooCommerceConfig;

  constructor(storage: IStorage, cfg: WooCommerceConfig, opts: BaseSourceOptions = {}) {
    super(storage, opts);
    this.cfg = cfg;
  }

  override isConfigured(): boolean {
    return !!(this.cfg.baseUrl && this.cfg.consumerKey && this.cfg.consumerSecret);
  }

  private base(): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, '')}/wp-json/wc/v3`;
  }

  private authHeaders(): Record<string, string> {
    const token = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`, 'utf8').toString('base64');
    return { authorization: `Basic ${token}`, 'content-type': 'application/json' };
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('woocommerce', ['WOOCOMMERCE_BASE_URL', 'WOOCOMMERCE_CONSUMER_KEY', 'WOOCOMMERCE_CONSUMER_SECRET']);
    }
  }

  override validate(input: ProductSourceInput): void {
    if (!input.productId && !input.url) throw new ValidationError('WooCommerce source requires a Product ID (numeric) or product URL');
  }

  override async connect(): Promise<void> {
    this.requireConfig();
    await httpJson(`${this.base()}/products`, {
      provider: 'woocommerce',
      headers: this.authHeaders(),
      query: { per_page: 1 },
      timeoutMs: 15_000,
    });
  }

  private resolveId(input: ProductSourceInput): string | null {
    if (input.productId && /^\d+$/.test(input.productId.trim())) return input.productId.trim();
    const url = input.url ?? '';
    const idMatch = /[?&]product_id=(\d+)/.exec(url) ?? /\/product\/[^/]+\/?\?.*\bid=(\d+)/.exec(url);
    if (idMatch) return idMatch[1]!;
    return null;
  }

  private async resolveBySlug(slug: string): Promise<WooProduct | undefined> {
    const res = await httpJson<WooProduct[]>(`${this.base()}/products`, {
      provider: 'woocommerce',
      headers: this.authHeaders(),
      query: { slug, per_page: 1 },
    });
    return res?.[0];
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    this.requireConfig();
    const id = this.resolveId(input);

    let product: WooProduct | undefined;
    if (id) {
      product = await httpJson<WooProduct>(`${this.base()}/products/${id}`, {
        provider: 'woocommerce',
        headers: this.authHeaders(),
      });
    } else {
      const url = input.url ?? '';
      const slugMatch = /\/product\/([a-z0-9-]+)\/?/i.exec(url);
      const slug = slugMatch?.[1] ?? input.productId?.trim();
      if (slug) product = await this.resolveBySlug(slug);
    }
    if (!product) throw new NotFoundError('WooCommerce product not found', { id, url: input.url, productId: input.productId });

    const description = stripHtml(product.description || product.short_description || '');
    const price = product.price !== undefined && product.price !== '' ? Number(product.price) : undefined;
    const regular = product.regular_price !== undefined && product.regular_price !== '' ? Number(product.regular_price) : undefined;
    const sale = product.sale_price !== undefined && product.sale_price !== '' ? Number(product.sale_price) : undefined;
    const priceAmount = price ?? sale ?? regular;
    const compareAtAmount = priceAmount !== undefined && regular !== undefined && regular > priceAmount ? regular : undefined;

    return {
      source: PST.woocommerce,
      sourceUrl: product.permalink ?? input.url,
      sourceProductId: String(product.id),
      title: product.name ?? `WooCommerce product ${product.id}`,
      category: product.categories?.[0]?.name,
      description,
      features: (product.attributes ?? [])
        .map((a) => (a.options?.length ? `${a.name}: ${a.options.join(', ')}` : a.name))
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8),
      priceAmount,
      currency: 'USD',
      compareAtAmount,
      imageUrls: (product.images ?? []).map((im) => im.src).filter(Boolean),
      availability: product.stock_status,
      language: input.language,
      raw: product,
    };
  }
}

/* ---- Minimal WooCommerce REST API v3 response typings (only fields we consume) ---- */
interface WooCategory {
  name: string;
}
interface WooImage {
  src: string;
}
interface WooAttribute {
  name: string;
  options?: string[];
}
interface WooProduct {
  id: number;
  name?: string;
  slug?: string;
  permalink?: string;
  description?: string;
  short_description?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  stock_status?: string;
  categories?: WooCategory[];
  images?: WooImage[];
  attributes?: WooAttribute[];
}
