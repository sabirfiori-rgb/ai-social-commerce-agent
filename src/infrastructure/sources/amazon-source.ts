/**
 * Amazon source — Product Advertising API v5 (GetItems), the ONLY authorized
 * way to pull Amazon product data. Requests are signed with AWS SigV4.
 * No page scraping is performed anywhere in this codebase.
 *
 * Requires an approved Associate account with PA-API access:
 *   AMAZON_PAAPI_ACCESS_KEY, AMAZON_PAAPI_SECRET_KEY, AMAZON_PAAPI_PARTNER_TAG.
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import { ProductSourceType as PST } from '../../domain/enums.ts';
import type { IStorage, ProductSourceInput, RawProduct } from '../../domain/ports.ts';
import { NotConfiguredError, ValidationError, ExternalApiError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { signAwsV4 } from '../../shared/aws-sigv4.ts';
import { BaseProductSource, type BaseSourceOptions } from './base-source.ts';

export interface AmazonConfig {
  accessKey: string;
  secretKey: string;
  partnerTag: string;
  host: string; // webservices.amazon.com
  region: string; // us-east-1
  marketplace?: string; // www.amazon.com
}

const RESOURCES = [
  'ItemInfo.Title',
  'ItemInfo.Features',
  'ItemInfo.ByLineInfo',
  'ItemInfo.Classifications',
  'ItemInfo.ProductInfo',
  'Images.Primary.Large',
  'Images.Variants.Large',
  'Offers.Listings.Price',
  'CustomerReviews.Count',
  'CustomerReviews.StarRating',
];

export class AmazonSource extends BaseProductSource {
  readonly type: ProductSourceType = PST.amazon;
  private cfg: AmazonConfig;

  constructor(storage: IStorage, cfg: AmazonConfig, opts: BaseSourceOptions = {}) {
    super(storage, opts);
    this.cfg = cfg;
  }

  override isConfigured(): boolean {
    return !!(this.cfg.accessKey && this.cfg.secretKey && this.cfg.partnerTag);
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('amazon', ['AMAZON_PAAPI_ACCESS_KEY', 'AMAZON_PAAPI_SECRET_KEY', 'AMAZON_PAAPI_PARTNER_TAG']);
    }
  }

  static extractAsin(input: ProductSourceInput): string | null {
    if (input.productId && /^[A-Z0-9]{10}$/i.test(input.productId.trim())) return input.productId.trim().toUpperCase();
    const url = input.url ?? '';
    const m = /(?:\/dp\/|\/gp\/product\/|\/product\/|asin=)([A-Z0-9]{10})/i.exec(url);
    return m ? m[1]!.toUpperCase() : null;
  }

  override validate(input: ProductSourceInput): void {
    if (!AmazonSource.extractAsin(input)) {
      throw new ValidationError('Amazon source requires a valid 10-character ASIN (Product ID) or an Amazon product URL');
    }
  }

  override async connect(): Promise<void> {
    this.requireConfig();
  }

  async importProduct(input: ProductSourceInput): Promise<RawProduct> {
    this.requireConfig();
    const asin = AmazonSource.extractAsin(input);
    if (!asin) throw new ValidationError('Could not determine ASIN for Amazon import');

    const payload = JSON.stringify({
      ItemIds: [asin],
      Resources: RESOURCES,
      PartnerTag: this.cfg.partnerTag,
      PartnerType: 'Associates',
      Marketplace: this.cfg.marketplace || 'www.amazon.com',
    });

    const path = '/paapi5/getitems';
    const target = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems';
    const signed = signAwsV4({
      method: 'POST',
      host: this.cfg.host,
      path,
      region: this.cfg.region,
      service: 'ProductAdvertisingAPI',
      accessKey: this.cfg.accessKey,
      secretKey: this.cfg.secretKey,
      headers: {
        'content-encoding': 'amz-1.0',
        'content-type': 'application/json; charset=utf-8',
        'x-amz-target': target,
      },
      body: payload,
    });

    const data = await httpJson<AmazonGetItemsResponse>(`https://${this.cfg.host}${path}`, {
      method: 'POST',
      provider: 'amazon-paapi',
      headers: {
        ...signed.headers,
        'content-encoding': 'amz-1.0',
        'content-type': 'application/json; charset=utf-8',
        'x-amz-target': target,
      },
      body: payload,
      timeoutMs: 20_000,
    });

    const item = data.ItemsResult?.Items?.[0];
    if (!item) {
      throw new ExternalApiError('amazon-paapi', 'No item returned for ASIN', { responseBody: data.Errors });
    }
    return this.mapItem(item, asin);
  }

  private mapItem(item: AmazonItem, asin: string): RawProduct {
    const info = item.ItemInfo ?? {};
    const listing = item.Offers?.Listings?.[0];
    const images: string[] = [];
    if (item.Images?.Primary?.Large?.URL) images.push(item.Images.Primary.Large.URL);
    for (const v of item.Images?.Variants ?? []) if (v.Large?.URL) images.push(v.Large.URL);

    return {
      source: PST.amazon,
      sourceUrl: item.DetailPageURL,
      sourceProductId: asin,
      title: info.Title?.DisplayValue ?? `Amazon product ${asin}`,
      brand: info.ByLineInfo?.Brand?.DisplayValue ?? info.ByLineInfo?.Manufacturer?.DisplayValue,
      category: info.Classifications?.ProductGroup?.DisplayValue,
      description: (info.Features?.DisplayValues ?? []).join('. '),
      features: info.Features?.DisplayValues ?? [],
      priceAmount: listing?.Price?.Amount,
      currency: listing?.Price?.Currency,
      compareAtAmount: listing?.Price?.Savings ? (listing.Price.Amount ?? 0) + (listing.Price.Savings.Amount ?? 0) : undefined,
      imageUrls: images,
      rating: item.CustomerReviews?.StarRating
        ? { value: Number(item.CustomerReviews.StarRating.Value ?? 0), count: Number(item.CustomerReviews.Count ?? 0) }
        : undefined,
      raw: item,
    };
  }
}

/* ---- Minimal PA-API response typings (only the fields we consume) ---- */
interface DisplayValue<T = string> {
  DisplayValue: T;
}
interface AmazonImage {
  URL?: string;
}
interface AmazonItem {
  ASIN?: string;
  DetailPageURL?: string;
  ItemInfo?: {
    Title?: DisplayValue;
    Features?: { DisplayValues?: string[] };
    ByLineInfo?: { Brand?: DisplayValue; Manufacturer?: DisplayValue };
    Classifications?: { ProductGroup?: DisplayValue };
    ProductInfo?: Record<string, unknown>;
  };
  Images?: { Primary?: { Large?: AmazonImage }; Variants?: { Large?: AmazonImage }[] };
  Offers?: { Listings?: { Price?: { Amount?: number; Currency?: string; Savings?: { Amount?: number } } }[] };
  CustomerReviews?: { Count?: number | string; StarRating?: { Value?: number | string } };
}
interface AmazonGetItemsResponse {
  ItemsResult?: { Items?: AmazonItem[] };
  Errors?: unknown;
}
