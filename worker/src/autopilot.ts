import { db, getSetting, setSetting } from "./db";
import { isAvailableFor, queue } from "./jobs";
import { DEFAULT_LANES, inLane, type Lane } from "./lanes";
import { taskSwitches, type TaskSwitches } from "./work";
import { checkJob, getPolicy, pacingState } from "./pacing";
import { createRun, listRunners, listRuns } from "./runs";
import { BROAD_SOURCE_PROMPT } from "./sourcing";
import { processFollowUps } from "./followups";
import { runFeeds } from "./feeds";
import { maybeLaunchPrep } from "./kits";
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
   * Per-agent auto-resume after a credit/quota rest; missing = on. On: the agent rests until the next reset
   * (next day for quota, next month for credit) and comes back by itself. Off: it is switched off instead and
   * stays off until someone turns it on.
   */
  autoResume?: Record<string, boolean>;
  /**
   * Backlog agents don't take fresh jobs while a front-line agent is available: they run only when jobs
   * were handed to them (failures, essays), or when no front-line agent can work. Default: Kimi.
   */
  backlog: string[];
  /** Agents limited to one kind of job (free-tier Gemini: email applications only). null = any job. */
  lanes: Record<string, Lane | null>;
  /** Capability labels per agent (cyber, blocker-bypass, applications, speed…); shown in the admin, editable via API. */
  tags: Record<string, string[]>;
  tasks: Record<string, Partial<TaskSwitches>>;
}

/** Seeded from matrix testing (2026-10): codex drafts cyber reports, kimi unblocks stuck applications, ollama does volume applications for free. */
const DEFAULT_TAGS: Record<string, string[]> = {
  ollama: ["applications", "essays", "free"],
  gemini: ["email", "speed", "free"],
  kimi: ["blocker-bypass", "handoffs"],
  codex: ["cyber", "reports"],
  claude: ["cyber", "applications"],
  mistral: ["email-first"],
  deepseek: ["unproven"],
  qwen: ["unproven"],
};

const DEFAULTS: AutopilotSettings = { enabled: true, maxConcurrent: 2, jobsPerRun: 3, minGapMin: 25, agents: {}, backlog: ["kimi"], lanes: DEFAULT_LANES, tags: DEFAULT_TAGS, tasks: {} };
const FAIL_STREAK_PAUSE = 3;
/** Exit code recorded on a run that stopped because the agent's quota or rate limit ran out (see runs.ts). */
export const QUOTA_EXIT = 429;

/**
 * 30-day outcome analysis (2026-10-21, n=171 Ashby+Greenhouse attempts): submissions during US
 * business hours convert at 9.8% vs 30.4% off-hours — ATS anti-fraud is strictest when real
 * candidate traffic peaks, and an evening application also just looks like a person applying
 * after work. So application/email runs only launch outside 9:00–17:00 America/Los_Angeles.
 * Sourcing, cyber and follow-ups are unaffected (they touch no ATS forms).
 */
export function businessHoursPT(now = Date.now()): boolean {
  const h = Number(new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }));
  return h >= 9 && h < 17;
}

export async function getAutopilot(env: Env): Promise<AutopilotSettings> {
  const saved = await getSetting<Partial<AutopilotSettings>>(env, "autopilot").catch(() => null);
  return { ...DEFAULTS, ...(saved ?? {}), tasks: { ...(saved?.tasks ?? {}) }, agents: { ...(saved?.agents ?? {}) }, autoResume: { ...(saved?.autoResume ?? {}) }, backlog: saved?.backlog ?? DEFAULTS.backlog, lanes: { ...DEFAULT_LANES, ...(saved?.lanes ?? {}) }, tags: { ...DEFAULT_TAGS, ...(saved?.tags ?? {}) } };
}

