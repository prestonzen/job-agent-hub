import { db, getSetting, setSetting } from "./db";
import { countCall, enqueueWrite } from "./mirror";
import type { Env, Task } from "./types";

const API = "https://api.clickup.com/api/v2";
const API_V3 = "https://api.clickup.com/api/v3";

interface CuOption {
  id: string;
  name: string;
  orderindex: number;
}

interface CuField {
  id: string;
  name?: string;
  type: string;
  type_config?: { options?: CuOption[] };
  value?: unknown;
}

interface CuTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string };
  parent?: string | null;
  priority?: { priority: string } | null;
  url: string;
  tags?: { name: string }[];
  date_created: string;
  date_updated: string;
  custom_fields?: CuField[];
}

function token(env: Env): string {
  if (!env.CLICKUP_TOKEN) throw new HttpError(503, "CLICKUP_TOKEN secret is not set on the hub");
  return env.CLICKUP_TOKEN;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Every ClickUp call goes through here: it is counted (api_usage), and a write that hits a rate
 * limit or ClickUp outage is parked in the D1 outbox and replayed later instead of failing the
 * agent's action. Reads throw (503 when rate-limited) so callers fall back to the local copy.
 * Task creation is never deferred, because the caller needs the new id.
 */
async function cu(env: Env, path: string, init: RequestInit = {}, base = API): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: token(env),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  await countCall(env);
  if (!res.ok) {
    const detail = `ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`;
    const transient = res.status === 429 || res.status >= 500;
    const creates = method === "POST" && /^\/list\/[^/]+\/task$/.test(path);
    if (transient && method !== "GET" && base === API && !creates) {
      await enqueueWrite(env, method, path, typeof init.body === "string" ? init.body : null, detail);
      return { deferred: true };
    }
    throw new HttpError(res.status === 429 ? 503 : 502, detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** Replay one deferred write (from the outbox). Throws if ClickUp still refuses it. */
export async function replayWrite(env: Env, method: string, path: string, body: string | null): Promise<void> {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: token(env), "Content-Type": "application/json" }, body: body ?? undefined });
  await countCall(env);
  if (!res.ok && (res.status === 429 || res.status >= 500)) throw new Error(`ClickUp ${res.status}`);
  // 4xx (e.g. task deleted since): drop it rather than retry forever.
}

/** Resolve a dropdown custom field to its option name (ClickUp returns the option's orderindex). */
function dropdownName(field: CuField | undefined): string | null {
  if (!field || field.value === undefined || field.value === null) return null;
  const options = field.type_config?.options ?? [];
  const v = field.value;
  const byIndex = options.find((o) => o.orderindex === v);
  if (byIndex) return byIndex.name;
  const byId = options.find((o) => o.id === v);
  return byId ? byId.name : null;
}

