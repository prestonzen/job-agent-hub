import { HttpError } from "./clickup";
import { db, logEvent } from "./db";
import { getJob, reportResult } from "./jobs";
import { pickResume, resumeBytes } from "./resumes";
import type { Env } from "./types";

/**
 * Email applications, in one shot. For a posting that is applied to by emailing the employer, the agent
 * writes a short cover note and calls this: the hub attaches the right resume from the bank, sends it from
 * the mailer Worker (Cloudflare Email Sending on mail.prestonzen.com), and marks the job applied. Guardrails: the hub only sends to
 * the address on the claimed job, only for a job the agent holds, and no more than DAILY_CAP a day.
 */

const SIGNATURE = "\n\nPreston Zen\ncontact@prestonzen.com\nhttps://linkedtfin.com/in/prestonzen";
export const DAILY_CAP = 15;

export function emailEnabled(env: Env): boolean {
  return !!(env.MAILER_URL && env.MAILER_TOKEN);
}

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Hand one message to the mailer Worker; returns the message id. */
async function mail(env: Env, m: { to: string; subject: string; text: string; attachment?: { filename: string; type: string; bytes: ArrayBuffer } }): Promise<string> {
  const res = await fetch(env.MAILER_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MAILER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: m.to,
      subject: m.subject,
      text: m.text,
      attachment: m.attachment && { filename: m.attachment.filename, type: m.attachment.type, base64: toBase64(m.attachment.bytes) },
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { messageId?: string; error?: string };
  if (!res.ok || !j.messageId) throw new HttpError(502, `mailer: ${j.error ?? res.status}`);
  return j.messageId;
}

async function sentToday(env: Env): Promise<number> {
  const r = await (await db(env))
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'emailed' AND at > ?")
    .bind(Date.now() - 86_400_000)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const clean = (s: string, max: number) => s.replace(/\r/g, "").trim().slice(0, max);

export async function sendApplicationEmail(
  env: Env,
  agent: string,
  jobId: string,
  a: { body?: string | null; subject?: string | null; resumeId?: number | null },
): Promise<{ ok: true; messageId: string; to: string; resume: string; subject: string }> {
  if (!emailEnabled(env)) throw new HttpError(503, "email sending is not enabled on the hub; release_job and stop");
  const job = await getJob(env, jobId);
  if (job.claimedBy !== agent) throw new HttpError(409, `you don't hold ${job.name}; claim it first`);
  if (job.status !== "not started") throw new HttpError(409, `${job.name} is already "${job.status}"`);
  if (!job.applyEmail) throw new HttpError(400, `${job.name} has no employer email address (Apply by email: …); apply on the posting instead`);
  const body = clean(a.body ?? "", 3000);
  if (body.length < 40) throw new HttpError(400, "body is required: a short cover note (3–5 sentences) in Preston's voice");
  if ((await sentToday(env)) >= DAILY_CAP) throw new HttpError(429, `daily email cap (${DAILY_CAP}) reached; release_job and try tomorrow`);

  const pick = a.resumeId ? { id: a.resumeId } : await pickResume(env, job.role);
  if (!pick) throw new HttpError(404, "the resume bank is empty");
  const file = await resumeBytes(env, pick.id);
  const subject = clean(a.subject ?? "", 150) || `Application: ${job.role} — Preston Zen`;

  const messageId = await mail(env, {
    to: job.applyEmail,
    subject,
    text: body + SIGNATURE,
    attachment: { filename: file.filename, type: file.contentType, bytes: file.bytes },
  });

  await logEvent(env, { agent, taskId: job.id, taskName: job.name, type: "emailed", message: `${job.applyEmail} · ${file.filename}` });
  await reportResult(env, agent, job.id, { outcome: "applied", platform: "Email to employer", note: `Emailed ${job.applyEmail} with ${file.filename} (message ${messageId}).` });
  return { ok: true, messageId, to: job.applyEmail, resume: file.filename, subject };
}

/** Admin-only check that sending works end to end: sends to Preston's own address with a resume attached. */
export async function sendTestEmail(env: Env, to: string): Promise<{ ok: true; messageId: string }> {
  if (!emailEnabled(env)) throw new HttpError(503, "email sending is not enabled (MAILER_URL / MAILER_TOKEN missing)");
  if (!/^(contact@prestonzen\.com|prestonzen@kaizenapps\.com)$/i.test(to)) throw new HttpError(400, "test emails only go to Preston's own addresses");
  const pick = await pickResume(env, "AI Engineer");
  const file = pick ? await resumeBytes(env, pick.id) : null;
  const messageId = await mail(env, {
    to,
    subject: "Job Agent Hub: email application test",
    text: "This is a test from the hub's email sender. If the resume is attached, email applications will go out the same way." + SIGNATURE,
    attachment: file ? { filename: file.filename, type: file.contentType, bytes: file.bytes } : undefined,
  });
  return { ok: true, messageId };
}