export async function saveAutopilot(env: Env, patch: Partial<AutopilotSettings>): Promise<AutopilotSettings> {
  const cur = await getAutopilot(env);
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const tags = (t: unknown) =>
    Object.fromEntries(
      Object.entries(t && typeof t === "object" ? (t as Record<string, unknown>) : {})
        .map(([k, v]) => [k.toLowerCase(), (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase().slice(0, 24)).slice(0, 8)] as const)
        .filter(([, v]) => v.length),
    );
  const next: AutopilotSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    maxConcurrent: num(patch.maxConcurrent, 1, 6, cur.maxConcurrent),
    jobsPerRun: num(patch.jobsPerRun, 1, 10, cur.jobsPerRun),
    minGapMin: num(patch.minGapMin, 5, 720, cur.minGapMin),
    agents: { ...cur.agents, ...(patch.agents ?? {}) },
    autoResume: { ...(cur.autoResume ?? {}), ...(patch.autoResume ?? {}) },
    backlog: Array.isArray(patch.backlog) ? patch.backlog.map((a) => String(a).toLowerCase()).slice(0, 10) : cur.backlog,
    lanes: { ...cur.lanes, ...(patch.lanes ?? {}) },
    tags: patch.tags ? { ...cur.tags, ...tags(patch.tags) } : cur.tags,
    tasks: { ...cur.tasks },
  };
  for (const [agent, values] of Object.entries(patch.tasks ?? {})) {
    next.tasks[agent] = { ...cur.tasks[agent] };
    for (const key of ["applications", "email", "sourcing", "cyber"] as const) if (typeof values[key] === "boolean") next.tasks[agent][key] = values[key];
  }
  await setSetting(env, "autopilot", next);
  // A switch change also removes work that was queued before the switch changed.
  await listRuns(env,1);
  for (const agent of new Set([...Object.keys(patch.agents ?? {}),...Object.keys(patch.tasks ?? {})])) {
    const tasks = taskSwitches(next,agent);
    await (await db(env)).prepare(`UPDATE runs SET status='cancelled',cancel=1,finished_at=?1,
      log=log||'\n[hub] queued task cancelled after task switches changed.\n'
      WHERE agent=?2 AND status='queued' AND (?3=1 OR task IN (SELECT value FROM json_each(?4))
        OR (kind='queue' AND task IS NULL AND ?5=1))`).bind(Date.now(),agent,next.agents[agent]===false?1:0,
      JSON.stringify(Object.entries(tasks).filter(([,on])=>!on).map(([task])=>task)),!tasks.applications&&!tasks.email?1:0).run();
  }
  return next;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS autopilot_state (agent TEXT PRIMARY KEY, next_after INTEGER NOT NULL DEFAULT 0)`;
let ready = false;
async function adb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.prepare(SCHEMA).run();
    await d.prepare("ALTER TABLE autopilot_state ADD COLUMN reason TEXT").run().catch(() => {}); // why an agent is resting
    ready = true;
  }
  return d;
}

export interface AgentAutopilot {
  agent: string;
  state: "working" | "queued" | "waiting" | "ready" | "idle" | "offline" | "paused" | "off" | "not-ready";
  signedIn: boolean | null;
  online: boolean;
  tasks: TaskSwitches;
  nextAt: string | null;
  detail: string | null;
  /** "backlog" agents (Kimi) work handed-over jobs; front-line agents take fresh ones. */
  role: "front-line" | "backlog";
  /** Capability labels (cyber, blocker-bypass, applications, speed…) from settings.tags. */
  tags: string[];
}

/** Most recent finished agent runs (queue/prompt kinds), newest first. */
const finished = (runs: Awaited<ReturnType<typeof listRuns>>, agent: string) =>
  runs.filter((r) => r.agent === agent && r.task !== "diagnostic" && r.kind !== "login" && ["succeeded", "failed", "cancelled"].includes(r.status));

export function applicationLane(s: AutopilotSettings, agent: string): Lane | null {
  const tasks = taskSwitches(s, agent);
  return !tasks.applications && !tasks.email ? "none" : !tasks.applications ? "email" : !tasks.email ? "web" : s.lanes[agent] ?? null;
}

function failStreak(runs: Awaited<ReturnType<typeof listRuns>>, agent: string, task: string = "applications"): number {
  let n = 0;
  for (const r of finished(runs, agent).filter(r=>r.task===task)) {
    if (r.exitCode === QUOTA_EXIT) continue; // out of quota is a rest, not a failure
    if (r.status === "failed") n++;
    else if (r.status === "succeeded") break;
  }
  return n;
}

/** Recent success rate (succeeded / finished, quota rests and cancels excluded); null until 3+ samples. */
function successRate(runs: Awaited<ReturnType<typeof listRuns>>, agent: string): number | null {
  let ok = 0,
    fail = 0;
  for (const r of finished(runs, agent)) {
    if (r.exitCode === QUOTA_EXIT) continue;
    if (r.status === "succeeded") ok++;
    else if (r.status === "failed") fail++;
  }
  return ok + fail >= 3 ? ok / (ok + fail) : null;
}

export async function autopilotStatus(env: Env) {
  const [s, runners, runs, d, jobs, policy] = await Promise.all([getAutopilot(env), listRunners(env), listRuns(env, 80), adb(env), queue(env), getPolicy(env)]);
  const pace = await pacingState(env, jobs, policy);
  const { results } = await d.prepare("SELECT agent, next_after, reason FROM autopilot_state").all<{ agent: string; next_after: number; reason: string | null }>();
  const next = new Map(results.map((r) => [r.agent, r.next_after]));
  const readySet = new Set(runners.filter((r) => r.online).flatMap((r) => r.agents.filter((a) => a.ready).map((a) => a.id)));
  const known = new Set([...readySet, ...runners.flatMap((r) => r.agents.map((a) => a.id))]);
  const agents: AgentAutopilot[] = [...known].sort().map((agent): AgentAutopilot => {
    const role: AgentAutopilot["role"] = s.backlog.includes(agent) ? "backlog" : "front-line";
    const lane = applicationLane(s, agent);
    const tags = s.tags[agent] ?? [];
    const probes = runners.flatMap((r) => r.agents.filter((a) => a.id === agent));
    const online = runners.some((r) => r.online && r.agents.some((a) => a.id === agent));
    const signedIn = agent === "ollama" ? null : probes.some((a) => a.signedIn ?? a.ready);
    const tasks = taskSwitches(s, agent);
    const base = { agent, role, tags, online, signedIn, tasks };
    const active = runs.find((r) => r.agent === agent && r.kind !== "login" && (r.status === "running" || r.status === "queued"));
    const streak = failStreak(runs, agent, taskSwitches(s,agent).applications?"applications":"email");
    const n = next.get(agent) ?? 0;
    if (s.agents[agent] === false) return { ...base, state: "off", nextAt: null, detail: active ? `Off; run #${active.id} is finishing` : "switched off" };
    if (!online) return { ...base, state: "offline", nextAt: null, detail: "No online runner" };
    if (!readySet.has(agent)) return { ...base, state: "not-ready", nextAt: null, detail: probes.find((a) => a.note)?.note ?? "Agent cannot execute work" };
    if (active) return { ...base, state: active.status === "running" ? "working" : "queued", nextAt: null, detail: `${active.task} · run #${active.id}` };
    if (streak >= FAIL_STREAK_PAUSE) return { ...base, state: "paused", nextAt: null, detail: `${streak} failed ${tasks.applications?"application":"email"} runs in a row` };
    if (n > Date.now()) {
      const why = results.find((r) => r.agent === agent)?.reason;
      const resumeAt = new Date(n).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      return { ...base, state: "waiting", nextAt: new Date(n).toISOString(), detail: why ? `Paused: ${why}. Resumes ${resumeAt}${s.autoResume?.[agent] === false ? "" : " automatically"}` : "Resting between runs or waiting for quota" };
    }
    if (!s.enabled) return { ...base, state: "idle", nextAt: null, detail: "Autopilot disabled" };
    const eligible = jobs.filter((j) => isAvailableFor(j, agent) && inLane(j, lane));
    const claimable = eligible.filter((j) => checkJob(j, pace, policy).ok);
    if (!eligible.length) return { ...base, state: "idle", nextAt: null, detail: tasks.applications || tasks.email ? `No eligible ${lane==="email"?"email":"application"} work${tasks.sourcing ? "; sourcing fallback enabled" : ""}` : "No task queued for enabled work types" };
    if (!claimable.length) return { ...base, state: "waiting", nextAt: null, detail: "Application pacing limit" };
    if (!runners.some((r) => r.online && r.busy < r.slots && r.agents.some((a) => a.id === agent && a.ready))) return { ...base, state: "waiting", nextAt: null, detail: "Runner capacity is full" };
    if (businessHoursPT()) return { ...base, state: "waiting", nextAt: null, detail: "Off-hours window: submissions resume at 17:00 PT (business-hour applications convert ~3× worse)" };
    return { ...base, state: "ready", nextAt: null, detail: `${claimable.length} eligible jobs for enabled tasks` };
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
  // Quiet email applications get one follow-up (self-gated to a few times a day; never blocks the tick).
  await processFollowUps(env).catch(() => null);
  // Public job feeds refill the queue twice a day with no tokens spent (self-gated).
  await runFeeds(env).catch(() => null);
  const freeSlots = online.reduce((n, r) => n + Math.max(0, r.slots - r.busy), 0);
  const inFlight = runs.filter((r) => r.kind !== "login" && (r.status === "running" || r.status === "queued"));
  const readyAgents = [...new Set(online.flatMap((r) => r.agents.filter((a) => a.ready).map((a) => a.id)))].filter((a) => s.agents[a] !== false);

  // Parked jobs without a copy/paste kit get one prepared (read-only run, never submits): one at a time, every
  // 20 min. Checked before the concurrency gate so background cyber runs can't starve it; it still needs a free slot.
  if (freeSlots > inFlight.filter((r) => r.status === "queued").length && !inFlight.some((r) => r.task === "prep")) {
    const prepped = await maybeLaunchPrep(env, { settings: s, readyAgents, busyAgents: new Set(inFlight.map((r) => r.agent)), prepInFlight: false }).catch(() => null);
    if (prepped) return prepped;
  }
  if (inFlight.length >= s.maxConcurrent || freeSlots <= inFlight.filter((r) => r.status === "queued").length) return null;

  // What could this agent claim right now (not parked, not paced, under the daily cap, not handed to someone else)?
  const pace = await pacingState(env, jobs, policy);
  const claimableFor = (agent: string) =>
    jobs.filter((j) => isAvailableFor(j, agent) && inLane(j, applicationLane(s, agent)) && checkJob(j, pace, policy, Date.now(), j.assignedTo === agent).ok).length;

  const d = await adb(env);

  // Demand-driven sourcing: when the fleet is truly idle (no ready jobs AND no application run in flight),
  // source fresh roles instead of waiting for the daily schedule. Guarded so it can never spin: one run at a
  // time, gated by a cooldown that backs off as sourcing runs fail (45 min → 2 h → 6 h → 24 h), and only on
  // agents that can actually browse and source (never the free email-only tier, never Ollama). The gate is
  // written before the run is created, so a run that dies in seconds cannot re-trigger on the next tick.
  const readyJobs = jobs.filter((j) => !j.claimedBy && !j.needsHuman && (j.applyUrl || j.applyEmail));
  const applying = inFlight.some((r) => r.task !== "sourcing");
  if (readyJobs.length === 0 && !applying && !inFlight.some((r) => r.task === "sourcing")) {
    const tNow = Date.now();
    const gate = (await d.prepare("SELECT next_after FROM autopilot_state WHERE agent = '__sourcing__'").first<{ next_after: number }>())?.next_after ?? 0;
    if (gate <= tNow) {
      let streak = 0;
      for (const r of runs) {
        if (r.task !== "sourcing" || (r.status !== "failed" && r.status !== "succeeded")) continue;
        if (r.status === "failed") streak++; else break;
      }
      const backoff = streak >= 3 ? 24 * 3_600_000 : streak === 2 ? 6 * 3_600_000 : streak === 1 ? 2 * 3_600_000 : 45 * 60_000;
      const SOURCERS = ["claude", "codex", "kimi", "claude2", "claude3", "kimi2"];
      const canSource = (a: string) => readyAgents.includes(a) && taskSwitches(s, a).sourcing && !inFlight.some((r) => r.agent === a) && failStreak(runs, a, "applications") < FAIL_STREAK_PAUSE;
      // Prefer an agent whose last sourcing run did not fail, so a dead key or empty credit rotates to the next one.
      const sourcer = SOURCERS.find((a) => canSource(a) && runs.find((r) => r.agent === a && r.task === "sourcing")?.status !== "failed") ?? SOURCERS.find(canSource);
      if (sourcer) {
        await d.prepare("INSERT OR IGNORE INTO autopilot_state (agent, next_after) VALUES ('__sourcing__', 0)").run();
        await d.prepare("UPDATE autopilot_state SET next_after = ?1 WHERE agent = '__sourcing__'").bind(tNow + backoff).run();
        if (streak === 2) await notify(env, `⚠️ <b>Sourcing backing off</b>: the last two sourcing runs failed (quota, credit or login — see the run logs). Retrying every 6 h, then every 24 h after a third failure.`);
        const run = await createRun(env, { agent: sourcer, kind: "prompt", task: "sourcing", prompt: BROAD_SOURCE_PROMPT });
        return `queue empty: launched sourcing run #${run.id} for ${sourcer} (next allowed in ${Math.round(backoff / 60_000)} min)`;
      }
    }
  }
  const { results } = await d.prepare("SELECT agent, next_after, reason FROM autopilot_state").all<{ agent: string; next_after: number; reason: string | null }>();
  const next = new Map(results.map((r) => [r.agent, r.next_after]));
  const order = readyAgents.sort((a, b) => (next.get(a) ?? 0) - (next.get(b) ?? 0));

  const now = Date.now();
  // Off-hours gate: no submission runs 9:00–17:00 PT (see businessHoursPT). Sourcing above already ran.
  if (businessHoursPT(now)) return null;
  const assignedTo = new Set(jobs.filter((j) => j.assignedTo && isAvailableFor(j, j.assignedTo)).map((j) => j.assignedTo as string));
  // Handed-off jobs go first. Among backlog agents, recent success rate sets priority (unproven
  // agents rank neutral). An agent already flying a run — e.g. a dispatched bug-bounty job — is
  // skipped below, so cyber work never competes with applications for that agent.
  const rate = new Map(order.map((a) => [a, successRate(runs, a)]));
  order.sort((a, b) => {
    const urgent = Number(assignedTo.has(b)) - Number(assignedTo.has(a));
    if (urgent !== 0) return urgent;
    if (s.backlog.includes(a) && s.backlog.includes(b)) return (rate.get(b) ?? 0.5) - (rate.get(a) ?? 0.5);
    return 0;
  });
  const frontLineAvailable = order.some((a) => !s.backlog.includes(a) && !inFlight.some((r) => r.agent === a) && failStreak(runs,a,taskSwitches(s,a).applications?"applications":"email") < FAIL_STREAK_PAUSE && (next.get(a) ?? 0) <= now && claimableFor(a) > 0);
  for (const agent of order) {
    if (inFlight.some((r) => r.agent === agent)) continue;
    const claimable = claimableFor(agent);
    if (claimable === 0) continue;
    // Backlog agents (Kimi) only start when jobs were handed to them, or when no front-line agent can work.
    if (s.backlog.includes(agent) && !assignedTo.has(agent) && frontLineAvailable) continue;
    const streak = failStreak(runs, agent, taskSwitches(s,agent).applications?"applications":"email");
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
    const won = await d.prepare("UPDATE autopilot_state SET next_after = ?1, reason = NULL WHERE agent = ?2 AND (next_after <= ?3 OR ?4 = 1)").bind(Math.round(nextAfter), agent, now, urgent).run();
    if (won.meta.changes !== 1) continue;
    // A lane agent (free tier) gets a short run: its daily request budget is tiny.
    const run = await createRun(env, { agent, kind: "queue", task: applicationLane(s,agent) === "email" ? "email" : "applications", exclusive: true, count: Math.min(agent === "ollama" ? 1 : applicationLane(s,agent) === "email" ? 2 : s.jobsPerRun, claimable) });
    return `launched run #${run.id} for ${agent}`;
  }
  return null;
}
