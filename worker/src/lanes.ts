import { getSetting } from "./db";
import type { Env, Job } from "./types";

/**
 * Lanes: what kind of job an agent takes. Free-tier agents (Gemini's free API key allows about
 * twenty requests a day) can't drive a multi-page browser application, but they can finish a one-shot
 * email application, so Gemini is limited to the "email" lane and the other free tiers (Mistral, DeepSeek) and the local
 * Ollama model take email applications first. Paid agents (Claude, Codex, Kimi) take any job.
 * Stored in the autopilot settings (`lanes`); a null entry removes an agent's default lane.
 */

/** "email": only email applications. "email-first": any job, but email applications first (cheap for a free tier). */
export type Lane = "email" | "email-first";
export const DEFAULT_LANES: Record<string, Lane | null> = { gemini: "email", mistral: "email-first", deepseek: "email-first", ollama: "email-first" };

export async function agentLane(env: Env, agent: string): Promise<Lane | null> {
  const saved = await getSetting<{ lanes?: Record<string, Lane | null> }>(env, "autopilot").catch(() => null);
  const lanes = { ...DEFAULT_LANES, ...(saved?.lanes ?? {}) };
  return lanes[agent] ?? null;
}

/** An application made by emailing the employer: the posting names an address, or the ATS is "Email". */
export const isEmailJob = (j: Job): boolean => !!j.applyEmail || /\be-?mail\b/i.test(j.ats ?? "") || /^mailto:/i.test(j.applyUrl ?? "");

export const inLane = (j: Job, lane: Lane | null): boolean => !lane || lane === "email-first" || isEmailJob(j);

/** Email-first agents see email jobs ahead of the rest (stable). */
export const laneOrder = (jobs: Job[], lane: Lane | null): Job[] => (lane === "email-first" ? [...jobs.filter(isEmailJob), ...jobs.filter((j) => !isEmailJob(j))] : jobs);
