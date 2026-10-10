import { db, getSetting, setSetting } from "./db";
import { isAvailable, queue } from "./jobs";
import { checkJob, getPolicy, pacingState } from "./pacing";
import { createRun, listRunners, listRuns } from "./runs";
import { esc, notify } from "./telegram";
import type { Env } from "./types";

/**
 * Autopilot: while Active, every logged-in agent on an online runner keeps working the queue with
 * no schedule needed. It is evaluated on every runner heartbeat (~30 s), launches at most one run
 * per tick, and only when a job could actually be claimed right now (pacing, daily cap and parked
 * jobs already accounted for), so it never starts a run just to find nothing to do.
 */

export interface AutopilotSettings {
  enabled: boolean;
  /** Runs allowed in flight at once across all agents. */
  maxConcurrent: number;
  jobsPerRun: number;
  /** Minimum quiet time between one agent's runs (a random 0–60% is added). */
  minGapMin: number;
  /** Per-agent switch; missing = on. */
  agents: Record<string, boolean>;
}

const DEFAULTS: AutopilotSettings = { enabled: true, maxConcurrent: 2, jobsPerRun: 3, minGapMin: 25, agents: {} };
const FAIL_STREAK_PAUSE = 3;

export async function getAutopilot(env: Env): Promise<AutopilotSettings> {
  const saved = await getSetting<Partial<AutopilotSettings>>(env, "autopilot").catch(() => null);
  return { ...DEFAULTS, ...(saved ?? {}), agents: { ...(saved?.agents ?? {}) } };
}

export async function saveAutopilot(env: Env, patch: Partial<AutopilotSettings>): Promise<AutopilotSettings> {
  const cur = await getAutopilot(env);
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const next: AutopilotSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    maxConcurrent: num(patch.maxConcurrent, 1, 6, cur.maxConcurrent),
    jobsPerRun: num(patch.jobsPerRun, 1, 10, cur.jobsPerRun),
    minGapMin: num(patch.minGapMin, 5, 720, cur.minGapMin),
    agents: { ...cur.agents, ...(patch.agents ?? {}) },
  };
  await setSetting(env, "autopilot", next);
  return next;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS autopilot_state (agent TEXT PRIMARY KEY, next_after INTEGER NOT NULL DEFAULT 0)`;
let ready = false;
async function adb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.prepare(SCHEMA).run();
    ready = true;
  }
  return d;
}

export interface AgentAutopilot {
  agent: string;
  state: "working" | "queued" | "waiting" | "ready" | "paused" | "off" | "not-ready";
  nextAt: string | null;
  detail: string | null;
}

/** Most recent finished agent runs (queue/prompt kinds), newest first. */
const finished = (runs: Awaited<ReturnType<typeof listRuns>>, agent: string) =>
  runs.filter((r) => r.agent === agent && r.kind !== "login" && ["succeeded", "failed", "cancelled"].includes(r.status));

function failStreak(runs: Awaited<ReturnType<typeof listRuns>>, agent: string): number {
  let n = 0;
  for (const r of finished(runs, agent)) {
    if (r.status === "failed") n++;
    else if (r.status === "succeeded") break;
  }
  return n;
}

export async function autopilotStatus(env: Env) {
  const [s, runners, runs, d] = await Promise.all([getAutopilot(env), listRunners(env), listRuns(env, 80), adb(env)]);
  const { results } = await d.prepare("SELECT agent, next_after FROM autopilot_state").all<{ agent: string; next_after: number }>();
  const next = new Map(results.map((r) => [r.agent, r.next_after]));
  const readySet = new Set(runners.filter((r) => r.online).flatMap((r) => r.agents.filter((a) => a.ready).map((a) => a.id)));
  const known = new Set([...readySet, ...runners.flatMap((r) => r.agents.map((a) => a.id))]);
  const agents: AgentAutopilot[] = [...known].sort().map((agent) => {
    const active = runs.find((r) => r.agent === agent && r.kind !== "login" && (r.status === "running" || r.status === "queued"));
    const streak = failStreak(runs, agent);
    const n = next.get(agent) ?? 0;
    if (s.agents[agent] === false) return { agent, state: "off", nextAt: null, detail: "switched off" };
    if (!readySet.has(agent)) return { agent, state: "not-ready", nextAt: null, detail: "not logged in on a runner" };
    if (streak >= FAIL_STREAK_PAUSE) return { agent, state: "paused", nextAt: null, detail: `${streak} failed runs in a row` };
    if (active) return { agent, state: active.status === "running" ? "working" : "queued", nextAt: null, detail: `run #${active.id}` };
    if (n > Date.now()) return { agent, state: "waiting", nextAt: new Date(n).toISOString(), detail: null };
    return { agent, state: "ready", nextAt: null, detail: null };
  });
  return { settings: s, agents };
}

