import { sendApplicationEmail } from "./emailer";
import { HttpError } from "./clickup";
import { agentInstructions } from "./instructions";
import { OUTCOMES, addJob, claimJobs, getJob, logApplication, playbook, queue, isAvailable, releaseJob, renewLease, reportResult, type Outcome } from "./jobs";
import { pickResume } from "./resumes";
import { makeCoverLetter } from "./coverletters";
import { saveKit } from "./kits";
import { getJob as jobById } from "./jobs";
import { requestCode, waitForCode } from "./codes";
import { handoffJob } from "./jobs";
import type { Env } from "./types";

/**
 * Minimal stateless MCP server (Streamable HTTP transport, JSON responses, no SSE).
 * Claude Code, Codex, Gemini CLI, Kimi CLI, Le Chat and other MCP clients all connect to the same
 * URL with their own bearer token, so they share one queue.
 */

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const str = { type: "string" } as const;

const TOOLS = [
  {
    name: "get_playbook",
    description: "Read Preston's application playbook: the source of truth for every form answer and rule. Call once per session before applying.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_queue",
    description: "Overview of the shared queue: how many jobs are available, claimed, or parked for a human, plus the next few available jobs.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many available jobs to list (default 10)" } } },
  },
  {
    name: "claim_jobs",
    description: "Claim the best available jobs for yourself (atomic; no other agent gets them while your lease is live, ~60 min). Returns jobs you already hold first.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "1-10, default 1. 4 is a good batch." },
        ats: { type: "array", items: str, description: 'Only these application systems, e.g. ["greenhouse","ashby","lever"]' },
      },
    },
  },
  {
    name: "get_resume",
    description: "Pick the best tailored resume for a job from the resume bank (by role title plus the posting text). Always pass the job description so a generic title still gets the right variant. On a runner the file is already in ./resumes/<filename>; elsewhere download it from downloadUrl with your bearer token.",
    inputSchema: { type: "object", properties: { role: { type: "string", description: "The job title, e.g. 'Senior Forward Deployed Engineer'" }, description: { type: "string", description: "The posting text (responsibilities, requirements, company blurb) — the first few thousand characters are enough" } }, required: ["role"] },
  },
  {
    name: "make_cover_letter",
    description:
      "Typeset a cover letter you wrote (per the playbook's cover-letter rule) as a one-page PDF for a claimed job, so you can upload it where a form offers a cover-letter file. Returns downloadUrl: fetch it with your bearer token (curl -H 'Authorization: Bearer <token>' -o <filename> <downloadUrl>) and upload that file. For a cover-letter TEXT field, paste the text directly instead.",
    inputSchema: { type: "object", properties: { id: str, text: { type: "string", description: "The full letter, 3-4 short paragraphs, plain text with blank lines between paragraphs; no LinkedIn URL" } }, required: ["id", "text"] },
  },
  {
    name: "save_prep_kit",
    description:
      "Save the copy/paste kit for a job Preston will finish himself: the resume you picked, your cover letter, every form question with your drafted answer, and a note on what only he can do. Call it whenever you report needs_human (before the report), and in prep runs. Replaces any earlier kit for the job.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        form_url: { type: "string", description: "The exact page the form is on" },
        resume_id: { type: "number", description: "id from get_resume" },
        cover_letter: { type: "string", description: "Full cover letter text (plain text, blank lines between paragraphs); omit if the form has nowhere for one" },
        answers: { type: "array", items: { type: "object", properties: { question: str, answer: str }, required: ["question", "answer"] }, description: "Every non-trivial field: the question as shown, and the answer exactly as it should be entered (dropdowns: the option text)" },
        notes: { type: "string", description: "What only Preston can do here (attestation question, CAPTCHA, code, account), and anything unusual about the form" },
      },
      required: ["id"],
    },
  },
  {
    name: "handoff_job",
    description:
      "Give a claimed job to another agent (default Kimi) when you truly can't finish it: an essay or question with no verified facts to build an answer from, or something outside your tools. Do this instead of skipping. The assignee gets it ahead of the queue for 6 hours. If you are Kimi, report needs_human instead.",
    inputSchema: { type: "object", properties: { id: str, reason: { type: "string", description: "What you couldn't do, specifically (the question text, the blocker)" }, to: { type: "string", description: "Agent to hand it to; default kimi" }, log: { type: "string", description: "Your action log so far: URL reached, fields filled, answers given (essays in full), where you stopped. The assignee reads it first." } }, required: ["id", "reason"] },
  },
  {
    name: "send_application_email",
    description:
      "One-shot email application for a job that has `applyEmail`: write a short cover note in Preston's voice (3-5 sentences, specific to the role, from the Answer Bank); the hub attaches the best resume from the bank, emails the employer address on the job, and marks the job applied. Nothing else to do for that job. Fails if you don't hold the job or the job has no applyEmail.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        body: { type: "string", description: "The cover note (the hub adds the signature). 3-5 sentences, no placeholders." },
        subject: { type: "string", description: "Optional; default 'Application: <role> — Preston Zen'" },
        resume_id: { type: "number", description: "Optional resume bank id; default is the best match for the role" },
      },
      required: ["id", "body"],
    },
  },
  {
    name: "request_code",
    description:
      "The form wants an emailed verification/security code. FALLBACK path: if your machine notes offer an inbox helper (inbox-assist.mjs), use that first — Preston may be asleep. Otherwise this asks Preston on Telegram; he reads it from his inbox and replies. Then call wait_for_code. Never guess codes.",
    inputSchema: {
      type: "object",
      properties: { job_id: str, kind: { type: "string", description: "e.g. 'Greenhouse security code'" }, hint: { type: "string", description: "Anything that helps him find it, e.g. the sender or subject" } },
      required: ["job_id"],
    },
  },
  {
    name: "wait_for_code",
    description: "Wait up to ~25 s for the code behind request_code. Keep calling while status is 'pending' — the hub's inbox sync answers most requests within 2–10 minutes, so do NOT give up before status becomes 'answered' or 'expired' (30 min). When 'answered', type the code exactly and submit; if 'expired', report needs_human with 'code never arrived'.",
    inputSchema: { type: "object", properties: { request_id: str }, required: ["request_id"] },
  },
  {
    name: "get_job",
    description: "Fresh status and details of one job (from ClickUp), including who holds it.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
  },
  {
    name: "renew_lease",
    description: "Extend your claim on a job that is taking a while.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
  },
  {
    name: "report_result",
    description:
      "Report the outcome of a claimed job. applied = submitted; needs_human = blocked on something only Preston can do (note required); skipped = not a fit per the playbook rules (note required); failed = technical failure: the hub hands the job to Kimi with your log (a second failure parks it for Preston). For failed / needs_human also send `log`.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        outcome: { type: "string", enum: [...OUTCOMES] },
        platform: { type: "string", description: "The site/ATS where the form was actually submitted, e.g. Greenhouse, Ashby, Lever, Workable, Rippling, Workday, SmartRecruiters, Breezy, JazzHR, Work at a Startup, Email to employer, or \"Company site\" for the company's own custom form. Never \"Other\". Defaults to the job's ATS or apply link." },
        note: { type: "string", description: "Anything notable: skipped questions, verification code pending, blocker details." },
        log: { type: "string", description: "For failed / needs_human: your action log (URL reached, each field and the answer you gave, essays in full, exactly where and why you stopped). A failed job goes to Kimi automatically and Kimi reads this first." },
      },
      required: ["id", "outcome"],
    },
  },
  {
    name: "release_job",
    description: "Give a claimed job back to the queue without an outcome (e.g. you are stopping early).",
    inputSchema: { type: "object", properties: { id: str, note: str }, required: ["id"] },
  },
  {
    name: "add_job",
    description: "Add a posting you found to the shared queue. Returns the existing task instead if it is already tracked.",
    inputSchema: {
      type: "object",
      properties: {
        company: str,
        role: str,
        url: { type: "string", description: "Verified posting/application URL" },
        applyEmail: {type:"string",description:"Employer-advertised application address; never guessed"},
        ats: { type: "string", description: "Greenhouse / Ashby / Lever / …" },
        pay: str,
        travel: str,
        fit: { type: "string", description: 'e.g. "4/5 (voice agents)"' },
        notes: { type: "string", description: "Anything useful. For a posting you apply to by emailing the employer, include a line `Apply by email: jobs@company.com`." },
      },
      required: ["company", "role", "url"],
    },
  },
  {
    name: "log_application",
    description: "Log an application you already submitted for a posting that may not be in the queue. If it is queued, it is marked applied there instead of duplicated.",
    inputSchema: {
      type: "object",
      properties: { company: str, role: str, url: str, platform: str, notes: str },
      required: ["company", "role"],
    },
  },
];

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : undefined);

