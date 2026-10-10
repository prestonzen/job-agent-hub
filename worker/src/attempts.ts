import { db } from "./db";
import type { Env } from "./types";

/**
 * Attempt logs. When an agent fails a job, parks it, or hands it over, it saves what it did: the
 * fields it filled, the answers it gave (essays in full), and where and why it stopped. The next
 * agent (normally Kimi, the fallback) gets that log with the job and carries on instead of starting
 * from zero. Kept short on purpose: the point is speed, not an archive.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT NOT NULL,
     agent TEXT NOT NULL,
     outcome TEXT NOT NULL,
     note TEXT,
     log TEXT,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS attempts_task ON attempts (task_id, at)`,
];

let ready = false;
async function adb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.batch(SCHEMA.map((s) => d.prepare(s)));
    ready = true;
  }
  return d;
}

const LOG_CAP = 12_000;

export interface Attempt {
  agent: string;
  at: string;
  outcome: string;
  note: string | null;
  log: string | null;
}

export async function saveAttempt(env: Env, taskId: string, agent: string, outcome: string, note: string | null, log: string | null): Promise<void> {
  await (await adb(env))
    .prepare("INSERT INTO attempts (task_id, agent, outcome, note, log, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(taskId, agent, outcome, note ? note.slice(0, 1000) : null, log ? log.slice(0, LOG_CAP) : null, Date.now())
    .run();
}

/** The most recent attempts at a job, oldest first (so they read as a story). */
export async function listAttempts(env: Env, taskId: string, limit = 3): Promise<Attempt[]> {
  const { results } = await (await adb(env))
    .prepare("SELECT agent, outcome, note, log, at FROM attempts WHERE task_id = ? ORDER BY at DESC LIMIT ?")
    .bind(taskId, limit)
    .all<{ agent: string; outcome: string; note: string | null; log: string | null; at: number }>();
  return results.reverse().map((r) => ({ agent: r.agent, at: new Date(r.at).toISOString(), outcome: r.outcome, note: r.note, log: r.log }));
}

export async function countFailures(env: Env, taskId: string): Promise<number> {
  const r = await (await adb(env)).prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND outcome = 'failed'").bind(taskId).first<{ n: number }>();
  return r?.n ?? 0;
}
