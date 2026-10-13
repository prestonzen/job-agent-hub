import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { db, logEvent, setSetting } from "../worker/src/db";
import { createRun, claimRun, finishRun, getRun, listRuns, quotaStop, runnerHeartbeat } from "../worker/src/runs";
import { createSchedule, listSchedules, nextRun, tick } from "../worker/src/schedules";
import { processSourceChecks, queueSourceCheck, sourceDb } from "../worker/src/sourcing";
import { autopilotStatus, saveAutopilot } from "../worker/src/autopilot";
import { eligibleAgents, EMPTY_OUTCOME, outcomeSummary, taskSwitches } from "../worker/src/work";
import { inLane } from "../worker/src/lanes";
import type { Env, Job } from "../worker/src/types";
import { resolveIdentity, identityId, agentName } from "../worker/src/auth";
import { cyberDb, completeCyber } from "../worker/src/cyber";
import { logApplication } from "../worker/src/jobs";

const sqlite = new DatabaseSync(":memory:");
const D1 = {
  prepare(sql: string) { return { args: [] as unknown[], bind(...args: unknown[]) { this.args=args;return this; },
    async first() { return sqlite.prepare(sql).get(...this.args as []) ?? null; },
    async all() { return {results:sqlite.prepare(sql).all(...this.args as [])}; },
    async run() { const r=sqlite.prepare(sql).run(...this.args as []);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}; },
  }; },
  async batch(stmts: {run:()=>Promise<unknown>}[]) { const results=[];for(const s of stmts)results.push(await s.run());return results; },
};
const env = {DB:D1,MOCK:"false",AGENT_TOKENS:"{}",LEASE_MINUTES:"60"} as unknown as Env;
await db(env);await listRuns(env,1);await listSchedules(env);await sourceDb(env);
sqlite.exec("CREATE TABLE IF NOT EXISTS autopilot_state (agent TEXT PRIMARY KEY,next_after INTEGER NOT NULL DEFAULT 0)");
beforeEach(async()=>{
  for(const table of ["runs","runners","events","settings","source_checks","schedules","autopilot_state","claims"])sqlite.exec(`DELETE FROM ${table}`);
  await setSetting(env,"autopilot",{enabled:true,maxConcurrent:2,agents:{claude:false},tasks:{}});
});
async function online(name="kloud",agents=["codex","mistral"],busy=0){await runnerHeartbeat(env,{name,slots:2,busy,active:[],agents:agents.map(id=>({id,installed:true,signedIn:id==='ollama'?null:true,ready:true}))});}
async function source(preferred:string|null="codex") {
  const s=await createSchedule(env,{kind:"sourcing",agent:preferred??undefined,cron:"0 8,20 * * *",tz:"Asia/Tokyo"});
  await queueSourceCheck(env,s,Date.now()-1000);return s;
}
function check(){return sqlite.prepare("SELECT * FROM source_checks ORDER BY id DESC LIMIT 1").get() as Record<string,unknown>;}

