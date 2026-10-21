import { HttpError } from "./clickup";
import type { Env, Task } from "./types";

/**
 * Huly (self-hosted) as the system of record. A thin client for the transactor's REST API (find-all / tx),
 * the collaborator service (issue descriptions and documents are collaborative markup, fetched and stored
 * separately from the issue record) and the two markup converters the hub needs (Huly's ProseMirror JSON
 * ↔ markdown). No Huly packages: the Worker bundle stays small and nothing expects a browser.
 *
 * The Job Hunter project (identifier JOB) carries one issue per application. Its task type's mixin holds the
 * ClickUp-equivalent fields (Platform Applied, Applied By, Applied On, Next Action, Pay, Apply URL, ClickUp ID…).
 */

export interface HulyCfg { url: string; ws: string; wsUrl: string; token: string; project: string; teamspace: string }
export function hulyCfg(env: Env): HulyCfg {
  if (!env.HULY_URL || !env.HULY_WORKSPACE_ID || !env.HULY_TOKEN) throw new HttpError(503, "Huly is not configured (HULY_URL / HULY_WORKSPACE_ID / HULY_TOKEN)");
  return { url: env.HULY_URL.replace(/\/$/, ""), ws: env.HULY_WORKSPACE_ID, wsUrl: env.HULY_WORKSPACE_URL ?? "kaizengroup", token: env.HULY_TOKEN, project: env.HULY_PROJECT ?? "JOB", teamspace: env.HULY_TEAMSPACE ?? "Job Hunter Playbook" };
}
export const hulyEnabled = (env: Env) => !!(env.HULY_URL && env.HULY_WORKSPACE_ID && env.HULY_TOKEN);

const SPACE = "core:space:Space";
export const PRIORITIES = ["none", "urgent", "high", "medium", "low"];

export function hulyId(): string {
  // Same shape as Huly's generateId: a time-ordered hex prefix plus random hex, 24 chars.
  const t = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  const r = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  return (t + r).slice(0, 24);
}

// ---------- transactor REST ----------

