/** Versioned benchmark rubric. Scores judge the supplied evidence, not actual bounty success. */
export const CYBER_RUBRIC = 'Evidence calibration v1';
const rubric: Record<string,{verdict:string[];severity:number[];validation:RegExp;first:number[]}> = {
  '1': {verdict:['real|needs-manual-check','real|needs-manual-check','real','needs-manual-check','needs-manual-check'],severity:[0,0,2,2,2],validation:/verify|confirm|inspect|handshake|frame|fetch|replay|request|curl|check/i,first:[3,4,2]},
  '2': {verdict:['false-positive','real|needs-manual-check','real|false-positive','real|false-positive','real'],severity:[0,2,0,0,1],validation:/verify|confirm|inspect|compare|origin|credential|browser|response|cookie|check/i,first:[1]},
  '3': {verdict:['needs-manual-check','real','needs-manual-check|real','real','real|false-positive'],severity:[0,3,0,1,0],validation:/verify|confirm|inspect|auth|owner|account|login|invoice|check/i,first:[1]},
};
type Entry={id?:string;verdict?:string;severity?:string;why?:string;finding?:string;observation?:string;next_step?:string;next_validation_step?:string;next_validation?:string;next?:string;validation_step?:string};
export type CyberScore={scenario:string;score:number|null;verdict:number;severity:number;validation:number;priority:number;notes:string[]};
const severityLevel=(s:string)=> /critical|p1/i.test(s)?4:/high|p2/i.test(s)?3:/medium|p3/i.test(s)?2:/low|p4/i.test(s)?1:0;
const aliases=[['tls','header','git','actuator','user|pii|wayback'],['cve|apache|traversal','cors|api.me','s3|bucket|logo','swagger','cookie'],['default|admin','invoice','rate','stack|debug','cert']];
function observationIndex(e:Entry,index:number,scenario:string){
  const id=String(e.id??'');
  if(/^(?:obs)?[1-5]$/i.test(id))return Number(id.replace(/obs/i,''))-1;
  const hay=[id,e.finding,e.observation].filter(Boolean).join(' ');
  const mapped=aliases[Number(scenario)-1]?.findIndex(a=>new RegExp(a,'i').test(hay));
  return mapped!==undefined&&mapped>=0?mapped:index;
}
export function scoreCyber(program:string|null,detail:string|null):CyberScore{
  const scenario=program?.startsWith('cyber-matrix-')?(program.match(/-s(\d+)-/)?.[1]??'1'):'unknown', expected=rubric[scenario];
  const out:CyberScore={scenario,score:null,verdict:0,severity:0,validation:0,priority:0,notes:[]};
  if(!expected){out.notes.push('Unknown scenario; no rubric');return out;}
  let j:{triage?:Entry[];first_report?:string};try{j=JSON.parse((detail??'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{out.notes.push('Invalid JSON; unscored');return out;}
  if(!j||!Array.isArray(j.triage)||!j.triage.length){out.notes.push('No structured observations; unscored');return out;}
  const mapped=new Map<number,Entry>();
  j.triage.forEach((e,i)=>{if(!e||typeof e!=='object')return;const k=observationIndex(e,i,scenario);if(k>=0&&k<5&&!mapped.has(k))mapped.set(k,e);});
  if(!mapped.size){out.notes.push("No valid observations; unscored");return out;}
  for(let i=0;i<5;i++){
    const e=mapped.get(i);if(!e){out.notes.push(`Observation ${i+1} missing`);continue;}
    const verdict=String(e.verdict??'').toLowerCase().replace(/_/g,'-');
    if(expected.verdict[i].split('|').includes(verdict))out.verdict+=10;else out.notes.push(`Observation ${i+1}: unsupported verdict`);
    const level=severityLevel(String(e.severity??''));
    // Conditional severity is acceptable for unverified exposure, unconditional inflation is not.
    const conditional=/\bif\b|unverified|conditional|potential/i.test(String(e.severity??''));
    if(e.severity && (level<=expected.severity[i]||(expected.severity[i]>=2&&level<=3&&verdict==='needs-manual-check'&&conditional)))out.severity+=4;
    else out.notes.push(`Observation ${i+1}: severity unsupported or missing`);
    const next=String(e.next_step??e.next_validation_step??e.next_validation??e.next??e.validation_step??'');
    if(next.length>=12&&expected.validation.test(next)&&String(e.why??'').length>=10)out.validation+=4;
  }
  const first=String(j.first_report??'');
  if(first.length>64){out.notes.push('First pick must name one observation');out.score=out.verdict+out.severity+out.validation;return out;}
  let firstIndex=[...mapped].find(([i,e])=>first===String(e.id??'')||new RegExp(aliases[Number(scenario)-1][i],'i').test(first))?.[0];
  if(firstIndex===undefined&&/^[1-5]$/.test(first))firstIndex=Number(first)-1;
  if(firstIndex!==undefined&&expected.first.includes(firstIndex))out.priority=10;else out.notes.push('First pick is unsupported or missing');
  out.score=out.verdict+out.severity+out.validation+out.priority;
  return out;
}

export function cyberLeaderboard(events:{id:number;agent:string;program:string|null;detail:string|null}[]){
  const latest=new Map<string,{agent:string;result:CyberScore}>();
  for(const e of [...events].sort((a,b)=>b.id-a.id)){
    const result=scoreCyber(e.program,e.detail),key=`${e.agent}:${result.scenario}`;
    if(!latest.has(key))latest.set(key,{agent:e.agent,result});
  }
  return [...new Set(events.map(e=>e.agent))].map(agent=>{
    const attempts=[...latest.values()].filter(e=>e.agent===agent).map(e=>e.result),scored=attempts.filter(e=>e.score!==null);
    const avg=(key:'score'|'verdict'|'severity'|'validation'|'priority')=>scored.length?Math.round(scored.reduce((n,e)=>n+(e[key]??0),0)/scored.length):null;
    return {agent,score:avg('score'),verdict:avg('verdict'),severity:avg('severity'),validation:avg('validation'),priority:avg('priority'),coverage:scored.length,unscored:attempts.length-scored.length};
  }).sort((a,b)=>(b.score??-1)-(a.score??-1)||b.coverage-a.coverage||a.agent.localeCompare(b.agent));
}
