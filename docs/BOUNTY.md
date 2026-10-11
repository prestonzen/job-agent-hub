# Bug bounty lane

Status 2026-10-11: infrastructure live and smoke-tested. Dark-Moon verified end-to-end against
a local OWASP Juice Shop lab (recon → confirmed finding → finalized report). Pipeline to real
programs still manual.

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

## Scope discipline (hard rules)

1. **Only scan assets explicitly in scope** of a program Preston is enrolled in on
   HackerOne/Bugcrowd, and only programs whose policy permits automated scanning. Read the
   policy first; paste the scope + automation clause into the task before running anything.
2. Honor per-program rate limits; default to `NOISE=low` / `--quick` until a program proves tolerant.
3. No intrusive nuclei templates (default), no DoS classes, no credential brute-forcing beyond
   what the policy allows.
4. Findings are reported through the platform's official channel only; FORMAT=h1 for HackerOne reports.
5. Every run logs to the ClickUp task: target, scope source URL, tool, start/end, findings count.

## Pipeline (manual today, automate later)

1. Pick program (HackerOne/Bugcrowd account — creation authorized, contact@prestonzen.com).
2. Extract in-scope domains → `./BugBountyScanner.sh -d <domain> [--quick] -t /opt/tools`
   (or the Docker image with a results volume).
3. Feed interesting live hosts to Dark-Moon with PROGRAM/FOCUS flags.
4. Triage findings (evidence = exact command + raw output), write the report, submit on-platform,
   log payout on the ClickUp task (`Earned` field).

## TODO

- [x] Verify Dark-Moon build finished (`/root/darkmoon-install.log` on CT 134) and smoke-test
      against a deliberately vulnerable lab (e.g. OWASP Juice Shop) before any real target.
      Done 2026-10-11: found + documented a confirmed info-disclosure vuln on the lab; repeatable
      via `bounty/darkmoon-smoke-test.sh`.
- [ ] Telegram notifications for BugBountyScanner (env: telegram_api_key / telegram_chat_id — Ava bot).
- [ ] Program-scope fetcher: build on `arkadiyt/bounty-targets-data` (hourly-updated JSON per
      platform: `data/hackerone_data.json`, `bugcrowd_data.json`, `intigriti_data.json`,
      `yeswehack_data.json` — validated 2026-10-11: 449 H1 programs, 118 paying with wildcard
      scope). Filter paying + automation-tolerant programs → scope list → ClickUp subtasks per
      in-scope domain.
- [ ] Scheduled low-noise re-scans of enrolled programs (hub automation).

## Platforms (accounts live on the runner, all with TOTP via `oathtool`)

HackerOne, Bugcrowd, Intigriti, YesWeHack — credentials in CT 218 `/etc/job-agent-runner/accounts.json`.
Hub tracking: `POST /api/agent/bounty` events (program/scan/finding/report/payout) roll up to the
admin **Bug bounty** tab and the main analytics KPIs.
