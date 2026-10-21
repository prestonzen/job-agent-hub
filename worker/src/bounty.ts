import { db, logEvent } from "./db";
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
  /** Most-seen technologies on this program's live hosts (from the tech matrix). */
  stack: string[];
}

export interface BountyTechStat {
  tech: string;
  programs: number;
  hosts: number;
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
  /** Technology matrix across all scanned programs (httpx tech-detect, pushed by CT 134). */
  tech: { programsProfiled: number; hostsProfiled: number; lastIngest: string | null; top: BountyTechStat[] };
  programs: BountyProgramRollup[];
  recent: BountyEvent[];
}

const s = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/**
 * The scanner's scan-done detail is one run-on funnel ("0 wildcard roots and 7 exact targets ->
 * 7 in-scope hosts -> 5 live hosts -> 0\n0 nuclei observations. Raw results on CT 134: /root/bbscans/X").
 * Turn it into labeled Telegram lines; anything unrecognized is returned as-is (truncated).
 */
export function scanReportLines(detail: string): string[] {
  const d = detail.replace(/\s+/g, " ").trim();
  if (!d) return [];
  const lines: string[] = [];
  const scope = d.match(/(\d+)\s+wildcard roots? and (\d+)\s+exact targets?/);
  if (scope) lines.push(`Scope: ${scope[1]} wildcard roots, ${scope[2]} exact targets`);
  const funnel = d.match(/(\d+)\s+in-scope hosts? ->\s*(\d+)\s+live hosts? ->\s*(\d+)/);
  if (funnel) lines.push(`Funnel: ${funnel[1]} in-scope hosts → ${funnel[2]} live → ${funnel[3]} nuclei hits`);
  const nuclei = d.match(/(\d+)\s+nuclei observations?/);
  if (nuclei && !funnel) lines.push(`Nuclei observations: ${nuclei[1]}`);
  const wayback = d.match(/wayback harvest:?\s*(\d+)\s*(?:raw\s*)?urls?/i);
  if (wayback) lines.push(`Wayback URLs harvested: ${wayback[1]}`);
  const raw = d.match(/Raw results on CT ?134:\s*(\S+)/i);
  if (raw) lines.push(`Raw results (CT134): ${raw[1]}`);
  return lines.length ? lines : [d.slice(0, 250)];
}

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
  if (kind === "report" && body.platform?.toLowerCase() !== "benchmark") await logEvent(env, { agent, type: "cyber_report", message: s(body.title, 200), company: s(body.program, 120) });
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

export interface BountyTechHostInput {
  host?: string;
  status?: number;
  title?: string;
  techs?: string[];
}
export interface BountyTechProgramInput {
  program?: string;
  platform?: string;
  hosts?: BountyTechHostInput[];
}

/**
 * Replace one scan's worth of tech-detect rows for each listed program. CT 134 pushes
 * the full parsed httpx output after every recon pass, so a rescan naturally refreshes
 * the program's stack; hosts not seen anymore disappear.
 */
export async function upsertBountyTech(env: Env, body: { programs?: BountyTechProgramInput[] }): Promise<{ programs: number; hosts: number }> {
  const programs = Array.isArray(body.programs) ? body.programs.slice(0, 200) : [];
  const d = await db(env);
  const now = Date.now();
  let hostCount = 0;
  for (const p of programs) {
    const program = s(p.program, 120);
    if (!program) continue;
    const platform = s(p.platform, 40)?.toLowerCase() ?? null;
    const hosts = (Array.isArray(p.hosts) ? p.hosts : []).slice(0, 2000);
    const stmts: D1PreparedStatement[] = [d.prepare("DELETE FROM bounty_hosts WHERE program = ?").bind(program)];
    for (const h of hosts) {
      const host = s(h.host, 300);
      if (!host) continue;
      const techs = (Array.isArray(h.techs) ? h.techs : []).map((t) => s(t, 80)).filter((t): t is string => !!t).slice(0, 40);
      const status = typeof h.status === "number" && Number.isFinite(h.status) ? Math.trunc(h.status) : null;
      stmts.push(
        d
          .prepare(
            `INSERT INTO bounty_hosts (program, platform, host, status, title, techs, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (program, host) DO UPDATE SET platform=excluded.platform, status=excluded.status,
               title=excluded.title, techs=excluded.techs, last_seen=excluded.last_seen`,
          )
          .bind(program, platform, host, status, s(h.title, 200), JSON.stringify(techs), now, now),
      );
      hostCount++;
    }
    // D1 batches cap at ~1000 statements; a program with more hosts is ingested in chunks.
    for (let i = 0; i < stmts.length; i += 500) await d.batch(stmts.slice(i, i + 500));
  }
  return { programs: programs.length, hosts: hostCount };
}

