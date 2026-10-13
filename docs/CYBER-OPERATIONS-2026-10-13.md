# Continuous local evidence review

Preston's objective is plausible human-reviewed findings that become accepted bug bounty reports.
Token speed, scanner volume, benchmark scores and process exits are supporting diagnostics.

## Work flow

CT 134's `cyber-feed.timer` inventories existing scoped program artifacts every minute. Scanner
observations are batched; Dark Moon validation logs are retained for offline review. Content hashes
deduplicate the durable `cyber_work` queue. Nothing in this feeder scans or contacts targets.

When `cyber_continuous` and agent/task switches are enabled, runner heartbeats dispatch eligible
agents, preferring Ollama. Existing twice-daily sourcing checks retain first scheduling opportunity;
the email autopilot shares finite task capacity. Each cyber run reviews one artifact and saves
`draft`, `needs-validation` or `reject`. Empty queues wait for new evidence rather than replaying
benchmarks. Three attempts without a saved result block the artifact for review. No result is
inferred from the model's console text. Global Claude-off remains respected.

The Cyber panel records human plausibility, false positives, duplicates, submission, acceptance and
rejection with a required explanation/receipt. No external submission happens automatically.
Human-reviewed reasons enter subsequent task context. Synthetic calibration is separate from
actual report outcomes. Unreviewed work cannot increment accepted/plausible counts.

As of October 13, routine evidence saves, needs-validation/reject verdicts, cyber run
completions and scanner `confirmed` labels remain silent in Telegram. A single Ava alert is
sent when a **complete report draft** with reproduction, impact and remediation is saved;
its link opens the full draft for Preston's pre-submission review. Payouts still alert.
The admin Cyber panel opens unreviewed report drafts in full and keeps the other triage
items in history. No report is submitted automatically. See
[Model outcomes](MODEL-OUTCOMES-2026-10-13.md) for the separate synthetic matrix.

## Local model and learning

Sparky already contained Qwen3-Coder-Next Q4_K_M: about 52 GB weights, 80B total parameters and
3B active per token. Active parameter count lowers computation, not total weight storage.
It loaded successfully at 65536 context on the GB10 shared-memory machine. A simple fallback-page
check succeeded; real report quality remains unmeasured until human outcomes accumulate.

The cyber task gets an isolated `/home/agent/.hermes-cyber` profile with Qwen3-Coder-Next, 40 turns
and a 60-minute limit. Other Ollama tasks retain their previous Gemma model/profile. Compression
starts at 80 percent with eight recent turns protected. The ComfyUI gate still pauses/unloads
Ollama when rendering begins. Continuous means whenever fresh evidence and GPU capacity exist.

Hermes supports OpenAI-compatible local endpoints, not only Gemma and Qwen. Its persistent memory
and skills improve procedures/context; they do not automatically train weights. Only explicit human
feedback should become durable calibration knowledge. Keep profiles isolated to prevent unrelated
job application context or concurrent profile writes contaminating cyber reviews.

## APIs

- Admin POST `/api/admin/cyber`: sourceKey, program, platform, target, source, evidence, offlineOnly=true.
- Agent GET `/api/agent/cyber/:id`: assigned evidence plus recent human feedback.
- Agent POST `/api/agent/cyber/:id/complete`: verdict and markdown result; requires active ownership.
- Admin POST `/api/admin/cyber/:id/review`: outcome and feedback/receipt.
- Admin PUT `/api/admin/cyber/continuous`: enabled boolean.

Existing artifacts lacking a current catalog provenance are skipped, not used to expand scope.
Runner updates now require an acknowledged idle drain before restarting. A run claimed during
the old idle-check/setup race cannot be interrupted by the new updater. Artifact files must be
quiet for two minutes before ingestion to avoid reviewing partially written output.
The CT 134 `bounty-daily.timer` was restored October 13 after deploying an explicit-policy
blacklist, weekly policy cache, one-request-per-second pacing and strict in-scope/out-of-scope
asset filters. Dry-run checks verified that a blacklisted program is rejected and an eligible
program's target list is normalized without sending target requests. The daily timer is enabled;
the next run is scheduled for October 14 at 05:17 UTC. The classifier uses local text patterns,
not Ollama, and may miss policy language it does not recognize; see [Bug bounty lane](BOUNTY.md).
The evidence review queue does not authorize additional testing.
