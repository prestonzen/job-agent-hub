import { HttpError } from "./clickup";
import { db } from "./db";
import { createRun } from "./runs";
import type { Env } from "./types";

/**
 * Scheduled runs. Pages Functions have no cron triggers, so schedules are evaluated lazily by
 * tick(): it runs on every runner heartbeat (~30 s) and admin load, and fires anything due.
 * kind "queue"/"prompt" queue agent runs; kind "digest" posts a Telegram summary (no runner needed).
 */

export const SCHEDULE_KINDS = ["queue", "prompt", "digest"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export interface Schedule {
  id: number;
  name: string;
  agent: string | null;
  kind: ScheduleKind;
  count: number | null;
  copies: number;
  prompt: string | null;
  cron: string;
  tz: string;
  enabled: boolean;
  /** Random start delay, 0..jitterMin minutes, per fire (parallel copies are spread further). */
  jitterMin: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  agent TEXT,
  kind TEXT NOT NULL,
  count INTEGER,
  copies INTEGER NOT NULL DEFAULT 1,
  prompt TEXT,
  cron TEXT NOT NULL,
  tz TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL
)`;

let ready = false;
async function sdb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.prepare(SCHEMA).run();
    await d.prepare("ALTER TABLE schedules ADD COLUMN jitter_min INTEGER NOT NULL DEFAULT 20").run().catch(() => {});
    ready = true;
  }
  return d;
}

// ---------- cron (5 fields: minute hour day-of-month month day-of-week; *, lists, ranges, steps) ----------

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min, hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b ?? (stepStr ? max : a);
    }
    if (![lo, hi, step].every(Number.isInteger) || lo < min || hi > max || step < 1) throw new HttpError(400, `bad cron field "${spec}"`);
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(cron: string) {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) throw new HttpError(400, "cron needs 5 fields: minute hour day month weekday");
  return { min: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31), mon: field(f[3], 1, 12), dow: field(f[4], 0, 7), domAny: f[2] === "*", dowAny: f[4] === "*" };
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Next matching minute strictly after `from`, evaluated in time zone `tz`. */
export function nextRun(cron: string, tz: string, from = Date.now()): number | null {
  const c = parseCron(cron);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" });
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 * 24 * 32; i++, t += 60_000) {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    const m = +p.minute, h = +p.hour, d = +p.day, mo = +p.month, w = WD[p.weekday];
    if (!c.min.has(m) || !c.hour.has(h) || !c.mon.has(mo)) continue;
    const domOk = c.dom.has(d), dowOk = c.dow.has(w);
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (dayOk) return t;
  }
  return null;
}

// ---------- CRUD ----------

interface Row {
  id: number; name: string; agent: string | null; kind: ScheduleKind; count: number | null; copies: number; prompt: string | null;
  cron: string; tz: string; enabled: number; jitter_min: number; last_run_at: number | null; next_run_at: number | null;
}
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const toSchedule = (r: Row): Schedule => ({
  id: r.id, name: r.name, agent: r.agent, kind: r.kind, count: r.count, copies: r.copies, prompt: r.prompt,
  cron: r.cron, tz: r.tz, enabled: !!r.enabled, jitterMin: r.jitter_min ?? 0, lastRunAt: iso(r.last_run_at), nextRunAt: iso(r.next_run_at),
});

export async function listSchedules(env: Env): Promise<Schedule[]> {
  const { results } = await (await sdb(env)).prepare("SELECT * FROM schedules ORDER BY id").all<Row>();
  return results.map(toSchedule);
}

export async function createSchedule(
  env: Env,
  s: { name?: string; agent?: string; kind: ScheduleKind; count?: number; copies?: number; prompt?: string; cron: string; tz?: string; jitterMin?: number },
): Promise<Schedule> {
  if (!SCHEDULE_KINDS.includes(s.kind)) throw new HttpError(400, `kind must be one of ${SCHEDULE_KINDS.join(", ")}`);
  if (s.kind !== "digest" && !s.agent) throw new HttpError(400, "agent is required");
  if (s.kind === "prompt" && !s.prompt?.trim()) throw new HttpError(400, "prompt is required");
  const tz = s.tz || "America/Los_Angeles";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new HttpError(400, `unknown time zone ${tz}`);
  }
  const next = nextRun(s.cron, tz);
  const name = s.name?.trim() || (s.kind === "digest" ? "Daily digest" : s.kind === "queue" ? `${s.agent}: work ${s.count ?? 4} jobs` : `${s.agent}: custom`);
  const r = await (await sdb(env))
    .prepare(
      `INSERT INTO schedules (name, agent, kind, count, copies, prompt, cron, tz, next_run_at, created_at, jitter_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      name.slice(0, 80), s.kind === "digest" ? null : s.agent!.toLowerCase(), s.kind,
      s.kind === "queue" ? Math.min(10, Math.max(1, s.count ?? 4)) : null,
      Math.min(5, Math.max(1, s.copies ?? 1)), s.kind === "prompt" ? s.prompt!.trim().slice(0, 8000) : null,
      s.cron.trim(), tz, next, Date.now(), Math.min(120, Math.max(0, Math.round(s.jitterMin ?? 20))),
    )
    .first<Row>();
  return toSchedule(r!);
}

export async function updateSchedule(env: Env, id: number, patch: { enabled?: boolean }): Promise<Schedule> {
  const d = await sdb(env);
  const r = await d.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<Row>();
  if (!r) throw new HttpError(404, `no schedule ${id}`);
  const enabled = patch.enabled ?? !!r.enabled;
  const next = enabled ? nextRun(r.cron, r.tz) : null;
  const u = await d.prepare("UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ? RETURNING *").bind(enabled ? 1 : 0, next, id).first<Row>();
  return toSchedule(u!);
}

export async function deleteSchedule(env: Env, id: number): Promise<void> {
  await (await sdb(env)).prepare("DELETE FROM schedules WHERE id = ?").bind(id).run();
}

// ---------- tick ----------

/**
 * Fire due schedules. Each due row is claimed by advancing next_run_at in a single conditional
 * UPDATE, so concurrent ticks (several runners, admin loads) never fire the same slot twice.
 */
export async function tick(env: Env, onDigest: () => Promise<void>): Promise<number> {
  const d = await sdb(env);
  const now = Date.now();
  const { results } = await d.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").bind(now).all<Row>();
  let fired = 0;
  for (const r of results) {
    const next = nextRun(r.cron, r.tz, now);
    const won = await d
      .prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ? AND next_run_at = ?")
      .bind(now, next, r.id, r.next_run_at)
      .run();
    if (won.meta.changes !== 1) continue;
    fired++;
    if (r.kind === "digest") {
      await onDigest().catch((e) => console.error("digest:", e));
      continue;
    }
    // Random start within the jitter window; each parallel copy starts a few more random minutes later.
    let start = now + Math.random() * (r.jitter_min ?? 0) * 60_000;
    for (let i = 0; i < r.copies; i++) {
      await createRun(env, { agent: r.agent!, kind: r.kind, count: r.count ?? undefined, prompt: r.prompt ?? undefined, notBefore: Math.round(start) });
      start += (3 + Math.random() * 9) * 60_000;
    }
  }
  return fired;
}
