# Email and agent operations

## Capability map and delivery order

| Module | Outcome | Depends on |
|---|---|---|
| reply-delivery | Actionable invitations alert loudly, with receipts and retry status | existing inbox bridge |
| email-sourcing | Source verified email applications first, including public communities | existing deduplicated queue |
| cyber-scoring | Versioned rubric rewards evidence calibration, not finding counts | recorded benchmark scenarios |
| application-cost | Per-application spend uses application runs only and exposes missing usage | runner usage records |
| task-models | Local models and harnesses can be selected per task | runner task controls |
| admin-navigation | Five grouped sections, compact overview and bounded lists | existing admin components |

Build order: reply-delivery, email-sourcing, cyber-scoring, application-cost, task-models, admin-navigation.

## Scope and acceptance

- Prefer public employer-authorized email routes. Reddit and accessible Discord hiring posts are leads: verify employer, freshness, role and explicitly supplied address. Never guess emails or send community DMs. Preserve provenance and advertised pay; use existing deduplication.
- Keep twice-daily sourcing and disabled-agent preferences. Claude remains off; its cyber harness configuration does not authorize a paid run or new security targets.
- Treat platform onboarding as actionable separately from interviews. Record Telegram message ID, delivery errors and attempts. Retry definite failures; an uncertain network delivery needs review instead of blind duplication.
- Cyber scores are a transparent 0–100 rubric: verdict 50, severity 20, validation 20, prioritization 10. Equal weight per scenario; use the latest attempt per agent/scenario. Incomplete scenario coverage is provisional. Unknown/malformed scenarios are visibly unscored. Benchmarks are separate from real bounty outcomes.
- Cost per application includes both successful and failed application/email run costs; exclude cyber/sourcing/diagnostics. Distinguish reported charges, estimates and missing usage. No fabricated historical costs or flat-subscription bill estimates.
- Add per-task command selection, model and timeout controls. Compare installed local models using synthetic, offline observations; preserve GPU sharing. Do not launch new scans or make paid model calls for comparison.
- Reduce nine top-level tabs to Overview, Applications, Replies, Cyber and Agents. Preserve legacy deep links. Collapse maintenance controls and cap visible activity/queue rows with explicit access to more.

## Implementation and operation

Source: `worker/src`, `runner`, `src/components`, `bounty`; versioned schema additions: `migrations`.
Follow existing typed function and React component conventions. Use `npm run typecheck` and `npm run build` in a clean dependency checkout. Do not change unrelated working-tree edits.
Observe production mail delivery receipts, run usage coverage, sourcing additions, agent switches and rubric coverage. Deploy via the existing main-branch Pages integration. Schema changes are additive; old runner commands remain the default when no task override is configured.

## Confirmed billing and local inference decisions

The user confirmed Kimi Allegro at $31/month and Codex at $100/month on October 13. Allocate each fixed fee by application/email tokens divided by all tracked monthly tokens, then divide that allocation by distinct reported applications. Calendar month is Asia/Tokyo. Include cache read/write tokens in usage as requested. Display run usage coverage; usage outside this hub and missing runs are not inferred. Kimi usage is recovered only from structured per-turn usage events in sessions whose exact working directory matches the run.

Sparky has a GB10 with 119 GiB shared memory and about 44 GiB available during inspection. Qwen3-Coder-Next is installed but its 51.7 GB weights plus context would exceed that headroom. Gemma 4 and Qwen 3.6 synthetic comparisons did not establish a reliable cyber quality upgrade, so retain the existing backend. vLLM is an optional future serving experiment, not a quality fix by itself. Preserve the existing ComfyUI GPU gate.

Per-task commands allow bounded email, sourcing and cyber work. `runner/hermes-cyber-profile.example.json` prepares an optional Claude cyber profile using the installed Hermes Anthropic provider and the configured Claude model. It is not activated: Hermes documentation states Claude Max plus extra usage credits for OAuth. Keep the current Claude Code route and global off switch until that billing route is explicitly selected. No paid comparison or new target scan is launched. A harness change is not evidence of improved model quality.

The Upwork invitation from Kristel Ann C./Enterprise Talent Services is onboarding for AI Training & Evaluation, not a scheduled interview, and expires October 19. The old tracker classified it recruiter and requested a silent Telegram message, with no receipt retained. New recruiter/onboarding actions are loud; receipt failures are visible, definite failures retry, ambiguous delivery requires explicit recovery. Older messages remain marked legacy rather than retrospectively claimed delivered.

Official references: [Hermes providers](https://hermes-agent.nousresearch.com/docs/integrations/providers) and [NVIDIA DGX Spark vLLM recipes](https://build.nvidia.com/spark/vllm/choose-recipe). A serving engine change requires separate memory/throughput evaluation; it does not change model knowledge.