/** "Who runs what": technology frequency across the whole scanned surface, plus per-program stacks. */
export async function techMatrixStats(env: Env): Promise<{ stats: BountySummary["tech"]; stacks: Map<string, string[]> }> {
  const d = await db(env);
  const empty = { stats: { programsProfiled: 0, hostsProfiled: 0, lastIngest: null, top: [] as BountyTechStat[] }, stacks: new Map<string, string[]>() };
  const [top, perProgram, meta] = await Promise.all([
    d
      .prepare(
        `SELECT je.value AS tech, COUNT(DISTINCT program) AS programs, COUNT(*) AS hosts
         FROM bounty_hosts, json_each(bounty_hosts.techs) je
         GROUP BY je.value ORDER BY programs DESC, hosts DESC LIMIT 40`,
      )
      .all<{ tech: string; programs: number; hosts: number }>()
      .catch(() => ({ results: [] as { tech: string; programs: number; hosts: number }[] })),
    d
      .prepare(
        `SELECT program, je.value AS tech, COUNT(*) AS n
         FROM bounty_hosts, json_each(bounty_hosts.techs) je
         GROUP BY program, je.value ORDER BY program, n DESC`,
      )
      .all<{ program: string; tech: string; n: number }>()
      .catch(() => ({ results: [] as { program: string; tech: string; n: number }[] })),
    d
      .prepare("SELECT COUNT(DISTINCT program) AS programs, COUNT(*) AS hosts, MAX(last_seen) AS last FROM bounty_hosts")
      .first<{ programs: number; hosts: number; last: number | null }>()
      .catch(() => null),
  ]);
  if (!meta) return empty;
  const stacks = new Map<string, string[]>();
  for (const r of perProgram.results) {
    const list = stacks.get(r.program) ?? [];
    if (list.length < 6) list.push(r.tech);
    stacks.set(r.program, list);
  }
  return {
    stats: {
      programsProfiled: meta.programs ?? 0,
      hostsProfiled: meta.hosts ?? 0,
      lastIngest: meta.last ? new Date(meta.last).toISOString() : null,
      top: top.results,
    },
    stacks,
  };
}

const toEvent = (r: Row): BountyEvent => ({ ...r, kind: r.kind as BountyKind, at: new Date(r.at).toISOString() });

/**
 * Hosts running a given technology (or all hosts of one program), for the validation dispatcher
 * on CT 134: a "Tech research: X" hypothesis needs a real in-scope host that runs X.
 */
export async function bountyHosts(env: Env, opts: { tech?: string | null; program?: string | null; limit?: number }): Promise<unknown[]> {
  const d = await db(env);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  if (opts.tech) {
    const { results } = await d
      .prepare(
        `SELECT h.program, h.platform, h.host, h.status, h.title, h.last_seen
         FROM bounty_hosts h, json_each(h.techs) je
         WHERE LOWER(je.value) = LOWER(?1) ORDER BY h.last_seen DESC LIMIT ?2`,
      )
      .bind(opts.tech, limit)
      .all();
    return results;
  }
  if (opts.program) {
    const { results } = await d
      .prepare("SELECT program, platform, host, status, title, techs, last_seen FROM bounty_hosts WHERE program = ? ORDER BY last_seen DESC LIMIT ?")
      .bind(opts.program, limit)
      .all();
    return results;
  }
  return [];
}

