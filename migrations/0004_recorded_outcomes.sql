-- Credit existing hub reports only when agent and event time identify exactly one run.
-- Keep ambiguous/outside-run reports unassigned; never infer outcomes from the process log.
UPDATE events SET run_id = (
  SELECT MIN(r.id) FROM runs r
  WHERE r.agent=events.agent AND r.kind!='login' AND (r.task IS NULL OR r.task!='diagnostic')
    AND r.started_at IS NOT NULL AND events.at>=r.started_at
    AND (r.finished_at IS NULL OR events.at<=r.finished_at)
)
WHERE run_id IS NULL AND (
  SELECT COUNT(*) FROM runs r
  WHERE r.agent=events.agent AND r.kind!='login' AND (r.task IS NULL OR r.task!='diagnostic')
    AND r.started_at IS NOT NULL AND events.at>=r.started_at
    AND (r.finished_at IS NULL OR events.at<=r.finished_at)
)=1;
