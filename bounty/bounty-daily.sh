#!/usr/bin/env bash
# bounty-daily.sh — daily bounty lane routine for CT 134.
#
# 1. Refresh the program queue from bounty-targets-data (hourly-updated upstream).
# 2. Pick the top N not-recently-scanned programs and scan them with up to PAR
#    concurrent scanner containers (default 6). Per-target politeness is unchanged:
#    each container stays at SCAN_RPS=1 and every container works a DIFFERENT
#    company, so no single target sees more than 1 req/s — the daily wall-clock
#    just shrinks ~6x. Programs listed in /opt/bounty/priority.txt (one name per
#    line) are always picked first — regenerate that file from the unscanned
#    backlog as needed. Anything scanned >7 days ago is eligible again, so the
#    whole queue re-scans on a rolling cycle (new nuclei CVE templates land
#    daily, so re-scans surface fresh hits on old programs).
# 3. Each scan posts its summary to the hub Bug bounty tab (per-company, so
#    parallel ingest is safe: the hub upserts one Huly issue per program).
#
# Run by systemd timer (bounty-daily.timer, bounty-daily-evening.timer) or by hand:
#   ./bounty-daily.sh              # 12 programs, 6 at a time
#   TOP=6 ./bounty-daily.sh        # 6 programs, 6 at a time
#   PAR=2 TOP=8 ./bounty-daily.sh  # gentler: 2 containers at a time

set -u
TOP=${TOP:-12}
PAR=${PAR:-6}
LOG=/root/bounty-daily.log

# Only one batch at a time: skip if a previous timer/manual run is still going.
exec 9>/tmp/bounty-daily.lock
flock -n 9 || { echo "bounty-daily already running; skipping" | tee -a "$LOG"; exit 0; }

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
echo "[2/2] scanning $N programs, up to $PAR at a time" | tee -a "$LOG"
cat /tmp/bounty-batch.txt | tee -a "$LOG" | sed 's/^/  /'

# Parallel scan pool. Each scan logs to its own file so concurrent output never
# interleaves; per-program logs are concatenated into the main log (batch order)
# once the pool drains. TAB-separated because program names contain spaces.
while IFS= read -r PROGRAM; do
  [ -n "$PROGRAM" ] || continue
  SAFE=$(echo "$PROGRAM" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//;s/-$//')
  printf '%s\t%s\n' "$SAFE" "$PROGRAM"
done < /tmp/bounty-batch.txt > /tmp/bounty-batch-safe.tsv

xargs -P "$PAR" -d '\n' -I{} sh -c '
  SAFE=$(printf "%s" "$1" | cut -f1)
  PROGRAM=$(printf "%s" "$1" | cut -f2-)
  bash /opt/bounty/bounty-scan.sh "$PROGRAM" > "/root/bounty-daily.$SAFE.log" 2>&1
  echo "scanned: $PROGRAM (rc=$?)"
' _ {} < /tmp/bounty-batch-safe.tsv | tee -a "$LOG"

# Fold per-program logs into the main log in batch order.
while IFS=$'\t' read -r SAFE _; do
  [ -f "/root/bounty-daily.$SAFE.log" ] || continue
  { echo "--- $SAFE ---"; cat "/root/bounty-daily.$SAFE.log"; } >> "$LOG"
  rm -f "/root/bounty-daily.$SAFE.log"
done < /tmp/bounty-batch-safe.tsv

# Rotate: move scanned programs to the end of priority.txt so the next batch
# picks the unscanned tail instead of re-scanning the same front of the list.
if [ -s /tmp/bounty-batch.txt ]; then
  # shellcheck disable=SC2046
  python3 /opt/bounty/bounty-rotate.py $(grep . /tmp/bounty-batch.txt) >> "$LOG" 2>&1 || true
fi

echo "=== done $(date -u) ===" >> "$LOG"
tail -5 "$LOG"
