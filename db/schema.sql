-- Forkless Core Schema — 8 tables
-- All statements are idempotent (safe to re-run)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journey_instances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  journey_type TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'not_started',
  campaign_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_journey_instances_user_id ON journey_instances(user_id);
CREATE INDEX IF NOT EXISTS idx_journey_instances_status ON journey_instances(status);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  journey_instance_id TEXT REFERENCES journey_instances(id),
  messages TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_journey ON conversations(journey_instance_id);

CREATE TABLE IF NOT EXISTS events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_instance_id TEXT NOT NULL REFERENCES journey_instances(id),
  type TEXT NOT NULL,
  source TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_log_journey ON events_log(journey_instance_id);
CREATE INDEX IF NOT EXISTS idx_events_log_type ON events_log(type);

CREATE TABLE IF NOT EXISTS business_records (
  id TEXT PRIMARY KEY,
  journey_instance_id TEXT NOT NULL REFERENCES journey_instances(id),
  record_type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_business_records_journey ON business_records(journey_instance_id);
CREATE INDEX IF NOT EXISTS idx_business_records_type ON business_records(record_type);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  product_type TEXT NOT NULL,         -- 'lab_panel', 'lab_test', 'bundle', 'rx', 'consult', 'plan', 'ebook'
  category TEXT,                       -- e.g. 'MALE', 'FEMALE', 'UNISEX'
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', -- flexible JSON (panel_ids, included tests, etc.)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_type ON products(product_type);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

CREATE TABLE IF NOT EXISTS product_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  price_cents INTEGER NOT NULL,
  cost_cents INTEGER,                  -- supplier/COGS cost for margin analysis
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_to TEXT,                    -- NULL = indefinite (current price)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_prices_product ON product_prices(product_id);
CREATE INDEX IF NOT EXISTS idx_product_prices_effective ON product_prices(product_id, effective_from);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  config TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT
);
