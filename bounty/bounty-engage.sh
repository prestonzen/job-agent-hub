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

# Bounded researcher-account context (Preston, 2026-10-30): authenticated validation needs
# researcher-owned test accounts. Existing ones are pointed to by file path (never embedded in
# the prompt); if none exist and policy allows, Dark-Moon may self-register up to 2 via the
# plus-addressed applicant inbox, the form-assist captcha solver and the inbox-assist code reader.
ACCT_TEXT=$(python3 - "$SAFE" <<'PYEOF'
import json, sys
safe = sys.argv[1]
path = f"/opt/bounty/sensitive/accounts/{safe}.json"
policy = {"max_accounts_per_program": 2, "deny": []}
try:
    policy.update(json.load(open("/opt/bounty/registration-policy.json")))
except Exception:
    pass
tag = safe.lower()[:32]
try:
    accounts = json.load(open(path))
except Exception:
    accounts = []
if accounts:
    print(f"Researcher-owned test accounts for this program are stored at {path} — read that file for credentials, use them for authenticated validation, and do not register more.")
elif tag in [str(d).lower() for d in policy.get("deny", [])]:
    print("Account registration is disabled for this program; validate unauthenticated only.")
else:
    n = int(policy.get("max_accounts_per_program", 2))
    emails = f"contact+bb-{tag}-a@prestonzen.com" + (f" and contact+bb-{tag}-b@prestonzen.com for the second" if n > 1 else "")
    print(f"Self-registration is permitted, bounded: if validating this finding needs authenticated state, you may register up to {n} researcher test accounts through the product's normal signup using email {emails}. Solve a signup captcha with: node /opt/bounty/form-assist.mjs --url SIGNUP_URL (it prints a token as JSON). Read email verification codes or links with: node /opt/bounty/inbox-assist.mjs --wait 180 --query newer_than:15m (add the to: address of the mailbox tag used). Immediately append each created account as JSON to {path} and never overwrite existing entries. No paid plans, no real-user data, accounts only for this validation. If signup is walled by phone, payment, KYC, or a captcha the solver cannot pass, report blocked rather than refuted.")
PYEOF
)
ACCT_TEXT=$(printf '%s' "$ACCT_TEXT" | tr -d '"`$' | tr '\n' ' ')

cd /opt/Dark-Moon || exit 1
# Validation standards distilled from github.com/mdpsec/bug-bounty-hunting-prompts (phase-07/08) (Preston, 2026-10-30).
timeout 2400 ./darkmoon.sh " TARGET: $HOST  PROGRAM=\"$PROGRAM\" FOCUS=confirm-or-refute: $TITLE  NOISE=low FORMAT=h1  SCOPE: authorized $PLATFORM bug bounty program asset. Validate ONLY this suspected finding; do not widen scope. Accounts: $ACCT_TEXT Validation standard: prove the mechanism end-to-end on researcher-owned objects first, then at most one bounded confirmation on a non-owned object with the smallest request that proves the boundary; no bulk reads, no privileged actions on objects you do not own. Credential findings require minimal liveness proof with a negative control (a deliberately wrong secret must fail where the real one succeeds). Never assume a prerequisite: a chain step needing a victim identifier, token, or state you cannot show an attacker obtaining means refuted, not confirmed. Before confirming, run one negative control showing the boundary exists for unauthorized requests. If confirmed, draft the report. " > "$LOG" 2>&1
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
