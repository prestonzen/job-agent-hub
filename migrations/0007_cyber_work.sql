CREATE TABLE IF NOT EXISTS cyber_work (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL, program TEXT NOT NULL, platform TEXT NOT NULL,
 target TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', agent TEXT, run_id INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0, verdict TEXT, result TEXT,
 review TEXT, feedback TEXT, reviewed_at INTEGER, detail TEXT
);
