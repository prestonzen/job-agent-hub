import { HttpError } from "./clickup";
import { db } from "./db";
import { esc, send } from "./telegram";
import type { Env } from "./types";

/**
 * Emailed verification codes ("security code", email verification).
 *
 * Primary path (2026-10-27): the Gmail Apps Script already posts every inbound email body to the hub,
 * so when a pending code request exists and a code-looking email arrives, `answerFromEmail` answers
 * the request itself — no runner-side Gmail token (the runner's refresh token was revoked, which
 * parked a dozen Greenhouse applications as "code never arrived"). Fallback: Preston also gets a
 * Telegram note and can answer by hand. The agent calls request_code, then wait_for_code until
 * answered, and types exactly that code.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS code_requests (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  job_name TEXT,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  code TEXT,
  tg_message_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER
)`;

// The inbox sync runs every few minutes; a request must outlive at least two sync cycles plus the code's own validity window.
const TTL_MS = 30 * 60_000;
let ready = false;
async function cdb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.prepare(SCHEMA).run();
    ready = true;
  }
  return d;
}

export interface CodeRequest {
  id: string;
  jobId: string | null;
  jobName: string | null;
  agent: string;
  kind: string;
  status: "pending" | "answered" | "expired" | "cancelled";
  code: string | null;
  tgMessageId: number | null;
  createdAt: number;
  expiresAt: number;
}

interface Row { id: string; job_id: string | null; job_name: string | null; agent: string; kind: string; status: CodeRequest["status"]; code: string | null; tg_message_id: number | null; created_at: number; expires_at: number }
const toReq = (r: Row): CodeRequest => ({
  id: r.id, jobId: r.job_id, jobName: r.job_name, agent: r.agent, kind: r.kind,
  status: r.status === "pending" && r.expires_at < Date.now() ? "expired" : r.status,
  code: r.code, tgMessageId: r.tg_message_id, createdAt: r.created_at, expiresAt: r.expires_at,
});

const shortId = () => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31]).join("");
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" });

export async function requestCode(env: Env, r: { agent: string; jobId?: string | null; jobName?: string | null; kind?: string; hint?: string }): Promise<CodeRequest> {
  const d = await cdb(env);
  const now = Date.now();
  const id = shortId();
  const kind = (r.kind || "email verification code").slice(0, 60);
  const sent = await send(
    env,
    `🔐 <b>${esc(r.agent)} needs a code</b> for ${esc(r.jobName ?? "an application")}\n` +
      `${esc(kind)}${r.hint ? ` · ${esc(r.hint.slice(0, 200))}` : ""}\n\n` +
      `The hub reads the inbox itself and should answer within a few minutes. If it has not by ${hhmm(now + 12 * 60_000)} PT, check contact@prestonzen.com and send <code>/code ${id} XXXX</code>. Expires ${hhmm(now + TTL_MS)} PT.`,
  );
  await d
    .prepare("INSERT INTO code_requests (id, job_id, job_name, agent, kind, tg_message_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, r.jobId ?? null, r.jobName ?? null, r.agent, kind, sent.messageId, now, now + TTL_MS)
    .run();
  if (sent.error) console.error("code request telegram:", sent.error);
  return toReq((await d.prepare("SELECT * FROM code_requests WHERE id = ?").bind(id).first<Row>())!);
}

export async function getCodeRequest(env: Env, id: string): Promise<CodeRequest> {
  const r = await (await cdb(env)).prepare("SELECT * FROM code_requests WHERE id = ?").bind(id.toUpperCase()).first<Row>();
  if (!r) throw new HttpError(404, `no code request ${id}`);
  return toReq(r);
}

/** Long-poll for up to ~25 s; the agent calls again until answered or expired. */
export async function waitForCode(env: Env, id: string, agent: string): Promise<{ status: CodeRequest["status"]; code: string | null; expiresAt: string }> {
  const deadline = Date.now() + 25_000; // under the 30 s MCP timeout set for Gemini/Qwen
  for (;;) {
    const r = await getCodeRequest(env, id);
    if (r.agent !== agent) throw new HttpError(403, "this code request belongs to another agent");
    if (r.status !== "pending" || Date.now() > deadline) return { status: r.status, code: r.code, expiresAt: new Date(r.expiresAt).toISOString() };
    await new Promise((res) => setTimeout(res, 3_000));
  }
}

