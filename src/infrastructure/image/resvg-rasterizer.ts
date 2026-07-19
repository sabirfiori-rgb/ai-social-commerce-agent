/**
 * SVG → PNG rasterizer backed by the vendored resvg WebAssembly build.
 * No native compilation, no npm install — the .wasm and glue ship in /vendor.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IImageRasterizer, RasterizeSpec } from '../../domain/ports.ts';
import { loadFontBuffers, resolveFontFamily } from './fonts.ts';
import { createLogger } from '../../shared/logger.ts';

const log = createLogger({ mod: 'resvg' });

interface ResvgModule {
  initWasm(input: BufferSource | Promise<Response> | Response): Promise<void>;
  Resvg: new (svg: string, opts?: unknown) => { render(): { asPng(): Uint8Array; width: number; height: number } };
}

let modPromise: Promise<ResvgModule> | null = null;

async function loadModule(vendorDir: string): Promise<ResvgModule> {
  if (modPromise) return modPromise;
  modPromise = (async () => {
    const mjsPath = resolve(process.cwd(), vendorDir, 'resvg.mjs');
    const wasmPath = resolve(process.cwd(), vendorDir, 'resvg.wasm');
    const mod = (await import(pathToFileURL(mjsPath).href)) as unknown as ResvgModule;
    await mod.initWasm(readFileSync(wasmPath));
    log.debug('resvg wasm initialized', { wasmPath });
    return mod;
  })();
  return modPromise;
}

export class ResvgRasterizer implements IImageRasterizer {
  private vendorDir: string;
  private fontsDir: string;
  private defaultFamily: string;
  private fontBuffers: Buffer[];

  constructor(opts: { vendorDir?: string; fontsDir?: string; brandFont?: string } = {}) {
    this.vendorDir = opts.vendorDir ?? 'vendor/resvg';
    this.fontsDir = opts.fontsDir ?? 'vendor/fonts';
    const loaded = loadFontBuffers(this.fontsDir);
    this.fontBuffers = loaded.buffers;
    this.defaultFamily = resolveFontFamily(opts.brandFont, loaded.families);
  }

  get family(): string {
    return this.defaultFamily;
  }

  async render(spec: RasterizeSpec): Promise<Buffer> {
    const mod = await loadModule(this.vendorDir);
    const fonts = spec.extraFonts ? [...this.fontBuffers, ...spec.extraFonts] : this.fontBuffers;
    const resvg = new mod.Resvg(spec.svg, {
      font: {
        fontBuffers: fonts,
        defaultFontFamily: this.defaultFamily,
        loadSystemFonts: false,
        sansSerifFamily: this.defaultFamily,
      },
      shapeRendering: 2,
      textRendering: 2,
      imageRendering: 0,
      logLevel: 'off',
    });
    const rendered = resvg.render();
    return Buffer.from(rendered.asPng());
  }
}
