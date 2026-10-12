-- Additive schema: old runners keep working during deployment.
ALTER TABLE runs ADD COLUMN task TEXT;
ALTER TABLE events ADD COLUMN run_id INTEGER;
CREATE INDEX IF NOT EXISTS events_run_id ON events(run_id);
CREATE TABLE IF NOT EXISTS source_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL, due_at INTEGER NOT NULL,
  prompt TEXT NOT NULL, preferred_agent TEXT, status TEXT NOT NULL DEFAULT 'pending',
  run_id INTEGER, attempted_agents TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, detail TEXT,
  UNIQUE(schedule_id, due_at)
);
-- Historic diagnostics had no task field; preserve their logs but exclude them from work metrics.
UPDATE runs SET task='diagnostic' WHERE kind='prompt' AND task IS NULL
  AND (prompt LIKE '%HEALTH_OK%' OR prompt LIKE '%Repair verification only%' OR prompt LIKE '%health check%');
