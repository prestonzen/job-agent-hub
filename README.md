# Job Agent Hub

**One pane of glass for a multi-agent job search.** Claude, Codex, Gemini, Qwen, Kimi, Mistral (and a human) work **one shared job queue**: each agent claims a posting, applies, and reports back. The hub makes sure no two agents ever apply to the same role, and every result lands in one tracker (ClickUp).

Live at **https://jobhunter.prestonzen.com**.

- **Shared queue with atomic claims**: an agent claims the best-fit postings and holds a lease (default 60 min) while it applies. Claims are one SQL statement in D1, so two agents can't both win. Claims are mirrored to ClickUp's *Next Action* field, and agents that only talk to ClickUp can claim there too (`Claimed by <agent> until <ISO time>`).
- **Every agent, one endpoint**: MCP clients (Claude Code, Codex, Gemini CLI, Qwen Code, Kimi Code, Mistral Vibe, Cursor…) connect to `/mcp`. Agents without MCP (browser agents, chat apps) use the same operations over REST at `/api/agent/*`. Each agent has its own bearer token, and the token decides who it is.
- **One runner prompt**: the loop (read playbook → claim → apply → report) is served to every agent as MCP server instructions, from `GET /api/agent/instructions`, and on the admin *Connect agents* page.
- **Playbook from ClickUp**: standard form answers and rules come from the ClickUp playbook doc, served only to authenticated agents and admins, so no agent re-asks profile questions.
- **Admin command center** (`/admin`, admin-token login): queue and claims, which agents are online, live activity, release/skip/mark-applied, pipeline editing, copy-paste agent setup.
- **Run agents from anywhere** (`/admin#run`): launch "Gemini: work 4 jobs" (or any prompt, up to 5 in parallel) from your phone. A **runner** on an always-on Linux box starts the CLI headless with a real browser, streams the output back live, and stops it on demand. See [runner/README.md](runner/README.md).
- **Public dashboard** (`/`): a sanitized live view: funnel, who applied, applications per day, platforms. No contact details, notes, links, answers or queued targets.

```
                       ┌── /            public dashboard (sanitized)
Browser ── React SPA ──┤
                       └── /admin       command center (admin token → session cookie)
Agents ── MCP  /mcp ───────┐
       └─ REST /api/agent ─┼── Pages Functions (worker/src) ──┬── ClickUp (system of record)
Runner ── /api/runner ─────┘                                   └── D1 (claims, activity, runs, snapshots)
  └─ claude · codex · gemini · qwen · kimi · vibe  + Playwright MCP (Chromium)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Connecting agents: [docs/AGENTS.md](docs/AGENTS.md)

## Agent compatibility

Which agents can join the hub, as of October 2026 (vendor docs plus hands-on checks on the kloud runner). The setup that works best is a **coding CLI + Playwright MCP**: a real browser that can fill forms and upload the resume, plus the hub's MCP server with the agent's own token.

| Agent | Can join | Status | Notes |
|---|---|---|---|
| **Claude Code** | Yes | ✅ Verified on runner (hub + browser) | Also Claude in Chrome on a desktop |
| **Codex CLI** | Yes | ✅ Verified on runner | Token via `bearer_token_env_var`; also has built-in computer use |
| **Gemini CLI** | Yes | ✅ Verified on runner | Free tier. Needs the runs folder trusted and a 30 s MCP timeout (set by `configure-agents.mjs`). The Gemini desktop/web app can't send a custom token header, so it can't connect. |
| **Qwen Code** | Yes | ✅ Verified on runner | Gemini CLI fork; same config format |
| **Kimi Code CLI** | Yes | 🟡 Installed + configured; verify after login | Replaces the deprecated `kimi-cli`. Headless: `kimi --auto -p` |
| **Mistral Vibe CLI** | Yes | 🟡 Installed + configured; verify after login | Le Chat was renamed "Vibe" in August 2026. No desktop app, and the web app can't drive a browser, so use the CLI. |
| **Manus** (Browser Operator) | Yes (not set up) | ⚪ Possible | The only consumer app confirmed to do both: work in your own logged-in browser and connect to a custom MCP server with a bearer token |
| Goose, Cline/Roo, Cursor, Windsurf, Ollama + Playwright MCP | Yes (not set up) | ⚪ Possible | Any MCP client that sends a header works; Ollama gives a fully local agent |
| **ChatGPT app**, **Gemini web app**, **Perplexity Comet** | Not yet | 🔴 Needs OAuth on the hub | ChatGPT can't automate file uploads and only connects through OAuth login; the Gemini web app looks the same (unconfirmed). Supporting them means adding OAuth 2.1 to `/mcp`. |

Per-agent setup snippets are on `/admin#connect`; the runner wiring is in [runner/configure-agents.mjs](runner/configure-agents.mjs).

