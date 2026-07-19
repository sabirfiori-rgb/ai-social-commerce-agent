/**
 * Structured logger — zero dependencies.
 * - Levels gated by LOG_LEVEL.
 * - Pretty console output or JSON lines (LOG_PRETTY).
 * - Automatic redaction of secret-looking fields.
 * - Child loggers with bound context (jobId, productId, ...).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE = /(token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|private[_-]?key)/i;

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[depth-limit]';
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));

  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value as unknown as Record<string, unknown>) };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k) && v) {
      out[k] = typeof v === 'string' && v.length > 8 ? `***${v.slice(-4)}` : '***';
    } else {
      out[k] = redact(v, depth + 1, seen);
    }
  }
  return out;
}

export class Logger {
  private level: number;
  private pretty: boolean;
  private bindings: Record<string, unknown>;

  constructor(opts: { level?: LogLevel; pretty?: boolean; bindings?: Record<string, unknown> } = {}) {
    const envLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
    this.level = LEVELS[opts.level ?? envLevel] ?? LEVELS.info;
    this.pretty = opts.pretty ?? process.env.LOG_PRETTY !== 'false';
    this.bindings = opts.bindings ?? {};
  }

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level] ?? this.level;
  }

  child(bindings: Record<string, unknown>): Logger {
    const c = new Logger({ pretty: this.pretty, bindings: { ...this.bindings, ...bindings } });
    c.level = this.level;
    return c;
  }

  private write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVELS[level] < this.level) return;
    const record = {
      time: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(extra ? (redact(extra) as Record<string, unknown>) : {}),
    };

    if (this.pretty) {
      const ctx = { ...this.bindings, ...(extra ?? {}) };
      const ctxStr = Object.keys(ctx).length ? ' ' + JSON.stringify(redact(ctx)) : '';
      const line = `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${record.time}  ${msg}${ctxStr}`;
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(line + '\n');
    } else {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(JSON.stringify(record) + '\n');
    }
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.write('debug', msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>): void {
    this.write('info', msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.write('warn', msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    this.write('error', msg, extra);
  }
}

export const logger = new Logger();
export function createLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
