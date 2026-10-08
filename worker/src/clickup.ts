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

async function cu(env: Env, path: string, init: RequestInit = {}, base = API): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: token(env),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new HttpError(502, `ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
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
  const plat = (a.platform && (await optionId(env, env.FIELD_PLATFORM, a.platform))) || (await optionId(env, env.FIELD_PLATFORM, "Other"));
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
    const plat = (await optionId(env, env.FIELD_PLATFORM, a.platform ?? "Other")) ?? (await optionId(env, env.FIELD_PLATFORM, "Other"));
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
      name: `${a.company} — ${a.role}`,
      parent: env.PARENT_TASK_ID,
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

/**
 * The playbook lives in a ClickUp Doc (standard answers, EEO, salary, rules). It holds personal
 * data, so it is only ever returned to authenticated agents and admins, and cached in memory only.
 */
export async function getPlaybook(env: Env): Promise<string> {
  if (playbookCache && Date.now() - playbookCache.at < 300_000) return playbookCache.text;
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
      if (p.name) out.push(`# ${p.name}`);
      if (p.content) out.push(p.content.trim());
      if (p.pages?.length) walk(p.pages);
    }
  };
  walk(pages);
  const text = out.join("\n\n");
  playbookCache = { at: Date.now(), text };
  return text;
}
