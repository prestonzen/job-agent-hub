import type { AdminTask, HubState, PublicSummary, Run, RunnerInfo } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const getSummary = () => request<PublicSummary>("/api/public/summary");
export const getAdminTasks = () => request<{ demo: boolean; tasks: AdminTask[] }>("/api/admin/tasks");
export const getMe = () => request<{ user: string }>("/api/admin/me");
export const login = (token: string) => request<{ ok: true }>("/api/admin/login", { method: "POST", body: JSON.stringify({ token }) });
export const logout = () => request<{ ok: true }>("/api/admin/logout", { method: "POST" });
export const setStatus = (id: string, status: string) =>
  request<{ ok: true }>(`/api/admin/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
export const addComment = (id: string, text: string) =>
  request<{ ok: true }>(`/api/admin/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ text }) });
export const getHub = () => request<HubState>("/api/admin/hub");
export const releaseJob = (id: string, note?: string) =>
  request<{ ok: true }>(`/api/admin/jobs/${id}/release`, { method: "POST", body: JSON.stringify({ note }) });
export const reportJob = (id: string, outcome: "applied" | "skipped" | "needs_human" | "failed", note?: string, platform?: string) =>
  request<unknown>(`/api/admin/jobs/${id}/report`, { method: "POST", body: JSON.stringify({ outcome, note, platform }) });

export async function getText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

export const getRuns = () => request<{ runs: Run[]; runners: RunnerInfo[] }>("/api/admin/runs");
export const getRun = (id: number) => request<Run>(`/api/admin/runs/${id}`);
export const createRun = (r: { agent: string; kind: "queue" | "prompt"; count?: number; prompt?: string; copies?: number }) =>
  request<{ runs: Run[] }>("/api/admin/runs", { method: "POST", body: JSON.stringify(r) });
export const cancelRun = (id: number) => request<Run>(`/api/admin/runs/${id}/cancel`, { method: "POST" });

// ---------- pacing, schedules, resumes, alerts ----------
export interface AtsLimit { concurrent: number; minGapMin: number; perDay: number }
export interface PacingPolicy { ats: Record<string, AtsLimit>; companyConcurrent: number; companyCooldownDays: number; globalPerDay: number }
export interface PacingLive { globalPerDay: number; todayTotal: number; ats: (AtsLimit & { ats: string; active: number; today: number; nextSlotAt: string | null })[] }
export const getPacing = () => request<{ policy: PacingPolicy; defaults: PacingPolicy; live: PacingLive }>("/api/admin/pacing");
export const savePacing = (p: PacingPolicy) => request<{ policy: PacingPolicy }>("/api/admin/pacing", { method: "PUT", body: JSON.stringify(p) });

export interface Schedule { id: number; name: string; agent: string | null; kind: "queue" | "prompt" | "digest"; count: number | null; copies: number; prompt: string | null; cron: string; tz: string; enabled: boolean; jitterMin: number; lastRunAt: string | null; nextRunAt: string | null }
export const getSchedules = () => request<{ schedules: Schedule[] }>("/api/admin/schedules");
export const createSchedule = (s: Partial<Schedule>) => request<Schedule>("/api/admin/schedules", { method: "POST", body: JSON.stringify(s) });
export const setScheduleEnabled = (id: number, enabled: boolean) => request<Schedule>(`/api/admin/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
export const deleteSchedule = (id: number) => request<{ ok: true }>(`/api/admin/schedules/${id}`, { method: "DELETE" });

export interface Resume { id: number; name: string; filename: string; tags: string[]; isDefault: boolean; size: number; contentType: string; uploadedAt: string }
export const getResumes = () => request<{ resumes: Resume[] }>("/api/admin/resumes");
export async function uploadResume(form: FormData): Promise<Resume> {
  const res = await fetch("/api/admin/resumes", { method: "POST", body: form });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`);
  return res.json() as Promise<Resume>;
}
export const updateResume = (id: number, patch: { name?: string; tags?: string; isDefault?: boolean }) =>
  request<Resume>(`/api/admin/resumes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteResume = (id: number) => request<{ ok: true }>(`/api/admin/resumes/${id}`, { method: "DELETE" });
export const pickResume = (role: string) => request<(Resume & { matched: string[] }) | null>(`/api/admin/resume-pick?role=${encodeURIComponent(role)}`);

export interface InboundEmail { message_id: string; at: number; from_addr: string; subject: string; category: string; company: string | null; task_id: string | null; action: string; summary: string }
export const getInbound = () => request<{ emails: InboundEmail[] }>("/api/admin/inbound");
export const testTelegram = () => request<{ ok: boolean; error: string | null; configured: boolean }>("/api/admin/telegram/test", { method: "POST" });
export const sendDigestNow = () => request<{ ok: boolean; error: string | null }>("/api/admin/digest", { method: "POST" });

export interface AutopilotSettings { enabled: boolean; maxConcurrent: number; jobsPerRun: number; minGapMin: number; agents: Record<string, boolean>; backlog?: string[] }
export interface AgentAutopilot { agent: string; state: "working" | "queued" | "waiting" | "ready" | "paused" | "off" | "not-ready"; nextAt: string | null; detail: string | null; role?: "front-line" | "backlog" }
export const getAutopilot = () => request<{ settings: AutopilotSettings; agents: AgentAutopilot[] }>("/api/admin/autopilot");
export const saveAutopilot = (p: Partial<AutopilotSettings>) =>
  request<{ settings: AutopilotSettings; agents: AgentAutopilot[] }>("/api/admin/autopilot", { method: "PUT", body: JSON.stringify(p) });

// ---------- analytics ----------
export interface AgentStats { agent: string; claimed: number; applied: number; skipped: number; needsHuman: number; failed: number; released: number; successRate: number | null; medianMinToApply: number | null; runs: number; runsOk: number; runsFailed: number; avgRunMin: number | null; runMinutes: number }
export interface AtsStats { ats: string; applied: number; needsHuman: number; skipped: number; failed: number; successRate: number | null }
export interface DayStats { date: string; applied: number; needsHuman: number; skipped: number; failed: number; runsOk: number; runsFailed: number }
export interface Analytics {
  generatedAt: string; days: number; demo: boolean;
  totals: { applied: number; claimed: number; skipped: number; needsHuman: number; failed: number; successRate: number | null; medianMinToApply: number | null; runs: number; runsOk: number; runMinutes: number; appsPerRunHour: number | null };
  byAgent: AgentStats[]; byDay: DayStats[]; byHour: number[]; byAts: AtsStats[];
  parked: { reason: string; count: number }[];
  queue: { ready: number; claimed: number; parked: number; total: number };
  clickup: { day: string; calls: number }[];
  fleet: { agentsReady: number; runnersOnline: number; slots: number; busy: number };
}
export const getAnalytics = (days: number) => request<Analytics>(`/api/admin/analytics?days=${days}`);
