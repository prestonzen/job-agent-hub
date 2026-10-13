# Model outcomes: local first

Snapshot: 2026-10-13. Three different measurements appear below. A mock form score, a
synthetic security triage score and a production outcome are **not interchangeable**. None
measures job offers or accepted bounty reports yet. The eight security calibration records
are retained for research, but excluded from production bounty analytics.

## Local model choices

| Task | Current evidence | Choice now | Measured real success |
| --- | --- | --- | --- |
| Browser applications | `gemma4:26b` bare loop submitted 3/3 medium mock forms at 0.97 average field accuracy; Hermes also submitted 3/3 at 0.97. On hard mock forms, bare Gemma submitted 2/3 at 0.97 accuracy when submitted. | Gemma 4 26B for browser forms; preserve read-back of masked inputs and human verification. | No model-specific verified employer receipt or hiring rate established by these tests. |
| Email applications | Current local email profile uses Gemma; the observed local email run was cancelled and yielded no sent message. | Gemma provisionally; collect delivery receipts and employer responses before ranking models. | 0 measured local sends in this snapshot; response and interview rates unavailable. |
| Cyber evidence triage | Qwen3-Coder-Next runs in the isolated Hermes cyber profile on Sparky. Its live work is offline triage of Dark Moon/scanner artifacts. | Continue Qwen3-Coder-Next as a trial for structured triage; promote only human-reviewed report quality. | 0 accepted reports and 0 human-reviewed local drafts at this snapshot. A saved triage verdict is not a successful vulnerability report. |
| Sourcing | Qwen3-Coder-Next uses a separate Hermes profile; two local sourcing runs were observed in the 30-day snapshot. | Keep task isolation; judge by verified, unique email leads. | No model comparison with enough labeled outcomes. |

Gemma's mock form benchmark is the strongest local comparative result. Other medium-form
results: Qwen3.6 35B bare 3/3 at 0.90; Qwen3-Coder-Next bare 2/3 at 0.59, Hermes 3/3 at
0.89; GLM 4.7 Flash bare 2/3 at 0.61. Qwen3-Coder-Next bare hard forms submitted 0/3.
These are small synthetic samples (usually three attempts), so percentages describe these
attempts, not expected real-world success. Full setup and per-run data are in
[Local models](LOCAL_MODELS.md) and `scripts/agent-eval/results/`.

## Kimi's late cyber scoring matrix

The Oct 11 matrix used two fictional evidence scenarios per agent. The v1 rubric awards
verdict 50, severity 20, validation plan 20 and first report priority 10. The latest
record per agent and scenario is weighted equally. All agents covered 2 of 3 planned
scenarios, so every rank is provisional.

| Agent label | Mean score /100 | Scenario scores | Coverage | Interpretation |
| --- | ---: | --- | --- | --- |
| Codex | 96 | 96, 96 | 2/3 | Synthetic calibration only. |
| Claude | 83 | 70, 96 | 2/3 | Synthetic calibration only; production Claude switch is off. |
| **Kimi** | **82** | **76, 88** | **2/3** | Kimi's late matrix work was saved as benchmark events even though its run summaries said no work result recorded. |
| Ollama | 73 | 66, 80 | 2/3 | The model was not recorded with these events; do not attribute this score to the later Qwen3-Coder-Next cyber deployment. |

The rubric is implemented in `src/cyber-score.ts`. It rewards cautious interpretation,
conditional severity and concrete validation, but a heuristic text grader cannot establish
whether a real vulnerability exists. The eight original events were exported to a local
research snapshot before the production dashboard stopped exposing `matrix`. No new
benchmark runs were launched for this report.

## Production evidence and success-rate definitions

The Oct 13 30-day Hub snapshot showed Ollama with 20 application claims and 3 **reported**
applications; its dashboard 0.333 success value is an internal completion ratio, not an
employer acceptance or hire rate. Claude, Kimi, Codex and Mistral had 13, 12, 3 and 2
reported applications respectively in that snapshot. Those counts are not verified
submission receipts and are not controlled model comparisons. Cyber had no accepted
reports. No local email sends were recorded. These counts change as the fleet runs.

For decisions, track separate denominators: claimed jobs; submissions with portal or mail
receipts; positive employer replies; interviews; offers; complete draft reports; human
plausible findings; submitted bounty reports; accepted bounty reports. Compare models only
within the same task, eligibility and time window, and attach the actual model/harness
identity to each run. Small or unlabeled samples should show `insufficient data` instead
of a fabricated success percentage.

## Next measurement gate

Keep synthetic calibration outside production analytics. For cyber, review an entire draft
and record a reasoned human outcome before calling it plausible; record a program receipt
before calling it submitted and a platform acceptance before calling it accepted. For
applications and emails, require a submission or delivery receipt, then connect replies
and interviews to that receipt. Model selection can be revisited when those labels exist.
