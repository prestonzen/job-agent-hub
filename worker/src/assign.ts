import { db } from "./db";
import type { Env } from "./types";

/**
 * Handoffs: an agent that can't finish a job (an essay with nothing verified to build it from, a
 * question it can't answer) gives it to another agent, normally Kimi, instead of skipping it.
 * An assigned job is claimable only by its assignee, and ahead of the rest of the queue, for 6 hours;
 * after that it returns to the shared pool.
 */

const TTL_MS = 6 * 3_600_000;
export const FALLBACK_AGENT = "kimi";

const SCHEMA = `CREATE TABLE IF NOT EXISTS assignments (
  task_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  reason TEXT,
  by_agent TEXT,
  created_at INTEGER NOT NULL
)`;

let ready = false;
async function adb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.prepare(SCHEMA).run();
    ready = true;
  }
  return d;
}

export interface Assignment {
  agent: string;
  reason: string | null;
  by: string | null;
}

export async function activeAssignments(env: Env): Promise<Map<string, Assignment>> {
  const { results } = await (await adb(env))
    .prepare("SELECT task_id, agent, reason, by_agent FROM assignments WHERE created_at > ?")
    .bind(Date.now() - TTL_MS)
    .all<{ task_id: string; agent: string; reason: string | null; by_agent: string | null }>();
  return new Map(results.map((r) => [r.task_id, { agent: r.agent, reason: r.reason, by: r.by_agent }]));
}

export async function getAssignment(env: Env, taskId: string): Promise<Assignment | null> {
  const r = await (await adb(env))
    .prepare("SELECT agent, reason, by_agent FROM assignments WHERE task_id = ? AND created_at > ?")
    .bind(taskId, Date.now() - TTL_MS)
    .first<{ agent: string; reason: string | null; by_agent: string | null }>();
  return r ? { agent: r.agent, reason: r.reason, by: r.by_agent } : null;
}

export async function assignJob(env: Env, taskId: string, agent: string, reason: string, by: string): Promise<void> {
  await (await adb(env))
    .prepare(
      `INSERT INTO assignments (task_id, agent, reason, by_agent, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (task_id) DO UPDATE SET agent = excluded.agent, reason = excluded.reason, by_agent = excluded.by_agent, created_at = excluded.created_at`,
    )
    .bind(taskId, agent, reason.slice(0, 600), by, Date.now())
    .run();
}

export async function clearAssignment(env: Env, taskId: string): Promise<void> {
  await (await adb(env)).prepare("DELETE FROM assignments WHERE task_id = ?").bind(taskId).run();
}