/** Launch at most one run if Active and there is real work. Returns a short note for logs. */
export async function autopilotTick(env: Env): Promise<string | null> {
  const s = await getAutopilot(env);
  if (!s.enabled || env.MOCK === "true") return null;

  const [runners, runs, jobs, policy] = await Promise.all([listRunners(env), listRuns(env, 80), queue(env), getPolicy(env)]);
  const online = runners.filter((r) => r.online);
  if (!online.length) return null;
  const freeSlots = online.reduce((n, r) => n + Math.max(0, r.slots - r.busy), 0);
  const inFlight = runs.filter((r) => r.kind !== "login" && (r.status === "running" || r.status === "queued"));
  if (inFlight.length >= s.maxConcurrent || freeSlots <= inFlight.filter((r) => r.status === "queued").length) return null;

  // Is anything claimable right now (not parked, not paced, under the daily cap)?
  const pace = await pacingState(env, jobs, policy);
  const claimable = jobs.filter((j) => isAvailable(j) && checkJob(j, pace, policy).ok).length;
  if (claimable === 0) return null;

  const d = await adb(env);
  const readyAgents = [...new Set(online.flatMap((r) => r.agents.filter((a) => a.ready).map((a) => a.id)))].filter((a) => s.agents[a] !== false);
  const { results } = await d.prepare("SELECT agent, next_after FROM autopilot_state").all<{ agent: string; next_after: number }>();
  const next = new Map(results.map((r) => [r.agent, r.next_after]));
  const order = readyAgents.sort((a, b) => (next.get(a) ?? 0) - (next.get(b) ?? 0));

  const now = Date.now();
  for (const agent of order) {
    if (inFlight.some((r) => r.agent === agent)) continue;
    const streak = failStreak(runs, agent);
    if (streak >= FAIL_STREAK_PAUSE) {
      const last = finished(runs, agent)[0]?.id ?? 0;
      const seen = await getSetting<number>(env, `autopilot_paused_${agent}`).catch(() => null);
      if (seen !== last) {
        await setSetting(env, `autopilot_paused_${agent}`, last);
        await notify(env, `⚠️ <b>Autopilot paused ${esc(agent)}</b>: ${streak} runs failed in a row (latest #${last}). Check the log, fix it, then <code>/resume</code> or switch it on again in the admin.`);
      }
      continue;
    }
    // Win this agent's slot atomically so concurrent ticks can't launch it twice.
    await d.prepare("INSERT OR IGNORE INTO autopilot_state (agent, next_after) VALUES (?, 0)").bind(agent).run();
    const nextAfter = now + s.minGapMin * 60_000 * (1 + 0.6 * Math.random());
    const won = await d.prepare("UPDATE autopilot_state SET next_after = ?1 WHERE agent = ?2 AND next_after <= ?3").bind(Math.round(nextAfter), agent, now).run();
    if (won.meta.changes !== 1) continue;
    const run = await createRun(env, { agent, kind: "queue", count: Math.min(s.jobsPerRun, claimable) });
    return `launched run #${run.id} for ${agent}`;
  }
  return null;
}
