/**
 * Shopify source — Admin REST API. Requires a store domain + Admin API access
 * token (custom app). Imports a product by numeric id or handle.
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { NotConfiguredError, NotFoundError, ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export interface ShopifyConfig {
  storeDomain: string; // my-store.myshopify.com
  adminToken: string;
  apiVersion: string; // 2024-10
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

export class ShopifySource extends BaseProductSource {
  readonly type: ProductSourceType = PST.shopify;
  private cfg: ShopifyConfig;

  constructor(storage: IStorage, cfg: ShopifyConfig, opts: BaseSourceOptions = {}) {
    super(storage, opts);
    this.cfg = cfg;
  }

  override isConfigured(): boolean {
    return !!(this.cfg.storeDomain && this.cfg.adminToken);
  }

  private base(): string {
    return `https://${this.cfg.storeDomain}/admin/api/${this.cfg.apiVersion}`;
  }
  private authHeaders(): Record<string, string> {
    return { 'X-Shopify-Access-Token': this.cfg.adminToken, 'content-type': 'application/json' };
  }

  override validate(input: ProductSourceInput): void {
    if (!input.productId && !input.url) throw new ValidationError('Shopify source requires a Product ID (numeric or handle) or product URL');
  }

  override async connect(): Promise<void> {
    if (!this.isConfigured()) throw new NotConfiguredError('shopify', ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN']);
    await httpJson(`${this.base()}/shop.json`, { provider: 'shopify', headers: this.authHeaders(), timeoutMs: 15_000 });
  }

  private resolveIdentifier(input: ProductSourceInput): { id?: string; handle?: string } {
    if (input.productId && /^\d+$/.test(input.productId.trim())) return { id: input.productId.trim() };
    const url = input.url ?? '';
    const idMatch = /\/products\/(\d+)/.exec(url);
    if (idMatch) return { id: idMatch[1] };
    const handleMatch = /\/products\/([a-z0-9-]+)/i.exec(url);
    if (handleMatch) return { handle: handleMatch[1] };
    if (input.productId) return { handle: input.productId.trim() };
    return {};
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    if (!this.isConfigured()) throw new NotConfiguredError('shopify', ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN']);
    const { id, handle } = this.resolveIdentifier(input);

    let product: ShopifyProduct | undefined;
    if (id) {
      const res = await httpJson<{ product: ShopifyProduct }>(`${this.base()}/products/${id}.json`, {
        provider: 'shopify',
        headers: this.authHeaders(),
      });
      product = res.product;
    } else if (handle) {
      const res = await httpJson<{ products: ShopifyProduct[] }>(`${this.base()}/products.json`, {
        provider: 'shopify',
        headers: this.authHeaders(),
        query: { handle, limit: 1 },
      });
      product = res.products?.[0];
    }
    if (!product) throw new NotFoundError('Shopify product not found', { id, handle });

    const variant = product.variants?.[0];
    return {
      source: PST.shopify,
      sourceUrl: input.url ?? `https://${this.cfg.storeDomain}/products/${product.handle}`,
      sourceProductId: String(product.id),
      title: product.title,
      brand: product.vendor,
      category: product.product_type,
      description: stripHtml(product.body_html ?? ''),
      features: stripHtml(product.body_html ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 3)
        .slice(0, 8),
      priceAmount: variant?.price ? Number(variant.price) : undefined,
      currency: 'USD',
      compareAtAmount: variant?.compare_at_price ? Number(variant.compare_at_price) : undefined,
      imageUrls: (product.images ?? []).map((im) => im.src).filter(Boolean),
      availability: variant && variant.inventory_quantity !== undefined ? (variant.inventory_quantity > 0 ? 'in stock' : 'out of stock') : undefined,
      language: input.language,
      raw: product,
    };
  }
}

interface ShopifyVariant {
  price?: string;
  compare_at_price?: string;
  inventory_quantity?: number;
}
interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  vendor?: string;
  product_type?: string;
  body_html?: string;
  variants?: ShopifyVariant[];
  images?: { src: string }[];
}
