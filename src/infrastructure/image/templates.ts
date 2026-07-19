/**
 * Brand-aware SVG templates for every social format. Each builder returns a
 * complete SVG document string that the resvg rasterizer turns into a PNG.
 * Design language: bold display type, brand-color gradient field, product in a
 * soft-shadowed card, accent price pill, and a clean CTA — premium and legible.
 */
import type { BrandProfile, GeneratedContent, NormalizedProduct } from '../../domain/entities.ts';
import type { AssetType } from '../../domain/enums.ts';
import {
  embedImage,
  esc,
  icon,
  iconForIndex,
  linearGradient,
  normalizeHex,
  pill,
  readableText,
  roundedRect,
  shade,
  svgDocument,
  textBlock,
  wrapText,
} from './svg-kit.ts';

export interface EmbeddedImage {
  buffer: Buffer;
  mime: string;
}

export interface TemplateInput {
  product: NormalizedProduct;
  brand: BrandProfile;
  content?: GeneratedContent;
  image?: EmbeddedImage;
  family: string;
  width: number;
  height: number;
}

export interface CarouselSlide {
  kind: 'hero' | 'feature' | 'cta';
  feature?: string;
  index: number;
  featureIndex?: number;
}

function bgAndDefs(brand: BrandProfile, w: number, h: number): { defs: string; body: string } {
  const primary = normalizeHex(brand.primaryColor, '#0F2027');
  const accent = normalizeHex(brand.accentColor, '#E63946');
  const defs = [
    linearGradient('bg', shade(primary, 0.05), shade(primary, -0.4), 145),
    linearGradient('accent', accent, shade(accent, -0.2), 120),
    linearGradient('scrim', 'rgba(0,0,0,0)', shade(primary, -0.55), 90),
  ].join('');
  const body = [
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    `<circle cx="${w * 0.82}" cy="${h * 0.14}" r="${w * 0.5}" fill="${accent}" opacity="0.10"/>`,
    `<circle cx="${w * 0.1}" cy="${h * 0.92}" r="${w * 0.42}" fill="${shade(primary, 0.5)}" opacity="0.06"/>`,
  ].join('');
  return { defs, body };
}

function brandHeader(brand: BrandProfile, family: string, x: number, y: number, size = 34): string {
  const label = (brand.watermarkText || brand.name || '').trim();
  if (!label) return '';
  const accent = normalizeHex(brand.accentColor, '#E63946');
  return `${roundedRect(x, y - size * 0.7, size * 0.5, size * 0.5, size * 0.12, accent)}
    <text x="${x + size * 0.75}" y="${y}" font-family="${family}" font-size="${size * 0.62}" font-weight="700" fill="#ffffff" opacity="0.92" letter-spacing="1.5">${esc(label.toUpperCase())}</text>`;
}

function productCard(
  image: EmbeddedImage | undefined,
  brand: BrandProfile,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = 44,
): string {
  const shadow = roundedRect(x + 8, y + 16, w, h, radius, '#000000', { opacity: 0.28 });
  if (image) {
    const clip = `pc${Math.round(x)}${Math.round(y)}`;
    return `${shadow}${roundedRect(x, y, w, h, radius, '#ffffff')}${embedImage(image.buffer, image.mime, x, y, w, h, { clipId: clip, radius })}`;
  }
  // Branded placeholder when no product photo is available.
  const accent = normalizeHex(brand.accentColor, '#E63946');
  const initials = (brand.name || 'AC').slice(0, 2).toUpperCase();
  return `${shadow}${roundedRect(x, y, w, h, radius, shade(normalizeHex(brand.primaryColor), 0.12))}
    <text x="${x + w / 2}" y="${y + h / 2}" font-family="Poppins" font-size="${Math.min(w, h) * 0.28}" font-weight="800" fill="${accent}" text-anchor="middle" dominant-baseline="central" opacity="0.85">${esc(initials)}</text>`;
}

function priceBlock(product: NormalizedProduct, brand: BrandProfile, family: string, x: number, y: number, size = 60): string {
  if (!product.price) return '';
  const accent = normalizeHex(brand.accentColor, '#E63946');
  const parts = [pill(x, y, product.price.formatted, { fill: accent, textFill: readableText(accent), fontSize: size, family, weight: 800, height: size * 1.7 })];
  if (product.price.compareAtFormatted) {
    parts.push(
      `<text x="${x + product.price.formatted.length * size * 0.62 + 96}" y="${y + size * 1.05}" font-family="${family}" font-size="${size * 0.6}" font-weight="600" fill="#ffffff" opacity="0.6" text-decoration="line-through">${esc(product.price.compareAtFormatted)}</text>`,
    );
  }
  return parts.join('');
}

