import { db } from "./db";
import { isAvailable, queue } from "./jobs";
import { listRunners } from "./runs";
import { esc, notify } from "./telegram";
import type { Env } from "./types";

/** Daily Telegram digest: what the army did in the last 24 h and what needs you. */
export async function sendDigest(env: Env, origin = "https://jobhunter.prestonzen.com"): Promise<string | null> {
  const since = Date.now() - 86_400_000;
  const d = await db(env);
  const [{ results: applied }, { results: replies }, q, runners] = await Promise.all([
    d.prepare("SELECT agent, COUNT(*) AS n FROM events WHERE type = 'applied' AND at > ? GROUP BY agent ORDER BY n DESC").bind(since).all<{ agent: string; n: number }>(),
    d.prepare("SELECT category, COUNT(*) AS n FROM inbound WHERE at > ? GROUP BY category").bind(since).all<{ category: string; n: number }>().catch(() => ({ results: [] as { category: string; n: number }[] })),
    queue(env),
    listRunners(env).catch(() => []),
  ]);
  const total = applied.reduce((s, r) => s + r.n, 0);
  const human = q.filter((j) => j.needsHuman);
  const lines = [
    `📊 <b>Job Agent Hub — last 24 h</b>`,
    `Applied: <b>${total}</b>${applied.length ? " (" + applied.map((r) => `${esc(r.agent)} ${r.n}`).join(", ") + ")" : ""}`,
    replies.length ? `Replies: ${replies.map((r) => `${esc(r.category)} ${r.n}`).join(", ")}` : "Replies: none",
    `Queue: ${q.filter(isAvailable).length} ready · ${q.filter((j) => j.claimedBy).length} in progress`,
    `Runners: ${runners.length ? runners.map((r) => `${esc(r.name)} ${r.online ? "🟢" : "🔴"} (${r.agents.filter((a) => a.ready).length}/${r.agents.length} ready)`).join(", ") : "none"}`,
  ];
  if (human.length) {
    lines.push("", `🙋 <b>Needs you (${human.length})</b>`);
    for (const j of human.slice(0, 10)) lines.push(`• <a href="${j.clickupUrl}">${esc(j.name)}</a>: ${esc(j.needsHuman ?? "")}`);
  }
  lines.push("", `<a href="${origin}/admin">Open the hub</a>`);
  return notify(env, lines.join("\n"), { silent: human.length === 0 });
}
