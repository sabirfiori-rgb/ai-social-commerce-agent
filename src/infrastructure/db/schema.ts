/**
 * SQLite schema (idempotent DDL). Covers:
 *  - operational tables (jobs, generated content, assets, videos, publications,
 *    logs, analytics events, settings, social accounts, dedupe)
 *  - a local mirror of the six sheet tabs (used by the Local sheet store so the
 *    app runs end-to-end with zero external credentials).
 *
 * The repository layer is abstracted; a Postgres port can implement the same
 * DDL with minor type adjustments (TEXT→TEXT, INTEGER→BIGINT, etc.).
 */
export const SCHEMA_SQL = /* sql */ `
-- ---------- Operational tables ----------
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  product_row_id TEXT NOT NULL,
  product_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  locked_by     TEXT,
  locked_at     TEXT,
  available_at  TEXT NOT NULL,
  last_error    TEXT,
  payload       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_jobs_row ON jobs(product_row_id);

CREATE TABLE IF NOT EXISTS generated_content (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL,
  tone          TEXT NOT NULL,
  language      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  captions      TEXT NOT NULL DEFAULT '[]',
  hooks         TEXT NOT NULL DEFAULT '[]',
  ctas          TEXT NOT NULL DEFAULT '[]',
  hashtags      TEXT NOT NULL DEFAULT '[]',
  seo_keywords  TEXT NOT NULL DEFAULT '[]',
  emojis        TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_product ON generated_content(product_id);

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  platform    TEXT,
  idx         INTEGER,
  path        TEXT NOT NULL,
  storage_key TEXT,
  url         TEXT,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_product ON assets(product_id);

CREATE TABLE IF NOT EXISTS videos (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  path         TEXT NOT NULL,
  storage_key  TEXT,
  url          TEXT,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  duration_sec REAL NOT NULL,
  fps          INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_product ON videos(product_id);

CREATE TABLE IF NOT EXISTS publications (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  platform     TEXT NOT NULL,
  account_id   TEXT,
  status       TEXT NOT NULL,
  scheduled_at TEXT,
  published_at TEXT,
  remote_id    TEXT,
  permalink    TEXT,
  caption      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pub_product ON publications(product_id);
CREATE INDEX IF NOT EXISTS idx_pub_status ON publications(status);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  level      TEXT NOT NULL,
  stage      TEXT NOT NULL,
  message    TEXT NOT NULL,
  product_id TEXT,
  job_id     TEXT,
  data       TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_product ON logs(product_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id                    TEXT PRIMARY KEY,
  platform              TEXT NOT NULL,
  label                 TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  is_default            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON social_accounts(platform);

CREATE TABLE IF NOT EXISTS dedupe (
  key        TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  product_id  TEXT,
  platform    TEXT,
  value       REAL,
  duration_ms INTEGER,
  data        TEXT
);
CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(type);

-- ---------- Local mirror of the six sheet tabs ----------
CREATE TABLE IF NOT EXISTS sheet_products (
  id                TEXT PRIMARY KEY,
  seq               INTEGER,
  status            TEXT NOT NULL DEFAULT 'NEW',
  product_source    TEXT,
  product_url       TEXT,
  product_id        TEXT,
  brand             TEXT,
  platform          TEXT,
  language          TEXT,
  category          TEXT,
  schedule_date     TEXT,
  schedule_time     TEXT,
  generated_caption TEXT,
  generated_video   TEXT,
  published_url     TEXT,
  error             TEXT,
  created_time      TEXT,
  updated_time      TEXT,
  lock_token        TEXT,
  lock_worker       TEXT,
  lock_expires      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sheet_products_status ON sheet_products(status);

CREATE TABLE IF NOT EXISTS sheet_brand_settings (
  brand         TEXT PRIMARY KEY,
  primary_color TEXT,
  accent_color  TEXT,
  text_color    TEXT,
  font          TEXT,
  logo_url      TEXT,
  watermark     TEXT,
  cta           TEXT,
  language      TEXT
);

CREATE TABLE IF NOT EXISTS sheet_schedule (
  id           TEXT PRIMARY KEY,
  product_id   TEXT,
  platform     TEXT,
  scheduled_at TEXT,
  status       TEXT,
  published_at TEXT,
  permalink    TEXT,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS sheet_generated (
  id         TEXT PRIMARY KEY,
  product_id TEXT,
  platform   TEXT,
  tone       TEXT,
  caption    TEXT,
  hashtags   TEXT,
  hooks      TEXT,
  ctas       TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sheet_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  time       TEXT,
  level      TEXT,
  product_id TEXT,
  job_id     TEXT,
  stage      TEXT,
  message    TEXT,
  data       TEXT
);

CREATE TABLE IF NOT EXISTS sheet_analytics (
  date               TEXT PRIMARY KEY,
  products_processed INTEGER,
  posts_published    INTEGER,
  videos_created     INTEGER,
  queue_size         INTEGER,
  failed_jobs        INTEGER,
  success_rate       REAL,
  avg_processing_ms  INTEGER
);
`;