async function rest(cfg: HulyCfg, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${cfg.url}/_transactor/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new HttpError(res.status === 429 ? 503 : 502, `Huly ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export async function findAll<T = Record<string, unknown>>(cfg: HulyCfg, _class: string, query: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Promise<T[]> {
  const p = new URLSearchParams({ class: _class });
  if (Object.keys(query).length) p.set("query", JSON.stringify(query));
  if (Object.keys(options).length) p.set("options", JSON.stringify(options));
  const r = (await rest(cfg, `/find-all/${cfg.ws}?${p}`)) as { value?: T[]; error?: unknown };
  if (r.error) throw new HttpError(502, `Huly find-all: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r.value ?? [];
}
export async function findOne<T = Record<string, unknown>>(cfg: HulyCfg, _class: string, query: Record<string, unknown>): Promise<T | null> {
  return (await findAll<T>(cfg, _class, query, { limit: 1 }))[0] ?? null;
}

let accountCache: { ws: string; socialId: string; uuid: string } | null = null;
async function account(cfg: HulyCfg): Promise<{ socialId: string; uuid: string }> {
  if (accountCache?.ws === cfg.ws) return accountCache;
  const a = (await rest(cfg, `/account/${cfg.ws}`)) as { uuid: string; primarySocialId: string };
  accountCache = { ws: cfg.ws, socialId: a.primarySocialId, uuid: a.uuid };
  return accountCache;
}

async function tx(cfg: HulyCfg, t: Record<string, unknown>): Promise<void> {
  const r = (await rest(cfg, `/tx/${cfg.ws}`, { method: "POST", body: JSON.stringify(t) })) as { error?: unknown };
  if (r && typeof r === "object" && "error" in r && r.error) throw new HttpError(502, `Huly tx: ${JSON.stringify(r.error).slice(0, 200)}`);
}
const base = async (cfg: HulyCfg, _class: string) => {
  const { socialId } = await account(cfg);
  return { _id: hulyId(), _class, space: "core:space:Tx", modifiedBy: socialId, modifiedOn: Date.now() };
};

export async function createDoc(cfg: HulyCfg, _class: string, space: string, attributes: Record<string, unknown>, id = hulyId()): Promise<string> {
  const b = await base(cfg, "core:class:TxCreateDoc");
  await tx(cfg, { ...b, objectId: id, objectClass: _class, objectSpace: space, createdBy: b.modifiedBy, attributes });
  return id;
}
/** A doc that lives in a parent's collection (issues under tracker:ids:NoParent, comments under an issue). */
export async function addCollection(cfg: HulyCfg, _class: string, space: string, attachedTo: string, attachedToClass: string, collection: string, attributes: Record<string, unknown>, id = hulyId()): Promise<string> {
  const b = await base(cfg, "core:class:TxCreateDoc");
  await tx(cfg, { ...b, objectId: id, objectClass: _class, objectSpace: space, createdBy: b.modifiedBy, collection, attachedTo, attachedToClass, attributes: { ...attributes, attachedTo, attachedToClass, collection } });
  return id;
}
export async function updateDoc(cfg: HulyCfg, _class: string, space: string, objectId: string, operations: Record<string, unknown>, col?: { attachedTo: string; attachedToClass: string; collection: string }): Promise<void> {
  const b = await base(cfg, "core:class:TxUpdateDoc");
  await tx(cfg, { ...b, objectId, objectClass: _class, objectSpace: space, operations, retrieve: false, ...(col ?? {}) });
}
export async function mixin(cfg: HulyCfg, objectId: string, objectClass: string, objectSpace: string, mixinClass: string, attributes: Record<string, unknown>): Promise<void> {
  const b = await base(cfg, "core:class:TxMixin");
  await tx(cfg, { ...b, objectId, objectClass, objectSpace, mixin: mixinClass, attributes });
}

// ---------- collaborator (collaborative markup: issue descriptions, documents) ----------

async function collabRpc(cfg: HulyCfg, objectClass: string, objectId: string, objectAttr: string, method: string, payload: Record<string, unknown>): Promise<{ content?: Record<string, string> }> {
  const docId = encodeURIComponent([cfg.ws, objectClass, objectId, objectAttr].join("|"));
  const res = await fetch(`${cfg.url}/_collaborator/rpc/${docId}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ method, payload }) });
  if (!res.ok) throw new HttpError(502, `Huly collaborator ${res.status} (${method})`);
  const r = (await res.json()) as { error?: unknown; content?: Record<string, string> };
  if (r.error) throw new HttpError(502, `Huly collaborator: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r;
}
/** Markup JSON string for a collaborative attribute; "" when the ref is empty. */
export async function getMarkup(cfg: HulyCfg, objectClass: string, objectId: string, attr: string, ref: unknown): Promise<string> {
  if (typeof ref !== "string" || !ref) return "";
  const r = await collabRpc(cfg, objectClass, objectId, attr, "getContent", { source: ref });
  return r.content?.[attr] ?? "";
}
/** Store markup for a collaborative attribute; returns the blob ref to put on the record. */
export async function createMarkup(cfg: HulyCfg, objectClass: string, objectId: string, attr: string, markup: string): Promise<string> {
  const r = await collabRpc(cfg, objectClass, objectId, attr, "createContent", { content: { [attr]: markup } });
  const ref = r.content?.[attr];
  if (!ref) throw new HttpError(502, "Huly collaborator returned no content ref");
  return ref;
}

// ---------- markup ⇄ markdown ----------

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] };

