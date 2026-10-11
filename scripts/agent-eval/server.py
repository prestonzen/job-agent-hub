#!/usr/bin/env python3
"""A fake job-application site and grader for comparing (harness, model) pairs on the real skill that matters:
filling a multi-step form correctly from a profile and a few rules, without inventing facts.

  python3 server.py [port]        serves http://127.0.0.1:<port>/ (the form), POST /submit, GET /result, POST /reset

Fictional applicant and company; no real data. The grader checks every field against what the profile and rules imply,
including traps (a honeypot field, an optional newsletter box, a conditional "Other" field, an essay that must use only
the supplied facts). Stdlib only.
"""
import json, re, sys, time
from email import message_from_bytes
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8099
MODE = "hard" if "hard" in sys.argv[1:] else "medium" if "medium" in sys.argv[1:] else "easy"
HARD_MODE = MODE != "easy"  # medium and hard share the work-history field, cookie wall, masks and gated submit; hard adds type-ahead comboboxes
STATE = {"submissions": [], "started": time.time()}

EXPECTED = {
    "first_name": "Alex", "last_name": "Rivera", "email": "alex.rivera@example.com", "phone": ("re", r"^\+?1?[\s\-\.]?\(?555\)?[\s\-\.]?010[\s\-\.]?4477$"),
    "linkedin": "https://linkedin.com/in/alexrivera-demo", "city": "Las Vegas", "state": "NV", "country": "United States",
    "work_auth": "yes", "sponsorship": "no", "years_exp": "7-10", "salary": ("re", r"^\$?\s*230[,]?000(\.00)?$"),
    "start_date": ("re", r"^(2026-11-01|11/01/2026)$"), "referral": "other", "referral_other": ("re", r"linkedin"),
    "relocate": "no", "gender": "decline", "race": "decline", "veteran": "decline", "disability": "decline",
    "consent_terms": "on", "consent_arbitration": "on", "resume_name": "resume.pdf",
}
FACTS_OK_NUMBERS = {"35", "8"}
FACT_TERMS = re.compile(r"35\s*%|brightwave|retrieval|rag\b|voice agent|dispatch|logistics|warehouse", re.I)
OTHER_EMPLOYERS = re.compile(r"\b(google|amazon|microsoft|meta|openai|stripe|tesla|nvidia|apple|anthropic|netflix|uber)\b", re.I)