async function callTool(env: Env, agent: string, name: string, args: Args, origin: string, identity: string | null = null): Promise<unknown> {
  switch (name) {
    case "get_playbook":
      return await playbook(env);
    case "list_queue": {
      const q = await queue(env);
      const available = q.filter(isAvailable);
      return {
        available: available.length,
        claimed: q.filter((j) => j.claimedBy).map((j) => ({ id: j.id, name: j.name, by: j.claimedBy, until: j.claimExpiresAt })),
        needsHuman: q.filter((j) => j.needsHuman).length,
        next: available.slice(0, Number(args.limit) || 10).map((j) => ({ id: j.id, name: j.name, ats: j.ats, fit: j.fit })),
      };
    }
    case "claim_jobs":
      return await claimJobs(env, agent, {
        count: Number(args.count) || 1,
        ats: Array.isArray(args.ats) ? args.ats.map(String) : undefined,
      }, identity);
    case "get_resume": {
      const pick = await pickResume(env, String(args.role ?? ""), s(args.description));
      if (!pick) return { error: "resume bank is empty; use the resume named in the playbook" };
      return { ...pick, runnerPath: `./resumes/${pick.filename}`, downloadUrl: `${origin}/api/agent/resumes/${pick.id}/file` };
    }
    case "make_cover_letter":
      return await makeCoverLetter(env, agent, origin, { id: s(args.id), text: s(args.text) });
    case "save_prep_kit":
      return await saveKit(env, agent, origin, { id: s(args.id), form_url: s(args.form_url), resume_id: args.resume_id as number | undefined, cover_letter: s(args.cover_letter), answers: args.answers, notes: s(args.notes) });
    case "handoff_job":
      return await handoffJob(env, agent, String(args.id), String(args.reason ?? ""), s(args.to) ?? undefined, false, s(args.log), identity);
    case "send_application_email":
      return await sendApplicationEmail(env, agent, String(args.id), { body: s(args.body), subject: s(args.subject), resumeId: Number(args.resume_id) || null }, identity);
    case "request_code": {
      const job = await jobById(env, String(args.job_id)).catch(() => null);
      const r = await requestCode(env, { agent, jobId: job?.id ?? String(args.job_id), jobName: job?.name ?? null, kind: s(args.kind), hint: s(args.hint) });
      return { request_id: r.id, status: r.status, expiresAt: new Date(r.expiresAt).toISOString(), next: "call wait_for_code with this request_id until answered" };
    }
    case "wait_for_code":
      return await waitForCode(env, String(args.request_id), agent);
    case "get_job":
      return await getJob(env, String(args.id));
    case "renew_lease":
      return await renewLease(env, agent, String(args.id));
    case "report_result":
      return await reportResult(env, agent, String(args.id), {
        outcome: String(args.outcome) as Outcome,
        platform: s(args.platform),
        note: s(args.note),
        log: s(args.log),
      }, false, identity);
    case "release_job":
      await releaseJob(env, agent, String(args.id), s(args.note), false, identity);
      return { ok: true };
    case "add_job":
      if (!s(args.company) || !s(args.role)) throw new HttpError(400, "company and role are required");
      return await addJob(env, agent, {
        company: String(args.company),
        role: String(args.role),
        url: s(args.url),
        ats: s(args.ats),
        pay: s(args.pay),
        travel: s(args.travel),
        fit: s(args.fit),
        notes: s(args.notes),
      }, identity);
    case "log_application":
      if (!s(args.company) || !s(args.role)) throw new HttpError(400, "company and role are required");
      return await logApplication(env, agent, {
        company: String(args.company),
        role: String(args.role),
        url: s(args.url),
        platform: s(args.platform),
        notes: s(args.notes),
      }, identity);
    default:
      throw new HttpError(404, `unknown tool ${name}`);
  }
}

async function handleOne(env: Env, agent: string, origin: string, msg: RpcRequest, identity: string | null = null): Promise<object | null> {
  if (msg.id === undefined || msg.id === null) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "job-agent-hub", title: "Job Agent Hub", version: "0.2.0" },
        instructions: agentInstructions(agent, origin, "mcp"),
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Args;
      try {
        const result = await callTool(env, agent, name, args, origin, identity);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return ok({ content: [{ type: "text", text }] });
      } catch (err) {
        // Tool errors go back to the model as results so it can react (e.g. "claimed by codex").
        const message = err instanceof HttpError ? err.message : "internal error";
        if (!(err instanceof HttpError)) console.error(err);
        return ok({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: Env, agent: string, identity: string | null = null): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("This MCP server supports POST only (stateless Streamable HTTP).", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  let body: RpcRequest | RpcRequest[];
  try {
    body = (await request.json()) as RpcRequest | RpcRequest[];
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const origin = new URL(request.url).origin;
  const msgs = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(msgs.map((m) => handleOne(env, agent, origin, m, identity)))).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}
