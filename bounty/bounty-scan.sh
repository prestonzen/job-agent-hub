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
# Scope discipline: only default-allow queue rows are scanned, and each active target is
# checked against the row's declared in-scope/out-of-scope assets before httpx or nuclei.

set -u
QUEUE=/opt/bounty/queue.json
TOKEN_FILE=/etc/hub-admin-token
HUB=https://jobhunter.prestonzen.com
IMAGE=chvancooten/bugbountyscanner:latest

[ -f "$QUEUE" ] || { echo "no queue; run scope-fetch.py first"; exit 1; }

SCANNED=/opt/bounty/scanned.log
touch "$SCANNED"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  NAME="${2:-}"
else
  NAME="${1:-}"
fi
if [ -n "$NAME" ] && [ -f /opt/bounty/policy-blacklist.json ]; then
  BLOCKED=$(python3 - "/opt/bounty/policy-blacklist.json" "$NAME" <<'EOF'
import json, sys
try:
    programs = json.load(open(sys.argv[1])).get("programs", [])
except Exception:
    programs = []
name = sys.argv[2].strip().casefold()
for item in programs:
    if item.get("program", "").strip().casefold() == name:
        print(item.get("evidence") or "explicit automated-scanning prohibition")
        break
EOF
  )
  [ -z "$BLOCKED" ] || { echo "program is explicitly policy-blacklisted: $BLOCKED"; exit 3; }
fi
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
echo "$ROW" | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('automation') == 'default-allow' else 1)" || { echo "program is explicitly policy-blacklisted; refusing scan"; exit 3; }
SCAN_RPS=1

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

# Build strict scan seeds from only the catalog's explicit scope entries. Wildcards may
# be enumerated; exact hosts and URLs are scanned as listed, without subdomain expansion.
printf '%s' "$ROW" | PYTHONPATH=/opt/bounty OUTDIR="$OUT" python3 -c '
import json,sys
from scope import scope_rules
row=json.load(sys.stdin); rules=scope_rules(row.get("assets",[]), row.get("out_of_scope",[]))
import os
out=os.environ["OUTDIR"]
with open(out+"/scope.json","w") as f: json.dump(rules,f)
wild=sorted({host for kind,host,path in rules["in"] if kind=="wildcard-host"})
direct=sorted({host if kind=="host" else "https://"+host+path for kind,host,path in rules["in"] if kind in ("host","url")})
open(out+"/wildcards.txt","w").write("\n".join(wild)+("\n" if wild else ""))
open(out+"/direct.txt","w").write("\n".join(direct)+("\n" if direct else ""))
' || { echo "could not parse program scope"; exit 3; }
DOMAINS=$(wc -l < "$OUT/wildcards.txt")
DIRECT=$(wc -l < "$OUT/direct.txt")
echo "program: $PROGRAM ($PLATFORM) — $DOMAINS wildcard domains, $DIRECT exact targets"
cat "$OUT/wildcards.txt" "$OUT/direct.txt" | sed 's/^/  /'
[ "$DOMAINS" = "0" ] && [ "$DIRECT" = "0" ] && { echo "no scannable explicit in-scope targets"; exit 1; }
if [ "$DRY_RUN" = "1" ]; then
  echo "dry run: policy gate and target scope parsed; no active requests sent"
  exit 0
fi

# Recon inside the scanner image.
CNAME="bbs-$(echo "$PROGRAM" | tr -c "A-Za-z0-9" "-")-$$"
docker rm -f "$CNAME" >/dev/null 2>&1 || true
timeout -k 60 3600 docker run --name "$CNAME" -e SCAN_RPS="$SCAN_RPS" -v "$OUT":/out -v /opt/bounty/scope.py:/scope.py:ro "$IMAGE" /bin/bash -c '
  set -u
  nuclei -update-templates > /dev/null 2>&1 || true   # fresh CVE templates every run
  : > /out/urls.txt
  touch /out/subs.raw.txt
  if [ -s /out/wildcards.txt ]; then subfinder -silent -dL /out/wildcards.txt -o /out/subs.raw.txt 2>/dev/null || true; fi
  cat /out/wildcards.txt /out/direct.txt >> /out/subs.raw.txt
  sort -u /out/subs.raw.txt -o /out/subs.raw.txt
  PYTHONPATH=/ python3 - <<"PY"
