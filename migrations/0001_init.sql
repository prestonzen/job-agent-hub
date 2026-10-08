-- Coordination state only; ClickUp is the system of record. Mirrors SCHEMA in worker/src/db.ts.
CREATE TABLE IF NOT EXISTS claims (
  task_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  agent TEXT NOT NULL,
  task_id TEXT,
  task_name TEXT,
  type TEXT NOT NULL,
  message TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);

CREATE TABLE IF NOT EXISTS heartbeats (
  agent TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  client TEXT
);
