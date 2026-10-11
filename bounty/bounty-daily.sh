#!/usr/bin/env bash
# bounty-daily.sh — daily bounty lane routine for CT 134.
#
# 1. Refresh the program queue from bounty-targets-data (hourly-updated upstream).
# 2. Pick the top N not-recently-scanned programs and scan them IN PARALLEL
#    (default 3 at a time — watch T-Mobile uplink; each scan is rate-limited internally).
# 3. Each scan posts its summary to the hub Bug bounty tab.
#
# Run by systemd timer (bounty-daily.timer) or by hand:
#   ./bounty-daily.sh            # 3 parallel scans
#   PARALLEL=5 TOP=6 ./bounty-daily.sh

set -u
PARALLEL=${PARALLEL:-3}
TOP=${TOP:-6}
LOG=/root/bounty-daily.log

echo "=== bounty-daily $(date -u) ===" >> "$LOG"

echo "[1/2] refreshing queue..." | tee -a "$LOG"
python3 /opt/bounty/scope-fetch.py --top 60 >> "$LOG" 2>&1

# Next N unscanned programs.
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
top = int(os.environ.get("TOP", "6"))
picked = [p["program"] for p in q if safe(p["program"]) not in scanned][:top]
print("\n".join(picked))
EOF

N=$(grep -c . /tmp/bounty-batch.txt || true)
echo "[2/2] scanning $N programs, $PARALLEL at a time" | tee -a "$LOG"
cat /tmp/bounty-batch.txt | tee -a "$LOG" | sed 's/^/  /'

export -f 2>/dev/null || true
cat /tmp/bounty-batch.txt | xargs -P "$PARALLEL" -I {} sh -c 'bash /opt/bounty/bounty-scan.sh "{}" >> /root/bounty-daily.log 2>&1'

echo "=== done $(date -u) ===" >> "$LOG"
tail -5 "$LOG"
