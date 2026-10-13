# Multi-user identity, concurrency, and subscription cost accounting

Date: 2026-10-13
Status: Design — awaiting review
Scope: `job-agent-hub` (jobhunter.prestonzen.com)

## 1. Context and goals

Today an agent is a bare model name (`claude`, `codex`, `kimi`). The `AGENT_TOKENS`
secret maps `name -> token`; runs, events and cyber work all store that name as `agent`.
This blocks three things several users (each bringing their own agent configs) now need:

1. **Concurrency** — one model should run several jobs at once: multiple **applications**
   in parallel, and multiple **cyber assessments** in parallel. Cyber has no double-scan
   risk — what matters is when a report arrives, then a validity check — so two configs
   assessing the same target is fine, and each is its own credited work item.
2. **Attribution by user + config, not bare model** — if Roman brings Claude and Brandon
   brings Claude (or Hermes, or Codex) against the same bug-bounty targets, the hub records
   only `claude` and cannot say whose config produced a report. Credit must distinguish each
   **user's agent variant**.
3. **Cost by billing mode** — only true API work is `$/token`. Most work runs on
   subscriptions, which should be measured as **% of a quota over a period**: **weekly** for
   Codex and Claude, **monthly** for Kimi.

### Success criteria

- Two identities that share a base model (e.g. `roman/claude` and `brandon/claude`) are
  recorded, counted and credited separately everywhere work is attributed.
- A single identity can have N runs in flight at once (applications and cyber), bounded only
  by runner slots and the existing per-ATS pacing.
- The admin cost view reports, per identity: `$` for API identities, and **% of the weekly
  (Claude/Codex) or monthly (Kimi) quota used** for subscription identities.

## 2. Non-goals (YAGNI)

- No OAuth / self-serve onboarding of users. Identities are provisioned by an operator via a
  secret, exactly as `AGENT_TOKENS` is today.
- No per-user dashboards or access control on the admin page. One operator view, with an
  identity breakdown added.
- No change to per-ATS pacing limits — those already protect job boards and stay the gate on
  how fast one ATS is hit.
- No billing/invoicing. Cost accounting is reporting only.
- Colors are not expanded per identity; identity is surfaced by label, not by new colors.

## 3. Identity model (the spine)

An **identity** = `user` + `model` + `approach`, with its own token and billing rule. A small
registry holds it; everything that attributes work references the identity string.

### Identity string

Canonical form: `user/model/approach`, lowercased, e.g. `roman/claude/hermes`,
`brandon/claude/default`, `brandon/codex/default`. When `approach` is `default` the short form
`user/model` may be shown in dense UI; storage always keeps the full triple.

### Registry and token resolution

New secret `AGENT_IDENTITIES` (JSON): `token -> { user, model, approach, billing }` where
`billing` is described in §6. Example:

```json
{
  "<token-a>": { "user": "roman",   "model": "claude", "approach": "hermes",
                 "billing": { "mode": "subscription", "period": "weekly", "quota": 2000000 } },
  "<token-b>": { "user": "brandon", "model": "claude", "approach": "default",
                 "billing": { "mode": "subscription", "period": "weekly", "quota": 2000000 } },
  "<token-c>": { "user": "brandon", "model": "codex",  "approach": "default",
                 "billing": { "mode": "api" } }
}
```

**Back-compat [A]:** existing `AGENT_TOKENS` entries keep working. A bare `name -> token`
resolves to identity `{ user: name, model: name, approach: "default", billing: subscription
with the existing default plan where one exists (kimi monthly, codex/claude weekly), else
api }`. This preserves current behaviour until an operator migrates entries to
`AGENT_IDENTITIES`.

`worker/src/auth.ts` gains `resolveIdentity(env, token): Identity | null` (and the existing
agent-name auth is implemented on top of it: `agentFor(token) = identity.model` for callers
that only need the model). The MCP and REST agent paths (`index.ts`) attach the full identity
to the request context.

### Colour and display [A]

- **Colour follows `model`** — `roman/claude/*` and `brandon/claude/*` share Claude's colour.
  `src/agents.ts` `agentColor`/`agentLabel` keep taking a model key; a new `identityLabel`
  renders `user · model · approach`.
- **Identity is surfaced two ways:** a **hover tag** (the `title` attribute, and a small
  muted suffix where space allows) on the agent name in the live activity feed and tables; and
  a dedicated **per-identity column/section** in the admin analytics and cyber tables. The
  public dashboard stays per-model (unchanged, uncluttered).

## 4. Concurrency

### Applications

- Replace the "one in-flight run per agent" rule in `worker/src/autopilot.ts` (the
  `if (inFlight.some(r => r.agent === agent)) continue;` guard, ~line 227) with a
  **per-identity in-flight count** check: allow up to `perIdentityConcurrent` runs per identity
  (new autopilot setting, **default 3 [A]**, clamped 1–6).
- The global `maxConcurrent` stays as the hub-wide ceiling (default raised to **[A] 4**,
  clamp widened to 1–12) and runner `slots`/`busy` still cap real parallelism.
- **Per-ATS pacing in `pacing.ts` is unchanged** — it remains the limit on how fast any one
  ATS is touched, and on one in-flight application per company.
- The atomic claim (`claimRun`, single `UPDATE ... WHERE id = (SELECT ... LIMIT 1)`) is
  unchanged, so a posting is never double-worked.

### Cyber

- Allow parallel cyber assessments per identity. Cyber review passes already run as separate
  `task='cyber'` runs keyed by `(work_id, run_id, agent)`; the serialization to remove is the
  shared agent gate, replaced by the same per-identity count.
