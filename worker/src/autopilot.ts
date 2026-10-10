import { db, getSetting, setSetting } from "./db";
import { isAvailableFor, queue } from "./jobs";
import { DEFAULT_LANES, inLane, type Lane } from "./lanes";
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
  /**
   * Backlog agents don't take fresh jobs while a front-line agent is available: they run only when jobs
   * were handed to them (failures, essays), or when no front-line agent can work. Default: Kimi.
   */
  backlog: string[];
  /** Agents limited to one kind of job (free-tier Gemini: email applications only). null = any job. */
  lanes: Record<string, Lane | null>;
}

const DEFAULTS: AutopilotSettings = { enabled: true, maxConcurrent: 2, jobsPerRun: 3, minGapMin: 25, agents: {}, backlog: ["kimi"], lanes: DEFAULT_LANES };
const FAIL_STREAK_PAUSE = 3;
/** Exit code recorded on a run that stopped because the agent's quota or rate limit ran out (see runs.ts). */
export const QUOTA_EXIT = 429;

export async function getAutopilot(env: Env): Promise<AutopilotSettings> {
  const saved = await getSetting<Partial<AutopilotSettings>>(env, "autopilot").catch(() => null);
  return { ...DEFAULTS, ...(saved ?? {}), agents: { ...(saved?.agents ?? {}) }, backlog: saved?.backlog ?? DEFAULTS.backlog, lanes: { ...DEFAULT_LANES, ...(saved?.lanes ?? {}) } };
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
    backlog: Array.isArray(patch.backlog) ? patch.backlog.map((a) => String(a).toLowerCase()).slice(0, 10) : cur.backlog,
    lanes: { ...cur.lanes, ...(patch.lanes ?? {}) },
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
  /** "backlog" agents (Kimi) work handed-over jobs; front-line agents take fresh ones. */
  role: "front-line" | "backlog";
}

/** Most recent finished agent runs (queue/prompt kinds), newest first. */
const finished = (runs: Awaited<ReturnType<typeof listRuns>>, agent: string) =>
  runs.filter((r) => r.agent === agent && r.kind !== "login" && ["succeeded", "failed", "cancelled"].includes(r.status));

function failStreak(runs: Awaited<ReturnType<typeof listRuns>>, agent: string): number {
  let n = 0;
  for (const r of finished(runs, agent)) {
    if (r.exitCode === QUOTA_EXIT) continue; // out of quota is a rest, not a failure
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
  const agents: AgentAutopilot[] = [...known].sort().map((agent): AgentAutopilot => {
    const role = s.backlog.includes(agent) ? "backlog" : "front-line";
    const lane = s.lanes[agent] ?? null;
    const active = runs.find((r) => r.agent === agent && r.kind !== "login" && (r.status === "running" || r.status === "queued"));
    const streak = failStreak(runs, agent);
    const n = next.get(agent) ?? 0;
    if (s.agents[agent] === false) return { agent, role, state: "off", nextAt: null, detail: "switched off" };
    if (!readySet.has(agent)) return { agent, role, state: "not-ready", nextAt: null, detail: "not logged in on a runner" };
    if (streak >= FAIL_STREAK_PAUSE) return { agent, role, state: "paused", nextAt: null, detail: `${streak} failed runs in a row` };
    if (active) return { agent, role, state: active.status === "running" ? "working" : "queued", nextAt: null, detail: `run #${active.id}` };
    if (n > Date.now()) return { agent, role, state: "waiting", nextAt: new Date(n).toISOString(), detail: lane === "email" ? "email applications only" : lane === "email-first" ? "email applications first" : null };
    return { agent, role, state: "ready", nextAt: null, detail: lane === "email" ? "email applications only" : lane === "email-first" ? "email applications first" : null };
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

  // What could this agent claim right now (not parked, not paced, under the daily cap, not handed to someone else)?
  const pace = await pacingState(env, jobs, policy);
  const claimableFor = (agent: string) =>
    jobs.filter((j) => isAvailableFor(j, agent) && inLane(j, s.lanes[agent] ?? null) && checkJob(j, pace, policy, Date.now(), j.assignedTo === agent).ok).length;

  const d = await adb(env);
  const readyAgents = [...new Set(online.flatMap((r) => r.agents.filter((a) => a.ready).map((a) => a.id)))].filter((a) => s.agents[a] !== false);
  const { results } = await d.prepare("SELECT agent, next_after FROM autopilot_state").all<{ agent: string; next_after: number }>();
  const next = new Map(results.map((r) => [r.agent, r.next_after]));
  const order = readyAgents.sort((a, b) => (next.get(a) ?? 0) - (next.get(b) ?? 0));

  const now = Date.now();
  const assignedTo = new Set(jobs.filter((j) => j.assignedTo && isAvailableFor(j, j.assignedTo)).map((j) => j.assignedTo as string));
  order.sort((a, b) => Number(assignedTo.has(b)) - Number(assignedTo.has(a)));
  const frontLineAvailable = order.some((a) => !s.backlog.includes(a));
  for (const agent of order) {
    if (inFlight.some((r) => r.agent === agent)) continue;
    const claimable = claimableFor(agent);
    if (claimable === 0) continue;
    // Backlog agents (Kimi) only start when jobs were handed to them, or when no front-line agent can work.
    if (s.backlog.includes(agent) && !assignedTo.has(agent) && frontLineAvailable) continue;
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
    // A handed-off job (e.g. an essay another agent couldn't write) starts its assignee right away.
    const urgent = assignedTo.has(agent) ? 1 : 0;
    const won = await d.prepare("UPDATE autopilot_state SET next_after = ?1 WHERE agent = ?2 AND (next_after <= ?3 OR ?4 = 1)").bind(Math.round(nextAfter), agent, now, urgent).run();
    if (won.meta.changes !== 1) continue;
    // A lane agent (free tier) gets a short run: its daily request budget is tiny.
    const run = await createRun(env, { agent, kind: "queue", count: Math.min(s.lanes[agent] === "email" ? 2 : s.jobsPerRun, claimable) });
    return `launched run #${run.id} for ${agent}`;
  }
  return null;
}