const esc = (s: string) => s.replace(/([*_`\\])/g, "\\$1");
function inlineMd(nodes: Node[] | undefined): string {
  let out = "";
  for (const n of nodes ?? []) {
    if (n.type === "hardBreak") { out += "  \n"; continue; }
    if (n.type !== "text") { out += inlineMd(n.content); continue; }
    let t = n.text ?? "";
    const marks = n.marks ?? [];
    const has = (m: string) => marks.some((x) => x.type === m);
    if (has("code")) t = `\`${t}\``;
    else {
      if (has("bold")) t = `**${t}**`;
      if (has("italic")) t = `*${t}*`;
      if (has("strike")) t = `~~${t}~~`;
    }
    const link = marks.find((x) => x.type === "link");
    if (link?.attrs?.href) t = `[${t}](${String(link.attrs.href)})`;
    out += t;
  }
  return out;
}
function blockMd(n: Node, depth = 0): string {
  const pad = "  ".repeat(depth);
  switch (n.type) {
    case "doc": return (n.content ?? []).map((c) => blockMd(c, depth)).join("\n\n");
    case "paragraph": return pad + inlineMd(n.content);
    case "heading": return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${inlineMd(n.content)}`;
    case "bulletList": case "orderedList": {
      const ordered = n.type === "orderedList";
      return (n.content ?? []).map((li, i) => {
        const parts = (li.content ?? []).map((c, j) => (j === 0 ? `${pad}${ordered ? `${i + 1}.` : "-"} ${blockMd(c, 0).trimStart()}` : blockMd(c, depth + 1)));
        return parts.join("\n");
      }).join("\n");
    }
    case "listItem": return (n.content ?? []).map((c) => blockMd(c, depth)).join("\n");
    case "blockquote": return (n.content ?? []).map((c) => blockMd(c, depth)).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n");
    case "codeBlock": return `\`\`\`${String(n.attrs?.language ?? "")}\n${(n.content ?? []).map((c) => c.text ?? "").join("")}\n\`\`\``;
    case "horizontalRule": return "* * *";
    case "image": return `![](${String(n.attrs?.src ?? "")})`;
    case "table": return (n.content ?? []).map((row) => "| " + (row.content ?? []).map((cell) => inlineMd(cell.content?.[0]?.content)).join(" | ") + " |").join("\n");
    default: return n.content ? (n.content.map((c) => blockMd(c, depth)).join("\n\n")) : inlineMd([n]);
  }
}
export function markupToMarkdown(markup: string): string {
  if (!markup) return "";
  try { return blockMd(JSON.parse(markup) as Node).replace(/\n{3,}/g, "\n\n").trim(); } catch { return markup; }
}

function inlineNodes(s: string): Node[] {
  const out: Node[] = [];
  // Tokens: `code`, **bold**, *italic*, [text](url), bare URLs. Everything else is text.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>)\]]+)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ type: "text", text: unesc(s.slice(last, m.index)) });
    if (m[1]) out.push({ type: "text", text: m[1].slice(1, -1), marks: [{ type: "code" }] });
    else if (m[2]) out.push({ type: "text", text: unesc(m[2].slice(2, -2)), marks: [{ type: "bold" }] });
    else if (m[3]) out.push({ type: "text", text: unesc(m[3].slice(1, -1)), marks: [{ type: "italic" }] });
    else if (m[4]) out.push({ type: "text", text: unesc(m[4].slice(1, m[4].indexOf("](")) ), marks: [{ type: "link", attrs: { href: m[5], target: "_blank" } }] });
    else if (m[6]) out.push({ type: "text", text: m[6], marks: [{ type: "link", attrs: { href: m[6], target: "_blank" } }] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ type: "text", text: unesc(s.slice(last)) });
  return out.filter((n) => n.text !== "");
}
const unesc = (s: string) => s.replace(/\\([*_`\\\[\]()#>-])/g, "$1");
const para = (s: string): Node => ({ type: "paragraph", content: inlineNodes(s) });

/** Markdown → Huly markup JSON (headings, paragraphs, bullet/numbered lists, quotes, code fences, rules, inline marks). */
export function markdownToMarkup(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const doc: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      doc.push({ type: "codeBlock", attrs: { language: fence[1] || null }, content: [{ type: "text", text: buf.join("\n") }] });
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { doc.push({ type: "heading", attrs: { level: h[1].length }, content: inlineNodes(h[2].trim()) }); i++; continue; }
    if (/^(\*\s*\*\s*\*|-{3,}|_{3,})\s*$/.test(l)) { doc.push({ type: "horizontalRule" }); i++; continue; }
    if (/^>\s?/.test(l)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      doc.push({ type: "blockquote", content: [para(buf.join(" "))] });
      continue;
    }
    const li = l.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: Node[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        const text: string[] = [m[3]]; i++;
        // continuation lines indented under the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) text.push(lines[i++].trim());
        items.push({ type: "listItem", content: [para(text.join(" "))] });
      }
      doc.push({ type: ordered ? "orderedList" : "bulletList", attrs: ordered ? { start: 1 } : undefined, content: items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*•]|\d+[.)])\s+|(\*\s*\*\s*\*|-{3,})\s*$)/.test(lines[i])) buf.push(lines[i++]);
    const content: Node[] = [];
    buf.forEach((b, j) => { if (j) content.push({ type: "hardBreak" }); content.push(...inlineNodes(b.replace(/\s{2,}$/, ""))); });
    doc.push({ type: "paragraph", content });
  }
  return JSON.stringify({ type: "doc", content: doc });
}
export const plainToMarkup = (text: string) => markdownToMarkup(text.replace(/([*_`])/g, "\\$1"));
void esc;

// ---------- project context ----------

