import { addComment } from "./store";
import { db, getSetting, logEvent, setSetting } from "./db";
import { DAILY_CAP, SIGNATURE, emailEnabled, mail } from "./emailer";
import { getJob } from "./jobs";
import { pickResume, resumeBytes } from "./resumes";
import { esc, notify } from "./telegram";
import type { Env } from "./types";

/**
 * One polite follow-up for each email application that has gone quiet. Runs from the autopilot tick a few
 * times a day: an application emailed 7–21 days ago, still "applied" in ClickUp, with no reply tracked from
 * that company (the Gmail → /api/inbound/email feed) and no follow-up sent yet, gets one more email from the
 * same sender with the resume attached again. Replies land in Preston's inbox as before (reply-to contact@).
 */

const MIN_AGE_MS = 7 * 86_400_000;
const MAX_AGE_MS = 21 * 86_400_000;
const EVERY_MS = 6 * 3_600_000;
const PER_RUN = 5;

const firstName = (company: string) => company.trim();

function body(role: string, company: string, sentOn: string): string {
  return (
    `Hi ${firstName(company)} team,\n\n` +
    `Preston Zen here. I applied for the ${role} role on ${sentOn} and wanted to make sure it didn't get buried.\n\n` +
    `Short version of why I think it's a fit: I build and ship AI systems end to end. Recent work includes a production voice agent that answers and books real customer calls for a landscaping company, a private RAG system (a modified PrivateGPT) for an engineering firm, and AI red-teaming work I presented at DEF CON. Fully remote US, US citizen, no sponsorship needed, and I can interview on short notice.\n\n` +
    `Resume attached again for convenience. Happy to do a quick call whenever works on your side.` +
    SIGNATURE
  );
}

/** Follow-ups due now; returns a short summary or null when nothing was due. Gated so it runs at most every 6 h. */
export async function processFollowUps(env: Env): Promise<string | null> {
  if (!emailEnabled(env)) return null;
  const now = Date.now();
  const gate = (await getSetting<{ at: number }>(env, "followups_last_run"))?.at ?? 0;
  if (now - gate < EVERY_MS) return null;
  await setSetting(env, "followups_last_run", { at: now });

  const d = await db(env);
  const { results: sent } = await d
    .prepare(
      `SELECT e.task_id AS taskId, e.task_name AS taskName, MIN(e.at) AS sentAt
         FROM events e
        WHERE e.type = 'emailed' AND e.task_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM events f WHERE f.type = 'followup' AND f.task_id = e.task_id)
        GROUP BY e.task_id
       HAVING sentAt BETWEEN ?1 AND ?2
        ORDER BY sentAt ASC LIMIT 20`,
    )
    .bind(now - MAX_AGE_MS, now - MIN_AGE_MS)
    .all<{ taskId: string; taskName: string; sentAt: number }>();
  if (!sent.length) return null;

  const today = (await d.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('emailed','followup') AND at > ?").bind(now - 86_400_000).first<{ n: number }>())?.n ?? 0;
  let budget = Math.min(PER_RUN, DAILY_CAP - today);
  const done: string[] = [];
  const skipped: string[] = [];
  for (const s of sent) {
    if (budget <= 0) break;
    try {
      const job = await getJob(env, s.taskId);
      if (job.status !== "applied" || !job.applyEmail) { skipped.push(`${job.company}: ${job.status}`); continue; }
      // Any tracked reply from this company since we wrote means a human is already in the loop.
      const replied = await d
        .prepare("SELECT 1 AS x FROM inbound WHERE at > ?1 AND (task_id = ?2 OR (company IS NOT NULL AND lower(company) = lower(?3))) LIMIT 1")
        .bind(s.sentAt, s.taskId, job.company)
        .first()
        .catch(() => null);
      if (replied) { skipped.push(`${job.company}: replied`); continue; }
      const pick = await pickResume(env, job.role);
      const file = pick ? await resumeBytes(env, pick.id) : null;
      const sentOn = new Date(s.sentAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });
      const messageId = await mail(env, {
        to: job.applyEmail,
        subject: `Following up: ${job.role} — Preston Zen`,
        text: body(job.role, job.company, sentOn),
        attachment: file ? { filename: file.filename, type: file.contentType, bytes: file.bytes } : undefined,
      });
      budget--;
      await logEvent(env, { agent: "hub", taskId: job.id, taskName: job.name, type: "followup", message: `${job.applyEmail} · ${file?.filename ?? "no attachment"}` });
      await addComment(env, job.id, `[hub] ${new Date().toISOString().slice(0, 10)}: follow-up emailed to ${job.applyEmail} (first email ${new Date(s.sentAt).toISOString().slice(0, 10)}; message ${messageId}).`).catch(() => {});
      done.push(job.company);
    } catch (e) {
      skipped.push(`${s.taskName}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  if (done.length) await notify(env, `📨 Follow-ups sent (${done.length}): ${esc(done.join(", "))}${skipped.length ? `\n<i>skipped ${skipped.length}: ${esc(skipped.slice(0, 4).join("; "))}</i>` : ""}`, { silent: true });
  return done.length ? `followed up with ${done.join(", ")}` : null;
}
