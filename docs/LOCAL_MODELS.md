# Local models for job applications: which model, and do you need an agent harness?

Job Agent Hub runs one agent on a home GPU box (an NVIDIA GB10 "DGX Spark" class machine, 119 GiB unified memory)
using open-weight models served by Ollama. This page records what was measured when picking that model, so the
choice is evidence rather than taste. It is written for three audiences: people evaluating this project, people
building something similar, and applicants who want to know how far a free local model gets on a real form.

This page measures **mock form completion and field accuracy**, not real employer submissions,
responses, interviews or offers. For current local cyber and email evidence, Kimi's synthetic
scoring matrix and production outcome definitions, see [Model outcomes](MODEL-OUTCOMES-2026-10-13.md).

**Short answer (Oct 2026):**

| Question | Answer |
|---|---|
| Which local model? | **`gemma4:26b`** (18 GB, runs well on one box). Highest and most consistent score of everything tested, including the 51 GB `qwen3-coder-next`. |
| Do you need a harness? | **No for accuracy, yes for operations.** A bare "model + browser tools + loop" scored the same as Claude Code and Hermes. We still run **Hermes Agent** in production because it adds memory and skill learning, and it was the only harness that finished a perfect run. |
| Is it as good as a frontier cloud model? | No. Expect roughly 97% of form fields right on a medium form and a miss on tricky masked inputs. Everything else here is cheaper, not smarter. |
| Anything that failed outright? | `gpt-oss:20b` (malformed tool calls), `qwen3:30b-a3b` (never finished), `muse-glimmer:30b` (slow, mostly timed out). |

## How it was measured

`scripts/agent-eval/` contains a fake multi-step application site ("Acme Robotics", a fictional applicant, no real
data) and a grader. The agent gets the same browser tools it would use in production (Playwright MCP) and the same
kind of instructions (a profile plus rules). The grader checks 30 to 34 things per submission and the score is
`checks passed / total`, with **0 if nothing was submitted**.

Difficulty levels:

- **medium**: cookie wall, masked phone and date inputs that reformat what you type, a Submit button gated behind a
  character counter, a required work-history row.
- **hard**: medium plus type-ahead comboboxes that only register a click on a suggestion.

Traps that catch sloppy agents: a hidden honeypot field (must stay empty), an optional newsletter box (must stay
unchecked), a conditional "Other" field, and a cover note that may only use supplied facts (no invented numbers or
employers).

Each configuration ran 3 times (1 for models that failed at once). **Samples are small; read the numbers as
direction, not as precision.** Speed did not matter for the decision: the agent runs 24/7 on a queue.

## Results

### Medium difficulty

| Harness | Model | Submitted | Avg score | Perfect runs | Avg time |
|---|---|---|---|---|---|
| bare loop | **gemma4:26b** | 3/3 | **0.97** | 0/3 | 2 min |
| Claude Code | gemma4:26b | 3/3 | 0.96 | 0/3 | 3 min |
| Hermes | gemma4:26b | 3/3 | **0.97** | 1/3 | 6 min |
| bare loop | qwen3.6:35b-a3b (q4_K_M) | 3/3 | 0.90 | 0/3 | 2.5 min |
| bare loop | qwen3-coder-next (80B MoE, 51 GB) | 2/3 | 0.59 | 0/3 | 4 min |
| Hermes | qwen3-coder-next | 3/3 | 0.89 | 0/3 | 8 min |
| bare loop | glm-4.7-flash | 2/3 | 0.61 | 0/3 | 2.5 min |
| bare loop | muse-glimmer:30b | 1/3 | 0.32 | 0/3 | 10 min |
| bare loop | qwen3:30b-a3b | 0/1 | 0 | 0/1 | timed out at 20 min |
| bare loop | gpt-oss:20b | 0 | 0 | 0 | malformed tool calls every time |

### Hard difficulty (type-ahead comboboxes)

| Harness | Model | Submitted | Score when submitted | Avg time |
|---|---|---|---|---|
| bare loop | **gemma4:26b** | 2/3 (third hit the 15-minute limit) | 0.97 (33 of 34 checks; only the masked phone missed) | 4 to 8 min |
| bare loop | qwen3.6:35b-a3b | 0/2 | none submitted | stopped at 6 min, never finished |

