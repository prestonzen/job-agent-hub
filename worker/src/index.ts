import { adminUser, agentName, agentNames, clearedCookie, isAdminToken, sessionCookie } from "./auth";
import { HttpError, addComment, setStatus } from "./clickup";
import { isApplication } from "./classify";
import { activeClaims, heartbeat, lastEventAt, listEvents, listHeartbeats, loadSnapshot, saveSnapshot, setSetting } from "./db";
import { agentInstructions } from "./instructions";
import {
  addJob,
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
import { sendDigest } from "./digest";
import { handleInbound, recentInbound, type InboundEmail } from "./inbound";
import { DEFAULT_POLICY, getPolicy, pacingState, pacingSummary, type PacingPolicy } from "./pacing";
import { deleteResume, listResumes, pickResume, resumeFile, updateResume, uploadResume } from "./resumes";
import { createSchedule, deleteSchedule, listSchedules, tick, updateSchedule, type ScheduleKind } from "./schedules";
import { notify, telegramConfigured } from "./telegram";
import { toPublicSummary } from "./sanitize";
import type { Env } from "./types";
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

  // ---------- MCP (bearer token) ----------
  if (path === "/mcp" || path === "/api/mcp") {
    const agent = agentName(request, env);
    if (!agent) return unauthorizedAgent();
    ctx.waitUntil(heartbeat(env, agent, `mcp ${request.headers.get("User-Agent") ?? ""}`).catch(() => {}));
    return handleMcp(request, env, agent);
  }

  // ---------- Runner API (RUNNER_TOKEN): machines that execute agent runs ----------
  if (path.startsWith("/api/runner/")) {
    if (!isRunnerToken(env, request)) return json({ error: "unauthorized" }, 401);
    const sub = path.slice("/api/runner".length);
    if (sub === "/heartbeat" && method === "POST") {
      const b = await readJson<Parameters<typeof runnerHeartbeat>[1]>(request);
      if (!b.name) return json({ error: "name is required" }, 400);
      await runnerHeartbeat(env, b);
      ctx.waitUntil(tick(env, () => sendDigest(env, url.origin).then(() => {})).catch((e) => console.error("schedule tick:", e)));
      return json({ ok: true });
    }
    if (sub === "/resumes" && method === "GET") return json({ resumes: await listResumes(env) });
    const rf = sub.match(/^\/resumes\/(\d+)\/file$/);
    if (rf && method === "GET") return resumeFile(env, Number(rf[1]));
    if (sub === "/claim" && method === "POST") {
      const b = await readJson<{ name?: string; agents?: string[] }>(request);
      if (!b.name) return json({ error: "name is required" }, 400);
      return json({ run: await claimRun(env, b.name, Array.isArray(b.agents) ? b.agents : [], url.origin) });
    }
    const m = sub.match(/^\/runs\/(\d+)\/(log|finish)$/);
    if (m && method === "POST") {
      const id = Number(m[1]);
      if (m[2] === "log") {
        const b = await readJson<{ name?: string; chunk?: string }>(request);
        return json(await appendLog(env, id, String(b.name ?? ""), String(b.chunk ?? "")));
      }
      const b = await readJson<{ name?: string; exitCode?: number | null; cancelled?: boolean }>(request);
      await finishRun(env, id, String(b.name ?? ""), { exitCode: b.exitCode ?? null, cancelled: !!b.cancelled });
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  // ---------- Agent REST API (bearer token) ----------
  if (path.startsWith("/api/agent/")) {
    const agent = agentName(request, env);
    if (!agent) return unauthorizedAgent();
    ctx.waitUntil(heartbeat(env, agent, `rest ${request.headers.get("User-Agent") ?? ""}`).catch(() => {}));
    const sub = path.slice("/api/agent".length);

    if (sub === "/me" && method === "GET") return json({ agent });
    if (sub === "/instructions" && method === "GET") return text(agentInstructions(agent, url.origin, "rest"));
    if (sub === "/playbook" && method === "GET") return text(await playbook(env));
    if (sub === "/resume" && method === "GET") {
      const pick = await pickResume(env, url.searchParams.get("role") ?? "");
      return json(pick ? { ...pick, downloadUrl: `${url.origin}/api/agent/resumes/${pick.id}/file` } : { error: "resume bank is empty" }, pick ? 200 : 404);
    }
    const arf = sub.match(/^\/resumes\/(\d+)\/file$/);
    if (arf && method === "GET") return resumeFile(env, Number(arf[1]));

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
      return json(await claimJobs(env, agent, { count: body.count, ats: Array.isArray(body.ats) ? body.ats : undefined }));
    }

    if (sub === "/jobs" && method === "POST") {
      return json(await addJob(env, agent, newJob(await readJson(request))), 201);
    }

    if (sub === "/applications" && method === "POST") {
      return json({ ok: true, agent, ...(await logApplication(env, agent, newJob(await readJson(request)))) }, 201);
    }

    const job = sub.match(/^\/jobs\/([^/]+)(?:\/(renew|report|release))?$/);
    if (job) {
      const id = decodeURIComponent(job[1]);
      if (!job[2] && method === "GET") return json(await getJob(env, id));
      if (job[2] === "renew" && method === "POST") return json(await renewLease(env, agent, id));
      if (job[2] === "report" && method === "POST") return json(await reportResult(env, agent, id, await readJson<Report>(request)));
      if (job[2] === "release" && method === "POST") {
        const { note } = await readJson<{ note?: string }>(request).catch(() => ({}) as { note?: string });
        await releaseJob(env, agent, id, note);
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
      return json({
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

    // Pacing (per-ATS / per-company limits across all agents).
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
    if (path === "/api/admin/schedules" && method === "GET") return json({ schedules: await listSchedules(env) });
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
    if (path === "/api/admin/resume-pick" && method === "GET") return json(await pickResume(env, url.searchParams.get("role") ?? ""));

    // Notifications + replies.
    if (path === "/api/admin/telegram/test" && method === "POST") {
      const err = await notify(env, "👋 Job Agent Hub is connected. Alerts for runs, jobs that need you, and recruiter replies will land in this topic.");
      return json({ ok: !err, error: err, configured: telegramConfigured(env) }); // 200 either way: Cloudflare replaces 502 bodies
    }
    if (path === "/api/admin/digest" && method === "POST") {
      const err = await sendDigest(env, url.origin);
      return json({ ok: !err, error: err });
    }
    if (path === "/api/admin/inbound" && method === "GET") return json({ emails: await recentInbound(env) });

    // Remote agent runs (executed by runner machines).
    if (path === "/api/admin/runs" && method === "GET") {
      ctx.waitUntil(tick(env, () => sendDigest(env, url.origin).then(() => {})).catch((e) => console.error("schedule tick:", e)));
      const [runs, runners] = await Promise.all([listRuns(env, Number(url.searchParams.get("limit")) || 50), listRunners(env)]);
      return json({ runs, runners });
    }
    if (path === "/api/admin/runs" && method === "POST") {
      const b = await readJson<{ agent?: string; kind?: RunKind; prompt?: string; count?: number; copies?: number }>(request);
      if (!b.agent) return json({ error: "agent is required" }, 400);
      const copies = Math.min(5, Math.max(1, Math.floor(b.copies ?? 1)));
      const created = [];
      for (let i = 0; i < copies; i++) created.push(await createRun(env, { agent: b.agent, kind: b.kind ?? "queue", prompt: b.prompt, count: b.count }));
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
        await releaseJob(env, "human", id, note, true);
        return json({ ok: true });
      }
      return json(await reportResult(env, "human", id, await readJson<Report>(request), true));
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

const ONLINE_MS = 15 * 60_000;

/** Compute the public summary from ClickUp + hub activity, and save it as the latest snapshot. */
async function buildPublicSummary(env: Env): Promise<string> {
  const [tasks, beats, claims, last] = await Promise.all([
    loadTasks(env),
    listHeartbeats(env).catch(() => []),
    activeClaims(env).catch(() => new Map()),
    lastEventAt(env).catch(() => null),
  ]);
  const summary = toPublicSummary(tasks, env, env.MOCK === "true");
  summary.live = {
    agentsOnline: beats.filter((b) => Date.now() - Date.parse(b.lastSeen) < ONLINE_MS).map((b) => b.agent),
    inProgress: claims.size,
    lastActivityAt: last,
  };
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
