#!/usr/bin/env python3
"""cyber-dispatch.py — route cyber work to the hub's on-point cyber agents.

Modes:
  report  A validator (Dark-Moon) confirmed a finding: dispatch a prompt run so a
          capable agent drafts the platform-format report and posts it back to the
          hub as a bounty event (kind "report", status "draft").
  matrix  Fire the SAME standardized triage task at several agents so their output
          quality / speed / structure can be compared head to head. Each posts back
          kind "report", status "matrix-<tag>".

Dispatch = hub "prompt run" (POST /api/admin/runs with the hub admin token from
/etc/hub-admin-token). The runner on kloud claims it and runs that agent's CLI
headless. Agents authenticate their bounty post with their own JOBHUNTER_TOKEN env
(set for codex and kimi in the runner config).

Reports are drafts only — Preston reviews before anything is submitted anywhere.
"""

import argparse
import json
import hashlib
import re
from pathlib import Path
import sys
import time
import urllib.request

HUB = "https://jobhunter.prestonzen.com"
ADMIN_FILE = "/etc/hub-admin-token"

REPORT_TMPL = """You are on point for cyber work in Preston Zen's freelance pipeline. An automated validator (Dark-Moon) CONFIRMED a suspected finding on an authorized {platform} bug bounty asset.

Program: {program}
Platform: {platform}
Host: {host}
Suspected finding: {title}

Validator log excerpt:
{excerpt}

Draft a submission-ready {platform} report: title, severity with rationale, reproduction steps, impact, suggested remediation. Then post it to the hub as a bounty event:

curl -s -X POST {hub}/api/agent/bounty -H "Authorization: Bearer $JOBHUNTER_TOKEN" -H "Content-Type: application/json" -d '{{"kind":"report","platform":"{platform}","program":"{program}","target":"{host}","severity":"<your assessment>","status":"draft","title":"<report title>","detail":"<full report in markdown>"}}'

This is a DRAFT for Preston's review only — never submit anything to the platform itself. Print the hub event id when done."""

# One fixed task per scenario, identical for every agent, so results are comparable.
# Each scenario has a deliberate trap: a scary-looking scanner hit that does NOT hold up,
# mixed with quieter findings that do. Calibration (noise rejection) is what we score.
SCENARIOS = [
    # 1: infra noise vs real exposure
    """[+] nuclei: ssl-tls-version-mismatch (info): TLS 1.0/1.1 enabled
[+] nuclei: missing-security-headers (info): X-Frame-Options, CSP absent
[+] nuclei: exposed-git-config (medium): /.git/config readable, contains repo URL + branch
[+] httpx: 200 https://demo.acme-example.com/actuator/env (Spring Boot actuator, unauthenticated)
[+] waybackurls: /api/v1/users?limit=1000 returned JSON with email+role fields in 2024 snapshot""",
    # 2: the nuclei "critical" is the trap (WAF returns 200 on everything); CORS is the real one
    """[+] nuclei: CVE-2021-41773 (critical): Apache path traversal — BUT the host returns HTTP 200 with identical body for every path tested, including /this-path-does-not-exist-12345
[+] httpx: https://demo2.acme-example.com/api/me responds to Origin: https://evil.example with Access-Control-Allow-Origin: https://evil.example AND Access-Control-Allow-Credentials: true
[+] nuclei: s3-bucket-listing (low): assets.acme-example.com allows anonymous LIST, 3 public logo files only
[+] nuclei: swagger-ui-detected (info): /swagger/index.html loads, documents public marketing endpoints only
[+] httpx: login page sets session cookie without Secure flag (site is HTTPS)""",
    # 3: unverified default-cred guess is the trap; sequential invoice IDs are the real lead
    """[+] nuclei: default-login-guess (high): admin panel at /admin "may" accept admin/admin — scanner only matched the login page title, never logged in
[+] waybackurls: /invoice/view?id=1001 through id=1040 all returned 200 PDFs last year; current /invoice/view?id=9999 returns 200 with someone else's invoice when requested without login
[+] nuclei: missing-rate-limit (info): 20 login attempts in 5s, no 429
[+] httpx: /error/debug shows a stack trace with internal paths and "PostgreSQL 13.4" in the banner
[+] nuclei: expired-ssl-cert-on-unused-subdomain (info): old-blog.acme-example.com cert expired 2023, subdomain serves parked page""",
]

