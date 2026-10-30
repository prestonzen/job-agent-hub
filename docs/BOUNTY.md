# Bug bounty lane

Status 2026-10-15 (ops update): the 2026-10-14 05:17 UTC run hung ~14 h inside the KAYAK
scan (nuclei, no file output since 19:49 UTC) and blocked the 10-15 trigger. Fixed: hung
container killed; `bounty-scan.sh` docker run wrapped in `timeout 3600` (60 min/program cap);
unit got `TimeoutStartSec=12h`; daily batch raised TOP 6 → 8; a second timer
`bounty-daily-evening.timer` (17:23 UTC) doubles throughput; queue refresh widened
`--top 60` → `--top 120`; a curated `/opt/bounty/priority.txt` (committed copy in
`bounty/priority.txt`) is always scanned first — currently the 12 largest unscanned
programs by asset footprint (MercadoLibre, Dyson, Twilio, Logitech, Bumble, Reddit,
PlayStation, Valve, Netflix, Bykea, GitLab, KOHO). New: `exploit-watch.py` +
`exploit-feed.timer` (hourly) match fresh Exploit-DB RSS items and newly added CISA KEV
entries against scanned programs' httpx tech-detect; matches enqueue intel-only items to the
hub cyber review queue (sourceKey `intel:*`). Historical KEV (1745 items) seeded as seen on
first run. On-CT218 tooling note: `form-assist.mjs` now supports reCAPTCHA Enterprise
(`enterprise=1`, auto-detect of Ashby key `6LezdY0t…`, proper `proxytype`); the Ashby key
still returns ERROR_CAPTCHA_UNSOLVABLE from 2captcha (verified 2026-10-15). `socks5relay.py`
on CT218 (127.0.0.1:11080) relays to the CT125 proxy but does NOT change egress — CT218 and
CT125 share the same T-Mobile IP (172.56.242.28).

Status 2026-10-13: Dark-Moon passed a local OWASP Juice Shop lab smoke test. The CT 134
`bounty-daily.timer` is enabled after deployment and dry-run verification of the explicit-policy
blacklist and strict asset-scope filter. Its next run is scheduled for 2026-10-14 05:17 UTC.
Historical scanner events are leads, not validated findings or accepted reports.

Part of the Job Agent Hub's "find work of all types" mandate: bounty payouts count as income
alongside jobs, contracts and freelance platforms. ClickUp parent task: "HackerOne / Bugcrowd"
(868mdj1hm, tag `bounty`).

## Boxes (kloud Proxmox)

| Piece | Where | What |
| --- | --- | --- |
| BugBountyScanner | CT 134 `/opt/BugBountyScanner` + Docker image `chvancooten/bugbountyscanner` | Headless recon: subdomain enum, live hosts, nuclei (CVEs/misconfigs), wayback endpoints, port scan, screenshots. `--quick` for opsec-light runs. |
| Dark-Moon | CT 134 `/opt/Dark-Moon` (`./darkmoon.sh`) | Autonomous AI pentest over MCP-gated Docker toolbox. Bug bounty mode: `./darkmoon.sh " TARGET: <host> PROGRAM=\"<name>\" FOCUS=sqli,xss,idor NOISE=moderate FORMAT=h1 "`. LLM: OpenRouter (`.opencode.env`, currently `deepseek/deepseek-chat-v3.1`; bump to a frontier model for hard targets). |

CT 134 is Kali Rolling, nesting enabled, Docker 28 + Compose 2.40, 60 GB disk, 8 vCPU / 8.5 GB RAM.
Egress is the host's T-Mobile residential IP; route through CT 125's proxy (see runner config
`proxy` section) only if a program's rate limits require it.

## Regression test

`bounty/darkmoon-smoke-test.sh` (deployed at `/opt/darkmoon-smoke-test.sh` on CT 134) boots a
local OWASP Juice Shop container, runs Dark-Moon against it with a smoke-test scope, and asserts
the full pipeline: LLM reachable, recon executes, ≥1 confirmed finding, campaign finalized with a
report. Exits 0 = PASS. Run it after any Dark-Moon update, model change, or Docker rebuild before
pointing the stack at a real program:

```bash
ssh root@kloud "pct exec 134 -- sh /opt/darkmoon-smoke-test.sh"
```

## Scope discipline

1. **Only scan assets explicitly in scope** in the public program catalog, honoring its
   out-of-scope exceptions. Wildcards may be enumerated; exact hosts and URLs do not expand.
2. Honor stated rate limits; default to one request per second. Never run DoS, brute-force,
   or intrusive templates.
3. No intrusive nuclei templates (default), no DoS classes, no credential brute-forcing beyond
   what the policy allows.
4. Findings are reported through the platform's official channel only; FORMAT=h1 for HackerOne reports.
5. Every run logs to the ClickUp task: target, scope source URL, tool, start/end, findings count.

## Pipeline and policy gate