function ctaPill(brand: BrandProfile, family: string, x: number, y: number, size = 46): string {
  const text = (brand.cta || 'Shop now').trim();
  return pill(x, y, `${text}  →`, { fill: '#ffffff', textFill: '#111318', fontSize: size, family, weight: 700, height: size * 1.8 });
}

function ratingStars(product: NormalizedProduct, family: string, x: number, y: number, size = 30): string {
  if (!product.rating || !product.rating.value) return '';
  const full = Math.round(product.rating.value);
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += icon('star', x + i * (size + 8), y, size, i < full ? '#FFC857' : 'rgba(255,255,255,0.3)', 2);
  }
  out += `<text x="${x + 5 * (size + 8) + 12}" y="${y + size * 0.85}" font-family="${family}" font-size="${size * 0.8}" fill="#ffffff" opacity="0.8">${product.rating.value.toFixed(1)} (${product.rating.count})</text>`;
  return out;
}

/* ------------------------------ templates ------------------------------ */

function buildStandard(input: TemplateInput): string {
  // Used for instagram_post (1080x1350) and adapts to facebook/linkedin squares.
  const { brand, product, family, width: w, height: h } = input;
  const { defs, body } = bgAndDefs(brand, w, h);
  const pad = Math.round(w * 0.075);
  const titleLines = wrapText(product.title, Math.round(w / (w * 0.052)), 3);
  const cardTop = Math.round(h * 0.34);
  const cardH = Math.round(h * 0.40);
  const cardW = w - pad * 2;

  const parts = [
    body,
    brandHeader(brand, family, pad, Math.round(h * 0.07)),
    product.category
      ? `<text x="${pad}" y="${Math.round(h * 0.125)}" font-family="${family}" font-size="${Math.round(w * 0.028)}" font-weight="600" fill="${normalizeHex(brand.accentColor)}" letter-spacing="3">${esc(product.category.toUpperCase())}</text>`
      : '',
    textBlock(titleLines, { x: pad, y: Math.round(h * 0.185), fontSize: Math.round(w * 0.062), lineHeight: Math.round(w * 0.07), fill: '#ffffff', family, weight: 800 }),
    productCard(input.image, brand, pad, cardTop, cardW, cardH),
    priceBlock(product, brand, family, pad, Math.round(h * 0.80), Math.round(w * 0.055)),
    ctaPill(brand, family, Math.round(w * 0.6), Math.round(h * 0.80), Math.round(w * 0.042)),
    ratingStars(product, family, pad, Math.round(h * 0.915), Math.round(w * 0.03)),
  ];
  return svgDocument(w, h, defs, parts.join('\n'));
}

function buildStory(input: TemplateInput): string {
  const { brand, product, family, width: w, height: h } = input;
  const { defs, body } = bgAndDefs(brand, w, h);
  const pad = Math.round(w * 0.08);
  const imgH = Math.round(h * 0.60);
  const titleLines = wrapText(product.title, 20, 3);
  const parts = [
    body,
    input.image
      ? embedImage(input.image.buffer, input.image.mime, 0, 0, w, imgH, { clipId: 'story', preserve: 'xMidYMid slice' })
      : productCard(undefined, brand, pad, Math.round(h * 0.12), w - pad * 2, imgH - Math.round(h * 0.12)),
    `<rect x="0" y="${imgH - 220}" width="${w}" height="${h - imgH + 220}" fill="url(#scrim)"/>`,
    brandHeader(brand, family, pad, Math.round(h * 0.07)),
    textBlock(titleLines, { x: pad, y: Math.round(h * 0.70), fontSize: Math.round(w * 0.075), lineHeight: Math.round(w * 0.085), fill: '#ffffff', family, weight: 800 }),
    priceBlock(product, brand, family, pad, Math.round(h * 0.85), Math.round(w * 0.06)),
    ctaPill(brand, family, pad, Math.round(h * 0.92), Math.round(w * 0.045)),
  ];
  return svgDocument(w, h, defs, parts.join('\n'));
}

function buildPin(input: TemplateInput): string {
  const { brand, product, family, width: w, height: h } = input;
  const { defs, body } = bgAndDefs(brand, w, h);
  const pad = Math.round(w * 0.07);
  const imgH = Math.round(h * 0.58);
  const titleLines = wrapText(product.title, 22, 3);
  const parts = [
    body,
    productCard(input.image, brand, pad, pad, w - pad * 2, imgH),
    textBlock(titleLines, { x: pad, y: imgH + Math.round(h * 0.09), fontSize: Math.round(w * 0.07), lineHeight: Math.round(w * 0.078), fill: '#ffffff', family, weight: 800 }),
    priceBlock(product, brand, family, pad, imgH + Math.round(h * 0.20), Math.round(w * 0.058)),
    brandHeader(brand, family, pad, h - Math.round(h * 0.03)),
  ];
  return svgDocument(w, h, defs, parts.join('\n'));
}

