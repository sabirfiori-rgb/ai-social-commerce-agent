/**
 * Tiny, dependency-free schema validator for API request bodies and settings.
 * Not a full JSON-schema — just enough to validate/coerce untrusted input safely.
 */
import { ValidationError } from './errors.ts';

export type Validator<T> = (value: unknown, path: string) => T;

function fail(path: string, expected: string, value: unknown): never {
  throw new ValidationError(`Invalid value at "${path}": expected ${expected}`, {
    path,
    expected,
    received: value === null ? 'null' : typeof value,
  });
}

export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Validator<string> {
    return (value, path) => {
      if (typeof value !== 'string') fail(path, 'string', value);
      let s = value as string;
      if (opts.trim !== false) s = s.trim();
      if (opts.min !== undefined && s.length < opts.min) fail(path, `string length >= ${opts.min}`, value);
      if (opts.max !== undefined && s.length > opts.max) fail(path, `string length <= ${opts.max}`, value);
      if (opts.pattern && !opts.pattern.test(s)) fail(path, `string matching ${opts.pattern}`, value);
      return s;
    };
  },
  number(opts: { min?: number; max?: number; int?: boolean } = {}): Validator<number> {
    return (value, path) => {
      const n = typeof value === 'string' ? Number(value) : (value as number);
      if (typeof n !== 'number' || Number.isNaN(n)) fail(path, 'number', value);
      if (opts.int && !Number.isInteger(n)) fail(path, 'integer', value);
      if (opts.min !== undefined && n < opts.min) fail(path, `number >= ${opts.min}`, value);
      if (opts.max !== undefined && n > opts.max) fail(path, `number <= ${opts.max}`, value);
      return n;
    };
  },
  boolean(): Validator<boolean> {
    return (value, path) => {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return fail(path, 'boolean', value);
    };
  },
  enum<const T extends readonly string[]>(values: T): Validator<T[number]> {
    return (value, path) => {
      if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T[number];
      return fail(path, `one of [${values.join(', ')}]`, value);
    };
  },
  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path) => (value === undefined || value === null || value === '' ? undefined : inner(value, path));
  },
  withDefault<T>(inner: Validator<T>, def: T): Validator<T> {
    return (value, path) => (value === undefined || value === null || value === '' ? def : inner(value, path));
  },
  array<T>(inner: Validator<T>, opts: { min?: number; max?: number } = {}): Validator<T[]> {
    return (value, path) => {
      if (!Array.isArray(value)) fail(path, 'array', value);
      const arr = value as unknown[];
      if (opts.min !== undefined && arr.length < opts.min) fail(path, `array length >= ${opts.min}`, value);
      if (opts.max !== undefined && arr.length > opts.max) fail(path, `array length <= ${opts.max}`, value);
      return arr.map((item, i) => inner(item, `${path}[${i}]`));
    };
  },
  object<S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S]: ReturnType<S[K]> }> {
    return (value, path) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'object', value);
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, validator] of Object.entries(shape)) {
        out[key] = validator(obj[key], path ? `${path}.${key}` : key);
      }
      return out as { [K in keyof S]: ReturnType<S[K]> };
    };
  },
};

export function validate<T>(validator: Validator<T>, value: unknown): T {
  return validator(value, '');
}
