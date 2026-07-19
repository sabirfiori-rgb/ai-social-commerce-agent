/**
 * Cryptographic primitives (node:crypto) used across integrations:
 * - AES-256-GCM at-rest encryption for stored credentials.
 * - RS256 JWT signing (Google service-account auth).
 * - HMAC (AWS SigV4 for Amazon PA-API; OAuth 1.0a for X).
 * - base64url + hashing helpers.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createSign,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigError } from './errors.ts';

export function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlJson(obj: unknown): string {
  return base64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}

export function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(key: Buffer | string, data: Buffer | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function hmacSha256Hex(key: Buffer | string, data: Buffer | string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function hmacSha1Base64(key: string, data: string): string {
  return createHmac('sha1', key).update(data).digest('base64');
}

/** Encrypt a UTF-8 string with AES-256-GCM. Returns base64(iv|tag|ciphertext). */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = normalizeKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(payloadB64: string, keyHex: string): string {
  const key = normalizeKey(keyHex);
  const raw = Buffer.from(payloadB64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function normalizeKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new ConfigError('ENCRYPTION_KEY must be 32 bytes (64 hex characters)', { got: key.length });
  }
  return key;
}

/** Sign an RS256 JWT (used for Google service-account OAuth). */
export function signJwtRs256(
  payload: Record<string, unknown>,
  privateKeyPem: string,
  header: Record<string, unknown> = {},
): string {
  const fullHeader = { alg: 'RS256', typ: 'JWT', ...header };
  const signingInput = `${base64urlJson(fullHeader)}.${base64urlJson(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
