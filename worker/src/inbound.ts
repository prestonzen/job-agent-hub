import { isApplication } from "./classify";
import { addComment, setStatus } from "./clickup";
import { db, logEvent } from "./db";
import { loadTasks } from "./jobs";
import { companyKey } from "./pacing";
import { splitName } from "./sanitize";
import { esc, notify } from "./telegram";
import type { Env, Task } from "./types";

/**
 * Reply tracking. A Gmail Apps Script (integrations/gmail-reply-tracker.gs) posts new mail sent to
 * the application address here. Each message is classified (Workers AI, keyword fallback), matched to
 * its application by company, and the ClickUp status moves: rejection → rejected / paused,
 * interview/assessment → screening, offer → accepted. Telegram gets the interesting ones.
 */

export const CATEGORIES = ["rejection", "interview", "assessment", "offer", "confirmation", "recruiter", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface InboundEmail {
  id: string;
  from: string;
  subject: string;
  date?: string;
  text: string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS inbound (
  message_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  from_addr TEXT,
  subject TEXT,
  category TEXT,
  company TEXT,
  task_id TEXT,
  action TEXT,
  summary TEXT
)`;

let ready = false;
async function idb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.prepare(SCHEMA).run();
    ready = true;
  }
  return d;
}

const RULES: [Category, RegExp][] = [
  ["offer", /\b(offer letter|pleased to offer|extend (you )?an offer)\b/i],
  ["rejection", /\b(unfortunately|not (to )?(move|moving) forward|decided to (pursue|move forward with) other|position has been filled|no longer considering|will not be moving)\b/i],
  ["assessment", /\b(assessment|coding (challenge|exercise)|take[- ]home|hackerrank|codesignal|codility)\b/i],
  ["interview", /\b(schedule (a|an|your) (call|interview|chat)|interview|phone screen|availability|calendly\.com|goodtime|meet with)\b/i],
  ["confirmation", /\b(thank(s| you) for (applying|your application|your interest)|application (has been )?received|we('ve| have) received your application)\b/i],
];

function ruleClassify(e: InboundEmail): Category {
  const hay = `${e.subject}\n${e.text.slice(0, 4000)}`;
  for (const [cat, re] of RULES) if (re.test(hay)) return cat;
  return "other";
}

async function aiClassify(env: Env, e: InboundEmail): Promise<{ category: Category; company: string | null; summary: string } | null> {
  if (!env.AI) return null;
  try {
    const out = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content:
            "You triage emails received by a job applicant. Reply with JSON only: " +
            '{"category": one of ' + JSON.stringify(CATEGORIES) + ', "company": the hiring company name or null, "summary": one short sentence}. ' +
            "rejection = they are not moving forward; interview = they want to schedule a call/interview; assessment = a test or take-home; " +
            "offer = a job offer; confirmation = automatic 'we received your application'; recruiter = unsolicited outreach; other = anything else.",
        },
        { role: "user", content: `From: ${e.from}\nSubject: ${e.subject}\n\n${e.text.slice(0, 6000)}` },
      ],
      max_tokens: 200,
    })) as { response?: string | object };
    const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response ?? {});
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { category?: string; company?: string | null; summary?: string };
    const category = (CATEGORIES as readonly string[]).includes(j.category ?? "") ? (j.category as Category) : null;
    return category ? { category, company: j.company?.trim() || null, summary: (j.summary ?? "").slice(0, 300) } : null;
  } catch (err) {
    console.error("AI classify failed:", err);
    return null;
  }
}

/** Find the application this email is about: company named by the classifier, else any tracked company in the text. */
function matchTask(tasks: Task[], company: string | null, e: InboundEmail, includeQueued = false): Task | null {
  // Confirmations may be for jobs applied outside the hub (still "not started"); other replies only for applied ones.
  const apps = includeQueued ? tasks : tasks.filter((t) => t.status !== "not started");
  const byKey = (k: string) => apps.find((t) => companyKey(splitName(t.name).company) === k) ?? null;
  if (company) {
    const hit = byKey(companyKey(company));
    if (hit) return hit;
  }
  const hay = ` ${companyKey(`${e.from} ${e.subject} ${e.text.slice(0, 3000)}`)} `;
  let best: Task | null = null;
  for (const t of apps) {
    const k = companyKey(splitName(t.name).company);
    if (k.length >= 3 && hay.includes(` ${k} `) && (!best || k.length > companyKey(splitName(best.name).company).length)) best = t;
  }
  return best;
}

const NEXT_STATUS: Partial<Record<Category, string>> = { rejection: "rejected / paused", interview: "screening", assessment: "screening", offer: "accepted", confirmation: "applied" };
const ICON: Record<Category, string> = { rejection: "❌", interview: "🗓️", assessment: "📝", offer: "🎉", confirmation: "📨", recruiter: "👋", other: "✉️" };

export async function handleInbound(env: Env, e: InboundEmail): Promise<{ duplicate?: boolean; category: Category; taskId: string | null; action: string }> {
  const d = await idb(env);
  if (!e.id) throw new Error("id is required");
  const seen = await d.prepare("SELECT category, task_id, action FROM inbound WHERE message_id = ?").bind(e.id).first<{ category: Category; task_id: string | null; action: string }>();
  if (seen) return { duplicate: true, category: seen.category, taskId: seen.task_id, action: seen.action };

  const ai = await aiClassify(env, e);
  const category = ai?.category ?? ruleClassify(e);
  const summary = ai?.summary || e.subject;
  const tasks = (await loadTasks(env)).filter((t) => isApplication(t, env));
  const task = category === "recruiter" || category === "other" ? null : matchTask(tasks, ai?.company ?? null, e, category === "confirmation");

  let action = "none";
  if (task) {
    const next = NEXT_STATUS[category];
    // Never move an application backwards (e.g. a late confirmation after an interview invite).
    // A confirmation for a queued job means someone applied outside the hub: mark it applied so no agent re-applies.
    const order = ["not started", "applied", "screening", "accepted", "earning"];
    const forward = next && (next === "rejected / paused" ? task.status !== "rejected / paused" : order.indexOf(next) > order.indexOf(task.status));
    if (env.MOCK !== "true") {
      if (forward) await setStatus(env, task.id, next!);
      await addComment(env, task.id, `[hub] ${ICON[category]} Email (${category}) from ${e.from}: "${e.subject}"\n${summary}`);
    }
    action = forward ? `status → ${next}` : "comment";
    await logEvent(env, { agent: "inbox", taskId: task.id, taskName: task.name, type: `reply:${category}`, message: summary });
  }

  await d
    .prepare("INSERT INTO inbound (message_id, at, from_addr, subject, category, company, task_id, action, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(e.id, Date.now(), e.from.slice(0, 200), e.subject.slice(0, 300), category, ai?.company ?? null, task?.id ?? null, action, summary)
    .run();

  if (category !== "confirmation" && category !== "other") {
    const loud = category === "interview" || category === "assessment" || category === "offer";
    const where = task ? `<a href="${task.url}">${esc(task.name)}</a> · ${esc(action)}` : "⚠️ couldn't match this to an application";
    await notify(env, `${ICON[category]} <b>${esc(category)}</b>: ${esc(e.subject)}\n${where}\n<i>${esc(summary)}</i>`, { silent: !loud });
  }
  return { category, taskId: task?.id ?? null, action };
}

export async function recentInbound(env: Env, limit = 50) {
  const { results } = await (await idb(env))
    .prepare("SELECT message_id, at, from_addr, subject, category, company, task_id, action, summary FROM inbound ORDER BY at DESC LIMIT ?")
    .bind(limit)
    .all();
  return results;
}
