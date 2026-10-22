import { assistedQueue } from "./assisted";
import { buildAnalytics } from "./analytics";
import { sendApplicationEmail, sendTestEmail } from "./emailer";
import { adminUser, agentName, agentNames, clearedCookie, isAdminToken, resolveIdentity, sessionCookie } from "./auth";
import { HttpError, ensureCyberList, replayWrite } from "./clickup";
import { addComment, appendDocPage, getDocPage, getPlaybook, listDocPages, patchDocPage, reconcileFromClickUp, requeueTask, setStatus, syncCyber } from "./store";
import { flushOutbox, mirrorAge, mirrorTasks, outboxSize, usageToday } from "./mirror";
import { isApplication } from "./classify";
import { activeClaims, completeRunnerCommand, db as dbHandle, enqueueRunnerCommand, exportEvents, getSetting, heartbeat, lastEventAt, listEvents, listHeartbeats, loadSnapshot, pendingRunnerCommands, saveSnapshot, setSetting } from "./db";
import { agentInstructions } from "./instructions";
import {
  addJob,
  adminName,
  handoffJob,
  claimJobs,
  getJob,
  isAvailable,
  loadTasks,
  logApplication,
  playbook,
  queue,
  releaseJob,
  renewLease,
  reportResult,
  type NewJob,
  type Report,
} from "./jobs";
import { handleMcp } from "./mcp";
import { appendLog, cancelRun, claimRun, createRun, finishRun, getRun, isRunnerToken, listRunners, listRuns, runnerHeartbeat, type RunKind } from "./runs";
import { autopilotStatus, autopilotTick, saveAutopilot } from "./autopilot";
import { sourceCheckStatus } from "./sourcing";
import type { RunTask } from "./work";
import { sendDigest } from "./digest";
import { flushReplyNotifications, recoverReplyNotification } from "./reply-delivery";
import { handleInbound, markHandled, recentInbound, type InboundEmail } from "./inbound";
import { DEFAULT_POLICY, getPolicy, pacingState, pacingSummary, type PacingPolicy } from "./pacing";
import { deleteResume, listResumes, pickResume, resumeFile, updateResume, uploadResume } from "./resumes";
import { coverLetterFile, makeCoverLetter } from "./coverletters";
import { prepNow, saveKit } from "./kits";
import { PHASES, runFeeds, type Phase } from "./feeds";
import { createSchedule, deleteSchedule, listSchedules, tick, updateSchedule, type ScheduleKind } from "./schedules";
import { notify, notifyBounty, esc, disableTelegramReplies, telegramConfigured, webhookInfo } from "./telegram";
import { getCodeRequest, requestCode, waitForCode } from "./codes";
import { addBountyEvent, bountyHosts, bountySummary, upsertBountyTech, type BountyEventInput } from "./bounty";
import { cyberTick, cyberSummary, enqueueCyber, getCyberWork, completeCyber, reviewCyber, submitCyberExternal } from "./cyber";
import { toPublicSummary } from "./sanitize";
import type { Env, PublicSummary } from "./types";
import { zadarmaGet } from "./zadarma";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function text(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

const unauthorizedAgent = () =>
  json({ error: "unauthorized: send Authorization: Bearer <agent token>" }, 401, { "WWW-Authenticate": 'Bearer realm="job-agent-hub"' });

/** Validated fields for adding/logging a posting. */
function newJob(body: Partial<NewJob & { platform: string }>): NewJob & { platform?: string } {
  if (!body.company || !body.role) throw new HttpError(400, "company and role are required");
  const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  return {
    company: String(body.company).slice(0, 120),
    role: String(body.role).slice(0, 160),
    url: s(body.url, 500),
    ats: s(body.ats, 40),
    platform: s(body.platform, 40),
    pay: s(body.pay, 80),
    travel: s(body.travel, 80),
    fit: s(body.fit, 120),
    notes: s(body.notes, 4000),
  };
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ---------- Public (sanitized) ----------
  if (path === "/api/public/summary" && method === "GET") {
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/__cache/public-summary`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // Stale-while-revalidate from the D1 snapshot: visitors never wait on ClickUp (~2 s) unless
    // there's no recent snapshot; a snapshot older than a minute is refreshed in the background.
    const snap = await loadSnapshot(env, "public-summary-v2").catch(() => null);
    const age = snap ? Date.now() - snap.at : Infinity;
    let body: string;
    if (snap && age < 10 * 60_000) {
      body = snap.body;
      if (age > 60_000) ctx.waitUntil(buildPublicSummary(env).catch((e) => console.error("summary refresh:", e)));
    } else {
      try {
        body = await buildPublicSummary(env);
      } catch (err) {
        // ClickUp down, slow or rate-limited: show the last good snapshot instead of an error.
        if (!snap) throw err;
        console.error("public summary from old snapshot:", err);
        return json({ ...JSON.parse(snap.body), stale: true }, 200, { "Cache-Control": "public, max-age=30" });
      }
    }
    const res = new Response(body, { headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=30" } });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      demo: env.MOCK === "true",
      clickup: !!env.CLICKUP_TOKEN,
      agents: agentNames(env).length,
      adminConfigured: !!env.ADMIN_TOKEN,
    });
  }

  // Uptime Kuma: 503 when no runner has checked in for 3 minutes.
  if (path === "/api/health/runner" && method === "GET") {
    const runners = await listRunners(env);
    const fresh = runners.filter((r) => Date.now() - Date.parse(r.lastSeen) < 180_000);
    return json({ ok: fresh.length > 0, runners: runners.map((r) => ({ name: r.name, lastSeen: r.lastSeen })) }, fresh.length ? 200 : 503);
  }

  // ---------- Reply tracking (Gmail Apps Script, INBOUND_TOKEN) ----------
  if (path === "/api/inbound/email" && method === "POST") {
    const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!env.INBOUND_TOKEN || env.INBOUND_TOKEN.length < 24 || m?.[1]?.trim() !== env.INBOUND_TOKEN) return json({ error: "unauthorized" }, 401);
    const b = await readJson<Partial<InboundEmail>>(request);
    if (!b.id || !b.subject) return json({ error: "id and subject are required" }, 400);
    return json(await handleInbound(env, { id: String(b.id), from: String(b.from ?? ""), subject: String(b.subject), date: b.date, text: String(b.text ?? "") }));
  }

  // ---------- Telegram inbound updates are intentionally ignored; remove any legacy webhook on first callback. ----------
  if ((path === "/api/telegram/webhook" || path === "/api/telegram/update") && method === "POST") {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? request.headers.get("X-Hub-Secret") ?? "";
    if (!env.TELEGRAM_HUB_SECRET || env.TELEGRAM_HUB_SECRET.length < 24 || secret !== env.TELEGRAM_HUB_SECRET) return json({ error: "unauthorized" }, 401);
    const disabled = await disableTelegramReplies(env);
    return json(disabled, disabled.ok ? 200 : 502);
  }

  // ---------- MCP (bearer token) ----------
  if (path === "/mcp" || path === "/api/mcp") {
    const agent = agentName(request, env);
    if (!agent) return unauthorizedAgent();
    const identity = resolveIdentity(request, env)?.id ?? null;
    ctx.waitUntil(heartbeat(env, agent, `mcp ${request.headers.get("User-Agent") ?? ""}`).catch(() => {}));
    return handleMcp(request, env, agent, identity);
  }

  // ---------- Runner API (RUNNER_TOKEN): machines that execute agent runs ----------
  if (path.startsWith("/api/runner/")) {
    if (!isRunnerToken(env, request)) return json({ error: "unauthorized" }, 401);
    const sub = path.slice("/api/runner".length);
    if (sub === "/heartbeat" && method === "POST") {
      const b = await readJson<Parameters<typeof runnerHeartbeat>[1]>(request);
      if (!b.name) return json({ error: "name is required" }, 400);
      await runnerHeartbeat(env, b);
      // Reserve scheduled sourcing first, then any eligible email application, then cyber evidence.
      // One ordered dispatch avoids the email and cyber ticks racing for the same agent.
      ctx.waitUntil((async () => {
        await tick(env, () => sendDigest(env, url.origin).then(() => {})).catch((e) => console.error("schedule tick:", e));
        await autopilotTick(env).then((n) => n && console.log("autopilot:", n)).catch((e) => console.error("autopilot tick:", e));
        await cyberTick(env).then((n) => n && console.log("cyber tick:", n)).catch((e) => console.error("cyber tick:", e));
      })());
      ctx.waitUntil(flushReplyNotifications(env).catch((e)=>console.error("reply delivery:",e)));
      // Replay ClickUp writes that were deferred by a rate limit or outage.
      ctx.waitUntil(
        outboxSize(env)
          .then((n) => (n ? flushOutbox(env, (m, p, body) => replayWrite(env, m, p, body)) : 0))
          .catch((e) => console.error("outbox flush:", e)),
      );
      return json({ ok: true, commands: await pendingRunnerCommands(env, b.name).catch(() => []) });
    }
    if (sub === "/command-done" && method === "POST") {
      const b = await readJson<{ id?: number }>(request);
      if (!b.id) return json({ error: "id is required" }, 400);
      await completeRunnerCommand(env, Number(b.id));
      return json({ ok: true });
    }
    if (sub === "/resumes" && method === "GET") return json({ resumes: await listResumes(env) });
    const rf = sub.match(/^\/resumes\/(\d+)\/file$/);
    if (rf && method === "GET") return resumeFile(env, Number(rf[1]));
    if (sub === "/claim" && method === "POST") {
      const b = await readJson<{ name?: string; agents?: string[]; installed?: string[] }>(request);
      if (!b.name) return json({ error: "name is required" }, 400);
      return json({ run: await claimRun(env, b.name, Array.isArray(b.agents) ? b.agents : [], url.origin, Array.isArray(b.installed) ? b.installed : []) });
    }
    const m = sub.match(/^\/runs\/(\d+)\/(log|finish)$/);
    if (m && method === "POST") {
      const id = Number(m[1]);
      if (m[2] === "log") {
        const b = await readJson<{ name?: string; chunk?: string }>(request);
        return json(await appendLog(env, id, String(b.name ?? ""), String(b.chunk ?? "")));
      }
      const b = await readJson<{ name?: string; exitCode?: number | null; cancelled?: boolean; costUsd?: number | null; tokens?: number | null }>(request);
      await finishRun(env, id, String(b.name ?? ""), { exitCode: b.exitCode ?? null, cancelled: !!b.cancelled, costUsd: b.costUsd ?? null, tokens: b.tokens ?? null });
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  // ---------- Agent REST API (bearer token) ----------
  if (path.startsWith("/api/agent/")) {
    const agent = agentName(request, env);
    if (!agent) return unauthorizedAgent();
    const identity = resolveIdentity(request, env)?.id ?? null;
    ctx.waitUntil(heartbeat(env, agent, `rest ${request.headers.get("User-Agent") ?? ""}`).catch(() => {}));
    const sub = path.slice("/api/agent".length);

    if (sub === "/me" && method === "GET") return json({ agent });
    if (sub === "/instructions" && method === "GET") return text(agentInstructions(agent, url.origin, "rest"));
    if (sub === "/playbook" && method === "GET") return text(await playbook(env));
    if (sub === "/resume" && method === "GET") {
      const pick = await pickResume(env, url.searchParams.get("role") ?? "", url.searchParams.get("text"));
      return json(pick ? { ...pick, downloadUrl: `${url.origin}/api/agent/resumes/${pick.id}/file` } : { error: "resume bank is empty" }, pick ? 200 : 404);
    }
    const arf = sub.match(/^\/resumes\/(\d+)\/file$/);
    if (arf && method === "GET") return resumeFile(env, Number(arf[1]));
    if (sub === "/codes" && method === "POST") {
      const b = await readJson<{ jobId?: string; jobName?: string; kind?: string; hint?: string }>(request);
      return json(await requestCode(env, { agent, ...b }), 201);
    }
    const cw = sub.match(/^\/codes\/([A-Za-z0-9]{3})(\/wait)?$/);
    if (cw && method === "GET") return json(cw[2] ? await waitForCode(env, cw[1], agent) : await getCodeRequest(env, cw[1]));

    // Cover letters: the agent writes, the hub typesets a PDF and serves it back for the form upload.
    if (sub === "/cover-letter" && method === "POST") return json(await makeCoverLetter(env, agent, url.origin, await readJson(request)), 201);
    const clf = sub.match(/^\/cover-letters\/([A-Za-z0-9._-]+)$/);
    if (clf && method === "GET") return coverLetterFile(env, clf[1]);
    // Prep kit for a parked job: resume pick, cover letter, drafted answers — what Preston pastes to finish it.
    const kitRoute = sub.match(/^\/jobs\/([^/]+)\/kit$/);
    if (kitRoute && method === "POST") return json(await saveKit(env, agent, url.origin, { ...(await readJson<Record<string, unknown>>(request)), id: kitRoute[1] }), 201);

    if (sub === "/queue" && method === "GET") {
      const q = await queue(env);
      const available = q.filter(isAvailable);
      return json({
        available: available.length,
        claimed: q.filter((j) => j.claimedBy).map((j) => ({ id: j.id, name: j.name, by: j.claimedBy, until: j.claimExpiresAt })),
        needsHuman: q.filter((j) => j.needsHuman).length,
        next: available.slice(0, 20),
      });
    }

    if (sub === "/claim" && method === "POST") {
      const body = await readJson<{ count?: number; ats?: string[] }>(request).catch(() => ({}) as { count?: number; ats?: string[] });
      return json(await claimJobs(env, agent, { count: body.count, ats: Array.isArray(body.ats) ? body.ats : undefined }, identity));
    }

    if (sub === "/jobs" && method === "POST") {
      return json(await addJob(env, agent, newJob(await readJson(request)), identity), 201);
    }

    if (sub === "/applications" && method === "POST") {
      return json({ ok: true, agent, ...(await logApplication(env, agent, newJob(await readJson(request)), identity)) }, 201);
    }

    const cyberWork = sub.match(/^\/cyber\/(\d+)(?:\/(complete))?$/);
    if(cyberWork && method==='GET' && !cyberWork[2])return json(await getCyberWork(env,Number(cyberWork[1]),agent));
    if(cyberWork && method==='POST' && cyberWork[2])return json(await completeCyber(env,Number(cyberWork[1]),agent,await readJson(request),identity));
    const cyberSubmit = sub.match(/^\/cyber\/(\d+)\/submit-result$/);
    if(cyberSubmit && method==='POST')return json(await submitCyberExternal(env,Number(cyberSubmit[1]),agent,await readJson(request)));
    // Bug bounty lane: runner tooling and agents push program/scan/finding/report/payout events.
    if (sub === "/bounty" && method === "POST") {
      const b = await readJson<BountyEventInput>(request);
      const created = await addBountyEvent(env, agent, b);
      if (b.program) ctx.waitUntil(syncCyber(env, { ...b, program: b.program }).catch((e) => console.error("cyber store sync:", e)));
      // Scanner labels and unreviewed findings do not need a human notification.
      if (b.kind === "payout") {
        const what = `💰 Bounty payout${b.amount ? ` — $${b.amount}` : ""}`;
        const lines = [what, `${b.program ?? "unknown program"}${b.target ? ` · ${b.target}` : ""}`];
        if (b.title) lines.push(b.title);
        lines.push(`${url.origin}/admin#bounty`);
        ctx.waitUntil(notifyBounty(env, lines.join("\n")).then((e) => e && console.error("bounty notify:", e)));
      }
      return json({ ok: true, agent, ...created }, 201);
    }

    const job = sub.match(/^\/jobs\/([^/]+)(?:\/(renew|report|release|handoff|email))?$/);
    if (job) {
      const id = decodeURIComponent(job[1]);
      if (!job[2] && method === "GET") return json(await getJob(env, id));
      if (job[2] === "email" && method === "POST") {
        const b = await readJson<{ body?: string; subject?: string; resumeId?: number }>(request);
        return json(await sendApplicationEmail(env, agent, id, { body: b.body, subject: b.subject, resumeId: b.resumeId }, identity));
      }
      if (job[2] === "renew" && method === "POST") return json(await renewLease(env, agent, id));
      if (job[2] === "report" && method === "POST") return json(await reportResult(env, agent, id, await readJson<Report>(request), false, identity));
      if (job[2] === "handoff" && method === "POST") {
        const b = await readJson<{ reason?: string; to?: string; log?: string }>(request);
        return json(await handoffJob(env, agent, id, String(b.reason ?? ""), b.to, false, typeof b.log === "string" ? b.log : null, identity));
      }
      if (job[2] === "release" && method === "POST") {
        const { note } = await readJson<{ note?: string }>(request).catch(() => ({}) as { note?: string });
        await releaseJob(env, agent, id, note, false, identity);
        return json({ ok: true });
      }
    }
    return json({ error: "not found" }, 404);
  }

  // ---------- Admin login (ADMIN_TOKEN -> signed session cookie) ----------
  if (path === "/api/admin/login" && method === "POST") {
    const { token } = await readJson<{ token?: string }>(request);
    if (!token || !isAdminToken(env, token)) {
      await new Promise((r) => setTimeout(r, 750)); // slow down guessing
      return json({ error: "wrong admin token" }, 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env) });
  }
  if (path === "/api/admin/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearedCookie });
  }

  // ---------- Admin API (session cookie or admin bearer token) ----------
  if (path.startsWith("/api/admin/")) {
    const user = await adminUser(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    if (path === "/api/admin/me" && method === "GET") return json({ user });

    if (path === "/api/admin/tasks" && method === "GET") {
      return json({ demo: env.MOCK === "true", tasks: await loadTasks(env) });
    }

    // Email sending check: sends a test message (resume attached) to Preston's own address.
    if (path === "/api/admin/email/test" && method === "POST") {
      const b = await readJson<{ to?: string }>(request).catch(() => ({}) as { to?: string });
      return json(await sendTestEmail(env, b.to ?? "prestonzen@kaizenapps.com"));
    }

    // Jobs agents couldn't finish: worked in a signed-in Chrome with Preston nearby (Claude in Chrome), logs attached.
    if (path === "/api/admin/assisted" && method === "GET") return json(await assistedQueue(env));

    // Analytics: per-agent success, time to apply, ATS yield, queue health (rolling window).
    if (path === "/api/admin/analytics" && method === "GET") {
      const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30));
      return json(await buildAnalytics(env, days));
    }

    // Bug bounty lane: programs, scans, findings, reports, payouts.
    if (path === "/api/admin/bounty" && method === "GET") return json({...await bountySummary(env),cyber:await cyberSummary(env)});
    // CT 134 uses its admin credential to report scanner/Dark Moon output. Keep
    // service events separate from agent activity so an off agent is not shown
    // as active merely because the scanner posted through its old token.
    if (path === "/api/admin/bounty-events" && method === "POST") {
      const b = await readJson<BountyEventInput>(request);
      const kind = b.kind?.toLowerCase();
      if (kind !== "scan" && kind !== "finding") return json({ error: "Only scan and finding events are accepted" }, 400);
      const created = await addBountyEvent(env, "bounty-pipeline", b);
      if (b.program) ctx.waitUntil(syncCyber(env, { ...b, program: b.program }).catch((e) => console.error("cyber store sync:", e)));
      // Wins are announced as they land (Preston, 2026-10-21): a completed scan is a small win,
      // Preston, 2026-10-22: only a CONFIRMED finding pings immediately. Completed scans are
      // routine — they stay silent and roll into the daily digest's cyber summary instead
      // of spamming a message per program.
      if (kind === "finding" && b.status === "confirmed") {
        await notifyBounty(env, `🚨 <b>Bounty finding</b> — ${esc(b.program ?? b.target ?? "?")} (${esc(b.platform ?? "?")})${b.severity ? ` [${esc(b.severity)}]` : ""}\n${esc(b.title ?? "")}${b.detail ? `\n${esc(b.detail.slice(0, 300))}` : ""}`);
      }
      return json({ ok: true, agent: "bounty-pipeline", ...created }, 201);
    }
    // Technology matrix: CT 134 pushes parsed httpx tech-detect rows after recon passes.
    if (path === "/api/admin/bounty-tech" && method === "POST") {
      return json(await upsertBountyTech(env, await readJson(request)), 201);
    }
    // Hosts running a technology (validation dispatcher picks targets for research hypotheses).
    if (path === "/api/admin/bounty-hosts" && method === "GET") {
      return json(await bountyHosts(env, { tech: url.searchParams.get("tech"), program: url.searchParams.get("program"), limit: Number(url.searchParams.get("limit") ?? 100) }));
    }
    // One-task-per-program ClickUp list for the cyber lane; idempotent.
    if (path === "/api/admin/clickup/cyber-list" && method === "POST") return json(await ensureCyberList(env));
    if(path==='/api/admin/cyber' && method==='POST')return json(await enqueueCyber(env,await readJson(request)),201);
    const cyberReview=path.match(/^\/api\/admin\/cyber\/(\d+)\/review$/);
    if(cyberReview && method==='POST')return json(await reviewCyber(env,Number(cyberReview[1]),await readJson(request),adminName(env)));
    if(path==='/api/admin/cyber/continuous' && method==='PUT'){
      const b=await readJson<{enabled:boolean}>(request);
      if(typeof b.enabled!=='boolean')return json({error:'enabled must be boolean'},400);
      await setSetting(env,'cyber_continuous',b.enabled);return json({enabled:b.enabled});
    }
    // Auto-submit toggle + platform credentials (stored in D1 settings, never echoed back).
    // HackerOne submits via API; Bugcrowd submits via a browser run on the runner, using
    // the account login (TOTP secret included so the run can clear 2FA unattended).
    const autosubmitState=async()=>({
      enabled:!!await getSetting<boolean>(env,'bounty_autosubmit'),
      h1Configured:!!(await getSetting<string>(env,'h1_api_id'))&&!!(await getSetting<string>(env,'h1_api_token')),
      bugcrowdConfigured:!!(await getSetting<string>(env,'bugcrowd_email'))&&!!(await getSetting<string>(env,'bugcrowd_password'))&&!!(await getSetting<string>(env,'bugcrowd_totp')),
    });
    if(path==='/api/admin/bounty/autosubmit' && method==='PUT'){
      const b=await readJson<{enabled?:boolean;h1ApiId?:string;h1ApiToken?:string;bugcrowdEmail?:string;bugcrowdPassword?:string;bugcrowdTotp?:string}>(request);
      if(typeof b.enabled==='boolean')await setSetting(env,'bounty_autosubmit',b.enabled);
      if(typeof b.h1ApiId==='string'&&b.h1ApiId.trim())await setSetting(env,'h1_api_id',b.h1ApiId.trim());
      if(typeof b.h1ApiToken==='string'&&b.h1ApiToken.trim())await setSetting(env,'h1_api_token',b.h1ApiToken.trim());
      if(typeof b.bugcrowdEmail==='string'&&b.bugcrowdEmail.trim())await setSetting(env,'bugcrowd_email',b.bugcrowdEmail.trim());
      if(typeof b.bugcrowdPassword==='string'&&b.bugcrowdPassword.trim())await setSetting(env,'bugcrowd_password',b.bugcrowdPassword.trim());
      if(typeof b.bugcrowdTotp==='string'&&b.bugcrowdTotp.trim())await setSetting(env,'bugcrowd_totp',b.bugcrowdTotp.replace(/\s+/g,'').toUpperCase());
      return json(await autosubmitState());
    }
    if(path==='/api/admin/bounty/autosubmit' && method==='GET')return json(await autosubmitState());

    // Command center: queue + claims, agent activity and check-ins, per-agent totals.
    if (path === "/api/admin/hub" && method === "GET") {
      const [tasks, q, events, heartbeats] = await Promise.all([loadTasks(env), queue(env), listEvents(env, 150), listHeartbeats(env)]);
      const applied: Record<string, number> = {};
      for (const t of tasks) {
        if (isApplication(t, env) && t.status !== "not started" && t.status !== "rejected / paused") {
          const k = (t.appliedBy ?? "unknown").toLowerCase();
          applied[k] = (applied[k] ?? 0) + 1;
        }
      }
      const state = await autopilotStatus(env);
      const disabledAgents = state.agents.filter((a) => a.state === "off").map((a) => a.agent);
      return json({
        ready: state.agents.filter((a) => a.state === "ready").map((a) => a.agent),
        agentStates: state.agents,
        disabledAgents,
        demo: env.MOCK === "true",
        agents: agentNames(env),
        queue: q,
        events,
        heartbeats,
        applied,
        leaseMinutes: Number(env.LEASE_MINUTES) || 60,
      });
    }

    if (path === "/api/admin/instructions" && method === "GET") {
      const agent = (url.searchParams.get("agent") ?? "agent").toLowerCase();
      return text(agentInstructions(agent, url.origin, url.searchParams.get("mode") === "rest" ? "rest" : "mcp"));
    }

    if (path === "/api/admin/playbook" && method === "GET") return text(await playbook(env));
    if (path === "/api/admin/events" && method === "GET") return json(await exportEvents(env, Number(url.searchParams.get("days") ?? 30)));
    if (path === "/api/admin/playbook/pages" && method === "GET") return json(await listDocPages(env));
    // Exact in-place edits of a playbook page (each `find` must match exactly once, or nothing is written).
    if (path === "/api/admin/playbook/page" && method === "GET") return text((await getDocPage(env, url.searchParams.get("id") ?? "")).content);
    if (path === "/api/admin/playbook/patch" && method === "POST") {
      const b = await readJson<{ page?: string; edits?: { find: string; replace: string }[]; append?: string; dry?: boolean }>(request);
      if (!b.page) return json({ error: "page is required" }, 400);
      const res = b.edits?.length ? await patchDocPage(env, b.page, b.edits, !!b.dry) : { applied: false, report: [] as unknown[] };
      if (b.append && !b.dry && (res.applied || !b.edits?.length)) await appendDocPage(env, b.page, b.append);
      return json({ ...res, appended: !!b.append && !b.dry });
    }

    // Pacing (per-ATS / per-company limits across all agents).
    if (path === "/api/admin/autopilot" && method === "GET") return json(await autopilotStatus(env));
    if (path === "/api/admin/autopilot" && method === "PUT") {
      await saveAutopilot(env, await readJson(request));
      return json(await autopilotStatus(env));
    }
    if (path === "/api/admin/pacing" && method === "GET") {
      const policy = await getPolicy(env);
      return json({ policy, defaults: DEFAULT_POLICY, live: pacingSummary(await pacingState(env, await queue(env), policy), policy) });
    }
    if (path === "/api/admin/pacing" && method === "PUT") {
      const b = await readJson<Partial<PacingPolicy>>(request);
      await setSetting(env, "pacing", b);
      return json({ policy: await getPolicy(env) });
    }

    // Schedules.
    if (path === "/api/admin/schedules" && method === "GET") return json({ schedules: await listSchedules(env), sourceChecks: await sourceCheckStatus(env) });
    if (path === "/api/admin/schedules" && method === "POST") {
      const b = await readJson<{ name?: string; agent?: string; kind?: ScheduleKind; count?: number; copies?: number; prompt?: string; cron?: string; tz?: string; jitterMin?: number }>(request);
      if (!b.cron) return json({ error: "cron is required" }, 400);
      return json(await createSchedule(env, { ...b, kind: b.kind ?? "queue", cron: b.cron }), 201);
    }
    const sched = path.match(/^\/api\/admin\/schedules\/(\d+)$/);
    if (sched && method === "PATCH") return json(await updateSchedule(env, Number(sched[1]), await readJson<{ enabled?: boolean }>(request)));
    if (sched && method === "DELETE") {
      await deleteSchedule(env, Number(sched[1]));
      return json({ ok: true });
    }

    // Resume bank.
    if (path === "/api/admin/resumes" && method === "GET") return json({ resumes: await listResumes(env) });
    if (path === "/api/admin/resumes" && method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return json({ error: "file is required" }, 400);
      const f = file as unknown as { name: string; arrayBuffer(): Promise<ArrayBuffer> };
      return json(
        await uploadResume(env, { name: String(form.get("name") ?? ""), filename: f.name, tags: String(form.get("tags") ?? ""), isDefault: form.get("isDefault") === "true" }, await f.arrayBuffer()),
        201,
      );
    }
    const res = path.match(/^\/api\/admin\/resumes\/(\d+)(\/file)?$/);
    if (res && res[2] && method === "GET") return resumeFile(env, Number(res[1]));
    if (res && !res[2] && method === "PATCH") return json(await updateResume(env, Number(res[1]), await readJson(request)));
    if (res && !res[2] && method === "DELETE") {
      await deleteResume(env, Number(res[1]));
      return json({ ok: true });
    }
    if (path === "/api/admin/resume-pick" && method === "GET") return json(await pickResume(env, url.searchParams.get("role") ?? "", url.searchParams.get("text")));

    // Notifications + replies.
    if (path === "/api/admin/telegram/test" && method === "POST") {
      const err = await notify(env, "👋 Job Agent Hub is connected. Alerts for runs, jobs that need you, and recruiter replies will land in this topic.");
      return json({ ok: !err, error: err, configured: telegramConfigured(env) }); // 200 either way: Cloudflare replaces 502 bodies
    }
    // Manual runner command (e.g. open a URL on the application device's browser from the admin UI).
    if (path === "/api/admin/runner-command" && method === "POST") {
      const b = await readJson<{ runner?: string; kind?: string; url?: string }>(request);
      if (b.kind !== "open-url" || !b.url || !/^https?:\/\//i.test(b.url)) return json({ error: "kind=open-url and an http(s) url are required" }, 400);
      const id = await enqueueRunnerCommand(env, { runner: b.runner ?? "kloud", kind: "open-url", payload: { url: b.url } });
      return json({ ok: true, id }, 201);
    }
    if (path === "/api/admin/digest" && method === "POST") {
      const err = await sendDigest(env, url.origin);
      return json({ ok: !err, error: err });
    }
    const replyNotify=path.match(/^\/api\/admin\/inbound\/([^/]+)\/notify$/);
    if(replyNotify && method === "POST")return json(await recoverReplyNotification(env,replyNotify[1]));
    if (path === "/api/admin/inbound" && method === "GET") return json({ emails: await recentInbound(env) });
    // Assisted-tab helpers: download a kit's cover letter, send an agent to prep one job now, pull the job feeds now.
    const aclf = path.match(/^\/api\/admin\/cover-letters\/([A-Za-z0-9._-]+)$/);
    if (aclf && method === "GET") return coverLetterFile(env, decodeURIComponent(aclf[1]));
    const prep = path.match(/^\/api\/admin\/jobs\/([^/]+)\/prep$/);
    if (prep && method === "POST") {
      const b = await readJson<{ agent?: string }>(request).catch(() => ({}) as { agent?: string });
      return json(await prepNow(env, prep[1], b.agent ?? "claude"), 201);
    }
    if (path === "/api/admin/feeds/run" && method === "POST") { const ph = url.searchParams.get("phase"); return json(await runFeeds(env, true, PHASES.includes(ph as Phase) ? (ph as Phase) : undefined)); }
    // Tick an employer email as dealt with so it leaves the digest / /needs action list.
    const handled = path.match(/^\/api\/admin\/inbound\/([^/]+)\/handled$/);
    if (handled && method === "POST") return json({ ok: await markHandled(env, decodeURIComponent(handled[1])) });
    // Admin-authored Telegram note (e.g. "assessment drafted, review it"), loud by default.
    if (path === "/api/admin/notify" && method === "POST") {
      const b = await readJson<{ html?: string; silent?: boolean }>(request);
      if (!b.html?.trim()) return json({ error: "html is required" }, 400);
      return json({ ok: true, error: await notify(env, b.html.slice(0, 3500), { silent: !!b.silent }) });
    }
    if (path === "/api/admin/telegram/webhook-info" && method === "GET") return json(await webhookInfo(env));

    // ClickUp usage: local copy age, deferred writes, calls today.
    if (path === "/api/admin/clickup" && method === "GET") {
      const [age, tasks, outbox, usage] = await Promise.all([mirrorAge(env), mirrorTasks(env), outboxSize(env), usageToday(env)]);
      return json({ mirrorAgeMin: Number.isFinite(age) ? Math.round(age / 60_000) : null, tasks: tasks.length, outbox, callsToday: usage.clickup ?? 0 });
    }
    // Dual-run: copy ClickUp-side edits (status, Next Action, Applied By/On, Platform) into Huly. ?dry=1 reports only.
    if (path === "/api/admin/clickup/reconcile" && method === "POST") return json(await reconcileFromClickUp(env, url.searchParams.get("dry") === "1"));
    if (path === "/api/admin/clickup/refresh" && method === "POST") {
      const tasks = await loadTasks(env, { force: true });
      await getPlaybook(env, true).catch(() => {});
      const flushed = await flushOutbox(env, (m, p, body) => replayWrite(env, m, p, body));
      return json({ tasks: tasks.length, flushed, outbox: await outboxSize(env) });
    }
    if ((path === "/api/admin/telegram/disable-replies" || path === "/api/admin/telegram/set-webhook") && method === "POST") {
      const disabled = await disableTelegramReplies(env);
      return json(disabled, disabled.ok ? 200 : 502);
    }

    // Remote agent runs (executed by runner machines).
    if (path === "/api/admin/runs" && method === "GET") {
      ctx.waitUntil(tick(env, () => sendDigest(env, url.origin).then(() => {})).catch((e) => console.error("schedule tick:", e)));
      const [runs, runners, state] = await Promise.all([listRuns(env, Number(url.searchParams.get("limit")) || 50), listRunners(env), autopilotStatus(env)]);
      return json({ runs, runners, agentStates: state.agents });
    }
    if (path === "/api/admin/runs" && method === "POST") {
      const b = await readJson<{ agent?: string; kind?: RunKind; task?: RunTask; prompt?: string; count?: number; copies?: number }>(request);
      if (!b.agent) return json({ error: "agent is required" }, 400);
      const copies = Math.min(5, Math.max(1, Math.floor(b.copies ?? 1)));
      const created = [];
      for (let i = 0; i < copies; i++) created.push(await createRun(env, { agent: b.agent, kind: b.kind ?? "queue", task: b.task, prompt: b.prompt, count: b.count }));
      return json({ runs: created }, 201);
    }
    const runRoute = path.match(/^\/api\/admin\/runs\/(\d+)(?:\/(cancel))?$/);
    if (runRoute) {
      const id = Number(runRoute[1]);
      if (!runRoute[2] && method === "GET") return json(await getRun(env, id));
      if (runRoute[2] === "cancel" && method === "POST") return json(await cancelRun(env, id));
    }

    const adminJob = path.match(/^\/api\/admin\/jobs\/([^/]+)\/(release|report)$/);
    if (adminJob && method === "POST") {
      const id = decodeURIComponent(adminJob[1]);
      if (adminJob[2] === "release") {
        const { note } = await readJson<{ note?: string }>(request).catch(() => ({}) as { note?: string });
        await releaseJob(env, adminName(env), id, note, true);
        return json({ ok: true });
      }
      return json(await reportResult(env, adminName(env), id, await readJson<Report>(request), true));
    }

    // Requeue: fully un-park a task (note, name marker, Applied By stamp) so it is claimable again.
    const requeue = path.match(/^\/api\/admin\/tasks\/([^/]+)\/requeue$/);
    if (requeue && method === "POST") {
      if (env.MOCK === "true") return json({ ok: true, demo: true });
      return json({ ok: true, ...(await requeueTask(env, requeue[1])) });
    }
    const status = path.match(/^\/api\/admin\/tasks\/([^/]+)\/status$/);
    if (status && method === "PUT") {
      const { status: next } = await readJson<{ status?: string }>(request);
      if (!next) return json({ error: "status is required" }, 400);
      if (env.MOCK !== "true") await setStatus(env, status[1], next);
      return json({ ok: true });
    }

    const comment = path.match(/^\/api\/admin\/tasks\/([^/]+)\/comments$/);
    if (comment && method === "POST") {
      const { text: body } = await readJson<{ text?: string }>(request);
      if (!body) return json({ error: "text is required" }, 400);
      if (env.MOCK !== "true") await addComment(env, comment[1], `[hub:${user}] ${body}`);
      return json({ ok: true });
    }

    // Experimental: call stats for the Zadarma burner number.
    if (path === "/api/admin/phone/stats" && method === "GET") {
      const end = new Date();
      const start = new Date(end.getTime() - 7 * 86_400_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
      const data = await zadarmaGet(env, "/v1/statistics/", { start: fmt(start), end: fmt(end) });
      return json({ experimental: true, data });
    }

    return json({ error: "not found" }, 404);
  }

  if (path.startsWith("/api/")) return json({ error: "not found" }, 404);

  // ---------- Static app (only reached when running as a plain Worker) ----------
  return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "not found" }, 404);
}


