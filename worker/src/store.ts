import * as cu from "./clickup";
import { getSetting, setSetting } from "./db";
import * as h from "./huly";
import { mirrorTasks } from "./mirror";
import type { Env, Task } from "./types";

/**
 * The task store: every read and write of applications and playbook pages goes through here. With STORE=huly
 * (Preston, 2026-10-22: "let's move to Huly") Huly is the system of record and every write is mirrored to the
 * ClickUp task that carries the same application (the issue's ClickUp ID field) on a best-effort basis, so both
 * boards stay usable during the hand-over. With STORE=clickup (or Huly unconfigured) the legacy ClickUp path runs.
 */

export const useHuly = (env: Env) => (env.STORE ?? "clickup") === "huly" && h.hulyEnabled(env);
const mirrorOn = (env: Env) => !!env.CLICKUP_TOKEN;

/** Best-effort ClickUp mirror write: never fails the Huly write, just logs. */
async function mirror(env: Env, what: string, fn: () => Promise<unknown>): Promise<void> {
  if (!mirrorOn(env)) return;
  try { await fn(); } catch (e) { console.error(`clickup mirror (${what}) failed:`, (e as Error).message); }
}

/** The ClickUp task id for a Huly issue, from the local copy first (no round trip), else from Huly. */
async function clickupIdOf(env: Env, id: string): Promise<string | null> {
  const t = (await mirrorTasks(env)).find((x) => x.id === id);
  if (t) return t.clickupId ?? null;
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const i = await h.getIssue(cfg, p, id);
  return ((i[p.mixin] as Record<string, unknown> | undefined)?.clickupId as string | undefined) ?? null;
}

// ---------- reads ----------

/** Every application. Huly: descriptions (collaborative) come from the local copy when the issue is unchanged, else refetched, at most 40 per sync. */
export async function listTasks(env: Env): Promise<Task[]> {
  if (!useHuly(env)) return cu.listTasks(env);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const issues = await h.listIssues(cfg, p);
  const prev = new Map((await mirrorTasks(env)).map((t) => [t.id, t]));
  let fetched = 0;
  const out: Task[] = [];
  for (const i of issues) {
    const old = prev.get(i._id);
    let description = old?.description ?? "";
    if (!old || old.modifiedOn !== i.modifiedOn || !old.description) {
      if (fetched < 40) { fetched++; description = await h.issueDescription(cfg, i); }
    }
    out.push(h.toTask(cfg, p, i, description));
  }
  return out;
}

export async function getTask(env: Env, id: string): Promise<Task> {
  if (!useHuly(env)) return cu.getTask(env, id);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const i = await h.getIssue(cfg, p, id);
  return h.toTask(cfg, p, i, await h.issueDescription(cfg, i));
}

// ---------- writes ----------

export async function setStatus(env: Env, id: string, status: string): Promise<void> {
  if (!useHuly(env)) return cu.setStatus(env, id, status);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const sid = p.statusByName[status.toLowerCase()];
  if (!sid) throw new cu.HttpError(400, `unknown status "${status}"; known: ${Object.values(p.statusById).join(", ")}`);
  const i = await h.getIssue(cfg, p, id);
  await h.updateIssue(cfg, p, i, { status: sid });
  const cid = await clickupIdOf(env, id);
  if (cid) await mirror(env, "status", () => cu.setStatus(env, cid, status));
}

/** The Next Action note (claims, parks, handoffs); null clears it. */
export async function setNextAction(env: Env, id: string, text: string | null): Promise<void> {
  if (!useHuly(env)) return text === null ? cu.clearField(env, id, env.FIELD_NEXT_ACTION) : cu.setField(env, id, env.FIELD_NEXT_ACTION, text);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const i = await h.getIssue(cfg, p, id);
  await h.setFields(cfg, p, i, { nextAction: text ? text.slice(0, 1000) : null });
  const cid = await clickupIdOf(env, id);
  if (cid) await mirror(env, "next action", () => (text === null ? cu.clearField(env, cid, env.FIELD_NEXT_ACTION) : cu.setField(env, cid, env.FIELD_NEXT_ACTION, text.slice(0, 250))));
}

