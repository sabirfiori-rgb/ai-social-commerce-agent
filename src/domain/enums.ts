/**
 * Domain enumerations.
 * Implemented as `as const` objects + union types so they are fully erasable
 * (Node's native TypeScript type-stripping does not support `enum`).
 */

export const ProductStatus = {
  NEW: 'NEW',
  PROCESSING: 'PROCESSING',
  PRODUCT_IMPORTED: 'PRODUCT_IMPORTED',
  CONTENT_CREATED: 'CONTENT_CREATED',
  VIDEO_CREATED: 'VIDEO_CREATED',
  POSTED: 'POSTED',
  FAILED: 'FAILED',
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];
export const ALL_PRODUCT_STATUSES = Object.values(ProductStatus);

/** Ordered pipeline progression for PROCESSING → POSTED. */
export const STATUS_PROGRESSION: ProductStatus[] = [
  ProductStatus.NEW,
  ProductStatus.PROCESSING,
  ProductStatus.PRODUCT_IMPORTED,
  ProductStatus.CONTENT_CREATED,
  ProductStatus.VIDEO_CREATED,
  ProductStatus.POSTED,
];

export const JobStatus = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  DEAD: 'DEAD', // exhausted all retries
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const Platform = {
  instagram: 'instagram',
  facebook: 'facebook',
  linkedin: 'linkedin',
  pinterest: 'pinterest',
  threads: 'threads',
  x: 'x',
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];
export const ALL_PLATFORMS = Object.values(Platform);

export const ProductSourceType = {
  amazon: 'amazon',
  shopify: 'shopify',
  woocommerce: 'woocommerce',
  etsy: 'etsy',
  flipkart: 'flipkart',
  meesho: 'meesho',
  csv: 'csv',
  manual: 'manual',
} as const;
export type ProductSourceType = (typeof ProductSourceType)[keyof typeof ProductSourceType];
export const ALL_SOURCE_TYPES = Object.values(ProductSourceType);

export const Tone = {
  professional: 'professional',
  friendly: 'friendly',
  luxury: 'luxury',
  minimal: 'minimal',
  funny: 'funny',
  sales: 'sales',
  urgent: 'urgent',
} as const;
export type Tone = (typeof Tone)[keyof typeof Tone];
export const ALL_TONES = Object.values(Tone);

export const AssetType = {
  instagram_post: 'instagram_post',
  carousel: 'carousel',
  story: 'story',
  pinterest_pin: 'pinterest_pin',
  facebook_image: 'facebook_image',
  linkedin_image: 'linkedin_image',
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];
export const ALL_ASSET_TYPES = Object.values(AssetType);

export const PublicationStatus = {
  scheduled: 'scheduled',
  published: 'published',
  dry_run: 'dry_run',
  failed: 'failed',
  skipped: 'skipped',
} as const;
export type PublicationStatus = (typeof PublicationStatus)[keyof typeof PublicationStatus];

/** Canonical pixel dimensions per asset type. */
export const ASSET_DIMENSIONS: Record<AssetType, { width: number; height: number }> = {
  instagram_post: { width: 1080, height: 1350 },
  carousel: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  pinterest_pin: { width: 1000, height: 1500 },
  facebook_image: { width: 1200, height: 1200 },
  linkedin_image: { width: 1200, height: 1200 },
};
