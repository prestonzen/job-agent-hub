import { adminEmail, agentName } from "./auth";
import { HttpError, addComment, createApplication, listTasks, setStatus, type NewApplication } from "./clickup";
import { mockTasks } from "./mock";
import { toPublicSummary } from "./sanitize";
import type { Env, Task } from "./types";
import { zadarmaGet } from "./zadarma";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

async function loadTasks(env: Env): Promise<{ tasks: Task[]; demo: boolean }> {
  if (env.MOCK === "true") return { tasks: mockTasks(env), demo: true };
  return { tasks: await listTasks(env), demo: false };
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
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
    const { tasks, demo } = await loadTasks(env);
    const res = json(toPublicSummary(tasks, env, demo), 200, { "Cache-Control": "public, max-age=60" });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  // ---------- Agent API (bearer token) ----------
  if (path === "/api/agent/applications" && method === "POST") {
    const agent = agentName(request, env);
    if (!agent) return json({ error: "unauthorized" }, 401);
    const body = await readJson<Partial<NewApplication>>(request);
    if (!body.company || !body.role) return json({ error: "company and role are required" }, 400);
    if (env.MOCK === "true") return json({ ok: true, demo: true, agent }, 201);
    const id = await createApplication(env, {
      company: String(body.company).slice(0, 120),
      role: String(body.role).slice(0, 160),
      platform: body.platform,
      appliedBy: agent, // identity comes from the token, not the body
      status: body.status,
      notes: body.notes ? String(body.notes).slice(0, 4000) : undefined,
      url: body.url,
      appliedOn: body.appliedOn,
    });
    return json({ ok: true, id, agent }, 201);
  }

  // ---------- Admin API (Cloudflare Access) ----------
  if (path.startsWith("/api/admin/")) {
    const email = await adminEmail(request, env);
    if (!email) return json({ error: "unauthorized — sign in via Cloudflare Access" }, 401);

    if (path === "/api/admin/me" && method === "GET") return json({ email });

    if (path === "/api/admin/tasks" && method === "GET") {
      const { tasks, demo } = await loadTasks(env);
      return json({ demo, tasks });
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
      const { text } = await readJson<{ text?: string }>(request);
      if (!text) return json({ error: "text is required" }, 400);
      if (env.MOCK !== "true") await addComment(env, comment[1], `[hub:${email}] ${text}`);
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

  // ---------- Static app ----------
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
