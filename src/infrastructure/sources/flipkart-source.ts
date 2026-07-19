/**
 * Flipkart source — Flipkart Affiliate API v1.0 (Product API, query by Product ID).
 * Requires an approved Flipkart Affiliate account: an Affiliate Tracking ID and
 * an API Token, generated from https://affiliate.flipkart.com/ under
 * API > API Token. Imports a product by its Flipkart Product ID (dpid, e.g.
 * "MOBFK4REY6GGXSAY") or a flipkart.com product URL containing `pid=`.
 *
 * Docs: https://affiliate.flipkart.com/api-docs/af_prod_ref.html
 *   GET https://affiliate-api.flipkart.net/affiliate/1.0/product.json?id={productId}
 *   Headers: Fk-Affiliate-Id, Fk-Affiliate-Token
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { ExternalApiError, NotConfiguredError, NotFoundError, ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export interface FlipkartConfig {
  affiliateId: string;
  affiliateToken: string;
}

const API_BASE = 'https://affiliate-api.flipkart.net/affiliate/1.0';

export class FlipkartSource extends BaseProductSource {
  readonly type: ProductSourceType = PST.flipkart;
  private cfg: FlipkartConfig;

  constructor(storage: IStorage, cfg: FlipkartConfig, opts: BaseSourceOptions = {}) {
    super(storage, opts);
    this.cfg = cfg;
  }

  override isConfigured(): boolean {
    return !!(this.cfg.affiliateId && this.cfg.affiliateToken);
  }

  private authHeaders(): Record<string, string> {
    return { 'Fk-Affiliate-Id': this.cfg.affiliateId, 'Fk-Affiliate-Token': this.cfg.affiliateToken };
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('flipkart', ['FLIPKART_AFFILIATE_ID', 'FLIPKART_AFFILIATE_TOKEN']);
    }
  }

  private extractDpid(input: ProductSourceInput): string | null {
    if (input.productId && input.productId.trim()) return input.productId.trim();
    const url = input.url ?? '';
    const m = /[?&]pid=([A-Z0-9]+)/i.exec(url);
    return m ? m[1]!.toUpperCase() : null;
  }

  override validate(input: ProductSourceInput): void {
    if (!this.extractDpid(input)) {
      throw new ValidationError('Flipkart source requires a Flipkart Product ID (dpid, e.g. "MOBFK4REY6GGXSAY") or a product URL containing a `pid` query parameter');
    }
  }

  override async connect(): Promise<void> {
    this.requireConfig();
    // No dedicated ping endpoint is documented; the Product API itself is the
    // cheapest authenticated call, so validate credentials with a benign lookup
    // that only checks header acceptance (a 401/403 surfaces bad credentials,
    // while a 404 for a bogus id still proves the headers were accepted).
    try {
      await httpJson(`${API_BASE}/product.json`, {
        provider: 'flipkart',
        headers: this.authHeaders(),
        query: { id: 'CONNECTIVITY-CHECK' },
        timeoutMs: 15_000,
      });
    } catch (e) {
      if (e instanceof ExternalApiError && e.httpStatus === 404) return; // credentials accepted; id simply doesn't exist
      throw e;
    }
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    this.requireConfig();
    const dpid = this.extractDpid(input);
    if (!dpid) throw new ValidationError('Could not determine Flipkart Product ID (dpid)');

    let data: FlipkartProductResponse;
    try {
      data = await httpJson<FlipkartProductResponse>(`${API_BASE}/product.json`, {
        provider: 'flipkart',
        headers: this.authHeaders(),
        query: { id: dpid },
        timeoutMs: 20_000,
      });
    } catch (e) {
      if (e instanceof ExternalApiError && e.httpStatus === 404) throw new NotFoundError('Flipkart product not found', { dpid });
      throw e;
    }

    const info = data.productBaseInfoV1;
    if (!info) throw new NotFoundError('Flipkart product not found', { dpid });

    const mrp = info.maximumRetailPrice?.amount;
    const selling = info.flipkartSellingPrice?.amount ?? info.flipkartSpecialPrice?.amount ?? info.sellingPrice?.amount;
    const priceAmount = selling ?? mrp;
    const compareAtAmount = priceAmount !== undefined && mrp !== undefined && mrp > priceAmount ? mrp : undefined;
    const currency = info.flipkartSellingPrice?.currency ?? info.maximumRetailPrice?.currency ?? info.sellingPrice?.currency ?? 'INR';

    const imageUrls = Object.values(info.imageUrls ?? {}).filter(Boolean);
    const keySpecs = data.categorySpecificInfoV1?.keySpecs ?? [];

    return {
      source: PST.flipkart,
      sourceUrl: info.productUrl ?? input.url,
      sourceProductId: info.productId ?? dpid,
      title: info.title ?? `Flipkart product ${dpid}`,
      brand: info.productBrand,
      category: this.lastCategoryNode(info.categoryPath),
      description: info.productDescription && info.productDescription !== 'NA' ? info.productDescription : keySpecs.join('. '),
      features: keySpecs.map((s) => s.trim()).filter(Boolean).slice(0, 8),
      priceAmount,
      currency,
      compareAtAmount,
      imageUrls,
      availability: info.inStock === false ? 'out of stock' : info.inStock === true ? 'in stock' : undefined,
      language: input.language,
      raw: data,
    };
  }

  /** categoryPath is documented as either a `>`-joined string (feed API) or a
   * JSON-encoded array of `{node_id, node_name}` hierarchies (some responses).
   * Extract a human-readable leaf category name from whichever shape shows up. */
  private lastCategoryNode(categoryPath?: string): string | undefined {
    if (!categoryPath) return undefined;
    const trimmed = categoryPath.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as { node_name?: string }[][];
        const flat = parsed.flat();
        const last = flat[flat.length - 1];
        if (last?.node_name) return last.node_name;
      } catch {
        /* fall through to string handling */
      }
    }
    const parts = trimmed.split('>').map((p) => p.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : undefined;
  }
}

/* ---- Minimal Flipkart Affiliate API v1.0 response typings (only fields we consume) ---- */
interface FlipkartMoney {
  amount?: number;
  currency?: string;
}
interface FlipkartProductBaseInfo {
  productId?: string;
  title?: string;
  productDescription?: string;
  productBrand?: string;
  productUrl?: string;
  categoryPath?: string;
  inStock?: boolean;
  imageUrls?: Record<string, string>;
  maximumRetailPrice?: FlipkartMoney;
  flipkartSellingPrice?: FlipkartMoney;
  flipkartSpecialPrice?: FlipkartMoney;
  sellingPrice?: FlipkartMoney;
}
interface FlipkartCategorySpecificInfo {
  keySpecs?: string[];
}
interface FlipkartProductResponse {
  productBaseInfoV1?: FlipkartProductBaseInfo;
  categorySpecificInfoV1?: FlipkartCategorySpecificInfo;
}
