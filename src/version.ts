/**
 * Application version — read once from package.json at runtime.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cached: string | null = null;

export function appVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
