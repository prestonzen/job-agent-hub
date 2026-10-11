#!/usr/bin/env bash
# Install the runner on a provisioned Debian/Ubuntu box (run provision.sh first). Run as root.
# Needs /etc/job-agent-runner/config.json (see config.example.json). Idempotent; update.sh re-runs it.
#
#   setup.sh                    server mode: CLIs run as the unprivileged `agent` user on a virtual
#                               display (Xvfb :99); system services; starts at boot. (kloud CT 218)
#   setup.sh --desktop <user>   desktop mode: CLIs run as <user> inside their graphical session, so
#                               the agents' browsers open on your screen; a systemd *user* service.
set -euo pipefail
export PATH="/usr/local/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG=/etc/job-agent-runner/config.json
[ -f "$CONFIG" ] || { echo "missing $CONFIG"; exit 1; }

MODE=server RUN_USER=agent
if [ "${1:-}" = "--desktop" ]; then
  MODE=desktop RUN_USER="${2:-${SUDO_USER:-}}"
  [ -n "$RUN_USER" ] && id "$RUN_USER" >/dev/null 2>&1 || { echo "usage: setup.sh --desktop <your-login-user>"; exit 1; }
fi
RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6 || true)

if [ "$MODE" = server ]; then
  id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
  RUN_HOME=/home/agent
fi
install -d -o "$RUN_USER" -g "$RUN_USER" -m 700 "$RUN_HOME/resume" /var/lib/job-agent-runner /var/lib/job-agent-runner/runs
install -d -m 755 /opt/job-agent-runner
install -m 644 "$HERE/runner.mjs" "$HERE/configure-agents.mjs" /opt/job-agent-runner/
install -m 755 "$HERE/update.sh" "$HERE/form-assist.mjs" "$HERE/inbox-assist.mjs" "$HERE/with-key.mjs" "$HERE/gpu-gate.mjs" /opt/job-agent-runner/
install -m 755 "$HERE/set-key.sh" /usr/local/bin/jar-set-key
chown "root:$RUN_USER" "$CONFIG" && chmod 640 "$CONFIG"

# Python CLIs and the browser must live outside /root so the run user can use them.
export UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin
if grep -q '"mistral"' "$CONFIG" && [ ! -x /opt/uv/tools/mistral-vibe/bin/vibe ]; then
  uv tool uninstall mistral-vibe >/dev/null 2>&1 || true
  uv tool install --force mistral-vibe
fi
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Install the Chromium build matching the Playwright version that playwright-mcp bundles.
PW_DIR=$(node -p 'require("path").dirname(require.resolve("playwright/package.json", { paths: ["/usr/lib/node_modules/@playwright/mcp"] }))')
PW_REV=$(node -p "require('$PW_DIR/../playwright-core/browsers.json').browsers.find(b => b.name === 'chromium').revision" 2>/dev/null || echo "")
if [ -z "$PW_REV" ] || [ ! -d "/opt/ms-playwright/chromium-$PW_REV" ]; then
  node "$PW_DIR/cli.js" install --with-deps chromium
fi
chmod -R a+rX /opt/ms-playwright /opt/uv
# Some npm CLIs ship vendored binaries (e.g. Qwen's ripgrep) without the execute bit for other users.
find /usr/lib/node_modules -path '*vendor/ripgrep*' -name rg -type f -exec chmod a+rx {} +

# Hermes (the Ollama agent's harness) installs per user; make it visible to the runner service.
[ -x "$RUN_HOME/.local/bin/hermes" ] && ln -sf "$RUN_HOME/.local/bin/hermes" /usr/local/bin/hermes

su - "$RUN_USER" -c "PATH=/usr/local/bin:\$PATH node /opt/job-agent-runner/configure-agents.mjs $CONFIG"

RUNNER_ENV='Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
Environment=RUNNER_CONFIG=/etc/job-agent-runner/config.json'

if [ "$MODE" = server ]; then
  cat > /etc/systemd/system/xvfb-runner.service <<'UNIT'
[Unit]
Description=Virtual display :99 for agent browsers
After=network.target

[Service]
User=agent
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
  cat > /etc/systemd/system/job-agent-runner.service <<UNIT
[Unit]
Description=Job Agent Hub runner (executes agent CLIs for jobhunter.prestonzen.com)
After=network-online.target xvfb-runner.service
Wants=network-online.target xvfb-runner.service

[Service]
User=agent
WorkingDirectory=/var/lib/job-agent-runner
$RUNNER_ENV
Environment=DISPLAY=:99
ExecStart=/usr/bin/node /opt/job-agent-runner/runner.mjs
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT
else
  # Desktop: a user service inherits DISPLAY/WAYLAND_DISPLAY from the graphical session.
  cat > /etc/systemd/user/job-agent-runner.service <<UNIT
[Unit]
Description=Job Agent Hub runner (desktop session)
After=graphical-session.target

[Service]
WorkingDirectory=/var/lib/job-agent-runner
$RUNNER_ENV
ExecStart=/usr/bin/node /opt/job-agent-runner/runner.mjs
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=graphical-session.target
UNIT
fi

# Pull-based CD: check GitHub every 5 minutes, redeploy runner/ when it changed and nothing is running.
cat > /etc/systemd/system/job-agent-updater.service <<UNIT
[Unit]
Description=Job Agent Hub runner auto-update (pulls runner/ from GitHub)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=RUNNER_SETUP_ARGS=$( [ "$MODE" = desktop ] && echo "--desktop $RUN_USER" )
ExecStart=/opt/job-agent-runner/update.sh
UNIT
cat > /etc/systemd/system/job-agent-updater.timer <<'UNIT'
[Unit]
Description=Check for runner updates every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now job-agent-updater.timer
if [ "$MODE" = server ]; then
  systemctl enable --now xvfb-runner.service
  systemctl enable job-agent-runner.service
  systemctl restart job-agent-runner.service
  sleep 3
  systemctl --no-pager --lines=5 status job-agent-runner.service || true
else
  if su - "$RUN_USER" -c 'systemctl --user daemon-reload && systemctl --user enable job-agent-runner.service && systemctl --user restart job-agent-runner.service' 2>/dev/null; then
    echo "desktop runner (re)started for $RUN_USER"
  else
    echo "Now, logged in as $RUN_USER in your desktop session, run:"
    echo "  systemctl --user daemon-reload && systemctl --user enable --now job-agent-runner"
  fi
fi