function dateField(field: CuField | undefined): string | null {
  if (!field?.value) return null;
  const ms = Number(field.value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function textField(field: CuField | undefined): string | null {
  return typeof field?.value === "string" && field.value.trim() ? field.value.trim() : null;
}

function normalize(t: CuTask, env: Env): Task {
  const f = (id: string) => t.custom_fields?.find((c) => c.id === id);
  return {
    id: t.id,
    name: t.name,
    status: t.status.status,
    parentId: t.parent ?? null,
    appliedBy: dropdownName(f(env.FIELD_APPLIED_BY)),
    platform: dropdownName(f(env.FIELD_PLATFORM)),
    appliedOn: dateField(f(env.FIELD_APPLIED_ON)),
    nextAction: textField(f(env.FIELD_NEXT_ACTION)),
    priority: t.priority?.priority ?? null,
    tags: (t.tags ?? []).map((x) => x.name),
    url: t.url,
    description: t.description ?? "",
    createdAt: new Date(Number(t.date_created)).toISOString(),
    updatedAt: new Date(Number(t.date_updated)).toISOString(),
  };
}

export async function listTasks(env: Env): Promise<Task[]> {
  const out: Task[] = [];
  for (let page = 0; page < 20; page++) {
    const data = (await cu(
      env,
      `/list/${env.CLICKUP_LIST_ID}/task?include_closed=true&subtasks=true&page=${page}`,
    )) as { tasks: CuTask[]; last_page?: boolean };
    out.push(...data.tasks.map((t) => normalize(t, env)));
    if (data.last_page || data.tasks.length === 0) break;
  }
  return out;
}

export async function getTask(env: Env, taskId: string): Promise<Task> {
  return normalize((await cu(env, `/task/${encodeURIComponent(taskId)}`)) as CuTask, env);
}

export async function setStatus(env: Env, taskId: string, status: string): Promise<void> {
  await cu(env, `/task/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

/** ClickUp priority: 1 urgent, 2 high, 3 normal, 4 low. */
export async function setPriority(env: Env, taskId: string, priority: 1 | 2 | 3 | 4): Promise<void> {
  await cu(env, `/task/${encodeURIComponent(taskId)}`, { method: "PUT", body: JSON.stringify({ priority }) });
}

export async function addComment(env: Env, taskId: string, text: string): Promise<void> {
  await cu(env, `/task/${encodeURIComponent(taskId)}/comment`, {
    method: "POST",
    body: JSON.stringify({ comment_text: text }),
  });
}

export async function setField(env: Env, taskId: string, fieldId: string, value: string | number): Promise<void> {
  await cu(env, `/task/${encodeURIComponent(taskId)}/field/${fieldId}`, {
    method: "POST",
    body: JSON.stringify({ value }),
  });
}

export async function clearField(env: Env, taskId: string, fieldId: string): Promise<void> {
  await cu(env, `/task/${encodeURIComponent(taskId)}/field/${fieldId}`, { method: "DELETE" });
}

// ---------- Requeue: fully un-park a task so agents can claim it again ----------

/** Trailing "(NEEDS HUMAN: …)" / "(BLOCKED …)" / "(PARKED)" marker on a task name. */
const PARK_SUFFIX = /\s*\((?:NEEDS HUMAN|BLOCKED|PARKED)\b[^)]*\)\s*$/i;

/**
 * Un-park a task. The hub reads a task as parked from its Next Action note, a park marker in its name,
 * or an Applied By stamp ("already worked"), so all three are cleared, then the status goes back to
 * not started. Clearing an already-empty field is not an error.
 */
export async function requeueTask(env: Env, taskId: string): Promise<{ name: string }> {
  const t = await getTask(env, taskId);
  const name = t.name.replace(PARK_SUFFIX, "").trim();
  await Promise.all([
    name !== t.name ? cu(env, `/task/${encodeURIComponent(taskId)}`, { method: "PUT", body: JSON.stringify({ name }) }) : Promise.resolve(),
    clearField(env, taskId, env.FIELD_NEXT_ACTION).catch(() => {}),
    clearField(env, taskId, env.FIELD_APPLIED_BY).catch(() => {}),
  ]);
  await setStatus(env, taskId, "not started");
  return { name };
}

// ---------- Dropdown options (read live, so new options like "Mistral" work without a deploy) ----------

let fieldCache: { at: number; fields: CuField[] } | null = null;

async function listFields(env: Env): Promise<CuField[]> {
  if (fieldCache && Date.now() - fieldCache.at < 600_000) return fieldCache.fields;
  const { fields } = (await cu(env, `/list/${env.CLICKUP_LIST_ID}/field`)) as { fields: CuField[] };
  fieldCache = { at: Date.now(), fields };
  return fields;
}

/** Option id for a dropdown value by (case-insensitive) name, or null if the option doesn't exist. */
export async function optionId(env: Env, fieldId: string, name: string): Promise<string | null> {
  const field = (await listFields(env)).find((f) => f.id === fieldId);
  const opt = field?.type_config?.options?.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
  return opt?.id ?? null;
}

export async function optionNames(env: Env, fieldId: string): Promise<string[]> {
  const field = (await listFields(env)).find((f) => f.id === fieldId);
  return (field?.type_config?.options ?? []).map((o) => o.name);
}

/** Stamp Applied By / Platform Applied / Applied On. Unknown dropdown values are skipped, not guessed. */
export async function stampApplied(
  env: Env,
  taskId: string,
  a: { agent: string; platform?: string | null; on?: string },
): Promise<{ appliedBy: boolean; platform: boolean }> {
  const by = await optionId(env, env.FIELD_APPLIED_BY, a.agent);
  const plat = a.platform ? await optionId(env, env.FIELD_PLATFORM, a.platform) : null; // no "Other" fallback: add the specific platform to the dropdown instead
  const on = a.on ?? new Date().toISOString().slice(0, 10);
  await Promise.all([
    by ? setField(env, taskId, env.FIELD_APPLIED_BY, by) : Promise.resolve(),
    plat ? setField(env, taskId, env.FIELD_PLATFORM, plat) : Promise.resolve(),
    setField(env, taskId, env.FIELD_APPLIED_ON, Date.parse(`${on}T12:00:00Z`)),
  ]);
  return { appliedBy: !!by, platform: !!plat };
}

export interface NewApplication {
  company: string;
  role: string;
  platform?: string;
  appliedBy: string;
  status?: string;
  notes?: string;
  url?: string;
  appliedOn?: string; // YYYY-MM-DD
  /** Queue-format posting details (for status "not started"). */
  pay?: string;
  travel?: string;
  fit?: string;
}

export async function createApplication(env: Env, a: NewApplication): Promise<string> {
  const status = a.status ?? "applied";
  const custom_fields: { id: string; value: string | number }[] = [];
  if (status !== "not started") {
    const by = await optionId(env, env.FIELD_APPLIED_BY, a.appliedBy);
    if (by) custom_fields.push({ id: env.FIELD_APPLIED_BY, value: by });
    const plat = a.platform ? await optionId(env, env.FIELD_PLATFORM, a.platform) : null;
    if (plat) custom_fields.push({ id: env.FIELD_PLATFORM, value: plat });
    const on = a.appliedOn ?? new Date().toISOString().slice(0, 10);
    custom_fields.push({ id: env.FIELD_APPLIED_ON, value: Date.parse(`${on}T12:00:00Z`) });
  }

  // Same shape as the hand-made queue tasks, so the queue parser reads both.
  const details = [
    a.url ? `Apply: ${a.url}` : "",
    [
      `Pay: ${a.pay ?? "not posted"}`,
      `Travel: ${a.travel ?? "unknown"}`,
      `Fit: ${a.fit ?? "unrated"}`,
      `ATS: ${a.platform ?? "unknown"}`,
    ].join(" | "),
    a.notes ? `\n${a.notes}` : "",
    `\nAdded by ${a.appliedBy} via Job Agent Hub.`,
  ];

  const created = (await cu(env, `/list/${env.CLICKUP_LIST_ID}/task`, {
    method: "POST",
    body: JSON.stringify({
      // Top-level task named "Company — Role" (applications are no longer subtasks of a parent).
      name: `${a.company} — ${a.role}`,
      status,
      markdown_description: details.filter(Boolean).join("\n"),
      custom_fields,
    }),
  })) as { id: string };
  return created.id;
}

// ---------- Playbook (ClickUp Doc → markdown) ----------

interface DocPage {
  id: string;
  name?: string;
  content?: string;
  pages?: DocPage[];
}

let playbookCache: { at: number; text: string } | null = null;

const pagePath = (env: Env, pageId: string) => `/workspaces/${env.CLICKUP_WORKSPACE_ID}/docs/${encodeURIComponent(env.PLAYBOOK_DOC_ID)}/pages/${encodeURIComponent(pageId)}`;

export async function getDocPage(env: Env, pageId: string): Promise<{ name: string; content: string }> {
  const p = (await cu(env, `${pagePath(env, pageId)}?content_format=text%2Fmd`, {}, API_V3)) as { name?: string; content?: string };
  return { name: p.name ?? "", content: p.content ?? "" };
}

async function forgetPlaybookCache(env: Env): Promise<void> {
  playbookCache = null;
  await setSetting(env, "playbook_cache", null).catch(() => {});
}

/** Exact find/replace on one page: every `find` must occur exactly once, otherwise nothing is written. */
export async function patchDocPage(env: Env, pageId: string, edits: { find: string; replace: string }[], dry = false) {
  const page = await getDocPage(env, pageId);
  let content = page.content;
  const report = edits.map((e) => ({ find: e.find.slice(0, 70), matches: content.split(e.find).length - 1 }));
  if (report.some((r) => r.matches !== 1) || dry) return { applied: false, report };
  for (const e of edits) content = content.replace(e.find, () => e.replace);
  await cu(env, pagePath(env, pageId), { method: "PUT", body: JSON.stringify({ content, content_format: "text/md", content_edit_mode: "replace" }) }, API_V3);
  await forgetPlaybookCache(env);
  return { applied: true, report, chars: content.length };
}

export async function appendDocPage(env: Env, pageId: string, markdown: string): Promise<void> {
  await cu(env, pagePath(env, pageId), { method: "PUT", body: JSON.stringify({ content: markdown, content_format: "text/md", content_edit_mode: "append" }) }, API_V3);
  await forgetPlaybookCache(env);
}
const PLAYBOOK_TTL_MS = 4 * 3_600_000; // refresh from ClickUp a few times a day

/**
 * The playbook lives in a ClickUp Doc (standard answers, EEO, salary, rules). It holds personal
 * data, so it is only ever returned to authenticated agents and admins, and cached in memory only.
 */
export async function getPlaybook(env: Env, force = false): Promise<string> {
  if (!force && playbookCache && Date.now() - playbookCache.at < 300_000) return playbookCache.text;
  // Shared cache in D1 so every isolate doesn't fetch the doc; refreshed every few hours.
  const saved = await getSetting<{ at: number; text: string }>(env, "playbook_cache").catch(() => null);
  if (!force && saved && Date.now() - saved.at < PLAYBOOK_TTL_MS) {
    playbookCache = saved;
    return saved.text;
  }
  try {
    const text = await fetchPlaybook(env);
    playbookCache = { at: Date.now(), text };
    await setSetting(env, "playbook_cache", playbookCache).catch(() => {});
    return text;
  } catch (e) {
    if (saved) return saved.text; // ClickUp down or rate-limited: serve the last copy
    throw e;
  }
}

/** List playbook pages with IDs (for targeted patch/append via /api/admin/playbook/patch). */
export async function listDocPages(env: Env): Promise<{ id: string; name: string }[]> {
  const data = (await cu(
    env,
    `/workspaces/${env.CLICKUP_WORKSPACE_ID}/docs/${encodeURIComponent(env.PLAYBOOK_DOC_ID)}/pages?max_page_depth=-1&content_format=text%2Fmd`,
    {},
    API_V3,
  )) as DocPage[] | { pages?: DocPage[] };
  const pages = Array.isArray(data) ? data : (data.pages ?? []);
  const out: { id: string; name: string }[] = [];
  const walk = (ps: DocPage[]) => {
    for (const p of ps) {
      out.push({ id: p.id, name: p.name ?? "" });
      if (p.pages?.length) walk(p.pages);
    }
  };
  walk(pages);
  return out;
}

async function fetchPlaybook(env: Env): Promise<string> {
  const data = (await cu(
    env,
    `/workspaces/${env.CLICKUP_WORKSPACE_ID}/docs/${encodeURIComponent(env.PLAYBOOK_DOC_ID)}/pages?max_page_depth=-1&content_format=text%2Fmd`,
    {},
    API_V3,
  )) as DocPage[] | { pages?: DocPage[] };
  const pages = Array.isArray(data) ? data : (data.pages ?? []);
  const out: string[] = [];
  const walk = (ps: DocPage[]) => {
    for (const p of ps) {
      const content = p.content?.trim() ?? "";
      // Pages usually open with their own "# <name>" heading; don't print the title twice.
      if (p.name && !content.startsWith(`# ${p.name}`)) out.push(`# ${p.name}`);
      if (content) out.push(content);
      if (p.pages?.length) walk(p.pages);
    }
  };
  walk(pages);
  return out.join("\n\n");
}

// ---------- Bug Bounty / Cyber list ----------

const CYBER_LIST_NAME = "Bug Bounty — Cyber Operations";

/** Cyber pipeline stages as ClickUp statuses (override of the space defaults). */
const CYBER_STATUSES = [
  { status: "scoping", type: "open", orderindex: 0, color: "#7f77f1" },
  { status: "scanning", type: "custom", orderindex: 1, color: "#04a9f4" },
  { status: "validating", type: "custom", orderindex: 2, color: "#f9d900" },
  { status: "report drafted", type: "custom", orderindex: 3, color: "#ff7fab" },
  { status: "submitted", type: "custom", orderindex: 4, color: "#e65100" },
  { status: "accepted", type: "done", orderindex: 5, color: "#6bc950" },
  { status: "refuted", type: "closed", orderindex: 6, color: "#656f7d" },
  { status: "parked", type: "custom", orderindex: 7, color: "#d92d20" },
];

/** Custom fields carried by every cyber task (program = one task). */
const CYBER_FIELDS: Record<string, unknown>[] = [
  { name: "Platform", type: "drop_down", type_config: { options: ["hackerone", "bugcrowd", "intigriti", "yeswehack", "research"].map((name, i) => ({ name, orderindex: i })) } },
  { name: "Severity", type: "drop_down", type_config: { options: ["critical", "high", "medium", "low", "info"].map((name, i) => ({ name, orderindex: i })) } },
  { name: "Program URL", type: "url" },
  { name: "Tech Stack", type: "text" },
  { name: "Hosts Scanned", type: "number" },
  { name: "Findings", type: "number" },
  { name: "Payouts USD", type: "currency", type_config: { precision: 2, currency_type: "USD" } },
  { name: "Last Scan", type: "date" },
];

/**
 * One-task-per-bounty-program list, created next to the jobs list (same space).
 * Idempotent: a stored setting short-circuits, and a half-created list/field set is
 * completed rather than duplicated. Scan summaries and tech stacks flow in via syncCyberTask.
 */
export async function ensureCyberList(env: Env): Promise<{ listId: string; created: boolean }> {
  const existing = await getSetting<string>(env, "clickup_cyber_list").catch(() => null);
  if (existing) return { listId: existing, created: false };

  const jobsList = (await cu(env, `/list/${env.CLICKUP_LIST_ID}`)) as { space?: { id: string } };
  const spaceId = jobsList.space?.id;
  if (!spaceId) throw new HttpError(502, "Could not resolve the jobs list's space");

  const lists = (await cu(env, `/space/${spaceId}/list?archived=false`)) as { lists?: { id: string; name: string }[] };
  let list = (lists.lists ?? []).find((l) => l.name === CYBER_LIST_NAME);
  if (!list) {
    list = (await cu(env, `/space/${spaceId}/list`, {
      method: "POST",
      body: JSON.stringify({
        name: CYBER_LIST_NAME,
        markdown_content:
          "One task per bug bounty program. The bounty pipeline keeps statuses, scan counts, tech stacks and findings in sync from the hub (bounty_events). Reports are drafts until Preston approves submission.",
      }),
    })) as { id: string; name: string };
  }

  await cu(env, `/list/${list.id}`, {
    method: "PUT",
    body: JSON.stringify({ override_statuses: true, statuses: CYBER_STATUSES }),
  });

  const have = (await cu(env, `/list/${list.id}/field`)) as { fields?: { name?: string }[] };
  const present = new Set((have.fields ?? []).map((f) => f.name));
  for (const field of CYBER_FIELDS) {
    if (present.has(field.name as string)) continue;
    await cu(env, `/list/${list.id}/field`, { method: "POST", body: JSON.stringify(field) });
  }

  await setSetting(env, "clickup_cyber_list", list.id);
  return { listId: list.id, created: true };
}

/** Status order for the cyber list; a program's task only ever advances, never regresses. */
const CYBER_STATUS_ORDER = ["scoping", "scanning", "validating", "report drafted", "submitted", "accepted"];

interface CyberSyncInput {
  program: string;
  platform?: string | null;
  kind?: string;
  status?: string | null;
  severity?: string | null;
  detail?: string | null;
  title?: string | null;
  amount?: number | null;
}

/** Map a bounty event to the list status the program's task should sit at (null = keep current). */
function cyberStatusFor(i: CyberSyncInput): string | null {
  if (i.kind === "payout") return "accepted";
  if (i.kind === "report") return "report drafted";
  if (i.kind === "finding" && i.status === "confirmed") return "validating";
  if (i.kind === "scan") return "scanning";
  if (i.kind === "program") return "scoping";
  return null;
}

/**
 * Mirror a bounty event into the cyber ClickUp list: one task per program, fields refreshed
 * from the hub's own tables (host/finding counts, tech stack, payouts), status advanced, and
 * the event's summary appended as a comment. Never throws into the caller's request path —
 * failures surface as console errors and the next event retries the state.
 */
export async function syncCyberTask(env: Env, input: CyberSyncInput): Promise<void> {
  const program = input.program.trim();
  if (!program || program === "Pipeline Test") return;
  const listId = await getSetting<string>(env, "clickup_cyber_list").catch(() => null);
  if (!listId) return; // list not provisioned yet

  // Find the program's task (cyber lists are small; a page or two at most).
  let task: { id: string; status: { status: string } } | undefined;
  for (let page = 0; page < 5 && !task; page++) {
    const res = (await cu(env, `/list/${listId}/task?include_closed=true&page=${page}`)) as { tasks?: { id: string; name: string; status: { status: string } }[] };
    const tasks = res.tasks ?? [];
    task = tasks.find((t) => t.name === program);
    if (tasks.length < 100) break;
  }
  if (!task) {
    const created = (await cu(env, `/list/${listId}/task`, {
      method: "POST",
      body: JSON.stringify({ name: program, description: "Bug bounty program. Fields and comments are synced from the hub's bounty pipeline.", status: "scoping" }),
    })) as { id: string; status: { status: string } };
    task = { id: created.id, status: created.status };
  }

  // Aggregate the hub's own tables for this program.
  const d = await db(env);
  const counts = (await d
    .prepare(`SELECT COUNT(*) AS scans, SUM(kind='finding') AS findings, SUM(kind='payout' AND amount IS NOT NULL) AS payoutEvents, SUM(CASE WHEN kind='payout' THEN amount ELSE 0 END) AS payouts FROM bounty_events WHERE program = ?`)
    .bind(program)
    .first<{ scans: number; findings: number | null; payouts: number | null }>()) ?? { scans: 0, findings: 0, payouts: 0 };
  const techRows = await d
    .prepare(`SELECT DISTINCT je.value AS tech FROM bounty_hosts, json_each(bounty_hosts.techs) je WHERE program = ? LIMIT 20`)
    .bind(program)
    .all<{ tech: string }>()
    .catch(() => ({ results: [] as { tech: string }[] }));

  // Resolve field ids (and drop-down option ids) once per sync.
  const fields = (await cu(env, `/list/${listId}/field`)) as { fields?: CuField[] };
  const byName = new Map((fields.fields ?? []).map((f) => [f.name, f]));
  const optionId = (field: string, name: string) =>
    byName.get(field)?.type_config?.options?.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id;

  const custom: { id: string; value: unknown }[] = [];
  const push = (name: string, value: unknown) => {
    const f = byName.get(name);
    if (f && value !== undefined && value !== null && value !== "") custom.push({ id: f.id, value });
  };
  if (input.platform) { const oid = optionId("Platform", input.platform); if (oid) push("Platform", oid); }
  if (input.severity) { const oid = optionId("Severity", input.severity); if (oid) push("Severity", oid); }
  push("Hosts Scanned", counts.scans ?? 0);
  push("Findings", counts.findings ?? 0);
  if ((counts.payouts ?? 0) > 0) push("Payouts USD", Math.round((counts.payouts ?? 0) * 100) / 100);
  if (input.kind === "scan") push("Last Scan", Date.now());
  const techs = techRows.results.map((r) => r.tech).filter(Boolean).slice(0, 15).join(", ");
  if (techs) push("Tech Stack", techs);

  // Advance the status only forward through the pipeline.
  const next = cyberStatusFor(input);
  const current = (task.status.status ?? "").toLowerCase();
  const advance = next && CYBER_STATUS_ORDER.indexOf(next) > CYBER_STATUS_ORDER.indexOf(current) ? next : null;

  await cu(env, `/task/${encodeURIComponent(task.id)}`, {
    method: "PUT",
    body: JSON.stringify({ ...(advance ? { status: advance } : {}), ...(custom.length ? { custom_fields: custom } : {}) }),
  });

  const summary = (input.detail ?? input.title ?? "").trim();
  if (summary) await addComment(env, task.id, `[${input.kind}${input.status ? `/${input.status}` : ""}] ${summary}`.slice(0, 1500));
}
