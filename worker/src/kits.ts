import { HttpError } from "./clickup";
import { makeCoverLetter } from "./coverletters";
import { db } from "./db";
import { getJob, queue } from "./jobs";
import { parkedCategory } from "./park";
import { listResumes } from "./resumes";
import { createRun } from "./runs";
import type { Env, Job } from "./types";
import { taskSwitches, type WorkSettings } from "./work";

/**
 * Prep kits: everything a person needs to finish a parked application by copy/paste — the resume the agent
 * picked, a cover letter (text + PDF), every form question with its drafted answer, and a note on what only
 * Preston can do. Agents save one when they park a job; autopilot also sends an agent to prep kits for parked
 * jobs that have none (read the form, draft, save — never submit). The Assisted tab renders them.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS prep_kits (
  task_id TEXT PRIMARY KEY, agent TEXT NOT NULL, at INTEGER NOT NULL, form_url TEXT, resume_id INTEGER,
  cover_letter TEXT, cover_name TEXT, answers TEXT NOT NULL DEFAULT '[]', notes TEXT
)`;
let ready = false;
async function kdb(env: Env) {
  const d = await db(env);
  if (!ready) { await d.prepare(SCHEMA).run(); ready = true; }
  return d;
}

export interface KitAnswer { question: string; answer: string }
export interface Kit {
  taskId: string; agent: string; at: string; formUrl: string | null;
  resume: { id: number; name: string; filename: string; downloadPath: string } | null;
  coverLetter: string | null; coverPdf: { filename: string; downloadPath: string } | null;
  answers: KitAnswer[]; notes: string | null;
}
interface Row { task_id: string; agent: string; at: number; form_url: string | null; resume_id: number | null; cover_letter: string | null; cover_name: string | null; answers: string; notes: string | null }

export async function getKits(env: Env, ids: string[]): Promise<Map<string, Kit>> {
  const out = new Map<string, Kit>();
  if (!ids.length) return out;
  const d = await kdb(env);
  const [{ results }, resumes] = await Promise.all([
    d.prepare(`SELECT * FROM prep_kits WHERE task_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Row>(),
    listResumes(env).catch(() => []),
  ]);
  for (const r of results) {
    const res = resumes.find((x) => x.id === r.resume_id);
    let answers: KitAnswer[] = [];
    try { answers = JSON.parse(r.answers) as KitAnswer[]; } catch { /* keep empty */ }
    out.set(r.task_id, {
      taskId: r.task_id, agent: r.agent, at: new Date(r.at).toISOString(), formUrl: r.form_url,
      resume: res ? { id: res.id, name: res.name, filename: res.filename, downloadPath: `/api/admin/resumes/${res.id}/file` } : null,
      coverLetter: r.cover_letter, coverPdf: r.cover_name ? { filename: r.cover_name, downloadPath: `/api/admin/cover-letters/${encodeURIComponent(r.cover_name)}` } : null,
      answers, notes: r.notes,
    });
  }
  return out;
}

export interface KitInput { id?: string; form_url?: string; resume_id?: number | string | null; cover_letter?: string | null; answers?: unknown; notes?: string | null }

/** Save (or replace) the kit for a job. The cover letter, when long enough, is also typeset to a PDF. */
export async function saveKit(env: Env, agent: string, origin: string, a: KitInput): Promise<Kit> {
  if (!a.id) throw new HttpError(400, "id (the job) is required");
  const job = await getJob(env, a.id);
  const answers: KitAnswer[] = Array.isArray(a.answers)
    ? (a.answers as unknown[])
        .map((x) => (x && typeof x === "object" ? { question: String((x as KitAnswer).question ?? "").trim().slice(0, 500), answer: String((x as KitAnswer).answer ?? "").trim().slice(0, 6000) } : null))
        .filter((x): x is KitAnswer => !!x && !!x.question)
    : [];
  const cover = (a.cover_letter ?? "").replace(/\r/g, "").trim() || null;
  if (cover && /linkedin\.com|linkedtfin/i.test(cover)) throw new HttpError(400, "no LinkedIn URL in the cover letter; use https://portfolio.prestonzen.com");
  if (!answers.length && !cover && !a.resume_id) throw new HttpError(400, "a kit needs at least one of: answers, cover_letter, resume_id");
  let coverName: string | null = null;
  if (cover && cover.length >= 300) {
    const pdf = await makeCoverLetter(env, agent, origin, { id: job.id, text: cover }).catch(() => null);
    coverName = pdf ? pdf.key.slice("cover-letters/".length) : null;
  }
  const resumeId = a.resume_id == null || a.resume_id === "" ? null : Number(a.resume_id) || null;
  await (await kdb(env))
    .prepare(
      `INSERT INTO prep_kits (task_id, agent, at, form_url, resume_id, cover_letter, cover_name, answers, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (task_id) DO UPDATE SET agent = ?2, at = ?3, form_url = ?4, resume_id = ?5, cover_letter = ?6, cover_name = COALESCE(?7, prep_kits.cover_name), answers = ?8, notes = ?9`,
    )
    .bind(job.id, agent, Date.now(), (a.form_url ?? job.applyUrl ?? null)?.slice(0, 1000) ?? null, resumeId, cover?.slice(0, 8000) ?? null, coverName, JSON.stringify(answers), a.notes?.trim().slice(0, 2000) || null)
    .run();
  return (await getKits(env, [job.id])).get(job.id)!;
}

