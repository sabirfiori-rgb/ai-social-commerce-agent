/**
 * Minimal, dependency-free .env loader.
 * Parses KEY=VALUE lines (supports quotes, comments, and `export ` prefixes)
 * and populates process.env WITHOUT overwriting already-set variables.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DotenvResult {
  loaded: boolean;
  path: string;
  count: number;
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const withoutExport = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length)
    : trimmed;

  const eq = withoutExport.indexOf('=');
  if (eq === -1) return null;

  const key = withoutExport.slice(0, eq).trim();
  if (!key) return null;

  let value = withoutExport.slice(eq + 1).trim();

  // Strip inline comments for unquoted values.
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;

  if (isDoubleQuoted) {
    value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  } else if (isSingleQuoted) {
    value = value.slice(1, -1);
  } else {
    // Strip an inline comment: a '#' at the start of the value or preceded by
    // whitespace. (URL fragments like `http://x#y` are not preceded by space.)
    const m = /(^|\s)#/.exec(value);
    if (m) value = value.slice(0, m.index).trim();
  }

  return [key, value];
}

/**
 * Load a .env file into process.env (existing values win).
 */
export function loadDotenv(path = '.env'): DotenvResult {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) return { loaded: false, path: abs, count: 0 };

  const contents = readFileSync(abs, 'utf8');
  let count = 0;

  for (const rawLine of contents.split(/\r?\n/)) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }

  return { loaded: true, path: abs, count };
}
