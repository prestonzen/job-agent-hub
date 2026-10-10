import { getSetting, setSetting } from "./db";
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
