// Stage 2: every ClickUp task from the hub's mirror becomes a JOB issue with the same status and fields.
import api from "@hcengineering/api-client";
import core from "@hcengineering/core";
import { readFileSync } from "node:fs";
const { connect, NodeWebSocketFactory } = api;
const upload = (c, cls, id, attr, md) => c.uploadMarkup(cls, id, attr, md, "markdown"); // api-client 0.7.423 never awaits a markup-content upload, so refs are uploaded by hand
const { generateId } = core;
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { href: "https://projects.kaizenapps.com" }, document: {} };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
globalThis.navigator ??= { onLine: true };

const token = readFileSync("C:/Users/prestonzen/dev/job-agent-hub/.huly-token.local.txt", "utf8").trim();
const HERE = ".";
const rows = JSON.parse(readFileSync(`${HERE}/clickup-tasks.json`, "utf8"))[0].results.map((r) => JSON.parse(r.json));
const OLD_PARENT = "868mehfh7"; // the retired container task; its subtasks are imported flat

const client = await connect("https://projects.kaizenapps.com", { token, workspace: "kaizengroup", socketFactory: NodeWebSocketFactory, connectionTimeout: 30000 });
const project = await client.findOne("tracker:class:Project", { identifier: "JOB" });
const type = await client.findOne("task:class:ProjectType", { _id: project.type });
const taskTypeId = type.tasks[0];
const taskMixin = `${taskTypeId}:type:mixin`;
const statusByName = {};
for (const s of await client.findAll("tracker:class:IssueStatus", { _id: { $in: type.statuses.map((x) => x._id) } })) statusByName[s.name] = s._id;
const enums = {};
for (const a of await client.findAll("core:class:Attribute", { attributeOf: taskMixin })) if (a.type?._class === "core:class:EnumOf") enums[a.name] = (await client.findOne("core:class:Enum", { _id: a.type.of }))?.enumValues ?? [];

const existing = await client.findAll("tracker:class:Issue", { space: project._id });
const have = new Set(existing.map((i) => i[taskMixin]?.clickupId).filter(Boolean));
let number = existing.reduce((m, i) => Math.max(m, i.number ?? 0), 0);
console.log(`project ${project.identifier}: ${existing.length} issues already, next number ${number + 1}; importing ${rows.length} ClickUp tasks`);

const PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };
const rank = (n) => `0|${(0x3b9ac9ff + n * 4096).toString(36).padStart(6, "0")}:`;
const enumVal = (name, v) => (v && enums[name]?.includes(v) ? v : v && enums[name]?.find((e) => e.toLowerCase() === String(v).toLowerCase())) || undefined;
const strip = (v) => (v == null || v === "None" || v === "" ? undefined : v);

let created = 0, skipped = 0, failed = 0;
for (const t of rows.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))) {
  if (t.id === OLD_PARENT || have.has(t.id)) { skipped++; continue; }
  try {
    const desc = (t.description ?? "").replace(/\r/g, "");
    const payM = desc.match(/\bPay:\s*([^|\n]+)/i);
    const urlM = desc.match(/^Apply:\s*\[?(https?:\/\/[^\s\])]+)/im) ?? desc.match(/https?:\/\/[^\s\])]+/);
    const appliedOn = strip(t.appliedOn) ? Date.parse(`${t.appliedOn}T12:00:00Z`) : undefined;
    const status = statusByName[(t.status ?? "").toLowerCase()] ?? statusByName["not started"];
    number++;
    const id = generateId();
    const body = `${desc.trim()}\n\n---\nImported from ClickUp ${t.url} on ${new Date().toISOString().slice(0, 10)}${t.parentId && t.parentId !== "None" ? ` (was a subtask of ${t.parentId})` : ""}.`;
    const description = await upload(client, "tracker:class:Issue", id, "description", body);
    await client.addCollection("tracker:class:Issue", project._id, "tracker:ids:NoParent", "tracker:class:Issue", "subIssues", {
      title: t.name.slice(0, 300), description, status, priority: PRIORITY[String(t.priority ?? "").toLowerCase()] ?? 0,
      number, identifier: `${project.identifier}-${number}`, kind: taskTypeId, rank: rank(number),
      assignee: null, component: null, milestone: null, dueDate: null, estimation: 0, remainingTime: 0, reportedTime: 0, reports: 0,
      subIssues: 0, parents: [], childInfo: [], comments: 0, attachments: 0, labels: 0,
    }, id);
    const attrs = {
      clickupId: t.id,
      platformApplied: enumVal("platformApplied", strip(t.platform)),
      appliedBy: enumVal("appliedBy", strip(t.appliedBy)) ?? (strip(t.appliedBy) ? enumVal("appliedBy", String(t.appliedBy).replace(/\d+$/, "")) : undefined),
      appliedOn, nextAction: strip(t.nextAction)?.slice(0, 1000), pay: payM?.[1]?.trim().slice(0, 200), applyUrl: urlM?.[1]?.slice(0, 1000),
    };
    for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];
    await client.createMixin(id, "tracker:class:Issue", project._id, taskMixin, attrs);
    created++;
    if (created % 25 === 0) console.log(`  ${created} created…`);
  } catch (e) {
    failed++; number--;
    console.error("FAILED", t.id, t.name.slice(0, 50), (e && e.message) || e);
  }
}
await client.updateDoc("tracker:class:Project", "core:space:Space", project._id, { sequence: number });
console.log(`done: created ${created}, skipped ${skipped}, failed ${failed}; project sequence ${number}`);
await client.close();
