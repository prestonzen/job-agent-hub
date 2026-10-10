import {
  HttpError,
  addComment,
  clearField,
  createApplication,
  getPlaybook,
  getTask,
  listTasks,
  setField,
  setStatus,
  stampApplied,
} from "./clickup";
import { isApplication } from "./classify";
import { inferPlatform } from "./platform";
import { activeAssignments, assignJob, clearAssignment, getAssignment, FALLBACK_AGENT, type Assignment } from "./assign";
import { agentNames } from "./auth";
import { atsKey, checkJob, companyKey, getPolicy, noteClaim as notePacedClaim, pacingState } from "./pacing";
import { activeClaims, deleteClaim, getClaim, logEvent, tryClaim, type Claim } from "./db";
import { mockPlaybook, mockTasks } from "./mock";
import { esc, notify } from "./telegram";
import { isFresh, mirrorAge, mirrorTasks, patchMirror, replaceMirror, upsertMirror } from "./mirror";
import { getSetting, setSetting } from "./db";
import { splitName } from "./sanitize";
import type { Env, Job, Task } from "./types";

/**
 * The job queue and its rules. Both front doors (REST /api/agent/* and MCP /mcp) call these
 * functions, so every agent gets identical behaviour.
 *
 * Queue = application tasks in the list (see classify.ts) with status "not started".
 * A job is unavailable while it has an unexpired claim, either a hub claim (D1) or a ClickUp
 * "Next Action" note "Claimed by <agent> until <ISO time>" (so ClickUp-only agents can take part).
 */

const mock = (env: Env) => env.MOCK === "true";
const leaseMs = (env: Env) => Math.max(5, Number(env.LEASE_MINUTES) || 60) * 60_000;

export const OUTCOMES = ["applied", "needs_human", "skipped", "failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** "kimi" -> "Kimi" for comments and ClickUp dropdowns. */
export const displayAgent = (a: string) => (a.length ? a[0].toUpperCase() + a.slice(1) : a);

/**
 * The whole list, from the local copy (task_mirror) when it's under 10 minutes old; otherwise one
 * full read from ClickUp refreshes it. If ClickUp is down or rate-limited, the last copy is served.
 * One sync at a time: a sync started in the last 30 s means "serve the copy".
 */
export async function loadTasks(env: Env, opts: { force?: boolean } = {}): Promise<Task[]> {
  if (mock(env)) return mockTasks(env);
  const age = await mirrorAge(env);
  if (!opts.force && isFresh(age)) return mirrorTasks(env);
  const syncing = await getSetting<number>(env, "mirror_syncing").catch(() => null);
  if (!opts.force && syncing && Date.now() - syncing < 30_000 && age !== Infinity) return mirrorTasks(env);
  await setSetting(env, "mirror_syncing", Date.now()).catch(() => {});
  try {
    const tasks = await listTasks(env);
    await replaceMirror(env, tasks);
    return tasks;
  } catch (e) {
    const copy = await mirrorTasks(env);
    if (copy.length) return copy;
    throw e;
  } finally {
    await setSetting(env, "mirror_syncing", 0).catch(() => {});
  }
}

/** One task, fresh from ClickUp (correctness matters for claims and reports); updates the copy. */
async function loadTask(env: Env, id: string): Promise<Task> {
  if (mock(env)) {
    const t = mockTasks(env).find((x) => x.id === id);
    if (!t) throw new HttpError(404, `no task ${id}`);
    return t;
  }
  try {
    const t = await getTask(env, id);
    await upsertMirror(env, t);
    return t;
  } catch (e) {
    const copy = (await mirrorTasks(env)).find((t) => t.id === id);
    if (copy && e instanceof HttpError && e.status !== 404) return copy; // ClickUp unavailable
    throw e;
  }
}

/** New tasks were created: make the next read sync the list. */
const invalidateMirror = (env: Env) => (mock(env) ? Promise.resolve() : setSetting(env, "mirror_synced_at", 0));

/** Skip ClickUp writes in demo mode; everything else (D1 claims, events) still runs. */
async function write(env: Env, fn: () => Promise<unknown>): Promise<void> {
  if (!mock(env)) await fn();
}

export function playbook(env: Env): Promise<string> {
  return mock(env) ? Promise.resolve(mockPlaybook()) : getPlaybook(env);
}

// ---------- Parsing ----------

/** Parses the queue task description: "Apply: <url>\nPay: … | Travel: … | Fit: 5/5 (…) | ATS: Greenhouse". */
export function parseDetails(desc: string) {
  const grab = (key: string) => {
    const m = desc.match(new RegExp(`${key}:\\s*([^|\\n]+)`, "i"));
    return m ? m[1].trim() : null;
  };
  const applyUrl = desc.match(/Apply:\s*\[?(https?:\/\/[^\s\]\)]+)/i)?.[1] ?? desc.match(/https?:\/\/[^\s\]\)]+/)?.[0] ?? null;
  const fitRaw = grab("Fit");
  const fitNum = fitRaw?.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return {
    applyUrl,
    pay: grab("Pay"),
    travel: grab("Travel"),
    ats: grab("ATS"),
    fit: fitNum ? Number(fitNum[1]) : null,
    fitNote: fitRaw?.match(/\((.*)\)/)?.[1] ?? null,
  };
}