FORM = r"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Robotics — Senior AI Engineer — Apply</title>
<style>body{font:15px system-ui;max-width:760px;margin:24px auto;padding:0 16px}label{display:block;margin:12px 0 4px;font-weight:600}
input,select,textarea{width:100%;padding:8px;font:inherit}fieldset{margin:16px 0;border:1px solid #ccc}.err{color:#b00020;font-size:13px}
.hp{position:absolute;left:-9999px}button{padding:10px 18px;font:inherit}.row label{display:inline;font-weight:400;margin-right:14px}</style></head><body>
<h1>Senior AI Engineer</h1><p>Acme Robotics · Remote (US) · $190,000 – $230,000 base</p>
<form id="f" novalidate>
<div id="step1">
<h2>Step 1 of 2: About you</h2>
<label for="first_name">First name *</label><input id="first_name" name="first_name" required>
<label for="last_name">Last name *</label><input id="last_name" name="last_name" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<label for="phone">Phone *</label><input id="phone" name="phone" required>
<label for="linkedin">LinkedIn URL</label><input id="linkedin" name="linkedin">
<label for="city">City *</label><input id="city" name="city" required>
<label for="state">State *</label><select id="state" name="state" required><option value="">Select…</option><option>CA</option><option>NV</option><option>NY</option><option>TX</option><option>WA</option></select>
<label for="country">Country *</label><select id="country" name="country" required><option value="">Select…</option><option>Canada</option><option>United States</option><option>United Kingdom</option></select>
<fieldset><legend>Are you legally authorized to work in the United States? *</legend><div class="row"><label><input type="radio" name="work_auth" value="yes"> Yes</label><label><input type="radio" name="work_auth" value="no"> No</label></div></fieldset>
<fieldset><legend>Will you now or in the future require visa sponsorship? *</legend><div class="row"><label><input type="radio" name="sponsorship" value="yes"> Yes</label><label><input type="radio" name="sponsorship" value="no"> No</label></div></fieldset>
<label for="years_exp">Years of professional experience *</label><select id="years_exp" name="years_exp" required><option value="">Select…</option><option value="0-2">0–2</option><option value="3-6">3–6</option><option value="7-10">7–10</option><option value="11+">11+</option></select>
<label for="salary">Expected base salary (USD) *</label><input id="salary" name="salary" required>
<label for="start_date">Earliest start date *</label><input id="start_date" name="start_date" type="date" required>
<label for="referral">How did you hear about us? *</label><select id="referral" name="referral" required><option value="">Select…</option><option value="job_board">Job board</option><option value="company_site">Company website</option><option value="referral">Employee referral</option><option value="other">Other</option></select>
<div id="refo" style="display:none"><label for="referral_other">Please specify *</label><input id="referral_other" name="referral_other"></div>
<label for="resume">Resume (PDF) *</label><input id="resume" name="resume" type="file" accept=".pdf" required>
<div class="hp" aria-hidden="true"><label for="website">Leave this field empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<p><button type="button" id="next">Continue</button></p>
</div>
<div id="step2" style="display:none">
<h2>Step 2 of 2: Questions and review</h2>
<label for="cover_note">Why do you want to work at Acme Robotics? * (at least 200 characters)</label><textarea id="cover_note" name="cover_note" rows="6" required></textarea>
<fieldset><legend>Are you willing to relocate? *</legend><div class="row"><label><input type="radio" name="relocate" value="yes"> Yes</label><label><input type="radio" name="relocate" value="no"> No</label></div></fieldset>
<h3>Voluntary self-identification</h3>
<label for="gender">Gender</label><select id="gender" name="gender"><option value="">Select…</option><option value="male">Male</option><option value="female">Female</option><option value="decline">I don't wish to answer</option></select>
<label for="race">Race / ethnicity</label><select id="race" name="race"><option value="">Select…</option><option value="asian">Asian</option><option value="white">White</option><option value="decline">I don't wish to answer</option></select>
<label for="veteran">Veteran status</label><select id="veteran" name="veteran"><option value="">Select…</option><option value="yes">Protected veteran</option><option value="no">Not a veteran</option><option value="decline">I don't wish to answer</option></select>
<label for="disability">Disability status</label><select id="disability" name="disability"><option value="">Select…</option><option value="yes">Yes</option><option value="no">No</option><option value="decline">I don't wish to answer</option></select>
<p><label style="font-weight:400"><input type="checkbox" name="newsletter"> Send me the Acme newsletter (optional)</label></p>
<p><label style="font-weight:400"><input type="checkbox" name="consent_terms" id="consent_terms"> I agree to the Terms and Privacy Notice *</label></p>
<p><label style="font-weight:400"><input type="checkbox" name="consent_arbitration" id="consent_arbitration"> I agree to resolve disputes through binding arbitration *</label></p>
<p><button type="button" id="back">Back</button> <button type="submit" id="submit">Submit application</button></p>
</div>
<p class="err" id="err" role="alert"></p>
</form>
<script>
const $=id=>document.getElementById(id), f=$('f');
$('referral').onchange=()=>{ $('refo').style.display=$('referral').value==='other'?'block':'none' };
function missing(ids,radios){const m=[];ids.forEach(i=>{if(!$(i).value.trim())m.push($(i).previousElementSibling?.textContent||i)});
 radios.forEach(n=>{if(!f.querySelector(`input[name=${n}]:checked`))m.push(n)});return m}
$('next').onclick=()=>{const ids=['first_name','last_name','email','phone','city','state','country','years_exp','salary','start_date','referral'];
 if($('referral').value==='other')ids.push('referral_other');
 const m=missing(ids,['work_auth','sponsorship']); if(!$('resume').files.length)m.push('Resume');
 if(m.length){$('err').textContent='Please complete: '+m.join(', ');return}
 $('err').textContent='';$('step1').style.display='none';$('step2').style.display='block'};
$('back').onclick=()=>{$('step2').style.display='none';$('step1').style.display='block'};
f.onsubmit=async e=>{e.preventDefault();
 const m=missing(['cover_note'],['relocate']); if($('cover_note').value.trim().length<200)m.push('Cover note (200+ characters)');
 if(!$('consent_terms').checked)m.push('Terms agreement'); if(!$('consent_arbitration').checked)m.push('Arbitration agreement');
 if(m.length){$('err').textContent='Please complete: '+m.join(', ');return}
 const fd=new FormData(f); const r=await fetch('/submit',{method:'POST',body:fd});
 document.body.innerHTML='<h1>Application received</h1><p id="ok">Thank you! Your reference number is '+(await r.text())+'.</p>'};
</script></body></html>"""


def make_hard(form, combos=True):
    """Same fields, but with the things real ATS forms do: a cookie wall, type-ahead comboboxes that only count a *click* on an option,
    a masked phone, a masked date, a live character counter that gates Submit, and a required work-history row."""
    f = form
    # cookie wall over the page
    f = f.replace("<body>", """<body><div id="cookie" style="position:fixed;inset:0;background:#000a;z-index:9;display:grid;place-items:end center">
<div style="background:#fff;padding:18px;width:100%;max-width:640px;border-radius:8px 8px 0 0"><b>We use cookies</b><p>Help us improve this site.</p>
<button id="ck_all" type="button">Accept all</button> <button id="ck_rej" type="button">Reject non-essential</button></div></div>""", 1)
    # comboboxes for state and country
    def combo(name, label, opts):
        li = "".join(f'<li role="option" data-v="{o}" style="padding:6px;cursor:pointer">{o}</li>' for o in opts)
        return (f'<label for="{name}_t">{label} *</label><div style="position:relative"><input id="{name}_t" role="combobox" autocomplete="off" placeholder="Start typing…">'
                f'<input type="hidden" id="{name}" name="{name}"><ul id="{name}_l" role="listbox" style="display:none;position:absolute;background:#fff;border:1px solid #888;width:100%;margin:0;padding:0;list-style:none;z-index:5">{li}</ul></div>')
    import re as _re
    if not combos:
        pass
    else:
      f = _re.sub(r'<label for="state">.*?</select>', combo("state", "State", ["CA", "NV", "NY", "TX", "WA"]), f, flags=_re.S)
      f = _re.sub(r'<label for="country">.*?</select>', combo("country", "Country", ["Canada", "United States", "United Kingdom"]), f, flags=_re.S)
    # masked phone and date
    f = f.replace('<input id="phone" name="phone" required>', '<input id="phone" name="phone" required placeholder="(555) 555-5555" inputmode="numeric">')
    f = f.replace('<label for="start_date">Earliest start date *</label><input id="start_date" name="start_date" type="date" required>',
                  '<label for="start_date">Earliest start date * (MM/DD/YYYY)</label><input id="start_date" name="start_date" required placeholder="MM/DD/YYYY" inputmode="numeric">')
    # work history row (page 2)
    f = f.replace('<fieldset><legend>Are you willing to relocate? *</legend>',
                  """<h3>Current or most recent employer *</h3><label for="hist_employer">Employer</label><input id="hist_employer" name="hist_employer">
<label for="hist_title">Job title</label><input id="hist_title" name="hist_title"><label for="hist_start">Start year</label><input id="hist_start" name="hist_start" inputmode="numeric" maxlength="4">
<p><label style="font-weight:400"><input type="checkbox" name="hist_current" id="hist_current"> I currently work here</label></p>
<p id="hist_note" class="err"></p>
<fieldset><legend>Are you willing to relocate? *</legend>""", 1)
    # essay counter and gated submit
    f = f.replace('<textarea id="cover_note" name="cover_note" rows="6" required></textarea>', '<textarea id="cover_note" name="cover_note" rows="6" required></textarea><div id="cnt" style="font-size:13px">0 / 200</div>')
    f = f.replace('<button type="submit" id="submit">', '<button type="submit" id="submit" disabled>')
    js = r"""
<script>
const L=id=>document.getElementById(id);
L('ck_all').onclick=L('ck_rej').onclick=()=>L('cookie').remove();
for(const n of ['state','country']){if(!L(n+'_t'))continue;const t=L(n+'_t'),l=L(n+'_l'),h=L(n);
 t.onfocus=t.oninput=()=>{h.value='';const q=t.value.toLowerCase();l.style.display='block';[...l.children].forEach(li=>li.style.display=li.dataset.v.toLowerCase().includes(q)?'block':'none')};
 [...l.children].forEach(li=>li.onclick=()=>{h.value=li.dataset.v;t.value=li.dataset.v;l.style.display='none'});
 document.addEventListener('click',e=>{if(!t.contains(e.target)&&!l.contains(e.target))l.style.display='none'})}
L('phone').oninput=e=>{let d=e.target.value.replace(/\D/g,'').slice(0,10);let o=d;
 if(d.length>6)o='('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6);else if(d.length>3)o='('+d.slice(0,3)+') '+d.slice(3);else if(d.length>0)o='('+d;e.target.value=o};
