#!/usr/bin/env python3
"""research-lab.py — Ollama deep-research timesink on the technologies bounty targets run.

Each invocation (cron, every 6 h):

1. Collects finished research runs: takes the local Ollama run's markdown output and feeds
   it into the hub's multi-model cyber review queue (POST /api/admin/cyber,
   sourceKey research:<tech>:<yyyy-ww>) so codex/claude/kimi independently critique the
   hypotheses before anything can reach the report-draft pile.
2. If no research run is in flight, dispatches one new free local Ollama run
   (POST /api/admin/runs) on the highest-coverage technology not researched in the last
   7 days, per /opt/bounty/tech-matrix.json (default-allow programs only).

Research is offline hypothesis generation: the prompt forbids any target contact. Active
validation of a hypothesis goes through the existing scope-gated bounty-engage/Dark-Moon
pipeline after human review. This is the "zero-day lab": many cheap local attempts, with
expensive models reserved for judging which ones deserve real testing.
"""

import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HUB = "https://jobhunter.prestonzen.com"
MATRIX = Path("/opt/bounty/tech-matrix.json")
ALERTS = Path("/opt/bounty/exploit-alerts.jsonl")
STATE = Path("/opt/bounty/research-lab.state.json")
TOKEN = Path("/etc/hub-admin-token").read_text().strip()
HEADERS = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "User-Agent": "curl/8.5.0"}

RESEARCH_GAP = 7 * 86400          # one research pass per technology per week
MAX_RESEARCHED = 40               # rotation window
# Protocols/headers, not products: high coverage but no exploit surface to hypothesize about.
SKIP_TECH = {"hsts", "http/3", "http/2", "tls", "ssl", "ipv6", "dns", "spf", "dmarc"}


