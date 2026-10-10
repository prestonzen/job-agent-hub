import { db } from "./db";
import { parkedCategory } from "./park";
import { queue } from "./jobs";
import { mdb } from "./mirror";
import { listRunners } from "./runs";
import type { Env } from "./types";

/**
 * Admin analytics: how the agent army is actually performing. Everything is computed from D1
 * (events, runs, ClickUp call counters) plus the live queue, over a rolling window.
 * Nothing here is public: it carries company-level detail and operational numbers.
 */

export interface AgentStats {
  agent: string;
  claimed: number;
  applied: number;
  skipped: number;
  needsHuman: number;
  failed: number;
  released: number;
  /** applied / (applied + skipped + needs_human + failed); null when the agent finished nothing. */
  successRate: number | null;
  /** Median minutes from claim to a reported "applied". */
  medianMinToApply: number | null;
  runs: number;
  runsOk: number;
  runsFailed: number;
  avgRunMin: number | null;
  /** Total minutes the agent's CLI spent running. */
  runMinutes: number;
}

export interface AtsStats {
  ats: string;
  applied: number;
  needsHuman: number;
  skipped: number;
  failed: number;
  successRate: number | null;
}

export interface DayStats {
  date: string;
  applied: number;
  needsHuman: number;
  skipped: number;
  failed: number;
  runsOk: number;
  runsFailed: number;
}

export interface Analytics {
  generatedAt: string;
  days: number;
  demo: boolean;
  totals: {
    applied: number;
    claimed: number;
    skipped: number;
    needsHuman: number;
    failed: number;
    successRate: number | null;
    medianMinToApply: number | null;
    runs: number;
    runsOk: number;
    runMinutes: number;
    /** Applications per hour of agent run time. */
    appsPerRunHour: number | null;
  };
  byAgent: AgentStats[];
  byDay: DayStats[];
  /** Applied events per UTC hour of day (24 slots). */
  byHour: number[];
  byAts: AtsStats[];
  parked: { reason: string; count: number }[];
  queue: { ready: number; claimed: number; parked: number; total: number };
  clickup: { day: string; calls: number }[];
  fleet: { agentsReady: number; runnersOnline: number; slots: number; busy: number };
}

const DAY = 86_400_000;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const rate = (applied: number, other: number) => (applied + other ? applied / (applied + other) : null);

interface Ev {
  at: number;
  agent: string;
  task_id: string | null;
  type: string;
  ats: string | null;
}

