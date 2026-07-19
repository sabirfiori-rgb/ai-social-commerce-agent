/**
 * Typed application configuration, assembled from environment variables.
 * Loaded once at startup; validated eagerly for required core settings and
 * lazily (per-integration) elsewhere so the app boots without optional creds.
 */
import { loadDotenv } from '../shared/dotenv.ts';
import { ConfigError } from '../shared/errors.ts';
import { logger } from '../shared/logger.ts';

loadDotenv(process.env.ENV_FILE || '.env');

function str(name: string, def?: string): string {
  const val = process.env[name];
  if (val === undefined || val === '') {
    if (def !== undefined) return def;
    throw new ConfigError(`Missing required env var ${name}`);
  }
  return val;
}
function opt(name: string, def = ''): string {
  return process.env[name] ?? def;
}
function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`Env var ${name} must be a number`, { got: raw });
  return n;
}
function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return raw === 'true' || raw === '1';
}
function list(name: string, def: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return def;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export type SheetStore = 'local' | 'google';
export type StorageDriver = 'local' | 'gdrive';
export type AiProvider = 'template' | 'openai' | 'gemini' | 'anthropic';
export type DatabaseDriver = 'sqlite' | 'postgres';

export interface AppConfig {
  env: string;
  isProd: boolean;
  http: { host: string; port: number; publicBaseUrl: string };
  security: { encryptionKey: string };
  auth: { enabled: boolean; tokens: string[] };
  db: { driver: DatabaseDriver; sqlitePath: string; url: string };
  sheets: {
    store: SheetStore;
    spreadsheetId: string;
    serviceAccountFile: string;
    serviceAccountJson: string;
  };
  storage: { driver: StorageDriver; localDir: string; publicBaseUrl: string; gdriveFolderId: string };
  ai: {
    provider: AiProvider;
    timeoutMs: number;
    openai: { apiKey: string; model: string; baseUrl: string };
    gemini: { apiKey: string; model: string };
    anthropic: { apiKey: string; model: string };
  };
  automation: {
    pollIntervalMinutes: number;
    concurrency: number;
    retryMax: number;
    retryMinDelayMs: number;
    retryMaxDelayMs: number;
    jobLockTtlMs: number;
    rateLimitPerMinute: number;
    postingTimes: string[];
    timezone: string;
  };
  brand: {
    name: string;
    primaryColor: string;
    accentColor: string;
    textColor: string;
    font: string;
    logoUrl: string;
    watermarkText: string;
    defaultCta: string;
    defaultLanguage: string;
  };
  video: {
    ffmpegPath: string;
    ffprobePath: string;
    durationSeconds: number;
    fps: number;
    musicFile: string;
    musicEnabled: boolean;
  };
  publishing: { dryRun: boolean; metaGraphVersion: string };
  notify: { webhookUrl: string };
  paths: { root: string; vendor: string; fonts: string; assets: string };
}

export function loadConfig(): AppConfig {
  const env = opt('NODE_ENV', 'development');
  const authTokens = [...new Set([...list('API_TOKENS'), opt('API_TOKEN')].map((s) => s.trim()).filter(Boolean))];
  const cfg: AppConfig = {
    env,
    isProd: env === 'production',
    http: {
      host: opt('HTTP_HOST', '0.0.0.0'),
      port: int('HTTP_PORT', 8080),
      publicBaseUrl: opt('PUBLIC_BASE_URL', `http://localhost:${int('HTTP_PORT', 8080)}`),
    },
    security: {
      encryptionKey: opt('ENCRYPTION_KEY', '0'.repeat(64)),
    },
    auth: {
      enabled: authTokens.length > 0,
      tokens: authTokens,
    },
    db: {
      driver: (opt('DATABASE_DRIVER', 'sqlite') as DatabaseDriver),
      sqlitePath: opt('SQLITE_PATH', './data/app.db'),
      url: opt('DATABASE_URL'),
    },
    sheets: {
      store: (opt('SHEET_STORE', 'local') as SheetStore),
      spreadsheetId: opt('GOOGLE_SHEETS_SPREADSHEET_ID'),
      serviceAccountFile: opt('GOOGLE_SERVICE_ACCOUNT_FILE'),
      serviceAccountJson: opt('GOOGLE_SERVICE_ACCOUNT_JSON'),
    },
    storage: {
      driver: (opt('STORAGE_DRIVER', 'local') as StorageDriver),
      localDir: opt('STORAGE_LOCAL_DIR', './data/output'),
      publicBaseUrl: opt('STORAGE_PUBLIC_BASE_URL'),
      gdriveFolderId: opt('GDRIVE_FOLDER_ID'),
    },
    ai: {
      provider: (opt('AI_PROVIDER', 'template') as AiProvider),
      timeoutMs: int('AI_REQUEST_TIMEOUT_MS', 45_000),
      openai: { apiKey: opt('OPENAI_API_KEY'), model: opt('OPENAI_MODEL', 'gpt-4o-mini'), baseUrl: opt('OPENAI_BASE_URL', 'https://api.openai.com/v1') },
      gemini: { apiKey: opt('GEMINI_API_KEY'), model: opt('GEMINI_MODEL', 'gemini-1.5-flash') },
      anthropic: { apiKey: opt('ANTHROPIC_API_KEY'), model: opt('ANTHROPIC_MODEL', 'claude-3-5-sonnet-latest') },
    },
    automation: {
      pollIntervalMinutes: int('POLL_INTERVAL_MINUTES', 5),
      concurrency: int('WORKER_CONCURRENCY', 2),
      retryMax: int('RETRY_MAX', 3),
      retryMinDelayMs: int('RETRY_MIN_DELAY_MS', 1000),
      retryMaxDelayMs: int('RETRY_MAX_DELAY_MS', 30_000),
      jobLockTtlMs: int('JOB_LOCK_TTL_MS', 600_000),
      rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60),
      postingTimes: list('POSTING_TIMES', ['09:00', '13:00', '18:00']),
      timezone: opt('TIMEZONE', 'UTC'),
    },
    brand: {
      name: opt('BRAND_NAME', 'Acme'),
      primaryColor: opt('BRAND_PRIMARY_COLOR', '#0F2027'),
      accentColor: opt('BRAND_ACCENT_COLOR', '#E63946'),
      textColor: opt('BRAND_TEXT_COLOR', '#FFFFFF'),
      font: opt('BRAND_FONT', 'Poppins'),
      logoUrl: opt('BRAND_LOGO_URL'),
      watermarkText: opt('WATERMARK_TEXT', ''),
      defaultCta: opt('DEFAULT_CTA', 'Shop now'),
      defaultLanguage: opt('DEFAULT_LANGUAGE', 'en'),
    },
    video: {
      ffmpegPath: opt('FFMPEG_PATH', 'ffmpeg'),
      ffprobePath: opt('FFPROBE_PATH', 'ffprobe'),
      durationSeconds: Math.max(15, Math.min(30, int('VIDEO_DURATION_SECONDS', 20))),
      fps: int('VIDEO_FPS', 30),
      musicFile: opt('VIDEO_MUSIC_FILE'),
      musicEnabled: bool('VIDEO_MUSIC_ENABLED', true),
    },
    publishing: {
      dryRun: bool('DRY_RUN', true),
      metaGraphVersion: opt('META_GRAPH_VERSION', 'v20.0'),
    },
    notify: { webhookUrl: opt('NOTIFY_WEBHOOK_URL') },
    paths: {
      root: process.cwd(),
      vendor: 'vendor',
      fonts: 'vendor/fonts',
      assets: 'assets',
    },
  };

  logger.setLevel((opt('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error'));
  return cfg;
}

let cached: AppConfig | null = null;
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
