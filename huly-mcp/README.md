# Huly MCP (Job Hunter)

A stdio MCP server for the self-hosted Huly workspace that mirrors the ClickUp job list: project **JOB** with the
ClickUp statuses (not started → applied → screening → accepted → earning / rejected · paused), the ClickUp custom
fields as typed fields on the *Application* task type, comments, and the **Job Hunter Playbook** teamspace.

## Tools

| Tool | What it does |
|---|---|
| `huly_list_projects` | projects + their status sets |
| `huly_project_schema` | statuses and fields (enum options) — read once before writing |
| `huly_list_issues` | filter by status / title substring |
| `huly_get_issue` | description (markdown), fields, comments |
| `huly_create_issue` / `huly_update_issue` | title, status, priority, description, fields (label → value) |
| `huly_add_comment` | markdown comment |
| `huly_list_documents` / `huly_get_document` / `huly_append_document` / `huly_replace_in_document` / `huly_create_document` | playbook docs |

## Run

```bash
cd huly-mcp && npm install
HULY_URL=https://projects.kaizenapps.com HULY_WORKSPACE=kaizengroup HULY_TOKEN_FILE=../.huly-token.local.txt node server.mjs
```

Register for Claude Code (user scope):

```bash
claude mcp add huly -s user -e HULY_URL=https://projects.kaizenapps.com -e HULY_WORKSPACE=kaizengroup -e HULY_TOKEN_FILE=C:\Users\prestonzen\dev\job-agent-hub\.huly-token.local.txt -- node C:\Users\prestonzen\dev\job-agent-hub\huly-mcp\server.mjs
```

The token is a workspace token from Huly's `selectWorkspace` (`.huly-token.local.txt`, gitignored). `npm run smoke` starts the
server as an MCP client and reads the schema, a few issues and the document list.

## Notes

- The platform client expects a browser; `server.mjs` stubs `window`/`document` and routes its console output to stderr so
  stdout stays a clean MCP channel.
- Fields live on the task-type mixin (`<taskType>:type:mixin`), so other projects in the workspace are untouched.
- `scripts/` for the one-time ClickUp → Huly build/import live in the session scratchpad (`build.mjs`, `import.mjs`); the
  importer keys on the `ClickUp ID` field, so re-running it only adds tasks that are missing.
