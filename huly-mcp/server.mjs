#!/usr/bin/env node
// Huly MCP server for Job Agent Hub: the Job Hunter project (applications as issues with ClickUp-identical
// statuses and fields), comments, and the playbook teamspace documents. stdio transport.
//
// Env: HULY_URL (https://projects.kaizenapps.com), HULY_WORKSPACE (kaizengroup), and HULY_TOKEN or
// HULY_TOKEN_FILE (path to a file holding the workspace token). Optional HULY_PROJECT (default JOB).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import api from "@hcengineering/api-client";
import core from "@hcengineering/core";
import textMd from "@hcengineering/text-markdown";
import text from "@hcengineering/text";

// stdout is the MCP channel: everything the platform client prints must go to stderr.
console.log = (...a) => console.error(...a);
console.info = console.log;
console.warn = console.log;
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { href: process.env.HULY_URL ?? "" }, document: {} };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
globalThis.navigator ??= { onLine: true };

const { connect, NodeWebSocketFactory } = api;
const upload = (c, cls, id, attr, md) => c.uploadMarkup(cls, id, attr, md, "markdown"); // api-client 0.7.423 never awaits a markup-content upload, so refs are uploaded by hand
const { generateId } = core;
const { markdownToMarkup, markupToMarkdown } = textMd;
const { jsonToMarkup, markupToJSON } = text;

const URL = process.env.HULY_URL ?? "https://projects.kaizenapps.com";
const WORKSPACE = process.env.HULY_WORKSPACE ?? "kaizengroup";
const PROJECT = process.env.HULY_PROJECT ?? "JOB";
const token = (process.env.HULY_TOKEN ?? (process.env.HULY_TOKEN_FILE ? readFileSync(process.env.HULY_TOKEN_FILE, "utf8") : "")).trim();
if (!token) { console.error("huly-mcp: set HULY_TOKEN or HULY_TOKEN_FILE"); process.exit(2); }

const SPACE = "core:space:Space";
const PRIORITY = ["none", "urgent", "high", "medium", "low"];
const rank = (n) => `0|${(0x3b9ac9ff + n * 4096).toString(36).padStart(6, "0")}:`;

let clientP = null;
const client = () => {
  if (clientP === null) {
    clientP = connect(URL, { token, workspace: WORKSPACE, socketFactory: NodeWebSocketFactory, connectionTimeout: 30000 })
      .catch((error) => {
        clientP = null;
        throw error;
      });
  }
  return clientP;
};

/** Project + its type, task type, status map and custom-field definitions (cached per process). */
const ctxCache = new Map();
async function ctx(identifier = PROJECT) {
  if (ctxCache.has(identifier)) return ctxCache.get(identifier);
  const c = await client();
  const project = await c.findOne("tracker:class:Project", { identifier });
  if (!project) throw new Error(`no project with identifier ${identifier}`);
  const type = await c.findOne("task:class:ProjectType", { _id: project.type });
  const taskTypeId = type.tasks[0];
  const mixin = `${taskTypeId}:type:mixin`;
  const statuses = await c.findAll("tracker:class:IssueStatus", { _id: { $in: type.statuses.map((s) => s._id) } });
  const statusById = Object.fromEntries(statuses.map((s) => [s._id, s.name]));
  const statusByName = Object.fromEntries(statuses.map((s) => [s.name.toLowerCase(), s._id]));
  const attrs = await c.findAll("core:class:Attribute", { attributeOf: mixin });
  const fields = {};
  for (const a of attrs) {
    const label = String(a.label ?? "").replace(/^embedded:embedded:/, "");
    const f = { name: a.name, label, kind: a.type?._class?.replace(/^core:class:/, "") ?? "unknown" };
    if (a.type?._class === "core:class:EnumOf") f.values = (await c.findOne("core:class:Enum", { _id: a.type.of }))?.enumValues ?? [];
    fields[a.name] = f;
  }
  const out = { c, project, type, taskTypeId, mixin, statusById, statusByName, fields };
  ctxCache.set(identifier, out);
  return out;
}

