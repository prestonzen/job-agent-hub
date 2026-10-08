export interface Env {
  ASSETS: Fetcher;

  // --- non-secret vars (wrangler.jsonc) ---
  MOCK: string;
  CLICKUP_LIST_ID: string;
  PARENT_TASK_ID: string;
  FIELD_APPLIED_BY: string;
  FIELD_PLATFORM: string;
  FIELD_APPLIED_ON: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS: string;

  // --- secrets (wrangler secret put ...) ---
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
  tags: string[];
  url: string;
  description: string;
  createdAt: string;
  updatedAt: string;
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
  totals: { applications: number; platforms: number };
  byStatus: Record<string, number>;
  byPlatform: Record<string, number>;
  byAgent: Record<string, number>;
  byDay: { date: string; count: number }[];
  recent: PublicApplication[];
  platforms: { name: string; status: string }[];
}
