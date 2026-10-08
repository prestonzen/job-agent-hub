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
  stale?: boolean;
  totals: { applications: number; platforms: number; queued: number };
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
  nextAction: string | null;
  priority: string | null;
  tags: string[];
  url: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export const STATUSES = ["not started", "applied", "screening", "accepted", "earning", "rejected / paused"] as const;

export interface Job {
  id: string;
  name: string;
  company: string;
  role: string;
  status: string;
  applyUrl: string | null;
  ats: string | null;
  pay: string | null;
  travel: string | null;
  fit: number | null;
  fitNote: string | null;
  priority: string | null;
  clickupUrl: string;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  needsHuman: string | null;
}

export interface AgentEvent {
  id: number;
  at: string;
  agent: string;
  taskId: string | null;
  taskName: string | null;
  type: string;
  message: string | null;
}

export interface HubState {
  demo: boolean;
  agents: string[];
  queue: Job[];
  events: AgentEvent[];
  heartbeats: { agent: string; lastSeen: string; client: string | null }[];
  applied: Record<string, number>;
  leaseMinutes: number;
}
