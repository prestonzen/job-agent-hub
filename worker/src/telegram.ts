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

async function threadId(env: Env): Promise<number | undefined> {
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

/** Send an HTML message. Returns an error string instead of throwing. */
export async function notify(env: Env, html: string, opts: { silent?: boolean } = {}): Promise<string | null> {
  if (!telegramConfigured(env)) return "Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)";
  try {
    const thread = await threadId(env);
    const send = (t?: number) =>
      api(env, "sendMessage", {
        chat_id: env.TELEGRAM_CHAT_ID,
        ...(t ? { message_thread_id: t } : {}),
        text: html.slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: !!opts.silent,
      });
    let r = await send(thread);
    if (!r.ok && thread && /thread|topic/i.test(r.description ?? "")) {
      // Topic was deleted: forget it and fall back to the main chat (a new topic is made next time).
      await setSetting(env, "telegram_thread", 0);
      r = await send(undefined);
    }
    return r.ok ? null : `Telegram: ${r.description ?? "send failed"}`;
  } catch (e) {
    return `Telegram: ${(e as Error).message}`;
  }
}
