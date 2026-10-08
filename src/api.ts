import type { AdminTask, PublicSummary } from "./types";

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
