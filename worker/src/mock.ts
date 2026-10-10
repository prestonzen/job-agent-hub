import type { Env, Task } from "./types";

/** Demo data for local development and screenshots. Not real applications. */
export function mockTasks(env: Env): Task[] {
  const mk = (
    id: string,
    name: string,
    status: string,
    appliedBy: string | null,
    platform: string | null,
    appliedOn: string | null,
    parentId: string | null,
    description = "Demo task — private details would live here and never reach the public site.",
    priority: string | null = "normal",
  ): Task => ({
    id,
    name,
    status,
    parentId,
    appliedBy,
    platform,
    appliedOn,
    nextAction: null,
    priority,
    tags: [],
    url: "https://example.com/task/" + id,
    description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const posting = (url: string, fit: string, ats: string) =>
    `Apply: ${url}\nPay: $180k–$220k | Travel: ~5% | Fit: ${fit} | ATS: ${ats}`;
  const p = null; // applications are top-level tasks
  const generated = mockApplications(mk, posting);
  return [
    ...generated,
    mk("d1", "Acme AI — Senior LLM Engineer", "applied", "Claude", "Ashby", "2026-10-07", p),
    mk("d2", "Northwind Labs — Applied AI Engineer", "applied", "Claude", "Greenhouse", "2026-10-07", p),
    mk("d3", "Globex — AI Agent Engineer", "screening", "Claude", "Lever", "2026-10-08", p),
    mk("d4", "Initech — ML Platform Engineer", "applied", "Codex", "Greenhouse", "2026-10-08", p),
    mk("d5", "Umbrella Systems — Voice AI Engineer", "applied", "Human", "Other", "2026-10-08", p),
    mk("d6", "Hooli — Full Stack AI Engineer", "accepted", "Claude", "Ashby", "2026-10-08", p),
    mk("d7", "Stark Industries — Security Engineer, AI", "not started", null, null, null, p,
      posting("https://job-boards.greenhouse.io/example/jobs/1", "4/5 (security + LLM)", "Greenhouse"), "high"),
    mk("d8", "Wayne Labs — Forward Deployed AI Engineer", "not started", null, null, null, p,
      posting("https://jobs.ashbyhq.com/example/2", "5/5 (voice agents)", "Ashby")),
    mk("d9", "Cyberdyne — Agent Platform Engineer", "not started", null, null, null, p,
      posting("https://jobs.lever.co/example/3", "3/5", "Lever"), "low"),
    { ...mk("pl1", "Example Expert Network", "applied", null, null, null, null), tags: ["ai-expert"] },
    { ...mk("pl2", "Example Freelance Marketplace", "rejected / paused", null, null, null, null), tags: ["freelance"] },
    mk(env.PARENT_TASK_ID, "AI Dev Job Applications — Oct 2026", "not started", null, null, null, null),
  ];
}

export function mockPlaybook(): string {
  return "# Demo playbook\n\nIn production this is the ClickUp playbook doc (standard answers and rules). Demo mode never exposes real data.";
}

// ---------- Demo volume ----------

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_COMPANIES = [
  "Lumen Robotics", "Quillbase", "Northwind Labs", "Brightloop", "Cobalt Mind", "Fernwood AI", "Gridstone", "Halcyon Data", "Ironleaf", "Juniper Systems",
  "Kestrel Health", "Lattice Forge", "Meridian Voice", "Nimbus Works", "Orchard AI", "Pinecone Labs", "Quasar Cloud", "Riverbend", "Sable Analytics", "Tidewater AI",
  "Umbra Security", "Vantage Agents", "Willow Compute", "Xylo Systems", "Yarrow Labs", "Zephyr Data", "Alder & Finch", "Basalt Cloud", "Cinder Labs", "Driftwood AI",
  "Ember Logic", "Flint Robotics", "Granite Mind", "Harbor Intelligence", "Indigo Ledger", "Jetstream AI", "Keystone Agents", "Lantern Labs", "Mosaic Voice", "Nova Tools",
];
const ROLES = [
  "Senior LLM Engineer", "Applied AI Engineer", "AI Agent Engineer", "Full Stack AI Engineer", "ML Platform Engineer", "Forward Deployed AI Engineer",
  "Staff Machine Learning Engineer", "Voice AI Engineer", "AI Infrastructure Engineer", "Founding AI Engineer",
];
const ATS_LIST = ["Ashby", "Ashby", "Ashby", "Greenhouse", "Greenhouse", "Lever", "Workable", "Company site", "SmartRecruiters", "JazzHR"];
const AGENTS = ["Claude", "Claude", "Claude", "Claude", "Codex", "Codex", "Gemini", "Kimi", "Kimi", "Mistral"];

/** ~90 sent applications over the last 16 days plus a live queue, so demo charts have something to show. */
function mockApplications(
  mk: (id: string, name: string, status: string, appliedBy: string | null, platform: string | null, appliedOn: string | null, parentId: string | null, description?: string, priority?: string | null) => Task,
  posting: (url: string, fit: string, ats: string) => string,
): Task[] {
  const r = rng(20261007);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out: Task[] = [];
  const day = (back: number) => new Date(Date.now() - back * 86_400_000).toLocaleDateString("en-CA");
  for (let i = 0; i < 92; i++) {
    const back = Math.floor(Math.pow(r(), 1.35) * 16); // more recent days are busier
    const company = DEMO_COMPANIES[i % DEMO_COMPANIES.length];
    const status = r() < 0.07 ? "screening" : r() < 0.02 ? "accepted" : r() < 0.06 ? "rejected / paused" : "applied";
    out.push(mk(`g${i}`, `${company} — ${pick(ROLES)}`, status, pick(AGENTS), pick(ATS_LIST), day(back), null));
  }
  const parked = ["Needs human: emailed verification code", "Needs human: essay question", "Needs human: reCAPTCHA", "Needs human: account required", "Needs human: emailed verification code"];
  for (let i = 0; i < 22; i++) {
    const company = DEMO_COMPANIES[(i * 3 + 7) % DEMO_COMPANIES.length];
    const ats = pick(ATS_LIST);
    const t = mk(`q${i}`, `${company} — ${pick(ROLES)}`, "not started", null, null, null, null, posting(`https://jobs.example.com/${i}`, `${3 + (i % 3)}/5 (AI agents)`, ats));
    if (i % 4 === 0) t.nextAction = parked[(i / 4) % parked.length];
    out.push(t);
  }
  return out;
}