function coerceFields(k, input) {
  const out = {};
  for (const [name, raw] of Object.entries(input ?? {})) {
    const f = k.fields[name] ?? Object.values(k.fields).find((x) => x.label.toLowerCase() === name.toLowerCase());
    if (!f) throw new Error(`unknown field "${name}"; known: ${Object.keys(k.fields).join(", ")}`);
    if (raw === null || raw === "") { out[f.name] = null; continue; }
    if (f.kind === "EnumOf") {
      const v = f.values.find((x) => x === raw) ?? f.values.find((x) => x.toLowerCase() === String(raw).toLowerCase());
      if (!v) throw new Error(`"${raw}" is not an option for ${f.label}; options: ${f.values.join(", ")}`);
      out[f.name] = v;
    } else if (f.kind === "TypeDate") out[f.name] = typeof raw === "number" ? raw : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? `${raw}T12:00:00Z` : String(raw));
    else if (f.kind === "TypeNumber") out[f.name] = Number(raw);
    else out[f.name] = String(raw);
  }
  return out;
}

function presentIssue(k, i) {
  const fx = i[k.mixin] ?? {};
  const fields = {};
  for (const [name, f] of Object.entries(k.fields)) if (fx[name] !== undefined && fx[name] !== null) fields[f.label] = f.kind === "TypeDate" ? new Date(fx[name]).toISOString().slice(0, 10) : fx[name];
  return { id: i._id, identifier: i.identifier, title: i.title, status: k.statusById[i.status] ?? i.status, priority: PRIORITY[i.priority] ?? i.priority, fields, modifiedOn: new Date(i.modifiedOn).toISOString(), url: `${URL}/workbench/${WORKSPACE}/tracker/${i.identifier}` };
}

async function findIssue(k, identifier) {
  const i = await k.c.findOne("tracker:class:Issue", { space: k.project._id, identifier: identifier.toUpperCase() });
  if (!i) throw new Error(`no issue ${identifier} in ${k.project.identifier}`);
  return i;
}
const mdFromMarkup = (m) => { try { return markupToMarkdown(markupToJSON(m)); } catch { return String(m ?? ""); } };
const toMarkup = (md) => jsonToMarkup(markdownToMarkup(md));

const server = new McpServer({ name: "huly-job-hunter", version: "0.1.0" });
const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return { content: [{ type: "text", text: `error: ${e?.message ?? e}` }], isError: true }; } };

server.tool("huly_list_projects", "List the tracker projects in the workspace with their identifier and status set.", {}, wrap(async () => {
  const c = await client();
  const ps = await c.findAll("tracker:class:Project", {});
  const out = [];
  for (const p of ps) {
    const t = await c.findOne("task:class:ProjectType", { _id: p.type });
    const st = t ? await c.findAll("tracker:class:IssueStatus", { _id: { $in: t.statuses.map((s) => s._id) } }) : [];
    out.push({ identifier: p.identifier, name: p.name, type: t?.name, statuses: st.map((s) => s.name) });
  }
  return out;
}));

server.tool("huly_project_schema", "Statuses and custom fields (with enum options) of a project — read this once before creating or updating issues.", { project: z.string().optional() }, wrap(async ({ project }) => {
  const k = await ctx(project);
  return { project: k.project.identifier, statuses: Object.values(k.statusById), fields: Object.values(k.fields) };
}));

server.tool("huly_list_issues", "List issues (applications). Filter by status name and/or a case-insensitive title substring; newest first.", {
  project: z.string().optional(), status: z.string().optional(), search: z.string().optional(), limit: z.number().int().min(1).max(500).optional(),
}, wrap(async ({ project, status, search, limit }) => {
  const k = await ctx(project);
  const q = { space: k.project._id };
  if (status) { const s = k.statusByName[status.toLowerCase()]; if (!s) throw new Error(`unknown status "${status}"; known: ${Object.values(k.statusById).join(", ")}`); q.status = s; }
  if (search) q.title = { $like: `%${search}%` };
  const rows = await k.c.findAll("tracker:class:Issue", q, { limit: limit ?? 50, sort: { modifiedOn: -1 } });
  return rows.map((i) => presentIssue(k, i));
}));

