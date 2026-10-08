import { HttpError } from "./clickup";
import { agentInstructions } from "./instructions";
import { esc, notify } from "./telegram";
import type { Env } from "./types";

/**
 * Remote agent runs. The admin queues a run ("Gemini: work 4 jobs"); a runner process on an
 * always-on machine (runner/runner.mjs) claims it, starts that agent's CLI headless, streams the
 * output back, and checks for a cancel on every log flush. D1 is the only shared state.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     agent TEXT NOT NULL,
     kind TEXT NOT NULL,
     prompt TEXT,
     count INTEGER,
     status TEXT NOT NULL DEFAULT 'queued',
     runner TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER,
     exit_code INTEGER,
     cancel INTEGER NOT NULL DEFAULT 0,
     log TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS runs_status ON runs (status, id)`,
  `CREATE TABLE IF NOT EXISTS runners (
     name TEXT PRIMARY KEY,
     last_seen INTEGER NOT NULL,
     agents TEXT NOT NULL,
     slots INTEGER NOT NULL,
     busy INTEGER NOT NULL,
     version TEXT,
     host TEXT
   )`,
];

let ready = false;
async function db(env: Env): Promise<D1Database> {
  if (!ready) {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    ready = true;
  }
  return env.DB;
}

/** Keep the tail of the log; runs can be chatty. */
const LOG_CAP = 200_000;
export const RUN_KINDS = ["queue", "prompt"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface RunRow {
  id: number;
  agent: string;
  kind: RunKind;
  prompt: string | null;
  count: number | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  runner: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  cancel: boolean;
  logSize: number;
  log?: string;
}

interface DbRun {
  id: number;
  agent: string;
  kind: RunKind;
  prompt: string | null;
  count: number | null;
  status: RunRow["status"];
  runner: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  cancel: number;
  log_size: number;
  log?: string;
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const toRow = (r: DbRun): RunRow => ({
  id: r.id,
  agent: r.agent,
  kind: r.kind,
  prompt: r.prompt,
  count: r.count,
  status: r.status,
  runner: r.runner,
  createdAt: iso(r.created_at)!,
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  exitCode: r.exit_code,
  cancel: !!r.cancel,
  logSize: r.log_size,
  ...(r.log !== undefined ? { log: r.log } : {}),
});

const COLS = "id, agent, kind, prompt, count, status, runner, created_at, started_at, finished_at, exit_code, cancel, length(log) AS log_size";

// ---------- admin ----------

export async function createRun(env: Env, r: { agent: string; kind: RunKind; prompt?: string; count?: number }): Promise<RunRow> {
  if (!RUN_KINDS.includes(r.kind)) throw new HttpError(400, `kind must be one of ${RUN_KINDS.join(", ")}`);
  if (r.kind === "prompt" && !r.prompt?.trim()) throw new HttpError(400, "prompt is required for a custom run");
  const count = r.kind === "queue" ? Math.min(10, Math.max(1, Math.floor(r.count ?? 4))) : null;
  const row = await (await db(env))
    .prepare(`INSERT INTO runs (agent, kind, prompt, count, created_at) VALUES (?, ?, ?, ?, ?) RETURNING ${COLS}`)
    .bind(r.agent.toLowerCase(), r.kind, r.kind === "prompt" ? r.prompt!.trim().slice(0, 8000) : null, count, Date.now())
    .first<DbRun>();
  return toRow(row!);
}

export async function listRuns(env: Env, limit = 50): Promise<RunRow[]> {
  const { results } = await (await db(env))
    .prepare(`SELECT ${COLS} FROM runs ORDER BY id DESC LIMIT ?`)
    .bind(Math.min(200, Math.max(1, limit)))
    .all<DbRun>();
  return results.map(toRow);
}

export async function getRun(env: Env, id: number): Promise<RunRow> {
  const r = await (await db(env)).prepare(`SELECT ${COLS}, log FROM runs WHERE id = ?`).bind(id).first<DbRun>();
  if (!r) throw new HttpError(404, `no run ${id}`);
  return toRow(r);
}

/** Queued runs are cancelled at once; running ones are flagged and the runner kills them on its next flush. */
export async function cancelRun(env: Env, id: number): Promise<RunRow> {
  const d = await db(env);
  await d.batch([
    d.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").bind(Date.now(), id),
    d.prepare("UPDATE runs SET cancel = 1 WHERE id = ? AND status = 'running'").bind(id),
  ]);
  return getRun(env, id);
}

export interface RunnerInfo {
  name: string;
  lastSeen: string;
  online: boolean;
  agents: { id: string; installed: boolean; ready: boolean; version?: string | null; note?: string | null }[];
  slots: number;
  busy: number;
  version: string | null;
  host: string | null;
}

export async function listRunners(env: Env): Promise<RunnerInfo[]> {
  const { results } = await (await db(env))
    .prepare("SELECT name, last_seen, agents, slots, busy, version, host FROM runners ORDER BY last_seen DESC")
    .all<{ name: string; last_seen: number; agents: string; slots: number; busy: number; version: string | null; host: string | null }>();
  return results.map((r) => ({
    name: r.name,
    lastSeen: iso(r.last_seen)!,
    online: Date.now() - r.last_seen < 90_000,
    agents: JSON.parse(r.agents),
    slots: r.slots,
    busy: r.busy,
    version: r.version,
    host: r.host,
  }));
}

// ---------- runner ----------

export function isRunnerToken(env: Env, request: Request): boolean {
  const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  const tok = env.RUNNER_TOKEN ?? "";
  if (!m || tok.length < 24) return false;
  const given = m[1].trim();
  if (given.length !== tok.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export async function runnerHeartbeat(
  env: Env,
  h: { name: string; agents: RunnerInfo["agents"]; slots: number; busy: number; version?: string; host?: string; active?: number[] },
): Promise<void> {
  const d = await db(env);
  const name = h.name.slice(0, 60);
  const active = (h.active ?? []).filter(Number.isInteger);
  await d.batch([
    d
      .prepare(
        `INSERT INTO runners (name, last_seen, agents, slots, busy, version, host) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (name) DO UPDATE SET last_seen = excluded.last_seen, agents = excluded.agents, slots = excluded.slots,
           busy = excluded.busy, version = excluded.version, host = excluded.host`,
      )
      .bind(name, Date.now(), JSON.stringify(h.agents ?? []).slice(0, 8000), h.slots, h.busy, h.version ?? null, h.host ?? null),
    // Runs this runner owns but no longer reports (it restarted mid-run) are marked failed.
    d
      .prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?1, log = substr(log || ?2, -${LOG_CAP})
         WHERE runner = ?3 AND status = 'running' AND started_at < ?4 AND id NOT IN (SELECT value FROM json_each(?5))`,
      )
      .bind(Date.now(), "\n[hub] runner stopped reporting this run (restarted?); marked failed.\n", name, Date.now() - 60_000, JSON.stringify(active)),
  ]);
}

/** Atomically hand the oldest queued run for one of `agents` to this runner, with its full prompt. */
export async function claimRun(env: Env, runner: string, agents: string[], origin: string): Promise<(RunRow & { fullPrompt: string }) | null> {
  const list = agents.map((a) => a.toLowerCase()).filter(Boolean);
  if (!list.length) return null;
  const r = await (await db(env))
    .prepare(
      `UPDATE runs SET status = 'running', runner = ?1, started_at = ?2
       WHERE id = (SELECT id FROM runs WHERE status = 'queued' AND agent IN (SELECT value FROM json_each(?3)) ORDER BY id LIMIT 1)
       RETURNING ${COLS}`,
    )
    .bind(runner.slice(0, 60), Date.now(), JSON.stringify(list))
    .first<DbRun>();
  if (!r) return null;
  const row = toRow(r);
  const fullPrompt =
    row.kind === "queue"
      ? `${agentInstructions(row.agent, origin, "mcp")}\n\nTHIS RUN: work up to ${row.count} jobs from the queue (claim them with claim_jobs), report each one, then stop and print a one-line summary per job.`
      : row.prompt!;
  return { ...row, fullPrompt };
}

export async function appendLog(env: Env, id: number, runner: string, chunk: string): Promise<{ cancel: boolean }> {
  const r = await (await db(env))
    .prepare(`UPDATE runs SET log = substr(log || ?1, -${LOG_CAP}) WHERE id = ?2 AND runner = ?3 RETURNING cancel, status`)
    .bind(chunk.slice(-LOG_CAP), id, runner)
    .first<{ cancel: number; status: string }>();
  if (!r) throw new HttpError(404, `run ${id} is not held by ${runner}`);
  return { cancel: !!r.cancel || r.status !== "running" };
}

export async function finishRun(env: Env, id: number, runner: string, f: { exitCode: number | null; cancelled?: boolean }): Promise<void> {
  const status = f.cancelled ? "cancelled" : f.exitCode === 0 ? "succeeded" : "failed";
  const r = await (await db(env))
    .prepare(
      `UPDATE runs SET status = ?1, exit_code = ?2, finished_at = ?3 WHERE id = ?4 AND runner = ?5 AND status = 'running'
       RETURNING agent, kind, count, started_at, finished_at, substr(log, -1500) AS tail`,
    )
    .bind(status, f.exitCode, Date.now(), id, runner)
    .first<{ agent: string; kind: string; count: number | null; started_at: number; finished_at: number; tail: string }>();
  if (r) {
    const mins = Math.max(1, Math.round((r.finished_at - r.started_at) / 60_000));
    const icon = status === "succeeded" ? "✅" : status === "cancelled" ? "⏹️" : "⚠️";
    const tail = r.tail.trim().split("\n").slice(-12).join("\n");
    await notify(
      env,
      `${icon} Run #${id} <b>${esc(r.agent)}</b> ${r.kind === "queue" ? `(work ${r.count} jobs)` : "(custom)"} ${status} on ${esc(runner)} after ${mins} min` +
        (tail ? `\n<pre>${esc(tail.slice(-1200))}</pre>` : ""),
      { silent: status === "succeeded" },
    );
  }
}
