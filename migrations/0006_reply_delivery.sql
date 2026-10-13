CREATE TABLE IF NOT EXISTS inbound_notifications (
  message_id TEXT PRIMARY KEY,
  html TEXT NOT NULL,
  silent INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  receipt INTEGER,
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_notification_pending ON inbound_notifications(state,next_at);
