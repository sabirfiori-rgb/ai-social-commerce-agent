/**
 * Typed, operational error hierarchy used across the whole system.
 * Every error carries a machine-readable `code`, an HTTP `statusCode` for the
 * API layer, and an `isOperational` flag distinguishing expected failures
 * (retry / report) from programmer bugs (crash-worthy).
 */

export interface ErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly details?: ErrorDetails;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code?: string;
      statusCode?: number;
      isOperational?: boolean;
      details?: ErrorDetails;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.statusCode = options.statusCode ?? 500;
    this.isOperational = options.isOperational ?? true;
    this.details = options.details;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, { code: 'CONFIG_ERROR', statusCode: 500, isOperational: false, details });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, { code: 'VALIDATION_ERROR', statusCode: 400, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, { code: 'NOT_FOUND', statusCode: 404, details });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, { code: 'CONFLICT', statusCode: 409, details });
  }
}

export class AuthError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, { code: 'AUTH_ERROR', statusCode: 401, details });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number, details?: ErrorDetails) {
    super(message, { code: 'RATE_LIMIT', statusCode: 429, details });
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, { code: 'TIMEOUT', statusCode: 504, details });
  }
}

/** An error returned by an external HTTP API (Google, Meta, OpenAI, etc.). */
export class ExternalApiError extends AppError {
  readonly provider: string;
  readonly httpStatus?: number;
  readonly responseBody?: unknown;
  constructor(
    provider: string,
    message: string,
    options: { httpStatus?: number; responseBody?: unknown; details?: ErrorDetails; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'EXTERNAL_API_ERROR',
      statusCode: 502,
      details: { provider, httpStatus: options.httpStatus, ...options.details },
      cause: options.cause,
    });
    this.provider = provider;
    this.httpStatus = options.httpStatus;
    this.responseBody = options.responseBody;
  }
}

/** Raised when a credential/config for an optional integration is missing. */
export class NotConfiguredError extends AppError {
  constructor(integration: string, missing: string[] = []) {
    super(`Integration "${integration}" is not configured`, {
      code: 'NOT_CONFIGURED',
      statusCode: 412,
      details: { integration, missing },
    });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : JSON.stringify(err));
}

/** Determine whether an arbitrary thrown value should be retried. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError || err instanceof TimeoutError) return true;
  if (err instanceof ExternalApiError) {
    const s = err.httpStatus ?? 0;
    return s === 408 || s === 425 || s === 429 || s >= 500;
  }
  if (err instanceof AppError) return false;
  // Network-level errors (fetch/undici) are retryable.
  const code = (err as { code?: string })?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  );
}
