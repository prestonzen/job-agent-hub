// Stage 1: Job Hunter project type (ClickUp-identical statuses), project, custom attributes, playbook teamspace + docs.
import api from "@hcengineering/api-client";
import core from "@hcengineering/core";
const { connect, NodeWebSocketFactory } = api;
const upload = (c, cls, id, attr, md) => c.uploadMarkup(cls, id, attr, md, "markdown"); // api-client 0.7.423 never awaits a markup-content upload, so refs are uploaded by hand
// client-resources touches window/document on connect; give Node a stub.
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { href: "https://projects.kaizenapps.com" }, document: {} };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
globalThis.navigator ??= { onLine: true };
const { generateId } = core;
import { readFileSync } from "node:fs";

const URL = "https://projects.kaizenapps.com";
const token = readFileSync("C:/Users/prestonzen/dev/job-agent-hub/.huly-token.local.txt", "utf8").trim();
const DOCS = "./docs";
const MODEL = "core:space:Model", SPACE = "core:space:Space";

const client = await connect(URL, { token, workspace: "kaizengroup", socketFactory: NodeWebSocketFactory, connectionTimeout: 30000 });
const account = await client.getAccount();
const me = account.uuid;
console.log("connected as", me, "role", account.role);

// ---------- statuses (ClickUp order, mapped onto Huly categories so Done/Canceled semantics work) ----------
const STATUSES = [
  ["not started", "task:statusCategory:UnStarted", 21],
  ["applied", "task:statusCategory:ToDo", 9],
  ["screening", "task:statusCategory:Active", 10],
  ["accepted", "task:statusCategory:Active", 4],
  ["earning", "task:statusCategory:Won", 12],
  ["rejected / paused", "task:statusCategory:Lost", 0],
];

let type = await client.findOne("task:class:ProjectType", { name: "Job Hunter" });
let taskTypeId, statusIds = {};
if (type) {
  console.log("project type exists:", type._id);
  taskTypeId = type.tasks[0];
  for (const s of await client.findAll("tracker:class:IssueStatus", { _id: { $in: type.statuses.map((x) => x._id) } })) statusIds[s.name] = s._id;
} else {
  const typeId = generateId(); taskTypeId = generateId();
  const typeMixin = `${typeId}:type:mixin`, taskMixin = `${taskTypeId}:type:mixin`;
  for (const [name, category, color] of STATUSES) {
    statusIds[name] = await client.createDoc("tracker:class:IssueStatus", MODEL, { ofAttribute: "tracker:attribute:IssueStatus", name, color, category });
  }
  const statusList = STATUSES.map(([n]) => statusIds[n]);
  await client.createDoc("core:class:Mixin", MODEL, { extends: "tracker:class:Project", kind: 2, label: "embedded:embedded:Job Hunter", icon: "tracker:icon:Issues" }, typeMixin);
  await client.createMixin(typeMixin, "core:class:Mixin", MODEL, "task:mixin:ProjectTypeClass", { projectType: typeId });
  await client.createDoc("core:class:Mixin", MODEL, { extends: "tracker:class:Issue", kind: 2, label: "embedded:embedded:Application", icon: "tracker:icon:Issue" }, taskMixin);
  await client.createMixin(taskMixin, "core:class:Mixin", MODEL, "task:mixin:TaskTypeClass", { taskType: taskTypeId, projectType: typeId });
  await client.createDoc("task:class:TaskType", MODEL, {
    descriptor: "tracker:descriptors:Issue", kind: "both", name: "Application", ofClass: "tracker:class:Issue",
    statusCategories: ["task:statusCategory:UnStarted", "task:statusCategory:ToDo", "task:statusCategory:Active", "task:statusCategory:Won", "task:statusCategory:Lost"],
    statusClass: "tracker:class:IssueStatus", icon: "tracker:icon:Issue", color: 0, allowedAsChildOf: [taskTypeId], parent: typeId, statuses: statusList, targetClass: taskMixin,
  }, taskTypeId);
  await client.createDoc("task:class:ProjectType", MODEL, {
    name: "Job Hunter", descriptor: "tracker:descriptors:ProjectType", description: "", roles: 0, classic: false,
    shortDescription: "Job applications — statuses mirror the ClickUp list AI Job Applications",
    tasks: [taskTypeId], statuses: statusList.map((_id) => ({ _id, taskType: taskTypeId })), targetClass: typeMixin,
  }, typeId);
  type = await client.findOne("task:class:ProjectType", { _id: typeId });
  console.log("created project type", typeId, "task type", taskTypeId, "statuses", statusIds);
}
const taskMixin = `${taskTypeId}:type:mixin`;

// ---------- project ----------
let project = await client.findOne("tracker:class:Project", { identifier: "JOB" });
if (!project) {
  const id = await client.createDoc("tracker:class:Project", SPACE, {
    name: "Job Hunter", identifier: "JOB", description: "AI Job Applications — one issue per application (mirrors ClickUp list 901115501535)",
    type: type._id, defaultIssueStatus: statusIds["not started"], defaultTimeReportDay: "PreviousWorkDay",
    private: false, archived: false, autoJoin: true, members: [me], owners: [me], sequence: 0,
  });
  await client.createMixin(id, "tracker:class:Project", SPACE, `${type._id}:type:mixin`, {});
  project = await client.findOne("tracker:class:Project", { _id: id });
  console.log("created project", id);
} else console.log("project exists", project._id);

