# Identity & Attribution Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute every agent action to a full identity (`user/model/approach`) resolved from the bearer token, so two users running the same base model — and a user running their own config for cyber bug-bounty review — are credited separately.

**Architecture:** A small identity registry (`AGENT_IDENTITIES` secret: `token → {user, model, approach, billing}`) resolved at the agent-auth boundary. Every attribution write stores both the derived `model` (as today's `agent`, so colours and per-model rollups keep working) and the full `identity` string (new column) for credit. `AGENT_TOKENS` keeps working, read as single-user identities. Cyber review passes are sourced from configured cyber-capable identities instead of a hardcoded model list, and credited to the identity whose token completes the pass.

**Tech Stack:** TypeScript, Cloudflare Pages Functions + Workers, D1 (SQLite), React (Vite). Tests: `node scripts/test.mjs` (`node:test`), `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-10-13-identity-concurrency-cost-design.md` (§3 Identity, §5 Attribution; this plan is Stage 1 of the build order. Stage 2 concurrency and Stage 3 cost are separate plans. Runner-level per-identity routing — a runner advertising which identities it serves — is explicitly out of scope here; identity is derived from the token that performs/completes the work.)

## Global Constraints

- Node ≥ 22 for Wrangler; run local Wrangler with `PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH` (copied from the repo's WSL setup note).
- Schema changes are additive only, via the repo's existing idempotent `ALTER TABLE … .catch(()=>{})` pattern plus a shadow migration file under `migrations/`; no destructive migration.
- Attribution storage keeps the existing `agent` column meaning = **model** (lowercased). The new `identity` column is the full `user/model/approach` string, lowercased. Colour/label keying stays on `model`.
- `AGENT_TOKENS` must keep authenticating unchanged when `AGENT_IDENTITIES` is unset or does not contain a token.
- Identity strings are lowercased and formed as `user/model/approach`; `approach` defaults to `default`.
- Production deploy is Git-connected Cloudflare Pages: a push to `main` builds and deploys. Secrets are set with `wrangler pages secret put <NAME> --project-name job-agent-hub`.

## Review Focus

- **Malformed `AGENT_IDENTITIES` JSON** → registry treated as empty, `AGENT_TOKENS` still authenticates (pinned in Task 1).
- **Token in both `AGENT_IDENTITIES` and `AGENT_TOKENS`** → `AGENT_IDENTITIES` wins; no double match or timing early-exit (pinned in Task 1).
- **Unknown/short token** (< 24 chars or absent) → `resolveIdentity` returns `null`, request rejected as today (pinned in Task 1).
- **Cyber work when no cyber-capable identity is configured** → `enqueueCyber` falls back to the `ollama/kimi/claude` filter, and `cyberTick`'s existing path still marks the row `blocked` rather than losing it (fallback implemented in Task 5).
- **Legacy rows with `identity IS NULL`** (written before this change) → analytics/UI fall back to `model` and never crash on null (pinned by the third event in Task 6's test).

---

### Task 1: Identity registry and resolution (`auth.ts`)

**Files:**
- Modify: `worker/src/auth.ts`
- Modify: `worker/src/types.ts` (add `AGENT_IDENTITIES?: string` to `Env`)
- Test: `tests/identity.test.ts` (create)

**Interfaces:**
- Produces:
  - `export interface Identity { id: string; user: string; model: string; approach: string; billing?: { mode: "api" } | { mode: "subscription"; period: "weekly" | "monthly"; quota: number } }`
  - `export function resolveIdentity(request: Request, env: Env): Identity | null` — matches the bearer token against `AGENT_IDENTITIES` first, then `AGENT_TOKENS`; returns `null` when no token matches.
  - `export function identityId(i: { user: string; model: string; approach: string }): string` → `"user/model/approach"` lowercased.
  - `agentName(request, env)` is retained and returns `resolveIdentity(...)?.model ?? null` (back-compat: for a bare `AGENT_TOKENS` name, model === that name).

- [ ] **Step 1: Write the failing test**

Create `tests/identity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIdentity, identityId, agentName } from "../worker/src/auth.ts";

const TOK = "x".repeat(30), TOK2 = "y".repeat(30), LEGACY = "z".repeat(30);
function req(token?: string) {
  return new Request("https://h/api/agent/me", token ? { headers: { Authorization: `Bearer ${token}` } } : {});
}
const env = {
  AGENT_IDENTITIES: JSON.stringify({
    [TOK]: { user: "Roman", model: "Claude", approach: "Hermes",
             billing: { mode: "subscription", period: "weekly", quota: 2000000 } },
    [TOK2]: { user: "brandon", model: "codex", approach: "default", billing: { mode: "api" } },
  }),
  AGENT_TOKENS: JSON.stringify({ kimi: LEGACY }),
} as any;

test("resolveIdentity reads the registry and lowercases the id", () => {
  const i = resolveIdentity(req(TOK), env)!;
  assert.equal(i.id, "roman/claude/hermes");
  assert.equal(i.model, "claude");
  assert.deepEqual(i.billing, { mode: "subscription", period: "weekly", quota: 2000000 });
});

test("AGENT_TOKENS entries resolve as single-user identities", () => {
  const i = resolveIdentity(req(LEGACY), env)!;
  assert.equal(i.id, "kimi/kimi/default");
  assert.equal(i.model, "kimi");
});

test("agentName stays the model for back-compat", () => {
  assert.equal(agentName(req(TOK), env), "claude");
  assert.equal(agentName(req(LEGACY), env), "kimi");
});

test("unknown token and malformed registry are safe", () => {
  assert.equal(resolveIdentity(req("short"), env), null);
  assert.equal(resolveIdentity(req(), env), null);
  const bad = { AGENT_IDENTITIES: "{not json", AGENT_TOKENS: JSON.stringify({ kimi: LEGACY }) } as any;
  assert.equal(resolveIdentity(req(LEGACY), bad)!.model, "kimi"); // falls back to AGENT_TOKENS
});

test("identityId builds the canonical string", () => {
  assert.equal(identityId({ user: "A", model: "B", approach: "C" }), "a/b/c");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/identity.test.ts` (or `npm test`)
Expected: FAIL — `resolveIdentity`/`identityId` are not exported.

- [ ] **Step 3: Implement in `worker/src/auth.ts`**

Add near the other exports (reuse the existing `timingSafeEqual`):

```ts
export interface Identity {
  id: string; user: string; model: string; approach: string;
  billing?: { mode: "api" } | { mode: "subscription"; period: "weekly" | "monthly"; quota: number };
}

export function identityId(i: { user: string; model: string; approach: string }): string {
  return `${i.user}/${i.model}/${i.approach}`.toLowerCase();
}

interface RawIdentity { user?: string; model?: string; approach?: string; billing?: Identity["billing"] }
function identityMap(env: Env): Record<string, RawIdentity> {
  if (!env.AGENT_IDENTITIES) return {};
  try { return JSON.parse(env.AGENT_IDENTITIES) as Record<string, RawIdentity>; } catch { return {}; }
}

function bearer(request: Request): string | null {
  const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Resolve a bearer token to a full identity: AGENT_IDENTITIES first, then AGENT_TOKENS (single-user). */
export function resolveIdentity(request: Request, env: Env): Identity | null {
  const tok = bearer(request);
  if (!tok || tok.length < 24) return null;
  let found: Identity | null = null;
  for (const [t, raw] of Object.entries(identityMap(env))) {
    if (t.length >= 24 && timingSafeEqual(t, tok)) {
      const user = (raw.user ?? "").toLowerCase(), model = (raw.model ?? "").toLowerCase(), approach = (raw.approach ?? "default").toLowerCase();
      if (user && model) found = { id: identityId({ user, model, approach }), user, model, approach, billing: raw.billing };
    }
  }
  if (found) return found;
  for (const [name, t] of Object.entries(tokenMap(env))) {
    if (t.length >= 24 && timingSafeEqual(t, tok)) {
      const model = name.toLowerCase();
      found = { id: identityId({ user: model, model, approach: "default" }), user: model, model, approach: "default" };
    }
  }
  return found;
}
```

Then make `agentName` delegate (replace the existing body):

```ts
export function agentName(request: Request, env: Env): string | null {
  return resolveIdentity(request, env)?.model ?? null;
}
```

Add to `worker/src/types.ts` in the secrets block near `AGENT_TOKENS`:

```ts
  /** JSON map of bearer token -> { user, model, approach, billing }. Supersedes AGENT_TOKENS per token. */
  AGENT_IDENTITIES?: string;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/identity.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add worker/src/auth.ts worker/src/types.ts tests/identity.test.ts
git commit -m "feat: resolve bearer tokens to full identities (user/model/approach)"
```

---

### Task 2: `identity` columns and migration

**Files:**
- Modify: `worker/src/db.ts` (lazy `ALTER` for `events`, next to the existing ones)
- Modify: `worker/src/runs.ts` (lazy `ALTER` for `runs.identity`, in the block at lines ~48-50)
- Modify: `worker/src/cyber.ts` (lazy `ALTER` for `cyber_work.identity` and `cyber_review_passes.identity`, in `cyberDb`)
- Create: `migrations/0009_identity.sql`
- Test: `tests/identity-schema.test.ts` (create)

**Interfaces:**
- Produces: columns `events.identity TEXT`, `runs.identity TEXT`, `cyber_work.identity TEXT`, `cyber_review_passes.identity TEXT` (all nullable).

- [ ] **Step 1: Write the failing test**

Create `tests/identity-schema.test.ts` (follow the harness in `tests/dispatch.test.ts` for building an in-memory D1; reuse its `env`/`sqlite` setup helper import):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.ts"; // if no helper exists, inline the better-sqlite3 setup copied from dispatch.test.ts
import { logEvent } from "../worker/src/db.ts";
import { cyberDb } from "../worker/src/cyber.ts";

test("identity columns exist after schema init", async () => {
  const { env, sqlite } = makeEnv();
  await logEvent(env, { agent: "claude", type: "applied" });   // forces events schema
  await cyberDb(env);                                           // forces cyber schema
  const cols = (t: string) => sqlite.prepare(`PRAGMA table_info(${t})`).all().map((r: any) => r.name);
  assert.ok(cols("events").includes("identity"));
  assert.ok(cols("cyber_work").includes("identity"));
  assert.ok(cols("cyber_review_passes").includes("identity"));
});
```

> If `tests/helpers.ts` does not exist, copy the `better-sqlite3` + D1-shim setup block from the top of `tests/dispatch.test.ts` into this file instead of importing a helper.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/identity-schema.test.ts`
Expected: FAIL — `events`/`cyber_work` have no `identity` column.

- [ ] **Step 3: Add the lazy ALTERs**

In `worker/src/db.ts`, where `events` is ensured, add after the table create:
```ts
await env.DB.prepare("ALTER TABLE events ADD COLUMN identity TEXT").run().catch(() => {});
```
In `worker/src/runs.ts`, in the ALTER block (~lines 48-50) add:
```ts
await env.DB.prepare("ALTER TABLE runs ADD COLUMN identity TEXT").run().catch(() => {});
```
In `worker/src/cyber.ts` `cyberDb`, after the existing ALTERs add:
```ts
await d.prepare("ALTER TABLE cyber_work ADD COLUMN identity TEXT").run().catch(() => {});
await d.prepare("ALTER TABLE cyber_review_passes ADD COLUMN identity TEXT").run().catch(() => {});
```

Create `migrations/0009_identity.sql`:
```sql
ALTER TABLE runs ADD COLUMN identity TEXT;
ALTER TABLE events ADD COLUMN identity TEXT;
ALTER TABLE cyber_work ADD COLUMN identity TEXT;
ALTER TABLE cyber_review_passes ADD COLUMN identity TEXT;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/identity-schema.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db.ts worker/src/runs.ts worker/src/cyber.ts migrations/0009_identity.sql tests/identity-schema.test.ts
git commit -m "feat: add identity columns to runs, events and cyber tables"
```

---

### Task 3: `logEvent` records identity

**Files:**
- Modify: `worker/src/db.ts` (`logEvent` signature + INSERT)
- Test: `tests/identity-event.test.ts` (create)

**Interfaces:**
- Consumes: `events.identity` column (Task 2).
- Produces: `logEvent` accepts optional `identity?: string | null` and writes it; when omitted, stores `null`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.ts";
import { logEvent } from "../worker/src/db.ts";

test("logEvent stores identity when provided", async () => {
  const { env, sqlite } = makeEnv();
  await logEvent(env, { agent: "claude", type: "applied", identity: "roman/claude/hermes" });
  const row: any = sqlite.prepare("SELECT agent, identity FROM events ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.agent, "claude");
  assert.equal(row.identity, "roman/claude/hermes");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/identity-event.test.ts`
Expected: FAIL — `identity` not written (column stays null / unknown property).

- [ ] **Step 3: Implement**

In `worker/src/db.ts` `logEvent`: add `identity?: string | null;` to the `e` object type, and include `identity` in the INSERT column list and bindings (`e.identity ?? null`). Locate the existing `INSERT INTO events (...)` inside `logEvent` and add the `identity` column + a `?` bind in the same position.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/identity-event.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db.ts tests/identity-event.test.ts
git commit -m "feat: logEvent records the acting identity"
```

---

### Task 4: Thread identity through the agent REST boundary and application reporting

**Files:**
- Modify: `worker/src/index.ts` (agent REST block at ~line 209; resolve identity once, pass to attributing ops)
- Modify: `worker/src/jobs.ts` (`reportResult`, `logApplication`, `claimJobs` accept an optional `identity` and pass it to their `logEvent` calls)
- Test: `tests/identity-report.test.ts` (create)

**Interfaces:**
- Consumes: `resolveIdentity` (Task 1), `logEvent(identity)` (Task 3).
- Produces: `reportResult(env, agent, id, report, admin?, identity?)`, `logApplication(env, agent, job, identity?)`, `claimJobs(env, agent, opts, identity?)` — the new trailing optional `identity?: string | null` is forwarded into every `logEvent` these functions make. Existing callers that omit it are unchanged (identity stored null).

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, seedOneOpenJob } from "./helpers.ts"; // seedOneOpenJob: inline a minimal mock job if no helper
import { reportResult } from "../worker/src/jobs.ts";

test("reportResult tags the applied event with the identity", async () => {
  const { env, sqlite } = makeEnv({ mock: true });
  const jobId = await seedOneOpenJob(env);               // or use a MOCK queue id from mock.ts
  await reportResult(env, "claude", jobId, { outcome: "applied" } as any, false, "roman/claude/hermes");
  const row: any = sqlite.prepare("SELECT agent, identity, type FROM events WHERE type='applied' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.agent, "claude");
  assert.equal(row.identity, "roman/claude/hermes");
});
```

> If helpers don't exist, construct the env in MOCK mode and use a mock queue id from `worker/src/mock.ts` (e.g. the first `mk(...)` id) the way `tests/dispatch.test.ts` drives the hub.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/identity-report.test.ts`
Expected: FAIL — `reportResult` has no identity parameter / event identity is null.

- [ ] **Step 3: Implement**

In `worker/src/jobs.ts`:
- Add a trailing `identity: string | null = null` parameter to `reportResult`, `logApplication`, and `claimJobs`.
- In each `logEvent(env, { … })` call inside these functions, add `identity`.

In `worker/src/index.ts`, agent REST block (~line 209), after `const agent = agentName(request, env);` add:
```ts
const identity = resolveIdentity(request, env)?.id ?? null;
```
(import `resolveIdentity` from `./auth`). Then pass `identity` to the attributing calls in that block:
- `claimJobs(env, agent, {…}, identity)`
- `logApplication(env, agent, newJob(...), identity)` (the `/applications` POST)
- `reportResult(env, agent, id, …, false, identity)` (the `/jobs/:id/report` POST)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/identity-report.test.ts && npm test && npm run typecheck`
Expected: PASS; all existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts worker/src/jobs.ts tests/identity-report.test.ts
git commit -m "feat: record identity on application claims and reports"
```

---

### Task 5: Cyber passes sourced from identities and credited by identity

**Files:**
- Modify: `worker/src/cyber.ts` (`enqueueCyber` pass source; `completeCyber` records identity; `cyberTick` default plan)
- Modify: `worker/src/index.ts` (agent cyber routes pass identity to `completeCyber`)
- Modify: `worker/src/autopilot.ts` (export the set of cyber-capable configured agents; see Step 3)
- Test: `tests/identity-cyber.test.ts` (create)

**Interfaces:**
- Consumes: `resolveIdentity` (Task 1), `cyber_work.identity` / `cyber_review_passes.identity` (Task 2).
- Produces:
  - `completeCyber(env, id, agent, body, identity?)` — stores `identity` on the completed pass and work row.
  - `enqueueCyber` builds `pass_agents` from **configured cyber-capable agents** (`agentNames(env)` filtered by `settings.agents[a]!==false && taskSwitches(settings,a).cyber`), falling back to `['ollama','kimi','claude']` only when none are configured — preserving today's demo behaviour.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.ts";
import { cyberDb, completeCyber } from "../worker/src/cyber.ts";

test("completeCyber stamps the reviewing identity on the pass", async () => {
  const { env, sqlite } = makeEnv();
  const d = await cyberDb(env);
  // Arrange a running pass owned by model 'claude', run 1, sequence 1:
  sqlite.prepare("INSERT INTO cyber_work (source_key,created_at,program,platform,target,source,evidence,status,run_id,agent,pass_agents) VALUES ('k',1,'P','H','t','s','steps; impact; remediation','running',1,'claude','[\"claude\"]')").run();
  const wid = sqlite.prepare("SELECT id FROM cyber_work WHERE source_key='k'").get().id;
  sqlite.prepare("INSERT INTO cyber_review_passes (work_id,sequence,agent,run_id,status,created_at) VALUES (?,1,'claude',1,'running',1)").run(wid);
  await completeCyber(env, wid, "claude", { verdict: "reject", result: "no trust boundary crossed" }, "roman/claude/hermes");
  const pass: any = sqlite.prepare("SELECT identity FROM cyber_review_passes WHERE work_id=? AND sequence=1").get(wid);
  assert.equal(pass.identity, "roman/claude/hermes");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/identity-cyber.test.ts`
Expected: FAIL — `completeCyber` has no identity parameter / pass identity null.

- [ ] **Step 3: Implement**

In `worker/src/cyber.ts`:
- `completeCyber(env, id, agent, body, identity: string | null = null)`: add `identity=?` to the `UPDATE cyber_review_passes SET status='completed', …` and to the `UPDATE cyber_work SET …` statements (bind `identity`); add `identity` to the `logEvent(env, {agent, type:'cyber_triage', …})` call.
- `enqueueCyber`: replace
  ```ts
  const passAgents=['ollama','kimi','claude'].filter(a=>settings.agents?.[a]!==false&&taskSwitches(settings,a).cyber);
  ```
  with
  ```ts
  const configured = agentNames(env).filter(a=>settings.agents?.[a]!==false&&taskSwitches(settings,a).cyber);
  const passAgents = configured.length ? configured : ['ollama','kimi','claude'].filter(a=>settings.agents?.[a]!==false&&taskSwitches(settings,a).cyber);
  ```
  (import `agentNames` from `./auth`).
- `cyberTick`: where it defaults `plan=['ollama','kimi','claude']` when `pass_agents` is empty, keep as-is (already a fallback).

In `worker/src/index.ts`, agent cyber route (`/api/agent/cyber/:id/complete`): pass the `identity` resolved at the top of the agent block:
```ts
if(cyberWork && method==='POST' && cyberWork[2])return json(await completeCyber(env,Number(cyberWork[1]),agent,await readJson(request),identity));
```

In `worker/src/autopilot.ts`: no code change required if `taskSwitches` and `settings.agents` are already exported for use in `cyber.ts` (they are imported there today). If `agentNames` import creates a cycle, import it from `./auth` directly in `cyber.ts` (auth.ts imports only `types`, so no cycle).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/identity-cyber.test.ts && npm test && npm run typecheck`
Expected: PASS; existing cyber tests still green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cyber.ts worker/src/index.ts tests/identity-cyber.test.ts
git commit -m "feat: credit cyber passes to the reviewing identity; source passes from configured identities"
```

---

### Task 6: Surface identity in analytics and the admin UI

**Files:**
- Modify: `worker/src/analytics.ts` (add a `byIdentity` rollup to the response)
- Modify: `worker/src/cyber.ts` `cyberSummary` (add identity to items + a by-identity count)
- Modify: `src/api.ts` (extend response types with `byIdentity` / item `identity`)
- Modify: `src/agents.ts` (`identityLabel`)
- Modify: `src/components/CommandCenter.tsx` and `src/components/Bounty.tsx` (hover `title` + a by-identity column)
- Test: `tests/identity-analytics.test.ts` (create) + `npm run typecheck` for the React side

**Interfaces:**
- Consumes: `events.identity`, `cyber_review_passes.identity`.
- Produces: `buildAnalytics(...)` result gains `byIdentity: { identity: string; applied: number; … }[]`; `src/agents.ts` exports `identityLabel(id: string): string` rendering `user · model · approach`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.ts";
import { logEvent } from "../worker/src/db.ts";
import { buildAnalytics } from "../worker/src/analytics.ts";

test("analytics groups applied events by identity", async () => {
  const { env } = makeEnv();
  await logEvent(env, { agent: "claude", type: "applied", identity: "roman/claude/hermes" });
  await logEvent(env, { agent: "claude", type: "applied", identity: "brandon/claude/default" });
  await logEvent(env, { agent: "kimi", type: "applied" }); // legacy row: identity null -> falls back to model
  const a = await buildAnalytics(env, 30);
  const ids = (a.byIdentity ?? []).map((r: any) => r.identity).sort();
  assert.deepEqual(ids, ["brandon/claude/default", "kimi", "roman/claude/hermes"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/identity-analytics.test.ts`
Expected: FAIL — `a.byIdentity` is undefined.

- [ ] **Step 3: Implement**

- `worker/src/analytics.ts`: the events query already selects `agent`; add `identity` to that SELECT and accumulate a `byIdentity` map keyed by `identity ?? agent` (so legacy null rows fall back to the model), counting at least `applied`. Add `byIdentity: [...]` to the returned object and to the `Analytics` type.
- `worker/src/cyber.ts` `cyberSummary`: add `identity` to the items SELECT and add a `byIdentity` aggregate (`SELECT identity, COUNT(*) … FROM cyber_review_passes WHERE status='completed' GROUP BY identity`), tolerating null.
- `src/api.ts`: add `byIdentity?: {identity:string; applied:number}[]` to the analytics type and `identity?: string|null` to cyber items / a `byIdentity` list.
- `src/agents.ts`:
  ```ts
  export function identityLabel(id: string): string {
    const [user, model, approach] = id.split("/");
    const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
    return approach && approach !== "default" ? `${cap(user)} · ${cap(model)} · ${cap(approach)}` : `${cap(user)} · ${cap(model)}`;
  }
  ```
- `src/components/CommandCenter.tsx` (live activity) and `src/components/Bounty.tsx`: where an agent/pass name is rendered, add `title={row.identity ? identityLabel(row.identity) : undefined}` for the hover tag, and render the analytics `byIdentity` list as a small table/column. Colour stays via `agentColor(model)` (unchanged).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/identity-analytics.test.ts && npm test && npm run typecheck && npm run build`
Expected: PASS; typecheck clean; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add worker/src/analytics.ts worker/src/cyber.ts src/api.ts src/agents.ts src/components/CommandCenter.tsx src/components/Bounty.tsx tests/identity-analytics.test.ts
git commit -m "feat: show per-identity attribution in analytics and admin UI"
```

---

### Task 7: MCP parity, docs, and secret

**Files:**
- Modify: `worker/src/mcp.ts` (resolve identity at the MCP bearer boundary and pass to the shared ops, same as REST)
- Modify: `.dev.vars.example` (document `AGENT_IDENTITIES`)
- Modify: `wrangler.jsonc` (add `AGENT_IDENTITIES` to the secrets comment list)
- Modify: `README.md` (one line under the agent-token section + a note that cyber passes now come from configured identities)
- Test: `npm test && npm run typecheck`

**Interfaces:**
- Consumes: `resolveIdentity` (Task 1), the identity-aware ops (Tasks 4–5).

- [ ] **Step 1: Thread identity through MCP**

In `worker/src/mcp.ts`, wherever it authenticates the agent (currently via `agentName`), also compute `const identity = resolveIdentity(request, env)?.id ?? null;` and pass it to `claimJobs` / `logApplication` / `reportResult` / `completeCyber` exactly as Task 4/5 did for REST. Grep for the tool handlers that call those functions and add the trailing `identity` argument.

- [ ] **Step 2: Document the secret**

In `.dev.vars.example` add:
```
# Supersedes AGENT_TOKENS per token. JSON: token -> {user, model, approach, billing}.
# billing: {"mode":"api"} or {"mode":"subscription","period":"weekly"|"monthly","quota":<number>}
AGENT_IDENTITIES={"<token>":{"user":"roman","model":"claude","approach":"hermes","billing":{"mode":"subscription","period":"weekly","quota":2000000}}}
```
In `wrangler.jsonc`, add `AGENT_IDENTITIES` to the `Secrets, set with …` comment list.
In `README.md`, under the agents/tokens section, add one line: identities (`user/model/approach`) are resolved from `AGENT_IDENTITIES`; `AGENT_TOKENS` still works as single-user identities; cyber review passes are drawn from configured cyber-capable identities.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add worker/src/mcp.ts .dev.vars.example wrangler.jsonc README.md
git commit -m "feat: identity-aware MCP path; document AGENT_IDENTITIES secret"
```

- [ ] **Step 5: Manual verification note (not automated)**

With the local server (`PATH=$HOME/.nvm/...v24.../bin:$PATH npx wrangler pages dev dist --port 8788 --binding MOCK=true`), set a test `AGENT_IDENTITIES` in `.dev.vars`, POST `/api/agent/cyber/:id/complete` with roman's token on a seeded running pass, and confirm `cyber_review_passes.identity = roman/claude/hermes` and the admin Bounty tab's by-identity view shows it. Then deploy by pushing `main` (Git-connected Cloudflare Pages) and set the prod secret: `wrangler pages secret put AGENT_IDENTITIES --project-name job-agent-hub`.

---

## Notes on scope boundaries (for the executor)

- This plan makes **credit** identity-aware. It does **not** change runner dispatch: a cyber pass is still dispatched to a model and claimed by whatever runner advertises that model; the identity is whatever token completes it. Running Roman's and Brandon's same-model configs as two *distinct passes in one consensus plan* needs runner per-identity routing — that is a separate plan.
- Per-identity **concurrency** (Spec §4) and **cost/usage** accounting (Spec §6) are Stage 2 and Stage 3 plans; the `billing` field is captured on the identity here but not yet consumed.
