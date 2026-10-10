/**
 * Job Agent Hub mailer: sends one email through Cloudflare Email Sending and nothing else.
 * Only the hub can call it (bearer MAILER_TOKEN). The sender is fixed to the job-hub address, the
 * subject and body are bounded, and attachments are limited to a single resume-sized file, so a leaked
 * token can't be used as a general mail relay.
 */
interface Env {
  EMAIL: SendEmail;
  MAILER_TOKEN: string;
}

const FROM = { name: "Preston Zen", email: "apply@mail.prestonzen.com" };
const REPLY_TO = { name: "Preston Zen", email: "contact@prestonzen.com" };
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/;
const MAX_ATTACHMENT = 2_000_000; // bytes; resumes are ~60 KB

interface SendBody {
  to?: string;
  subject?: string;
  text?: string;
  attachment?: { filename: string; type: string; base64: string };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

function authorized(req: Request, env: Env): boolean {
  const given = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const tok = env.MAILER_TOKEN ?? "";
  if (tok.length < 24 || given.length !== tok.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
    let b: SendBody;
    try {
      b = (await req.json()) as SendBody;
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (!b.to || !EMAIL_RE.test(b.to)) return json({ error: "a valid `to` address is required" }, 400);
    if (!b.subject || b.subject.length > 200) return json({ error: "subject is required (max 200 chars)" }, 400);
    if (!b.text || b.text.length > 6000) return json({ error: "text is required (max 6000 chars)" }, 400);
    const attachments: EmailAttachment[] = [];
    if (b.attachment) {
      const bytes = fromBase64(b.attachment.base64);
      if (bytes.byteLength > MAX_ATTACHMENT) return json({ error: "attachment too large" }, 413);
      attachments.push({ disposition: "attachment", filename: b.attachment.filename.slice(0, 120), type: b.attachment.type || "application/pdf", content: bytes });
    }
    try {
      const sent = await env.EMAIL.send({ from: FROM, to: b.to, replyTo: REPLY_TO, subject: b.subject, text: b.text, attachments });
      return json({ ok: true, messageId: sent.messageId });
    } catch (e) {
      return json({ error: `send failed: ${(e as Error).message}` }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
