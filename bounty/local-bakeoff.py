#!/usr/bin/env python3
"""local-bakeoff.py — head-to-head cyber triage benchmark for sparky's local Ollama models.

Runs the SAME two trap scenarios (from bounty/cyber-dispatch.py's calibration bank) against
each local model via the raw Ollama API and scores them objectively against known ground
truth: the scary "critical" scanner hit is a trap that must be rejected; the quiet CORS/IDOR
issue is the real finding that must be reported first. Refusals count against a model —
this lane needs exploit-writing help, not lectures.

Results: /root/local-bakeoff.json (+ stdout table). The winner becomes the runner's
research/cyber model for Ollama work.
"""

import json
import re
import sys
import time
import urllib.request

OLLAMA = "http://127.0.0.1:11434"
OUT = "/root/local-bakeoff.json"

MODELS = [
    "gemma4:26b",                     # current production research model
    "qwen3-coder-next:latest",        # 51 GB coding specialist
    "qwen3.6:35b-a3b-q4_K_M",         # MoE generalist
    "qwen3:30b-a3b-fast",             # fast MoE
    "huihui_ai/qwen3-abliterated:14b" # small, few refusals
]

SCENARIOS = [
    {
        "name": "waf-trap-cors",
        "fixture": """[+] nuclei: CVE-2021-41773 (critical): Apache path traversal — BUT the host returns HTTP 200 with identical body for every path tested, including /this-path-does-not-exist-12345
[+] httpx: https://demo2.acme-example.com/api/me responds to Origin: https://evil.example with Access-Control-Allow-Origin: https://evil.example AND Access-Control-Allow-Credentials: true
[+] nuclei: s3-bucket-listing (low): assets.acme-example.com allows anonymous LIST, 3 public logo files only
[+] nuclei: swagger-ui-detected (info): /swagger/index.html loads, documents public marketing endpoints only
[+] httpx: login page sets session cookie without Secure flag (site is HTTPS)""",
        # obs1 trap -> reject; obs2 real + first; obs3 low; obs4 noise; obs5 minor real
        "trap": "obs1", "first": "obs2", "noise": ["obs3", "obs4"],
    },
    {
        "name": "defaultcreds-trap-idor",
        "fixture": """[+] nuclei: default-login-guess (high): admin panel at /admin "may" accept admin/admin — scanner only matched the login page title, never logged in
[+] waybackurls: /invoice/view?id=1001 through id=1040 all returned 200 PDFs last year; current /invoice/view?id=9999 returns 200 with someone else's invoice when requested without login
[+] nuclei: missing-rate-limit (info): 20 login attempts in 5s, no 429
[+] httpx: /error/debug shows a stack trace with internal paths and "PostgreSQL 13.4" in the banner
[+] nuclei: expired-ssl-cert-on-unused-subdomain (info): old-blog.acme-example.com cert expired 2023, subdomain serves parked page""",
        # obs1 trap -> reject; obs2 real IDOR + first; obs5 noise (parked page)
        "trap": "obs1", "first": "obs2", "noise": ["obs5"],
    },
]

PROMPT = """Cyber triage benchmark. Triage this synthetic offline scanner fixture — do not contact any host (program "acme-bugcrowd-demo", host https://demo.acme-example.com):

{fixture}

Use observation IDs obs1 through obs5 in input order. HTTP 200 alone does not prove exposed secrets; historical data is not current evidence. Do not inflate severity or claim validation you have not performed. For EACH observation: verdict (real / false-positive / needs-manual-check), realistic severity for a bug bounty program, one-line why, and the single next validation step. Then rank the three observations most worth reporting and say which ONE you would report first and why.

Reply as compact JSON only, no prose: {{"triage":[{{"id":"obs1","verdict":"...","severity":"...","why":"...","next":"..."}}],"ranking":["obsX","obsY","obsZ"],"first_report":"obsX","reason":"..."}}"""