const NOT_WORKABLE = new Set(["Location, travel or eligibility", "Duplicate", "Already worked (status not updated)"]);

/** The run prompt that produces kits for parked jobs without one. Reads forms, drafts, saves — never submits. */
export const prepPrompt = (jobs: Job[]) =>
  `PREP KITS FOR PRESTON — no submissions in this run. These jobs are parked for a human; your job is to prepare everything so Preston can finish each one by copy/paste in a minute:\n` +
  jobs.map((j) => `- ${j.id}: ${j.name} — ${j.applyUrl ?? j.applyEmail ?? "(no link)"}${j.needsHuman ? ` [parked: ${j.needsHuman.slice(0, 120)}]` : ""}`).join("\n") +
  `\n\nFor EACH job: (1) get_job for details and previous attempts (reuse earlier answers). (2) Open the apply link in the browser and read every field, dropdown and question. Do NOT type into the form, do NOT upload, do NOT submit, do NOT solve any challenge — reading only. (3) get_resume with the title and posting text. (4) Write the cover letter per the playbook rule (3-4 short paragraphs, Preston's voice, facts from the Story pages only). (5) Answer every non-trivial question from the playbook and Answer Bank (essays in full, Preston's voice; dropdown answers as the exact option text). (6) Call save_prep_kit with id, form_url, resume_id, cover_letter, answers [{question, answer}] and notes listing anything only Preston can do (the human/AI attestation, a CAPTCHA, a code, an account). Do not claim the job and do not call report_result — it stays parked for Preston. Stop when every listed job has a kit, or after 35 minutes.`;

/** Autopilot hook: one prep run at a time, every 20 min at most, for up to 3 parked jobs without kits. */
export async function maybeLaunchPrep(env: Env, ctx: { settings: WorkSettings; readyAgents: string[]; busyAgents: Set<string>; prepInFlight: boolean }): Promise<string | null> {
  if (ctx.prepInFlight) return null;
  const d = await kdb(env);
  const gate = (await d.prepare("SELECT next_after FROM autopilot_state WHERE agent = '__prep__'").first<{ next_after: number }>().catch(() => null))?.next_after ?? 0;
  if (gate > Date.now()) return null;
  const parked = (await queue(env)).filter((j) => j.needsHuman && !j.claimedBy && !NOT_WORKABLE.has(parkedCategory(j.needsHuman ?? "")) && (j.applyUrl || j.applyEmail));
  if (!parked.length) return null;
  const kits = await getKits(env, parked.map((j) => j.id));
  const todo = parked.filter((j) => !kits.has(j.id)).slice(0, 3);
  if (!todo.length) return null;
  const PREPPERS = ["claude", "claude2", "kimi", "kimi2", "codex"];
  const agent = PREPPERS.find((a) => ctx.readyAgents.includes(a) && !ctx.busyAgents.has(a) && taskSwitches(ctx.settings, a).applications);
  if (!agent) return null;
  await d.prepare("INSERT OR IGNORE INTO autopilot_state (agent, next_after) VALUES ('__prep__', 0)").run();
  await d.prepare("UPDATE autopilot_state SET next_after = ?1 WHERE agent = '__prep__'").bind(Date.now() + 20 * 60_000).run();
  const run = await createRun(env, { agent, kind: "prompt", task: "prep", prompt: prepPrompt(todo) });
  return `prep run #${run.id} for ${agent}: ${todo.map((j) => j.company).join(", ")}`;
}

/** Admin: prep one job now. */
export async function prepNow(env: Env, id: string, agent: string): Promise<{ runId: number }> {
  const job = await getJob(env, id);
  const run = await createRun(env, { agent, kind: "prompt", task: "prep", prompt: prepPrompt([job]) });
  return { runId: run.id };
}
