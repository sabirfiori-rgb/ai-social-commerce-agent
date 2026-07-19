/**
 * SVG construction toolkit for brand templates: color math, gradients, rounded
 * shapes, word-wrapped text, pills/badges, a built-in line-icon set, and raster
 * image embedding (as data URIs — the rasterizer renders these natively).
 * Note: color emoji do not render in resvg, so image text is kept emoji-free.
 */

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------- colors -------------------------------- */

export function normalizeHex(hex: string, fallback = '#0F2027'): string {
  const h = (hex || '').trim();
  if (/^#([0-9a-f]{6})$/i.test(h)) return h;
  if (/^#([0-9a-f]{3})$/i.test(h)) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  if (/^([0-9a-f]{6})$/i.test(h)) return `#${h}`;
  return fallback;
}

function toRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function toHex([r, g, b]: [number, number, number]): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
export function shade(hex: string, amount: number): string {
  // amount in [-1, 1]; negative darkens, positive lightens
  const [r, g, b] = toRgb(hex);
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  return toHex([r + (t - r) * p, g + (t - g) * p, b + (t - b) * p]);
}
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
export function readableText(bgHex: string): string {
  return luminance(bgHex) > 0.6 ? '#111318' : '#FFFFFF';
}

/* ------------------------------ gradients ------------------------------ */

export function linearGradient(id: string, from: string, to: string, angleDeg = 135): string {
  const rad = (angleDeg * Math.PI) / 180;
  const x2 = (Math.cos(rad) * 0.5 + 0.5).toFixed(4);
  const y2 = (Math.sin(rad) * 0.5 + 0.5).toFixed(4);
  const x1 = (1 - Number(x2)).toFixed(4);
  const y1 = (1 - Number(y2)).toFixed(4);
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
    <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
}

/* ------------------------------- shapes -------------------------------- */

export function roundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  opts: { opacity?: number; stroke?: string; strokeWidth?: number } = {},
): string {
  const extra = [
    opts.opacity !== undefined ? `opacity="${opts.opacity}"` : '',
    opts.stroke ? `stroke="${opts.stroke}"` : '',
    opts.strokeWidth ? `stroke-width="${opts.strokeWidth}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}" ${extra}/>`;
}

/* -------------------------------- text --------------------------------- */

/** Approximate character capacity for a given pixel width + font size. */
export function wrapText(text: string, maxChars: number, maxLines = 4): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (candidate.length > maxChars && cur) {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines - 1) break;
    } else {
      cur = candidate;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const rest = words.slice(lines.join(' ').split(' ').length).join(' ');
  if (rest && lines.length === maxLines) {
    lines[maxLines - 1] = `${lines[maxLines - 1]!.replace(/[.,!?\s]+$/, '')}…`;
  }
  return lines;
}

export interface TextBlockOptions {
  x: number;
  y: number;
  fontSize: number;
  lineHeight?: number;
  fill?: string;
  family?: string;
  weight?: number | string;
  letterSpacing?: number;
  anchor?: 'start' | 'middle' | 'end';
}

export function textBlock(lines: string[], o: TextBlockOptions): string {
  const lh = o.lineHeight ?? o.fontSize * 1.12;
  const anchor = o.anchor ?? 'start';
  const tspans = lines
    .map((line, i) => `<tspan x="${o.x}" dy="${i === 0 ? 0 : lh}">${esc(line)}</tspan>`)
    .join('');
  const ls = o.letterSpacing !== undefined ? `letter-spacing="${o.letterSpacing}"` : '';
  return `<text x="${o.x}" y="${o.y}" font-family="${o.family ?? 'Poppins'}" font-size="${o.fontSize}" font-weight="${o.weight ?? 700}" fill="${o.fill ?? '#fff'}" text-anchor="${anchor}" ${ls}>${tspans}</text>`;
}

/* ------------------------------- badges -------------------------------- */

export function pill(
  cx: number,
  y: number,
  text: string,
  o: { fill: string; textFill: string; fontSize: number; padX?: number; height?: number; family?: string; weight?: number },
): string {
  const padX = o.padX ?? 44;
  const height = o.height ?? o.fontSize * 2.1;
  const approxCharW = o.fontSize * 0.6;
  const width = Math.round(text.length * approxCharW + padX * 2);
  const x = cx;
  return `${roundedRect(x, y, width, height, height / 2, o.fill)}
    <text x="${x + width / 2}" y="${y + height / 2}" font-family="${o.family ?? 'Poppins'}" font-size="${o.fontSize}" font-weight="${o.weight ?? 700}" fill="${o.textFill}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`;
}

/* -------------------------------- icons -------------------------------- */

// 24x24 line-icon path data (MIT-style, hand-authored). Rendered via <path>.
const ICONS: Record<string, string> = {
  check: 'M20 6L9 17l-5-5',
  bolt: 'M13 2L3 14h7l-1 8 10-12h-7l1-8z',
  truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7zM5.5 18.5a2 2 0 100 .01M18.5 18.5a2 2 0 100 .01',
  shield: 'M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z',
  star: 'M12 2l3 6.5 7 .9-5 4.8 1.3 7L12 18l-6.3 3.2L7 14.2 2 9.4l7-.9L12 2z',
  heart: 'M12 21C6 16.5 3 13 3 9.2 3 6.3 5.3 4 8.2 4c1.7 0 3.2.8 3.8 2 .6-1.2 2.1-2 3.8-2C18.7 4 21 6.3 21 9.2c0 3.8-3 7.3-9 11.8z',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z',
  tag: 'M20 12l-8 8-9-9V3h8l9 9zM7 7h.01',
  leaf: 'M11 20C6 20 3 16 3 11 9 11 13 7 13 3c5 0 8 4 8 9 0 5-4 8-10 8z',
  clock: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
};

export function icon(
  name: string,
  x: number,
  y: number,
  size: number,
  color: string,
  strokeWidth = 2,
): string {
  const d = ICONS[name] ?? ICONS.check!;
  const scale = size / 24;
  return `<g transform="translate(${x},${y}) scale(${scale})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`;
}

export const ICON_NAMES = Object.keys(ICONS);
export function iconForIndex(i: number): string {
  const preferred = ['bolt', 'shield', 'star', 'truck', 'sparkle', 'leaf', 'clock', 'tag', 'heart', 'check'];
  return preferred[i % preferred.length]!;
}

/* ------------------------------- images -------------------------------- */

export function embedImage(
  buffer: Buffer,
  mime: string,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { clipId?: string; preserve?: string; radius?: number } = {},
): string {
  const href = `data:${mime};base64,${buffer.toString('base64')}`;
  const preserve = opts.preserve ?? 'xMidYMid slice';
  if (opts.clipId) {
    return `<clipPath id="${opts.clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${opts.radius ?? 0}" ry="${opts.radius ?? 0}"/></clipPath>
      <image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${preserve}" clip-path="url(#${opts.clipId})"/>`;
  }
  return `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${preserve}"/>`;
}

export function svgDocument(width: number, height: number, defs: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>${defs}</defs>
${body}
</svg>`;
}
