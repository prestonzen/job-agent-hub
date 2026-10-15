#!/usr/bin/env bash
# bounty-daily.sh — daily bounty lane routine for CT 134.
#
# 1. Refresh the program queue from bounty-targets-data (hourly-updated upstream).
# 2. Pick the top N not-recently-scanned programs and scan them sequentially at one
#    request per second to keep traffic low and policy limits easy to honor.
#    Programs listed in /opt/bounty/priority.txt (one name per line) are always
#    picked first — regenerate that file from the unscanned backlog as needed.
# 3. Each scan posts its summary to the hub Bug bounty tab.
#
# Run by systemd timer (bounty-daily.timer, bounty-daily-evening.timer) or by hand:
#   ./bounty-daily.sh            # 8 sequential scans
#   TOP=6 ./bounty-daily.sh

set -u
TOP=${TOP:-8}
LOG=/root/bounty-daily.log

echo "=== bounty-daily $(date -u) ===" >> "$LOG"

echo "[1/2] refreshing queue..." | tee -a "$LOG"
python3 /opt/bounty/scope-fetch.py --top 120 >> "$LOG" 2>&1 || { echo "scope refresh failed; refusing stale queue" | tee -a "$LOG"; exit 1; }

# Next N unscanned programs; priority.txt entries come first.
TOP="$TOP" python3 - <<'EOF' > /tmp/bounty-batch.txt
import json, re, time
q = json.load(open("/opt/bounty/queue.json"))["programs"]
safe = lambda s: re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")
try:
    scanned = set()
    for line in open("/opt/bounty/scanned.log"):
        k, ts = line.strip().split("|")
        if time.time() - int(ts) < 7 * 86400:
            scanned.add(k)
except FileNotFoundError:
    pass
import os
top = int(os.environ.get("TOP", "8"))
by_name = {p["program"].strip(): p["program"] for p in q}
picked = []
try:
    for line in open("/opt/bounty/priority.txt"):
        name = line.strip()
        if not name or len(picked) >= top:
            continue
        hit = by_name.get(name) or next((v for k, v in by_name.items() if safe(k) == safe(name)), None)
        if hit and hit not in picked:
            picked.append(hit)
except FileNotFoundError:
    pass
for p in q:
    if len(picked) >= top:
        break
    if p["program"] not in picked and safe(p["program"]) not in scanned:
        picked.append(p["program"])
print("\n".join(picked))
EOF

N=$(grep -c . /tmp/bounty-batch.txt || true)
echo "[2/2] scanning $N programs sequentially" | tee -a "$LOG"
cat /tmp/bounty-batch.txt | tee -a "$LOG" | sed 's/^/  /'

while IFS= read -r PROGRAM; do
  [ -n "$PROGRAM" ] || continue
  bash /opt/bounty/bounty-scan.sh "$PROGRAM" >> "$LOG" 2>&1
done < /tmp/bounty-batch.txt

echo "=== done $(date -u) ===" >> "$LOG"
tail -5 "$LOG"
