#!/usr/bin/env node
// Prints SQL that fills a LOCAL D1 with a month of believable agent activity, so `npm run demo`
// shows real-looking analytics, command center and run history. Pure demo data: fictional
// companies, no connection to any real account. Usage: node scripts/seed-demo.mjs > .demo-seed.sql
//
// Pair it with MOCK mode (see package.json "demo"), where the task list is generated too.

let seed = 20261007;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const weighted = (pairs) => {
  let r = rnd() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(Math.round(v)) : `'${String(v).replace(/'/g, "''")}'`);

const DAY = 86_400_000;
const NOW = Date.now();
const COMPANIES = [
  "Lumen Robotics", "Quillbase", "Northwind Labs", "Brightloop", "Cobalt Mind", "Fernwood AI", "Gridstone", "Halcyon Data", "Ironleaf", "Juniper Systems",
  "Kestrel Health", "Lattice Forge", "Meridian Voice", "Nimbus Works", "Orchard AI", "Pinecone Labs", "Quasar Cloud", "Riverbend", "Sable Analytics", "Tidewater AI",
  "Umbra Security", "Vantage Agents", "Willow Compute", "Xylo Systems", "Yarrow Labs", "Zephyr Data", "Alder & Finch", "Basalt Cloud", "Cinder Labs", "Driftwood AI",
];
const ROLES = ["Senior LLM Engineer", "Applied AI Engineer", "AI Agent Engineer", "Full Stack AI Engineer", "ML Platform Engineer", "Forward Deployed AI Engineer", "Voice AI Engineer"];
const AGENTS = [
  ["claude", 38, 0.86],
  ["codex", 20, 0.78],
  ["gemini", 14, 0.7],
  ["kimi", 16, 0.8],
  ["mistral", 8, 0.74],
];
// Success is lower where the system is hostile to automation.
const ATS = [
  ["ashby", 40, 0.92],
  ["greenhouse", 26, 0.55],
  ["lever", 14, 0.85],
  ["workable", 8, 0.8],
  ["smartrecruiters", 6, 0.7],
  ["jazzhr", 6, 0.75],
];
// Hour of day (UTC) weights: the agents run mostly overnight US time.
const HOURS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1];
const hourW = (h) => (h >= 4 && h <= 13 ? 3 : h >= 14 && h <= 20 ? 1.4 : 0.6);

