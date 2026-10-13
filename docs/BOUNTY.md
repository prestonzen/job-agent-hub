# Bug bounty lane

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
   full queue, then scan up to 6 not-recently-scanned programs sequentially (`TOP` tunable). Queueing
   all default-allow programs does not increase the number scanned in a run.
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
   and report drafting. Dark-Moon's original evidence stays the same for each independent model
   interpretation. The hub records a per-evidence pass log: enabled Ollama, Kimi, and Claude cyber
   agents review sequentially, with each later pass reading earlier notes and recording agreement,
   disagreement, and next direction. An agent only participates when its existing global and Cyber
   switches permit it; this workflow does not turn Claude on. The final pass becomes the report
   draft or rejection, while all pass results remain visible in the Cyber evidence history. One master
   report template internally (severity, summary, repro steps,
   exact commands + raw output, impact, remediation); rendered per platform on submit
   (HackerOne markdown via FORMAT=h1, Bugcrowd/Intigriti/YesWeHack variants). Reports are always
   reviewed by Preston before submission — nothing auto-submits.
4. Payouts logged as `payout` events → hub analytics. Only a complete report draft triggers
   an Ava review alert; routine evidence saves, scanner finding labels and completed cyber runs
   are silent. Preston reviews the entire draft before any external submission.

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

## Platforms (accounts live on the runner, all with TOTP via `oathtool`)

HackerOne, Bugcrowd, Intigriti, YesWeHack — credentials in CT 218 `/etc/job-agent-runner/accounts.json`.
Hub tracking: `POST /api/agent/bounty` events (program/scan/finding/report/payout) roll up to the
admin **Bug bounty** tab and the main analytics KPIs.
