# Bug bounty lane

Status 2026-10-11: infrastructure provisioned, pipeline not yet automated end-to-end.

Part of the Job Agent Hub's "find work of all types" mandate: bounty payouts count as income
alongside jobs, contracts and freelance platforms. ClickUp parent task: "HackerOne / Bugcrowd"
(868mdj1hm, tag `bounty`).

## Boxes (kloud Proxmox)

| Piece | Where | What |
| --- | --- | --- |
| BugBountyScanner | CT 134 `/opt/BugBountyScanner` + Docker image `chvancooten/bugbountyscanner` | Headless recon: subdomain enum, live hosts, nuclei (CVEs/misconfigs), wayback endpoints, port scan, screenshots. `--quick` for opsec-light runs. |
| Dark-Moon | CT 134 `/opt/Dark-Moon` (`./darkmoon.sh`) | Autonomous AI pentest over MCP-gated Docker toolbox. Bug bounty mode: `./darkmoon.sh " TARGET: <host> PROGRAM=\"<name>\" FOCUS=sqli,xss,idor NOISE=moderate FORMAT=h1 "`. LLM: OpenRouter (`.opencode.env`, currently `deepseek/deepseek-chat-v3.1`; bump to a frontier model for hard targets). |

CT 134 is Kali Rolling, nesting enabled, Docker 28 + Compose 2.40, 35 GB disk, 8 vCPU / 8.5 GB RAM.
Egress is the host's T-Mobile residential IP; route through CT 125's proxy (see runner config
`proxy` section) only if a program's rate limits require it.

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

- [ ] Verify Dark-Moon build finished (`/root/darkmoon-install.log` on CT 134) and smoke-test
      against a deliberately vulnerable lab (e.g. OWASP Juice Shop) before any real target.
- [ ] Telegram notifications for BugBountyScanner (env: telegram_api_key / telegram_chat_id — Ava bot).
- [ ] Program-scope fetcher: HackerOne API → scope list → ClickUp subtasks per in-scope domain.
- [ ] Scheduled low-noise re-scans of enrolled programs (hub automation).
