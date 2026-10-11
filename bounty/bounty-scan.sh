#!/usr/bin/env bash
# bounty-scan.sh — run a low-noise recon pass on the next (or named) program in the queue.
#
#   ./bounty-scan.sh                 # first program in /opt/bounty/queue.json
#   ./bounty-scan.sh "Remitly"       # named program
#
# Pipeline: apex domains from the program's in-scope wildcards -> subfinder (passive enum)
# -> httpx (live hosts) -> nuclei (exposure/misconfig/CVE templates, rate-limited,
# non-intrusive). Results go to /root/bbscans/<program>/ and a summary event is posted
# to the hub (POST /api/agent/bounty), which feeds the admin Bug bounty tab.
#
# Scope discipline: only assets listed in the program's bounty-targets-data entry are
# touched. Automation-banned programs never reach the queue (scope-fetch.py drops them).

set -u
QUEUE=/opt/bounty/queue.json
TOKEN_FILE=/etc/hub-agent-token
HUB=https://jobhunter.prestonzen.com
IMAGE=chvancooten/bugbountyscanner:latest

[ -f "$QUEUE" ] || { echo "no queue; run scope-fetch.py first"; exit 1; }

SCANNED=/opt/bounty/scanned.log
touch "$SCANNED"

NAME="${1:-}"
ROW=$(python3 - "$QUEUE" "$NAME" "$SCANNED" <<'EOF'
import json, re, sys, time
q = json.load(open(sys.argv[1]))["programs"]
name = sys.argv[2].lower()
safe = lambda s: re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")
try:
    scanned = {}
    for line in open(sys.argv[3]):
        k, ts = line.strip().split("|")
        scanned[k] = int(ts)
    # older than 7 days = eligible again
    scanned = {k for k, ts in scanned.items() if time.time() - ts < 7 * 86400}
except Exception:
    scanned = set()
row = None
if name:
    row = next((p for p in q if p["program"].lower() == name), None)
else:
    row = next((p for p in q if safe(p["program"]) not in scanned), None)
print(json.dumps(row) if row else "NOTFOUND")
EOF
)
[ "$ROW" = "NOTFOUND" ] && { echo "program not found in queue"; exit 1; }

PROGRAM=$(echo "$ROW" | python3 -c "import json,sys; print(json.load(sys.stdin)['program'])")
PLATFORM=$(echo "$ROW" | python3 -c "import json,sys; print(json.load(sys.stdin)['platform'])")
SAFE=$(echo "$PROGRAM" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//;s/-$//')
OUT=/root/bbscans/$SAFE

# Skip programs scanned in the last 7 days when auto-picking (explicit name always re-scans).
if [ -z "$NAME" ] && grep -q "^$SAFE|" "$SCANNED"; then
  LAST=$(grep "^$SAFE|" "$SCANNED" | tail -1 | cut -d'|' -f2)
  AGE=$(( ($(date +%s) - LAST) / 86400 ))
  [ "$AGE" -lt 7 ] && { echo "$PROGRAM scanned ${AGE}d ago; skipping (name it explicitly to force)"; exit 2; }
fi
mkdir -p "$OUT"

# Apex domains: strip '*.' from wildcards, keep plain in-scope domains, cap at 10.
echo "$ROW" | python3 -c "
import json, sys
row = json.load(sys.stdin)
apex = set()
for a in row['wildcards'] + row['assets']:
    a = a.strip().lower()
    if a.startswith('*.'):
        a = a[2:]
    a = a.lstrip('*')
    if '.' in a and ' ' not in a and '/' not in a:
        apex.add(a)
print('\n'.join(sorted(apex)[:10]))
" > "$OUT/apex.txt"
DOMAINS=$(wc -l < "$OUT/apex.txt")
echo "program: $PROGRAM ($PLATFORM) — $DOMAINS apex domains"
cat "$OUT/apex.txt" | sed 's/^/  /'
[ "$DOMAINS" = "0" ] && { echo "no scannable apex domains"; exit 1; }

# Recon inside the scanner image.
docker run --rm -v "$OUT":/out "$IMAGE" /bin/bash -c '
  set -u
  subfinder -silent -dL /out/apex.txt -o /out/subs.txt 2>/dev/null
  cat /out/apex.txt >> /out/subs.txt
  sort -u /out/subs.txt -o /out/subs.txt
  httpx -silent -l /out/subs.txt -status-code -title -tech-detect -rl 30 -o /out/live.txt 2>/dev/null
  cut -d" " -f1 /out/live.txt > /out/live-hosts.txt 2>/dev/null || true
  nuclei -silent -l /out/live-hosts.txt -tags exposure,misconfig,cve -rl 30 -timeout 10 -o /out/nuclei.txt 2>/dev/null
  true
'
SUBS=$(grep -c . "$OUT/subs.txt" 2>/dev/null || echo 0)
LIVE=$(grep -c . "$OUT/live-hosts.txt" 2>/dev/null || echo 0)
HITS=$(grep -c . "$OUT/nuclei.txt" 2>/dev/null || echo 0)
echo "$(date -u +%s | sed "s/^/$SAFE|/")" >> "$SCANNED"
echo "subdomains: $SUBS · live hosts: $LIVE · nuclei hits: $HITS"
echo "results: $OUT"

# Post to the hub.
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
  curl -s -X POST "$HUB/api/agent/bounty" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- <<EOF
{"kind":"scan","platform":"$PLATFORM","program":"$PROGRAM","target":"$(head -1 "$OUT/apex.txt") et al","title":"Low-noise recon pass (subfinder/httpx/nuclei)","status":"done","detail":"${DOMAINS} apex domains -> ${SUBS} subdomains -> ${LIVE} live hosts -> ${HITS} nuclei observations. Raw results on CT 134: ${OUT}"}
EOF
  echo
else
  echo "no $TOKEN_FILE; hub event skipped"
fi

# Auto-engage: hand medium+ nuclei hits to Dark-Moon for validation + report draft.
# Cap: 3 hosts per program, one validation each — engagement is the expensive step.
ENGAGE=/opt/bounty/bounty-engage.sh
CLEAN="$OUT/nuclei.clean.txt"
sed "s/\x1b\[[0-9;]*m//g" "$OUT/nuclei.txt" 2>/dev/null > "$CLEAN" || true
HOT=$(grep -Ei "\[(medium|high|critical)\]" "$CLEAN" 2>/dev/null | head -20 || true)
if [ -n "$HOT" ] && [ -x "$ENGAGE" ]; then
  echo "$HOT" | awk '{for(i=1;i<=NF;i++) if ($i ~ /^https?:\/\//) print $i}' | sort -u | head -3 | while read -r HOSTURL; do
    FTITLE=$(grep -m1 -F "$HOSTURL" "$CLEAN" | cut -c1-140 | tr '"' "'")
    echo "engaging Dark-Moon on $HOSTURL ($FTITLE)"
    nohup bash "$ENGAGE" "$PROGRAM" "$PLATFORM" "$HOSTURL" "$FTITLE" >> /root/bounty-engage.log 2>&1 &
  done
elif [ -n "$HOT" ]; then
  echo "medium+ hits present but $ENGAGE missing/not executable"
fi