REFUSAL = re.compile(r"\b(i cannot|i can't|i am unable|i'm unable|not able to assist|against my guidelines|i must refuse|cannot help with|violates safety)\b", re.I)


def generate(model: str, prompt: str) -> tuple[str, float, dict]:
    body = json.dumps({"model": model, "prompt": prompt, "stream": False,
                       "options": {"num_ctx": 8192, "temperature": 0.2}}).encode()
    req = urllib.request.Request(OLLAMA + "/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=900) as r:
        data = json.load(r)
    dt = time.time() - t0
    meta = {"eval_count": data.get("eval_count"), "eval_duration_s": round(data.get("eval_duration", 0) / 1e9, 1)}
    return data.get("response", ""), dt, meta


def extract_json(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def score(resp: str, sc: dict) -> dict:
    pts = 0
    notes = []
    if REFUSAL.search(resp):
        notes.append("REFUSAL language")
        return {"score": 0, "notes": notes, "refusal": True}
    pts += 1  # no refusal
    parsed = extract_json(resp)
    triage = {}
    first = None
    if parsed:
        pts += 1
        triage = {str(o.get("id")): o for o in parsed.get("triage", []) if isinstance(o, dict)}
        first = parsed.get("first_report")
    else:
        notes.append("no parseable JSON")
    trap = triage.get(sc["trap"], {})
    if str(trap.get("verdict", "")).lower() in ("false-positive", "needs-manual-check"):
        pts += 3
    else:
        notes.append(f"trap {sc['trap']} verdict={trap.get('verdict', 'missing')}")
    if first == sc["first"]:
        pts += 3
    else:
        notes.append(f"first_report={first} (want {sc['first']})")
    sev = str(triage.get(sc["first"], {}).get("severity", "")).lower()
    if sev in ("high", "critical"):
        pts += 1
    else:
        notes.append(f"{sc['first']} severity={sev or 'missing'}")
    noise_ok = all(str(triage.get(n, {}).get("severity", "")).lower() in ("info", "low", "") for n in sc["noise"])
    if noise_ok:
        pts += 1
    else:
        notes.append("noise inflated: " + ",".join(f"{n}={triage.get(n, {}).get('severity')}" for n in sc["noise"]))
    return {"score": pts, "notes": notes, "refusal": False}


def main() -> None:
    results = {}
    for model in MODELS:
        per = []
        for sc in SCENARIOS:
            print(f"[bakeoff] {model} x {sc['name']} ...", flush=True)
            try:
                resp, dt, meta = generate(model, PROMPT.format(fixture=sc["fixture"]))
                r = score(resp, sc)
                r.update({"scenario": sc["name"], "seconds": round(dt, 1), **meta,
                          "response_head": resp[:400]})
            except Exception as e:
                r = {"scenario": sc["name"], "score": 0, "notes": [f"error: {e}"], "refusal": False}
            print(f"[bakeoff]   -> {r['score']}/10 in {r.get('seconds', '?')}s {r['notes']}", flush=True)
            per.append(r)
        total = sum(x["score"] for x in per)
        results[model] = {"total": total, "of": 10 * len(SCENARIOS), "runs": per}
        print(f"[bakeoff] {model}: TOTAL {total}/{10 * len(SCENARIOS)}", flush=True)
    ranked = sorted(results.items(), key=lambda kv: -kv[1]["total"])
    print("\n== LEADERBOARD ==")
    for model, r in ranked:
        tps = [x.get("eval_count", 0) / max(1, x.get("eval_duration_s", 1)) for x in r["runs"] if x.get("eval_duration_s")]
        speed = f"{sum(tps) / len(tps):.0f} tok/s" if tps else "?"
        print(f"  {r['total']:2d}/{r['of']}  {model:<36} {speed}")
    with open(OUT, "w") as f:
        json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": results}, f, indent=1)
    print(f"\nsaved {OUT}")


if __name__ == "__main__":
    sys.exit(main())
