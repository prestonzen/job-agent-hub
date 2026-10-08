import type { AdminTask, HubState, PublicSummary } from "./types";

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
export const getMe = () => request<{ email: string }>("/api/admin/me");
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
