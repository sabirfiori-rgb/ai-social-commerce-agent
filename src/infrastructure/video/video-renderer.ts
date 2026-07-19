/**
 * ffmpeg-based promotional video renderer. Builds vertical 1080x1920 scenes
 * (hero → feature slides → CTA) from the SVG templates, animates each with a
 * Ken Burns zoom + cross-fades, adds an optional royalty-free music bed (or a
 * soft synthesized pad), and exports a web-optimized H.264 MP4.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GeneratedVideo } from '../../domain/entities.ts';
import type { IImageRasterizer, IStorage, IVideoRenderer, VideoBuildContext } from '../../domain/ports.ts';
import { nowIso } from '../../shared/clock.ts';
import { AppError } from '../../shared/errors.ts';
import { prefixedId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { existsSyncSafe } from './fs-util.ts';
import { buildCarouselSlide, buildTemplate } from '../image/templates.ts';
import { ffprobeDuration, runFfmpeg } from './ffmpeg.ts';

const log = createLogger({ mod: 'video' });
const W = 1080;
const H = 1920;

export interface VideoRendererConfig {
  ffmpegPath: string;
  ffprobePath: string;
  fps: number;
  durationSeconds: number;
  musicFile?: string;
  musicEnabled: boolean;
  tmpDir?: string;
}

export class FfmpegVideoRenderer implements IVideoRenderer {
  private rasterizer: IImageRasterizer;
  private storage: IStorage;
  private cfg: VideoRendererConfig;

  constructor(rasterizer: IImageRasterizer, storage: IStorage, cfg: VideoRendererConfig) {
    this.rasterizer = rasterizer;
    this.storage = storage;
    this.cfg = cfg;
  }

  async generate(ctx: VideoBuildContext): Promise<GeneratedVideo> {
    const workDir = resolve(process.cwd(), this.cfg.tmpDir ?? 'data/tmp', `vid-${ctx.product.id}-${prefixedId('v').slice(2, 10)}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const finalPath = await this.render(ctx, workDir);
      const durationSec = (await ffprobeDuration(finalPath, this.cfg.ffprobePath)) || this.totalDuration(ctx);
      const uploaded = await this.upload(finalPath, ctx.product.id);
      const persistedPath = uploaded.storageKey ? this.storage.localPathFor(uploaded.storageKey) : finalPath;
      const video: GeneratedVideo = {
        id: prefixedId('vid'),
        productId: ctx.product.id,
        path: persistedPath,
        storageKey: uploaded.storageKey,
        url: uploaded.url,
        width: W,
        height: H,
        durationSec: Math.round(durationSec * 100) / 100,
        fps: this.cfg.fps,
        bytes: uploaded.bytes,
        createdAt: nowIso(),
      };
      log.info('video generated', { productId: ctx.product.id, durationSec: video.durationSec, bytes: video.bytes });
      return video;
    } finally {
      // Clean scene/clip temp files; the final MP4 lives in storage.
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  private totalDuration(_ctx: VideoBuildContext): number {
    return Math.max(15, Math.min(30, this.cfg.durationSeconds));
  }

  private buildScenes(ctx: VideoBuildContext): string[] {
    const image = this.loadImage(ctx);
    const base = { product: ctx.product, brand: ctx.brand, content: ctx.content, image, family: 'Poppins', width: W, height: H };
    const svgs: string[] = [];
    svgs.push(buildTemplate('story', base)); // hero
    const featureCount = Math.max(1, Math.min(3, ctx.product.features.length));
    for (let i = 0; i < featureCount; i++) {
      svgs.push(buildCarouselSlide(base, { kind: 'feature', index: i + 1, featureIndex: i, feature: ctx.product.features[i] }));
    }
    svgs.push(buildCarouselSlide(base, { kind: 'cta', index: featureCount + 1 }));
    return svgs;
  }

  private loadImage(ctx: VideoBuildContext): { buffer: Buffer; mime: string } | undefined {
    const img = ctx.product.images.find((i) => i.role === 'primary') ?? ctx.product.images[0];
    if (img?.localPath && existsSyncSafe(img.localPath)) {
      try {
        return { buffer: readFileSync(img.localPath), mime: img.mimeType ?? 'image/jpeg' };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async render(ctx: VideoBuildContext, workDir: string): Promise<string> {
    const fps = this.cfg.fps;
    const svgs = this.buildScenes(ctx);
    const total = this.totalDuration(ctx);
    const per = Math.round((total / svgs.length) * 100) / 100;
    const frames = Math.max(2, Math.round(per * fps));

    // 1) Rasterize each scene to PNG and encode a Ken Burns clip.
    const clipPaths: string[] = [];
    for (let i = 0; i < svgs.length; i++) {
      const png = await this.rasterizer.render({ svg: svgs[i]! });
      const scenePath = join(workDir, `scene-${i}.png`);
      writeFileSync(scenePath, png);
      const clipPath = join(workDir, `clip-${i}.mp4`);
      const fadeOutAt = Math.max(0, frames / fps - 0.45).toFixed(2);
      // Ken Burns via zoompan. CRITICAL: use d=1 (one output frame per input
      // frame) with the zoom driven by the output-frame counter `on`, and bound
      // the clip with -frames:v. Using d=<frames> on a looped still causes a
      // frame-count explosion (frames x inputFrames) that is extremely slow.
      const vf = [
        `scale=${Math.round(W * 1.1)}:${Math.round(H * 1.1)}`,
        `zoompan=z='min(1.001+0.0013*on,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}`,
        `fade=t=in:st=0:d=0.4`,
        `fade=t=out:st=${fadeOutAt}:d=0.45`,
        `format=yuv420p`,
      ].join(',');
      const t0 = Date.now();
      await runFfmpeg(
        ['-y', '-framerate', String(fps), '-loop', '1', '-i', scenePath, '-vf', vf, '-frames:v', String(frames), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-an', clipPath],
        { bin: this.cfg.ffmpegPath, label: `scene-${i}` },
      );
      log.debug('scene encoded', { scene: i, ms: Date.now() - t0 });
      clipPaths.push(clipPath);
    }

    // 2) Concatenate clips (identical encode params → stream copy).
    const listPath = join(workDir, 'concat.txt');
    writeFileSync(listPath, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const silentPath = join(workDir, 'silent.mp4');
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', silentPath], {
      bin: this.cfg.ffmpegPath,
      label: 'concat',
    });

    // 3) Mux audio (music file → soft synth pad → silent), web-optimized.
    const outPath = join(workDir, 'promo.mp4');
    await this.muxAudio(silentPath, outPath, per * svgs.length);
    return outPath;
  }

  private async muxAudio(silentPath: string, outPath: string, total: number): Promise<void> {
    const common = ['-movflags', '+faststart', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest'];
    if (this.cfg.musicFile && existsSyncSafe(this.cfg.musicFile)) {
      await runFfmpeg(
        [
          '-y', '-i', silentPath, '-i', this.cfg.musicFile,
          '-filter_complex', `[1:a]afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2,volume=0.85[a]`,
          '-map', '0:v', '-map', '[a]', ...common, outPath,
        ],
        { bin: this.cfg.ffmpegPath, label: 'mux-music' },
      );
      return;
    }
    if (this.cfg.musicEnabled) {
      // Soft ambient pad from two detuned sine voices — subtle, royalty-free.
      await runFfmpeg(
        [
          '-y', '-i', silentPath,
          '-f', 'lavfi', '-t', String(total), '-i', 'sine=frequency=196:sample_rate=44100',
          '-f', 'lavfi', '-t', String(total), '-i', 'sine=frequency=293.66:sample_rate=44100',
          '-filter_complex', `[1:a][2:a]amix=inputs=2:normalize=0,volume=0.05,afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[a]`,
          '-map', '0:v', '-map', '[a]', ...common, outPath,
        ],
        { bin: this.cfg.ffmpegPath, label: 'mux-pad' },
      );
      return;
    }
    // Silent track (platforms generally require an audio stream).
    await runFfmpeg(
      ['-y', '-i', silentPath, '-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v', '-map', '1:a', ...common, outPath],
      { bin: this.cfg.ffmpegPath, label: 'mux-silent' },
    );
  }

  async compress(inputPath: string, outputPath: string): Promise<string> {
    await runFfmpeg(
      ['-y', '-i', inputPath, '-c:v', 'libx264', '-crf', '23', '-preset', 'medium', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', outputPath],
      { bin: this.cfg.ffmpegPath, label: 'compress' },
    );
    return outputPath;
  }

  async upload(localPath: string, productId: string): Promise<{ url?: string; storageKey?: string; bytes: number }> {
    const bytes = readFileSync(localPath);
    const key = `videos/${productId}/promo.mp4`;
    const stored = await this.storage.put(key, bytes, 'video/mp4');
    if (!stored.bytes) throw new AppError('video upload produced empty object', { code: 'VIDEO_UPLOAD_EMPTY' });
    return { url: stored.url, storageKey: stored.key, bytes: stored.bytes };
  }
}
