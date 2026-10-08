# Job Agent Hub

**One pane of glass for a multi-agent job search.** Claude, Codex, Gemini, Kimi, Mistral, Ollama (and a human) work **one shared job queue**: each agent claims a posting, applies, and reports back. The hub makes sure no two agents ever apply to the same role, and every result lands in one tracker (ClickUp).

Live at **https://jobhunter.prestonzen.com**.

- **Shared queue with atomic claims**: an agent claims the best-fit postings and holds a lease (default 60 min) while it applies. Claims are one SQL statement in D1, so two agents can't both win. Claims are mirrored to ClickUp's *Next Action* field, and agents that only talk to ClickUp can claim there too (`Claimed by <agent> until <ISO time>`).
- **Every agent, one endpoint**: MCP clients (Claude Code, Codex, Gemini CLI, Kimi CLI, Cursor…) connect to `/mcp`. Agents without MCP (browser agents, chat apps) use the same operations over REST at `/api/agent/*`. Each agent has its own bearer token, and the token decides who it is.
- **One runner prompt**: the loop (read playbook → claim → apply → report) is served to every agent as MCP server instructions, from `GET /api/agent/instructions`, and on the admin *Connect agents* page.
- **Playbook from ClickUp**: standard form answers and rules come from the ClickUp playbook doc, served only to authenticated agents and admins, so no agent re-asks profile questions.
- **Admin command center** (`/admin`, admin-token login): queue and claims, which agents are online, live activity, release/skip/mark-applied, pipeline editing, copy-paste agent setup.
- **Public dashboard** (`/`): a sanitized live view: funnel, who applied, applications per day, platforms. No contact details, notes, links, answers or queued targets.

```
                       ┌── /            public dashboard (sanitized)
Browser ── React SPA ──┤
                       └── /admin       command center (admin token → session cookie)
Agents ── MCP  /mcp ───────┐
       └─ REST /api/agent ─┼── Pages Functions (worker/src) ──┬── ClickUp (system of record)
                           │                                   └── D1 (claims, activity, check-ins)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Connecting agents: [docs/AGENTS.md](docs/AGENTS.md)

## Privacy model

This repo and the public site contain **no personal data and no secrets**.

- Only the Functions hold credentials (Pages secrets). The browser bundle never does, so **never put secrets in `VITE_*` variables**.
- `/api/public/summary` returns only company, role, platform, status, who applied and the date for submitted applications.
- `/api/admin/*` requires the admin session cookie (HMAC-signed, HttpOnly, Secure, SameSite=Strict, 30 days) obtained by posting `ADMIN_TOKEN` to `/api/admin/login`, or `Authorization: Bearer <ADMIN_TOKEN>` for scripts. Rotating the secret ends all sessions.
- `/api/agent/*` and `/mcp` use per-agent bearer tokens (24+ chars). The playbook (personal data) is only served there and to admins, and is cached in memory only.

## Setup

The Pages project `job-agent-hub` is Git-connected: **every push to `main` builds and deploys**. Bindings and vars live in `wrangler.jsonc`.

Everything is done with wrangler; no dashboard steps. Set the account first (3 accounts are logged in):

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "f19d27cc74917ce2597bf6b423f94aff"   # Kaizen Apps
npx wrangler pages secret list --project-name job-agent-hub
npx wrangler pages secret put <NAME> --project-name job-agent-hub    # prompts for the value
```

Secrets take effect on the next deployment (push to `main`, or `git commit --allow-empty -m redeploy; git push`).

| Secret | What |
|---|---|
| `CLICKUP_TOKEN` | ClickUp personal API token (`pk_…`). Required for real data. |
| `AGENT_TOKENS` | JSON map of agent name → token, e.g. `{"claude":"…","codex":"…"}`. Names should match ClickUp *Applied By* options. |
| `ADMIN_TOKEN` | 24+ char random string; paste it on `/admin` to sign in. |
| `ZADARMA_KEY`, `ZADARMA_SECRET` | Optional, experimental phone stats |

**Database**: D1 `job-agent-hub`. Tables are created on first use; `npm run db:migrate` applies `migrations/` explicitly.

## Local development (demo data)

```bash
npm install
cp .dev.vars.example .dev.vars   # set AGENT_TOKENS to test tokens
npm run build && npm run dev:api # Pages Functions + local D1 on http://127.0.0.1:8788 (MOCK=true)
npm run dev                      # Vite on http://localhost:5173, proxies /api and /mcp
```

In demo mode, ClickUp writes are skipped, while claims and activity run for real against local D1. The admin page skips login on localhost.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (proxies `/api`, `/mcp` to port 8788) |
| `npm run dev:api` | `wrangler pages dev dist` in demo mode |
| `npm run typecheck` | Type-check the app, the Functions and `worker/src` |
| `npm run build` | Production build into `dist/` |
| `npm run db:migrate` | Apply D1 migrations to the remote database |
| `npm run deploy` | Manual deploy (normally Git integration does this) |

## License

MIT
