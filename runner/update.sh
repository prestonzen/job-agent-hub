#!/usr/bin/env bash
# Pull-based CD for the runner. A systemd timer runs this every 5 minutes as root:
#   1. fetch main from GitHub (outbound only, works behind CGNAT, no secrets in GitHub)
#   2. if anything under runner/ changed since the last deploy, and no agent run is in progress,
#      re-run setup.sh from the new checkout (idempotent: installs files, MCP config, units, restart)
# provision.sh (system packages, CLI installs) is not re-run automatically; run it by hand.
set -euo pipefail
export PATH="/usr/local/bin:$PATH"
REPO="${RUNNER_REPO:-https://github.com/prestonzen/job-agent-hub.git}"
BRANCH="${RUNNER_BRANCH:-main}"
DIR=/opt/job-agent-runner/repo
STAMP=/var/lib/job-agent-runner/deployed-runner-tree
STATE=/var/lib/job-agent-runner/state.json

[ -d "$DIR/.git" ] || git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH"
NEW=$(git -C "$DIR" rev-parse "origin/$BRANCH:runner")   # tree hash of runner/ only
OLD=$(cat "$STAMP" 2>/dev/null || true)
[ "$NEW" = "$OLD" ] && exit 0

BUSY=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).busy||0))}catch{process.stdout.write("0")}' "$STATE")
if [ "$BUSY" != "0" ]; then
  echo "runner/ changed (${OLD:0:8} -> ${NEW:0:8}) but $BUSY run(s) in progress; deferring"
  exit 0
fi

echo "deploying runner/ ${OLD:0:8} -> ${NEW:0:8} ($(git -C "$DIR" log -1 --format='%h %s' "origin/$BRANCH"))"
git -C "$DIR" reset --quiet --hard "origin/$BRANCH"
bash "$DIR/runner/setup.sh" ${RUNNER_SETUP_ARGS:-}
echo "$NEW" > "$STAMP"
