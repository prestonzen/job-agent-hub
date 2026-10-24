#!/usr/bin/env bash
# bounty-engage.sh — hand one suspected finding to Dark-Moon for validation + report draft.
#
#   bounty-engage.sh <program> <platform> <host-url> <suspected-finding>
#
# Dark-Moon gets a tight scope: confirm or refute THIS finding on THIS host (an in-scope
# asset of the named program). If confirmed, it drafts a platform-format report.
# The outcome is posted to the hub (finding confirmed/refuted, report drafted).
# Reports are drafts only — Preston reviews before anything is submitted.

set -u
PROGRAM="${1:?program}"; PLATFORM="${2:?platform}"; HOST="${3:?host}"; TITLE="${4:?finding}"
HUB=https://jobhunter.prestonzen.com
TOKEN=$(cat /etc/hub-admin-token)
SAFE=$(echo "$PROGRAM" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//;s/-$//')
OUT=/root/bbscans/$SAFE
LOG="$OUT/engage-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$OUT"

echo "[engage] $PROGRAM / $HOST / $TITLE"

# Announce the hypothesis up front: "found, verifying" — the confirmed/refuted verdict
# (and, for confirmed, the report draft for Telegram approval) follows when Dark-Moon exits.
python3 - "$PLATFORM" "$PROGRAM" "$HOST" "$TITLE" <<'PYEOF' | curl -fsS -X POST "$HUB/api/admin/bounty-events" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- || echo "[engage] verifying ping failed (non-fatal)"
import json, sys
platform, program, host, title = sys.argv[1:5]
print(json.dumps({
    "kind": "finding", "platform": platform, "program": program, "target": host,
    "status": "verifying", "title": f"Verifying: {title}"[:200],
}))
PYEOF

cd /opt/Dark-Moon || exit 1
timeout 2400 ./darkmoon.sh " TARGET: $HOST  PROGRAM=\"$PROGRAM\" FOCUS=confirm-or-refute: $TITLE  NOISE=low FORMAT=h1  SCOPE: authorized $PLATFORM bug bounty program asset. Validate ONLY this suspected finding; do not widen scope. If confirmed, draft the report. " > "$LOG" 2>&1
RC=$?

CONFIRMED=$(grep -c -a '"status":"confirmed"' "$LOG" || true)
FINALIZED=$(grep -c -a 'finalize_campaign' "$LOG" || true)
echo "[engage] done rc=$RC confirmed=$CONFIRMED finalized=$FINALIZED log=$LOG"

if [ "$CONFIRMED" -gt 0 ]; then
  STATUS=confirmed
  KIND=finding
else
  STATUS=refuted
  KIND=finding
fi

# Build the event JSON with python so quotes/backslashes in $TITLE can't corrupt it
# (jury markdown contains literal quotes — a raw heredoc 400s the POST and loses the record).
PAYLOAD=$(python3 - "$KIND" "$PLATFORM" "$PROGRAM" "$HOST" "$STATUS" "$TITLE" "$LOG" "$RC" "$CONFIRMED" "$FINALIZED" <<'PYEOF'
import json, sys
kind, platform, program, host, status, title, log, rc, confirmed, finalized = sys.argv[1:11]
print(json.dumps({
    "kind": kind, "platform": platform, "program": program, "target": host,
    "severity": "medium", "status": status,
    "title": f"Dark-Moon validation: {title}"[:200],
    "detail": f"Autonomous validation of a scanner-flagged observation. rc={rc}, confirmed_findings={confirmed}, campaign_finalized={finalized}. Full log on CT 134: {log}",
}))
PYEOF
)
curl -fsS -X POST "$HUB/api/admin/bounty-events" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$PAYLOAD"
echo

# Every validation log enters durable offline review; no log marker is treated as proof.
if [ -f /etc/hub-admin-token ]; then
  python3 /opt/bounty/cyber-dispatch.py --mode report --agents "${CYBER_AGENTS:-codex}" \
    --program "$PROGRAM" --platform "$PLATFORM" --host "$HOST" --title "$TITLE" --log "$LOG" \
    || echo "[engage] cyber dispatch failed (non-fatal)"
fi
