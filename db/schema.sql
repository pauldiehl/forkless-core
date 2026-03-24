-- Forkless Core Schema — 6 tables
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

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  config TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT
);
