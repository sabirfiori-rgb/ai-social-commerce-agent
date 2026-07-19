/**
 * Unit tests for src/shared/* — crypto, dotenv, csv, clock, ids.
 * Pure functions / node:crypto only: no network, no filesystem except a
 * throwaway temp .env file for the dotenv test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { encryptSecret, decryptSecret, signJwtRs256, base64url, randomHex } from '../src/shared/crypto.ts';
import { loadDotenv } from '../src/shared/dotenv.ts';
import { parseCsvObjects, pick } from '../src/shared/csv.ts';
import { parseHhmm, nextSlot, localWallClockToIso } from '../src/shared/clock.ts';
import { ulid, productDedupeKey, slugify } from '../src/shared/ids.ts';

/* ============================== crypto.ts ================================ */

describe('crypto: encryptSecret/decryptSecret', () => {
  const key = randomHex(32); // 32 bytes -> 64 hex chars

  test('roundtrips a plaintext secret', () => {
    const plaintext = 'super-secret-access-token-12345';
    const encrypted = encryptSecret(plaintext, key);
    assert.notEqual(encrypted, plaintext);
    const decrypted = decryptSecret(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  test('produces different ciphertext each call (random IV)', () => {
    const plaintext = 'same-input-every-time';
    const a = encryptSecret(plaintext, key);
    const b = encryptSecret(plaintext, key);
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a, key), plaintext);
    assert.equal(decryptSecret(b, key), plaintext);
  });

  test('decrypting with the wrong key fails', () => {
    const encrypted = encryptSecret('hello world', key);
    const wrongKey = randomHex(32);
    assert.throws(() => decryptSecret(encrypted, wrongKey));
  });

  test('rejects a key that is not exactly 32 bytes', () => {
    assert.throws(() => encryptSecret('x', 'ab')); // too short (1 byte)
  });
});

describe('crypto: signJwtRs256', () => {
  test('produces a well-formed 3-segment JWT signed by a runtime-generated RSA key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

    const jwt = signJwtRs256({ iss: 'test', sub: 'unit-test', iat: 1_700_000_000 }, pem);
    const segments = jwt.split('.');
    assert.equal(segments.length, 3);
    for (const seg of segments) {
      assert.ok(seg.length > 0);
      // base64url alphabet only — no '+', '/', or padding.
      assert.match(seg, /^[A-Za-z0-9_-]+$/);
    }

    const headerJson = JSON.parse(Buffer.from(segments[0]!, 'base64url').toString('utf8'));
    assert.equal(headerJson.alg, 'RS256');
    assert.equal(headerJson.typ, 'JWT');

    const payloadJson = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'));
    assert.equal(payloadJson.sub, 'unit-test');
  });

  test('merges a custom header on top of the RS256 defaults', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    const jwt = signJwtRs256({ a: 1 }, pem, { kid: 'my-key-id' });
    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8'));
    assert.equal(header.kid, 'my-key-id');
    assert.equal(header.alg, 'RS256');
  });
});

describe('crypto: base64url', () => {
  test('encodes without +, /, or = padding', () => {
    // Bytes chosen so the plain-base64 encoding would contain '+' and '/'.
    const buf = Buffer.from([0xfb, 0xff, 0xbf, 0xef, 0xfe]);
    const plainB64 = buf.toString('base64');
    assert.match(plainB64, /[+/]/); // sanity: the naive encoding does contain them
    const encoded = base64url(buf);
    assert.doesNotMatch(encoded, /[+/=]/);
  });

  test('accepts a string input (encoded as utf8)', () => {
    const encoded = base64url('hello world');
    assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), 'hello world');
  });
});

/* ============================== dotenv.ts ================================= */

