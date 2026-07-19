/**
 * Identifier + hashing utilities (dependency-free).
 */
import { randomUUID, createHash, randomBytes } from 'node:crypto';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/**
 * Lexicographically-sortable, time-prefixed unique id (ULID-compatible layout).
 * 10 chars of timestamp + 16 chars of randomness.
 */
export function ulid(now = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ULID_ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(10);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += ULID_ALPHABET[rnd[i % rnd.length]! % 32];
  }
  return ts + rand;
}

export function uuid(): string {
  return randomUUID();
}

/** Short prefixed id, e.g. prefixedId('job') => 'job_01J9...' */
export function prefixedId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic dedupe key for a product, so the same product from the same
 * source is never processed twice even across sheet re-imports.
 */
export function productDedupeKey(parts: { source: string; productId?: string; url?: string; title?: string }): string {
  const basis = [parts.source, parts.productId ?? '', parts.url ?? '', parts.title ?? '']
    .map((s) => s.trim().toLowerCase())
    .join('|');
  return sha256Hex(basis).slice(0, 32);
}

export function slugify(input: string, max = 60): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'item';
}
