ALTER TABLE runs ADD COLUMN dispatch_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS runs_dispatch_key ON runs(dispatch_key);
