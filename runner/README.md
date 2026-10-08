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
| `setup.sh` | Creates the `agent` user, writes each CLI's MCP config (hub + browser), installs the systemd units |
| `runner.mjs` | The runner (zero dependencies) |
| `config.example.json` | Runner config shape; the real one is `/etc/job-agent-runner/config.json` (holds secrets, never committed) |

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
kimi              # then /login
vibe              # first run asks for a Mistral API key
```

## Operating

```bash
pct exec 218 -- systemctl status job-agent-runner xvfb-runner
pct exec 218 -- journalctl -u job-agent-runner -f
pct exec 218 -- systemctl restart job-agent-runner
```

Rotate the runner secret: generate a new `RUNNER_TOKEN`, put it in the Pages secret and in `/etc/job-agent-runner/config.json`, and restart the service.
