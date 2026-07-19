/**
 * AWS Signature Version 4 signer (node:crypto only). Used by the Amazon
 * Product Advertising API v5 source. Implements the canonical request →
 * string-to-sign → signing-key → signature flow.
 */
import { hmacSha256, hmacSha256Hex, sha256Hex } from './crypto.ts';

export interface SigV4Input {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  headers: Record<string, string>;
  body: string;
  now?: Date;
}

export interface SigV4Output {
  authorization: string;
  amzDate: string;
  headers: Record<string, string>;
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export function signAwsV4(input: SigV4Input): SigV4Output {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);

  const headers: Record<string, string> = { ...input.headers, host: input.host, 'x-amz-date': amzDate };

  const sortedHeaderKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => {
      const originalKey = Object.keys(headers).find((h) => h.toLowerCase() === k)!;
      return `${k}:${String(headers[originalKey]).trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const hashedPayload = sha256Hex(input.body);
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    '', // canonical query string (empty for PA-API POST)
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(`AWS4${input.secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256Hex(kSigning, stringToSign);

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, amzDate, headers: { ...headers, authorization } };
}
