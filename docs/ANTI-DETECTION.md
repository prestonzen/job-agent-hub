# Spam flags & anti-detection

Why applications get flagged as spam/duplicate by an ATS or employer, and what this system does about each cause. Two goals: **don't get flagged**, and **don't burn tokens retrying a flagged application into a harder block**.

## What trips the flags

| Signal | Why it looks like a bot |
| --- | --- |
| Identical essay / free-text answers across companies | Anti-fraud vendors fingerprint answer text |
| Machine-speed form filling | Fields filled in milliseconds, no focus/blur pattern |
| Same browser fingerprint everywhere | `navigator.webdriver`, headless Chromium tells, no stored cookies |
| Datacenter IP | ASN lookup says "cloud", not "home" |
| Burst patterns | Many applications to one ATS in a short window, same company twice |
| Resume metadata | Same PDF author/producer fields on every upload |

## Already in place

- **Pacing** (`worker/src/pacing.ts`): per-ATS concurrency/gap/daily caps, one in-flight application per company. The single biggest anti-flag lever.
- **Residential egress**: runner config `proxy` section routes through CT 125 (T-Mobile residential IP). The browser itself also egresses via that proxy (see below).
- **Real browser**: Playwright with a virtual display, not raw HTTP posting.
- **Persistent per-agent browser profiles** (Oct 20): every agent's playwright-mcp launches with `--user-data-dir /var/lib/job-agent-runner/profiles/<agent>` instead of `--isolated`. Cookies/localStorage survive between runs — a returning user looks legitimate, a fresh blank profile every run looks like a bot farm. Profiles are per agent (not shared) so concurrent runs never collide on the profile lock. Managed by `runner/configure-agents.mjs` (`browserFor(agent)`); never hand-add `--isolated` back.
- **Browser hardening config** (`/opt/job-agent-runner/pw-config.json`, template `runner/pw-config.example.json`): strips the `AutomationControlled` blink feature (kills the `navigator.webdriver` tell), pins `en-US` locale + `America/Los_Angeles` timezone so the browser matches the residential IP's geography, and routes through `socks5://127.0.0.1:11080` — the local no-auth relay (`socks5relay.service`) that holds the upstream credentials, so the browser never handles proxy auth (Chrome can't do SOCKS5 auth at all).
- **AppArmor network rule** (Oct 20): Ubuntu's `chrome` AppArmor profile (`abi/4.0`) silently denies ALL inet socket creation for the real Chrome binary inside LXC — every page load died with `ERR_PROXY_CONNECTION_FAILED` right after the Chrome switch. Fixed with `network,` in `/etc/apparmor.d/local/chrome` + `apparmor_parser -r /etc/apparmor.d/chrome`. If Chrome ever gets reinstalled and networking dies, check `dmesg` on the kloud host for `apparmor="DENIED" ... profile="chrome"` first.
- **Real Chrome channel** (Oct 20): `google-chrome` (155.x) installed on CT 218; `browserFor()` in `runner/configure-agents.mjs` launches playwright-mcp with `--browser chrome` instead of bundled Chromium, which carries its own binary-level tells beyond `navigator.webdriver`. Baseline probe after the switch passes the full sannysoft suite; only remaining tell is the SwiftShader WebGL renderer (no GPU in the container — accepted).
- **Profile warmup** (Oct 20): all 10 agent profiles were walked through 8 mainstream sites (Google, Wikipedia, GitHub, Stack Overflow, YouTube, Reddit, NYT, LinkedIn) so each carries real history + cookies before touching an ATS. Warmup script lives at `/home/agent/warmup.py` on CT 218 — rerun it after any profile wipe.

## Rules for agents (also in runner machineNotes)

1. If a platform flags an application as spam / duplicate / "unusual activity": **stop immediately**, report `needs_human` with note `spam-flagged: <platform>`. Never retry in the same session — retries from the same fingerprint turn a soft flag into a hard block.
2. Never paste the same essay text verbatim into two companies. Rephrase from the Answer Bank each time (same facts, different sentences).
3. Fill forms at human pace: let jev-apply/form-assist type into fields, don't bulk-set values via JS.
4. A retry (only when Preston says so) needs: ≥48 h since the flag, and the profile for that agent may be wiped first (`/var/lib/job-agent-runner/profiles/<agent>`) if the flag was fingerprint-based.

## Next upgrades (in priority order)

1. **Submission-time spread**: jitter run starts (autopilot already randomizes rest gaps); avoid identical minute-of-hour submission stamps across ATS accounts.
2. **Resume PDF metadata**: strip/rotate author-producer fields on upload copies; keep the human-readable file identical.
3. **Email aliasing** (if flags persist): per-platform aliases (`contact+<platform>@prestonzen.com`) to break cross-site correlation — tradeoff: harder inbox tracking, so only if needed.
4. **WebGL renderer**: SwiftShader is the last probe-visible tell; would need a GPU (or a renderer-spoofing build) in CT 218 to fix. Only pursue if flags persist after the Chrome switch proves out.
