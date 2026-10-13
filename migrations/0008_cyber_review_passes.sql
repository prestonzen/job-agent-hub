ALTER TABLE cyber_work ADD COLUMN pass_agents TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS cyber_review_passes (
  work_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  agent TEXT NOT NULL,
  run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  verdict TEXT,
  result TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (work_id, sequence),
  FOREIGN KEY (work_id) REFERENCES cyber_work(id)
);
