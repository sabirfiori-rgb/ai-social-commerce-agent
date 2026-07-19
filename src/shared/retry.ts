/**
 * Retry with exponential backoff + jitter, and a promise timeout helper.
 */
import { sleep } from './clock.ts';
import { TimeoutError, isRetryable, toError } from './errors.ts';

export interface RetryOptions {
  retries?: number; // number of *additional* attempts after the first
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  retryable?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const minDelay = options.minDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;
  const isRetry = options.retryable ?? isRetryable;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const canRetry = attempt <= retries && isRetry(e);
      if (!canRetry) break;
      const base = Math.min(maxDelay, minDelay * Math.pow(factor, attempt - 1));
      const delay = jitter ? Math.round(base / 2 + Math.random() * (base / 2)) : base;
      options.onRetry?.({ attempt, delayMs: delay, error: e });
      await sleep(delay, options.signal);
    }
  }
  throw toError(lastErr);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