test("twice daily is 08:00 and 20:00 in the saved timezone",()=>{
  assert.equal(new Date(nextRun("0 8,20 * * *","Asia/Tokyo",Date.parse("2026-10-12T00:00:00Z"))!).toISOString(),"2026-10-12T11:00:00.000Z");
  assert.equal(new Date(nextRun("0 8,20 * * *","Asia/Tokyo",Date.parse("2026-10-12T11:00:00Z"))!).toISOString(),"2026-10-12T23:00:00.000Z");
});
test("a disabled preferred agent falls back to an online enabled agent",async()=>{
  await online();await source("claude");assert.equal(await processSourceChecks(env),1);const r=await getRun(env,Number(check().run_id));assert.notEqual(r.agent,"claude");assert.equal(r.task,"sourcing");
});
test("a check persists through an outage and runs when a runner returns",async()=>{
  await source();assert.equal(await processSourceChecks(env),0);assert.equal(check().status,"pending");await online();sqlite.exec("UPDATE source_checks SET next_try=0");assert.equal(await processSourceChecks(env),1);
});
test("concurrent heartbeats and duplicate schedule occurrences launch one sourcing run",async()=>{
  await online();const s=await source();const due=Number(check().due_at);await queueSourceCheck(env,s,due);
  await Promise.all([processSourceChecks(env),processSourceChecks(env)]);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM source_checks").get()!.n,1);assert.equal((await listRuns(env)).length,1);
});
test("quota failure rests the first agent and starts a backup",async()=>{
  await online();await source();await processSourceChecks(env);const first=await claimRun(env,"kloud",["codex","mistral"],"https://example.invalid");assert.equal(first!.agent,"codex");
  sqlite.prepare("UPDATE runs SET log=? WHERE id=?").run("You've hit your weekly limit",first!.id);await finishRun(env,first!.id,"kloud",{exitCode:1});
  await processSourceChecks(env);const backup=await getRun(env,Number(check().run_id));assert.equal(backup.agent,"mistral");assert.equal(check().attempts,2);assert.equal((await getRun(env,first!.id)).exitCode,429);
});
test("zero-exit sourcing without recorded new roles tries a backup",async()=>{
  await online();await source();await processSourceChecks(env);const first=await claimRun(env,"kloud",["codex"],"https://example.invalid");await finishRun(env,first!.id,"kloud",{exitCode:0});await processSourceChecks(env);assert.equal((await getRun(env,Number(check().run_id))).agent,"mistral");
});
test("recorded sourcing additions complete the occurrence",async()=>{
  await online();await source();await processSourceChecks(env);const r=await claimRun(env,"kloud",["codex"],"https://example.invalid");await logEvent(env,{agent:"codex",type:"added",taskId:"real-record"});await finishRun(env,r!.id,"kloud",{exitCode:0});await processSourceChecks(env);assert.equal(check().status,"succeeded");assert.equal((await getRun(env,r!.id)).outcome!.added,1);
});
test("turning an agent off cancels its queued sourcing task and falls back",async()=>{
  await online();await source();await processSourceChecks(env);const first=Number(check().run_id);await saveAutopilot(env,{agents:{codex:false}});assert.equal((await getRun(env,first)).status,"cancelled");await processSourceChecks(env);assert.equal((await getRun(env,Number(check().run_id))).agent,"mistral");
});
test("signed-in agents with no permitted application work are idle, not ready",async()=>{
  await online();await setSetting(env,"autopilot",{enabled:true,tasks:{codex:{applications:false,email:false,sourcing:true,cyber:true}}});const s=await autopilotStatus({...env,MOCK:"true"});const a=s.agents.find(a=>a.agent==='codex')!;assert.equal(a.signedIn,true);assert.equal(a.state,'idle');
});
test("busy, quota-limited, signed-out and sourcing-disabled agents are not fallback candidates",()=>{
  const runners=[{name:'host',online:true,slots:2,busy:0,agents:[{id:'codex',installed:true,signedIn:true,ready:true},{id:'mistral',installed:true,signedIn:false,ready:true}]}] as Parameters<typeof eligibleAgents>[0];
  assert.deepEqual(eligibleAgents(runners,[],{tasks:{codex:{sourcing:false}}},'sourcing',new Map()),[]);assert.deepEqual(eligibleAgents(runners,[],{},'sourcing',new Map([['codex',Date.now()+10000]])),[]);
  assert.deepEqual(eligibleAgents(runners,[{agent:'codex',status:'running'}] as Parameters<typeof eligibleAgents>[1],{},'sourcing',new Map()),[]);
});
test("task switches distinguish web, email and cyber work",async()=>{
  const web={applyUrl:'https://example.invalid',applyEmail:null,ats:'Ashby'} as Job,email={...web,applyEmail:'jobs@example.invalid'} as Job;
  assert.equal(inLane(web,'email'),false);assert.equal(inLane(email,'email'),true);assert.equal(inLane(email,'web'),false);assert.equal(inLane(web,'none'),false);
  await setSetting(env,'autopilot',{enabled:true,tasks:{codex:{cyber:false}}});await assert.rejects(createRun(env,{agent:'codex',kind:'prompt',task:'cyber',prompt:'draft only'}),/switched off/);assert.equal(taskSwitches({},'gemini').applications,false);
});
test("process success and diagnostics never imply application success",()=>{
  assert.match(outcomeSummary('applications','succeeded',EMPTY_OUTCOME),/no work result/);assert.match(outcomeSummary('diagnostic','succeeded',EMPTY_OUTCOME),/no application work/);assert.match(outcomeSummary('applications','failed',{...EMPTY_OUTCOME,applied:1,blocked:2}),/1 application reported submitted.*2 need review.*process failed/);assert.ok(quotaStop("You've hit your weekly limit"));
});
test("ambiguous concurrent runs do not get duplicate outcome credit",async()=>{
  const a=await createRun(env,{agent:'codex',kind:'prompt',prompt:'custom'}),b=await createRun(env,{agent:'codex',kind:'prompt',prompt:'custom'});sqlite.prepare("UPDATE runs SET status='running',started_at=? WHERE id IN (?,?)").run(Date.now(),a.id,b.id);await logEvent(env,{agent:'codex',type:'applied'});assert.equal((await getRun(env,a.id)).outcome!.applied,0);assert.equal((await getRun(env,b.id)).outcome!.applied,0);
});
test("a twice-daily schedule creates a durable occurrence even with no runner online",async()=>{
  const s=await createSchedule(env,{kind:'sourcing',cron:'0 8,20 * * *',tz:'Asia/Tokyo'});sqlite.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(Date.now()-1000,s.id);await tick(env,async()=>{});assert.equal(check().status,'pending');assert.equal((await listRuns(env)).length,0);
});
test("a lost runner releases sourcing to a different online agent",async()=>{
  await online('primary',['codex']);await online('backup',['mistral']);await source();await processSourceChecks(env);const r=await claimRun(env,'primary',['codex'],'https://example.invalid');sqlite.prepare("UPDATE runners SET last_seen=? WHERE name='primary'").run(Date.now()-180000);await processSourceChecks(env);assert.equal((await getRun(env,r!.id)).status,'failed');assert.equal((await getRun(env,Number(check().run_id))).agent,'mistral');
});
test("automatic dispatch never exceeds fleet capacity",async()=>{
  await online();await createRun(env,{agent:'codex',kind:'prompt',prompt:'custom',exclusive:true});await createRun(env,{agent:'mistral',kind:'prompt',prompt:'custom',exclusive:true});await assert.rejects(createRun(env,{agent:'ollama',kind:'prompt',prompt:'custom',exclusive:true}),/capacity/);
});
test("disabled task types cannot be claimed even if queued before settings changed",async()=>{
  await createRun(env,{agent:'codex',kind:'prompt',task:'cyber',prompt:'draft only'});await setSetting(env,'autopilot',{enabled:true,tasks:{codex:{cyber:false}}});assert.equal(await claimRun(env,'host',['codex'],'https://example.invalid'),null);
});
test("provider UTC reset times prevent retrying a weekly limit after three hours",()=>{
  const oldNow=Date.now;Date.now=()=>Date.parse('2026-10-12T00:00:00Z');try {assert.equal(quotaStop("You've hit your weekly limit · resets Oct 13, 11am (UTC)")!.restMs,35*3600000+120000);}finally{Date.now=oldNow;}
});
test("an uppercase agent name cannot bypass its off switch",async()=>{
  await assert.rejects(createRun(env,{agent:'Claude',kind:'prompt',prompt:'custom'}),/switched off/);
});
test("historical reports are credited only for an unambiguous run window",async()=>{
  const a=await createRun(env,{agent:'codex',kind:'prompt',prompt:'custom'}),b=await createRun(env,{agent:'codex',kind:'prompt',prompt:'custom'});const now=Date.now();sqlite.prepare("UPDATE runs SET status='failed',started_at=?,finished_at=? WHERE id IN (?,?)").run(now-1000,now+1000,a.id,b.id);sqlite.prepare("INSERT INTO events(at,agent,type,task_id) VALUES(?,?,?,?)").run(now,'codex','applied','recorded-role');const migration=readFileSync('migrations/0004_recorded_outcomes.sql','utf8');sqlite.exec(migration);assert.equal((await getRun(env,a.id)).outcome!.applied,0);sqlite.prepare('DELETE FROM runs WHERE id=?').run(b.id);sqlite.exec(migration);assert.equal((await getRun(env,a.id)).outcome!.applied,1);
});
test("partial results identify unfinished jobs separately from process failure",async()=>{
  const r=await createRun(env,{agent:'codex',kind:'queue'});await claimRun(env,'host',['codex'],'https://example.invalid');await logEvent(env,{agent:'codex',type:'claimed',taskId:'a'});await logEvent(env,{agent:'codex',type:'claimed',taskId:'b'});await logEvent(env,{agent:'codex',type:'applied',taskId:'a'});await finishRun(env,r.id,'host',{exitCode:1});const result=await getRun(env,r.id);assert.equal(result.outcome!.applied,1);assert.equal(result.outcome!.unfinished,1);assert.match(result.summary!,/application reported submitted.*no final result.*process failed/);
});
test("passing diagnostics do not send routine completion messages",async()=>{
  let sent=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{sent++;return new Response(JSON.stringify({ok:true}));};try{const r=await createRun(env,{agent:'codex',kind:'prompt',task:'diagnostic',prompt:'health check'});await claimRun(env,'host',['codex'],'https://example.invalid');await finishRun({...env,TELEGRAM_BOT_TOKEN:'test',TELEGRAM_CHAT_ID:'test',TELEGRAM_THREAD_ID:'1'},r.id,'host',{exitCode:0});assert.equal(sent,0);}finally{globalThis.fetch=oldFetch;}
});
test("stalled sourcing moves to a backup after 55 minutes",async()=>{
  await online();await source();await processSourceChecks(env);const r=await claimRun(env,'kloud',['codex'],'https://example.invalid');sqlite.prepare('UPDATE runs SET started_at=? WHERE id=?').run(Date.now()-56*60000,r!.id);await processSourceChecks(env);assert.equal((await getRun(env,r!.id)).status,'failed');assert.equal((await getRun(env,Number(check().run_id))).agent,'mistral');
});
test("a DB failure after accepting dispatch is recovered without a duplicate run",async()=>{
  await online();await source();const prepare=D1.prepare;let injected=false;D1.prepare=function(sql){const p=prepare.call(this,sql);if(!injected&&sql.startsWith("UPDATE source_checks SET status='running',run_id")){p.run=async()=>{injected=true;throw new Error('simulated transient DB outage');};}return p;};try{await processSourceChecks(env);}finally{D1.prepare=prepare;}assert.equal((await listRuns(env)).length,1);assert.equal(check().run_id,null);sqlite.exec('UPDATE source_checks SET next_try=0');await processSourceChecks(env);assert.equal((await listRuns(env)).length,1);assert.ok(check().run_id);assert.equal(check().attempts,1);
});


