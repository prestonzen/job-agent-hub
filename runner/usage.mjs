import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Kimi's usage.record events are per-turn totals. Match exact session cwd; no log-text guessing. */
export function kimiUsage(home, cwd) {
  const root=join(home,'.kimi-code','sessions');let tokens=0,records=0;const seen=new Set();
  let workspaces;try{workspaces=readdirSync(root);}catch{return null;}
  for(const workspace of workspaces){
    if(workspace.startsWith('.'))continue;
    let sessions;try{sessions=readdirSync(join(root,workspace));}catch{continue;}
    for(const session of sessions){
      const dir=join(root,workspace,session);let meta;try{meta=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));}catch{continue;}
      if(typeof meta.cwd!=='string'||resolve(meta.cwd)!==resolve(cwd))continue;
      const visit=(path)=>{let names;try{names=readdirSync(path);}catch{return;}
        for(const name of names){const file=join(path,name);if(statSync(file).isDirectory())visit(file);
          else if(name==='wire.jsonl')for(const line of readFileSync(file,'utf8').split('\n')){
            let e;try{e=JSON.parse(line);}catch{continue;}
            if(e.type!=='usage.record'||e.usageScope!=='turn'||!e.usage)continue;
            const key=JSON.stringify([session,e.agentId,e.time,e.usage]);if(seen.has(key))continue;seen.add(key);
            const u=e.usage;tokens+=['inputOther','output','inputCacheRead','inputCacheCreation'].reduce((n,k)=>n+(Number.isFinite(u[k])?u[k]:0),0);records++;
          }
        }
      };visit(join(dir,'agents'));
    }
  }
  return records?{tokens,records}:null;
}
