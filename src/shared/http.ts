/**
 * HTTP client wrapper over global fetch:
 * - query building, JSON encode/decode, timeouts (AbortController),
 * - retry with backoff on transient failures,
 * - typed ExternalApiError with parsed body on non-2xx.
 */
import { ExternalApiError, RateLimitError, TimeoutError, isRetryable } from './errors.ts';
import { withRetry } from './retry.ts';

export type ResponseType = 'json' | 'text' | 'buffer';

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  provider?: string;
  responseType?: ResponseType;
  signal?: AbortSignal;
  /** Treat these HTTP statuses as success (default: 200-299). */
  okStatuses?: (status: number) => boolean;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

function buildUrl(url: string, query?: HttpRequestOptions['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function encodeBody(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof URLSearchParams || body instanceof ArrayBuffer) {
    return body as BodyInit;
  }
  if (body instanceof FormData) return body;
  if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
  return JSON.stringify(body);
}

async function parseResponse<T>(res: Response, type: ResponseType): Promise<T> {
  if (type === 'buffer') return Buffer.from(await res.arrayBuffer()) as unknown as T;
  if (type === 'text') return (await res.text()) as unknown as T;
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function httpRequest<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  const provider = options.provider ?? 'http';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 2;
  const responseType = options.responseType ?? 'json';
  const isOk = options.okStatuses ?? ((s: number) => s >= 200 && s < 300);
  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  const finalUrl = buildUrl(url, options.query);
  const bodyInit = encodeBody(options.body, headers);

  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new TimeoutError(`${provider} request timed out`)), timeoutMs);
      const onExternalAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const res = await fetch(finalUrl, {
          method: options.method ?? 'GET',
          headers,
          body: bodyInit,
          signal: controller.signal,
        });

        if (!isOk(res.status)) {
          const errBody = await parseResponse<unknown>(res, 'text');
          let parsed: unknown = errBody;
          try {
            parsed = typeof errBody === 'string' ? JSON.parse(errBody) : errBody;
          } catch {
            /* keep text */
          }
          if (res.status === 429) {
            const ra = Number(res.headers.get('retry-after'));
            throw new RateLimitError(`${provider} rate limited`, Number.isFinite(ra) ? ra * 1000 : undefined, {
              body: parsed,
            });
          }
          throw new ExternalApiError(provider, `${provider} responded ${res.status}`, {
            httpStatus: res.status,
            responseBody: parsed,
          });
        }

        const data = await parseResponse<T>(res, responseType);
        return { status: res.status, headers: res.headers, data };
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw new TimeoutError(`${provider} request aborted/timed out`);
        throw e;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
    { retries, retryable: isRetryable },
  );
}

/** Convenience: return only the parsed body. */
export async function httpJson<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const res = await httpRequest<T>(url, options);
  return res.data;
}

/** Download binary content (e.g. product images). */
export async function httpDownload(url: string, options: HttpRequestOptions = {}): Promise<Buffer> {
  const res = await httpRequest<Buffer>(url, { ...options, responseType: 'buffer' });
  return res.data;
}
