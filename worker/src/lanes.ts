import { getSetting } from "./db";
import type { Env, Job } from "./types";

/**
 * Lanes: what kind of job an agent may take. Free-tier agents (Gemini's free API key allows about
 * twenty requests a day) can't drive a multi-page browser application, but they can finish a one-shot
 * email application, so they are limited to the "email" lane. Everyone else takes any job.
 * Stored in the autopilot settings (`lanes`); a null entry removes an agent's default lane.
 */

export type Lane = "email";
export const DEFAULT_LANES: Record<string, Lane | null> = { gemini: "email" };

export async function agentLane(env: Env, agent: string): Promise<Lane | null> {
  const saved = await getSetting<{ lanes?: Record<string, Lane | null> }>(env, "autopilot").catch(() => null);
  const lanes = { ...DEFAULT_LANES, ...(saved?.lanes ?? {}) };
  return lanes[agent] ?? null;
}

/** An application made by emailing the employer: the posting names an address, or the ATS is "Email". */
export const isEmailJob = (j: Job): boolean => !!j.applyEmail || /\be-?mail\b/i.test(j.ats ?? "") || /^mailto:/i.test(j.applyUrl ?? "");

export const inLane = (j: Job, lane: Lane | null): boolean => !lane || (lane === "email" && isEmailJob(j));