1. **Queue** — `bounty/scope-fetch.py` pulls the four public catalogs and checks policy pages for
   every paying program with scannable in-scope web assets before ranking all default-allow programs.
   The complete eligible backlog (552 at the latest review; count changes as catalogs and policies change)
   stays in `/opt/bounty/queue.json`. A seven-day
   cache avoids redundant reads. Only clauses explicitly
   prohibiting automated/AI scanning (including human-supervision or prior-approval requirements
   the unattended scanner cannot satisfy) enter `/opt/bounty/policy-blacklist.json`. Everything
   else follows the requested default-allow rule and may enter `/opt/bounty/queue.json`; a rule
   that rejects scanner-only reports is not treated as a scan ban. `policy-audit.json` stores the
   latest evidence, check time, source URL and content hash. The classifier is local text matching;
   it does not currently use Ollama, and policy wording outside its patterns can be missed.
2. **Daily scans** — `bounty-daily.timer` (05:17 UTC) runs `bounty/bounty-daily.sh`: refresh the
   full queue, then scan up to 12 not-recently-scanned programs with up to `PAR=6` scanner
   containers in flight (`TOP`/`PAR` tunables; a `flock` skips overlapping batches). Containers
   always work different companies, so per-target rate stays 1 req/s (`SCAN_RPS=1` each) while
   wall-clock drops ~4x. Per-program logs fold back into `/root/bounty-daily.log` in batch order.
   Queueing all default-allow programs does not increase the number scanned in a run.
   Each scan (`bounty/bounty-scan.sh`): subfinder → httpx → nuclei (non-intrusive, rate-limited),
   posts a summary event to the hub (`POST /api/admin/bounty-events`) → admin
   **Bug bounty** tab. CT 134 authenticates as a service; these events are attributed to
   `bounty-pipeline`, not an AI agent.
   Programs re-scan at most every 7 days. The daily script refuses a failed queue refresh; the
   scanner refuses rows that are explicitly blacklisted or not marked `default-allow`. It applies
   the program's exact in-scope and out-of-scope rules again before probing targets, httpx results,
   historical URLs and nuclei inputs. Each tool is limited to one request per second. These checks
   cannot detect every policy nuance or every program-specific requirement; blacklist additions
   should be reviewed when policy pages change.