server.tool("huly_get_issue", "One issue with its description (markdown), fields and comments.", { identifier: z.string(), project: z.string().optional() }, wrap(async ({ identifier, project }) => {
  const k = await ctx(project);
  const i = await findIssue(k, identifier);
  const description = i.description ? await k.c.fetchMarkup("tracker:class:Issue", i._id, "description", i.description, "markdown").catch(() => "") : "";
  const comments = await k.c.findAll("chunter:class:ChatMessage", { attachedTo: i._id }, { sort: { createdOn: 1 } });
  return { ...presentIssue(k, i), description, comments: comments.map((m) => ({ at: new Date(m.createdOn).toISOString(), text: mdFromMarkup(m.message) })) };
}));

server.tool("huly_create_issue", "Create an application issue. description is markdown; fields are label→value (see huly_project_schema).", {
  title: z.string(), description: z.string().optional(), status: z.string().optional(), priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional(),
  fields: z.record(z.any()).optional(), project: z.string().optional(),
}, wrap(async ({ title, description, status, priority, fields, project }) => {
  const k = await ctx(project);
  const statusId = status ? k.statusByName[status.toLowerCase()] : k.project.defaultIssueStatus ?? Object.keys(k.statusById)[0];
  if (!statusId) throw new Error(`unknown status "${status}"`);
  const fresh = await k.c.findOne("tracker:class:Project", { _id: k.project._id });
  const number = (fresh.sequence ?? 0) + 1;
  const id = generateId();
  const descRef = description ? await upload(k.c, "tracker:class:Issue", id, "description", description) : null;
  await k.c.addCollection("tracker:class:Issue", k.project._id, "tracker:ids:NoParent", "tracker:class:Issue", "subIssues", {
    title: title.slice(0, 300), description: descRef, status: statusId, priority: PRIORITY.indexOf(priority ?? "none"),
    number, identifier: `${k.project.identifier}-${number}`, kind: k.taskTypeId, rank: rank(number),
    assignee: null, component: null, milestone: null, dueDate: null, estimation: 0, remainingTime: 0, reportedTime: 0, reports: 0,
    subIssues: 0, parents: [], childInfo: [], comments: 0, attachments: 0, labels: 0,
  }, id);
  await k.c.updateDoc("tracker:class:Project", SPACE, k.project._id, { sequence: number });
  const fx = coerceFields(k, fields);
  if (Object.keys(fx).length) await k.c.createMixin(id, "tracker:class:Issue", k.project._id, k.mixin, fx);
  return presentIssue(k, await k.c.findOne("tracker:class:Issue", { _id: id }));
}));

server.tool("huly_update_issue", "Update title, status, priority, description (markdown, replaces) and/or fields (label→value; null clears) of an issue.", {
  identifier: z.string(), title: z.string().optional(), status: z.string().optional(), priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional(),
  description: z.string().optional(), fields: z.record(z.any()).optional(), project: z.string().optional(),
}, wrap(async ({ identifier, title, status, priority, description, fields, project }) => {
  const k = await ctx(project);
  const i = await findIssue(k, identifier);
  const ops = {};
  if (title) ops.title = title.slice(0, 300);
  if (status) { const s = k.statusByName[status.toLowerCase()]; if (!s) throw new Error(`unknown status "${status}"; known: ${Object.values(k.statusById).join(", ")}`); ops.status = s; }
  if (priority) ops.priority = PRIORITY.indexOf(priority);
  if (description !== undefined) ops.description = await upload(k.c, "tracker:class:Issue", i._id, "description", description);
  if (Object.keys(ops).length) await k.c.updateCollection("tracker:class:Issue", k.project._id, i._id, i.attachedTo, i.attachedToClass, i.collection, ops);
  const fx = coerceFields(k, fields);
  if (Object.keys(fx).length) {
    if (i[k.mixin]) await k.c.updateMixin(i._id, "tracker:class:Issue", k.project._id, k.mixin, fx);
    else await k.c.createMixin(i._id, "tracker:class:Issue", k.project._id, k.mixin, fx);
  }
  return presentIssue(k, await k.c.findOne("tracker:class:Issue", { _id: i._id }));
}));

server.tool("huly_add_comment", "Add a comment (markdown) to an issue — use for application history, attempt logs, replies.", { identifier: z.string(), markdown: z.string(), project: z.string().optional() }, wrap(async ({ identifier, markdown, project }) => {
  const k = await ctx(project);
  const i = await findIssue(k, identifier);
  const id = await k.c.addCollection("chunter:class:ChatMessage", k.project._id, i._id, "tracker:class:Issue", "comments", { message: toMarkup(markdown), attachments: 0 });
  return { ok: true, id, identifier: i.identifier };
}));

