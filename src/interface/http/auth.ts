/**
 * Bearer-token / API-key authentication for the REST API.
 * - Enabled when one or more tokens are configured (API_TOKENS / API_TOKEN).
 * - Tokens are accepted via `Authorization: Bearer <token>` or `X-API-Key`.
 * - Compared in constant time. A small set of paths stays public so health
 *   probes and the login flow work without a token.
 */
import type { IncomingMessage } from 'node:http';
import { safeEqual } from '../../shared/crypto.ts';

/** Paths reachable without authentication (health probes + the login flow). */
const PUBLIC_PATHS = new Set(['/api/health', '/api/health/live', '/api/health/ready', '/api/auth/status', '/api/auth/login']);

export interface Authenticator {
  readonly enabled: boolean;
  isPublic(pathname: string): boolean;
  validate(token: string | null | undefined): boolean;
  check(req: IncomingMessage): boolean;
}

export function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key.trim()) return key.trim();
  return null;
}

export function createAuth(cfg: { enabled: boolean; tokens: string[] }): Authenticator {
  const tokens = (cfg.tokens ?? []).filter(Boolean);
  const enabled = cfg.enabled && tokens.length > 0;
  return {
    enabled,
    isPublic(pathname: string): boolean {
      return PUBLIC_PATHS.has(pathname);
    },
    validate(token: string | null | undefined): boolean {
      if (!enabled) return true;
      if (!token) return false;
      return tokens.some((t) => safeEqual(t, token));
    },
    check(req: IncomingMessage): boolean {
      if (!enabled) return true;
      return this.validate(extractToken(req));
    },
  };
}
