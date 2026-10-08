# Job Agent Hub

**One pane of glass for an AI-assisted job search.** Humans and AI agents (Claude, Codex, Gemini, Kimi, Ollama) apply across job boards, expert networks and freelance platforms; every action lands in one tracker (ClickUp) and is shown here.

- **Public site**: a sanitized live view: funnel, who applied (human vs. each agent), applications per day, platform breakdown and recent activity.
- **Admin panel** (`/admin`): behind Cloudflare Access login. Change statuses and add notes; changes write straight to ClickUp.
- **Agent API**: any agent with a bearer token can log an application (`POST /api/agent/applications`). See [docs/AGENTS.md](docs/AGENTS.md).
- **Built for one person's workflow** (resumes, docs and tasks live in ClickUp), not a multi-tenant SaaS.

```
React + Vite (SPA)  ──┐
                      ├─ one Cloudflare Worker (static assets + /api/*) ── ClickUp API
Agents (bearer token) ┘                                   └─ Zadarma API (optional, experimental)
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Privacy model

This repo and the public site contain **no personal data and no secrets**.

- The Worker is the only thing that holds credentials (Cloudflare secrets). The browser bundle never does, so **never put secrets in `VITE_*` variables** (they get compiled into the public JS).
- `/api/public/summary` returns only: company, role, platform, status, who applied, and the date. Descriptions, comments, links, contact details, DOB/address and form answers are never sent.
- `/api/admin/*` requires a valid Cloudflare Access JWT **and** an allow-listed email; the Worker re-verifies the token (RS256 against your team's JWKS) so a misconfigured Access policy can't expose it.
- `/api/agent/*` uses per-agent bearer tokens; the agent's identity comes from the token, not the request body.

## Quick start (local, demo data)

```bash
npm install
cp .dev.vars.example .dev.vars        # optional for demo mode
# run the Worker in demo mode, then the app:
npx wrangler dev --var MOCK:true      # terminal 1  → http://127.0.0.1:8787
npm run dev                           # terminal 2  → http://localhost:5173 (proxies /api)
```

## Deploy (Cloudflare, via GitHub Actions)

1. **Create a Cloudflare API token** (Workers Scripts: Edit) and note your Account ID.
2. **GitHub → Settings → Secrets and variables → Actions → New repository secret**:
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLICKUP_TOKEN` (ClickUp personal API token),
   `AGENT_TOKENS` (JSON like `{"claude":"…","codex":"…"}`), and optionally `ZADARMA_KEY` / `ZADARMA_SECRET`.
3. Edit `wrangler.jsonc` vars (`CLICKUP_LIST_ID`, `PARENT_TASK_ID`, field ids, `ADMIN_EMAILS`).
4. **Protect the admin area**: Cloudflare Zero Trust → Access → Applications → add a self-hosted app for your Worker's hostname with paths `/admin*` and `/api/admin/*`, allow only your email. Copy the application's **AUD tag** and your **team domain** into `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`.
5. Add a repository **variable** `DEPLOY_ENABLED` = `true` (Settings → Secrets and variables → Actions → Variables). Until then CI only typechecks and builds.
6. Push to `main`. The workflow typechecks, builds and deploys; secrets are synced to the Worker automatically.

## ClickUp data model

The tracker is a ClickUp list where each application is a subtask of one parent task, with three custom fields:
**Applied By** (Human/Claude/Codex/Kimi/Gemini/Ollama), **Platform Applied** (Greenhouse/Ashby/Lever/…), **Applied On** (date).
Task names follow `Company — Role`. Statuses: `not started → applied → screening → accepted → earning` (or `rejected / paused`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (proxies `/api` to the local Worker) |
| `npm run dev:worker` | `wrangler dev` |
| `npm run typecheck` | Type-check the app and the Worker |
| `npm run build` | Production build into `dist/` |
| `npm run deploy` | Build + `wrangler deploy` (CI does this for you) |

## Status

MVP. Planned: more agent connectors (subscription-based clients), Zadarma inbound-call/SMS feed in the admin, per-platform adapters, resume/document panel backed by ClickUp Docs.

## License

MIT
