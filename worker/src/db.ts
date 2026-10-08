import type { AgentEvent, Env } from "./types";

/**
 * D1 holds only coordination state: who is working on which job right now (claims), what agents
 * did (events), and when each agent last checked in (heartbeats). ClickUp stays the system of record.
 * Kept in sync with migrations/0001_init.sql; created lazily so a fresh database just works.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS claims (
     task_id TEXT PRIMARY KEY,
     agent TEXT NOT NULL,
     claimed_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     agent TEXT NOT NULL,
     task_id TEXT,
     task_name TEXT,
     type TEXT NOT NULL,
     message TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS events_at ON events (at DESC)`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     key TEXT PRIMARY KEY,
     at INTEGER NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS heartbeats (
     agent TEXT PRIMARY KEY,
     last_seen INTEGER NOT NULL,
     client TEXT
   )`,
];

/** Columns added after the first release; ALTER fails harmlessly when they already exist. */
const ADDED_COLUMNS = ["ALTER TABLE events ADD COLUMN ats TEXT", "ALTER TABLE events ADD COLUMN company TEXT"];

let ready = false;

export async function db(env: Env): Promise<D1Database> {
  if (!ready) {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    for (const sql of ADDED_COLUMNS) await env.DB.prepare(sql).run().catch(() => {});
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS events_ats ON events (type, ats, at)").run();
    ready = true;
  }
  return env.DB;
}

export async function getSetting<T>(env: Env, key: string): Promise<T | null> {
  const r = await (await db(env)).prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r ? (JSON.parse(r.value) as T) : null;
}

export async function setSetting(env: Env, key: string, value: unknown): Promise<void> {
  await (await db(env))
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

export interface Claim {
  taskId: string;
  agent: string;
  claimedAt: number;
  expiresAt: number;
}

export async function activeClaims(env: Env): Promise<Map<string, Claim>> {
  const { results } = await (await db(env))
    .prepare("SELECT task_id, agent, claimed_at, expires_at FROM claims WHERE expires_at > ?")
    .bind(Date.now())
    .all<{ task_id: string; agent: string; claimed_at: number; expires_at: number }>();
  return new Map(
    results.map((r) => [r.task_id, { taskId: r.task_id, agent: r.agent, claimedAt: r.claimed_at, expiresAt: r.expires_at }]),
  );
}

export async function getClaim(env: Env, taskId: string): Promise<Claim | null> {
  const r = await (await db(env))
    .prepare("SELECT task_id, agent, claimed_at, expires_at FROM claims WHERE task_id = ? AND expires_at > ?")
    .bind(taskId, Date.now())
    .first<{ task_id: string; agent: string; claimed_at: number; expires_at: number }>();
  return r ? { taskId: r.task_id, agent: r.agent, claimedAt: r.claimed_at, expiresAt: r.expires_at } : null;
}

/**
 * Atomically take (or renew) a lease. Succeeds only if the job is unclaimed, the old lease expired,
 * or the caller already holds it. One SQL statement, so two agents can never both win.
 */
export async function tryClaim(env: Env, taskId: string, agent: string, ms: number): Promise<number | null> {
  const now = Date.now();
  const expires = now + ms;
  const res = await (await db(env))
    .prepare(
      `INSERT INTO claims (task_id, agent, claimed_at, expires_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (task_id) DO UPDATE SET agent = excluded.agent, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
       WHERE claims.expires_at <= ?3 OR claims.agent = excluded.agent`,
    )
    .bind(taskId, agent, now, expires)
    .run();
  return res.meta.changes === 1 ? expires : null;
}

export async function deleteClaim(env: Env, taskId: string): Promise<void> {
  await (await db(env)).prepare("DELETE FROM claims WHERE task_id = ?").bind(taskId).run();
}

export async function logEvent(
  env: Env,
  e: {
    agent: string;
    taskId?: string | null;
    taskName?: string | null;
    type: string;
    message?: string | null;
    /** Normalized ATS key and company, for pacing. */
    ats?: string | null;
    company?: string | null;
  },
): Promise<void> {
  await (await db(env))
    .prepare("INSERT INTO events (at, agent, task_id, task_name, type, message, ats, company) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(Date.now(), e.agent, e.taskId ?? null, e.taskName ?? null, e.type, e.message ? e.message.slice(0, 2000) : null, e.ats ?? null, e.company ?? null)
    .run();
}

export async function listEvents(env: Env, limit = 100): Promise<AgentEvent[]> {
  const { results } = await (await db(env))
    .prepare("SELECT id, at, agent, task_id, task_name, type, message FROM events ORDER BY at DESC LIMIT ?")
    .bind(Math.min(500, Math.max(1, limit)))
    .all<{ id: number; at: number; agent: string; task_id: string | null; task_name: string | null; type: string; message: string | null }>();
  return results.map((r) => ({
    id: r.id,
    at: new Date(r.at).toISOString(),
    agent: r.agent,
    taskId: r.task_id,
    taskName: r.task_name,
    type: r.type,
    message: r.message,
  }));
}

export async function heartbeat(env: Env, agent: string, client: string | null): Promise<void> {
  await (await db(env))
    .prepare(
      `INSERT INTO heartbeats (agent, last_seen, client) VALUES (?1, ?2, ?3)
       ON CONFLICT (agent) DO UPDATE SET last_seen = excluded.last_seen, client = excluded.client`,
    )
    .bind(agent, Date.now(), client ? client.slice(0, 120) : null)
    .run();
}

export async function listHeartbeats(env: Env): Promise<{ agent: string; lastSeen: string; client: string | null }[]> {
  const { results } = await (await db(env))
    .prepare("SELECT agent, last_seen, client FROM heartbeats ORDER BY last_seen DESC")
    .all<{ agent: string; last_seen: number; client: string | null }>();
  return results.map((r) => ({ agent: r.agent, lastSeen: new Date(r.last_seen).toISOString(), client: r.client }));
}

/** Last good copy of a computed response (e.g. the public summary), served when ClickUp is down. */
export async function saveSnapshot(env: Env, key: string, body: string): Promise<void> {
  await (await db(env))
    .prepare(
      `INSERT INTO snapshots (key, at, body) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET at = excluded.at, body = excluded.body`,
    )
    .bind(key, Date.now(), body)
    .run();
}

export async function loadSnapshot(env: Env, key: string): Promise<{ body: string; at: number } | null> {
  const r = await (await db(env))
    .prepare("SELECT body, at FROM snapshots WHERE key = ?")
    .bind(key)
    .first<{ body: string; at: number }>();
  return r ?? null;
}

/** Last time any agent did something (claim, report, add). */
export async function lastEventAt(env: Env): Promise<string | null> {
  const r = await (await db(env)).prepare("SELECT MAX(at) AS at FROM events").first<{ at: number | null }>();
  return r?.at ? new Date(r.at).toISOString() : null;
}