export async function stampApplied(env: Env, id: string, a: { agent: string; platform?: string | null; on?: string }): Promise<{ appliedBy: boolean; platform: boolean }> {
  if (!useHuly(env)) return cu.stampApplied(env, id, a);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const i = await h.getIssue(cfg, p, id);
  const by = h.enumValue(p, "appliedBy", a.agent) ?? h.enumValue(p, "appliedBy", a.agent.replace(/\d+$/, ""));
  const plat = h.enumValue(p, "platformApplied", a.platform);
  const on = a.on ?? new Date().toISOString().slice(0, 10);
  await h.setFields(cfg, p, i, { ...(by ? { appliedBy: by } : {}), ...(plat ? { platformApplied: plat } : {}), appliedOn: Date.parse(`${on}T12:00:00Z`) });
  const cid = await clickupIdOf(env, id);
  if (cid) await mirror(env, "applied stamp", () => cu.stampApplied(env, cid, a));
  return { appliedBy: !!by, platform: !!plat };
}

export async function addComment(env: Env, id: string, text: string): Promise<void> {
  if (!useHuly(env)) return cu.addComment(env, id, text);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const i = await h.getIssue(cfg, p, id);
  await h.addIssueComment(cfg, p, i, text);
  const cid = await clickupIdOf(env, id);
  if (cid) await mirror(env, "comment", () => cu.addComment(env, cid, text));
}

/** Same description shape as the hand-made queue tasks, so the queue parser reads both. */
export function applicationBody(a: cu.NewApplication): string {
  return [
    a.url ? `Apply: ${a.url}` : "",
    [`Pay: ${a.pay ?? "not posted"}`, `Travel: ${a.travel ?? "unknown"}`, `Fit: ${a.fit ?? "unrated"}`, `ATS: ${a.platform ?? "unknown"}`].join(" | "),
    a.notes ? `\n${a.notes}` : "",
    `\nAdded by ${a.appliedBy} via Job Agent Hub.`,
  ].filter(Boolean).join("\n");
}

/** New application (queued posting or an already-submitted one). Huly first; the ClickUp twin is created and linked when the mirror is on. */
export async function createApplication(env: Env, a: cu.NewApplication): Promise<string> {
  if (!useHuly(env)) return cu.createApplication(env, a);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const status = a.status ?? "applied";
  let clickupId: string | null = null;
  if (mirrorOn(env)) { try { clickupId = await cu.createApplication(env, a); } catch (e) { console.error("clickup mirror (create) failed:", (e as Error).message); } }
  const fitNum = a.fit?.match(/(\d+(?:\.\d+)?)\s*\/\s*5/)?.[1];
  const fields: Record<string, unknown> = {
    clickupId, applyUrl: a.url ?? null, pay: a.pay ?? null, platformApplied: h.enumValue(p, "platformApplied", a.platform) ?? null,
    appliedBy: status !== "not started" ? (h.enumValue(p, "appliedBy", a.appliedBy) ?? h.enumValue(p, "appliedBy", a.appliedBy.replace(/\d+$/, "")) ?? null) : null,
    appliedOn: status !== "not started" ? Date.parse(`${a.appliedOn ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`) : null,
    category: h.enumValue(p, "category", "Job board") ?? null,
  };
  void fitNum;
  const i = await h.createIssue(cfg, p, { title: `${a.company} — ${a.role}`, description: applicationBody(a), status, fields });
  return i._id;
}

const PARK_SUFFIX = /\s*\((?:NEEDS HUMAN|BLOCKED|PARKED)\b[^)]*\)\s*$/i;
/** Un-park: strip the name marker, clear Next Action and Applied By, status back to not started. */
export async function requeueTask(env: Env, id: string): Promise<{ name: string }> {
  if (!useHuly(env)) return cu.requeueTask(env, id);
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const i = await h.getIssue(cfg, p, id);
  const name = i.title.replace(PARK_SUFFIX, "").trim();
  await h.updateIssue(cfg, p, i, { ...(name !== i.title ? { title: name } : {}), status: p.statusByName["not started"] });
  await h.setFields(cfg, p, i, { nextAction: null, appliedBy: null });
  const cid = await clickupIdOf(env, id);
  if (cid) await mirror(env, "requeue", () => cu.requeueTask(env, cid));
  return { name };
}

