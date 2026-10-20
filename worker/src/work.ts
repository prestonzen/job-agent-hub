import { getSetting } from "./db";
import type { Env } from "./types";
import type { RunnerInfo, RunRow } from "./runs";

export const TASKS = ["applications", "email", "sourcing", "cyber"] as const;
export type AgentTask = (typeof TASKS)[number];
export type TaskSwitches = Record<AgentTask, boolean>;
export type RunTask = AgentTask | "diagnostic" | "custom" | "login" | "prep";
export interface WorkSettings { enabled?: boolean; agents?: Record<string, boolean>; tasks?: Record<string, Partial<TaskSwitches>>; lanes?: Record<string, string | null>; maxConcurrent?: number }

export function taskSwitches(settings: WorkSettings, agent: string): TaskSwitches {
  return {
    applications: (settings.lanes?.[agent] ?? (agent === "gemini" ? "email" : null)) !== "email",
    email: true, sourcing: true, cyber: ["codex", "claude", "kimi", "ollama"].includes(agent),
    ...settings.tasks?.[agent],
  };
}
export const workSettings = async (env: Env): Promise<WorkSettings> => (await getSetting<WorkSettings>(env, "autopilot")) ?? {};

/** Installed/authenticated describes access. Eligibility also needs capacity, switches and quota. */
export function eligibleAgents(runners: RunnerInfo[], runs: RunRow[], settings: WorkSettings, task: AgentTask, cooldowns: Map<string, number>, now = Date.now()): string[] {
  if (settings.enabled === false) return [];
  const busy = new Set(runs.filter((r) => r.status === "running" || r.status === "queued").map((r) => r.agent));
  return [...new Set(runners.filter((r) => r.online && r.busy < r.slots).flatMap((r) => r.agents.filter((a) => a.ready && a.signedIn !== false).map((a) => a.id)))].filter((a) =>
    settings.agents?.[a] !== false && taskSwitches(settings, a)[task] && !busy.has(a) && (cooldowns.get(a) ?? 0) <= now,
  );
}

export interface RunOutcome { applied: number; emailed: number; added: number; blocked: number; failed: number; skipped: number; claimed: number; cyber: number; triaged: number; unfinished: number }
export const EMPTY_OUTCOME: RunOutcome = { applied: 0, emailed: 0, added: 0, blocked: 0, failed: 0, skipped: 0, claimed: 0, cyber: 0, triaged: 0, unfinished: 0 };
export function outcomeSummary(task: RunTask, status: RunRow["status"], o: RunOutcome): string {
  if (task === "diagnostic") return status === "succeeded" ? "Diagnostic passed; no application work performed" : `Diagnostic ${status}`;
  const results = [o.triaged && `${o.triaged} evidence item${o.triaged===1?'':'s'} triaged`, o.applied && `${o.applied} application${o.applied===1?'':'s'} reported submitted`, o.emailed && `${o.emailed} email${o.emailed===1?'':'s'} sent`, o.added && `${o.added} new role${o.added===1?'':'s'} added`, o.cyber && `${o.cyber} cyber report${o.cyber===1?'':'s'} recorded`, o.blocked && `${o.blocked} need review`, o.failed && `${o.failed} failed attempt${o.failed===1?'':'s'}`, o.skipped && `${o.skipped} skipped`, o.unfinished && `${o.unfinished} claimed job${o.unfinished===1?'':'s'} ${status==='running'?'awaiting results':o.unfinished===1?'has no final result recorded':'have no final result recorded'}`].filter(Boolean);
  if (results.length) return results.join(" · ") + (status === "failed" ? " · process failed" : "");
  if (status === "running") return o.claimed ? `${o.claimed} jobs claimed; no result reported yet` : "Running; no work result reported yet";
  if (status === "queued") return "Waiting to start";
  if (status === "failed") return "Process failed; no work result recorded";
  if (status === "cancelled") return "Cancelled; no work result recorded";
  return "Process finished; no work result recorded";
}

export function inferRunTask(kind: string, prompt: string | null): RunTask {
  if (kind === "login") return "login";
  if (kind === "queue") return "applications";
  if (/health[_ -]?ok|repair verification|diagnostic|health check/i.test(prompt ?? "")) return "diagnostic";
  if (/source new jobs|find (?:up to )?\d+ new|sourcing task|do not apply.*sourc/i.test(prompt ?? "")) return "sourcing";
  if (/cyber triage|bug bounty|validator.*finding/i.test(prompt ?? "")) return "cyber";
  return "custom";
}
