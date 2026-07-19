/**
 * Tiny dependency-free HTTP router with path params (e.g. /api/products/:id).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Container } from '../../boot/container.ts';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  container: Container;
}

export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface CompiledRoute {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function compile(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}/?$`), keys };
}

export class Router {
  private routes: CompiledRoute[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    const { regex, keys } = compile(path);
    this.routes.push({ method: method.toUpperCase(), regex, keys, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }
  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }
  put(path: string, handler: RouteHandler): void {
    this.add('PUT', path, handler);
  }
  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}