def api(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(HUB + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def edb_notes(tech: str) -> str:
    """Known public exploits for this technology from the local Exploit-DB copy, if installed."""
    try:
        out = subprocess.run(["searchsploit", "--json", "-t", tech], capture_output=True, text=True, timeout=30).stdout
        rows = json.loads(out).get("RESULTS_EXPLOIT", [])
    except Exception:
        return "local Exploit-DB copy unavailable"
    if not rows:
        return "no exact-title entries in local Exploit-DB"
    lines = [f"- {r.get('Title', '?')} ({r.get('Date_Published', '?')}, EDB {r.get('EDB-ID', '?')})" for r in rows[:8]]
    return f"{len(rows)} known public exploit(s)/paper(s):\n" + "\n".join(lines)


def recent_alerts(tech: str) -> str:
    if not ALERTS.is_file():
        return "none recorded"
    rx = re.compile(re.escape(tech.split()[0].lower()))
    hits = []
    for line in ALERTS.read_text(errors="replace").splitlines()[-400:]:
        try:
            a = json.loads(line)
        except ValueError:
            continue
        if any(rx.search(t.lower()) for t in a.get("matched_tech", [])):
            hits.append(f"- {a.get('at', '?')[:10]} {a.get('exploit', {}).get('title', '?')} (program: {a.get('program', '?')})")
    return "\n".join(hits[-6:]) if hits else "none recorded"


def tech_coverage(matrix: dict) -> dict[str, dict]:
    """tech -> {programs: set, samples: [(host, tech-as-seen)]}; default-allow programs only."""
    cov: dict[str, dict] = {}
    for p in matrix.get("programs", []):
        if p.get("automation") != "default-allow":
            continue
        for h in p.get("hosts", []):
            for t in h.get("techs", []):
                key = re.sub(r"\s+\d[\w.]*$", "", t).strip()  # fold versions into the product name
                if len(key) < 3 or key.lower() in SKIP_TECH:
                    continue
                entry = cov.setdefault(key, {"programs": set(), "samples": []})
                entry["programs"].add(p["program"])
                if len(entry["samples"]) < 8:
                    entry["samples"].append((h.get("host", "?"), t))
    return cov


def build_prompt(tech: str, entry: dict, edb: str, alerts: str) -> str:
    programs = ", ".join(sorted(entry["programs"])[:12])
    samples = "\n".join(f"  {host}  [{seen}]" for host, seen in entry["samples"])
    return f"""Offline security research task. No target contact: do not browse, scan, or send requests to any host. This is hypothesis generation for authorized bug bounty programs; anything you produce is reviewed by other models and a human before any validation.

Technology under research: {tech}
Seen on {len(entry['programs'])} in-scope, automation-allowed bounty programs: {programs}
Observed instances (host [tech as detected]):
{samples}

Known public exploits (local Exploit-DB): {edb}
Recent exploit-watch intel matches: {alerts}

Produce markdown with these sections:
1. **Attack surface map** — the components/endpoints/configurations of {tech} that historically yield bounty-valid bugs, ranked by expected value.
2. **Hypotheses** — 5 to 10 concrete vulnerability hypotheses for the versions/configurations above. For each: the bug class, why it might exist here, and the *smallest passive or low-impact check* that would confirm or refute it within a standard bug bounty policy.
3. **Exploit sketches** — for the 3 strongest hypotheses, candidate payload or exploit-approach code sketches (clearly marked UNTESTED), with the reasoning behind each step.
4. **Evidence bars** — what proof would turn each hypothesis into a reportable finding, and what would refute it.
5. **Ranking** — order the hypotheses by (likely bounty value x probability) / effort, and say which single one a validator should test first.

Never claim a successful test. Everything here is a hypothesis until the scope-gated validation pipeline confirms it."""


def main() -> None:
    state = json.loads(STATE.read_text()) if STATE.is_file() else {"dispatched": {}, "fed": [], "history": {}}
    changed = False

    # Phase 1: collect finished research runs into the multi-model review queue.
    for tech, rec in list(state["dispatched"].items()):
        if rec.get("fed"):
            continue
        try:
            run = api("GET", f"/api/admin/runs/{rec['run_id']}")
        except Exception as e:
            print(f"[research-lab] run {rec['run_id']} status check failed: {e}", file=sys.stderr)
            continue
        if run.get("status") in ("queued", "running"):
            print(f"[research-lab] {tech}: run {rec['run_id']} still {run['status']}")
            continue
        rec["fed"] = True
        changed = True
        if run.get("status") != "succeeded" or len(run.get("log") or "") < 400:
            print(f"[research-lab] {tech}: run {rec['run_id']} {run.get('status')}; not feeding ({run.get('summary', '')})")
            continue
        week = time.strftime("%Y-%W", time.gmtime(rec["at"]))
        evidence = (
            "RESEARCH HYPOTHESES — offline generation by local Ollama, no target contact was made or is authorized by this item.\n"
            "Assess which hypotheses are worth scope-gated validation; verdict 'draft' only if a hypothesis is concrete enough to become a report after validation.\n\n"
            + run["log"])
        try:
            api("POST", "/api/admin/cyber", {
                "sourceKey": f"research:{re.sub(r'[^a-z0-9]+', '-', tech.lower())}:{week}"[:180],
                "program": f"Tech research: {tech}", "platform": "research",
                "target": tech, "source": f"research-lab CT134 (run {rec['run_id']})",
                "offlineOnly": True, "evidence": evidence[:23000],
            })
            print(f"[research-lab] fed {tech} research (run {rec['run_id']}) into cyber review")
        except Exception as e:
            print(f"[research-lab] enqueue failed for {tech}: {e}", file=sys.stderr)

    # Phase 2: dispatch the next research run when nothing is in flight.
    in_flight = [t for t, r in state["dispatched"].items() if not r.get("fed")]
    if in_flight:
        print(f"[research-lab] still in flight: {', '.join(in_flight)}; nothing new dispatched")
    elif MATRIX.is_file():
        cov = tech_coverage(json.loads(MATRIX.read_text()))
        now = time.time()
        history = state.setdefault("history", {})
        candidates = sorted(
            ((tech, e) for tech, e in cov.items() if now - history.get(tech, 0) > RESEARCH_GAP),
            key=lambda kv: -len(kv[1]["programs"]),
        )[:MAX_RESEARCHED]
        if not candidates:
            print("[research-lab] every known technology was researched this week; idling")
        else:
            tech, entry = candidates[0]
            prompt = build_prompt(tech, entry, edb_notes(tech), recent_alerts(tech))
            try:
                res = api("POST", "/api/admin/runs", {"agent": "ollama", "kind": "prompt", "prompt": prompt})
                run_id = res["runs"][0]["id"]
                state["dispatched"][tech] = {"run_id": run_id, "at": now, "fed": False}
                history[tech] = now
                changed = True
                print(f"[research-lab] dispatched {tech} research as run {run_id} ({len(entry['programs'])} programs)")
            except Exception as e:
                print(f"[research-lab] dispatch failed: {e}", file=sys.stderr)
                sys.exit(1)
    else:
        print("[research-lab] no tech matrix yet; run tech-matrix.py first", file=sys.stderr)

    if changed:
        # Bound state growth: keep the last 60 dispatch records.
        state["dispatched"] = dict(list(state["dispatched"].items())[-60:])
        STATE.write_text(json.dumps(state, indent=1))


if __name__ == "__main__":
    main()
