#!/usr/bin/env python3
"""tech-matrix.py — build the "who runs what" technology matrix from recon output.

Reads every /root/bbscans/<program>/live.txt (httpx -tech-detect lines), parses each
host's stack, and writes /opt/bounty/tech-matrix.json — the local store exploit-watch.py
matches new Exploit-DB/KEV entries against and research-lab.py prioritizes from.
The same data is pushed to the hub (POST /api/admin/bounty-tech), which keeps it in D1
(table bounty_hosts) and renders the Bug bounty tab's technology stats.

Only programs with queue provenance are included; the policy decision from
policy-audit.json rides along so downstream matching can stay default-allow-only.

Usage:  python3 tech-matrix.py [--no-push]
"""

import json
import re
import sys
import time
import urllib.request
from pathlib import Path

HUB = "https://jobhunter.prestonzen.com"
SCANS = Path("/root/bbscans")
QUEUE = Path("/opt/bounty/queue.json")
AUDIT = Path("/opt/bounty/policy-audit.json")
OUT = Path("/opt/bounty/tech-matrix.json")
TOKEN_FILE = Path("/etc/hub-admin-token")

ANSI = re.compile(r"\x1b\[[0-9;]*m")
# httpx -status-code -title -tech-detect: url [status] [title?] [techs?] — bracket groups
# in fixed order, empty fields omitted. The tech group is the last one; with only two
# groups it is techs when it looks like a stack list, otherwise a title.
TECH_HINT = re.compile(
    r"cloudflare|nginx|apache|iis|wordpress|drupal|joomla|laravel|django|rails|react|vue|angular|"
    r"jquery|bootstrap|php|asp\.net|node\.js|express|next\.js|nuxt|tomcat|jetty|weblogic|jboss|"
    r"spring|struts|graphql|kubernetes|docker|jenkins|gitlab|grafana|prometheus|elastic|kibana|"
    r"redis|mongo|mysql|postgres|oracle|sap|salesforce|shopify|magento|woocommerce|squarespace|"
    r"wix|webflow|akamai|fastly|cloudfront|incapsula|imperva|sucuri|varnish|haproxy|envoy|"
    r"openresty|gunicorn|unicorn|puma|phusion|caddy|lighttpd|traefik|istio|linkerd|consul|"
    r"vault|okta|auth0|ping|forgerock|keycloak|cas|saml|oauth|openid|jwt|http/2|http/3|"
    r"websocket|socket\.io|signalr|blazor|svelte|ember|backbone|polymer|lit|stimulus|turbo|"
    r"htmx|alpine|tailwind|bulma|foundation|material|antd|chakra|mui|semantic|font awesome|"
    r"google analytics|tag manager|segment|mixpanel|amplitude|hotjar|sentry|datadog|new relic|"
    r"stripe|paypal|braintree|adyen|recaptcha|hcaptcha|turnstile|onesignal|firebase|supabase",
    re.I,
)


def parse_live(text: str) -> list[dict]:
    hosts = []
    for line in text.splitlines():
        line = ANSI.sub("", line).strip()
        if not line:
            continue
        m = re.match(r"^(\S+)\s*(.*)$", line)
        if not m:
            continue
        url, rest = m.group(1), m.group(2)
        groups = re.findall(r"\[([^\]]*)\]", rest)
        status = None
        if groups and groups[0].strip().isdigit():
            status = int(groups.pop(0))
        techs: list[str] = []
        title = ""
        if len(groups) >= 2:
            title, tech_raw = groups[0], groups[-1]
            techs = [t.strip() for t in tech_raw.split(",") if t.strip()]
        elif len(groups) == 1:
            if "," in groups[0] or TECH_HINT.search(groups[0]):
                techs = [t.strip() for t in groups[0].split(",") if t.strip()]
            else:
                title = groups[0]
        hosts.append({"host": url, "status": status, "title": title[:200], "techs": techs[:40]})
    return hosts


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")


def main() -> None:
    push = "--no-push" not in sys.argv
    queue = json.loads(QUEUE.read_text())["programs"] if QUEUE.is_file() else []
    by_safe = {safe(p["program"]): p for p in queue}
    audit = {}
    if AUDIT.is_file():
        try:
            audit = json.loads(AUDIT.read_text())
        except ValueError:
            audit = {}

    programs = []
    for folder in sorted(SCANS.iterdir()):
        live = folder / "live.txt"
        if not folder.is_dir() or not live.is_file():
            continue
        q = by_safe.get(folder.name)
        if not q:
            continue  # no provenance to a scoped program (same rule as cyber-feed.py)
        audit_row = next((a for k, a in audit.items() if k.endswith("|" + q["program"].strip().lower())), None)
        hosts = parse_live(live.read_text(errors="replace"))
        if not hosts:
            continue
        programs.append({
            "program": q["program"],
            "platform": q.get("platform", "unknown"),
            "automation": (audit_row or {}).get("decision", "unknown"),
            "hosts": hosts,
        })

    matrix = {"generated": time.time(), "programs": programs}
    OUT.write_text(json.dumps(matrix, indent=1))
    OUT.chmod(0o644)

    tech_programs: dict[str, set] = {}
    host_total = 0
    for p in programs:
        host_total += len(p["hosts"])
        for h in p["hosts"]:
            for t in h["techs"]:
                tech_programs.setdefault(t, set()).add(p["program"])
    top = sorted(tech_programs.items(), key=lambda kv: -len(kv[1]))[:15]
    print(f"[tech-matrix] {len(programs)} programs, {host_total} hosts, {len(tech_programs)} distinct technologies")
    for tech, progs in top:
        print(f"  {len(progs):3d} programs  {tech}")

    if not push:
        return
    if not TOKEN_FILE.is_file():
        print("[tech-matrix] no hub token; local matrix only", file=sys.stderr)
        return
    body = json.dumps({"programs": [{"program": p["program"], "platform": p["platform"], "hosts": p["hosts"]} for p in programs]}).encode()
    req = urllib.request.Request(HUB + "/api/admin/bounty-tech", data=body, headers={
        "Authorization": "Bearer " + TOKEN_FILE.read_text().strip(),
        "Content-Type": "application/json",
        "User-Agent": "curl/8.5.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print("[tech-matrix] hub ingest:", r.read().decode()[:200])
    except Exception as e:
        print(f"[tech-matrix] hub push failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