const out = [];
out.push(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, agent TEXT NOT NULL, task_id TEXT, task_name TEXT, type TEXT NOT NULL, message TEXT, ats TEXT, company TEXT);`);
out.push(`CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);`);
out.push(`CREATE TABLE IF NOT EXISTS heartbeats (agent TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, client TEXT);`);
out.push(`CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT, count INTEGER, status TEXT NOT NULL DEFAULT 'queued', runner TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, exit_code INTEGER, cancel INTEGER NOT NULL DEFAULT 0, log TEXT NOT NULL DEFAULT '', not_before INTEGER);`);
out.push(`CREATE TABLE IF NOT EXISTS runners (name TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, agents TEXT NOT NULL, slots INTEGER NOT NULL, busy INTEGER NOT NULL, version TEXT, host TEXT);`);
out.push(`CREATE TABLE IF NOT EXISTS api_usage (day TEXT NOT NULL, api TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY (day, api));`);
out.push(`DELETE FROM events; DELETE FROM runs; DELETE FROM heartbeats; DELETE FROM runners; DELETE FROM api_usage;`);

// ---- events: claim → outcome, a rising trend over 30 days ----
const events = [];
let n = 0;
for (let back = 29; back >= 0; back--) {
  const perDay = Math.round((3 + (30 - back) * 0.28 + rnd() * 5) * (back % 7 === 0 ? 0.5 : 1));
  for (let i = 0; i < perDay; i++) {
    const agent = weighted(AGENTS.map(([a, w]) => [a, w]));
    const base = AGENTS.find(([a]) => a === agent)[2];
    const ats = weighted(ATS.map(([a, w]) => [a, w]));
    const atsRate = ATS.find(([a]) => a === ats)[2];
    const hour = weighted(HOURS.map((h) => [h, hourW(h)]));
    const claimedAt = NOW - back * DAY - (NOW % DAY) + hour * 3_600_000 + Math.floor(rnd() * 3_600_000);
    if (claimedAt > NOW - 60_000) continue;
    const company = COMPANIES[(n * 7 + i) % COMPANIES.length];
    const name = `${company} — ${pick(ROLES)}`;
    const id = `g${n}`;
    events.push([claimedAt, agent, id, name, "claimed", null, ats, company.toLowerCase()]);
    const ok = rnd() < base * atsRate + 0.08;
    let type = "applied";
    let msg = null;
    if (!ok) {
      type = weighted([["needs_human", 5], ["skipped", 3], ["failed", 2]]);
      msg = type === "needs_human" ? pick(["Needs human: emailed verification code", "Needs human: essay question", "Needs human: reCAPTCHA", "Needs human: account required"]) : type === "skipped" ? "Not a fit: onsite" : "Form error on submit";
    }
    const took = (4 + rnd() * 11) * 60_000;
    events.push([Math.min(claimedAt + took, NOW - 1000), agent, id, name, type, msg, ats, company.toLowerCase()]);
    if (rnd() < 0.05) events.push([Math.min(claimedAt + took * 0.4, NOW - 2000), agent, id, name, "released", "lease expired", ats, company.toLowerCase()]);
    n++;
  }
}
events.sort((a, b) => a[0] - b[0]);
for (const e of events)
  out.push(`INSERT INTO events (at, agent, task_id, task_name, type, message, ats, company) VALUES (${q(e[0])}, ${q(e[1])}, ${q(e[2])}, ${q(e[3])}, ${q(e[4])}, ${q(e[5])}, ${q(e[6])}, ${q(e[7])});`);

// ---- runs ----
let rid = 0;
for (let back = 29; back >= 0; back--) {
  const runsToday = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < runsToday; i++) {
    const agent = weighted(AGENTS.map(([a, w]) => [a, w]));
    const created = NOW - back * DAY - Math.floor(rnd() * 14) * 3_600_000 - 900_000;
    if (created > NOW - 120_000) continue;
    const started = created + 30_000 + rnd() * 120_000;
    const mins = 9 + rnd() * 34;
    const status = rnd() < 0.9 ? "succeeded" : rnd() < 0.7 ? "failed" : "cancelled";
    out.push(
      `INSERT INTO runs (id, agent, kind, prompt, count, status, runner, created_at, started_at, finished_at, exit_code, cancel, log) VALUES (${++rid}, ${q(agent)}, 'queue', NULL, 3, ${q(status)}, 'kloud', ${q(created)}, ${q(started)}, ${q(started + mins * 60_000)}, ${status === "succeeded" ? 0 : 1}, 0, ${q("[demo] run output omitted\n")});`,
    );
  }
}
// One run in flight and one queued, so the dashboards show life.
out.push(`INSERT INTO runs (id, agent, kind, prompt, count, status, runner, created_at, started_at, cancel, log) VALUES (${++rid}, 'claude', 'queue', NULL, 3, 'running', 'kloud', ${q(NOW - 6 * 60_000)}, ${q(NOW - 5 * 60_000)}, 0, ${q("[demo] claimed 3 jobs\nopening the application form…\n")});`);

// ---- heartbeats, runner, API usage ----
// The runner's last_seen is set 90 minutes ahead so the demo reads as online for a while after seeding.
for (const [a] of AGENTS) out.push(`INSERT INTO heartbeats (agent, last_seen, client) VALUES (${q(a)}, ${q(NOW - Math.floor(rnd() * 8) * 60_000)}, 'demo-runner');`);
const agentsJson = JSON.stringify(AGENTS.map(([id]) => ({ id, installed: true, ready: true, version: "demo" })));
out.push(`INSERT INTO runners (name, last_seen, agents, slots, busy, version, host) VALUES ('kloud', ${q(NOW + 90 * 60_000)}, ${q(agentsJson)}, 2, 1, 'demo', 'proxmox-lxc');`);
for (let back = 29; back >= 0; back--) {
  const day = new Date(NOW - back * DAY).toISOString().slice(0, 10);
  out.push(`INSERT INTO api_usage (day, api, calls) VALUES (${q(day)}, 'clickup', ${q(70 + Math.floor(rnd() * 70))});`);
}

console.log(out.join("\n"));
