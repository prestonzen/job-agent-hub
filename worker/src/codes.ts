import { HttpError } from "./clickup";
import { db } from "./db";
import { esc, send } from "./telegram";
import type { Env } from "./types";

/**
 * Human-relayed verification codes. When a form asks for an emailed code (Greenhouse "security
 * code", email verification), the agent calls request_code: Preston gets a Telegram message, reads
 * the code from his own inbox and replies with it. Sending it is his approval for that application.
 * The agent waits (wait_for_code) and types exactly what he sent. Nothing reads the inbox for codes.
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

const TTL_MS = 20 * 60_000;
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
      `Check contact@prestonzen.com, then <b>reply to this message with the code</b> (or send <code>/code ${id} XXXX</code>). Expires ${hhmm(now + TTL_MS)} PT.`,
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

/** A plausible code from a message: the longest 4–12 char run of letters/digits containing a digit or all caps. */
export function extractCode(text: string): string | null {
  const tokens = text.replace(/^\/code(@\w+)?\s*/i, "").match(/[A-Za-z0-9-]{4,12}/g) ?? [];
  const good = tokens.filter((t) => /\d/.test(t) || /^[A-Z0-9-]+$/.test(t));
  return good.sort((a, b) => b.length - a.length)[0]?.replace(/-/g, "") ?? null;
}