// --- Identity resolution (Task 1) ---
{
  const TOK="x".repeat(30), TOK2="y".repeat(30), LEGACY="z".repeat(30);
  const idReq=(t?:string)=>new Request("https://h/api/agent/me", t?{headers:{Authorization:`Bearer ${t}`}}:undefined);
  const idEnv={AGENT_IDENTITIES:JSON.stringify({
    [TOK]:{user:"Roman",model:"Claude",approach:"Hermes",billing:{mode:"subscription",period:"weekly",quota:2000000}},
    [TOK2]:{user:"brandon",model:"codex",approach:"default",billing:{mode:"api"}},
  }),AGENT_TOKENS:JSON.stringify({kimi:LEGACY})} as unknown as Env;
  test("resolveIdentity reads the registry and lowercases the id",()=>{
    const i=resolveIdentity(idReq(TOK),idEnv)!;
    assert.equal(i.id,"roman/claude/hermes");assert.equal(i.model,"claude");
    assert.deepEqual(i.billing,{mode:"subscription",period:"weekly",quota:2000000});
  });
  test("AGENT_TOKENS entries resolve as single-user identities",()=>{
    const i=resolveIdentity(idReq(LEGACY),idEnv)!;assert.equal(i.id,"kimi/kimi/default");assert.equal(i.model,"kimi");
  });
  test("agentName stays the model for back-compat",()=>{
    assert.equal(agentName(idReq(TOK),idEnv),"claude");assert.equal(agentName(idReq(LEGACY),idEnv),"kimi");
  });
  test("unknown token and malformed registry are safe",()=>{
    assert.equal(resolveIdentity(idReq("short"),idEnv),null);assert.equal(resolveIdentity(idReq(),idEnv),null);
    const bad={AGENT_IDENTITIES:"{not json",AGENT_TOKENS:JSON.stringify({kimi:LEGACY})} as unknown as Env;
    assert.equal(resolveIdentity(idReq(LEGACY),bad)!.model,"kimi");
  });
  test("identityId builds the canonical string",()=>{
    assert.equal(identityId({user:"A",model:"B",approach:"C"}),"a/b/c");
  });
}