const CLAIM_NOTE = /^Claimed by\s+(\S+)\s+until\s+(\S+)/i;
const NEEDS_HUMAN = /^Needs human:?\s*(.*)$/i;
/** Markers other agents (the Chrome sessions) leave in names / Next Action for jobs a person must finish. */
const PARKED_NAME = /\b(NEEDS HUMAN|BLOCKED|PARKED)\b/;
const PARKED_NOTE = /^(NOT submitted|Retry manually|Blocked|Parked)\b/i;

function parkedReason(t: Task): string | null {
  const nh = t.nextAction?.match(NEEDS_HUMAN)?.[1];
  if (nh !== undefined) return nh || "needs a person";
  if (t.nextAction && PARKED_NOTE.test(t.nextAction)) return t.nextAction;
  if (PARKED_NAME.test(t.name)) return t.name.match(/\(([^)]*)\)\s*$/)?.[1] ?? "marked in the task name";
  // Someone already worked this job (Applied By set) without finishing the status: never hand it out again.
  if (t.appliedBy) return `already worked by ${t.appliedBy}; status not updated`;
  return null;
}

/** A ClickUp-side claim ("Claimed by codex until 2026-10-08T03:15:00Z"), if still live. */
function noteClaim(t: Task): { agent: string; expiresAt: number } | null {
  const m = t.nextAction?.match(CLAIM_NOTE);
  if (!m) return null;
  const exp = Date.parse(m[2]);
  return Number.isFinite(exp) && exp > Date.now() ? { agent: m[1].toLowerCase(), expiresAt: exp } : null;
}

const claimNote = (agent: string, expiresAt: number) =>
  `Claimed by ${agent} until ${new Date(expiresAt).toISOString().slice(0, 16)}Z (Job Agent Hub)`;