export async function pendingCodes(env: Env): Promise<CodeRequest[]> {
  const { results } = await (await cdb(env))
    .prepare("SELECT * FROM code_requests WHERE status = 'pending' AND expires_at > ? ORDER BY created_at")
    .bind(Date.now())
    .all<Row>();
  return results.map(toReq);
}

/** Store Preston's code. `match` is the request id, or the Telegram message he replied to. */
export async function answerCode(env: Env, match: { id?: string; tgMessageId?: number }, code: string): Promise<CodeRequest | null> {
  const d = await cdb(env);
  const row = match.id
    ? await d.prepare("SELECT * FROM code_requests WHERE id = ? AND status = 'pending' AND expires_at > ?").bind(match.id.toUpperCase(), Date.now()).first<Row>()
    : await d.prepare("SELECT * FROM code_requests WHERE tg_message_id = ? AND status = 'pending' AND expires_at > ?").bind(match.tgMessageId, Date.now()).first<Row>();
  if (!row) return null;
  await d.prepare("UPDATE code_requests SET status = 'answered', code = ?, answered_at = ? WHERE id = ?").bind(code, Date.now(), row.id).run();
  return toReq({ ...row, status: "answered", code });
}

/** Words that look like codes but never are (seen in Greenhouse/Ashby/Lever mails). */
const NOT_A_CODE = /^(https?|greenhouse|ashby|lever|workable|apply|resume|email|please|thanks|hello|verify|verification|security|expires?|minutes?|within|enter|below|your|this|code|request|application|unsubscribe|support|privacy|2026|2025)$/i;

/** Best code in an email body: scored like the runner's inbox helper (context words around the token win). */
export function bestCodeInEmail(text: string): string | null {
  const clean = text.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ");
  let best: { code: string; score: number } | null = null;
  const seen = new Set<string>();
  for (const m of clean.matchAll(/\b([A-Za-z0-9]{4,10})\b/g)) {
    const code = m[1];
    if (seen.has(code) || NOT_A_CODE.test(code)) continue;
    seen.add(code);
    const plausible = /\d/.test(code) || /^[A-Z0-9]+$/.test(code) || (/[a-z]/.test(code) && /[A-Z]/.test(code));
    if (!plausible) continue;
    const around = clean.slice(Math.max(0, (m.index ?? 0) - 70), (m.index ?? 0) + 70).toLowerCase();
    const score =
      (/code|verif|otp|confirm|pin|token|passcode|security/.test(around) ? 10 : 0) +
      (/expire|valid|minutes|resubmit|enter/.test(around) ? 2 : 0) +
      (/^\d{6}$/.test(code) ? 2 : 0) +
      (code.length === 8 ? 1 : 0) -
      (/^\d{4}$/.test(code) ? 3 : 0); // a bare 4-digit number is usually a year or a street number
    if (score >= 10 && (!best || score > best.score)) best = { code, score };
  }
  return best?.code ?? null;
}

/**
 * Called for every inbound email: if a code request is pending and this looks like the code email,
 * answer it. Matching prefers a request whose kind/job mentions the sender's brand; otherwise the
 * oldest pending request (one agent waits at a time in practice).
 */
export async function answerFromEmail(env: Env, e: { from: string; subject: string; text: string }): Promise<CodeRequest | null> {
  const pending = await pendingCodes(env);
  if (!pending.length) return null;
  const hay = `${e.subject}\n${e.text}`;
  if (!/\b(code|verif|one.?time|passcode|security code|confirm your email)/i.test(hay)) return null;
  const code = bestCodeInEmail(hay);
  if (!code) return null;
  const brand = ((e.from.match(/@([a-z0-9.-]+)/i)?.[1] ?? "").toLowerCase().split(".").slice(-2, -1)[0] ?? "").replace(/mail$/, "");
  const pick = (brand && pending.find((r) => `${r.kind} ${r.jobName ?? ""}`.toLowerCase().includes(brand))) || pending[0];
  const answered = await answerCode(env, { id: pick.id }, code);
  if (answered) console.log(`code request ${pick.id} answered from email "${e.subject}" (${e.from}) for ${pick.agent}`);
  return answered;
}

/** A plausible code from a message: the longest 4–12 char run of letters/digits containing a digit or all caps. */
export function extractCode(text: string): string | null {
  const tokens = text.replace(/^\/code(@\w+)?\s*/i, "").match(/[A-Za-z0-9-]{4,12}/g) ?? [];
  const good = tokens.filter((t) => /\d/.test(t) || /^[A-Z0-9-]+$/.test(t));
  return good.sort((a, b) => b.length - a.length)[0]?.replace(/-/g, "") ?? null;
}
