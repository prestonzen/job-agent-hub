import { agentNames } from "./auth";
import { answerCode, extractCode, pendingCodes } from "./codes";
import { db } from "./db";
import { sendDigest } from "./digest";
import { isAvailable, queue } from "./jobs";
import { cancelRun, createRun, listRunners, listRuns } from "./runs";
import { getPlaybook } from "./clickup";
import { loadTasks } from "./jobs";
import { mirrorAge, outboxSize, usageToday } from "./mirror";
import { autopilotStatus, saveAutopilot } from "./autopilot";
import { listSchedules, updateSchedule } from "./schedules";
import { esc, isChatAdmin, send, threadId } from "./telegram";
import type { Env } from "./types";

/**
 * Commands from the "Job Agent Hub" topic. The bot's webhook points at the hub
 * (/api/telegram/webhook); only messages in that topic are handled and only the group's
 * owner/admins are obeyed. Everything else in the group is ignored.
 */

interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: { id: number; first_name?: string; is_bot?: boolean };
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number; from?: { is_bot?: boolean } };
}

const HELP = [
  "<b>Job Agent Hub</b>, commands in this topic:",
  "/status: queue, runners, runs",
  "/needs: jobs waiting on you",
  "/run &lt;agent&gt; [jobs] [xN]: e.g. <code>/run claude 3</code>, <code>/run codex 2 x2</code>",
  "/runs: recent runs · /stop &lt;id|all&gt;",
  "/pause · /resume: switch autopilot (all agents) and schedules off / on",
  "/autopilot: what each agent is doing",
  "/digest: summary now · /refresh: reload ClickUp list + playbook now",
  "/login codex|kimi: sign an agent in on the runner (link posts here)",
  "/code &lt;code&gt;: answer a code request (or just reply to the 🔐 message)",
].join("\n");

const reply = (env: Env, msg: TgMessage, html: string) => send(env, html, { replyTo: msg.message_id, silent: true });

