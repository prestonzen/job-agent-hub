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
TOKEN=$(cat /etc/hub-agent-token)
SAFE=$(echo "$PROGRAM" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//;s/-$//')
OUT=/root/bbscans/$SAFE
LOG="$OUT/engage-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$OUT"

echo "[engage] $PROGRAM / $HOST / $TITLE"
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

curl -s -X POST "$HUB/api/agent/bounty" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- <<EOF
{"kind":"$KIND","platform":"$PLATFORM","program":"$PROGRAM","target":"$HOST","severity":"medium","status":"$STATUS","title":"Dark-Moon validation: $TITLE","detail":"Autonomous validation of a scanner-flagged observation. rc=$RC, confirmed_findings=$CONFIRMED, campaign_finalized=$FINALIZED. Full log on CT 134: $LOG"}
EOF
echo