/** Fleet totals for the public page: counts and hours only, never anything about a specific job. */
async function publicOps(env: Env): Promise<NonNullable<PublicSummary["ops"]>> {
  const d = await dbHandle(env);
  const [r, c, f] = await Promise.all([
    d
      .prepare(
        "SELECT COUNT(*) AS runs, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN started_at IS NOT NULL AND finished_at > started_at THEN finished_at - started_at ELSE 0 END) AS ms FROM runs WHERE kind != 'login' AND (task IS NULL OR task!='diagnostic') AND status IN ('succeeded','failed')",
      )
      .first<{ runs: number; ok: number | null; ms: number | null }>(),
    d.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'claimed'").first<{ n: number }>(),
    d.prepare("SELECT MIN(at) AS at FROM events").first<{ at: number | null }>(),
  ]);
  return {
    runs: r?.runs ?? 0,
    runsOk: r?.ok ?? 0,
    agentHours: Math.round(((r?.ms ?? 0) / 3_600_000) * 10) / 10,
    claims: c?.n ?? 0,
    since: f?.at ? new Date(f.at).toISOString().slice(0, 10) : null,
  };
}

/** Compute the public summary from ClickUp + hub activity, and save it as the latest snapshot. */
async function buildPublicSummary(env: Env): Promise<string> {
  const [tasks, claims, last, state] = await Promise.all([
    loadTasks(env),
    activeClaims(env).catch(() => new Map()),
    lastEventAt(env).catch(() => null),
    autopilotStatus(env),
  ]);
  const summary = toPublicSummary(tasks, env, env.MOCK === "true");
  summary.live = {
    agentsOnline: state.agents.filter((a) => a.online && a.state !== "off").map((a) => a.agent),
    agentsWorking: state.agents.filter((a) => a.state === "working").map((a) => a.agent),
    agentsReady: state.agents.filter((a) => a.state === "ready").map((a) => a.agent),
    inProgress: claims.size,
    lastActivityAt: last,
  };
  summary.ops = await publicOps(env).catch(() => undefined);
  const body = JSON.stringify(summary);
  await saveSnapshot(env, "public-summary-v2", body);
  return body;
}

/** Shared entry point for Pages Functions (functions/) and a plain Worker. */
export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await route(request, env, ctx);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "internal error" }, 500);
  }
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
