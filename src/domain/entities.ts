/**
 * Core domain entities (pure data shapes shared across all layers).
 */
import type {
  AssetType,
  JobStatus,
  Platform,
  ProductSourceType,
  ProductStatus,
  PublicationStatus,
  Tone,
} from './enums.ts';

export interface Money {
  amount: number;
  currency: string; // ISO 4217, e.g. USD, INR
  formatted: string; // e.g. "$49.99"
  compareAtAmount?: number;
  compareAtFormatted?: string;
}

export type ImageRole = 'primary' | 'gallery' | 'lifestyle' | 'logo';

export interface ProductImage {
  url: string;
  localPath?: string;
  storageKey?: string;
  width?: number;
  height?: number;
  role: ImageRole;
  bytes?: number;
  mimeType?: string;
}

/** A product after normalization — the canonical shape every source produces. */
export interface NormalizedProduct {
  id: string;
  dedupeKey: string;
  source: ProductSourceType;
  sourceUrl?: string;
  sourceProductId?: string;
  title: string;
  brand?: string;
  category?: string;
  description: string;
  features: string[];
  price?: Money;
  images: ProductImage[];
  rating?: { value: number; count: number };
  availability?: string;
  language: string;
  raw?: unknown; // original payload, retained for audit
  importedAt: string;
}

export interface BrandProfile {
  name: string;
  primaryColor: string;
  accentColor: string;
  textColor: string;
  font: string;
  logoUrl?: string;
  logoLocalPath?: string;
  watermarkText?: string;
  cta: string;
  language: string;
}

/** Per-platform caption with alternate variations. */
export interface CaptionSet {
  platform: Platform;
  primary: string;
  variations: string[];
}

/** Full copy package produced by the AI Copy Engine. */
export interface GeneratedContent {
  id: string;
  productId: string;
  tone: Tone;
  language: string;
  captions: CaptionSet[];
  hooks: string[]; // 10
  ctas: string[]; // 5
  hashtags: string[]; // 30
  seoKeywords: string[];
  emojis: string[];
  provider: string;
  createdAt: string;
}

export interface GeneratedAsset {
  id: string;
  productId: string;
  type: AssetType;
  platform?: Platform;
  index?: number; // carousel slide index
  path: string;
  storageKey?: string;
  url?: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
}

export interface GeneratedVideo {
  id: string;
  productId: string;
  path: string;
  storageKey?: string;
  url?: string;
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  bytes: number;
  createdAt: string;
}

export interface Publication {
  id: string;
  productId: string;
  platform: Platform;
  accountId?: string;
  status: PublicationStatus;
  scheduledAt?: string;
  publishedAt?: string;
  remoteId?: string;
  permalink?: string;
  caption?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialAccount {
  id: string;
  platform: Platform;
  label: string;
  /** Encrypted credential blob (AES-256-GCM). Never stored or logged in plaintext. */
  encryptedCredentials: string;
  isDefault: boolean;
  createdAt: string;
}

export interface Job {
  id: string;
  type: string; // e.g. 'process_product' | 'publish'
  productRowId: string;
  productId?: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lockedBy?: string;
  lockedAt?: string;
  availableAt: string; // ISO — not eligible to run before this
  lastError?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LogEntry {
  id?: string;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  productId?: string;
  jobId?: string;
  data?: Record<string, unknown>;
}

export interface AnalyticsSnapshot {
  date: string;
  productsProcessed: number;
  postsPublished: number;
  videosCreated: number;
  queueSize: number;
  failedJobs: number;
  successRate: number; // 0..1
  avgProcessingMs: number;
}