function toJob(t: Task, claim: Claim | undefined | null, assigned?: Assignment | null): Job {
  const { company, role } = splitName(t.name);
  const d = parseDetails(t.description);
  const note = noteClaim(t);
  const holder = claim ? { agent: claim.agent, expiresAt: claim.expiresAt } : note;
  return {
    id: t.id,
    name: t.name,
    company,
    role,
    status: t.status,
    applyUrl: d.applyUrl,
    ats: d.ats,
    pay: d.pay,
    travel: d.travel,
    fit: d.fit,
    fitNote: d.fitNote,
    priority: t.priority,
    clickupUrl: t.url,
    claimedBy: holder?.agent ?? null,
    claimExpiresAt: holder ? new Date(holder.expiresAt).toISOString() : null,
    needsHuman: parkedReason(t),
    assignedTo: assigned?.agent ?? null,
  };
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function byBestFirst(a: Job, b: Job): number {
  return (
    (b.fit ?? 0) - (a.fit ?? 0) ||
    (PRIORITY_RANK[a.priority ?? ""] ?? 4) - (PRIORITY_RANK[b.priority ?? ""] ?? 4) ||
    a.name.localeCompare(b.name)
  );
}

// ---------- Queue ----------

export async function queue(env: Env): Promise<Job[]> {
  const [tasks, claims, assigned] = await Promise.all([loadTasks(env), activeClaims(env), activeAssignments(env).catch(() => new Map<string, Assignment>())]);
  return tasks
    .filter((t) => isApplication(t, env) && t.status === "not started")
    .map((t) => toJob(t, claims.get(t.id), assigned.get(t.id)))
    .sort(byBestFirst);
}

export const isAvailable = (j: Job) => !j.claimedBy && !j.needsHuman && !!j.applyUrl;
/** Claimable by this agent: a job handed to another agent doesn't count. */
export const isAvailableFor = (j: Job, agent: string) => isAvailable(j) && (!j.assignedTo || j.assignedTo === agent);

export async function claimJobs(
  env: Env,
  agent: string,
  opts: { count?: number; ats?: string[] } = {},
): Promise<{ jobs: Job[]; remaining: number; paced: { ats: string; reason: string; retryAt: string | null }[] }> {
  const count = Math.min(10, Math.max(1, Math.floor(opts.count ?? 1)));
  const ats = (opts.ats ?? []).map((a) => a.toLowerCase()).filter(Boolean);
  const all = await queue(env);
  const policy = await getPolicy(env);
  const pace = await pacingState(env, all, policy);
  const paced = new Map<string, { ats: string; reason: string; retryAt: string | null }>();

  // Re-hand an agent the jobs it already holds (e.g. after a crash) before giving it new ones.
  const mine = all.filter((j) => j.claimedBy === agent);
  const out: Job[] = mine.slice(0, count);

  // Jobs handed to this agent come first.
  const ordered = [...all.filter((j) => j.assignedTo === agent), ...all.filter((j) => j.assignedTo !== agent)];
  for (const job of ordered) {
    if (out.length >= count) break;
    if (!isAvailableFor(job, agent)) continue;
    if (ats.length && !ats.some((a) => (job.ats ?? "").toLowerCase().includes(a))) continue;
    const verdict = checkJob(job, pace, policy, Date.now(), job.assignedTo === agent);
    if (!verdict.ok) {
      const k = atsKey(job.ats);
      if (!paced.has(k)) paced.set(k, { ats: k, reason: verdict.reason, retryAt: verdict.retryAt ? new Date(verdict.retryAt).toISOString() : null });
      continue;
    }
    // The list may be up to 10 min old: confirm with one fresh read that nobody (e.g. a Chrome
    // session working ClickUp directly) applied, parked or claimed it meanwhile.
    const fresh = mock(env) ? null : await loadTask(env, job.id).catch(() => null);
    if (fresh && !isAvailable(toJob(fresh, null))) continue;
    if (fresh && fresh.status !== "not started") continue;
    const expiresAt = await tryClaim(env, job.id, agent, leaseMs(env));
    if (!expiresAt) continue; // another agent won the race
    notePacedClaim(job, pace);
    await write(env, () => setField(env, job.id, env.FIELD_NEXT_ACTION, claimNote(agent, expiresAt)));
    await logEvent(env, { agent, taskId: job.id, taskName: job.name, type: "claimed", ats: atsKey(job.ats), company: companyKey(job.company) });
    out.push({ ...job, claimedBy: agent, claimExpiresAt: new Date(expiresAt).toISOString() });
  }

  const remaining = all.filter((j) => isAvailableFor(j, agent)).length - (out.length - mine.length);
  return { jobs: out, remaining: Math.max(0, remaining), paced: [...paced.values()] };
}

export async function getJob(env: Env, id: string): Promise<Job> {
  const [task, claim, assigned] = await Promise.all([loadTask(env, id), getClaim(env, id), getAssignment(env, id).catch(() => null)]);
  return toJob(task, claim, assigned);
}

/**
 * Give a job you can't finish to another agent (default Kimi) instead of skipping it.
 * Only the holder (or an admin) can hand it off; the assignee gets it ahead of the queue for 6 h.
 */
export async function handoffJob(env: Env, agent: string, id: string, reason: string, to: string = FALLBACK_AGENT, admin = false): Promise<{ ok: true; assignedTo: string }> {
  const target = to.toLowerCase();
  const why = reason?.trim();
  if (!why) throw new HttpError(400, "reason is required: say what you couldn't do");
  if (!agentNames(env).includes(target)) throw new HttpError(400, `unknown agent "${to}"`);
  if (target === agent) throw new HttpError(400, `you are ${agent}: report needs_human instead of handing it to yourself`);
  const [task, claim] = await Promise.all([loadTask(env, id), getClaim(env, id)]);
  const job = toJob(task, claim);
  assertHolder(job, agent, admin);
  if (task.status !== "not started") throw new HttpError(409, `${task.name} is already "${task.status}"`);
  await deleteClaim(env, id);
  await assignJob(env, id, target, why, agent);
  const today = new Date().toISOString().slice(0, 10);
  await write(env, async () => {
    await setField(env, id, env.FIELD_NEXT_ACTION, `Assigned to ${target}: ${why}`.slice(0, 250));
    await addComment(env, id, `[hub] ${today}: ${displayAgent(agent)} handed this to ${displayAgent(target)}: ${why}`);
  });
  if (!mock(env)) await patchMirror(env, id, { nextAction: `Assigned to ${target}: ${why}`.slice(0, 250) });
  await logEvent(env, { agent, taskId: id, taskName: task.name, type: "handoff", message: `→ ${target}: ${why}` });
  await notify(env, `🔀 <b>${esc(displayAgent(agent))}</b> handed <a href="${task.url}">${esc(task.name)}</a> to <b>${esc(displayAgent(target))}</b>: ${esc(why.slice(0, 200))}`, { silent: true });
  return { ok: true, assignedTo: target };
}

/** Throws 409 if someone else holds the job. Admins ("human") may act on anything. */
function assertHolder(job: Job, agent: string, admin: boolean) {
  if (!admin && job.claimedBy && job.claimedBy !== agent) {
    throw new HttpError(409, `${job.name} is claimed by ${job.claimedBy} until ${job.claimExpiresAt}`);
  }
}

export async function renewLease(env: Env, agent: string, id: string): Promise<Job> {
  const job = await getJob(env, id);
  assertHolder(job, agent, false);
  if (job.status !== "not started") throw new HttpError(409, `${job.name} is already "${job.status}"`);
  const expiresAt = await tryClaim(env, id, agent, leaseMs(env));
  if (!expiresAt) throw new HttpError(409, `${job.name} was claimed by someone else`);
  await write(env, () => setField(env, id, env.FIELD_NEXT_ACTION, claimNote(agent, expiresAt)));
  return { ...job, claimedBy: agent, claimExpiresAt: new Date(expiresAt).toISOString() };
}

export async function releaseJob(env: Env, agent: string, id: string, note?: string, admin = false): Promise<void> {
  const [task, claim] = await Promise.all([loadTask(env, id), getClaim(env, id)]);
  const job = toJob(task, claim);
  assertHolder(job, agent, admin);
  await deleteClaim(env, id);
  await clearAssignment(env, id);
  if (task.nextAction && (CLAIM_NOTE.test(task.nextAction) || /^Assigned to /i.test(task.nextAction) || (admin && NEEDS_HUMAN.test(task.nextAction)))) {
    await write(env, () => clearField(env, id, env.FIELD_NEXT_ACTION));
    if (!mock(env)) await patchMirror(env, id, { nextAction: null });
  }
  if (note) await write(env, () => addComment(env, id, `[hub] Released by ${displayAgent(agent)}: ${note}`));
  await logEvent(env, { agent, taskId: id, taskName: task.name, type: "released", message: note });
}

export interface Report {
  outcome: Outcome;
  platform?: string | null;
  note?: string | null;
}

export async function reportResult(
  env: Env,
  agent: string,
  id: string,
  r: Report,
  admin = false,
): Promise<{ job: Job; warnings: string[] }> {
  if (!OUTCOMES.includes(r.outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(", ")}`);
  const note = r.note?.trim().slice(0, 4000) || null;
  if ((r.outcome === "skipped" || r.outcome === "needs_human") && !note) {
    throw new HttpError(400, `a note explaining why is required for outcome "${r.outcome}"`);
  }

  const [task, claim] = await Promise.all([loadTask(env, id), getClaim(env, id)]);
  const job = toJob(task, claim);
  assertHolder(job, agent, admin);
  if (r.outcome === "applied" && task.status !== "not started") {
    throw new HttpError(409, `${task.name} is already "${task.status}"${task.appliedBy ? ` (by ${task.appliedBy})` : ""}; not overwriting`);
  }

  const who = displayAgent(agent);
  // The real submitting platform: what the agent said, else the job's ATS / apply link, else "Company site". Never "Other".
  const platform = inferPlatform({ platform: r.platform, ats: job.ats, url: job.applyUrl, text: note });
  const today = new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];

  switch (r.outcome) {
    case "applied": {
      await write(env, async () => {
        await setStatus(env, id, "applied");
        const stamped = await stampApplied(env, id, { agent, platform, on: today });
        if (!stamped.platform) warnings.push(`ClickUp "Platform Applied" has no option "${platform}"; add it in ClickUp (the comment records it meanwhile).`);
        if (!stamped.appliedBy) warnings.push(`ClickUp "Applied By" has no option "${who}"; add it in ClickUp to tag these.`);
        await clearField(env, id, env.FIELD_NEXT_ACTION);
        await addComment(env, id, `[hub] ${today}: applied by ${who} via ${platform}.${note ? `\n${note}` : ""}`);
      });
      break;
    }
    case "needs_human": {
      await write(env, async () => {
        await setField(env, id, env.FIELD_NEXT_ACTION, `Needs human: ${note}`.slice(0, 250));
        await addComment(env, id, `[hub] ${today}: ${who} needs a human: ${note}`);
      });
      break;
    }
    case "skipped": {
      await write(env, async () => {
        await setStatus(env, id, "rejected / paused");
        await clearField(env, id, env.FIELD_NEXT_ACTION);
        await addComment(env, id, `[hub] ${today}: skipped by ${who}: ${note}`);
      });
      break;
    }
    case "failed": {
      await write(env, async () => {
        await clearField(env, id, env.FIELD_NEXT_ACTION);
        await addComment(env, id, `[hub] ${today}: ${who} could not finish; back in the queue.${note ? `\n${note}` : ""}`);
      });
      break;
    }
  }

  await deleteClaim(env, id);
  await clearAssignment(env, id);
  if (r.outcome === "needs_human") {
    await notify(env, `🙋 <b>${esc(who)} needs you</b> on <a href="${task.url}">${esc(task.name)}</a>\n${esc(note ?? "")}${job.applyUrl ? `\n<a href="${job.applyUrl}">Open the posting</a>` : ""}`);
  }
  await logEvent(env, { agent, taskId: id, taskName: task.name, type: r.outcome, message: note, ats: atsKey(platform), company: companyKey(job.company) });
  return { job: await getJob(env, id).catch(() => job), warnings };
}

// ---------- Adding work ----------

const norm = (s: string) => s.toLowerCase().replace(/[—–-]/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

async function findExisting(env: Env, company: string, role: string, url?: string): Promise<Task | null> {
  const key = norm(`${company} ${role}`);
  const tasks = (await loadTasks(env)).filter((t) => isApplication(t, env));
  return (
    tasks.find((t) => norm(t.name) === key) ??
    (url ? tasks.find((t) => parseDetails(t.description).applyUrl === url) : undefined) ??
    null
  );
}

export interface NewJob {
  company: string;
  role: string;
  url?: string;
  ats?: string;
  pay?: string;
  travel?: string;
  fit?: string;
  notes?: string;
}

/** Add a posting to the queue (status "not started"). Returns the existing task if it's already tracked. */
export async function addJob(env: Env, agent: string, j: NewJob): Promise<{ id: string; created: boolean; status: string }> {
  const existing = await findExisting(env, j.company, j.role, j.url);
  if (existing) return { id: existing.id, created: false, status: existing.status };
  let id = `demo-${Date.now()}`;
  await write(env, async () => {
    id = await createApplication(env, {
      company: j.company,
      role: j.role,
      url: j.url,
      platform: j.ats,
      pay: j.pay,
      travel: j.travel,
      fit: j.fit,
      notes: j.notes,
      appliedBy: displayAgent(agent),
      status: "not started",
    });
  });
  await invalidateMirror(env);
  await logEvent(env, { agent, taskId: id, taskName: `${j.company} — ${j.role}`, type: "added", message: j.url ?? null });
  return { id, created: true, status: "not started" };
}

/**
 * Log an application the agent already submitted for a posting that may not be in the queue.
 * If the posting is queued, it's reported on that task instead of duplicating it.
 */
export async function logApplication(
  env: Env,
  agent: string,
  a: NewJob & { platform?: string },
): Promise<{ id: string; created: boolean; warnings: string[] }> {
  const existing = await findExisting(env, a.company, a.role, a.url);
  if (existing && existing.status === "not started") {
    const { warnings } = await reportResult(env, agent, existing.id, { outcome: "applied", platform: a.platform ?? a.ats, note: a.notes });
    return { id: existing.id, created: false, warnings };
  }
  if (existing) {
    throw new HttpError(409, `${existing.name} is already tracked as "${existing.status}"${existing.appliedBy ? ` (by ${existing.appliedBy})` : ""}`);
  }
  let id = `demo-${Date.now()}`;
  await write(env, async () => {
    id = await createApplication(env, {
      company: a.company,
      role: a.role,
      url: a.url,
      platform: a.platform ?? a.ats,
      pay: a.pay,
      travel: a.travel,
      fit: a.fit,
      notes: a.notes,
      appliedBy: displayAgent(agent),
      status: "applied",
    });
  });
  await invalidateMirror(env);
  await logEvent(env, { agent, taskId: id, taskName: `${a.company} — ${a.role}`, type: "applied", message: a.notes ?? null, ats: atsKey(a.platform ?? a.ats), company: companyKey(a.company) });
  return { id, created: true, warnings: [] };
}
