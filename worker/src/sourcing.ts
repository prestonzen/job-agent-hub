import { db } from "./db";
import { cancelRun, createRun, getRun, listRunners, listRuns } from "./runs";
import { eligibleAgents, taskSwitches, workSettings, type WorkSettings } from "./work";
import type { Env } from "./types";
import { notify } from "./telegram";

const SCHEMA = `CREATE TABLE IF NOT EXISTS source_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL, due_at INTEGER NOT NULL,
  prompt TEXT NOT NULL, preferred_agent TEXT, status TEXT NOT NULL DEFAULT 'pending',
  run_id INTEGER, attempted_agents TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, detail TEXT,
  UNIQUE(schedule_id, due_at))`;
export async function sourceDb(env: Env) { const d = await db(env); await d.prepare(SCHEMA).run(); return d; }
export async function queueSourceCheck(env: Env, schedule: { id: number; agent: string | null; prompt: string | null }, due: number) {
  await (await sourceDb(env)).prepare("INSERT OR IGNORE INTO source_checks (schedule_id,due_at,prompt,preferred_agent) VALUES (?,?,?,?)").bind(schedule.id, due, schedule.prompt ?? SOURCE_PROMPT, schedule.agent).run();
}

export const SOURCE_PROMPT = `EMAIL APPLICATION SOURCING ONLY. Check the Job Hunter queue and find up to 15 NEW fully remote US-compatible AI development, agent engineering, AI platform or full-stack AI product roles whose employer publicly and explicitly invites applications by email. Do not apply in this run. Read get_playbook and follow its current location, work authorization, target and skip rules. Search public hiring posts on Reddit (forhire, remotejobs, relevant AI/developer communities), accessible Discord hiring channels, community job boards, and employer careers pages. Community posts are leads: verify the employer, posting freshness, fully remote eligibility, the exact advertised application address, and its instructions. Check existing tracker records before adding. Use add_job only for verified email-application roles, with company, role, original posting URL, applyEmail, ATS='Email', advertised salary range or 'Not disclosed', travel and fit. Store source post URL, source platform, checked date and exact email instructions in notes. Do not add ATS-only listings to this check; the queue already holds traditional applications. Never guess email addresses, join private servers, send DMs, scrape private communities, or invent resume facts, salary or submission evidence. Avoid cyber investigation roles. If no new verified email roles exist, report zero, the sources checked and blockers; finish normally without filling slots with ATS links. Stop after 15 new additions or 45 minutes. This is a sourcing check, not an application run.`;

