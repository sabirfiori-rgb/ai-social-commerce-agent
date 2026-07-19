/**
 * Pure selection helpers used by the pipeline and publish service.
 */
import type { GeneratedAsset, GeneratedContent } from '../domain/entities.ts';
import { ALL_PLATFORMS, ALL_TONES, type AssetType, type Platform, type Tone } from '../domain/enums.ts';
import type { ProductRow } from '../domain/sheet-schema.ts';

const PLATFORM_ASSET: Record<Platform, AssetType> = {
  instagram: 'instagram_post',
  facebook: 'facebook_image',
  linkedin: 'linkedin_image',
  pinterest: 'pinterest_pin',
  threads: 'instagram_post',
  x: 'instagram_post',
};

export function pickAssetForPlatform(assets: GeneratedAsset[], platform: Platform): GeneratedAsset | undefined {
  const want = PLATFORM_ASSET[platform];
  return (
    assets.find((a) => a.type === want && a.index === undefined) ??
    assets.find((a) => a.type === 'instagram_post' && a.index === undefined) ??
    assets.find((a) => a.index === undefined) ??
    assets[0]
  );
}

export function pickCaption(content: GeneratedContent, platform: Platform): string {
  const c = content.captions.find((x) => x.platform === platform);
  return c?.primary ?? content.captions[0]?.primary ?? '';
}

export function resolvePlatforms(row: ProductRow, available: Platform[]): Platform[] {
  const raw = (row.platform || '').trim();
  if (!raw) return available;
  const wanted = raw
    .split(/[,\s]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  const valid = wanted.filter((p): p is Platform => (ALL_PLATFORMS as string[]).includes(p));
  const filtered = valid.filter((p) => available.includes(p));
  return filtered.length ? filtered : available;
}

export function resolveTone(_row: ProductRow, fallback: string): Tone {
  return (ALL_TONES as string[]).includes(fallback) ? (fallback as Tone) : 'friendly';
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
