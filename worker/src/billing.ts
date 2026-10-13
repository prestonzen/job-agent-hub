import { db, getSetting } from './db';
import type { Env } from './types';

export interface MonthlyBilling {
  billingMonth:string; monthlyPlanUsd:number|null; monthlyApplicationCostUsd:number|null;
  monthlyCostPerApplicationUsd:number|null; monthlyApplications:number; monthlyTokens:number;
  monthlyTokenCoverage:string; costBasis:string;
}

/** Allocate the fixed plan across tracked monthly token usage, including non-application work. */
export async function monthlyBilling(env:Env):Promise<Map<string,MonthlyBilling>>{
  const d=await db(env), month=new Date(Date.now()+9*3_600_000).toISOString().slice(0,7), since=Date.parse(`${month}-01T00:00:00+09:00`);
  const plans={kimi:31,codex:100,...await getSetting<Record<string,number>>(env,'subscription_monthly_usd')};
  const [{results:runs},{results:apps}]=await Promise.all([
    d.prepare(`SELECT agent,task,kind,tokens,cost_usd FROM runs WHERE created_at>=? AND started_at IS NOT NULL AND finished_at IS NOT NULL AND kind!='login'`).bind(since).all<{agent:string;task:string|null;kind:string;tokens:number|null;cost_usd:number|null}>(),
    d.prepare(`SELECT agent,COUNT(DISTINCT task_id) AS n FROM events WHERE at>=? AND type='applied' GROUP BY agent`).bind(since).all<{agent:string;n:number}>(),
  ]);
  const out=new Map<string,MonthlyBilling>();
  for(const agent of new Set([...runs.map(r=>r.agent),...apps.map(a=>a.agent),...Object.keys(plans)])){
    const mine=runs.filter(r=>r.agent===agent),application=mine.filter(r=>r.task==='applications'||r.task==='email'||(!r.task&&r.kind==='queue'));
    const total=mine.reduce((n,r)=>n+(r.tokens??0),0),appTokens=application.reduce((n,r)=>n+(r.tokens??0),0);
    const count=apps.find(a=>a.agent===agent)?.n??0, plan=(plans as Record<string,number>)[agent]??null;
    const recorded=application.filter(r=>r.cost_usd!==null);
    const cost=plan!==null?total>0&&(appTokens>0||!application.length)?plan*appTokens/total:null:recorded.length?recorded.reduce((n,r)=>n+r.cost_usd!,0):null;
    out.set(agent,{billingMonth:month,monthlyPlanUsd:plan,monthlyApplicationCostUsd:cost,monthlyCostPerApplicationUsd:cost!==null&&count?cost/count:null,
      monthlyApplications:count,monthlyTokens:total,monthlyTokenCoverage:`${mine.filter(r=>r.tokens!==null).length}/${mine.length} finished runs`,
      costBasis:plan!==null?'Subscription allocated by tracked monthly tokens; excludes usage outside this hub. Provisional if any run usage is missing.':'Reported application/email run charges only; missing charges are not zero.'});
  }
  return out;
}
