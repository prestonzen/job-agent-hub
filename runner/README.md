# Runner

A runner is an always-on machine that executes agent runs launched from the hub's **Run agents** tab (`/admin#run`). It polls the hub (outbound HTTPS only, so CGNAT and no open ports are fine), starts the requested agent CLI headless with a real browser, streams the output back, and stops it on **Stop** or timeout.

Production runner: Proxmox LXC **218 `job-agent-runner`** on `kloud` (Ubuntu 24.04, residential IP).

```
Phone / browser ──► /admin#run ──► hub (D1: runs) ◄── poll/claim/log ── runner.mjs (kloud CT 218)
                                                                          └─ claude | codex | gemini | qwen | kimi | vibe
                                                                               + Playwright MCP (Chromium on Xvfb :99)
                                                                               + hub MCP (/mcp, per-agent token)
```

## Files

| File | What |
|---|---|
| `provision.sh` | Installs Node 22, Chromium + Xvfb, the agent CLIs and Playwright MCP (idempotent; run as root) |
| `setup.sh` | Creates the `agent` user, writes each CLI's MCP config (hub + browser), installs the systemd units. `--desktop <user>` for a desktop machine |
| `update.sh` | Pull-based auto-update, run by `job-agent-updater.timer` every 5 min |
| `runner.mjs` | The runner (zero dependencies) |
| `form-assist.mjs` | Helper for agents: completes interactive human-verification challenges on a page |
| `inbox-assist.mjs` | Helper for agents: picks up emailed verification codes from the applicant inbox |
| `config.example.json` | Runner config shape; the real one is `/etc/job-agent-runner/config.json` (holds secrets, never committed) |

## Verification helpers

`machineNotes` tells agents about two helpers installed at `/opt/job-agent-runner/`. They let equipped runners handle verification steps (human-verification challenges, emailed codes) autonomously instead of stalling overnight. They are best-effort: if credentials are missing or the attempt fails, agents fall back to the Telegram relay and then `needs_human`.

- **Page challenges** — `node form-assist.mjs --url <page url>`; needs `captcha.provider` / `captcha.apiKey` in the config.
- **Emailed codes** — `node inbox-assist.mjs --wait 120`; needs `gmail.clientId` / `clientSecret` / `refreshToken` in the config (one-time OAuth setup, see the header comment in `inbox-assist.mjs`).

## New machine

```bash
git clone https://github.com/prestonzen/job-agent-hub.git /opt/job-agent-runner/repo
sudo bash /opt/job-agent-runner/repo/runner/provision.sh
sudo install -d /etc/job-agent-runner && sudo cp config.json /etc/job-agent-runner/   # from config.example.json
sudo bash /opt/job-agent-runner/repo/runner/setup.sh                     # server (Xvfb, starts at boot)
sudo bash /opt/job-agent-runner/repo/runner/setup.sh --desktop "$USER"   # or: desktop, browsers on your screen
```

Give each machine its own `name` in the config. Several runners can share one hub, and each claims runs only for the CLIs it has ready.

## Updates

Push to `main`. Within about 5 minutes `job-agent-updater.timer` notices that `runner/` changed and waits until no run is active. Then it re-runs `setup.sh` from the new checkout. Check it with `journalctl -u job-agent-updater -n 20`. System packages and CLI versions (`provision.sh`) are updated by hand: `sudo bash /opt/job-agent-runner/repo/runner/provision.sh`.

## Logins (one time, per CLI)

Each CLI must be logged in **as the `agent` user**. The runner shows a CLI as *not logged in* until its credentials exist, and picks up new logins within 5 minutes.

```bash
ssh root@kloud
pct enter 218
su - agent
claude            # then /login
codex login --device-auth
gemini            # choose "Login with Google"
qwen              # choose "Qwen OAuth"
kimi login        # device-code flow (Kimi Code CLI)
vibe              # first run asks for a Mistral API key (or use jar-set-key, below)
```

Mistral Vibe and Gemini can also run headless on API keys with no login. As root on the runner, `jar-set-key mistral` (or `gemini`) asks for the key with hidden input and stores it for the `agent` user; the hub shows the agent as ready within about 5 minutes:

```bash
ssh -t root@kloud "pct exec 218 -- /usr/local/bin/jar-set-key mistral"
```

## Operating

```bash
pct exec 218 -- systemctl status job-agent-runner xvfb-runner
pct exec 218 -- systemctl list-timers job-agent-updater.timer
pct exec 218 -- journalctl -u job-agent-runner -f
pct exec 218 -- systemctl restart job-agent-runner
```

Rotate the runner secret: generate a new `RUNNER_TOKEN`, put it in the Pages secret and in `/etc/job-agent-runner/config.json`, and restart the service.