export interface Project { id: string; identifier: string; name: string; sequence: number; defaultStatus: string; taskTypeId: string; mixin: string; statusById: Record<string, string>; statusByName: Record<string, string>; enums: Record<string, string[]> }
let projectCache: { at: number; key: string; p: Project } | null = null;
export async function project(cfg: HulyCfg): Promise<Project> {
  const key = `${cfg.ws}/${cfg.project}`;
  if (projectCache && projectCache.key === key && Date.now() - projectCache.at < 600_000) return projectCache.p;
  const pr = await findOne<{ _id: string; identifier: string; name: string; sequence?: number; type: string; defaultIssueStatus?: string }>(cfg, "tracker:class:Project", { identifier: cfg.project });
  if (!pr) throw new HttpError(503, `Huly project ${cfg.project} not found`);
  const type = await findOne<{ tasks: string[]; statuses: { _id: string }[] }>(cfg, "task:class:ProjectType", { _id: pr.type });
  if (!type) throw new HttpError(503, "Huly project type not found");
  const taskTypeId = type.tasks[0];
  const mixinCls = `${taskTypeId}:type:mixin`;
  const statuses = await findAll<{ _id: string; name: string }>(cfg, "tracker:class:IssueStatus", { _id: { $in: type.statuses.map((s) => s._id) } });
  const attrs = await findAll<{ name: string; type?: { _class?: string; of?: string } }>(cfg, "core:class:Attribute", { attributeOf: mixinCls });
  const enums: Record<string, string[]> = {};
  for (const a of attrs) if (a.type?._class === "core:class:EnumOf" && a.type.of) enums[a.name] = (await findOne<{ enumValues: string[] }>(cfg, "core:class:Enum", { _id: a.type.of }))?.enumValues ?? [];
  const p: Project = {
    id: pr._id, identifier: pr.identifier, name: pr.name, sequence: pr.sequence ?? 0, defaultStatus: pr.defaultIssueStatus ?? statuses[0]._id, taskTypeId, mixin: mixinCls,
    statusById: Object.fromEntries(statuses.map((s) => [s._id, s.name])), statusByName: Object.fromEntries(statuses.map((s) => [s.name.toLowerCase(), s._id])), enums,
  };
  projectCache = { at: Date.now(), key, p };
  return p;
}
export const forgetProject = () => { projectCache = null; };

/** The enum option matching a value (case-insensitive), or undefined when the option doesn't exist. */
export const enumValue = (p: Project, field: string, v: string | null | undefined) => (v ? p.enums[field]?.find((x) => x.toLowerCase() === v.trim().toLowerCase()) : undefined);

// ---------- issues ⇄ Task ----------

export interface HulyIssue {
  _id: string; identifier: string; title: string; status: string; priority?: number; number: number; description?: unknown; space: string;
  attachedTo: string; attachedToClass: string; collection: string; createdOn?: number; modifiedOn: number; [k: string]: unknown;
}
export const issueUrl = (cfg: HulyCfg, identifier: string) => `${cfg.url}/workbench/${cfg.wsUrl}/tracker/${identifier}`;

/** Task view of an issue. `description` comes from the collaborator (passed in; "" when not fetched). */
export function toTask(cfg: HulyCfg, p: Project, i: HulyIssue, description: string): Task {
  const f = (i[p.mixin] as Record<string, unknown> | undefined) ?? {};
  const s = (k: string) => (typeof f[k] === "string" && (f[k] as string).trim() ? (f[k] as string).trim() : null);
  return {
    id: i._id, name: i.title, status: p.statusById[i.status] ?? "not started", parentId: null,
    appliedBy: s("appliedBy"), platform: s("platformApplied"),
    appliedOn: typeof f.appliedOn === "number" ? new Date(f.appliedOn).toISOString().slice(0, 10) : null,
    nextAction: s("nextAction"), priority: i.priority ? PRIORITIES[i.priority] ?? null : null, tags: [],
    url: issueUrl(cfg, i.identifier), description, createdAt: new Date(i.createdOn ?? i.modifiedOn).toISOString(), updatedAt: new Date(i.modifiedOn).toISOString(),
    identifier: i.identifier, clickupId: s("clickupId"), modifiedOn: i.modifiedOn,
  };
}

export async function listIssues(cfg: HulyCfg, p: Project): Promise<HulyIssue[]> {
  return findAll<HulyIssue>(cfg, "tracker:class:Issue", { space: p.id }, { limit: 5000 });
}
export async function getIssue(cfg: HulyCfg, p: Project, id: string): Promise<HulyIssue> {
  const byId = await findOne<HulyIssue>(cfg, "tracker:class:Issue", { _id: id, space: p.id });
  // The REST find-all drops `_id` from a document matched by `_id`; put it back, everything downstream keys on it.
  const i = byId ? { ...byId, _id: byId._id ?? id } : await findOne<HulyIssue>(cfg, "tracker:class:Issue", { identifier: id.toUpperCase(), space: p.id });
  if (!i) throw new HttpError(404, `no issue ${id}`);
  return i;
}
export async function issueDescription(cfg: HulyCfg, i: HulyIssue): Promise<string> {
  return markupToMarkdown(await getMarkup(cfg, "tracker:class:Issue", i._id, "description", i.description).catch(() => ""));
}

