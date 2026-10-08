#!/usr/bin/env bash
# Install the runner on a provisioned box (run provision.sh first). Run as root from this directory,
# with /etc/job-agent-runner/config.json already in place (see config.example.json).
# Idempotent. Creates the unprivileged `agent` user the CLIs run as, shared browser + tool dirs,
# per-CLI MCP config, and two systemd services: a virtual display and the runner.
set -euo pipefail
export PATH="/usr/local/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG=/etc/job-agent-runner/config.json
[ -f "$CONFIG" ] || { echo "missing $CONFIG"; exit 1; }

id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
install -d -o agent -g agent -m 700 /home/agent/resume /var/lib/job-agent-runner /var/lib/job-agent-runner/runs
install -d -m 755 /opt/job-agent-runner
install -m 644 "$HERE/runner.mjs" "$HERE/configure-agents.mjs" /opt/job-agent-runner/
chown root:agent "$CONFIG" && chmod 640 "$CONFIG"

# Python CLIs and the browser must live outside /root so `agent` can use them.
export UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin
if [ ! -x /opt/uv/tools/mistral-vibe/bin/vibe ]; then
  uv tool uninstall mistral-vibe >/dev/null 2>&1 || true
  uv tool install --force mistral-vibe
fi
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Install the Chromium build matching the Playwright version that playwright-mcp bundles.
PW_DIR=$(node -p 'require("path").dirname(require.resolve("playwright/package.json", { paths: ["/usr/lib/node_modules/@playwright/mcp"] }))')
node "$PW_DIR/cli.js" install --with-deps chromium
chmod -R a+rX /opt/ms-playwright /opt/uv

su - agent -c "PATH=/usr/local/bin:\$PATH node /opt/job-agent-runner/configure-agents.mjs $CONFIG"

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

cat > /etc/systemd/system/job-agent-runner.service <<'UNIT'
[Unit]
Description=Job Agent Hub runner (executes agent CLIs for jobhunter.prestonzen.com)
After=network-online.target xvfb-runner.service
Wants=network-online.target xvfb-runner.service

[Service]
User=agent
WorkingDirectory=/var/lib/job-agent-runner
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=DISPLAY=:99
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
Environment=RUNNER_CONFIG=/etc/job-agent-runner/config.json
ExecStart=/usr/bin/node /opt/job-agent-runner/runner.mjs
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now xvfb-runner.service
systemctl enable job-agent-runner.service
systemctl restart job-agent-runner.service
sleep 3
systemctl --no-pager --lines=8 status job-agent-runner.service || true
