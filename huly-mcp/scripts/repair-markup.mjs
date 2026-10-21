// One-off repair: the first build/import ran on api-client 0.7.423, whose createDoc stores a MarkupContent value
// as {} (the upload promise is never awaited). Re-upload every document's content and every issue's description
// from the source markdown and store the real refs. Idempotent: skips records whose ref is already a string.
import api from "@hcengineering/api-client";
import { readFileSync, existsSync } from "node:fs";
const { connect, NodeWebSocketFactory } = api;
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { href: "" }, document: {} };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
globalThis.navigator ??= { onLine: true };
console.log = console.error;

const token = readFileSync("../.huly-token.local.txt", "utf8").trim();
const TASKS = process.argv[2] ?? "C:/Users/PRESTO~1/AppData/Local/Temp/claude/H--My-Drive-Career/c4babf8a-5e89-442f-b986-415068739b45/scratchpad/huly/clickup-tasks.json";
const c = await connect("https://projects.kaizenapps.com", { token, workspace: "kaizengroup", socketFactory: NodeWebSocketFactory, connectionTimeout: 30000 });
const upload = (cls, id, attr, md) => c.uploadMarkup(cls, id, attr, md, "markdown");

// Documents: title -> source file
const PAGES = {
  "Applicant Profile & Standard Answers": "kkr4k-13411.md", "Answer Bank (edit me — assistants read this)": "kkr4k-13431.md",
  "Story: AI Voice Agent for Galaxy Landscaping": "kkr4k-13451.md", "Story: Games — Roblox (Kaizen Gaming) and UAV Intercept Simulator": "kkr4k-13591.md",
  "Voice & Tone Example Essay (match this)": "kkr4k-13571.md", "Question Bank — every question asked so far": "kkr4k-13551.md",
  "Platform Log & Learnings": "kkr4k-13471.md", "Resume Bank — START HERE: which resume to send": "rb-start-here.md",
  "Resume Bank — Bullet Bank (verified text blocks)": "rb-bullet-bank.md", "Resume Bank — Story Bank (mined from ClickUp, GitHub, local files)": "rb-story-bank.md",
};
let fixedDocs = 0;
for (const d of await c.findAll("document:class:Document", {})) {
  if (typeof d.content === "string" && d.content) continue;
  const file = PAGES[d.title]; if (!file || !existsSync(`./docs/${file}`)) { console.error("no source for doc", d.title); continue; }
  const content = await upload("document:class:Document", d._id, "content", readFileSync(`./docs/${file}`, "utf8"));
  await c.updateDoc("document:class:Document", d.space, d._id, { content });
  fixedDocs++;
}
console.error(`documents repaired: ${fixedDocs}`);

// Issues: ClickUp ID -> description from the exported mirror
const rows = Object.fromEntries(JSON.parse(readFileSync(TASKS, "utf8"))[0].results.map((r) => JSON.parse(r.json)).map((t) => [t.id, t]));
const project = await c.findOne("tracker:class:Project", { identifier: "JOB" });
const type = await c.findOne("task:class:ProjectType", { _id: project.type });
const mixin = `${type.tasks[0]}:type:mixin`;
let fixed = 0, missing = 0;
for (const i of await c.findAll("tracker:class:Issue", { space: project._id })) {
  if (typeof i.description === "string" && i.description) continue;
  const t = rows[i[mixin]?.clickupId]; if (!t) { missing++; continue; }
  const body = `${(t.description ?? "").replace(/\r/g, "").trim()}\n\n---\nImported from ClickUp ${t.url} on 2026-10-22${t.parentId && t.parentId !== "None" ? ` (was a subtask of ${t.parentId})` : ""}.`;
  const description = await upload("tracker:class:Issue", i._id, "description", body);
  await c.updateCollection("tracker:class:Issue", project._id, i._id, i.attachedTo, i.attachedToClass, i.collection, { description });
  fixed++;
  if (fixed % 50 === 0) console.error(`  ${fixed} issues repaired…`);
}
console.error(`issues repaired: ${fixed}, without a source row: ${missing}`);
await c.close();