describe('dotenv: loadDotenv / parseLine behavior', () => {
  let dir: string;

  test('loads KEY=VALUE pairs, comment-only lines produce nothing, inline # comments are stripped', () => {
    dir = mkdtempSync(join(tmpdir(), 'dotenv-test-'));
    const envPath = join(dir, '.env');
    const contents = [
      '# this is a full-line comment',
      'PLAIN_KEY=plain_value',
      'WITH_INLINE_COMMENT=abc # trailing comment',
      'QUOTED_WITH_HASH="value#not-a-comment"',
      'export EXPORTED_KEY=exported_value',
      'EMPTY_VALUE=',
      'JUST_HASH=#',
      'URL_WITH_FRAGMENT=http://example.com/x#y', // '#' not preceded by whitespace -> not a comment
      '',
      '   ',
    ].join('\n');
    writeFileSync(envPath, contents, 'utf8');

    // Use a cwd-relative path via process.cwd() override trick: loadDotenv resolves
    // against process.cwd(), so pass an absolute path directly (resolve() is a no-op
    // for already-absolute paths).
    const result = loadDotenv(envPath);
    assert.equal(result.loaded, true);
    assert.equal(process.env.PLAIN_KEY, 'plain_value');
    assert.equal(process.env.WITH_INLINE_COMMENT, 'abc');
    assert.equal(process.env.QUOTED_WITH_HASH, 'value#not-a-comment');
    assert.equal(process.env.EXPORTED_KEY, 'exported_value');
    assert.equal(process.env.EMPTY_VALUE, '');
    // A value that is ONLY a comment marker strips down to an empty string.
    assert.equal(process.env.JUST_HASH, '');
    assert.equal(process.env.URL_WITH_FRAGMENT, 'http://example.com/x#y');

    rmSync(dir, { recursive: true, force: true });
  });

  test('returns loaded:false for a missing file without throwing', () => {
    const missing = join(tmpdir(), `does-not-exist-${Date.now()}.env`);
    const result = loadDotenv(missing);
    assert.equal(result.loaded, false);
    assert.equal(result.count, 0);
  });

  test('does not overwrite an already-set env var', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'dotenv-test2-'));
    const envPath = join(dir2, '.env');
    process.env.PRESET_KEY = 'original';
    writeFileSync(envPath, 'PRESET_KEY=overridden\n', 'utf8');
    const result = loadDotenv(envPath);
    assert.equal(process.env.PRESET_KEY, 'original');
    assert.equal(result.count, 0);
    rmSync(dir2, { recursive: true, force: true });
    delete process.env.PRESET_KEY;
  });
});

/* ================================ csv.ts =================================== */

describe('csv: parseCsvObjects + pick', () => {
  test('parses a simple CSV with headers into header-keyed objects', () => {
    const csv = 'Title,Price,Brand\nWireless Mouse,29.99,Acme\nUSB Cable,9.99,Acme';
    const rows = parseCsvObjects(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.Title, 'Wireless Mouse');
    assert.equal(rows[0]!.Price, '29.99');
    assert.equal(rows[1]!.Brand, 'Acme');
  });

  test('handles quoted fields with embedded commas and escaped quotes', () => {
    const csv = 'Title,Description\n"Mouse, Wireless","A ""great"" mouse"';
    const rows = parseCsvObjects(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.Title, 'Mouse, Wireless');
    assert.equal(rows[0]!.Description, 'A "great" mouse');
  });

  test('returns [] for an empty string', () => {
    assert.deepEqual(parseCsvObjects(''), []);
  });

  test('pick finds the first matching header case-insensitively, skipping blanks', () => {
    const obj = { Title: '', Name: 'Fallback Name', Brand: 'Acme' };
    assert.equal(pick(obj, 'title', 'name'), 'Fallback Name');
    assert.equal(pick(obj, 'BRAND'), 'Acme');
    assert.equal(pick(obj, 'nonexistent'), '');
  });
});

/* ================================ clock.ts =================================== */

describe('clock: parseHhmm', () => {
  test('parses valid HH:mm into minutes-since-midnight', () => {
    assert.equal(parseHhmm('00:00'), 0);
    assert.equal(parseHhmm('09:30'), 570);
    assert.equal(parseHhmm('23:59'), 1439);
    assert.equal(parseHhmm(' 9:05 '), 545);
  });

  test('rejects out-of-range or malformed input', () => {
    assert.equal(parseHhmm('24:00'), null);
    assert.equal(parseHhmm('12:60'), null);
    assert.equal(parseHhmm('not-a-time'), null);
    assert.equal(parseHhmm(''), null);
  });
});

