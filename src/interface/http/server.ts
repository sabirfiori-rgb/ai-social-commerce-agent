/**
 * Dependency-free HTTP server (node:http): CORS, JSON body parsing, API routing,
 * static asset serving (/files/*), and SPA hosting (web/) with client-route
 * fallback. Errors map to AppError status codes.
 */
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Container } from '../../boot/container.ts';
import { isAppError } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { registerRoutes } from '../controllers/routes.ts';
import { registerAdminRoutes } from '../controllers/admin-routes.ts';
import { Router } from './router.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return resolveBody(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody(undefined);
      const ct = String(req.headers['content-type'] ?? '');
      if (ct.includes('application/json')) {
        try {
          resolveBody(JSON.parse(raw));
        } catch {
          reject(new Error('invalid JSON body'));
        }
      } else {
        resolveBody(raw);
      }
    });
    req.on('error', reject);
  });
}

function serveFileWithin(baseDir: string, relPath: string, res: http.ServerResponse, spaFallback?: string): void {
  const safeRel = normalize(relPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const full = join(baseDir, safeRel);
  if (!resolve(full).startsWith(resolve(baseDir))) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  if (existsSync(full) && !full.endsWith('/')) {
    const data = readFileSync(full);
    res.writeHead(200, { 'content-type': contentType(full), 'cache-control': 'public, max-age=300' });
    res.end(data);
    return;
  }
  if (spaFallback && existsSync(spaFallback)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(spaFallback));
    return;
  }
  json(res, 404, { error: 'not found' });
}

export function createHttpServer(container: Container): http.Server {
  const router = new Router();
  registerAdminRoutes(router, container);
  registerRoutes(router, container);
  const webDir = resolve(process.cwd(), 'web');
  const spaIndex = join(webDir, 'index.html');
  const filesDir = resolve(process.cwd(), container.config.storage.localDir);

  return http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type,authorization');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname.startsWith('/files/')) {
        serveFileWithin(filesDir, url.pathname.slice('/files/'.length), res);
        return;
      }

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        // Bearer-token / API-key guard (health probes + login stay public).
        if (container.auth.enabled && !container.auth.isPublic(url.pathname) && !container.auth.check(req)) {
          json(res, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
          return;
        }
        const body = await parseBody(req);
        const match = router.match(req.method ?? 'GET', url.pathname);
        if (!match) {
          json(res, 404, { error: 'Not found', path: url.pathname });
          return;
        }
        const data = await match.handler({ req, res, params: match.params, query: url.searchParams, body, container });
        if (!res.headersSent) json(res, 200, data === undefined ? { ok: true } : data);
        return;
      }

      // Static SPA (client-side routing → index.html fallback).
      const rel = url.pathname === '/' ? 'index.html' : url.pathname;
      serveFileWithin(webDir, rel, res, spaIndex);
    } catch (e) {
      if (isAppError(e)) {
        json(res, e.statusCode, { error: e.message, code: e.code, details: e.details });
      } else {
        logger.error('request error', { error: (e as Error).message, url: req.url });
        json(res, 500, { error: 'Internal error' });
      }
    } finally {
      logger.debug('http', { method: req.method, path: req.url, ms: Date.now() - started });
    }
  });
}
