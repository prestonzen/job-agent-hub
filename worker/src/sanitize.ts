import type { Env, PublicApplication, PublicSummary, Task } from "./types";

/** "Company — Role" -> { company, role }. Falls back to the whole name as the role. */
export function splitName(name: string): { company: string; role: string } {
  const m = name.split(/\s+[—–-]\s+/);
  if (m.length >= 2) return { company: m[0].trim(), role: m.slice(1).join(" — ").trim() };
  return { company: "—", role: name.trim() };
}

function bump(map: Record<string, number>, key: string | null | undefined, fallback = "Unknown") {
  const k = key && key.length ? key : fallback;
  map[k] = (map[k] ?? 0) + 1;
}

/**
 * Build the PUBLIC summary. This is the privacy boundary: only company, role,
 * platform, status, who applied and the date leave the Worker. Descriptions, comments,
 * URLs, notes, contact details and form answers are never included.
 */
export function toPublicSummary(tasks: Task[], env: Env, demo = false): PublicSummary {
  const apps = tasks.filter((t) => t.parentId === env.PARENT_TASK_ID);
  const platforms = tasks.filter((t) => t.parentId === null && t.id !== env.PARENT_TASK_ID);

  const byStatus: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  const byDayMap: Record<string, number> = {};

  const recent: PublicApplication[] = apps.map((t) => {
    const { company, role } = splitName(t.name);
    return {
      company,
      role,
      platform: t.platform,
      status: t.status,
      appliedBy: t.appliedBy,
      appliedOn: t.appliedOn,
    };
  });

  for (const a of recent) {
    bump(byStatus, a.status);
    bump(byPlatform, a.platform, "Other");
    if (a.status !== "not started") bump(byAgent, a.appliedBy, "Unknown");
    if (a.appliedOn) byDayMap[a.appliedOn] = (byDayMap[a.appliedOn] ?? 0) + 1;
  }

  recent.sort((a, b) => (b.appliedOn ?? "").localeCompare(a.appliedOn ?? ""));

  return {
    generatedAt: new Date().toISOString(),
    demo,
    totals: { applications: apps.length, platforms: platforms.length },
    byStatus,
    byPlatform,
    byAgent,
    byDay: Object.entries(byDayMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    recent: recent.slice(0, 60),
    platforms: platforms.map((p) => ({ name: p.name, status: p.status })),
  };
}