server.tool("huly_list_documents", "List playbook documents (teamspace name optional; default: all teamspaces).", { teamspace: z.string().optional() }, wrap(async ({ teamspace }) => {
  const c = await client();
  const spaces = await c.findAll("document:class:Teamspace", teamspace ? { name: teamspace } : {});
  const docs = await c.findAll("document:class:Document", { space: { $in: spaces.map((s) => s._id) } }, { sort: { rank: 1 } });
  const byId = Object.fromEntries(spaces.map((s) => [s._id, s.name]));
  return docs.map((d) => ({ id: d._id, title: d.title, teamspace: byId[d.space], modifiedOn: new Date(d.modifiedOn).toISOString() }));
}));

async function findDoc(c, ref) {
  return (await c.findOne("document:class:Document", { _id: ref })) ?? (await c.findOne("document:class:Document", { title: ref })) ?? (await c.findOne("document:class:Document", { title: { $like: `%${ref}%` } }));
}
server.tool("huly_get_document", "Read a document (by id or title) as markdown.", { ref: z.string() }, wrap(async ({ ref }) => {
  const c = await client();
  const d = await findDoc(c, ref);
  if (!d) throw new Error(`no document matching "${ref}"`);
  const markdown = d.content ? await c.fetchMarkup("document:class:Document", d._id, "content", d.content, "markdown") : "";
  return { id: d._id, title: d.title, markdown };
}));

server.tool("huly_append_document", "Append markdown to the end of a document (by id or title). Use for playbook updates and logs.", { ref: z.string(), markdown: z.string() }, wrap(async ({ ref, markdown }) => {
  const c = await client();
  const d = await findDoc(c, ref);
  if (!d) throw new Error(`no document matching "${ref}"`);
  const current = d.content ? await c.fetchMarkup("document:class:Document", d._id, "content", d.content, "markdown") : "";
  const next = `${current.replace(/\s+$/, "")}\n\n${markdown.trim()}\n`;
  await c.updateDoc("document:class:Document", d.space, d._id, { content: await upload(c, "document:class:Document", d._id, "content", next) });
  return { ok: true, id: d._id, title: d.title, chars: next.length };
}));

server.tool("huly_replace_in_document", "Exact in-place edit of a document: each `find` must occur exactly once or nothing is written (same contract as the ClickUp playbook patch).", {
  ref: z.string(), edits: z.array(z.object({ find: z.string(), replace: z.string() })).min(1), dry: z.boolean().optional(),
}, wrap(async ({ ref, edits, dry }) => {
  const c = await client();
  const d = await findDoc(c, ref);
  if (!d) throw new Error(`no document matching "${ref}"`);
  let content = d.content ? await c.fetchMarkup("document:class:Document", d._id, "content", d.content, "markdown") : "";
  const report = edits.map((e) => ({ find: e.find.slice(0, 70), matches: content.split(e.find).length - 1 }));
  if (dry || report.some((r) => r.matches !== 1)) return { applied: false, report };
  for (const e of edits) content = content.replace(e.find, () => e.replace);
  await c.updateDoc("document:class:Document", d.space, d._id, { content: await upload(c, "document:class:Document", d._id, "content", content) });
  return { applied: true, report, chars: content.length };
}));

server.tool("huly_create_document", "Create a document in a teamspace (by name) from markdown.", { teamspace: z.string(), title: z.string(), markdown: z.string() }, wrap(async ({ teamspace, title, markdown }) => {
  const c = await client();
  const s = await c.findOne("document:class:Teamspace", { name: teamspace });
  if (!s) throw new Error(`no teamspace "${teamspace}"`);
  const n = (await c.findAll("document:class:Document", { space: s._id })).length + 1;
  const id = generateId();
  const content = await upload(c, "document:class:Document", id, "content", markdown);
  await c.createDoc("document:class:Document", s._id, { title, parent: "document:ids:NoParent", rank: rank(n), content }, id);
  return { ok: true, id, title };
}));

await server.connect(new StdioServerTransport());
console.error(`huly-mcp ready: ${URL} / ${WORKSPACE} / project ${PROJECT}`);