export async function buildAnalytics(env: Env, days = 30): Promise<Analytics> {
  const d = await db(env);
  const since = Date.now() - days * DAY;

  const [{ results: evs }, { results: runs }, q, runners, usage] = await Promise.all([
    d
      .prepare("SELECT at, agent, task_id, type, ats FROM events WHERE at >= ? AND type IN ('claimed','applied','skipped','needs_human','failed','released') ORDER BY at")
      .bind(since)
      .all<Ev>(),
    d
      .prepare("SELECT agent, status, created_at, started_at, finished_at FROM runs WHERE created_at >= ? AND kind != 'login'")
      .bind(since)
      .all<{ agent: string; status: string; created_at: number; started_at: number | null; finished_at: number | null }>()
      .catch(() => ({ results: [] as { agent: string; status: string; created_at: number; started_at: number | null; finished_at: number | null }[] })),
    queue(env).catch(() => []),
    listRunners(env).catch(() => []),
    (await mdb(env))
      .prepare("SELECT day, calls FROM api_usage WHERE api = 'clickup' AND day >= ? ORDER BY day")
      .bind(new Date(since).toISOString().slice(0, 10))
      .all<{ day: string; calls: number }>()
      .catch(() => ({ results: [] as { day: string; calls: number }[] })),
  ]);

  const agents = new Map<string, AgentStats & { _toApply: number[] }>();
  const A = (name: string) => {
    const k = (name || "unknown").toLowerCase();
    let a = agents.get(k);
    if (!a) {
      a = { agent: k, claimed: 0, applied: 0, skipped: 0, needsHuman: 0, failed: 0, released: 0, successRate: null, medianMinToApply: null, runs: 0, runsOk: 0, runsFailed: 0, avgRunMin: null, runMinutes: 0, _toApply: [] };
      agents.set(k, a);
    }
    return a;
  };
  const byDay = new Map<string, DayStats>();
  const D = (ms: number) => {
    const date = new Date(ms).toISOString().slice(0, 10);
    let x = byDay.get(date);
    if (!x) {
      x = { date, applied: 0, needsHuman: 0, skipped: 0, failed: 0, runsOk: 0, runsFailed: 0 };
      byDay.set(date, x);
    }
    return x;
  };
  const byAts = new Map<string, AtsStats>();
  const S = (ats: string | null) => {
    const k = ats || "unknown";
    let x = byAts.get(k);
    if (!x) {
      x = { ats: k, applied: 0, needsHuman: 0, skipped: 0, failed: 0, successRate: null };
      byAts.set(k, x);
    }
    return x;
  };
  const byHour = new Array<number>(24).fill(0);
  const openClaim = new Map<string, number>(); // task_id -> claimed_at (by the same agent)

  for (const e of evs) {
    const a = A(e.agent);
    const day = D(e.at);
    switch (e.type) {
      case "claimed":
        a.claimed++;
        if (e.task_id) openClaim.set(`${e.agent}:${e.task_id}`, e.at);
        break;
      case "applied": {
        a.applied++;
        day.applied++;
        S(e.ats).applied++;
        byHour[new Date(e.at).getUTCHours()]++;
        const c = e.task_id ? openClaim.get(`${e.agent}:${e.task_id}`) : undefined;
        if (c !== undefined && e.at - c < 6 * 3_600_000) a._toApply.push((e.at - c) / 60_000);
        break;
      }
      case "skipped":
        a.skipped++;
        day.skipped++;
        S(e.ats).skipped++;
        break;
      case "needs_human":
        a.needsHuman++;
        day.needsHuman++;
        S(e.ats).needsHuman++;
        break;
      case "failed":
        a.failed++;
        day.failed++;
        S(e.ats).failed++;
        break;
      case "released":
        a.released++;
        break;
    }
  }

  for (const r of runs) {
    const a = A(r.agent);
    a.runs++;
    const day = D(r.created_at);
    if (r.status === "succeeded") (a.runsOk++, day.runsOk++);
    else if (r.status === "failed") (a.runsFailed++, day.runsFailed++);
    if (r.started_at && r.finished_at && r.finished_at > r.started_at && (r.status === "succeeded" || r.status === "failed")) {
      a.runMinutes += (r.finished_at - r.started_at) / 60_000;
    }
  }

  const byAgent: AgentStats[] = [...agents.values()]
    .map(({ _toApply, ...a }) => ({
      ...a,
      successRate: rate(a.applied, a.skipped + a.needsHuman + a.failed),
      medianMinToApply: round1(median(_toApply)),
      avgRunMin: a.runsOk + a.runsFailed ? round1(a.runMinutes / (a.runsOk + a.runsFailed)) : null,
      runMinutes: Math.round(a.runMinutes),
    }))
    .filter((a) => a.agent !== "unknown" || a.claimed + a.applied > 0)
    .sort((a, b) => b.applied - a.applied || b.claimed - a.claimed || a.agent.localeCompare(b.agent));

  const sum = (f: (a: AgentStats) => number) => byAgent.reduce((s, a) => s + f(a), 0);
  const applied = sum((a) => a.applied);
  const skipped = sum((a) => a.skipped);
  const needsHuman = sum((a) => a.needsHuman);
  const failed = sum((a) => a.failed);
  const runMinutes = sum((a) => a.runMinutes);
  const allToApply = [...agents.values()].flatMap((a) => a._toApply);

  const ats = [...byAts.values()]
    .map((x) => ({ ...x, successRate: rate(x.applied, x.skipped + x.needsHuman + x.failed) }))
    .sort((a, b) => b.applied + b.needsHuman + b.failed + b.skipped - (a.applied + a.needsHuman + a.failed + a.skipped));

  // Zero-fill the window so charts have no holes.
  const dayList: DayStats[] = [];
  for (let t = since; t <= Date.now(); t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    dayList.push(byDay.get(date) ?? { date, applied: 0, needsHuman: 0, skipped: 0, failed: 0, runsOk: 0, runsFailed: 0 });
  }

  const parkedMap = new Map<string, number>();
  for (const j of q) if (j.needsHuman) parkedMap.set(parkedCategory(j.needsHuman), (parkedMap.get(parkedCategory(j.needsHuman)) ?? 0) + 1);
  const ready = q.filter((j) => !j.claimedBy && !j.needsHuman && j.applyUrl).length;

  const online = runners.filter((r) => r.online);
  return {
    generatedAt: new Date().toISOString(),
    days,
    demo: env.MOCK === "true",
    totals: {
      applied,
      claimed: sum((a) => a.claimed),
      skipped,
      needsHuman,
      failed,
      successRate: rate(applied, skipped + needsHuman + failed),
      medianMinToApply: round1(median(allToApply)),
      runs: sum((a) => a.runs),
      runsOk: sum((a) => a.runsOk),
      runMinutes,
      appsPerRunHour: runMinutes > 0 ? round1((applied / runMinutes) * 60) : null,
    },
    byAgent,
    byDay: dayList,
    byHour,
    byAts: ats,
    parked: [...parkedMap.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    queue: { ready, claimed: q.filter((j) => j.claimedBy).length, parked: q.filter((j) => j.needsHuman).length, total: q.length },
    clickup: usage.results,
    fleet: {
      agentsReady: new Set(online.flatMap((r) => r.agents.filter((a) => a.ready).map((a) => a.id))).size,
      runnersOnline: online.length,
      slots: online.reduce((s, r) => s + r.slots, 0),
      busy: online.reduce((s, r) => s + r.busy, 0),
    },
  };
}
