#!/usr/bin/env python3
"""jev-apply.py — fast-path job application filler (Jev Ultrafast + direct CDP).

Fills standard application forms in ~20-60s instead of a full agent CLI session.
Designed for Greenhouse/Lever-style forms WITHOUT essay questions (essays stay with
the full agents for voice quality). Composes with the other runner helpers:
  - outcome "captcha:*"    -> caller runs form-assist.mjs, injects token, re-submits
  - outcome "email-code"   -> caller runs inbox-assist.mjs and types the code

Run on the runner (kloud CT 218):
  BU_CDP_URL=http://127.0.0.1:9222 DISPLAY=:99 \
    uv run --env-file /etc/job-agent-runner/jev.env --project /opt/jev-ultrafast \
    python /opt/job-agent-runner/jev-apply.py --url <job-url> [--resume <path>] [--submit]

Stdout: one JSON line: {ok, url, filled, resumeUploaded, submitted, outcome, detail, actions, elapsedMs}
Exit 0 when ok=true, 1 otherwise. Never submits unless --submit is passed.
"""
import argparse
import json
import re
import sys
import time

DEFAULT_PROFILE = "/etc/job-agent-runner/applicant.json"

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def raw_eval(br, expr):
    """Runtime.evaluate WITHOUT jev's freshness guard.

    br.evaluate raises StalePage the moment React re-renders the document — which is
    exactly what happens right after we touch a form. The wrapper only ever evaluates
    idempotent read/write snippets, so freshness tracking is counterproductive here.
    """
    r = br.call("Runtime.evaluate", expression=expr, returnByValue=True)
    if r.get("exceptionDetails"):
        raise RuntimeError(str(r["exceptionDetails"])[:200])
    return r.get("result", {}).get("value")

def greenhouse_anchor(url: str) -> str:
    if "job-boards.greenhouse.io" in url and "#" not in url:
        return url + "#app_form"
    return url

