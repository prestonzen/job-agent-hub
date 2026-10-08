import { db, getSetting } from "./db";
import type { Env, Job } from "./types";

/**
 * Pacing across ALL agents, enforced where every claim is handed out (claimJobs). Applying from one
 * identity too fast, or to the same company twice at once, is exactly what ATS anti-fraud checks
 * flag (Ashby), and Greenhouse's emailed codes collide when two sessions run at once.
 *
 * Per ATS:   concurrent claims · minimum gap between claims · max per rolling 24 h
 * Per company: at most N in flight, optional cooldown after applying
 * Global:    max applications per rolling 24 h
 */

export interface AtsLimit {
  concurrent: number;
  minGapMin: number;
  perDay: number;
}

export interface PacingPolicy {
  ats: Record<string, AtsLimit>;
  companyConcurrent: number;
  companyCooldownDays: number;
  globalPerDay: number;
}

export const DEFAULT_POLICY: PacingPolicy = {
  ats: {
    greenhouse: { concurrent: 1, minGapMin: 4, perDay: 15 },
    ashby: { concurrent: 2, minGapMin: 6, perDay: 20 },
    lever: { concurrent: 2, minGapMin: 3, perDay: 25 },
    workable: { concurrent: 1, minGapMin: 5, perDay: 15 },
    workday: { concurrent: 1, minGapMin: 10, perDay: 8 },
    default: { concurrent: 2, minGapMin: 3, perDay: 20 },
  },
  companyConcurrent: 1,
  companyCooldownDays: 0,
  globalPerDay: 60,
};

/** "Greenhouse (job-boards)" → "greenhouse". */
export const atsKey = (ats: string | null | undefined) =>
  (ats ?? "").trim().toLowerCase().split(/[\s(/,]/)[0] || "other";

export const companyKey = (c: string | null | undefined) =>
  (c ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export async function getPolicy(env: Env): Promise<PacingPolicy> {
  const saved = await getSetting<Partial<PacingPolicy>>(env, "pacing").catch(() => null);
  return {
    ...DEFAULT_POLICY,
    ...(saved ?? {}),
    ats: { ...DEFAULT_POLICY.ats, ...(saved?.ats ?? {}) },
  };
}

const limitFor = (p: PacingPolicy, ats: string) => p.ats[ats] ?? p.ats.default ?? DEFAULT_POLICY.ats.default;

export interface PacingState {
  ats: Record<string, { active: number; lastClaimAt: number | null; today: number }>;
  company: Record<string, { active: number; lastAppliedAt: number | null }>;
  todayTotal: number;
}

/** Current load from live claims (the queue) plus the last 24 h of claims/applications (events). */
export async function pacingState(env: Env, jobs: Job[], policy: PacingPolicy): Promise<PacingState> {
  const now = Date.now();
  const st: PacingState = { ats: {}, company: {}, todayTotal: 0 };
  const a = (k: string) => (st.ats[k] ??= { active: 0, lastClaimAt: null, today: 0 });
  const c = (k: string) => (st.company[k] ??= { active: 0, lastAppliedAt: null });

  for (const j of jobs) {
    if (!j.claimedBy) continue;
    a(atsKey(j.ats)).active++;
    c(companyKey(j.company)).active++;
  }

  const since = now - Math.max(1, policy.companyCooldownDays) * 86_400_000;
  const { results } = await (await db(env))
    .prepare("SELECT type, ats, company, at FROM events WHERE at > ? AND type IN ('claimed', 'applied')")
    .bind(Math.min(since, now - 86_400_000))
    .all<{ type: string; ats: string | null; company: string | null; at: number }>();
  for (const e of results) {
    const recent = e.at > now - 86_400_000;
    if (e.type === "claimed" && e.ats) {
      const s = a(e.ats);
      s.lastClaimAt = Math.max(s.lastClaimAt ?? 0, e.at);
    }
    if (e.type === "applied") {
      if (recent) {
        st.todayTotal++;
        if (e.ats) a(e.ats).today++;
      }
      if (e.company) {
        const s = c(e.company);
        s.lastAppliedAt = Math.max(s.lastAppliedAt ?? 0, e.at);
      }
    }
  }
  return st;
}

export type PaceVerdict = { ok: true } | { ok: false; reason: string; retryAt: number | null };

export function checkJob(job: Job, st: PacingState, p: PacingPolicy, now = Date.now()): PaceVerdict {
  const ak = atsKey(job.ats);
  const lim = limitFor(p, ak);
  const s = st.ats[ak] ?? { active: 0, lastClaimAt: null, today: 0 };
  const cs = st.company[companyKey(job.company)] ?? { active: 0, lastAppliedAt: null };

  if (st.todayTotal >= p.globalPerDay) return { ok: false, reason: `daily limit of ${p.globalPerDay} applications reached`, retryAt: null };
  if (cs.active >= p.companyConcurrent) return { ok: false, reason: `another application to ${job.company} is in progress`, retryAt: null };
  if (p.companyCooldownDays > 0 && cs.lastAppliedAt && now - cs.lastAppliedAt < p.companyCooldownDays * 86_400_000) {
    return { ok: false, reason: `applied to ${job.company} recently (cooldown ${p.companyCooldownDays} d)`, retryAt: cs.lastAppliedAt + p.companyCooldownDays * 86_400_000 };
  }
  if (s.active >= lim.concurrent) return { ok: false, reason: `${ak}: ${s.active}/${lim.concurrent} in progress`, retryAt: null };
  if (s.today + s.active >= lim.perDay) return { ok: false, reason: `${ak}: daily limit ${lim.perDay} reached`, retryAt: null };
  if (s.lastClaimAt && now - s.lastClaimAt < lim.minGapMin * 60_000) {
    const retryAt = s.lastClaimAt + lim.minGapMin * 60_000;
    return { ok: false, reason: `${ak}: next slot in ${Math.ceil((retryAt - now) / 60_000)} min`, retryAt };
  }
  return { ok: true };
}

/** Account for a claim just made, so one claim_jobs batch respects the limits too. */
export function noteClaim(job: Job, st: PacingState, now = Date.now()) {
  const ak = atsKey(job.ats);
  const s = (st.ats[ak] ??= { active: 0, lastClaimAt: null, today: 0 });
  s.active++;
  s.lastClaimAt = now;
  const c = (st.company[companyKey(job.company)] ??= { active: 0, lastAppliedAt: null });
  c.active++;
}

/** Live view for the admin: limit vs. load per ATS. */
export function pacingSummary(st: PacingState, p: PacingPolicy, now = Date.now()) {
  const keys = [...new Set([...Object.keys(p.ats).filter((k) => k !== "default"), ...Object.keys(st.ats)])];
  return {
    globalPerDay: p.globalPerDay,
    todayTotal: st.todayTotal,
    ats: keys.map((k) => {
      const lim = limitFor(p, k);
      const s = st.ats[k] ?? { active: 0, lastClaimAt: null, today: 0 };
      const next = s.lastClaimAt ? s.lastClaimAt + lim.minGapMin * 60_000 : null;
      return { ats: k, ...lim, active: s.active, today: s.today, nextSlotAt: next && next > now ? new Date(next).toISOString() : null };
    }),
  };
}
