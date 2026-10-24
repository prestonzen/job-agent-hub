// Telegram approval inbox for the Bug Bounty topic: Preston replies yes/no to a posted
// report draft and the hub submits or rejects it. Long-poll free — each runner heartbeat
// triggers one non-blocking getUpdates; the offset lives in settings.
// Inbound is deliberately scoped: bounty topic only, group admins only.
import { getSetting, setSetting } from './db';
import { approveCyberTelegram, cyberDb, rejectCyberTelegram } from './cyber';
import { bountyThreadId, esc, isChatAdmin, send, telegramApi, telegramConfigured } from './telegram';
import type { Env } from './types';

interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  from?: { id: number; first_name?: string; username?: string };
  reply_to_message?: { message_id?: number };
}
interface TgUpdate { update_id: number; message?: TgMessage }

const YES = /^(yes|y|submit|send|approve|ship|👍)$/i;
const NO = /^(no|n|reject|drop|skip|👎)$/i;
const TAGGED = /^#(\d+)\s+(yes|y|no|n|submit|send|approve|reject|drop|skip)\b/i;

async function handleMessage(env: Env, msg: TgMessage): Promise<void> {
  const bountyThread = await bountyThreadId(env);
  if (bountyThread && msg.message_thread_id !== bountyThread) return;
  const text = (msg.text ?? '').trim();
  if (!text || !msg.from) return;
  if (!(await isChatAdmin(env, msg.from.id))) return;
  const who = msg.from.username ?? msg.from.first_name ?? String(msg.from.id);

  let workId: number | null = null;
  let approve: boolean | null = null;
  const tagged = text.match(TAGGED);
  if (tagged) {
    workId = Number(tagged[1]);
    approve = /^(yes|y|submit|send|approve)$/i.test(tagged[2]);
  } else if (YES.test(text) || NO.test(text)) {
    const replyTo = msg.reply_to_message?.message_id;
    if (!replyTo) return;
    const d = await cyberDb(env);
    const row = await d.prepare('SELECT id FROM cyber_work WHERE telegram_message_id=?').bind(replyTo).first<{ id: number }>();
    if (!row) return;
    workId = row.id;
    approve = YES.test(text);
  }
  if (workId === null || approve === null) return;

  const reply = approve ? await approveCyberTelegram(env, workId, who) : await rejectCyberTelegram(env, workId, who);
  const err = await send(env, esc(reply), { topic: 'bounty' });
  if (err) console.error('tg inbox reply:', err);
}

/** One non-blocking poll. Returns the number of updates seen. Never throws. */
export async function telegramInboxTick(env: Env): Promise<number> {
  if (!telegramConfigured(env)) return 0;
  try {
    let offset = await getSetting<number>(env, 'telegram_update_offset').catch(() => null);
    if (!offset) {
      // First run: fast-forward past every stale update (drop the backlog, start fresh).
      const r = await telegramApi(env, 'getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] });
      const last = r.ok ? (r.result as TgUpdate[]).at(-1) : undefined;
      await setSetting(env, 'telegram_update_offset', last ? last.update_id + 1 : 1);
      return 0;
    }
    const r = await telegramApi(env, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
    if (!r.ok) { console.error('tg inbox poll:', r.description); return 0; }
    const updates = (r.result ?? []) as TgUpdate[];
    let next = offset;
    for (const u of updates) {
      next = Math.max(next, u.update_id + 1);
      if (u.message) await handleMessage(env, u.message).catch((e) => console.error('tg inbox message:', e));
    }
    if (next !== offset) await setSetting(env, 'telegram_update_offset', next);
    return updates.length;
  } catch (e) {
    console.error('tg inbox tick:', e);
    return 0;
  }
}