// ---------- custom attributes on the Application task type (1:1 with the ClickUp list fields) ----------
const S = (label) => ({ _class: "core:class:TypeString", label: "core:string:String" });
const attrs = [
  ["platformApplied", "Platform Applied", "enum", ["Greenhouse", "Ashby", "Lever", "Company site", "LinkedIn", "Wellfound", "Upwork", "Workable", "Indeed Easy Apply", "Workday", "SmartRecruiters", "Breezy", "Rippling", "Avature", "Email to employer", "Work At A Startup", "JazzHR"]],
  ["appliedBy", "Applied By", "enum", ["Human", "Claude", "Codex", "Kimi", "Gemini", "Ollama", "Mistral", "DeepSeek", "Qwen", "Feeds"]],
  ["category", "Category", "enum", ["AI expert / data", "Freelance", "Job board", "Bounty / other"]],
  ["appliedOn", "Applied On", "date"],
  ["nextAction", "Next Action", "string"],
  ["pay", "Pay", "string"],
  ["payout", "Payout", "string"],
  ["screening", "Screening", "string"],
  ["earned", "Earned", "number"],
  ["applyUrl", "Apply URL", "hyperlink"],
  ["clickupId", "ClickUp ID", "string"],
];
for (const [name, label, kind, values] of attrs) {
  const existing = await client.findOne("core:class:Attribute", { attributeOf: taskMixin, name });
  if (existing) { console.log("attr exists", name); continue; }
  let t;
  if (kind === "enum") {
    const enumId = await client.createDoc("core:class:Enum", MODEL, { name: `Job Hunter: ${label}`, enumValues: values });
    t = { _class: "core:class:EnumOf", label: "core:string:Enum", of: enumId };
  } else if (kind === "date") t = { _class: "core:class:TypeDate", label: "core:string:Date", mode: "date", withShift: false };
  else if (kind === "number") t = { _class: "core:class:TypeNumber", label: "core:string:Number" };
  else if (kind === "hyperlink") t = { _class: "core:class:TypeHyperlink", label: "core:string:Hyperlink" };
  else t = S(label);
  await client.createDoc("core:class:Attribute", MODEL, { attributeOf: taskMixin, name, label: `embedded:embedded:${label}`, isCustom: true, type: t });
  console.log("attr created", name);
}

// ---------- playbook teamspace + documents ----------
let space = await client.findOne("document:class:Teamspace", { name: "Job Hunter Playbook" });
if (!space) {
  const st = await client.findOne("core:class:SpaceType", { _id: "document:spaceType:DefaultTeamspaceType" });
  const id = await client.createDoc("document:class:Teamspace", SPACE, {
    name: "Job Hunter Playbook", description: "Applicant profile, answer bank, stories, platform log — the agents' source of truth (mirrors ClickUp docs kkr4k-6751 and kkr4k-6771)",
    private: false, archived: false, autoJoin: true, members: [me], owners: [me], type: "document:spaceType:DefaultTeamspaceType",
  });
  if (st?.targetClass) await client.createMixin(id, "document:class:Teamspace", SPACE, st.targetClass, {});
  space = await client.findOne("document:class:Teamspace", { _id: id });
  console.log("created teamspace", id, "targetClass", st?.targetClass);
} else console.log("teamspace exists", space._id);

const PAGES = [
  ["kkr4k-13411.md", "Applicant Profile & Standard Answers"],
  ["kkr4k-13431.md", "Answer Bank (edit me — assistants read this)"],
  ["kkr4k-13451.md", "Story: AI Voice Agent for Galaxy Landscaping"],
  ["kkr4k-13591.md", "Story: Games — Roblox (Kaizen Gaming) and UAV Intercept Simulator"],
  ["kkr4k-13571.md", "Voice & Tone Example Essay (match this)"],
  ["kkr4k-13551.md", "Question Bank — every question asked so far"],
  ["kkr4k-13471.md", "Platform Log & Learnings"],
  ["rb-start-here.md", "Resume Bank — START HERE: which resume to send"],
  ["rb-bullet-bank.md", "Resume Bank — Bullet Bank (verified text blocks)"],
  ["rb-story-bank.md", "Resume Bank — Story Bank (mined from ClickUp, GitHub, local files)"],
];
const rank = (i) => `0|${(0x3b9ac9ff + i * 4096).toString(36).padStart(6, "0")}:`; // LexoRank-style, ascending
for (let i = 0; i < PAGES.length; i++) {
  const [file, title] = PAGES[i];
  if (await client.findOne("document:class:Document", { space: space._id, title })) { console.log("doc exists", title); continue; }
  const md = readFileSync(`${DOCS}/${file}`, "utf8");
  const id = generateId();
  const content = await upload(client, "document:class:Document", id, "content", md);
  await client.createDoc("document:class:Document", space._id, { title, parent: "document:ids:NoParent", rank: rank(i), content }, id);
  console.log("doc created", title, id, md.length, "chars");
}
await client.close();
console.log("stage 1 done");