3. **Validation + report** — anything above info level goes to Dark-Moon for exploitation-proof
   and report drafting; the engage script posts a `verifying` event up front ("Possible bounty
   found — verifying", silent ping) and the confirmed/refuted verdict when it exits. Confirmed
   evidence enters the cyber review queue. Revised 2026-10-24: the multi-model jury is replaced
   by **one authoritative pass** — the strongest enabled cyber agent (Claude first, then
   Codex/Kimi/…) is the sole decider; its verdict stands without cross-checks. A `draft` verdict
   posts the full report into the Telegram Bug Bounty topic (header + .md attachment) and waits
   for Preston's reply: **yes** publishes it (HackerOne via API; Bugcrowd via a browser
   submission run on the runner's logged-in session; other platforms stay manual), **no** rejects
   it. Replies work two ways: reply `yes`/`no` to the report's header message, or `#<id> yes/no`
   anywhere in the topic. Inbound is polled from runner heartbeats, admins only. One master
   report template internally (severity, summary, repro steps,
   exact commands + raw output, impact, remediation); rendered per platform on submit
   (HackerOne markdown via FORMAT=h1, Bugcrowd/Intigriti/YesWeHack variants). Nothing
   self-submits: publication requires Preston's explicit Telegram yes.
4. **Idle deep-dive fallback** (2026-10-26) — when no evidence is waiting and a cyber agent is
   free, the hub dispatches a passive deep-dive on one scanned program: the agent reads only
   archive.org (CDX URL harvest + archived JS snapshots) and the hub's host list for that
   program, writes up to 3 concrete UNTESTED hypotheses, and posts them into the review queue
   (`deepdive:<program>:<week>:*` keys via the agent enqueue endpoint). Zero live target
   contact; validation of any hypothesis still goes through scope-gated Dark-Moon. One program
   per 2-hour cooldown, each program at most once per ISO week, rotating by least-recent scan.
5. Payouts logged as `payout` events → hub analytics. Only a complete report draft triggers
   an Ava review alert; routine evidence saves, scanner finding labels and completed cyber runs
   are silent. Preston reviews the entire draft before any external submission.

Methodology standards (2026-10-30) are adapted from the public
[mdpsec/bug-bounty-hunting-prompts](https://github.com/mdpsec/bug-bounty-hunting-prompts)
pack (credit: @mdp_sec): the reviewer prompt carries its phase-06/07 triage gates (So-What
test, IDOR two-precondition rule, hardening-miss bar, credential-liveness exception,
prerequisite-first handling, external-only SSRF rejection), the idle deep-dive carries a
phase-02-derived class checklist, and the Dark-Moon engage carries its bounded-proof and
negative-control validation standards. Its live-contact phases (recon browser fleets,
auto-submission) are deliberately not adopted: agents never touch targets outside the
scope-gated Dark-Moon lane, and submission stays human-gated.

**Bounded self-registration** (2026-10-30, human-authorized): authenticated validation needs
researcher-owned test accounts, so the Dark-Moon engage lane may self-register up to 2 accounts
per program (`bounty/registration-policy.json`; `deny` list opts a program out). Registration
uses plus-addressed applicant inboxes (`contact+bb-<program>-a@prestonzen.com`), the runner
helpers deployed to CT 134 (`form-assist.mjs` for signup captchas via 2Captcha,
`inbox-assist.mjs` for emailed verification codes/links against the read-only Gmail OAuth), and
accounts are stored per-program at `/opt/bounty/sensitive/accounts/<program>.json` (mode 700,
never embedded in prompts or reports). Phone/payment/KYC walls or an unsolvable captcha mean
blocked, not refuted. Requires a valid Gmail refresh token in CT 134's
`/etc/job-agent-runner/config.json` (gmail + captcha sections only).

## Technology matrix & research lab

- **Matrix build** — `bounty/tech-matrix.py` (CT 134, cron every 6 h) parses every scanned
  program's httpx tech-detect output into `/opt/bounty/tech-matrix.json` (local source of truth)
  and pushes it to the hub (`POST /api/admin/bounty-tech` → D1 `bounty_hosts`, one row per
  program+host, rescan replaces the program's rows). The Bug bounty tab renders it: top
  technologies by program coverage and host count, plus a Stack column per program. First
  ingest (2026-10-20): 27 programs, 430 hosts, 123 distinct technologies — AWS, Cloudflare
  and Nginx dominate the surface.
- **Exploit matching** — `bounty/exploit-watch.py` matches fresh Exploit-DB RSS + CISA KEV
  entries against the parsed matrix (per-host tech strings, not raw scan text), so new public
  exploits land in the cyber review queue tagged with the exact in-scope hosts running that
  stack. A local Exploit-DB copy (`searchsploit`) on CT 134 adds full-history lookups.
- **Research lab** — `bounty/research-lab.py` (CT 134, cron every 6 h) is the Ollama timesink:
  when no research run is in flight it dispatches one free local Ollama run on the
  highest-coverage default-allow technology not researched in the last 7 days (attack-surface
  map, 5–10 vulnerability hypotheses, UNTESTED exploit sketches, evidence bars, ranking —
  protocol/header entries like HSTS are skipped as having no exploit surface). When the run
  finishes, its output is fed into the cyber review queue
  (`sourceKey research:<tech>:<week>`, platform `research`) for the single-authoritative-pass
  review; only concrete, validated hypotheses can become report drafts. Nothing contacts a target:
  validation stays behind the scope-gated bounty-engage/Dark-Moon pipeline and human review.

On 2026-10-13 the existing queue contained 60 programs with automation marked `unspecified`,
and the timer had already recorded low-noise scans of real company assets. That did not establish
policy compliance. The timer was stopped immediately. Synthetic matrix events, a `Pipeline Test`
event, account enrollments and a recon probe are excluded from production bounty analytics but
retained in source history. See [model outcomes](MODEL-OUTCOMES-2026-10-13.md) for the separate
calibration data and limits of the current results.

## TODO

- [x] Verify Dark-Moon build finished (`/root/darkmoon-install.log` on CT 134) and smoke-test
      against a deliberately vulnerable lab (e.g. OWASP Juice Shop) before any real target.
      Done 2026-10-11: found + documented a confirmed info-disclosure vuln on the lab; repeatable
      via `bounty/darkmoon-smoke-test.sh`.
- [x] Telegram notifications — revised 2026-10-13: notify on complete cyber report drafts and
      payouts; routine evidence saves, run completions and scanner labels remain in the hub.
- [x] Program-scope fetcher: built on `arkadiyt/bounty-targets-data` (hourly-updated JSON per
      platform: `data/hackerone_data.json`, `bugcrowd_data.json`, `intigriti_data.json`,
      `yeswehack_data.json` — validated 2026-10-11). `bounty/scope-fetch.py` normalizes all 4
      schemas, checks program policies against the explicit-ban patterns, records its blacklist
      and audit, merges cross-platform dupes, then ranks remaining programs → `/opt/bounty/queue.json`.
- [x] Explicit-policy gate and strict asset scope deployed/tested on CT 134 on 2026-10-13;
      daily timer enabled. Test runs did not send target requests.
- [x] Low-noise scan plumbing and timer created; only report drafts are sent for human review.
- [ ] Per-platform report renderers for Bugcrowd / Intigriti / YesWeHack (Dark-Moon emits H1
      markdown today; one master template internally, render at submission time).
- [ ] Prioritize queue by historical payout speed (H1 dumps carry avg time-to-bounty stats).
- [x] Technology matrix + research lab (2026-10-20): see "Technology matrix & research lab".
- [ ] Version-precise matching: httpx tech-detect versions are partial; consider wappalyzer
      CLI or favicon hashes for tighter exploit-to-version matching.

## Platforms (accounts live on the runner, all with TOTP via `oathtool`)

HackerOne, Bugcrowd, Intigriti, YesWeHack — credentials in CT 218 `/etc/job-agent-runner/accounts.json`.
Hub tracking: `POST /api/agent/bounty` events (program/scan/finding/report/payout) roll up to the
admin **Bug bounty** tab and the main analytics KPIs.
