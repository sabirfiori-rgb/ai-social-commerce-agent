/**
 * Etsy source — Etsy Open API v3. Requires an Etsy app API key (keystring) and
 * an OAuth2 access token (PKCE flow, scope `listings_r`) obtained for that key.
 * Imports a listing by numeric listing id, then fetches its images separately
 * (image URLs are not embedded in the base listing payload).
 *
 * Docs:
 *  - Get listing: https://developer.etsy.com/documentation/reference#operation/getListing
 *  - Get listing images: https://developer.etsy.com/documentation/reference#operation/getListingImages
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { NotConfiguredError, NotFoundError, ValidationError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export interface EtsyConfig {
  apiKey: string; // Etsy app "keystring"
  accessToken: string; // OAuth2 access token for the connected Etsy account
  shopId?: string; // optional, used for the connectivity ping
}

const API_BASE = 'https://openapi.etsy.com/v3/application';

export class EtsySource extends BaseProductSource {
  readonly type: ProductSourceType = PST.etsy;
  private cfg: EtsyConfig;

  constructor(storage: IStorage, cfg: EtsyConfig, opts: BaseSourceOptions = {}) {
    super(storage, opts);
    this.cfg = cfg;
  }

  override isConfigured(): boolean {
    return !!(this.cfg.apiKey && this.cfg.accessToken);
  }

  private authHeaders(): Record<string, string> {
    return { 'x-api-key': this.cfg.apiKey, authorization: `Bearer ${this.cfg.accessToken}` };
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('etsy', ['ETSY_API_KEY', 'ETSY_ACCESS_TOKEN']);
    }
  }

  override validate(input: ProductSourceInput): void {
    if (!this.extractListingId(input)) {
      throw new ValidationError('Etsy source requires a numeric Listing ID (Product ID) or an Etsy listing URL');
    }
  }

  override async connect(): Promise<void> {
    this.requireConfig();
    // The one unauthenticated-but-key-gated ping available to every app: fetch
    // the app's own rate-limit-relevant "ping" style endpoint via ITunes... not
    // applicable here, so verify by hitting a lightweight, key-scoped endpoint.
    await httpJson(`${API_BASE}/openapi-ping`, {
      provider: 'etsy',
      headers: this.authHeaders(),
      timeoutMs: 15_000,
    });
  }

  private extractListingId(input: ProductSourceInput): string | null {
    if (input.productId && /^\d+$/.test(input.productId.trim())) return input.productId.trim();
    const url = input.url ?? '';
    const m = /\/listing\/(\d+)/.exec(url);
    return m ? m[1]! : null;
  }

  private largestImageUrl(img: EtsyListingImage): string | undefined {
    return img.url_fullxfull || img.url_570xN || img.url_170x135 || img.url_75x75;
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    this.requireConfig();
    const listingId = this.extractListingId(input);
    if (!listingId) throw new ValidationError('Could not determine Etsy listing id');

    const listing = await httpJson<EtsyListing>(`${API_BASE}/listings/${listingId}`, {
      provider: 'etsy',
      headers: this.authHeaders(),
    });
    if (!listing || !listing.listing_id) throw new NotFoundError('Etsy listing not found', { listingId });

    let imageUrls: string[] = [];
    try {
      const imagesRes = await httpJson<{ results?: EtsyListingImage[] }>(`${API_BASE}/listings/${listingId}/images`, {
        provider: 'etsy',
        headers: this.authHeaders(),
      });
      imageUrls = (imagesRes.results ?? [])
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
        .map((img) => this.largestImageUrl(img))
        .filter((u): u is string => !!u);
    } catch (e) {
      this.log.warn('etsy: failed to fetch listing images', { listingId, error: (e as Error).message });
    }

    const priceAmount = listing.price ? listing.price.amount / listing.price.divisor : undefined;

    return {
      source: PST.etsy,
      sourceUrl: listing.url,
      sourceProductId: String(listing.listing_id),
      title: listing.title ?? `Etsy listing ${listing.listing_id}`,
      category: listing.taxonomy_path?.[listing.taxonomy_path.length - 1],
      description: (listing.description ?? '').trim(),
      features: (listing.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 8),
      priceAmount,
      currency: listing.price?.currency_code,
      imageUrls,
      availability: listing.state === 'active' && (listing.quantity ?? 0) > 0 ? 'in stock' : 'out of stock',
      language: input.language ?? listing.language,
      raw: listing,
    };
  }
}

/* ---- Minimal Etsy Open API v3 response typings (only fields we consume) ---- */
interface EtsyPrice {
  amount: number;
  divisor: number;
  currency_code: string;
}
interface EtsyListing {
  listing_id: number;
  title?: string;
  description?: string;
  url?: string;
  state?: string;
  quantity?: number;
  language?: string;
  tags?: string[];
  taxonomy_path?: string[];
  price?: EtsyPrice;
}
interface EtsyListingImage {
  rank?: number;
  url_75x75?: string;
  url_170x135?: string;
  url_570xN?: string;
  url_fullxfull?: string;
}
