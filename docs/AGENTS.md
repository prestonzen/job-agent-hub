# Connecting an agent

Any agent (an AI client, a script, an n8n workflow) can log what it did through one endpoint.

## 1. Issue a token

Add a name → token pair to the `AGENT_TOKENS` secret (JSON). The name must match an **Applied By** option
(`claude`, `codex`, `kimi`, `gemini`, `ollama`, `human`):

```json
{"claude":"<long-random-token>","codex":"<long-random-token>"}
```

Generate tokens with e.g. `openssl rand -hex 32`. Store them as a GitHub Actions secret named `AGENT_TOKENS`; the deploy workflow syncs it to the Worker.

## 2. Log an application

```bash
curl -X POST https://<your-worker-domain>/api/agent/applications \
  -H "Authorization: Bearer $CLAUDE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "company": "Acme AI",
        "role": "Senior LLM Engineer",
        "platform": "Ashby",
        "url": "https://jobs.example.com/acme/123",
        "notes": "Applied with the AI resume; answered 6 screening questions.",
        "status": "applied"
      }'
```

Response: `201 {"ok":true,"id":"<clickup task id>","agent":"claude"}`.

Fields: `company` and `role` are required. `platform` is one of Greenhouse, Ashby, Lever, Company site, LinkedIn, Wellfound, Upwork, Other.
`appliedOn` (YYYY-MM-DD) defaults to today. The agent's name always comes from the token.

## Rules for agents (house style)

1. **Check before applying**: search the tracker so two agents don't apply to the same role.
2. **Never complete bot checks** (CAPTCHAs, emailed human-check codes). Log the task as `not started` with a note and hand it to the human.
3. **Don't sign legal agreements** on the user's behalf; ticking routine privacy consents is a per-user setting.
4. **No secrets or personal data in notes** — notes are private in ClickUp, but treat them as sensitive.