export async function handleTelegramUpdate(env: Env, update: { message?: TgMessage; edited_message?: TgMessage }, origin: string): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg?.text || !msg.from || msg.from.is_bot || String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  if (msg.message_thread_id !== (await threadId(env))) return; // only the hub's own topic
  const text = msg.text.trim();
  const isCommand = text.startsWith("/");
  const repliedTo = msg.reply_to_message?.message_id;

  // Ignore chatter: act on commands, replies to the hub's messages, and code-looking text when a code is pending.
  const pending = await pendingCodes(env);
  const looksLikeCode = !isCommand && pending.length > 0 && /^[A-Za-z0-9-]{4,12}$/.test(text);
  if (!isCommand && !repliedTo && !looksLikeCode) return;

  if (!(await isChatAdmin(env, msg.from.id))) {
    if (isCommand) await reply(env, msg, "Only the group's owner or admins can command the hub.");
    return;
  }

  // ---- codes: reply to the 🔐 message, "/code XXXX", "/code ID XXXX", or a bare code ----
  const codeCmd = text.match(/^\/code(?:@\w+)?(?:\s+([A-Z0-9]{3})\b)?\s*(.*)$/i);
  if (repliedTo || looksLikeCode || codeCmd) {
    const code = extractCode(codeCmd ? codeCmd[2] : text);
    let target = repliedTo ? pending.find((p) => p.tgMessageId === repliedTo) : undefined;
    if (!target && codeCmd?.[1]) target = pending.find((p) => p.id === codeCmd[1].toUpperCase());
    if (!target && pending.length === 1 && (looksLikeCode || codeCmd)) target = pending[0];
    if (target) {
      if (!code) return void (await reply(env, msg, "I couldn't find a code in that. Send just the code, e.g. <code>AB12CD34</code>."));
      const done = await answerCode(env, { id: target.id }, code);
      await reply(env, msg, done ? `✅ Sent <code>${esc(code)}</code> to ${esc(done.agent)} for ${esc(done.jobName ?? "the application")}.` : "That request already expired or was answered.");
      return;
    }
    if (codeCmd) {
      await reply(env, msg, pending.length ? `Several codes are pending. Use <code>/code ID XXXX</code>:\n${pending.map((p) => `• <code>${p.id}</code> ${esc(p.agent)}: ${esc(p.jobName ?? "")}`).join("\n")}` : "No code requests are pending.");
      return;
    }
    if (!isCommand) return; // a reply to some other hub message: nothing to do
  }

  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd.replace(/@\w+$/, "").toLowerCase()) {
    case "/help":
    case "/start":
      await reply(env, msg, HELP);
      return;

    case "/status": {
      const [q, runners, runs] = await Promise.all([queue(env), listRunners(env), listRuns(env, 20)]);
      const ready = q.filter(isAvailable);
      const byAts: Record<string, number> = {};
      for (const j of ready) byAts[(j.ats ?? "?").split(/[\s(]/)[0]] = (byAts[(j.ats ?? "?").split(/[\s(]/)[0]] ?? 0) + 1;
      const d = await db(env);
      const today = await d.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'applied' AND at > ?").bind(Date.now() - 86_400_000).first<{ n: number }>();
      const running = runs.filter((r) => r.status === "running");
      const queued = runs.filter((r) => r.status === "queued");
      await reply(
        env,
        msg,
        [
          `📋 Queue: <b>${ready.length}</b> ready (${Object.entries(byAts).map(([k, n]) => `${esc(k)} ${n}`).join(", ") || "none"}) · ${q.filter((j) => j.claimedBy).length} in progress · ${q.filter((j) => j.needsHuman).length} parked`,
          `✅ Applied in 24 h: <b>${today?.n ?? 0}</b>`,
          `🖥️ ${runners.map((r) => `${esc(r.name)} ${r.online ? "🟢" : "🔴"} ready: ${r.agents.filter((a) => a.ready).map((a) => a.id).join(", ") || "none"}`).join("\n🖥️ ") || "no runners"}`,
          `🏃 Runs: ${running.length} running${running.length ? ` (${running.map((r) => `#${r.id} ${r.agent}`).join(", ")})` : ""} · ${queued.length} queued`,
          await clickupLine(env),
          pendingLine(await pendingCodes(env)),
        ].filter(Boolean).join("\n"),
      );
      return;
    }

    case "/needs": {
      const human = (await queue(env)).filter((j) => j.needsHuman);
      await reply(env, msg, human.length ? `🙋 <b>${human.length} waiting on you</b>\n${human.slice(0, 15).map((j) => `• <a href="${j.clickupUrl}">${esc(j.name)}</a>: ${esc((j.needsHuman ?? "").slice(0, 90))}`).join("\n")}` : "Nothing is waiting on you. 🎉");
      return;
    }

    case "/run": {
      const agent = (args[0] ?? "").toLowerCase();
      if (!agent || !agentNames(env).includes(agent)) return void (await reply(env, msg, `Usage: <code>/run &lt;agent&gt; [jobs] [xN]</code>. Agents: ${agentNames(env).join(", ")}`));
      const count = Math.min(10, Math.max(1, Number(args.find((a) => /^\d+$/.test(a))) || 3));
      const copies = Math.min(5, Math.max(1, Number(args.find((a) => /^x\d+$/i.test(a))?.slice(1)) || 1));
      const ids: number[] = [];
      for (let i = 0; i < copies; i++) ids.push((await createRun(env, { agent, kind: "queue", count })).id);
      const runners = await listRunners(env);
      const readyOn = runners.filter((r) => r.online && r.agents.some((a) => a.id === agent && a.ready));
      await reply(env, msg, `🏃 Queued ${ids.map((i) => `#${i}`).join(", ")}: ${esc(agent)} works ${count} job${count > 1 ? "s" : ""}${copies > 1 ? ` ×${copies}` : ""}.${readyOn.length ? "" : `\n⚠️ ${esc(agent)} isn't ready on any runner yet (not logged in?), so it will wait.`}`);
      return;
    }

    case "/login": {
      const agent = (args[0] ?? "").toLowerCase();
      if (!["codex", "kimi"].includes(agent)) return void (await reply(env, msg, "Usage: <code>/login codex</code> or <code>/login kimi</code>. Claude, Gemini and Vibe need a terminal or an API key."));
      const runs = await listRuns(env, 30);
      if (runs.some((r) => r.kind === "login" && r.agent === agent && (r.status === "queued" || r.status === "running"))) {
        return void (await reply(env, msg, `A ${esc(agent)} login is already in progress: use its link above.`));
      }
      const run = await createRun(env, { agent, kind: "login" });
      await reply(env, msg, `🔑 Starting ${esc(agent)} login (run #${run.id}). The link and code will appear here in a few seconds.`);
      return;
    }

    case "/runs": {
      const runs = await listRuns(env, 8);
      await reply(env, msg, runs.length ? runs.map((r) => `#${r.id} ${esc(r.agent)} ${r.kind === "queue" ? `${r.count} jobs` : "custom"}: <b>${r.status}</b>`).join("\n") : "No runs yet.");
      return;
    }

    case "/stop": {
      const runs = await listRuns(env, 50);
      const targets = args[0] === "all" ? runs.filter((r) => r.status === "running" || r.status === "queued") : runs.filter((r) => String(r.id) === (args[0] ?? "").replace("#", ""));
      if (!targets.length) return void (await reply(env, msg, "Usage: <code>/stop &lt;run id&gt;</code> or <code>/stop all</code>"));
      for (const r of targets) await cancelRun(env, r.id);
      await reply(env, msg, `⏹️ Stopping ${targets.map((r) => `#${r.id}`).join(", ")}.`);
      return;
    }

    case "/pause":
    case "/resume": {
      const on = cmd.toLowerCase().startsWith("/resume");
      await saveAutopilot(env, { enabled: on });
      const scheds = await listSchedules(env);
      for (const s of scheds) if (s.enabled !== on && s.kind !== "digest") await updateSchedule(env, s.id, { enabled: on });
      await reply(env, msg, on ? "▶️ Autopilot <b>ACTIVE</b>: ready agents will keep applying." : "⏸️ Autopilot <b>DISABLED</b>. Runs already in progress finish; use <code>/stop all</code> to end them now.");
      return;
    }

    case "/autopilot": {
      const { settings, agents } = await autopilotStatus(env);
      const icon: Record<string, string> = { working: "🏃", queued: "⏳", waiting: "⏱️", ready: "🟢", paused: "⚠️", off: "⚪", "not-ready": "🔑" };
      await reply(env, msg, [`Autopilot: <b>${settings.enabled ? "ACTIVE" : "DISABLED"}</b> · ${settings.jobsPerRun} jobs/run · ≥${settings.minGapMin} min between an agent's runs · max ${settings.maxConcurrent} at once`, ...agents.map((a) => `${icon[a.state] ?? "•"} ${esc(a.agent)}: ${a.state}${a.detail ? ` (${esc(a.detail)})` : ""}`)].join("\n"));
      return;
    }

    case "/digest":
      await sendDigest(env, origin);
      return;

    case "/refresh": {
      const tasks = await loadTasks(env, { force: true });
      await getPlaybook(env, true).catch(() => {});
      await reply(env, msg, `🔄 Reloaded ${tasks.length} tasks and the playbook from ClickUp.\n${await clickupLine(env)}`);
      return;
    }

    default:
      await reply(env, msg, HELP);
  }
}

async function clickupLine(env: Env): Promise<string> {
  const [age, outbox, usage] = await Promise.all([mirrorAge(env), outboxSize(env), usageToday(env)]);
  return `🗂️ ClickUp: ${usage.clickup ?? 0} calls today · list copy ${Number.isFinite(age) ? `${Math.round(age / 60_000)} min old` : "not loaded"}${outbox ? ` · ⏳ ${outbox} writes waiting (rate limit)` : ""}`;
}

function pendingLine(p: { id: string; agent: string; jobName: string | null }[]): string {
  return p.length ? `🔐 Codes pending: ${p.map((x) => `<code>${x.id}</code> ${esc(x.agent)} (${esc(x.jobName ?? "")})`).join(", ")}` : "";
}
