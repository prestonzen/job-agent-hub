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
Scanners and Dark Moon retain their existing schedule/scope. Changes to either require their own
explicit scope controls; this evidence review queue does not authorize additional testing.
