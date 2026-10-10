import { db, getSetting, setSetting } from "./db";
import type { Env, Task } from "./types";

/**
 * Local copy of the ClickUp list in D1, so dozens of agents don't each re-read ClickUp.
 * Reads come from here (refreshed at most every MAX_AGE); the hub patches it on every write;
 * when ClickUp is rate-limited or down, reads keep working from the last copy.
 */

const MAX_AGE_MS = 10 * 60_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS task_mirror (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS clickup_outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT,
     created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS api_usage (day TEXT NOT NULL, api TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY (day, api))`,
];

let ready = false;
export async function mdb(env: Env): Promise<D1Database> {
  const d = await db(env);
  if (!ready) {
    await d.batch(SCHEMA.map((s) => d.prepare(s)));
    ready = true;
  }
  return d;
}

export async function mirrorTasks(env: Env): Promise<Task[]> {
  const { results } = await (await mdb(env)).prepare("SELECT json FROM task_mirror").all<{ json: string }>();
  return results.map((r) => JSON.parse(r.json) as Task);
}

export async function mirrorAge(env: Env): Promise<number> {
  const at = await getSetting<number>(env, "mirror_synced_at").catch(() => null);
  return at ? Date.now() - at : Infinity;
}

/** Replace the copy with a fresh full read (tasks gone from ClickUp are dropped). */
export async function replaceMirror(env: Env, tasks: Task[]): Promise<void> {
  const d = await mdb(env);
  const now = Date.now();
  const stmts = [d.prepare("DELETE FROM task_mirror")];
  for (const t of tasks) stmts.push(d.prepare("INSERT INTO task_mirror (id, json, updated_at) VALUES (?, ?, ?)").bind(t.id, JSON.stringify(t), now));
  for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
  await setSetting(env, "mirror_synced_at", now);
}

export async function upsertMirror(env: Env, t: Task): Promise<void> {
  await (await mdb(env))
    .prepare("INSERT INTO task_mirror (id, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
    .bind(t.id, JSON.stringify(t), Date.now())
    .run();
}

/** Apply a hub write to the copy right away (so the next read is correct without a re-fetch). */
export async function patchMirror(env: Env, id: string, patch: Partial<Task>): Promise<void> {
  const d = await mdb(env);
  const row = await d.prepare("SELECT json FROM task_mirror WHERE id = ?").bind(id).first<{ json: string }>();
  if (!row) return;
  await upsertMirror(env, { ...(JSON.parse(row.json) as Task), ...patch, updatedAt: new Date().toISOString() });
}

/** True when the copy is fresh enough to serve without asking ClickUp. */
export const isFresh = (ageMs: number) => ageMs < MAX_AGE_MS;

// ---------- ClickUp API usage counter (per UTC day) ----------

export async function countCall(env: Env, api = "clickup"): Promise<void> {
  await (await mdb(env))
    .prepare("INSERT INTO api_usage (day, api, calls) VALUES (?1, ?2, 1) ON CONFLICT (day, api) DO UPDATE SET calls = calls + 1")
    .bind(new Date().toISOString().slice(0, 10), api)
    .run()
    .catch(() => {});
}

export async function usageToday(env: Env): Promise<Record<string, number>> {
  const { results } = await (await mdb(env))
    .prepare("SELECT api, calls FROM api_usage WHERE day = ?")
    .bind(new Date().toISOString().slice(0, 10))
    .all<{ api: string; calls: number }>();
  return Object.fromEntries(results.map((r) => [r.api, r.calls]));
}

// ---------- outbox: writes deferred while ClickUp is rate-limited or down ----------

export async function enqueueWrite(env: Env, method: string, path: string, body: string | null, error: string): Promise<void> {
  await (await mdb(env))
    .prepare("INSERT INTO clickup_outbox (method, path, body, created_at, last_error) VALUES (?, ?, ?, ?, ?)")
    .bind(method, path, body, Date.now(), error.slice(0, 300))
    .run();
}

export async function outboxSize(env: Env): Promise<number> {
  return (await (await mdb(env)).prepare("SELECT COUNT(*) AS n FROM clickup_outbox").first<{ n: number }>())?.n ?? 0;
}

/** Replay deferred writes in order; stop at the first failure (still limited/down). */
export async function flushOutbox(env: Env, send: (method: string, path: string, body: string | null) => Promise<void>): Promise<number> {
  const d = await mdb(env);
  const { results } = await d.prepare("SELECT id, method, path, body FROM clickup_outbox ORDER BY id LIMIT 40").all<{ id: number; method: string; path: string; body: string | null }>();
  let done = 0;
  for (const w of results) {
    try {
      await send(w.method, w.path, w.body);
      await d.prepare("DELETE FROM clickup_outbox WHERE id = ?").bind(w.id).run();
      done++;
    } catch (e) {
      await d.prepare("UPDATE clickup_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?").bind(String((e as Error).message).slice(0, 300), w.id).run();
      break;
    }
  }
  return done;
}
