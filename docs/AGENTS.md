# Connecting an agent

Every agent works the same queue with its own token. The admin page **Connect agents** (`/admin#connect`) has copy-paste setup for each client; this is the reference.

## 1. Give the agent a token

Add a `name → token` pair to the `AGENT_TOKENS` Pages secret (JSON, tokens 24+ chars, e.g. `openssl rand -hex 32`):

```bash
npx wrangler pages secret put AGENT_TOKENS --project-name job-agent-hub
# paste: {"claude":"…","codex":"…","gemini":"…","kimi":"…","mistral":"…"}
```

The name is the agent's identity in comments, activity and the ClickUp **Applied By** field. If ClickUp has no option with that name (e.g. *Mistral*), add the option in ClickUp; until then the application is still recorded, just untagged.

## ClickUp conventions (every agent, every doc)

- **Flat list, no subtasks.** Each application is one top-level task named "Company — Role" in the *AI Job Applications* list. Never create subtasks or nest tasks; if you find one, convert it to a task (Subtasks: "Separate" → Convert to Task). The header task `AI Dev Job Applications — Oct 2026` is notes-only.
- **Platform Applied is the ATS where the form was actually submitted** (Greenhouse, Ashby, Lever, Workable, Workday, SmartRecruiters, Breezy, Rippling, Avature, Indeed Easy Apply, …). **Company site** means the company's own custom form. There is no "Other": if the platform you used is missing, add that specific platform to the dropdown. Unknown names are skipped, never guessed.

## 2. Connect

**MCP** (Claude Code, Codex, Gemini CLI, Kimi CLI, Cursor…): remote server at `https://jobhunter.prestonzen.com/mcp`, Streamable HTTP, header `Authorization: Bearer <token>`.

```bash
claude mcp add --transport http jobhunter https://jobhunter.prestonzen.com/mcp --header "Authorization: Bearer <token>"
```

```toml
# ~/.codex/config.toml
[mcp_servers.jobhunter]
url = "https://jobhunter.prestonzen.com/mcp"
bearer_token_env_var = "JOBHUNTER_TOKEN"
```

```json
// ~/.gemini/settings.json
{ "mcpServers": { "jobhunter": { "httpUrl": "https://jobhunter.prestonzen.com/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

**REST** (browser agents, chat apps without MCP): same operations under `/api/agent/*`. Paste the REST runner prompt from the admin page (or `GET /api/agent/instructions`).

## 3. The loop

| Step | MCP tool | REST |
|---|---|---|
| Read the playbook (answers + rules) | `get_playbook` | `GET /api/agent/playbook` |
| Queue overview | `list_queue` | `GET /api/agent/queue` |
| Claim jobs (atomic, ~60 min lease) | `claim_jobs {count, ats?}` | `POST /api/agent/claim {"count":4,"ats":["greenhouse"]}` |
| Fresh job status | `get_job {id}` | `GET /api/agent/jobs/:id` |
| Extend lease | `renew_lease {id}` | `POST /api/agent/jobs/:id/renew` |
| Report outcome | `report_result {id, outcome, platform?, note?}` | `POST /api/agent/jobs/:id/report` |
| Give a job back | `release_job {id, note?}` | `POST /api/agent/jobs/:id/release` |
| Queue a posting you found | `add_job {company, role, url, …}` | `POST /api/agent/jobs` |
| Log an application made elsewhere | `log_application {company, role, …}` | `POST /api/agent/applications` |

Outcomes:

- `applied`: submitted. Sets status *applied*, *Applied By*, *Platform Applied*, *Applied On*, and comments.
- `needs_human`: blocked on something only the human can do (CAPTCHA, emailed code, account creation). Note required. Parks the job (*Next Action: Needs human: …*) until an admin releases it.
- `skipped`: not a fit under the playbook rules. Note required. Status → *rejected / paused*.
- `failed`: technical failure; the job returns to the queue.

Errors come back as HTTP 4xx (REST) or `isError` tool results (MCP), e.g. `409 … is claimed by codex until …`.

## ClickUp-only agents

Agents that use the ClickUp API/MCP directly can still take part without double-applying:

1. Skip any task whose **Next Action** is `Claimed by <agent> until <time>` (time in the future) or starts with `Needs human`.
2. To claim, set **Next Action** to `Claimed by <you> until <ISO time, ≤60 min ahead>Z`. The hub won't hand that job to anyone else.
3. When done, set status/fields as usual and clear **Next Action**.

## Rules for agents

1. **Only work on jobs you have claimed.** Re-check `get_job` if in doubt.
2. **Never create accounts, enter passwords, or solve CAPTCHAs/bot checks.** Report `needs_human`.
3. **Never invent** experience, employers or metrics. The playbook is the source of truth.
4. **No secrets in notes.** Notes become ClickUp comments.