- **Dedup key includes identity [A]:** `enqueueCyber` currently dedups on a `UNIQUE source_key`
  with `INSERT OR IGNORE`. So Roman's config and Brandon's config each get their own `cyber_work`
  row on the same target (each credited separately), while dedup still holds **within** one
  identity, the **stored `source_key` is namespaced by identity** at write time —
  `source_key = "<identity>::<rawSourceKey>"`. This keeps the existing standalone
  `UNIQUE(source_key)` constraint intact (no table rebuild) and makes it mean "once per identity"
  automatically. `identity` is also stored as its own column for grouping.

## 5. Attribution

- Every write that sets `agent` also sets `identity`: `logEvent`, `runs` rows, `cyber_work`,
  `cyber_review_passes`. The `agent`/`model` value is retained (derived from the identity) so
  colouring and existing per-model rollups keep working.
- The human cyber reviewer credit added earlier this session (`cyber_work.reviewed_by`, set to
  `ADMIN_NAME`) stays as-is; it is the human-review axis, orthogonal to agent/variant credit.
- Analytics (`worker/src/analytics.ts`) and `cyberSummary` gain an **by-identity** grouping
  alongside the existing by-agent/by-model one. UI renders it per §3.

## 6. Cost / usage accounting

Each identity carries a `billing` rule:

- `{ mode: "api" }` — cost in **USD per token**, from the CLI-reported `cost_usd` already stored
  on runs. Unchanged path.
- `{ mode: "subscription", period: "weekly" | "monthly", quota: <number> }` — usage as
  **% of the period quota**. Period is **weekly** for Claude and Codex, **monthly** for Kimi.

`worker/src/billing.ts` is generalized from monthly-USD-only to **period-aware, per identity**:

- Compute the current period window (week: Mon 00:00 local `[A]`; month: existing JST-month
  logic retained for continuity `[A]`).
- Sum usage in-window per identity. **Usage signal [A]:** if a run reports a native usage
  figure from the CLI (new optional `usage_pct` / `quota_units` on the run finish payload), use
  it; otherwise estimate from `tokens ÷ quota`. The result is labelled **provisional** when
  estimated, reusing the existing provisional-figure convention in `billing.ts`.
- Output per subscription identity: `{ period, used, quota, pct, provisional }`. API identities
  keep `{ costUsd }`.

Worked example: Roman's Claude burns 400k tokens this week with `quota: 2_000_000` → **20% of
weekly quota** (provisional, estimated). Brandon's Codex on API → `$X` from reported cost.

Quota numbers live in the identity's `billing.quota` (in `AGENT_IDENTITIES`), with an optional
`identity_quota` setting override so an operator can retune without rotating tokens.

## 7. Data model changes

All additive, using the repo's existing `ALTER ... .catch(()=>{})` idempotent pattern; no
destructive migration.

- `runs`: `+ identity TEXT`, `+ usage_pct REAL` (optional native usage), `+ quota_units REAL`
  (optional).
- `events`: `+ identity TEXT`.
- `cyber_work`: `+ identity TEXT`; the existing `UNIQUE(source_key)` is kept, and `source_key`
  is written identity-namespaced (`"<identity>::<rawSourceKey>"`) so dedup is per-identity
  without a table rebuild.
- `cyber_review_passes`: `+ identity TEXT`.
- New migration file under `migrations/` mirroring the lazy `ALTER`s so a fresh remote DB and a
  running instance converge (consistent with how 0003–0008 shadow the runtime schema).

## 8. API changes

- Agent auth (MCP + REST) resolves and attaches the full identity; run claim, event logging,
  application reporting and cyber complete all carry it.
- `finishRun` payload accepts optional `usagePct` / `quotaUnits`.
- `/api/admin/analytics` and `/api/admin/bounty` responses gain a `byIdentity` array.
- `src/api.ts` types extended; `AGENT_IDENTITIES` documented in `.dev.vars.example` and
  `wrangler.jsonc` secret list.

## 9. Testing

- Identity resolution: token → identity; `AGENT_TOKENS` back-compat; unknown token rejected.
- Concurrency: N-in-flight per identity honoured; `maxConcurrent` and runner slots still cap;
  per-ATS pacing unchanged; atomic claim still prevents double-work (extend `tests/dispatch.test.ts`).
- Cyber: two identities enqueue the same target → two work items, each credited; same identity
  + same evidence → deduped.
- Billing: weekly vs monthly window selection; estimate vs native-signal; provisional labelling;
  API vs subscription branch.

## 10. Build order

One spec, three staged implementation plans, each shippable:

1. **Identity registry + attribution** (foundation): registry, auth resolution, `identity` on
   runs/events/cyber, back-compat, UI label/hover + analytics by-identity column.
2. **Concurrency**: per-identity in-flight for applications and cyber; cyber dedup by identity.
3. **Cost/usage**: period-aware billing, subscription % with weekly/monthly periods, optional
   native usage signal.

## 11. Assumptions (overridable) and open items

- `[A]` Identity string = `user/model/approach`; `approach` defaults to `default`.
- `[A]` Colour follows model; identity shown via hover tag + analytics column (per the approval).
- `[A]` `AGENT_TOKENS` entries remain valid, read as single-user identities.
- `[A]` `perIdentityConcurrent` default 3; `maxConcurrent` default 4 (clamp 1–12).
- `[A]` Cyber dedup is per-identity via an identity-namespaced `source_key`.
- `[A]` Subscription %: use CLI-reported usage when present, else `tokens ÷ quota` (provisional).
- `[A]` Weekly window = Monday local; monthly window keeps the current JST-month basis.
- Open: exact weekly-quota numbers per identity (operator-supplied in `AGENT_IDENTITIES`).
- Repo note: this repo is `prestonzen/job-agent-hub`; this spec and the related code changes are
  currently local working-tree only (not pushed). Decision on branch/patch/PR is pending.
