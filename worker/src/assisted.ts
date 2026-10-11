import { db } from "./db";
import { queue } from "./jobs";
import { parkedCategory } from "./park";
import type { Attempt } from "./attempts";
import type { Env } from "./types";

/**
 * The assisted queue: jobs the agents couldn't finish on their own (failed on more than one agent, a code or
 * CAPTCHA wall, an account to sign in to). They are worked in a real, signed-in Chrome with Preston nearby (Claude in
 * Chrome via the admin API), where a person can solve a challenge or read a code, and pushed to completion.
 * Jobs that can't be fixed by effort (eligibility, travel, already done) are counted but not listed.
 */

const NOT_WORKABLE = new Set(["Location, travel or eligibility", "Duplicate", "Already worked (status not updated)"]);

export interface AssistedJob {
  id: string;
  name: string;
  company: string;
  role: string;
  applyUrl: string | null;
  applyEmail: string | null;
  ats: string | null;
  fit: number | null;
  pay: string | null;
  clickupUrl: string;
  category: string;
  reason: string;
  attempts: Attempt[];
}

async function attemptsFor(env: Env, ids: string[]): Promise<Map<string, Attempt[]>> {
  const out = new Map<string, Attempt[]>();
  if (!ids.length) return out;
  const d = await db(env);
  const { results } = await d
    .prepare(`SELECT task_id, agent, outcome, note, log, at FROM attempts WHERE task_id IN (${ids.map(() => "?").join(",")}) ORDER BY at`)
    .bind(...ids)
    .all<{ task_id: string; agent: string; outcome: string; note: string | null; log: string | null; at: number }>()
    .catch(() => ({ results: [] as { task_id: string; agent: string; outcome: string; note: string | null; log: string | null; at: number }[] }));
  for (const r of results) {
    const list = out.get(r.task_id) ?? [];
    list.push({ agent: r.agent, at: new Date(r.at).toISOString(), outcome: r.outcome, note: r.note, log: r.log });
    out.set(r.task_id, list);
  }
  return out;
}

export async function assistedQueue(env: Env): Promise<{ jobs: AssistedJob[]; notWorkable: number }> {
  const parked = (await queue(env)).filter((j) => j.needsHuman && !j.claimedBy);
  const all = parked.map((j) => ({ j, category: parkedCategory(j.needsHuman ?? "") }));
  const workable = all.filter((x) => !NOT_WORKABLE.has(x.category));
  const attempts = await attemptsFor(env, workable.map((x) => x.j.id));
  const jobs = workable
    .map(({ j, category }): AssistedJob => ({
      id: j.id,
      name: j.name,
      company: j.company,
      role: j.role,
      applyUrl: j.applyUrl,
      applyEmail: j.applyEmail,
      ats: j.ats,
      fit: j.fit,
      pay: j.pay,
      clickupUrl: j.clickupUrl,
      category,
      reason: j.needsHuman ?? "",
      attempts: attempts.get(j.id) ?? [],
    }))
    // Jobs that already cost agents attempts first (they're the ones that keep failing), then best fit.
    .sort((a, b) => b.attempts.length - a.attempts.length || (b.fit ?? 0) - (a.fit ?? 0) || a.name.localeCompare(b.name));
  return { jobs, notWorkable: all.length - workable.length };
}