def build_goal(p: dict, submit: bool) -> str:
    auth = p.get("workAuthorization", {})
    goal = (
        "You are filling a job application form. First accept or close any cookie/consent banner. "
        "The Application form is further down the page: SCROLL_DOWN to reveal its fields "
        "(do NOT click any in-page 'Apply' anchor button). Fill these fields exactly: "
        f"first name {p['firstName']}, last name {p['lastName']}, email {p['email']}, "
        f"phone {p['phone']}, location/city: {p['location']}. "
    )
    if p.get("linkedin"):
        goal += f"LinkedIn profile: {p['linkedin']}. "
    if p.get("website"):
        goal += f"Portfolio/website: {p['website']}. "
    if p.get("github"):
        goal += f"GitHub: {p['github']}. "
    if auth:
        goal += (
            "For dropdowns about work authorization or visa sponsorship choose: "
            f"'{auth.get('authorized', 'Yes, I am authorized to work in the United States')}' style option for authorization and "
            f"'{auth.get('sponsorship', 'No')}' for sponsorship. "
        )
    goal += (
        "Leave long free-text essay questions EMPTY (a human writes those later). "
        "Do NOT upload any file and do NOT touch file inputs. "
    )
    if submit:
        goal += "When every field above is filled, click the form's Submit button once."
    else:
        goal += "Do NOT click Submit. STOP (DONE) as soon as the listed fields are filled."
    return goal

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--resume", default=None)
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--timeout", type=int, default=240, help="overall seconds budget")
    ap.add_argument("--profile", default=DEFAULT_PROFILE)
    args = ap.parse_args()

    started = time.time()
    with open(args.profile) as f:
        profile = json.load(f)
    url = greenhouse_anchor(args.url)
    goal = build_goal(profile, args.submit)

    from jev_ultrafast import Agent  # noqa: E402  (inside main so --help stays fast)

    result = {"ok": False, "url": url, "filled": {}, "resumeUploaded": False,
              "submitted": False, "outcome": "unknown", "detail": None, "actions": 0}
    try:
        with Agent(url, goal) as agent:
            deadline = started + args.timeout
            run_error = None
            try:
                for state in agent.run():
                    h = state["history"][-1] if state["history"] else None
                    if h:
                        log(state["elapsed_ms"], state["status"], "|", h["kind"], "|", h["action"][:80])
                    result["actions"] = len(state["history"])
                    if state["status"] in ("done", "blocked") or time.time() > deadline:
                        break
            except Exception as e:  # noqa: BLE001 — keep the browser, verify what got filled
                run_error = e
                log("run interrupted:", e)

            br = agent.browser
            # --- verify filled values ---
            filled = raw_eval(br,
                "(() => { const out = {}; document.querySelectorAll('input,textarea').forEach(i => {"
                " if (i.value && !['checkbox','radio','file','password','hidden'].includes(i.type))"
                "   out[i.name || i.id || i.type] = i.value; }); return out; })()"
            ) or {}
            result["filled"] = filled

            # --- remaining EMPTY required fields -> hand off to a full agent (essays etc.) ---
            try:
                missing = raw_eval(br,
                    "(() => { const out = [];"
                    " document.querySelectorAll('input[required], select[required], textarea[required],"
                    "   [aria-required=true] input, [aria-required=true] textarea, [aria-required=true] select').forEach(i => {"
                    "   if (['checkbox','radio','file','hidden'].includes(i.type)) return;"
                    "   if (!i.value) { const lab = i.id ? document.querySelector('label[for=\"' + CSS.escape(i.id) + '\"]') : null;"
                    "     out.push((lab ? lab.textContent : (i.name || i.id || i.type)).trim().slice(0, 80)); } });"
                    " return out; })()"
                ) or []
            except Exception as e:  # noqa: BLE001
                missing = []
                log("missing-check failed:", e)
            if missing:
                result["outcome"] = "needs-agent"
                result["detail"] = "required fields left empty: " + "; ".join(missing[:6])
                log("missing required:", missing[:6])

            # --- resume upload via direct CDP (outside Jev's action space).
            # Greenhouse re-renders the file input when the page state changes: after a
            # successful set, React REPLACES the input with a filename chip, so success =
            # the filename appearing in the page (or files.length > 0 if it kept the input). ---
            if args.resume:
                fname = args.resume.replace("\\", "/").rsplit("/", 1)[-1]
                for up in range(3):
                    try:
                        doc = br.call("DOM.getDocument", depth=-1)["root"]["nodeId"]
                        nodes = br.call("DOM.querySelectorAll", nodeId=doc, selector="input[type=file]")["nodeIds"]
                        if not nodes:
                            # input gone — maybe already attached on a previous attempt
                            seen = raw_eval(br, "document.body.innerText.includes(" + json.dumps(fname) + ")")
                            if seen:
                                result["resumeUploaded"] = True
                                break
                            log(f"upload attempt {up+1}: no file input in DOM")
                            time.sleep(1)
                            continue
                        target = None
                        for nid in nodes:
                            attrs = br.call("DOM.getAttributes", nodeId=nid).get("attributes", [])
                            blob = " ".join(attrs).lower()
                            if any(k in blob for k in ("resume", "cv")):
                                target = nid
                                break
                        target = target or nodes[0]
                        br.call("DOM.setFileInputFiles", files=[args.resume], nodeId=target)
                        raw_eval(br,
                            "(() => { document.querySelectorAll('input[type=file]').forEach(i => {"
                            "   i.dispatchEvent(new Event('input', {bubbles:true}));"
                            "   i.dispatchEvent(new Event('change', {bubbles:true})); }); return true; })()"
                        )
                        time.sleep(1.5)
                        stuck = raw_eval(br,
                            "(() => { let n = 0; document.querySelectorAll('input[type=file]').forEach(i => n += i.files.length); return n; })()"
                        )
                        seen = raw_eval(br, "document.body.innerText.includes(" + json.dumps(fname) + ")")
                        if stuck or seen:
                            result["resumeUploaded"] = True
                            break
                        log(f"upload attempt {up+1}: files did not stick (React re-render?)")
                    except Exception as e:  # noqa: BLE001
                        log(f"upload attempt {up+1} error: {e}")
                    time.sleep(1)
                log("resume upload:", "ok" if result["resumeUploaded"] else "FAILED")

            # --- optional submit (when not done by the agent) ---
            if args.submit and not result["submitted"]:
                clicked = raw_eval(br,
                    "(() => { const b = document.querySelector('#submit_app, button[type=submit], input[type=submit]')"
                    " || [...document.querySelectorAll('button')].find(x => /submit/i.test(x.textContent));"
                    " if (b) { b.scrollIntoView(); b.click(); return true; } return false; })()"
                )
                log("submit click:", clicked)

            # --- outcome detection ---
            if args.submit:
                odeadline = time.time() + 45
                while time.time() < odeadline:
                    state = raw_eval(br,
                        "(() => { const t = document.body ? document.body.innerText.slice(0, 4000) : '';"
                        " return { url: location.href,"
                        "  captcha: !!(document.querySelector('iframe[src*=hcaptcha]') ? 'hcaptcha' :"
                        "     (document.querySelector('.cf-turnstile, iframe[src*=challenges.cloudflare]') ? 'turnstile' :"
                        "     (document.querySelector('.g-recaptcha, iframe[src*=recaptcha]') ? 'recaptcha' : null))),"
                        "  code: /security code|verification code|enter the code/i.test(t),"
                        "  done: /application (has been )?submitted|application received|thanks for applying|thank you for your application/i.test(t)"
                        "     || /confirmation|thanks/i.test(location.pathname) }; })()"
                    ) or {}
                    if state.get("done"):
                        result.update(ok=True, submitted=True, outcome="submitted", detail=state["url"])
                        break
                    if state.get("captcha"):
                        result.update(outcome=f"captcha:{state['captcha']}", detail="solve via form-assist.mjs, inject token, then resubmit")
                        break
                    if state.get("code"):
                        result.update(outcome="email-code", detail="code emailed; use inbox-assist.mjs and type it here")
                        break
                    time.sleep(2)
                else:
                    result["detail"] = "no confirmation/captcha/code detected within 45s of submit"
            else:
                result["ok"] = bool(result["filled"]) and result["outcome"] != "needs-agent"
                if result["outcome"] != "needs-agent":
                    result["outcome"] = "filled-only"
            if run_error is not None and not result["ok"]:
                result["outcome"] = "needs-agent"
                result["detail"] = f"run interrupted: {run_error}"[:300]
    except Exception as e:  # noqa: BLE001
        result["detail"] = f"{type(e).__name__}: {e}"
    result["elapsedMs"] = int((time.time() - started) * 1000)
    print(json.dumps(result))
    return 0 if result["ok"] else 1

if __name__ == "__main__":
    sys.exit(main())