// ---------- playbook ----------

/** Huly document title ↔ the ClickUp page it mirrors (the seven playbook pages). */
const PAGE_MAP: Record<string, string> = {
  "Applicant Profile & Standard Answers": "kkr4k-13411",
  "Answer Bank (edit me — assistants read this)": "kkr4k-13431",
  "Story: AI Voice Agent for Galaxy Landscaping": "kkr4k-13451",
  "Platform Log & Learnings": "kkr4k-13471",
  "Question Bank — every question asked so far": "kkr4k-13551",
  "Voice & Tone Example Essay (match this)": "kkr4k-13571",
  "Story: Games — Roblox (Kaizen Gaming) and UAV Intercept Simulator": "kkr4k-13591",
};
const titleForPage = (pageId: string) => Object.entries(PAGE_MAP).find(([, id]) => id === pageId)?.[0];

let playbookCache: { at: number; text: string } | null = null;
const PLAYBOOK_TTL_MS = 4 * 3_600_000;

/** The whole playbook as one markdown text: every document in the teamspace, in order, under its title. */
export async function getPlaybook(env: Env, force = false): Promise<string> {
  if (!useHuly(env)) return cu.getPlaybook(env, force);
  if (!force && playbookCache && Date.now() - playbookCache.at < 300_000) return playbookCache.text;
  const saved = await getSetting<{ at: number; text: string }>(env, "playbook_cache_huly").catch(() => null);
  if (!force && saved && Date.now() - saved.at < PLAYBOOK_TTL_MS) { playbookCache = saved; return saved.text; }
  try {
    const cfg = h.hulyCfg(env);
    const parts: string[] = [];
    for (const d of await h.listDocs(cfg)) {
      const md = (await h.docMarkdown(cfg, d)).trim();
      parts.push(md.startsWith("# ") ? md : `# ${d.title}\n\n${md}`);
    }
    const text = parts.join("\n\n");
    playbookCache = { at: Date.now(), text };
    await setSetting(env, "playbook_cache_huly", playbookCache).catch(() => {});
    return text;
  } catch (e) {
    if (saved) return saved.text;
    throw e;
  }
}
async function forgetPlaybook(env: Env) { playbookCache = null; await setSetting(env, "playbook_cache_huly", { at: 0, text: "" }).catch(() => {}); }

export async function listDocPages(env: Env): Promise<{ id: string; name: string }[]> {
  if (!useHuly(env)) return cu.listDocPages(env);
  return (await h.listDocs(h.hulyCfg(env))).map((d) => ({ id: d._id, name: d.title }));
}

/** A page by Huly id, title, or the ClickUp page id it mirrors. */
export async function getDocPage(env: Env, ref: string): Promise<{ name: string; content: string }> {
  if (!useHuly(env)) return cu.getDocPage(env, ref);
  const cfg = h.hulyCfg(env);
  const d = await h.findDoc(cfg, titleForPage(ref) ?? ref);
  if (!d) throw new cu.HttpError(404, `no playbook page matching "${ref}"`);
  return { name: d.title, content: await h.docMarkdown(cfg, d) };
}