import json,sys
from scope import in_scope
rules=json.load(open("/out/scope.json"))
with open("/out/subs.raw.txt") as src, open("/out/subs.txt","w") as dst:
    for line in src:
        target=line.strip()
        if target and in_scope(target,rules): dst.write(target+"\n")
PY
  httpx -silent -l /out/subs.txt -status-code -title -tech-detect -rl "$SCAN_RPS" -o /out/live.raw.txt 2>/dev/null || true
  PYTHONPATH=/ python3 - <<"PY"
import json
from scope import in_scope
rules=json.load(open("/out/scope.json"))
with open("/out/live.raw.txt") as src, open("/out/live.txt","w") as dst:
    for line in src:
        parts=line.split()
        if parts and in_scope(parts[0],rules): dst.write(line)
PY
  cut -d" " -f1 /out/live.txt > /out/live-hosts.txt 2>/dev/null || true
  # Endpoint harvesting: historical URLs give nuclei real paths, not just root pages.
  if command -v waybackurls > /dev/null 2>&1; then
    cat /out/live-hosts.txt | sed "s|https\?://||" | waybackurls 2>/dev/null | head -3000 > /out/urls.raw.txt || true
    PYTHONPATH=/ python3 - <<"PY"
import json
from scope import in_scope
rules=json.load(open("/out/scope.json"))
with open("/out/urls.raw.txt") as src, open("/out/urls.txt","w") as dst:
    for line in src:
        target=line.strip()
        if target and in_scope(target,rules): dst.write(target+"\n")
PY
  fi
  if [ -s /out/urls.txt ]; then
    nuclei -silent -l /out/urls.txt -tags exposure,misconfig,cve -rl "$SCAN_RPS" -timeout 10 -o /out/nuclei.txt 2>/dev/null
  else
    nuclei -silent -l /out/live-hosts.txt -tags exposure,misconfig,cve -rl "$SCAN_RPS" -timeout 10 -o /out/nuclei.txt 2>/dev/null
  fi
  true
'
docker rm -f "$CNAME" >/dev/null 2>&1 || true   # hard-kill if timeout fired (PID-1 ignores TERM)
SUBS=$(grep -c . "$OUT/subs.txt" 2>/dev/null || echo 0)
LIVE=$(grep -c . "$OUT/live-hosts.txt" 2>/dev/null || echo 0)
HITS=$(grep -c . "$OUT/nuclei.txt" 2>/dev/null || echo 0)
echo "$(date -u +%s | sed "s/^/$SAFE|/")" >> "$SCANNED"
echo "subdomains: $SUBS · live hosts: $LIVE · nuclei hits: $HITS"
echo "results: $OUT"
TARGET=$(cat "$OUT/wildcards.txt" "$OUT/direct.txt" | sed -n '1p')

# Post to the hub.
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
  PAYLOAD=$(python3 - "$PLATFORM" "$PROGRAM" "$TARGET et al" "$DOMAINS" "$DIRECT" "$SUBS" "$LIVE" "$HITS" "$OUT" <<'PY'
import json, sys
platform, program, target, wildcards, direct, hosts, live, hits, output = sys.argv[1:]
detail = f"{wildcards} wildcard roots and {direct} exact targets -> {hosts} in-scope hosts -> {live} live hosts -> {hits} nuclei observations. Raw results on CT 134: {output}"
print(json.dumps({"kind":"scan", "platform":platform, "program":program, "target":target,
                  "title":"Low-noise recon pass (subfinder/httpx/nuclei)", "status":"done", "detail":detail}))
PY
  )
  curl -fsS -X POST "$HUB/api/admin/bounty-events" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$PAYLOAD"
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