function buildLinkedin(input: TemplateInput): string {
  const { brand, product, family, width: w, height: h } = input;
  const { defs, body } = bgAndDefs(brand, w, h);
  const pad = Math.round(w * 0.06);
  const colW = Math.round(w * 0.44);
  const headline = input.content?.captions.find((c) => c.platform === 'linkedin')?.primary ?? product.title;
  const hlLines = wrapText(headline.split('\n')[0] ?? product.title, 26, 4);
  const parts = [
    body,
    productCard(input.image, brand, w - colW - pad, Math.round(h * 0.18), colW, Math.round(h * 0.64), 36),
    brandHeader(brand, family, pad, Math.round(h * 0.14)),
    textBlock(hlLines, { x: pad, y: Math.round(h * 0.34), fontSize: Math.round(w * 0.045), lineHeight: Math.round(w * 0.055), fill: '#ffffff', family, weight: 700 }),
    priceBlock(product, brand, family, pad, Math.round(h * 0.72), Math.round(w * 0.04)),
  ];
  return svgDocument(w, h, defs, parts.join('\n'));
}

export function buildCarouselSlide(input: TemplateInput, slide: CarouselSlide): string {
  const { brand, product, family, width: w, height: h } = input;
  const { defs, body } = bgAndDefs(brand, w, h);
  const pad = Math.round(w * 0.08);
  const accent = normalizeHex(brand.accentColor, '#E63946');

  if (slide.kind === 'hero') {
    const titleLines = wrapText(product.title, 16, 3);
    return svgDocument(w, h, defs, [
      body,
      brandHeader(brand, family, pad, Math.round(h * 0.1)),
      textBlock(titleLines, { x: pad, y: Math.round(h * 0.26), fontSize: Math.round(w * 0.075), lineHeight: Math.round(w * 0.085), fill: '#ffffff', family, weight: 800 }),
      productCard(input.image, brand, pad, Math.round(h * 0.42), w - pad * 2, Math.round(h * 0.42)),
      `<text x="${pad}" y="${Math.round(h * 0.93)}" font-family="${family}" font-size="${Math.round(w * 0.032)}" fill="#ffffff" opacity="0.7">Swipe to explore →</text>`,
    ].join('\n'));
  }
  if (slide.kind === 'cta') {
    return svgDocument(w, h, defs, [
      body,
      `<circle cx="${w / 2}" cy="${Math.round(h * 0.38)}" r="${w * 0.14}" fill="${accent}" opacity="0.18"/>`,
      icon('sparkle', w / 2 - Math.round(w * 0.06), Math.round(h * 0.30), Math.round(w * 0.12), accent, 2.4),
      textBlock(wrapText(brand.cta || 'Shop now', 16, 2), { x: w / 2, y: Math.round(h * 0.58), fontSize: Math.round(w * 0.08), fill: '#ffffff', family, weight: 800, anchor: 'middle', lineHeight: Math.round(w * 0.09) }),
      product.price ? pill(Math.round(w * 0.30), Math.round(h * 0.68), product.price.formatted, { fill: accent, textFill: readableText(accent), fontSize: Math.round(w * 0.05), family, weight: 800, height: Math.round(w * 0.09) }) : '',
      brandHeader(brand, family, pad, Math.round(h * 0.93)),
    ].join('\n'));
  }
  // feature slide
  const feature = slide.feature ?? product.features[slide.featureIndex ?? 0] ?? 'Premium quality';
  const featLines = wrapText(feature, 20, 4);
  return svgDocument(w, h, defs, [
    body,
    `<circle cx="${pad + Math.round(w * 0.09)}" cy="${Math.round(h * 0.26)}" r="${Math.round(w * 0.11)}" fill="${accent}" opacity="0.16"/>`,
    icon(iconForIndex(slide.featureIndex ?? 0), pad + Math.round(w * 0.03), Math.round(h * 0.20), Math.round(w * 0.12), accent, 2.4),
    `<text x="${pad}" y="${Math.round(h * 0.44)}" font-family="${family}" font-size="${Math.round(w * 0.032)}" font-weight="700" fill="${accent}" letter-spacing="3">FEATURE ${String((slide.featureIndex ?? 0) + 1).padStart(2, '0')}</text>`,
    textBlock(featLines, { x: pad, y: Math.round(h * 0.52), fontSize: Math.round(w * 0.062), lineHeight: Math.round(w * 0.072), fill: '#ffffff', family, weight: 700 }),
    brandHeader(brand, family, pad, Math.round(h * 0.93)),
  ].join('\n'));
}

export function buildTemplate(type: AssetType, input: TemplateInput): string {
  switch (type) {
    case 'story':
      return buildStory(input);
    case 'pinterest_pin':
      return buildPin(input);
    case 'linkedin_image':
      return buildLinkedin(input);
    case 'facebook_image':
    case 'instagram_post':
    case 'carousel':
    default:
      return buildStandard(input);
  }
}