describe('clock: nextSlot', () => {
  test('returns an ISO timestamp at or after `from` for the next valid slot', () => {
    const from = new Date('2026-07-19T10:00:00.000Z'); // UTC
    const iso = nextSlot(['09:00', '13:00', '18:00'], from, 'UTC');
    assert.ok(new Date(iso).getTime() >= from.getTime());
    // 13:00 UTC same day is the next slot after 10:00 UTC.
    assert.equal(iso, '2026-07-19T13:00:00.000Z');
  });

  test('rolls over to the next day when all slots for today have passed', () => {
    const from = new Date('2026-07-19T20:00:00.000Z');
    const iso = nextSlot(['09:00', '13:00', '18:00'], from, 'UTC');
    assert.equal(iso, '2026-07-20T09:00:00.000Z');
  });

  test('falls back to from+1h when no valid slots are provided', () => {
    const from = new Date('2026-07-19T10:00:00.000Z');
    const iso = nextSlot([], from, 'UTC');
    assert.equal(iso, new Date(from.getTime() + 3_600_000).toISOString());
  });

  test('falls back to from+1h when every provided slot is malformed', () => {
    const from = new Date('2026-07-19T10:00:00.000Z');
    const iso = nextSlot(['nonsense', '99:99'], from, 'UTC');
    assert.equal(iso, new Date(from.getTime() + 3_600_000).toISOString());
  });
});

describe('clock: localWallClockToIso', () => {
  test('converts a UTC wall-clock date+time to the identical ISO instant', () => {
    const iso = localWallClockToIso('2026-07-19', '09:00', 'UTC');
    assert.equal(iso, '2026-07-19T09:00:00.000Z');
  });

  test('accounts for a fixed negative offset (America/New_York, summer = UTC-4)', () => {
    const iso = localWallClockToIso('2026-07-19', '09:00', 'America/New_York');
    assert.ok(iso);
    assert.equal(iso, '2026-07-19T13:00:00.000Z');
  });

  test('returns null for malformed date or time', () => {
    assert.equal(localWallClockToIso('not-a-date', '09:00', 'UTC'), null);
    assert.equal(localWallClockToIso('2026-07-19', 'nope', 'UTC'), null);
  });
});

/* ================================= ids.ts ==================================== */

describe('ids: ulid', () => {
  test('generates 26-character Crockford-base32 identifiers', () => {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('is monotonic-ish: ids generated at increasing timestamps sort increasingly by their time prefix', () => {
    const early = ulid(1_700_000_000_000);
    const late = ulid(1_700_000_000_001);
    // Compare just the 10-char timestamp prefix (randomness differs after that).
    assert.ok(early.slice(0, 10) <= late.slice(0, 10));
    assert.notEqual(early, late);
  });

  test('two ulids minted at the exact same millisecond share a timestamp prefix but differ overall', () => {
    const now = 1_700_000_000_000;
    const a = ulid(now);
    const b = ulid(now);
    assert.equal(a.slice(0, 10), b.slice(0, 10));
    assert.notEqual(a, b); // random suffix differs
  });
});

describe('ids: productDedupeKey', () => {
  test('is stable for the same logical inputs regardless of case/whitespace', () => {
    const a = productDedupeKey({ source: 'amazon', productId: 'B001', url: 'https://x.com/p', title: 'Widget' });
    const b = productDedupeKey({ source: 'Amazon', productId: ' B001 ', url: 'https://x.com/p', title: '  widget  ' });
    assert.equal(a, b);
    assert.equal(a.length, 32);
  });

  test('differs when any identifying part differs', () => {
    const a = productDedupeKey({ source: 'amazon', productId: 'B001' });
    const b = productDedupeKey({ source: 'amazon', productId: 'B002' });
    assert.notEqual(a, b);
  });

  test('is deterministic across repeated calls', () => {
    const input = { source: 'csv', title: 'Same Product' };
    assert.equal(productDedupeKey(input), productDedupeKey(input));
  });
});

describe('ids: slugify', () => {
  test('lowercases, replaces non-alphanumerics with hyphens, trims edge hyphens', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
    assert.equal(slugify('  --Leading and Trailing--  '), 'leading-and-trailing');
  });

  test('truncates to the max length', () => {
    const long = 'a'.repeat(100);
    assert.equal(slugify(long, 10).length, 10);
  });

  test('falls back to "item" for input that produces an empty slug', () => {
    assert.equal(slugify('!!!???'), 'item');
    assert.equal(slugify(''), 'item');
  });
});
