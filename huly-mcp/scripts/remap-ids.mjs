// Cut-over helper: every D1 row that referenced a ClickUp task id now references the Huly issue id, and the
// task mirror is re-seeded with the Huly view of every issue (descriptions from the ClickUp export, which
// is the same text the import wrote). Produces one SQL file; apply it with
//   npx wrangler d1 execute job-agent-hub --remote --file huly-mcp/scripts/remap.sql
import { readFileSync, writeFileSync } from "node:fs";

const token = readFileSync("../.huly-token.local.txt", "utf8").trim();
const URL = "https://projects.kaizenapps.com", WS = "589c70ca-363f-434d-b3a3-e816d21bd430", WS_URL = "kaizengroup";
const TASKS = process.argv[2] ?? "C:/Users/PRESTO~1/AppData/Local/Temp/claude/H--My-Drive-Career/c4babf8a-5e89-442f-b986-415068739b45/scratchpad/huly/clickup-tasks.json";
const PRIORITIES = ["none", "urgent", "high", "medium", "low"];

async function findAll(cls, query = {}, options = {}) {
  const p = new URLSearchParams({ class: cls });
  if (Object.keys(query).length) p.set("query", JSON.stringify(query));
  if (Object.keys(options).length) p.set("options", JSON.stringify(options));
  const r = await fetch(`${URL}/_transactor/api/v1/find-all/${WS}?${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`find-all ${cls}: ${r.status}`);
  return (await r.json()).value ?? [];
}

const project = (await findAll("tracker:class:Project", { identifier: "JOB" }))[0];
const type = (await findAll("task:class:ProjectType", { _id: project.type }))[0];
const mixin = `${type.tasks[0]}:type:mixin`;
const statuses = Object.fromEntries((await findAll("tracker:class:IssueStatus", { _id: { $in: type.statuses.map((s) => s._id) } })).map((s) => [s._id, s.name]));
const issues = await findAll("tracker:class:Issue", { space: project._id }, { limit: 5000 });
const rows = Object.fromEntries(JSON.parse(readFileSync(TASKS, "utf8"))[0].results.map((r) => JSON.parse(r.json)).map((t) => [t.id, t]));

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = [];
sql.push("CREATE TABLE IF NOT EXISTS id_map (clickup TEXT PRIMARY KEY, huly TEXT NOT NULL);", "DELETE FROM id_map;");
const tasks = [];
let mapped = 0;
for (const i of issues) {
  const f = i[mixin] ?? {};
  const t = rows[f.clickupId];
  if (f.clickupId) { sql.push(`INSERT INTO id_map (clickup, huly) VALUES (${q(f.clickupId)}, ${q(i._id)});`); mapped++; }
  const desc = t ? `${(t.description ?? "").replace(/\r/g, "").trim()}\n\n---\nImported from ClickUp ${t.url} on 2026-10-22${t.parentId && t.parentId !== "None" ? ` (was a subtask of ${t.parentId})` : ""}.` : "";
  const s = (k) => (typeof f[k] === "string" && f[k].trim() ? f[k].trim() : null);
  tasks.push({
    id: i._id, name: i.title, status: statuses[i.status] ?? "not started", parentId: null,
    appliedBy: s("appliedBy"), platform: s("platformApplied"), appliedOn: typeof f.appliedOn === "number" ? new Date(f.appliedOn).toISOString().slice(0, 10) : null,
    nextAction: s("nextAction"), priority: i.priority ? PRIORITIES[i.priority] ?? null : null, tags: [],
    url: `${URL}/workbench/${WS_URL}/tracker/${i.identifier}`, description: desc,
    createdAt: new Date(i.createdOn ?? i.modifiedOn).toISOString(), updatedAt: new Date(i.modifiedOn).toISOString(),
    identifier: i.identifier, clickupId: s("clickupId"), modifiedOn: i.modifiedOn,
  });
}
for (const [table, col] of [["claims", "task_id"], ["attempts", "task_id"], ["events", "task_id"], ["inbound", "task_id"], ["prep_kits", "task_id"], ["assignments", "task_id"], ["code_requests", "job_id"]]) {
  sql.push(`UPDATE ${table} SET ${col} = (SELECT huly FROM id_map WHERE id_map.clickup = ${table}.${col}) WHERE ${col} IN (SELECT clickup FROM id_map);`);
}
sql.push("DELETE FROM task_mirror;");
const now = Date.now();
for (const t of tasks) sql.push(`INSERT INTO task_mirror (id, json, updated_at) VALUES (${q(t.id)}, ${q(JSON.stringify(t))}, ${now});`);
sql.push(`INSERT INTO settings (key, value, updated_at) VALUES ('mirror_synced_at', ${q(JSON.stringify(now))}, ${now}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`);
writeFileSync("remap.sql", sql.join("\n"), "utf8");
console.log(`issues ${issues.length}, mapped to ClickUp ids ${mapped}, mirror rows ${tasks.length}, statements ${sql.length} -> remap.sql`);
