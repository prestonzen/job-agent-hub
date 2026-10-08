-- Last good copy of computed responses (public summary), served when ClickUp is unavailable.
CREATE TABLE IF NOT EXISTS snapshots (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  body TEXT NOT NULL
);
