/**
 * Creative engine — turns a product + copy into branded PNG assets for every
 * requested format (plus a multi-slide carousel), using the SVG templates and
 * the resvg rasterizer, persisting each asset to storage.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { GeneratedAsset } from '../../domain/entities.ts';
import { ASSET_DIMENSIONS, AssetType } from '../../domain/enums.ts';
import type { CreativeContext, ICreativeEngine, IImageRasterizer, IStorage } from '../../domain/ports.ts';
import { nowIso } from '../../shared/clock.ts';
import { prefixedId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { resolveFontFamily, loadFontBuffers } from './fonts.ts';
import { buildCarouselSlide, buildTemplate, type EmbeddedImage } from './templates.ts';

const log = createLogger({ mod: 'creative' });

const DEFAULT_TYPES: AssetType[] = [
  AssetType.instagram_post,
  AssetType.story,
  AssetType.pinterest_pin,
  AssetType.facebook_image,
  AssetType.linkedin_image,
];

export class CreativeEngine implements ICreativeEngine {
  private rasterizer: IImageRasterizer;
  private storage: IStorage;
  private family: string;
  private carouselSlides: number;

  constructor(rasterizer: IImageRasterizer, storage: IStorage, opts: { brandFont?: string; carouselSlides?: number } = {}) {
    this.rasterizer = rasterizer;
    this.storage = storage;
    this.family = resolveFontFamily(opts.brandFont, loadFontBuffers().families);
    this.carouselSlides = Math.max(3, Math.min(6, opts.carouselSlides ?? 5));
  }

  private loadPrimaryImage(ctx: CreativeContext): EmbeddedImage | undefined {
    const img = ctx.product.images.find((i) => i.role === 'primary') ?? ctx.product.images[0];
    if (!img) return undefined;
    try {
      if (img.localPath && existsSync(img.localPath)) {
        return { buffer: readFileSync(img.localPath), mime: img.mimeType ?? 'image/jpeg' };
      }
    } catch (e) {
      log.warn('failed to load primary image; using placeholder', { error: (e as Error).message });
    }
    return undefined;
  }

  async generate(ctx: CreativeContext): Promise<GeneratedAsset[]> {
    const types = ctx.assetTypes ?? DEFAULT_TYPES;
    const family = resolveFontFamily(ctx.brand.font, loadFontBuffers().families) || this.family;
    const image = this.loadPrimaryImage(ctx);
    const out: GeneratedAsset[] = [];

    for (const type of types) {
      const dims = ASSET_DIMENSIONS[type];
      const svg = buildTemplate(type, { product: ctx.product, brand: ctx.brand, content: ctx.content, image, family, width: dims.width, height: dims.height });
      const png = await this.rasterizer.render({ svg });
      const asset = await this.store(ctx.product.id, type, png, dims, undefined);
      out.push(asset);
      log.debug('asset rendered', { type, bytes: png.length });
    }

    // Carousel: hero + feature slides + cta
    const dims = ASSET_DIMENSIONS[AssetType.carousel];
    const featureCount = Math.max(1, Math.min(this.carouselSlides - 2, ctx.product.features.length));
    const slides: { kind: 'hero' | 'feature' | 'cta'; index: number; featureIndex?: number; feature?: string }[] = [
      { kind: 'hero', index: 0 },
    ];
    for (let i = 0; i < featureCount; i++) slides.push({ kind: 'feature', index: i + 1, featureIndex: i, feature: ctx.product.features[i] });
    slides.push({ kind: 'cta', index: featureCount + 1 });

    for (const slide of slides) {
      const svg = buildCarouselSlide(
        { product: ctx.product, brand: ctx.brand, content: ctx.content, image, family, width: dims.width, height: dims.height },
        slide,
      );
      const png = await this.rasterizer.render({ svg });
      const asset = await this.store(ctx.product.id, AssetType.carousel, png, dims, slide.index);
      out.push(asset);
    }

    log.info('creative assets generated', { productId: ctx.product.id, count: out.length });
    return out;
  }

  private async store(
    productId: string,
    type: AssetType,
    png: Buffer,
    dims: { width: number; height: number },
    index?: number,
  ): Promise<GeneratedAsset> {
    const suffix = index === undefined ? type : `${type}-${index}`;
    const key = `assets/${productId}/${suffix}.png`;
    const stored = await this.storage.put(key, png, 'image/png');
    return {
      id: prefixedId('ast'),
      productId,
      type,
      index,
      path: stored.path,
      storageKey: stored.key,
      url: stored.url,
      width: dims.width,
      height: dims.height,
      bytes: png.length,
      createdAt: nowIso(),
    };
  }
}
