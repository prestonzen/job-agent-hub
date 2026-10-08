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
  return [
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
