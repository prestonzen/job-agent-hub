# Jev fast path (browser-use/jev-ultrafast)

Status 2026-10-11: **proven on a live Greenhouse form**, not yet wired into the runner.

Jev is a browser agent that *chooses* actions (indexed element table → TypeSafe policy → CLICK/TYPE_TEXT/SELECT/SCROLL) instead of generating code. A small OpenAI-compatible model (Mercury 2.5 via OpenRouter) writes field text. Filled a real Greenhouse application's contact fields in ~21 s for pennies, vs. minutes and dollars for a full agent CLI run.

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
