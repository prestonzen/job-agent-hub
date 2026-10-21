import { HttpError } from "./clickup";
import { agentInstructions } from "./instructions";
import { esc, notify, notifyBounty } from "./telegram";
import type { Env } from "./types";
import { db as eventDb, getSetting, setSetting } from "./db";
import { EMPTY_OUTCOME, TASKS, inferRunTask, outcomeSummary, taskSwitches, workSettings, type RunOutcome, type RunTask } from "./work";

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
    // Added later: earliest start (scheduled runs get a random delay). Fails harmlessly if present.
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN not_before INTEGER").run().catch(() => {});
    // Added later: what a run cost (USD, from the CLI's own report) and how many tokens it burned.
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN cost_usd REAL").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN tokens INTEGER").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN task TEXT").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN dispatch_key TEXT").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN identity TEXT").run().catch(() => {});
    await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS runs_dispatch_key ON runs(dispatch_key)").run();
    ready = true;
  }
  return env.DB;
}

/** Keep the tail of the log; runs can be chatty. */
const LOG_CAP = 200_000;
/** "login" starts an agent CLI's device-code login on the runner; the link is posted to Telegram. */
export const RUN_KINDS = ["queue", "prompt", "login"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface RunRow {
  dispatchKey?: string | null;
  task: RunTask;
  outcome?: RunOutcome;
  summary?: string;
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
  /** Earliest start, for scheduled runs with a random delay. */
  notBefore: string | null;
  log?: string;
}

interface DbRun {
  dispatch_key: string | null;
  task: RunTask | null;
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
  not_before: number | null;
  log?: string;
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const toRow = (r: DbRun): RunRow => ({
  dispatchKey: r.dispatch_key,
  task: r.task ?? inferRunTask(r.kind, r.prompt),
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
  notBefore: iso(r.not_before),
  ...(r.log !== undefined ? { log: r.log } : {}),
});

const COLS = "id, agent, kind, task, dispatch_key, prompt, count, status, runner, created_at, started_at, finished_at, exit_code, cancel, not_before, length(log) AS log_size";

// ---------- admin ----------

export async function createRun(env: Env, r: { agent: string; kind: RunKind; task?: RunTask; prompt?: string; count?: number; notBefore?: number; exclusive?: boolean; dispatchKey?: string }): Promise<RunRow> {
  const agent = r.agent.toLowerCase();
  if (!RUN_KINDS.includes(r.kind)) throw new HttpError(400, `kind must be one of ${RUN_KINDS.join(", ")}`);
  if (r.kind === "prompt" && !r.prompt?.trim()) throw new HttpError(400, "prompt is required for a custom run");
  if (r.kind === "login" && !["codex", "kimi"].includes(r.agent.toLowerCase())) throw new HttpError(400, "phone login works for codex and kimi (device-code flow)");
  const count = r.kind === "queue" ? Math.min(10, Math.max(1, Math.floor(r.count ?? 4))) : null;
  const settings = await workSettings(env);
  const task = r.kind === "login" ? "login" : r.task ?? (r.kind === "queue" && !taskSwitches(settings,agent).applications ? "email" : inferRunTask(r.kind, r.prompt ?? null));
  if (![...TASKS, "custom", "diagnostic", "login", "prep"].includes(task)) throw new HttpError(400, "unknown task");
  if (r.kind === "queue" && task !== "applications" && task !== "email") throw new HttpError(400,"Queue runs must be application or email tasks");
  if (r.kind !== "login") {
    if (settings.agents?.[agent] === false) throw new HttpError(409, `${agent} is switched off`);
    if ((TASKS as readonly string[]).includes(task) && !taskSwitches(settings, agent)[task as keyof ReturnType<typeof taskSwitches>]) throw new HttpError(409, `${task} is switched off for ${agent}`);
  }
  const row = await (await db(env))
    .prepare(`INSERT INTO runs (agent, kind, task, prompt, count, created_at, not_before,dispatch_key)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?10 WHERE ?8=0 OR (NOT EXISTS (SELECT 1 FROM runs WHERE agent=?1 AND status IN ('queued','running'))
      AND (SELECT COUNT(*) FROM runs WHERE kind!='login' AND status IN ('queued','running')) < ?9)
      ON CONFLICT(dispatch_key) DO NOTHING RETURNING ${COLS}`)
    .bind(agent, r.kind, task, r.kind === "prompt" ? r.prompt!.trim().slice(0, 8000) : null, count, Date.now(), r.notBefore ?? null, r.exclusive ? 1 : 0, settings.maxConcurrent ?? 2,r.dispatchKey??null)
    .first<DbRun>();
  if (!row && r.dispatchKey) {
    const existing=await(await db(env)).prepare(`SELECT ${COLS} FROM runs WHERE dispatch_key=?`).bind(r.dispatchKey).first<DbRun>();
    if(existing)return toRow(existing);
  }
  if (!row) throw new HttpError(409, "Agent or fleet task capacity is full");
  return toRow(row);
}

export async function listRuns(env: Env, limit = 50): Promise<RunRow[]> {
  const { results } = await (await db(env))
    .prepare(`SELECT ${COLS} FROM runs ORDER BY id DESC LIMIT ?`)
    .bind(Math.min(200, Math.max(1, limit)))
    .all<DbRun>();
  return attachOutcomes(env, results.map(toRow));
}

export async function getRun(env: Env, id: number): Promise<RunRow> {
  const r = await (await db(env)).prepare(`SELECT ${COLS}, log FROM runs WHERE id = ?`).bind(id).first<DbRun>();
  if (!r) throw new HttpError(404, `no run ${id}`);
  return (await attachOutcomes(env, [toRow(r)]))[0];
}

async function attachOutcomes(env: Env, rows: RunRow[]): Promise<RunRow[]> {
  if (!rows.length) return rows;
  const { results } = await (await eventDb(env)).prepare("SELECT run_id, type, COUNT(*) AS n FROM events WHERE run_id IN (SELECT value FROM json_each(?)) GROUP BY run_id, type").bind(JSON.stringify(rows.map((r) => r.id))).all<{ run_id: number; type: string; n: number }>();
  const counts = new Map<number, RunOutcome>();
  const keys: Record<string, keyof RunOutcome> = { applied: "applied", emailed: "emailed", added: "added", needs_human: "blocked", failed: "failed", skipped: "skipped", claimed: "claimed", cyber_report: "cyber", cyber_triage: "triaged" };
  for (const r of results) { const o = counts.get(r.run_id) ?? { ...EMPTY_OUTCOME }; if (keys[r.type]) o[keys[r.type]] += r.n; counts.set(r.run_id, o); }
  const { results: unfinished } = await (await eventDb(env)).prepare(`SELECT e.run_id,COUNT(DISTINCT e.task_id) AS n FROM events e
    WHERE e.type='claimed' AND e.run_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM events f WHERE f.run_id=e.run_id AND f.task_id=e.task_id
        AND f.type IN ('applied','needs_human','failed','skipped','handoff','released')) GROUP BY e.run_id`).bind(JSON.stringify(rows.map((r)=>r.id))).all<{run_id:number;n:number}>();
  for (const r of unfinished) {const o=counts.get(r.run_id)??{...EMPTY_OUTCOME};o.unfinished=r.n;counts.set(r.run_id,o);}
  return rows.map((r) => { const outcome = counts.get(r.id) ?? { ...EMPTY_OUTCOME }; return { ...r, outcome, summary: outcomeSummary(r.task, r.status, outcome) }; });
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
  agents: { id: string; installed: boolean; signedIn?: boolean | null; ready: boolean; version?: string | null; note?: string | null }[];
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
export async function claimRun(env: Env, runner: string, agents: string[], origin: string, installed: string[] = []): Promise<(RunRow & { fullPrompt: string }) | null> {
  const settings = await workSettings(env);
  const list = agents.map((a) => a.toLowerCase()).filter((a)=>!!a&&settings.agents?.[a]!==false);
  const inst = installed.map((a) => a.toLowerCase()).filter(Boolean);
  if (!list.length && !inst.length) return null;
  const r = await (await db(env))
    .prepare(
      `UPDATE runs SET status = 'running', runner = ?1, started_at = ?2
       WHERE id = (SELECT id FROM runs WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?2)
                   AND ((kind != 'login' AND agent IN (SELECT value FROM json_each(?3))
                     AND (task IN ('custom','diagnostic','prep') OR (task IS NULL AND kind!='queue')
                       OR (task IS NULL AND (json_extract(?5,'$.'||agent||'.applications')=1 OR json_extract(?5,'$.'||agent||'.email')=1))
                       OR json_extract(?5,'$.'||agent||'.'||task)=1))
                     OR (kind = 'login' AND agent IN (SELECT value FROM json_each(?4))))
                   ORDER BY id LIMIT 1)
       RETURNING ${COLS}`,
    )
    .bind(runner.slice(0, 60), Date.now(), JSON.stringify(list), JSON.stringify(inst),JSON.stringify(Object.fromEntries(list.map((a)=>[a,taskSwitches(settings,a)]))))
    .first<DbRun>();
  if (!r) return null;
  const row = toRow(r);
  const fullPrompt =
    row.kind === "login"
      ? ""
      : row.kind === "queue"
      ? `${agentInstructions(row.agent, origin, "mcp")}\n\nTHIS RUN: work up to ${row.count} jobs from the queue (claim them with claim_jobs), report each one, then stop and print a one-line summary per job. ${row.task === "email" ? "This is EMAIL ONLY: claim only email jobs, use email_application with an appropriate resume, never open ATS forms. Work one application at a time. If no eligible email job exists, stop without browsing. Do not invent recipients or send followups." : "Prefer verified email applications when available."}`
      : row.prompt!;
  return { ...row, fullPrompt };
}

export async function appendLog(env: Env, id: number, runner: string, chunk: string): Promise<{ cancel: boolean }> {
  const r = await (await db(env))
    .prepare(`UPDATE runs SET log = substr(log || ?1, -${LOG_CAP}) WHERE id = ?2 AND runner = ?3 RETURNING cancel, status, kind, agent`)
    .bind(chunk.slice(-LOG_CAP), id, runner)
    .first<{ cancel: number; status: string; kind: string; agent: string }>();
  if (!r) throw new HttpError(404, `run ${id} is not held by ${runner}`);
  if (r.kind === "login" && /https?:\/\//.test(chunk)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter((l) => /https?:\/\/|\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b|code|expires/i.test(l));
    await notify(env, `🔑 <b>${esc(r.agent)} login</b> on ${esc(runner)}: open the link and approve.\n${lines.map((l) => esc(l)).join("\n")}\n\n<i>Don't use /login again until this one finishes; that would cancel this code.</i>`);
  }
  return { cancel: !!r.cancel || r.status !== "running" };
}

export async function finishRun(env: Env, id: number, runner: string, f: { exitCode: number | null; cancelled?: boolean; costUsd?: number | null; tokens?: number | null }): Promise<void> {
  const status = f.cancelled ? "cancelled" : f.exitCode === 0 ? "succeeded" : "failed";
  const cost = typeof f.costUsd === "number" && Number.isFinite(f.costUsd) ? Math.round(f.costUsd * 10_000) / 10_000 : null;
  const tokens = typeof f.tokens === "number" && Number.isFinite(f.tokens) ? Math.round(f.tokens) : null;
  const r = await (await db(env))
    .prepare(
      `UPDATE runs SET status = ?1, exit_code = ?2, finished_at = ?3,
         cost_usd = COALESCE(?6, cost_usd), tokens = COALESCE(?7, tokens)
       WHERE id = ?4 AND runner = ?5 AND status = 'running'
       RETURNING agent, kind, count, started_at, finished_at, substr(log, -3000) AS tail`,
    )
    .bind(status, f.exitCode, Date.now(), id, runner, cost, tokens)
    .first<{ agent: string; kind: string; count: number | null; started_at: number; finished_at: number; tail: string }>();
  // A stop that isn't the job's fault (credit empty, quota used, keys resting, login expired): rest the agent
  // until the right reset boundary and keep the run out of the failure streak that pauses autopilot.
  const quota = r && status === "failed" ? quotaStop(r.tail) : null;
  if (r && quota) {
    const d = await db(env);
    await d.prepare("UPDATE runs SET exit_code = 429 WHERE id = ?").bind(id).run();
    await d.prepare("CREATE TABLE IF NOT EXISTS autopilot_state (agent TEXT PRIMARY KEY, next_after INTEGER NOT NULL DEFAULT 0)").run();
    await d.prepare("ALTER TABLE autopilot_state ADD COLUMN reason TEXT").run().catch(() => {});
    const until = new Date(Date.now() + quota.restMs);
    const when = until.toISOString().slice(0, 16).replace("T", " ") + " UTC";
    // Per-agent auto-resume (default on): a timed rest that ends at the next reset. Off = switch the agent off
    // instead, so it stays paused until someone turns it on. An expired login can't fix itself either.
    const ap = (await getSetting<{ agents?: Record<string, boolean>; autoResume?: Record<string, boolean> }>(env, "autopilot").catch(() => null)) ?? {};
    const resumes = ap.autoResume?.[r.agent] !== false && quota.kind !== "auth";
    if (resumes) {
      await d
        .prepare("INSERT INTO autopilot_state (agent, next_after, reason) VALUES (?1, ?2, ?3) ON CONFLICT (agent) DO UPDATE SET next_after = MAX(next_after, ?2), reason = ?3")
        .bind(r.agent, until.getTime(), quota.label)
        .run();
    } else {
      await setSetting(env, "autopilot", { ...ap, agents: { ...(ap.agents ?? {}), [r.agent]: false } });
    }
    const result = await getRun(env, id);
    if (result.task !== "cyber")
      await notify(
        env,
        resumes
          ? `⏳ <b>${esc(r.agent)}</b> paused: ${esc(quota.label)} (run #${id}). Resumes automatically ${esc(when)}.`
          : `⏸️ <b>${esc(r.agent)}</b> switched off: ${esc(quota.label)} (run #${id}). ${quota.kind === "auth" ? "Sign in on the runner, then turn it on" : "Auto-resume is off for this agent; turn it on"} in the agent manager.`,
        { silent: resumes && quota.kind !== "auth" },
      );
  }
  if (r && !quota) {
    const mins = Math.max(1, Math.round((r.finished_at - r.started_at) / 60_000));
    const result = await getRun(env, id);
    const o=result.outcome!;
    // Wins are announced the moment they land — including cyber, which used to be silent here.
    // Everything else (empty "no work recorded" runs, blocked, failed, cancelled) sends NO ping:
    // it rolls into the daily digest in bulk with top reasons (Preston, 2026-10-21: fewer
    // notifications, small wins for morale, failures addressed in bulk).
    const wins = o.applied + o.emailed + o.added + o.cyber + o.triaged;
    if (wins > 0 && !(result.task === "diagnostic" && status === "succeeded")) {
      // Cyber wins land in the Bug Bounty topic; job-hunting wins stay in the hub topic.
      const deliver = result.task === "cyber" ? notifyBounty : notify;
      await deliver(
        env,
        `✅ Run #${id} <b>${esc(r.agent)}</b> (${esc(result.task)}) on ${esc(runner)} after ${mins} min\n${esc(result.summary ?? status)}`,
      );
    }
  }
}

export type RestKind = "credit" | "keys" | "quota" | "auth";
/** Next calendar boundary in UTC: the start of tomorrow, or the 1st of next month. */
const nextBoundary = (unit: "day" | "month", now = Date.now()) => {
  const d = new Date(now);
  return unit === "day" ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Why an agent must stop, and until when. An empty paid-API balance resumes at the next month; free-tier
 * quota and resting keys at the next day unless the message names a shorter wait ("retry in 24m28s",
 * "resets Oct 21, 3pm (UTC)"); an expired login can't fix itself, so it rests a day and asks for a sign-in.
 * null means a real failure.
 */
export function quotaStop(tail: string, now = Date.now()): { restMs: number; kind: RestKind; label: string } | null {
  const t = stripAnsi(tail);
  if (/credit balance is too low|insufficient (?:credit|balance)|out of credits|billing hard limit/i.test(t))
    return { restMs: nextBoundary("month", now) - now, kind: "credit", label: "API credit balance is empty" };
  if (/OAuth session expired|could not be refreshed|Failed to authenticate|not logged in/i.test(t))
    return { restMs: 24 * 3_600_000, kind: "auth", label: "login expired, needs a fresh sign-in" };
  if (/all \d+ key\(s\) are resting|keys? (?:are|is) resting; nothing to run/i.test(t))
    return { restMs: nextBoundary("day", now) - now, kind: "keys", label: "all API keys are resting (daily quota used)" };
  if (!/exceeded your (current )?quota|quota exceeded|RESOURCE_EXHAUSTED|TerminalQuotaError|insufficient_quota|rate.?limit(ed)? (reached|exceeded)|usage limit|hit your .*limit/i.test(t)) return null;
  const m = t.match(/retry in (?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  const ms = m ? ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000 : 0;
  const reset = t.match(/resets\s+([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i);
  if (reset) {
    const month = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(reset[1].toLowerCase());
    if (month >= 0) {
      const hour = Number(reset[3]) % 12 + (reset[5].toLowerCase() === "pm" ? 12 : 0);
      let at = Date.UTC(new Date(now).getUTCFullYear(), month, Number(reset[2]), hour, Number(reset[4] ?? 0));
      if (at < now) at = Date.UTC(new Date(now).getUTCFullYear() + 1, month, Number(reset[2]), hour, Number(reset[4] ?? 0));
      return { restMs: Math.min(7 * 86_400_000, Math.max(3_600_000, at - now + 120_000)), kind: "quota", label: "usage limit reached" };
    }
  }
  const weekly = /weekly limit/i.test(t);
  // A named short wait wins; otherwise rest to the next day (a weekly limit: at least a full day).
  const restMs = ms > 0 ? Math.max(3_600_000, ms + 120_000) : weekly ? Math.max(24 * 3_600_000, nextBoundary("day", now) - now) : nextBoundary("day", now) - now;
  return { restMs: Math.min(7 * 86_400_000, restMs), kind: "quota", label: weekly ? "weekly usage limit reached" : "API quota exhausted" };
}

/** A one-line human reason for a failed run from its log tail: a known signature, else the last meaningful line. */
export function failureReason(tail: string): string | null {
  const t = stripAnsi(tail);
  const known: [RegExp, string][] = [
    [/credit balance is too low|insufficient (?:credit|balance)|out of credits/i, "API credit balance is empty"],
    [/all \d+ key\(s\) are resting|keys? (?:are|is) resting/i, "all API keys are resting (daily quota used)"],
    [/exceeded your (?:current )?quota|quota exceeded|RESOURCE_EXHAUSTED|insufficient_quota|usage limit|hit your .*limit/i, "API quota exhausted"],
    [/rate.?limit/i, "rate limited by the API"],
    [/OAuth session expired|could not be refreshed|Failed to authenticate|not logged in|invalid (?:api|x-api)[ -]key|authentication_error/i, "login or API key rejected, needs a fresh sign-in"],
    [/managed verification|turnstile|cloudflare|403 forbidden|captcha/i, "blocked by Cloudflare / a bot check"],
    [/possible spam|flagged as spam|possible fraud/i, "the ATS flagged the submission as spam"],
    [/ECONNREFUSED|ENOTFOUND|fetch failed|ETIMEDOUT|connect timeout|socket hang up/i, "network error reaching a service"],
    [/iteration limit|max.?turns|tool-calling iteration/i, "ran out of turns before finishing"],
    [/command not found|No such file|ENOENT/i, "the agent command or a file it needs is missing on the runner"],
  ];
  for (const [re, label] of known) if (re.test(t)) return label;
  const lines = t
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\[runner|^={3}|^session_id|^\[task profile\]|^\[session |^To resume|^\s*[{}\]]\s*$/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 140) : null;
}