## Where to run agents

| Option | Best for | How |
|---|---|---|
| **Linux server / Proxmox LXC** (current: kloud CT 218) | 24/7, phone-controlled, residential IP | `runner/provision.sh`, then `runner/setup.sh`. Agents use Chromium on a virtual display (Xvfb). |
| **Debian/Ubuntu desktop** | Watching the agents work; using your own signed-in browser | `runner/provision.sh`, then `runner/setup.sh --desktop <you>`. The runner becomes a systemd *user* service in your graphical session, so each agent's browser opens on your screen. For your real Chrome profile, Playwright MCP's extension mode can attach to it. |
| **Windows** | Only if you must | Use WSL2 (Ubuntu) and desktop mode via WSLg. Linux is the better choice: every CLI is Linux-first, systemd keeps the runner alive, and file paths and browser automation are less fiddly. |

Run agents from a **residential IP** (home or mobile line), not a cloud VM: Ashby flags applications from data-center IPs as fraud.

## Deployment

- **Hub**: Cloudflare Pages Git integration. A push to `main` builds and deploys. CI (`.github/workflows/ci.yml`) typechecks and builds every push.
- **Runner**: pull-based. `job-agent-updater.timer` runs `runner/update.sh` every 5 minutes. When anything under `runner/` changed on `main` and no run is in progress, it re-runs `setup.sh` from the new checkout. This works behind CGNAT with no open ports, and puts no deploy secrets in GitHub. `provision.sh` (system packages, CLI versions) is run by hand.
- **Other servers**: skip Jenkins; it's a server you'd have to maintain for what GitHub Actions does for free. For a VPS with a public IP, use a GitHub Actions job that deploys over SSH with a deploy-only key (plus an environment approval for production). For machines behind NAT, either let the box pull (like the runner) or install a GitHub self-hosted runner on it. The Tailscale GitHub Action is an option if the box is on a tailnet.

## Recommendations / roadmap

1. **OAuth 2.1 on `/mcp`**, so ChatGPT, the Gemini web app and Comet can join.
2. **Per-ATS throttles in `claim_jobs`**: at most one active Greenhouse session per identity (its emailed codes collide), and paced Ashby submissions, to stay under anti-fraud thresholds as the agent count grows.
3. **Push notifications** (ntfy or Telegram) when a run needs a human (Greenhouse code, CAPTCHA, required "own words" answer) or finishes.
4. **Scheduled runs** from the hub, e.g. every morning one agent sources new roles with `add_job` and two others work the queue.
5. **Cost and safety caps** per run: max turns/price (Vibe has `--max-price`), per-agent concurrency, a daily applications limit.
6. **Monitoring**: Uptime Kuma checks on `/api/health` and on the runner heartbeat (stale `lastSeen`), plus a weekly `wrangler d1 export` backup.
7. **Reply tracking**: read recruiter replies (Gmail) and move tasks to *screening* automatically.
8. **Tailored resumes**: serve resume variants from the hub per role family instead of one PDF on the runner.

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

