/**
 * Thin promisified wrappers around the ffmpeg / ffprobe binaries (spawned as
 * child processes). Captures stderr for diagnostics and enforces success codes.
 */
import { spawn } from 'node:child_process';
import { createLogger } from '../../shared/logger.ts';

const log = createLogger({ mod: 'ffmpeg' });

export function runFfmpeg(args: string[], opts: { bin?: string; label?: string } = {}): Promise<string> {
  const bin = opts.bin ?? 'ffmpeg';
  const label = opts.label ?? 'ffmpeg';
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
    });
    proc.on('error', (e) => reject(new Error(`${label} failed to spawn: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${label} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function ffprobeDuration(path: string, bin = 'ffprobe'): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve(0));
    proc.on('close', () => resolve(Number(out.trim()) || 0));
  });
}

export function checkFfmpeg(bin = 'ffmpeg'): Promise<boolean> {
  return runFfmpeg(['-version'], { bin, label: 'ffmpeg-version' })
    .then(() => true)
    .catch((e) => {
      log.warn('ffmpeg not available', { error: (e as Error).message });
      return false;
    });
}
