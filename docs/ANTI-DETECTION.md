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
- **Residential egress**: runner config `proxy` section routes through CT 125 (T-Mobile residential IP).
- **Real browser**: Playwright with a virtual display, not raw HTTP posting.

## Rules for agents (also in runner machineNotes)

1. If a platform flags an application as spam / duplicate / "unusual activity": **stop immediately**, report `needs_human` with note `spam-flagged: <platform>`. Never retry in the same session — retries from the same fingerprint turn a soft flag into a hard block.
2. Never paste the same essay text verbatim into two companies. Rephrase from the Answer Bank each time (same facts, different sentences).
3. Fill forms at human pace: let jev-apply/form-assist type into fields, don't bulk-set values via JS.
4. A retry (only when Preston says so) needs: fresh browser profile, residential proxy on, ≥48 h since the flag.

## Next upgrades (in priority order)

1. **Playwright stealth hardening**: strip `navigator.webdriver`, mock chrome runtime/plugins/languages; prefer the real Chrome channel over bundled Chromium on the runner.
2. **Consistent human fingerprint per platform account**: one persistent browser profile per platform (cookies, localStorage survive between runs) — returning users look legitimate; fresh-profile-every-run looks like a bot farm. Randomizing fingerprint per page load is *worse* than a stable one.
3. **Submission-time spread**: jitter run starts (autopilot already randomizes rest gaps); avoid identical minute-of-hour submission stamps across ATS accounts.
4. **Resume PDF metadata**: strip/rotate author-producer fields on upload copies; keep the human-readable file identical.
5. **Email aliasing** (if flags persist): per-platform aliases (`contact+<platform>@prestonzen.com`) to break cross-site correlation — tradeoff: harder inbox tracking, so only if needed.
