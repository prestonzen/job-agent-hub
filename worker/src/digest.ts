import { db } from "./db";
import { isAvailable, queue } from "./jobs";
import { listRunners } from "./runs";
import { actionItems, actionLine } from "./inbound";
import { esc, notify } from "./telegram";
import type { Env } from "./types";

/** Normalize a needs_human / failed note into a bucket so the digest can rank bulk reasons. */
function reasonBucket(msg: string): string {
  const m = msg.toLowerCase();
  if (/captcha|recaptcha|hcaptcha|turnstile|image challenge/.test(m)) return "CAPTCHA / visual challenge";
  if (/verification code|security code|emailed code|http 428|precondition/.test(m)) return "Emailed verification code";
  if (/spam|duplicate|unusual activity|possible fraud/.test(m)) return "Spam / duplicate flag";
  if (/cloudflare|bot protection|403|blocked page/.test(m)) return "Cloudflare / bot protection";
  if (/proxy|err_proxy|egress/.test(m)) return "Proxy / browser network";
  if (/account|sign.?in|log ?in|password|credentials/.test(m)) return "Account / sign-in needed";
  if (/email cap|daily cap/.test(m)) return "Daily email cap";
  if (/travel|onsite|hybrid|relocation|not remote/.test(m)) return "Location / travel misfit";
  if (/pacing|cooldown|too many|rate limit/.test(m)) return "Pacing / cooldown";
  return "Other";
}

/** Daily Telegram digest: what the army did in the last 24 h and what needs you. */
export async function sendDigest(env: Env, origin = "https://jobhunter.prestonzen.com"): Promise<string | null> {
  const since = Date.now() - 86_400_000;
  const d = await db(env);
  const [{ results: applied }, { results: replies }, { results: cyberWins }, { results: stalled }, { results: quiet }, q, runners] = await Promise.all([
    d.prepare("SELECT agent, COUNT(*) AS n FROM events WHERE type IN ('applied','emailed') AND at > ? GROUP BY agent ORDER BY n DESC").bind(since).all<{ agent: string; n: number }>(),
    d.prepare("SELECT category, COUNT(*) AS n FROM inbound WHERE at > ? GROUP BY category").bind(since).all<{ category: string; n: number }>().catch(() => ({ results: [] as { category: string; n: number }[] })),
    d.prepare("SELECT kind, COUNT(*) AS n FROM bounty_events WHERE at > ? AND (kind = 'finding' OR (kind = 'scan' AND status = 'done')) GROUP BY kind").bind(since).all<{ kind: string; n: number }>().catch(() => ({ results: [] as { kind: string; n: number }[] })),
    // Everything that did NOT win and did NOT ping you: parked and failed outcomes, in bulk.
    d.prepare("SELECT type, message FROM events WHERE type IN ('needs_human','failed') AND at > ? ORDER BY at DESC LIMIT 800").bind(since).all<{ type: string; message: string | null }>(),
    // Runs that finished with no recorded work at all (the old "no work result recorded" pings).
    d.prepare("SELECT COUNT(*) AS n FROM runs WHERE finished_at > ? AND status IN ('succeeded','failed','cancelled') AND id NOT IN (SELECT DISTINCT run_id FROM events WHERE at > ? AND run_id IS NOT NULL)").bind(since, since).all<{ n: number }>().catch(() => ({ results: [{ n: 0 }] })),
    queue(env),
    listRunners(env).catch(() => []),
  ]);
  const total = applied.reduce((s, r) => s + r.n, 0);
  const findings = cyberWins.find((r) => r.kind === "finding")?.n ?? 0;
  const scans = cyberWins.find((r) => r.kind === "scan")?.n ?? 0;
  const human = q.filter((j) => j.needsHuman);
  const actions = await actionItems(env, 7).catch(() => []);

  // Rank bulk stall reasons (top 5), needs_human and failed together.
  const buckets = new Map<string, number>();
  for (const r of stalled) {
    const b = reasonBucket(r.message ?? "");
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines = [
    `📊 <b>Job Agent Hub — last 24 h</b>`,
    `Applied: <b>${total}</b>${applied.length ? " (" + applied.map((r) => `${esc(r.agent)} ${r.n}`).join(", ") + ")" : ""}`,
    `Cyber: ${findings} finding${findings === 1 ? "" : "s"} · ${scans} scan${scans === 1 ? "" : "s"} completed`,
    replies.length ? `Replies: ${replies.map((r) => `${esc(r.category)} ${r.n}`).join(", ")}` : "Replies: none",
    `Queue: ${q.filter(isAvailable).length} ready · ${q.filter((j) => j.claimedBy).length} in progress`,
    `Runners: ${runners.length ? runners.map((r) => `${esc(r.name)} ${r.online ? "🟢" : "🔴"} (${r.agents.filter((a) => a.ready).length}/${r.agents.length} ready)`).join(", ") : "none"}`,
  ];
  // Employers waiting on Preston come first: an unanswered assessment or interview request is the priority.
  if (actions.length) {
    lines.push("", `⚡ <b>Employers waiting on you (${actions.length})</b>`);
    for (const a of actions) lines.push(actionLine(a));
  }
  if (stalled.length || (quiet[0]?.n ?? 0) > 0) {
    lines.push("", `⚠️ <b>Stalled / failed in bulk (${stalled.length} outcomes${quiet[0]?.n ? ` · ${quiet[0].n} empty runs` : ""})</b>`);
    if (ranked.length) {
      lines.push("Top reasons to address in bulk:");
      for (const [reason, n] of ranked) lines.push(`• ${esc(reason)} — ${n}`);
    }
  }
  if (human.length) {
    lines.push("", `🙋 <b>Needs you (${human.length})</b>`);
    lines.push(`Open the <a href="${origin}/admin#assisted">assisted queue</a> to push them through with Claude in Chrome.`);
    for (const j of human.slice(0, 10)) lines.push(`• <a href="${j.clickupUrl}">${esc(j.name)}</a>: ${esc(j.needsHuman ?? "")}`);
  }
  lines.push("", `<a href="${origin}/admin">Open the hub</a>`);
  return notify(env, lines.join("\n"), { silent: human.length === 0 && actions.length === 0 });
}