/** Exact in-place edits (each `find` must match exactly once, or nothing is written). Mirrored to the ClickUp page when one exists. */
export async function patchDocPage(env: Env, ref: string, edits: { find: string; replace: string }[], dry = false): Promise<{ applied: boolean; report: { find: string; matches: number }[]; chars?: number }> {
  if (!useHuly(env)) return cu.patchDocPage(env, ref, edits, dry);
  const cfg = h.hulyCfg(env);
  const d = await h.findDoc(cfg, titleForPage(ref) ?? ref);
  if (!d) throw new cu.HttpError(404, `no playbook page matching "${ref}"`);
  let content = await h.docMarkdown(cfg, d);
  const report = edits.map((e) => ({ find: e.find.slice(0, 70), matches: content.split(e.find).length - 1 }));
  if (report.some((r) => r.matches !== 1) || dry) return { applied: false, report };
  for (const e of edits) content = content.replace(e.find, () => e.replace);
  await h.setDocMarkdown(cfg, d, content);
  await forgetPlaybook(env);
  const page = PAGE_MAP[d.title];
  if (page) await mirror(env, "playbook patch", () => cu.patchDocPage(env, page, edits));
  return { applied: true, report, chars: content.length };
}

export async function appendDocPage(env: Env, ref: string, markdown: string): Promise<void> {
  if (!useHuly(env)) return cu.appendDocPage(env, ref, markdown);
  const cfg = h.hulyCfg(env);
  const d = await h.findDoc(cfg, titleForPage(ref) ?? ref);
  if (!d) throw new cu.HttpError(404, `no playbook page matching "${ref}"`);
  const current = await h.docMarkdown(cfg, d);
  await h.setDocMarkdown(cfg, d, `${current.replace(/\s+$/, "")}\n\n${markdown.trim()}\n`);
  await forgetPlaybook(env);
  const page = PAGE_MAP[d.title];
  if (page) await mirror(env, "playbook append", () => cu.appendDocPage(env, page, markdown));
}

// ---------- dual-run reconciliation ----------

/**
 * While both boards are in use, pull status / Next Action / Applied By / Platform / Applied On from the ClickUp twin
 * of every issue into Huly where they differ (ClickUp wins: it is where edits made outside the hub still land).
 * dry=true only reports. Returns one line per change.
 */
export async function reconcileFromClickUp(env: Env, dry = true): Promise<{ checked: number; changes: string[] }> {
  if (!useHuly(env) || !mirrorOn(env)) return { checked: 0, changes: [] };
  const cfg = h.hulyCfg(env), p = await h.project(cfg);
  const cuTasks = new Map((await cu.listTasks(env)).map((t) => [t.id, t]));
  const issues = await h.listIssues(cfg, p);
  const changes: string[] = [];
  let checked = 0;
  for (const i of issues) {
    const f = (i[p.mixin] as Record<string, unknown> | undefined) ?? {};
    const cid = typeof f.clickupId === "string" ? f.clickupId : null;
    const t = cid ? cuTasks.get(cid) : undefined;
    if (!t) continue;
    checked++;
    // ClickUp wins only where it was edited more recently than the issue; an empty ClickUp field never clears Huly.
    if (Date.parse(t.updatedAt) <= i.modifiedOn) continue;
    const ops: Record<string, unknown> = {};
    const fields: Record<string, unknown> = {};
    const status = p.statusByName[t.status.toLowerCase()];
    if (status && status !== i.status) ops.status = status;
    if (t.nextAction && t.nextAction !== ((f.nextAction as string | undefined) ?? null)) fields.nextAction = t.nextAction;
    const by = h.enumValue(p, "appliedBy", t.appliedBy);
    if (by && by !== ((f.appliedBy as string | undefined) ?? null)) fields.appliedBy = by;
    const plat = h.enumValue(p, "platformApplied", t.platform);
    if (plat && plat !== ((f.platformApplied as string | undefined) ?? null)) fields.platformApplied = plat;
    const on = t.appliedOn ? Date.parse(`${t.appliedOn}T12:00:00Z`) : null;
    if (on && on !== ((f.appliedOn as number | undefined) ?? null)) fields.appliedOn = on;
    if (!Object.keys(ops).length && !Object.keys(fields).length) continue;
    changes.push(`${i.identifier} ${i.title.slice(0, 40)}: ${[...Object.entries(ops).map(([k]) => `${k}→${t.status}`), ...Object.keys(fields)].join(", ")}`);
    if (dry) continue;
    await h.updateIssue(cfg, p, i, ops);
    await h.setFields(cfg, p, i, fields);
  }
  return { checked, changes };
}
