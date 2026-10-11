# Jev fast path (browser-use/jev-ultrafast)

Status 2026-10-11: **wired into the runner** as `/opt/job-agent-runner/jev-apply.py` (repo: `runner/jev-apply.py`). Profile: `/etc/job-agent-runner/applicant.json` (example: `runner/applicant.example.json`).

Jev is a browser agent that *chooses* actions (indexed element table → TypeSafe policy → CLICK/TYPE_TEXT/SELECT/SCROLL) instead of generating code. A small OpenAI-compatible model writes field text. Filled a real Greenhouse application's contact fields in ~21 s for pennies, vs. minutes and dollars for a full agent CLI run.

## Setup on the runner (kloud CT 218)

- Repo: `/opt/jev-ultrafast` (uv-managed, Python 3.12)
- Keys: `/etc/job-agent-runner/jev.env` (600) — TypeSafe key + OpenRouter key (`TEXT_MODEL_*`)
- Browser: dedicated Chromium as `jev-chrome.service` (CDP on 127.0.0.1:9222, own profile at `/var/lib/jev/chrome-profile`, DISPLAY :99). Separate from the agents' playwright browser.
- Run anything with: `BU_CDP_URL=http://127.0.0.1:9222 DISPLAY=:99 uv run --env-file /etc/job-agent-runner/jev.env python <script>`

## Hard-won lessons (bake these into the wrapper)

1. **Navigate straight to `#app_form`** for job-boards.greenhouse.io URLs. The Apply button is an in-page anchor; clicking it doesn't change the page fingerprint and Jev's anti-stall guard blocks after 3 no-change clicks.
2. **Say "SCROLL_DOWN" in the goal.** Form fields are only in the action space when visible; the policy needs an explicit scroll instruction for long postings.
3. **Mention cookie banners in the goal** ("accept consent banners first") — OneTrust overlays occlude clicks and get the run BLOCKED otherwise.
4. **Resume upload and password fields are outside Jev's action space** (file/password inputs are filtered out). The wrapper must do both via direct CDP: `DOM.setFileInputFiles` for the resume (proven), `Input.insertText` for sign-in fields, using credentials from `/etc/job-agent-runner/accounts.json`.
5. Verify filled values by reading the DOM after the run; verify submission by the confirmation page, not by the absence of errors.

## Planned integration

`jev-apply.py` wrapper: runner hands it the job (URL, title, core answers from a local profile file, resume path) → Jev fills → wrapper uploads resume via CDP → wrapper clicks submit → verify confirmation → report to hub. Fast-path eligible: Greenhouse/Lever-style standard forms without essay questions (essays stay with the full agents for voice quality). Per-ATS pacing in `worker/src/pacing.ts` still applies — the wrapper claims through the same hub API.

## jev-apply.py usage

```bash
BU_CDP_URL=http://127.0.0.1:9222 DISPLAY=:99 \
  /opt/jev-ultrafast/.venv/bin/python /opt/job-agent-runner/jev-apply.py \
  --url <job-url> --resume <path> [--submit] [--timeout 240]
```

(jev.env must be sourced first: `set -a; . /etc/job-agent-runner/jev.env; set +a`.)

Outcome JSON on stdout: `filled-only` (no --submit), `submitted`, `captcha:<type>` (run form-assist.mjs, inject, resubmit), `email-code` (run inbox-assist.mjs), `needs-agent` (custom required fields/essays — hand to a full agent CLI).

## More hard-won lessons (2026-10-11, second session)

6. **Text model matters.** `inception/mercury-2.5` returns null content under the helper's token cap; `google/gemini-2.5-flash` flakes on mid-form fields. `deepseek/deepseek-chat-v3.1` via OpenRouter (the library's default family) is stable. jev.env: `TEXT_MODEL=deepseek/deepseek-chat-v3.1`.
7. **The stock text helper is brittle**: strict JSON parse, no retry, no fence stripping. Patched in the container copy (`jev_ultrafast/model.py` `field_text`): strips ```json fences, retries once on empty/unparseable content. Local patch — a git pull of /opt/jev-ultrafast will overwrite it.
8. **Greenhouse React deletes the file input after a successful upload** and replaces it with a filename chip. Verify uploads by the *filename appearing in page text*, never by re-querying the input. Relatedly, never use jev's `Browser.evaluate` (StalePage guard) after touching the DOM — use raw `Runtime.evaluate` via `br.call`.
9. **Anti-stall guard ends runs** after 3 no-change actions; the wrapper treats interruption gracefully and still verifies/uploads, reporting `needs-agent` when required fields remain.