interface Check { id: number; schedule_id: number; due_at: number; prompt: string; preferred_agent: string | null; status: string; run_id: number | null; attempted_agents: string; attempts: number; next_try: number; lease_until: number; detail: string | null }
/** Persistent occurrences survive outages; a failed/offline/exhausted agent doesn't consume the check. */
export async function processSourceChecks(env: Env): Promise<number> {
  const d = await sourceDb(env), now = Date.now();
  const settings = await workSettings(env);
  if (settings.enabled === false) return 0;
  const { results: checks } = await d.prepare("SELECT c.* FROM source_checks c JOIN schedules s ON s.id=c.schedule_id WHERE s.enabled=1 AND c.status IN ('pending','running') AND c.next_try<=? AND c.lease_until<? ORDER BY c.due_at LIMIT 8").bind(now, now).all<Check>();
  let launched = 0;
  for (const c of checks) {
    const won = await d.prepare("UPDATE source_checks SET lease_until=? WHERE id=? AND lease_until<?").bind(now + 90_000, c.id, now).run();
    if (won.meta.changes !== 1) continue;
    let partialAdded = 0;
    let emptySuccess = false;
    try {
      const [runners, runs] = await Promise.all([listRunners(env), listRuns(env, 200)]);
      const dispatchKey=`source:${c.id}:${c.attempts}`;
      if (!c.run_id) {
        // Recover an accepted run if a transient DB error interrupted the check/run link write.
        const reserved=await d.prepare("SELECT id,agent FROM runs WHERE dispatch_key=?").bind(dispatchKey).first<{id:number;agent:string}>();
        if(reserved){
          const tried=JSON.parse(c.attempted_agents) as string[];
          await d.prepare("UPDATE source_checks SET status='running',run_id=?,attempted_agents=?,attempts=?,next_try=0,detail=? WHERE id=?").bind(reserved.id,JSON.stringify([...new Set([...tried,reserved.agent])]),c.attempts+1,`Recovered dispatch to ${reserved.agent} after interrupted check update`,c.id).run();
          continue;
        }
      }
      if (c.run_id) {
        const run = await getRun(env, c.run_id);
        partialAdded = run.outcome?.added ?? 0;
        if (run.status === "running") {
          const owner = runners.find((r) => r.name === run.runner);
          const expired = run.startedAt && now-Date.parse(run.startedAt)>55*60_000;
          if (owner?.online && !expired) continue;
          // The runner is lost. Cancel ownership before handing sourcing to a different agent.
          await cancelRun(env, run.id);
          await d.prepare("UPDATE runs SET status='failed',finished_at=?,cancel=1,log=log||? WHERE id=? AND status='running'").bind(now,expired?'\n[hub] sourcing reached its 55 minute recovery limit; trying a backup.\n':'\n[hub] sourcing runner went offline; trying a backup.\n',run.id).run();
        } else if (run.status === "queued") {
          const available = settings.agents?.[run.agent] !== false && taskEnabled(settings,run.agent) && runners.some((r) => r.online && r.busy < r.slots && r.agents.some((a) => a.id === run.agent && a.ready));
          if (available || now - Date.parse(run.createdAt) < 120_000) continue;
          await cancelRun(env, run.id);
        } else if (run.status === "succeeded" && partialAdded > 0) {
          await d.prepare("UPDATE source_checks SET status='succeeded',detail=? WHERE id=?").bind(`${partialAdded} new roles recorded`, c.id).run();
          continue;
        }
        emptySuccess = run.status === "succeeded" && partialAdded === 0;
        await d.prepare("UPDATE source_checks SET status='pending',run_id=NULL,detail=? WHERE id=?").bind(`${run.agent}: ${run.summary ?? run.status}; trying a backup`, c.id).run();
      }
      const { results: rests } = await d.prepare("SELECT agent,next_after FROM autopilot_state").all<{ agent: string; next_after: number }>().catch(() => ({ results: [] }));
      // Quota rests block sourcing. Normal application pacing doesn't block a sourcing check.
      const cooldowns = new Map(rests.filter((r) => runs.find((x) => x.agent === r.agent && (x.status === "failed" || x.status === "succeeded"))?.exitCode === 429).map((r) => [r.agent, r.next_after]));
      const tried = JSON.parse(c.attempted_agents) as string[];
      const candidates = eligibleAgents(runners, runs.filter((r) => r.id !== c.run_id), settings, "sourcing", cooldowns, now).filter((a) => !tried.includes(a));
      candidates.sort((a, b) => Number(b === c.preferred_agent) - Number(a === c.preferred_agent));
      const capacity = runs.filter((r) => r.id !== c.run_id && (r.status === "queued" || r.status === "running")).length < (settings.maxConcurrent ?? 2);
      const roster = [...new Set(runners.flatMap((r)=>r.agents.filter((a)=>a.ready).map((a)=>a.id)))].filter((a)=>settings.agents?.[a]!==false&&taskEnabled(settings,a));
      if (c.attempts >= 8 || (tried.length > 0 && roster.length > 0 && roster.every((a)=>tried.includes(a)))) {
        if (emptySuccess) {
          await d.prepare("UPDATE source_checks SET status='no_new_roles',detail=? WHERE id=?").bind(`No new verified email roles recorded after ${tried.length} available agent${tried.length===1?'':'s'} searched`,c.id).run();
        } else {
          const detail = `Backups exhausted after ${tried.length} agent attempts; ${partialAdded} partial role${partialAdded===1?'':'s'} recorded before the last failure`;
          await d.prepare("UPDATE source_checks SET status='exhausted',detail=? WHERE id=?").bind(detail,c.id).run();
          await notify(env, `⚠️ Sourcing check #${c.id}: ${detail}. Review the sourcing result in the admin Run agents tab.`);
        }
      } else if (!candidates.length || !capacity) {
        await d.prepare("UPDATE source_checks SET next_try=?,detail=? WHERE id=?").bind(now + 60_000, !capacity ? "Waiting for a free task slot" : "Waiting for an enabled online agent with sourcing enabled", c.id).run();
      } else {
        const agent = candidates[0];
        const run = await createRun(env, { agent, kind: "prompt", task: "sourcing", prompt: c.prompt, exclusive: true,dispatchKey });
        await d.prepare("UPDATE source_checks SET status='running',run_id=?,attempted_agents=?,attempts=attempts+1,next_try=0,detail=? WHERE id=?").bind(run.id, JSON.stringify([...tried, run.agent]), `Checking with ${run.agent}; backups eligible automatically`, c.id).run();
        launched++;
      }
    } catch (e) {
      await d.prepare("UPDATE source_checks SET next_try=?,detail=? WHERE id=?").bind(now + 60_000, `Will retry: ${(e as Error).message.slice(0, 200)}`, c.id).run();
    } finally { await d.prepare("UPDATE source_checks SET lease_until=0 WHERE id=?").bind(c.id).run(); }
  }
  return launched;
}

const taskEnabled = (s: WorkSettings, a: string) => taskSwitches(s,a).sourcing;

export async function sourceCheckStatus(env: Env) {
  const { results } = await (await sourceDb(env)).prepare("SELECT id,schedule_id,due_at,status,run_id,attempted_agents,attempts,detail FROM source_checks ORDER BY due_at DESC LIMIT 12").all();
  return results;
}