/** Totals over the whole bounty lane (bounty work is low-volume; no window needed yet). */
export async function bountyTotals(env: Env): Promise<BountySummary["totals"]> {
  const d = await db(env);
  const empty = { programs: 0, scans: 0, hostsScanned: 0, findings: 0, bySeverity: {} as Record<string, number>, reports: 0, payouts: 0, payoutsUsd: 0 };
  const [counts, sev, pay] = await Promise.all([
    d
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN kind = 'scan' THEN program END) AS programs,
           SUM(CASE WHEN kind = 'scan' THEN 1 ELSE 0 END) AS scans,
           COUNT(DISTINCT CASE WHEN kind = 'scan' THEN target END) AS hostsScanned,
           SUM(CASE WHEN kind = 'finding' THEN 1 ELSE 0 END) AS findings,
           SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END) AS reports,
           SUM(CASE WHEN kind = 'payout' THEN 1 ELSE 0 END) AS payouts
         FROM bounty_events WHERE COALESCE(platform,'') != 'benchmark' AND COALESCE(program,'') != 'Pipeline Test' AND COALESCE(title,'') NOT IN ('Account enrolled','Recon probe (httpx + nuclei, low-noise)')`,
      )
      .first<Omit<typeof empty, "bySeverity" | "payoutsUsd">>()
      .catch(() => null),
    d
      .prepare("SELECT severity, COUNT(*) AS n FROM bounty_events WHERE COALESCE(platform,'') != 'benchmark' AND COALESCE(program,'') != 'Pipeline Test' AND COALESCE(title,'') NOT IN ('Account enrolled','Recon probe (httpx + nuclei, low-noise)') AND kind = 'finding' AND severity IS NOT NULL GROUP BY severity")
      .all<{ severity: string; n: number }>()
      .catch(() => ({ results: [] as { severity: string; n: number }[] })),
    d
      .prepare("SELECT SUM(amount) AS usd FROM bounty_events WHERE COALESCE(platform,'') != 'benchmark' AND COALESCE(program,'') != 'Pipeline Test' AND COALESCE(title,'') NOT IN ('Account enrolled','Recon probe (httpx + nuclei, low-noise)') AND kind = 'payout'")
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
  const [totals, progs, recent, tech] = await Promise.all([
    bountyTotals(env),
    d
      .prepare(
        `SELECT program, MAX(platform) AS platform,
                SUM(CASE WHEN kind = 'scan' THEN 1 ELSE 0 END) AS scans,
                SUM(CASE WHEN kind = 'finding' THEN 1 ELSE 0 END) AS findings,
                SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END) AS reports,
                SUM(CASE WHEN kind = 'payout' THEN amount ELSE 0 END) AS payoutsUsd,
                MAX(at) AS lastAt
         FROM bounty_events WHERE COALESCE(platform,'') != 'benchmark' AND COALESCE(program,'') != 'Pipeline Test' AND COALESCE(title,'') NOT IN ('Account enrolled','Recon probe (httpx + nuclei, low-noise)') AND program IS NOT NULL
         GROUP BY program ORDER BY lastAt DESC LIMIT 50`,
      )
      .all<{ program: string; platform: string | null; scans: number; findings: number; reports: number; payoutsUsd: number | null; lastAt: number }>()
      .catch(() => ({ results: [] as { program: string; platform: string | null; scans: number; findings: number; reports: number; payoutsUsd: number | null; lastAt: number }[] })),
    d
      .prepare("SELECT * FROM bounty_events WHERE COALESCE(platform,'') != 'benchmark' AND COALESCE(program,'') != 'Pipeline Test' AND COALESCE(title,'') NOT IN ('Account enrolled','Recon probe (httpx + nuclei, low-noise)') ORDER BY at DESC LIMIT 50")
      .all<Row>()
      .catch(() => ({ results: [] as Row[] })),
    techMatrixStats(env),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    totals,
    tech: tech.stats,
    programs: progs.results.map((r) => ({
      program: r.program,
      platform: r.platform,
      scans: r.scans,
      findings: r.findings,
      reports: r.reports,
      payoutsUsd: Math.round((r.payoutsUsd ?? 0) * 100) / 100,
      lastAt: new Date(r.lastAt).toISOString(),
      stack: tech.stacks.get(r.program) ?? [],
    })),
    recent: recent.results.map(toEvent),
  };
}