MATRIX_TMPL = """Cyber triage benchmark (tag: {tag}). You are one of several agents given the IDENTICAL input; your output is compared for accuracy and usefulness. Triage this synthetic offline scanner fixture (do not contact the host) (program "acme-bugcrowd-demo", host https://demo.acme-example.com):

{scenario}

Use observation IDs obs1 through obs5 in input order. HTTP 200 alone does not prove exposed secrets; historical data is not current evidence. Do not inflate severity or claim validation you have not performed. For EACH observation: verdict (real / false-positive / needs-manual-check), realistic severity for a bug bounty program, one-line why, and the single next validation step. Then rank the three observations most worth reporting and say which ONE you would report first and why. Reply as compact JSON: {{"triage":[...],"ranking":[...],"first_report":"<id>","reason":"..."}}. Post your answer to the hub:

curl -s -X POST {hub}/api/agent/bounty -H "Authorization: Bearer $JOBHUNTER_TOKEN" -H "Content-Type: application/json" -d '{{"kind":"report","platform":"benchmark","program":"cyber-matrix-{tag}","target":"demo.acme-example.com","severity":"medium","status":"matrix","title":"matrix triage {tag}","detail":"<your JSON>"}}'

Print the hub event id when done."""


def post_run(admin: str, agent: str, prompt: str) -> dict:
    req = urllib.request.Request(
        HUB + "/api/admin/runs",
        data=json.dumps({"agent": agent, "kind": "prompt", "task": "cyber", "prompt": prompt}).encode(),
        headers={"Authorization": "Bearer " + admin, "Content-Type": "application/json",
                 "User-Agent": "curl/8.5.0"},  # default python UA gets a 403 from the edge
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mode", choices=["report", "matrix"], required=True)
    p.add_argument("--agents", default="codex", help="comma-separated hub agent ids (codex, kimi, claude, ...)")
    p.add_argument("--program", default="")
    p.add_argument("--platform", default="")
    p.add_argument("--host", default="")
    p.add_argument("--title", default="")
    p.add_argument("--log", help="validator log file; an excerpt goes into the prompt")
    p.add_argument("--tag", default=time.strftime("%Y%m%d-%H%M"), help="matrix batch tag")
    p.add_argument("--scenario", type=int, default=0, help="matrix scenario index; -1 = rotate by day of year")
    a = p.parse_args()

    admin = open(ADMIN_FILE).read().strip()
    if a.mode == "report":
        if not a.log:
            raise ValueError("--log is required: drafts need evidence")
        path = Path(a.log)
        evidence = re.sub(r'\x1b\[[0-9;]*m', '', path.read_text(errors="replace"))[:22000]
        digest = hashlib.sha256((a.program+'\n'+path.name+'\n'+evidence).encode()).hexdigest()
        payload = dict(sourceKey='artifact:'+digest,program=a.program,platform=a.platform,
                       target=a.host,source='CT134:'+str(path),evidence=evidence,offlineOnly=True)
        req=urllib.request.Request(HUB+'/api/admin/cyber',data=json.dumps(payload).encode(),
              headers={'Authorization':'Bearer '+admin,'Content-Type':'application/json','User-Agent':'curl/8.5.0'})
        with urllib.request.urlopen(req,timeout=30) as response:
            print('[dispatch] durable evidence queue:',json.load(response))
        return 0
    agents = [x.strip() for x in a.agents.split(",") if x.strip()]
    state_req = urllib.request.Request(HUB + "/api/admin/autopilot", headers={"Authorization": "Bearer " + admin, "User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(state_req, timeout=30) as response:
        state = json.load(response)
    allowed = {x["agent"] for x in state["agents"] if x.get("online") and x.get("signedIn") is not False
               and x["state"] in ("ready", "idle") and x.get("tasks", {}).get("cyber", False)}
    agents = [agent for agent in agents if agent in allowed]
    if not state["settings"]["enabled"] or not agents:
        print("[dispatch] no enabled, available cyber agent; no task launched")
        return 0
    si = (int(time.strftime("%j")) % len(SCENARIOS)) if a.scenario < 0 else a.scenario % len(SCENARIOS)

    for agent in agents:
        if a.mode == "report":
            excerpt = ""
            if a.log:
                try:
                    excerpt = open(a.log, errors="replace").read()[-3000:]
                except OSError:
                    excerpt = "(log unavailable)"
            prompt = REPORT_TMPL.format(hub=HUB, platform=a.platform, program=a.program,
                                        host=a.host, title=a.title, excerpt=excerpt)
        else:
            prompt = MATRIX_TMPL.format(hub=HUB, tag=f"{a.tag}-s{si + 1}-{agent}", scenario=SCENARIOS[si])
        res = post_run(admin, agent, prompt)
        run_ids = [r.get("id") for r in res.get("runs", [])]
        print(f"[dispatch] {a.mode} -> {agent}: run(s) {run_ids}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
