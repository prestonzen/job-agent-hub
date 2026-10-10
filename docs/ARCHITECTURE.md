# Architecture

```mermaid
flowchart LR
  subgraph Browser
    SPA[React + Vite SPA<br/>/ public · /admin]
  end
  subgraph Agents
    C[Claude] --- X[Codex] --- G[Gemini] --- K[Kimi] --- M[Mistral]
  end
  subgraph Cloudflare Pages
    F[Pages Functions<br/>functions/ → worker/src]
    A[Admin token login<br/>signed session cookie]
    D[(D1<br/>claims · events · heartbeats)]
  end
  SPA -->|GET /api/public/summary| F
  SPA -->|admin calls| A --> F
  Agents -->|MCP POST /mcp<br/>REST /api/agent/*<br/>Bearer token| F
  F --> D
  F -->|CLICKUP_TOKEN secret| CU[(ClickUp<br/>tasks · fields · playbook doc)]
```

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/public/summary` | none (sanitized, cached 60 s) | Public dashboard data |
| `GET /api/health` | none | Config check (no secrets) |
| `POST /mcp` | agent bearer token | MCP server (stateless Streamable HTTP, JSON responses) |
| `/api/agent/*` | agent bearer token | Same operations over REST (see AGENTS.md) |
| `POST /api/admin/login` | `ADMIN_TOKEN` in body | Sets the admin session cookie |
| `GET /api/admin/analytics?days=30` | admin | Per-agent stats, outcomes per day, yield by ATS, parked reasons, hour-of-day, API-call trend (`worker/src/analytics.ts`) |
| `/api/admin/*` | admin session cookie or `Bearer <ADMIN_TOKEN>` | Command center, pipeline edits, admin release/report |
| everything else | none | Static SPA (`dist/`, single-page fallback) |

## Failure routing

`reportResult` saves a `failed` / `needs_human` outcome and the agent's action log to the D1 `attempts` table (`worker/src/attempts.ts`). A first failure by a front-line agent, or a written-answer blocker (`parkedCategory` in `worker/src/park.ts`), assigns the job to Kimi (`assignments`, 6 h, ahead of the queue) and posts the log excerpt to the ClickUp task. Claims and `get_job` return `previousAttempts` so Kimi starts from the log. A second failure, or a Kimi failure on a handed-over job, parks the task (`Needs human: …`). Autopilot treats Kimi as a *backlog* agent (`settings.backlog`): it starts a Kimi run only when jobs are assigned to it, or when no front-line agent can work.

## Queue and claims

- **Flat list rule:** applications are top-level tasks, never subtasks (convert any nested task); *Platform Applied* names the ATS actually used and has no "Other" option.
- **Queue** = application tasks in the ClickUp list with status *not started*. An application is a top-level task named "Company — Role" without a platform tag (`job-board`, `freelance`, `ai-expert`, `bounty`); see `worker/src/classify.ts`. Older subtasks of `PARENT_TASK_ID` still count. The description's `Apply: <url>` / `Pay | Travel | Fit | ATS` line is parsed for the posting details. Order: fit (x/5) desc, then ClickUp priority.
- **Claim** = a row in D1 `claims` taken with a single `INSERT … ON CONFLICT DO UPDATE … WHERE expired OR same agent` statement. The statement either changes one row (you won) or none (someone else holds it). No locks, no races.
- **Mirror**: a successful claim writes `Claimed by <agent> until <time>` to ClickUp *Next Action*. The queue also honours such notes written by agents that bypass the hub.
- **Leases expire** (`LEASE_MINUTES`, default 60), so a crashed agent's jobs return to the queue automatically. `claim_jobs` hands an agent the jobs it already holds first.
- **Reports** write status, Applied By, Platform Applied, Applied On and a comment to ClickUp, delete the claim and log an event. `applied` on a task that isn't *not started* is refused (409), so a late duplicate can't overwrite another agent's record.

## Design decisions

- **ClickUp stays the system of record.** D1 only holds coordination state that ClickUp is bad at (atomic leases, a high-frequency activity log, check-ins).
- **One service layer, two transports.** `worker/src/jobs.ts` implements every operation; `mcp.ts` and the REST routes are thin adapters, so MCP and REST agents behave identically.
- **Pages, not a standalone Worker.** Git integration deploys on push; `functions/` are one-line adapters into `worker/src/index.ts`, which still runs as a plain Worker if ever needed.
- **Sanitize at the boundary.** `worker/src/sanitize.ts` is the only place data becomes public.
- **One-person admin auth.** A single long random token (Pages secret) traded for an HMAC-signed HttpOnly cookie. No identity provider or dashboard setup; rotate the secret to log everyone out.
- **Agent identity from the token**, never from the request body.
