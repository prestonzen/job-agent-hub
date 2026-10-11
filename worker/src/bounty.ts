import { db } from "./db";
import { HttpError } from "./clickup";
import type { Env } from "./types";

/**
 * Bug bounty lane: same "agents find work" idea, different game — instead of applying to jobs,
 * agents enroll in disclosure programs, scan in-scope assets, and submit findings for payouts.
 * Events are pushed by runner-side tooling (recon scanners, the autonomous pentest stack) through
 * POST /api/agent/bounty and roll up here for the admin Bug bounty tab and the main analytics.
 */

export const BOUNTY_KINDS = ["program", "scan", "finding", "report", "payout"] as const;
export type BountyKind = (typeof BOUNTY_KINDS)[number];

export const BOUNTY_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export interface BountyEventInput {
  kind?: string;
  platform?: string;
  program?: string;
  target?: string;
  severity?: string;
  status?: string;
  title?: string;
  detail?: string;
  /** Payout amount in USD (only meaningful for kind=payout). */
  amount?: number;
}

export interface BountyEvent {
  id: number;
  at: string;
  agent: string;
  kind: BountyKind;
  platform: string | null;
  program: string | null;
  target: string | null;
  severity: string | null;
  status: string | null;
  title: string | null;
  detail: string | null;
  amount: number | null;
}

export interface BountyProgramRollup {
  program: string;
  platform: string | null;
  scans: number;
  findings: number;
  reports: number;
  payoutsUsd: number;
  lastAt: string;
}

export interface BountySummary {
  generatedAt: string;
  totals: {
    programs: number;
    scans: number;
    hostsScanned: number;
    findings: number;
    bySeverity: Record<string, number>;
    reports: number;
    payouts: number;
    payoutsUsd: number;
  };
  programs: BountyProgramRollup[];
  recent: BountyEvent[];
}

const s = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** Record one bounty-lane event. Agent-authenticated; called by runner tooling and agents. */
export async function addBountyEvent(env: Env, agent: string, body: BountyEventInput): Promise<{ id: number }> {
  const kind = body.kind?.toLowerCase() ?? "";
  if (!(BOUNTY_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `kind must be one of: ${BOUNTY_KINDS.join(", ")}`);
  }
  if (kind !== "scan" && !s(body.title, 200) && !s(body.program, 120)) {
    throw new HttpError(400, "title or program is required");
  }
  const severity = s(body.severity, 10)?.toLowerCase() ?? null;
  if (severity && !(BOUNTY_SEVERITIES as readonly string[]).includes(severity)) {
    throw new HttpError(400, `severity must be one of: ${BOUNTY_SEVERITIES.join(", ")}`);
  }
  const amount = typeof body.amount === "number" && Number.isFinite(body.amount) && body.amount >= 0 ? Math.round(body.amount * 100) / 100 : null;
  const res = await (
    await db(env)
  )
    .prepare(
      `INSERT INTO bounty_events (at, agent, kind, platform, program, target, severity, status, title, detail, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      Date.now(),
      agent,
      kind,
      s(body.platform, 40)?.toLowerCase() ?? null,
      s(body.program, 120),
      s(body.target, 300),
      severity,
      s(body.status, 40)?.toLowerCase() ?? null,
      s(body.title, 200),
      s(body.detail, 4000),
      kind === "payout" ? amount : null,
    )
    .run();
  return { id: Number(res.meta.last_row_id) };
}

interface Row {
  id: number;
  at: number;
  agent: string;
  kind: string;
  platform: string | null;
  program: string | null;
  target: string | null;
  severity: string | null;
  status: string | null;
  title: string | null;
  detail: string | null;
  amount: number | null;
}

const toEvent = (r: Row): BountyEvent => ({ ...r, kind: r.kind as BountyKind, at: new Date(r.at).toISOString() });

/** Totals over the whole bounty lane (bounty work is low-volume; no window needed yet). */
export async function bountyTotals(env: Env): Promise<BountySummary["totals"]> {
  const d = await db(env);
  const empty = { programs: 0, scans: 0, hostsScanned: 0, findings: 0, bySeverity: {} as Record<string, number>, reports: 0, payouts: 0, payoutsUsd: 0 };
  const [counts, sev, pay] = await Promise.all([
    d
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN kind = 'program' THEN program END) AS programs,
           SUM(CASE WHEN kind = 'scan' THEN 1 ELSE 0 END) AS scans,
           COUNT(DISTINCT CASE WHEN kind = 'scan' THEN target END) AS hostsScanned,
           SUM(CASE WHEN kind = 'finding' THEN 1 ELSE 0 END) AS findings,
           SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END) AS reports,
           SUM(CASE WHEN kind = 'payout' THEN 1 ELSE 0 END) AS payouts
         FROM bounty_events`,
      )
      .first<Omit<typeof empty, "bySeverity" | "payoutsUsd">>()
      .catch(() => null),
    d
      .prepare("SELECT severity, COUNT(*) AS n FROM bounty_events WHERE kind = 'finding' AND severity IS NOT NULL GROUP BY severity")
      .all<{ severity: string; n: number }>()
      .catch(() => ({ results: [] as { severity: string; n: number }[] })),
    d
      .prepare("SELECT SUM(amount) AS usd FROM bounty_events WHERE kind = 'payout'")
      .first<{ usd: number | null }>()
      .catch(() => null),
  ]);
  if (!counts) return empty;
  return {
    programs: counts.programs ?? 0,
    scans: counts.scans ?? 0,
    hostsScanned: counts.hostsScanned ?? 0,
    findings: counts.findings ?? 0,
    bySeverity: Object.fromEntries(sev.results.map((r) => [r.severity, r.n])),
    reports: counts.reports ?? 0,
    payouts: counts.payouts ?? 0,
    payoutsUsd: Math.round((pay?.usd ?? 0) * 100) / 100,
  };
}

/** Full view for the admin Bug bounty tab. */
export async function bountySummary(env: Env): Promise<BountySummary> {
  const d = await db(env);
  const [totals, progs, recent] = await Promise.all([
    bountyTotals(env),
    d
      .prepare(
        `SELECT program, MAX(platform) AS platform,
                SUM(CASE WHEN kind = 'scan' THEN 1 ELSE 0 END) AS scans,
                SUM(CASE WHEN kind = 'finding' THEN 1 ELSE 0 END) AS findings,
                SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END) AS reports,
                SUM(CASE WHEN kind = 'payout' THEN amount ELSE 0 END) AS payoutsUsd,
                MAX(at) AS lastAt
         FROM bounty_events WHERE program IS NOT NULL
         GROUP BY program ORDER BY lastAt DESC LIMIT 50`,
      )
      .all<{ program: string; platform: string | null; scans: number; findings: number; reports: number; payoutsUsd: number | null; lastAt: number }>()
      .catch(() => ({ results: [] as { program: string; platform: string | null; scans: number; findings: number; reports: number; payoutsUsd: number | null; lastAt: number }[] })),
    d
      .prepare("SELECT * FROM bounty_events ORDER BY at DESC LIMIT 50")
      .all<Row>()
      .catch(() => ({ results: [] as Row[] })),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    totals,
    programs: progs.results.map((r) => ({
      program: r.program,
      platform: r.platform,
      scans: r.scans,
      findings: r.findings,
      reports: r.reports,
      payoutsUsd: Math.round((r.payoutsUsd ?? 0) * 100) / 100,
      lastAt: new Date(r.lastAt).toISOString(),
    })),
    recent: recent.results.map(toEvent),
  };
}