On the hard form Gemma still filled everything correctly when it finished; Qwen3.6 did not complete the type-ahead
fields in either run. Raw per-run data is in [`scripts/agent-eval/results/`](../scripts/agent-eval/results/).

`qwen3-coder-next` (bare loop, hard form): 0/3 submitted. In the run inspected it clicked the same suggestion 80 times
without progressing.

`qwen3-coder-next` summary: slower to load and behind Gemma in both harnesses. It filled the honeypot trap field once,
missed the demographic radio group once, and in the bare loop one run of three never submitted. Under Hermes it
recovered to 0.89 (3/3 submitted), the best of the other models, but still below Gemma's 0.97.

Not tested: `gpt-oss:120b` (65 GB, judged too large and slow for a shared box); its download was stopped.

## What the data says

1. **The model matters far more than the harness.** Gemma scored 0.96 to 0.97 in all three harnesses. Swapping
   models moved the score from 0.97 down to 0.32 or zero. Spend the evaluation effort on models.
2. **A harness changes speed and compatibility, not accuracy.** Same model: bare loop 2 min, Claude Code 3, Hermes 6.
   Claude Code could not drive GLM (it sent images to a text-only model) or Qwen3 (never engaged); the bare loop
   ran every model. A harness is a compatibility risk as much as a help.
3. **Why Hermes anyway.** It is slower, but it keeps memory and learns reusable skills between runs (the thing a
   24/7 queue benefits from over weeks), and it produced the only perfect run. If a different harness shows a
   higher success rate for these local models, that is the one worth switching to; none has so far.
4. **The universal miss is verification, not intelligence.** Nearly every run, every model, typed the phone number
   into a masked field and did not re-read what the field actually showed. The fix is a prompt rule ("after typing
   into any masked field, read the value back and correct it"), not a bigger model.
5. **"Can call tools" is not the same as "can drive a browser for 40 steps".** `gpt-oss:20b` and `qwen3:30b-a3b`
   advertise tool use but produced malformed calls or stalled. Only an end-to-end test showed that.
6. **Newest is not always runnable.** GLM 5.x is cloud-only on Ollama and too large for one box; the local option is
   `glm-4.7-flash`. `qwen3.6:35b-a3b-nvfp4` needs Ollama's MLX runtime, which the Linux build does not have, so the
   GGUF `q4_K_M` build was used.

## How the local agent is deployed

- The **browser and harness run on a small always-on server** (a US IP, which job sites prefer), and call the GPU box's
  Ollama API over the private network. The GPU box only serves the model.
- A **GPU gate** (`runner/gpu-gate.mjs`) pauses the agent and unloads the model whenever a ComfyUI / video render is
  queued, so image and video generation always win.
- The agent claims jobs from the same queue as the cloud agents and obeys the same pacing rules.

## Emailed verification codes (Greenhouse)

About one in five Greenhouse forms emails an 8-character code after Submit. Whether a code is sent cannot be known
before submitting, so it cannot be pre-checked. What the system guarantees:

- **One Greenhouse application at a time** (with a randomised gap of 4 to 7 minutes and 15 per day), so the newest code
  in the inbox always belongs to the application in progress. Codes never collide.
- **Every runner agent reads the code itself.** `runner/inbox-assist.mjs` polls the applicant inbox (read-only Gmail
  access) and returns the code; all agents on the runner, including the local Ollama one, are told to use it first.
- **Fallback:** if the helper finds nothing, the agent asks for the code over Telegram (`request_code` /
  `wait_for_code`, up to 20 minutes) instead of guessing or abandoning the form.

What is *not* guaranteed: that Greenhouse sends a code for a given form (it is a risk-based check) or that it arrives
within the helper's 90-second wait.

## Reproduce it

```bash
cd scripts/agent-eval
OLLAMA_URL=http://gpu-box:11434 HARD=medium bash run.sh bare gemma4:26b
OLLAMA_URL=http://gpu-box:11434 HARD=medium bash run.sh hermes gemma4:26b
```

See [`scripts/agent-eval/README.md`](../scripts/agent-eval/README.md) for the kit and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for how the agent fits into the hub.