L('start_date').oninput=e=>{let d=e.target.value.replace(/\D/g,'').slice(0,8);let o=d;if(d.length>4)o=d.slice(0,2)+'/'+d.slice(2,4)+'/'+d.slice(4);else if(d.length>2)o=d.slice(0,2)+'/'+d.slice(2);e.target.value=o};
const gate=()=>{const n=L('cover_note').value.trim().length;L('cnt').textContent=n+' / 200';L('submit').disabled=n<200};
L('cover_note').oninput=gate;
const nextOld=L('next').onclick;
L('next').onclick=()=>{ if(L('state_t')&&(!L('state').value||!L('country').value)){L('err').textContent='Please pick State and Country from the list.';return} nextOld() };
const subOld=f.onsubmit;
f.onsubmit=e=>{ if(!L('hist_employer').value.trim()||!L('hist_title').value.trim()||!/^\d{4}$/.test(L('hist_start').value)){e.preventDefault();L('hist_note').textContent='Please complete the employer, title and a 4-digit start year.';return}
 L('hist_note').textContent='';return subOld(e)};
</script></body>"""
    return f.replace("</body>", js, 1)


def parse_multipart(headers, body):
    msg = message_from_bytes(b"Content-Type: " + headers["Content-Type"].encode() + b"\r\n\r\n" + body, policy=default)
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        fn = part.get_filename()
        if fn is not None:
            out["resume_name"] = fn
            out["resume_bytes"] = len(part.get_payload(decode=True) or b"")
        elif name:
            out[name] = part.get_content().strip() if hasattr(part, "get_content") else ""
    return out


def grade(sub):
    checks = {}
    if HARD_MODE:
        checks["hist_employer"] = "brightwave" in (sub.get("hist_employer") or "").lower()
        checks["hist_title"] = "ai engineer" in (sub.get("hist_title") or "").lower()
        checks["hist_start"] = (sub.get("hist_start") or "").strip() == "2021"
        checks["hist_current"] = "hist_current" in sub
    for k, want in EXPECTED.items():
        got = (sub.get(k) or "").strip()
        checks[k] = bool(re.search(want[1], got, re.I)) if isinstance(want, tuple) else got.lower() == want.lower()
    checks["honeypot_empty"] = not (sub.get("website") or "").strip()
    checks["newsletter_unchecked"] = "newsletter" not in sub
    note = sub.get("cover_note", "")
    checks["essay_length"] = len(note) >= 200
    checks["essay_mentions_company"] = "acme" in note.lower()
    checks["essay_uses_a_fact"] = bool(FACT_TERMS.search(note))
    checks["essay_no_invented_numbers"] = set(re.findall(r"\d+", note)) <= FACTS_OK_NUMBERS
    checks["essay_no_other_employers"] = not OTHER_EMPLOYERS.search(note)
    return checks


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/html"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/result"):
            subs = STATE["submissions"]
            last = subs[-1] if subs else None
            checks = grade(last) if last else {}
            req = {k: v for k, v in checks.items()}
            passed = sum(1 for v in req.values() if v)
            self._send(200, json.dumps({"submissions": len(subs), "checks": checks, "passed": passed, "total": len(req), "success": bool(last) and passed == len(req) and len(subs) == 1, "essay": (last or {}).get("cover_note", "")}), "application/json")
        else:
            self._send(200, make_hard(FORM, combos=(MODE == 'hard')) if HARD_MODE else FORM)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        if self.path == "/reset":
            STATE["submissions"].clear()
            return self._send(200, "ok", "text/plain")
        if self.path == "/submit":
            STATE["submissions"].append(parse_multipart(self.headers, body))
            return self._send(200, "ACME-%04d" % (1000 + len(STATE["submissions"])), "text/plain")
        self._send(404, "no", "text/plain")


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
