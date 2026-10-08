export interface Env {
  /** Static assets (Pages provides this to Functions; unused for /api and /mcp). */
  ASSETS?: Fetcher;
  /** D1: job claims (leases), agent activity log, agent heartbeats. */
  DB: D1Database;

  // --- non-secret vars (wrangler.jsonc) ---
  MOCK: string;
  CLICKUP_WORKSPACE_ID: string;
  CLICKUP_LIST_ID: string;
  PARENT_TASK_ID: string;
  FIELD_APPLIED_BY: string;
  FIELD_PLATFORM: string;
  FIELD_APPLIED_ON: string;
  FIELD_NEXT_ACTION: string;
  /** ClickUp Doc holding the application playbook (standard answers + rules). */
  PLAYBOOK_DOC_ID: string;
  /** How long a claim lasts before the job returns to the queue. */
  LEASE_MINUTES: string;

  // --- secrets (wrangler pages secret put ...) ---
  /** Admin login token (24+ chars). Traded for a signed session cookie on /admin. */
  ADMIN_TOKEN?: string;
  CLICKUP_TOKEN?: string;
  /** JSON map of agent name -> bearer token, e.g. {"claude":"...","codex":"..."} */
  AGENT_TOKENS?: string;
  ZADARMA_KEY?: string;
  ZADARMA_SECRET?: string;
}

/** A job application or platform task, normalized from ClickUp. */
export interface Task {
  id: string;
  name: string;
  status: string;
  parentId: string | null;
  appliedBy: string | null;
  platform: string | null;
  appliedOn: string | null; // YYYY-MM-DD
  nextAction: string | null;
  priority: string | null;
  tags: string[];
  url: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** A queue item: a "not started" posting under the parent task, with the posting details parsed out. */
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
  /** Who holds it right now (hub claim or a ClickUp "Claimed by" note), if anyone. */
  claimedBy: string | null;
  claimExpiresAt: string | null;
  /** "Needs human: …" notes park a job until a person handles it. */
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

/** What the public site is allowed to see. No contact details, notes, links or answers. */
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
  totals: { applications: number; platforms: number; queued: number };
  byStatus: Record<string, number>;
  byPlatform: Record<string, number>;
  byAgent: Record<string, number>;
  byDay: { date: string; count: number }[];
  recent: PublicApplication[];
  platforms: { name: string; status: string }[];
}
