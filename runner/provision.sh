#!/usr/bin/env bash
# Provision an Ubuntu 24.04 box (e.g. a Proxmox LXC) as a Job Agent Hub runner.
# Idempotent: safe to re-run. Installs Node 22, a real Chromium (Playwright) + Xvfb,
# and the agent CLIs. Logins and tokens are configured separately (see runner/README.md).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n==> %s\n' "$*"; }

log "Apt over HTTPS (plain-HTTP downloads get corrupted on some carrier networks: 'Hash Sum mismatch')"
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
  [ -f "$f" ] && sed -i -E 's#http://(archive|security)\.ubuntu\.com/ubuntu#https://mirrors.edge.kernel.org/ubuntu#g' "$f"
done
echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries

log "Base packages"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq unzip xz-utils \
  build-essential python3 python3-venv xvfb xauth fonts-liberation fonts-noto-color-emoji locales tzdata
locale-gen en_US.UTF-8 >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

if ! command -v uv >/dev/null; then
  log "uv (Python tool installer)"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
fi

log "Agent CLIs (npm)"
npm install -g --no-fund --no-audit \
  @anthropic-ai/claude-code \
  @openai/codex \
  @google/gemini-cli \
  @qwen-code/qwen-code \
  @playwright/mcp

log "Agent CLIs (Python via uv)"
export UV_TOOL_BIN_DIR=/usr/local/bin
uv tool install --force kimi-cli || echo "WARN: kimi-cli install failed"
uv tool install --force mistral-vibe || echo "WARN: mistral-vibe install failed"

log "Chromium for Playwright MCP (with system deps)"
npx -y playwright install --with-deps chromium

log "Runner user dirs"
mkdir -p /opt/job-agent-runner /var/lib/job-agent-runner /root/resume

log "Installed versions"
for c in claude codex gemini qwen kimi vibe; do
  printf '%-8s ' "$c"; (command -v "$c" >/dev/null && ("$c" --version 2>/dev/null | head -1 || echo installed)) || echo MISSING
done
log "Done"
