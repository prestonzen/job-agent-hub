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
  ): Task => ({
    id,
    name,
    status,
    parentId,
    appliedBy,
    platform,
    appliedOn,
    tags: [],
    url: "https://example.com/task/" + id,
    description: "Demo task — private details would live here and never reach the public site.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const p = env.PARENT_TASK_ID;
  return [
    mk("d1", "Acme AI — Senior LLM Engineer", "applied", "Claude", "Ashby", "2026-10-07", p),
    mk("d2", "Northwind Labs — Applied AI Engineer", "applied", "Claude", "Greenhouse", "2026-10-07", p),
    mk("d3", "Globex — AI Agent Engineer", "screening", "Claude", "Lever", "2026-10-08", p),
    mk("d4", "Initech — ML Platform Engineer", "applied", "Codex", "Greenhouse", "2026-10-08", p),
    mk("d5", "Umbrella Systems — Voice AI Engineer", "applied", "Human", "Other", "2026-10-08", p),
    mk("d6", "Hooli — Full Stack AI Engineer", "accepted", "Claude", "Ashby", "2026-10-08", p),
    mk("d7", "Stark Industries — Security Engineer, AI", "not started", null, "Greenhouse", null, p),
    mk("pl1", "Example Expert Network", "applied", null, null, null, null),
    mk("pl2", "Example Freelance Marketplace", "rejected / paused", null, null, null, null),
  ];
}
