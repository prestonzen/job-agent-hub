import { adminEmail, agentName, agentNames } from "./auth";
import { HttpError, addComment, setStatus } from "./clickup";
import { heartbeat, listEvents, listHeartbeats } from "./db";
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
    const tasks = await loadTasks(env);
    const res = json(toPublicSummary(tasks, env, env.MOCK === "true"), 200, { "Cache-Control": "public, max-age=60" });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      demo: env.MOCK === "true",
      clickup: !!env.CLICKUP_TOKEN,
      agents: agentNames(env).length,
      accessConfigured: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.ADMIN_EMAILS),
    });
  }

  // ---------- MCP (bearer token) ----------
  if (path === "/mcp" || path === "/api/mcp") {
    const agent = agentName(request, env);
    if (!agent) return unauthorizedAgent();
    ctx.waitUntil(heartbeat(env, agent, `mcp ${request.headers.get("User-Agent") ?? ""}`).catch(() => {}));
    return handleMcp(request, env, agent);
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

  // ---------- Admin API (Cloudflare Access) ----------
  if (path.startsWith("/api/admin/")) {
    const email = await adminEmail(request, env);
    if (!email) return json({ error: "unauthorized: sign in via Cloudflare Access" }, 401);

    if (path === "/api/admin/me" && method === "GET") return json({ email });

    if (path === "/api/admin/tasks" && method === "GET") {
      return json({ demo: env.MOCK === "true", tasks: await loadTasks(env) });
    }

    // Command center: queue + claims, agent activity and check-ins, per-agent totals.
    if (path === "/api/admin/hub" && method === "GET") {
      const [tasks, q, events, heartbeats] = await Promise.all([loadTasks(env), queue(env), listEvents(env, 150), listHeartbeats(env)]);
      const applied: Record<string, number> = {};
      for (const t of tasks) {
        if (t.parentId === env.PARENT_TASK_ID && t.status !== "not started" && t.status !== "rejected / paused") {
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
      if (env.MOCK !== "true") await addComment(env, comment[1], `[hub:${email}] ${body}`);
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
