import type { Env, Task } from "./types";

/**
 * Which rows in the ClickUp list are job applications and which are platform/board rows.
 * Applications are top-level tasks named "Company — Role" (older ones may still be subtasks of
 * PARENT_TASK_ID). Platforms and boards (Mercor, Upwork, RemoteOK, …) carry one of these tags.
 */
const PLATFORM_TAGS = ["job-board", "freelance", "ai-expert", "bounty"];
const COMPANY_ROLE = /\s[—–-]\s/;
/** To-do rows that happen to look like "X — Y", e.g. "Apply to AI expert platforms — Handshake, …". */
const META = /^apply to\b/i;

export const isPlatform = (t: Task, env: Env): boolean =>
  t.id !== env.PARENT_TASK_ID && t.tags.some((tag) => PLATFORM_TAGS.includes(tag.toLowerCase()));

export function isApplication(t: Task, env: Env): boolean {
  if (t.id === env.PARENT_TASK_ID || isPlatform(t, env)) return false;
  if (t.parentId === env.PARENT_TASK_ID) return true;
  return t.parentId === null && COMPANY_ROLE.test(t.name) && !META.test(t.name);
}
