import { getSetting, setSetting } from "./db";
import type { Env } from "./types";

/**
 * Telegram notifications (bot API). Posts to TELEGRAM_CHAT_ID; in a forum supergroup it creates a
 * "Job Agent Hub" topic once and remembers its thread id (or uses TELEGRAM_THREAD_ID if set).
 * Never throws: a failed notification must not fail the action that triggered it.
 */

const TOPIC_NAME = "🤖 Job Agent Hub";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function api(env: Env, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
}

export async function threadId(env: Env): Promise<number | undefined> {
  if (env.TELEGRAM_THREAD_ID) return Number(env.TELEGRAM_THREAD_ID) || undefined;
  const saved = await getSetting<number>(env, "telegram_thread").catch(() => null);
  if (saved) return saved;
  // Forum supergroup: make our own topic so hub messages don't flood General.
  const r = await api(env, "createForumTopic", { chat_id: env.TELEGRAM_CHAT_ID, name: TOPIC_NAME, icon_color: 0x6fb9f0 });
  const id = (r.result as { message_thread_id?: number } | undefined)?.message_thread_id;
  if (r.ok && id) {
    await setSetting(env, "telegram_thread", id);
    return id;
  }
  return undefined; // not a forum, or the bot can't manage topics: post to the main chat
}

export function telegramConfigured(env: Env): boolean {
  return !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/** Send an HTML message to the hub topic. Never throws; returns the message id or an error. */
export async function send(
  env: Env,
  html: string,
  opts: { silent?: boolean; replyTo?: number } = {},
): Promise<{ messageId: number | null; error: string | null }> {
  if (!telegramConfigured(env)) return { messageId: null, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)" };
  try {
    const thread = await threadId(env);
    const post = (t?: number) =>
      api(env, "sendMessage", {
        chat_id: env.TELEGRAM_CHAT_ID,
        ...(t ? { message_thread_id: t } : {}),
        ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
        text: html.slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: !!opts.silent,
      });
    let r = await post(thread);
    if (!r.ok && thread && /thread|topic/i.test(r.description ?? "")) {
      // Topic was deleted: forget it and fall back to the main chat (a new topic is made next time).
      await setSetting(env, "telegram_thread", 0);
      r = await post(undefined);
    }
    const id = (r.result as { message_id?: number } | undefined)?.message_id ?? null;
    return r.ok ? { messageId: id, error: null } : { messageId: null, error: `Telegram: ${r.description ?? "send failed"}` };
  } catch (e) {
    return { messageId: null, error: `Telegram: ${(e as Error).message}` };
  }
}

/** Send an HTML message. Returns an error string instead of throwing. */
export async function notify(env: Env, html: string, opts: { silent?: boolean } = {}): Promise<string | null> {
  return (await send(env, html, opts)).error;
}

const adminCache = new Map<number, { at: number; ok: boolean }>();

/** Only the group's owner/admins can command the hub. Cached for 10 minutes. */
export async function isChatAdmin(env: Env, userId: number): Promise<boolean> {
  const hit = adminCache.get(userId);
  if (hit && Date.now() - hit.at < 600_000) return hit.ok;
  const r = await api(env, "getChatMember", { chat_id: env.TELEGRAM_CHAT_ID, user_id: userId }).catch(() => ({ ok: false }) as { ok: boolean; result?: unknown });
  const status = (r.result as { status?: string } | undefined)?.status;
  const ok = status === "creator" || status === "administrator";
  adminCache.set(userId, { at: Date.now(), ok });
  return ok;
}

/** Where the bot's updates go (the webhook belongs to Ava's worker). */
export async function webhookInfo(env: Env): Promise<unknown> {
  const r = await api(env, "getWebhookInfo", {});
  const w = (r.result ?? {}) as { url?: string; pending_update_count?: number; last_error_message?: string; last_error_date?: number; allowed_updates?: string[] };
  return { url: w.url, pending: w.pending_update_count, lastError: w.last_error_message ?? null, lastErrorAt: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : null, allowedUpdates: w.allowed_updates };
}
