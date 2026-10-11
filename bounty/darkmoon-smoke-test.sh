#!/usr/bin/env bash
# darkmoon-smoke-test.sh — regression test for the Dark-Moon stack on CT 134.
#
# Boots OWASP Juice Shop (a deliberately vulnerable app we own locally),
# points Dark-Moon at it with a smoke-test scope, and asserts the full
# pipeline works: LLM reachable, recon runs, at least one finding is
# confirmed, and the campaign finalizes with a report.
#
# Usage:  ./darkmoon-smoke-test.sh          # full check, PASS/FAIL exit code
# Exit:   0 = PASS, 1 = FAIL
#
# Safe to run any time: Juice Shop is disposable and the target is always
# the local instance, never anything external.

set -u
JUICE_NAME=juice-shop
JUICE_PORT=3000
LOG=/root/darkmoon-smoke.log
TIMEOUT=600   # seconds to wait for Dark-Moon to finish

fail() { echo "FAIL: $1"; exit 1; }

# 1. Juice Shop up?
if ! docker ps --format '{{.Names}}' | grep -qx "$JUICE_NAME"; then
  echo "starting juice-shop..."
  docker rm -f "$JUICE_NAME" >/dev/null 2>&1
  docker run -d --name "$JUICE_NAME" -p ${JUICE_PORT}:3000 bkimminich/juice-shop >/dev/null \
    || fail "could not start juice-shop container"
fi

# 2. Wait for HTTP 200 (container can take ~30s to boot)
echo "waiting for juice-shop..."
ok=""
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${JUICE_PORT}/" || true)
  [ "$code" = "200" ] && { ok=1; break; }
  sleep 3
done
[ -n "$ok" ] || fail "juice-shop never returned HTTP 200"

IP=$(hostname -I | awk '{print $1}')
TARGET="http://${IP}:${JUICE_PORT}"
echo "target: $TARGET"

# 3. Run Dark-Moon smoke scope
cd /opt/Dark-Moon || fail "/opt/Dark-Moon missing"
: > "$LOG"
timeout "$TIMEOUT" ./darkmoon.sh " TARGET: $TARGET  SCOPE: smoke test only, run recon and stop after the first confirmed finding. This is a local OWASP Juice Shop instance we own, fully authorized. " > "$LOG" 2>&1
rc=$?
[ $rc -eq 124 ] && fail "darkmoon timed out after ${TIMEOUT}s (see $LOG)"

# 4. Assertions
grep -q 'darkmoon_dashboard_push_finding' "$LOG" || fail "no finding was pushed (see $LOG)"
grep -q 'darkmoon_dashboard_finalize_campaign' "$LOG" || fail "campaign never finalized (see $LOG)"
grep -qi '"status":"confirmed"' "$LOG" || fail "finding not marked confirmed (see $LOG)"

finding=$(grep -o '"title":"[^"]*"' "$LOG" | head -1 | cut -d'"' -f4)
echo "PASS: finding confirmed + campaign finalized"
echo "first finding: ${finding:-unknown}"
exit 0
