// Mirrors worker/src/types.ts (the public API contract).
export interface PublicApplication {
  company: string;
  role: string;
  platform: string | null;
  status: string;
  appliedBy: string | null;
  appliedOn: string | null;
}

export interface PublicSummary {
  generatedAt: string;
  demo: boolean;
  totals: { applications: number; platforms: number };
  byStatus: Record<string, number>;
  byPlatform: Record<string, number>;
  byAgent: Record<string, number>;
  byDay: { date: string; count: number }[];
  recent: PublicApplication[];
  platforms: { name: string; status: string }[];
}

export interface AdminTask {
  id: string;
  name: string;
  status: string;
  parentId: string | null;
  appliedBy: string | null;
  platform: string | null;
  appliedOn: string | null;
  tags: string[];
  url: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export const STATUSES = ["not started", "applied", "screening", "accepted", "earning", "rejected / paused"] as const;