// --- Identity schema columns (Task 2) ---
test("identity columns exist after schema init",async()=>{
  await cyberDb(env);
  const cols=(t:string)=>sqlite.prepare(`PRAGMA table_info(${t})`).all().map((r:any)=>r.name);
  assert.ok(cols("events").includes("identity"),"events.identity");
  assert.ok(cols("runs").includes("identity"),"runs.identity");
  assert.ok(cols("cyber_work").includes("identity"),"cyber_work.identity");
  assert.ok(cols("cyber_review_passes").includes("identity"),"cyber_review_passes.identity");
});


// --- logEvent records identity (Task 3) ---
test("logEvent stores identity when provided",async()=>{
  await logEvent(env,{agent:"claude",type:"applied",identity:"roman/claude/hermes"} as any);
  const row:any=sqlite.prepare("SELECT agent, identity FROM events ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.agent,"claude");assert.equal(row.identity,"roman/claude/hermes");
});


// --- identity threaded to application reporting (Task 4) ---
test("logApplication tags the applied event with the identity",async()=>{
  const menv={...(env as any),MOCK:"true"} as unknown as Env;
  await logApplication(menv,"claude",{company:"Acme",role:"AI Eng",platform:"Ashby"} as any,"roman/claude/hermes" as any);
  const row:any=sqlite.prepare("SELECT agent, identity, type FROM events WHERE type='applied' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.agent,"claude");assert.equal(row.identity,"roman/claude/hermes");
});

// --- cyber pass credited to identity (Task 5) ---
test("completeCyber stamps the reviewing identity on the pass",async()=>{
  await cyberDb(env);
  const run=await createRun(env,{agent:"codex",kind:"prompt",task:"cyber",prompt:"cyber review"} as any);
  sqlite.exec(`UPDATE runs SET status='running' WHERE id=${run.id}`);
  sqlite.prepare("INSERT INTO cyber_work (source_key,created_at,program,platform,target,source,evidence,status,run_id,agent,pass_agents) VALUES ('k5',1,'P','H','t','s','ev','running',?,'codex','[\"codex\"]')").run(run.id);
  const wid:any=sqlite.prepare("SELECT id FROM cyber_work WHERE source_key='k5'").get();
  sqlite.prepare("INSERT INTO cyber_review_passes (work_id,sequence,agent,run_id,status,created_at) VALUES (?,1,'codex',?,'running',1)").run(wid.id,run.id);
  const result="Observed no trust boundary violation; the response was a public asset returning HTTP 200 with no sensitive data, so there is no exploitable impact.";
  await completeCyber(env,wid.id,"codex",{verdict:"reject",result},"roman/codex/hermes" as any);
  const pass:any=sqlite.prepare("SELECT identity FROM cyber_review_passes WHERE work_id=? AND sequence=1").get(wid.id);
  assert.equal(pass.identity,"roman/codex/hermes");
});
