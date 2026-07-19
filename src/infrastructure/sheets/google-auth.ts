/**
 * Google service-account authentication (OAuth 2.0 JWT-bearer flow) implemented
 * with only node:crypto + fetch — no googleapis dependency. Produces short-lived
 * access tokens for the Sheets / Drive REST APIs and caches them until expiry.
 */
import { readFileSync } from 'node:fs';
import { signJwtRs256 } from '../../shared/crypto.ts';
import { httpJson } from '../../shared/http.ts';
import { ConfigError } from '../../shared/errors.ts';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function loadServiceAccount(opts: { file?: string; inlineJson?: string }): ServiceAccount {
  let jsonText = '';
  if (opts.inlineJson && opts.inlineJson.trim()) {
    jsonText = opts.inlineJson.trim();
  } else if (opts.file && opts.file.trim()) {
    try {
      jsonText = readFileSync(opts.file, 'utf8');
    } catch (e) {
      throw new ConfigError(`Could not read Google service-account file at ${opts.file}`, { cause: String(e) });
    }
  } else {
    throw new ConfigError('No Google service-account credentials provided (set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON)');
  }
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new ConfigError('Google service-account JSON is not valid JSON', { cause: String(e) });
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new ConfigError('Google service-account JSON is missing client_email or private_key');
  }
  return parsed;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class GoogleAuth {
  private sa: ServiceAccount;
  private scopes: string[];
  private cachedToken: string | null = null;
  private expiresAtMs = 0;

  constructor(sa: ServiceAccount, scopes: string[]) {
    this.sa = sa;
    this.scopes = scopes;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.expiresAtMs - 60_000) return this.cachedToken;

    const tokenUri = this.sa.token_uri || 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(now / 1000);
    const assertion = signJwtRs256(
      {
        iss: this.sa.client_email,
        scope: this.scopes.join(' '),
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      },
      this.sa.private_key,
    );

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const res = await httpJson<TokenResponse>(tokenUri, {
      method: 'POST',
      provider: 'google-oauth',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    this.cachedToken = res.access_token;
    this.expiresAtMs = now + (res.expires_in ?? 3600) * 1000;
    return this.cachedToken;
  }

  async authHeader(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.getAccessToken()}` };
  }
}

export const GOOGLE_SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];
