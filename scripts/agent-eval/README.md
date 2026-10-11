# Agent bake-off: which local model (and harness) fills applications best?

A fake multi-step job application ("Acme Robotics", fictional applicant, no real data) plus a grader, used to compare
(harness, model) pairs on the skill the hub needs: fill a form correctly from a profile and a few rules, without
inventing facts, using a real browser through Playwright MCP.

- `server.py`: the site and grader. Three difficulties: *easy* (one form), *medium* (cookie wall, masked phone and date
  inputs, a Submit button gated on a character counter, a required work-history row), *hard* (adds type-ahead comboboxes
  that only count a click on an option). Traps: a honeypot field, an optional newsletter box, a conditional "Other"
  field, and an essay that may only use the supplied facts. 30 to 34 checks per submission.
- `prompt.txt`: the task and the profile/rules the agent gets (a stand-in for the hub playbook).
- `run.sh <harness> <model>`: one trial, prints a JSON line. Harnesses: `claude` (Claude Code on Ollama's Anthropic API),
  `hermes` (Hermes Agent), `bare` (`bare-agent.mjs`).
- `bare-agent.mjs`: the thinnest useful harness: Ollama `/api/chat` with tools, MCP tools (Playwright), a loop, old tool
  outputs shrunk, a nudge if the model stops early, and a resample when the model emits a malformed tool call.

Run on the box that will run the agents (the runner), pointing `OLLAMA_URL` at the GPU box:

```bash
OLLAMA_URL=http://gpu-box:11434 HARD=medium bash run.sh bare gemma4:26b
```

## Findings (Oct 2026, GB10 / 119 GiB, Ollama 0.40, medium difficulty unless noted)

Score = checks passed / total (0 if nothing was submitted), averaged over trials.

| Harness | Model | Trials submitted | Avg score | Avg time |
|---|---|---|---|---|
| bare | gemma4:26b | 3/3 | 0.97 | 2 min |
| claude (Claude Code) | gemma4:26b | 3/3 | 0.96 | 3 min |
| hermes | gemma4:26b | 3/3 | 0.97 | 6 min |
| bare | qwen3.6:35b-a3b (q4_K_M) | 3/3 | 0.90 | 2.5 min |
| bare | glm-4.7-flash | 2/3 | 0.61 | 2.5 min |
| bare | muse-glimmer:30b | 1/3 | 0.32 | 10 min |
| bare | qwen3:30b-a3b | 0/1 | 0 | timed out |
| bare | gpt-oss:20b | 0 | 0 | malformed tool calls (`??` in arguments, invented tool names) |

- The harness barely changed Gemma's accuracy; it changed speed (bare 2 min, Claude Code 3, Hermes 6) and compatibility:
  Claude Code failed outright on GLM (image content sent to a text-only model) and Qwen3 (never engaged), while the bare loop
  ran every model.
- Every model, harness included, misses the masked phone field the same way (typing `+1 555 010 4477` into a field that
  reformats digits) unless it re-checks what the field shows. That is a model-verification gap, not a harness one.
- The newest GLM models (5.x) are cloud-only on Ollama and too large for a single local box; `glm-4.7-flash` is the local one.
- `qwen3.6:35b-a3b-nvfp4` needs Ollama's MLX runtime, which the Linux build lacks; the GGUF `q4_K_M` build runs.
- Large downloads: never kill `ollama pull` mid-flight and then delete its zero-length `-partial-N` state files; the
  blob finishes with a digest mismatch and has to start over.
