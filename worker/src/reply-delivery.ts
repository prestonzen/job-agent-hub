import { db } from './db';
import { send, esc } from './telegram';
import type { Env } from './types';

export const REPLY_DELIVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS inbound_notifications (
  message_id TEXT PRIMARY KEY, html TEXT NOT NULL, silent INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, receipt INTEGER, error TEXT, updated_at INTEGER NOT NULL
)`;

export async function queueReplyNotification(env: Env, id: string, html: string, silent: boolean) {
  const d = await db(env);
  await d.prepare(REPLY_DELIVERY_SCHEMA).run();
  await d.prepare(`INSERT INTO inbound_notifications (message_id,html,silent,updated_at) VALUES (?,?,?,?) ON CONFLICT(message_id) DO NOTHING`)
    .bind(id,html,silent?1:0,Date.now()).run();
}

/** Explicit admin recovery; successful receipts are never resent. */
export async function recoverReplyNotification(env:Env,id:string){
  const d=await db(env);
  const email=await d.prepare('SELECT subject,summary,category FROM inbound WHERE message_id=?').bind(id).first<{subject:string;summary:string;category:string}>();
  if(!email)throw new Error('Reply not found');
  await queueReplyNotification(env,id,`📋 <b>Actionable reply</b>: ${esc(email.subject)}\n${esc(email.summary)}\nReview the original email for the next step.`,false);
  await d.prepare(`UPDATE inbound_notifications SET state='pending',next_at=0,attempts=0,updated_at=? WHERE message_id=? AND state IN ('failed','unknown')`).bind(Date.now(),id).run();
  await flushReplyNotifications(env);
  return d.prepare('SELECT state,receipt,error FROM inbound_notifications WHERE message_id=?').bind(id).first();
}

/** Atomic reservation prevents two runner heartbeats sending the same reply alert. */
export async function flushReplyNotifications(env: Env) {
  const d = await db(env), now=Date.now();
  await d.prepare(REPLY_DELIVERY_SCHEMA).run();
  // A crash after sending might have delivered. Never blindly duplicate uncertain delivery.
  await d.prepare(`UPDATE inbound_notifications SET state='unknown',error='Delivery interrupted; check Telegram before retrying' WHERE state='sending' AND updated_at<?`).bind(now-900_000).run();
  const {results}=await d.prepare(`SELECT message_id FROM inbound_notifications WHERE state='pending' AND next_at<=? ORDER BY updated_at LIMIT 5`).bind(now).all<{message_id:string}>();
  for(const row of results){
    const job=await d.prepare(`UPDATE inbound_notifications SET state='sending',attempts=attempts+1,updated_at=? WHERE message_id=? AND state='pending' AND next_at<=? RETURNING html,silent,attempts`)
      .bind(now,row.message_id,now).first<{html:string;silent:number;attempts:number}>();
    if(!job)continue;
    const result=await send(env,job.html,{silent:!!job.silent});
    const state=result.messageId!==null?'sent':result.uncertain?'unknown':job.attempts>=5?'failed':'pending';
    await d.prepare(`UPDATE inbound_notifications SET state=?,receipt=?,error=?,next_at=?,updated_at=? WHERE message_id=? AND state='sending'`)
      .bind(state,result.messageId,result.error,Date.now()+Math.min(3_600_000,30_000*2**job.attempts),Date.now(),row.message_id).run();
  }
}
