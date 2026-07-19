/**
 * Font loading for the image engine. Loads the vendored OFL fonts (Poppins)
 * plus a few system fonts for glyph coverage, and returns them as buffers for
 * the resvg-wasm rasterizer (which has no filesystem access of its own).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SYSTEM_FONT_CANDIDATES = [
  '/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf',
  '/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf',
  '/usr/share/fonts/liberation-serif/LiberationSerif-Regular.ttf',
  '/usr/share/fonts/liberation-serif/LiberationSerif-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

let cache: { buffers: Buffer[]; families: string[] } | null = null;

export function loadFontBuffers(fontsDir = 'vendor/fonts'): { buffers: Buffer[]; families: string[] } {
  if (cache) return cache;
  const buffers: Buffer[] = [];
  const families = new Set<string>();

  const dir = resolve(process.cwd(), fontsDir);
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (/\.(ttf|otf)$/i.test(file)) {
        try {
          buffers.push(readFileSync(join(dir, file)));
          families.add(file.split('-')[0] ?? file.replace(/\.(ttf|otf)$/i, ''));
        } catch {
          /* skip unreadable font */
        }
      }
    }
  }
  for (const path of SYSTEM_FONT_CANDIDATES) {
    if (existsSync(path)) {
      try {
        buffers.push(readFileSync(path));
      } catch {
        /* ignore */
      }
    }
  }

  cache = { buffers, families: [...families] };
  return cache;
}

/** Resolve the requested brand font to a family we actually have; fall back sensibly. */
export function resolveFontFamily(requested: string | undefined, families: string[]): string {
  const want = (requested ?? '').trim();
  if (want && families.some((f) => f.toLowerCase() === want.toLowerCase())) return want;
  if (families.includes('Poppins')) return 'Poppins';
  return 'Liberation Sans';
}