export async function createIssue(cfg: HulyCfg, p: Project, a: { title: string; description: string; status: string; priority?: string; fields: Record<string, unknown> }): Promise<HulyIssue> {
  const fresh = await findOne<{ sequence?: number }>(cfg, "tracker:class:Project", { _id: p.id });
  const number = (fresh?.sequence ?? p.sequence) + 1;
  const id = hulyId();
  const description = a.description.trim() ? await createMarkup(cfg, "tracker:class:Issue", id, "description", markdownToMarkup(a.description)) : null;
  const rank = `0|${(0x3b9ac9ff + number * 4096).toString(36).padStart(6, "0")}:`;
  await addCollection(cfg, "tracker:class:Issue", p.id, "tracker:ids:NoParent", "tracker:class:Issue", "subIssues", {
    title: a.title.slice(0, 300), description, status: p.statusByName[a.status.toLowerCase()] ?? p.defaultStatus, priority: Math.max(0, PRIORITIES.indexOf(a.priority ?? "none")),
    number, identifier: `${p.identifier}-${number}`, kind: p.taskTypeId, rank, assignee: null, component: null, milestone: null, dueDate: null,
    estimation: 0, remainingTime: 0, reportedTime: 0, reports: 0, subIssues: 0, parents: [], childInfo: [], comments: 0, attachments: 0, labels: 0,
  }, id);
  await updateDoc(cfg, "tracker:class:Project", SPACE, p.id, { sequence: number });
  const fields = Object.fromEntries(Object.entries(a.fields).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (Object.keys(fields).length) await mixin(cfg, id, "tracker:class:Issue", p.id, p.mixin, fields);
  return getIssue(cfg, p, id);
}
export async function updateIssue(cfg: HulyCfg, p: Project, i: HulyIssue, ops: Record<string, unknown>): Promise<void> {
  if (!Object.keys(ops).length) return;
  await updateDoc(cfg, "tracker:class:Issue", p.id, i._id, ops, { attachedTo: i.attachedTo, attachedToClass: i.attachedToClass, collection: i.collection });
}
export async function setFields(cfg: HulyCfg, p: Project, i: HulyIssue, fields: Record<string, unknown>): Promise<void> {
  if (!Object.keys(fields).length) return;
  await mixin(cfg, i._id, "tracker:class:Issue", p.id, p.mixin, fields);
}
export async function addIssueComment(cfg: HulyCfg, p: Project, i: HulyIssue, markdown: string): Promise<string> {
  return addCollection(cfg, "chunter:class:ChatMessage", p.id, i._id, "tracker:class:Issue", "comments", { message: markdownToMarkup(markdown), attachments: 0 });
}

// ---------- documents (playbook) ----------

export interface HulyDoc { _id: string; title: string; space: string; content?: unknown; rank?: string; modifiedOn: number }
export async function listDocs(cfg: HulyCfg): Promise<HulyDoc[]> {
  const ts = await findOne<{ _id: string }>(cfg, "document:class:Teamspace", { name: cfg.teamspace });
  if (!ts) return [];
  const docs = await findAll<HulyDoc>(cfg, "document:class:Document", { space: ts._id });
  return docs.sort((a, b) => (a.rank ?? "").localeCompare(b.rank ?? ""));
}
export async function findDoc(cfg: HulyCfg, ref: string): Promise<HulyDoc | null> {
  const docs = await listDocs(cfg);
  return docs.find((d) => d._id === ref) ?? docs.find((d) => d.title === ref) ?? docs.find((d) => d.title.toLowerCase().includes(ref.toLowerCase())) ?? null;
}
export async function docMarkdown(cfg: HulyCfg, d: HulyDoc): Promise<string> {
  return markupToMarkdown(await getMarkup(cfg, "document:class:Document", d._id, "content", d.content));
}
export async function setDocMarkdown(cfg: HulyCfg, d: HulyDoc, markdown: string): Promise<void> {
  const content = await createMarkup(cfg, "document:class:Document", d._id, "content", markdownToMarkup(markdown));
  await updateDoc(cfg, "document:class:Document", d.space, d._id, { content });
}
