#!/usr/bin/env python3
"""Rebuild /opt/bounty/priority.txt from the unscanned, allow-listed backlog.

Order: queue.json order (upstream-ranked). Excludes policy-blacklisted
programs and anything the hub already has scan events for."""
import json, re, urllib.request, pathlib

BASE = pathlib.Path("/opt/bounty")
TOKEN = pathlib.Path("/etc/hub-admin-token").read_text().strip()
safe = lambda s: re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")

queue = json.loads((BASE / "queue.json").read_text())["programs"]
bl = json.loads((BASE / "policy-blacklist.json").read_text())
rows = bl.get("programs", bl) if isinstance(bl, dict) else bl
blocked = {(r if isinstance(r, str) else str(r.get("program") or r.get("name") or "")).strip().lower()
           for r in rows}

req = urllib.request.Request("https://jobhunter.prestonzen.com/api/admin/bounty",
    headers={"Authorization": "Bearer " + TOKEN, "User-Agent": "curl/8.5.0"})
with urllib.request.urlopen(req, timeout=30) as r:
    scanned = {p["program"].strip().lower() for p in json.load(r).get("programs", []) if p.get("scans")}

picked, skipped_bl, skipped_done = [], 0, 0
for p in queue:
    name = p["program"].strip()
    if name.lower() in blocked:
        skipped_bl += 1
        continue
    if name.lower() in scanned:
        skipped_done += 1
        continue
    picked.append(name)

(BASE / "priority.txt").write_text("\n".join(picked) + "\n")
print(f"priority.txt rebuilt: {len(picked)} unscanned allow-listed programs "
      f"({skipped_bl} blacklisted, {skipped_done} already scanned skipped)")
print("\n".join(picked[:12]) + ("\n..." if len(picked) > 12 else ""))
