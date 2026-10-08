import type { Env, Task } from "./types";

const API = "https://api.clickup.com/api/v2";

/** Option ids for the "Applied By" / "Platform Applied" dropdowns (non-secret). */
export const APPLIED_BY_OPTIONS: Record<string, string> = {
  human: "0601dc66-bddb-48c4-a259-3d7996791d5a",
  claude: "a7a4cf00-13b4-4f58-aa27-aa4301a68bcc",
  codex: "54287086-b101-4729-be39-03e7bbe456e3",
  kimi: "d5f4aeb7-3902-40b6-bc63-ff5e3a39f7d9",
  gemini: "18a5415b-f769-4ca7-a75a-ad75402c75e6",
  ollama: "72731baf-2d9c-4ca9-8f4a-6e696c57faca",
};

export const PLATFORM_OPTIONS: Record<string, string> = {
  greenhouse: "1b66d78e-5671-442c-a2a6-14c32cf01ad9",
  ashby: "883d90fa-bc26-4994-8577-f0cccdc98a05",
  lever: "ad3c756b-2a09-4374-b256-5811497ba472",
  "company site": "7f4052c3-596e-477d-9bba-48699ad66282",
  linkedin: "5581edb1-da56-4c81-963a-93be27c956e2",
  wellfound: "bc753c44-5856-4b64-8313-4d5048d3b52d",
  upwork: "c2ed080f-6deb-4fa9-8013-b104fc398673",
  other: "fd27c2f7-c13a-452f-b210-3b70e19cd8f7",
};

interface CuField {
  id: string;
  type: string;
  type_config?: { options?: { id: string; name: string; orderindex: number }[] };
  value?: unknown;
}

interface CuTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string };
  parent?: string | null;
  url: string;
  tags?: { name: string }[];
  date_created: string;
  date_updated: string;
  custom_fields?: CuField[];
}

function token(env: Env): string {
  if (!env.CLICKUP_TOKEN) throw new HttpError(500, "CLICKUP_TOKEN secret is not set");
  return env.CLICKUP_TOKEN;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function cu(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
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
  return res.json();
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

export interface NewApplication {
  company: string;
  role: string;
  platform?: string;
  appliedBy: string;
  status?: string;
  notes?: string;
  url?: string;
  appliedOn?: string; // YYYY-MM-DD
}

export async function createApplication(env: Env, a: NewApplication): Promise<string> {
  const custom_fields: { id: string; value: string | number }[] = [];
  const by = APPLIED_BY_OPTIONS[a.appliedBy.toLowerCase()];
  if (by) custom_fields.push({ id: env.FIELD_APPLIED_BY, value: by });
  const plat = PLATFORM_OPTIONS[(a.platform ?? "other").toLowerCase()] ?? PLATFORM_OPTIONS.other;
  custom_fields.push({ id: env.FIELD_PLATFORM, value: plat });
  const on = a.appliedOn ?? new Date().toISOString().slice(0, 10);
  custom_fields.push({ id: env.FIELD_APPLIED_ON, value: Date.parse(`${on}T12:00:00Z`) });

  const created = (await cu(env, `/list/${env.CLICKUP_LIST_ID}/task`, {
    method: "POST",
    body: JSON.stringify({
      name: `${a.company} — ${a.role}`,
      parent: env.PARENT_TASK_ID,
      status: a.status ?? "applied",
      markdown_description: [a.url ? `Posting: ${a.url}` : "", a.notes ?? ""].filter(Boolean).join("\n\n"),
      custom_fields,
    }),
  })) as { id: string };
  return created.id;
}
