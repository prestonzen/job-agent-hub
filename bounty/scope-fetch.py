#!/usr/bin/env python3
"""scope-fetch.py — build the bug bounty target queue from bounty-targets-data.

Pulls the hourly-updated JSON dumps (HackerOne, Bugcrowd, Intigriti, YesWeHack),
keeps paying programs with domain/wildcard/URL assets in scope, checks each
candidate's policy page for an explicit automation clause, and writes a ranked
queue to /opt/bounty/queue.json for bounty-scan.sh to work through.

Usage:  python3 scope-fetch.py [--top N]

By default every default-allow program is written to the queue. --top N is an
optional preview/legacy cap; daily scan volume is controlled by bounty-daily.sh.
"""

import json
import hashlib
import re
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

from policy import POLICY_VERSION, explicit_prohibition, policy_text
from scope import asset_is_scannable

DATA = {
    "hackerone": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/hackerone_data.json",
    "bugcrowd": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/bugcrowd_data.json",
    "intigriti": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/intigriti_data.json",
    "yeswehack": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/yeswehack_data.json",
}

OUT = Path("/opt/bounty/queue.json")
POLICY_AUDIT = Path("/opt/bounty/policy-audit.json")
BLACKLIST = Path("/opt/bounty/policy-blacklist.json")
POLICY_TTL = 7 * 24 * 60 * 60

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) bounty-scope-fetcher (good-faith security research)"}
CTX = ssl.create_default_context()
FETCH_HOSTS = ("githubusercontent.com", "hackerone.com", "bugcrowd.com", "intigriti.com", "yeswehack.com")


def safe_fetch_url(url: str) -> bool:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    return (parsed.scheme == "https" and bool(host) and not parsed.username and not parsed.password
            and any(host == domain or host.endswith("." + domain) for domain in FETCH_HOSTS))


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not safe_fetch_url(newurl):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=CTX), SafeRedirectHandler())

# Explicit restrictions confirmed during the October 13 policy-page review. Keep these
# blocked if a site's public page is temporarily unreadable; a later readable page can
# remove the entry if the prohibition has actually been lifted.
SEED_BLACKLIST = [
    {"platform": "hackerone", "program": "Booking.com", "url": "https://hackerone.com/bookingcom", "evidence": "Using automated scanning tools to scan Booking.com assets is prohibited."},
    {"platform": "hackerone", "program": "Visa", "url": "https://hackerone.com/visa", "evidence": "Automated and AI-assisted testing must be actively supervised; the autonomous scanner is not supervised."},
    {"platform": "hackerone", "program": "Vimeo", "url": "https://hackerone.com/vimeo", "evidence": "Do not use automated tools or scanners."},
    {"platform": "hackerone", "program": "Live Nation", "url": "https://hackerone.com/livenation", "evidence": "Bots, automated scanning tools, and LLMs are prohibited in bug discovery; findings must be human-found."},
    {"platform": "hackerone", "program": "Nextcloud", "url": "https://hackerone.com/nextcloud", "evidence": "The policy says to refrain from automated testing tools."},
    {"platform": "hackerone", "program": "HackerOne", "url": "https://hackerone.com/security", "evidence": "This program prohibits automated tools, scripts, and bots."},
    {"platform": "hackerone", "program": "8x8", "url": "https://hackerone.com/8x8", "evidence": "Automated or high-volume testing requires prior coordination; none is recorded."},
    {"platform": "hackerone", "program": "Superbet", "url": "https://hackerone.com/superbet", "evidence": "The policy says not to use scanners such as Nessus or Acunetix."},
    {"platform": "hackerone", "program": "Flutter UK&I", "url": "https://hackerone.com/flutter", "evidence": "The policy disallows common vulnerability scanners; this pipeline uses Nuclei."},
    {"platform": "bugcrowd", "program": "Atlassian-Built Apps", "url": "https://bugcrowd.com/engagements/atlassianapps", "evidence": "The program strictly prohibits automated scanners and automated tools/scanners."},
]


def fetch(url: str, timeout: int = 30) -> bytes | None:
    if not safe_fetch_url(url):
        return None
    try:
        with OPENER.open(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return r.read()
    except Exception:
        return None


def policy_key(row: dict) -> str:
    return "|".join((row["platform"].lower(), row["program"].strip().lower()))


def load_json(path: Path, fallback):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, type(fallback)) else fallback
    except (OSError, ValueError):
        return fallback


def policy_verdict(row: dict, prior: dict | None, now: float) -> dict:
    """Default-allow unless readable policy text explicitly prohibits automation."""
    key = policy_key(row)
    if prior and prior.get("classifier_version") == POLICY_VERSION and now - float(prior.get("checked_at", 0)) < POLICY_TTL:
        return prior

    body = fetch(row.get("url", ""), timeout=15) if row.get("url") else None
    if not body:
        # Preserve a known ban on transient fetch failures; unseen/unreadable pages
        # follow the requested default-allow rule.
        if prior and prior.get("decision") == "blacklisted":
            return {**prior, "checked_at": now, "fetch_status": "unavailable; prior explicit ban retained"}
        return {"key": key, "platform": row["platform"], "program": row["program"], "url": row["url"],
                "decision": "default-allow", "evidence": None, "fetch_status": "unavailable; no explicit ban found",
                "checked_at": now, "content_sha256": None, "classifier_version": POLICY_VERSION}

    source = body.decode("utf-8", "ignore")
    text = policy_text(source)
    digest = hashlib.sha256(body).hexdigest()
    # A JS shell or access-denied page is not evidence that a previous prohibition
    # disappeared. For new programs, the requested default-allow behavior still applies.
    name_tokens = [token for token in re.findall(r"[a-z0-9]+", row["program"].casefold()) if token not in {"public", "bug", "bounty", "program", "managed"}]
    readable = len(text) >= 250 and bool(name_tokens) and any(token in text.casefold() for token in name_tokens) and ("scope" in text.casefold() or "policy" in text.casefold() or "rules" in text.casefold())
    evidence = explicit_prohibition(source)
    if evidence:
        decision = "blacklisted"
    elif prior and prior.get("decision") == "blacklisted" and not readable:
        decision = "blacklisted"
        evidence = prior.get("evidence")
    else:
        decision = "default-allow"

    return {"key": key, "platform": row["platform"], "program": row["program"], "url": row["url"],
            "decision": decision, "evidence": evidence, "fetch_status": "readable" if readable else "page text incomplete",
            "checked_at": now, "content_sha256": digest, "classifier_version": POLICY_VERSION}


def norm_program(platform: str, p: dict) -> dict | None:
    """Normalize one program entry from any of the 4 platform dumps. None = skip."""
    if platform == "hackerone":
        pays = bool(p.get("offers_bounties"))
        ident_of = lambda t: t.get("asset_identifier")  # noqa: E731
        type_of = lambda t: (t.get("asset_type") or t.get("type") or "")  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = None
        triage_h = p.get("average_time_to_first_program_response") if isinstance(p.get("average_time_to_first_program_response"), (int, float)) else None
    elif platform == "bugcrowd":
        pays = bool(p.get("max_payout"))
        ident_of = lambda t: t.get("target") or t.get("uri")  # noqa: E731
        type_of = lambda t: t.get("type") or ""  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = p.get("max_payout") or None
        triage_h = None
    elif platform == "intigriti":
        pays = bool(p.get("max_bounty"))
        ident_of = lambda t: t.get("endpoint")  # noqa: E731
        type_of = lambda t: t.get("type") or ""  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = p.get("max_bounty") or None
        triage_h = None
    else:  # yeswehack
        pays = bool(p.get("max_bounty")) and p.get("public", True) and not p.get("disabled")
        ident_of = lambda t: t.get("target")  # noqa: E731
        type_of = lambda t: t.get("type") or ""  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = p.get("max_bounty") or None
        triage_h = None

    if not pays:
        return None
    assets = set()
    for t in p.get("targets", {}).get("in_scope", []):
        ident = (ident_of(t) or "").strip()
        if not ident or ident.lower() in ("all", "*"):
            # "all" scope: note it via the program website if there is one
            ident = (p.get("website") or "").strip()
            if not ident:
                continue
        atype = type_of(t).strip().lower()
        if asset_is_scannable(ident, atype):
            assets.add(ident)
    if not assets:
        return None
    return {
        "platform": platform,
        "program": name,
        "url": url,
        "assets": sorted(assets),
        "wildcards": sorted(a for a in assets if "*" in a),
        "out_of_scope": sorted({(ident_of(t) or "").strip() for t in p.get("targets", {}).get("out_of_scope", []) if (ident_of(t) or "").strip()}),
        "asset_count": len(assets),
        "max_bounty": maxb,
        "triage_h": triage_h,
        "automation": "unchecked",
    }


def main() -> None:
    top: int | None = None
    args = sys.argv[1:]
    if "--no-policy-check" in args:
        raise SystemExit("--no-policy-check is disabled: every fresh program must pass the explicit-ban check")
    if "--top" in args:
        top = int(args[args.index("--top") + 1])

    candidates: list[dict] = []
    for platform, url in DATA.items():
        raw = fetch(url, timeout=60)
        if not raw:
            print(f"{platform}: fetch failed, skipping", file=sys.stderr)
            continue
        programs = json.loads(raw)
        n = 0
        for p in programs:
            row = norm_program(platform, p)
            if row:
                candidates.append(row)
                n += 1
        print(f"{platform}: {n} paying programs with in-scope assets")

    # Biggest attack surface first; merge the same program listed on multiple platforms
    # (dedupe by normalized name — keep the entry with the most assets, note the rest).
    merged: dict[str, dict] = {}
    for c in candidates:
        k = re.sub(r"[^a-z0-9]", "", c["program"].lower())
        if k in merged:
            prev = merged[k]
            prev.setdefault("also_on", []).append(c["platform"])
            if c["asset_count"] > prev["asset_count"]:
                c["also_on"] = prev.get("also_on", []) + [prev["platform"]]
                merged[k] = c
        else:
            merged[k] = c
    dupes = len(candidates) - len(merged)
    if dupes:
        print(f"merged {dupes} cross-platform duplicates")
    candidates = list(merged.values())
    candidates.sort(key=lambda c: -c["asset_count"])
    print(f"checking policies for all {len(candidates)} candidates (7-day refresh; explicit-ban blacklist)...")
    now = time.time()
    audits = load_json(POLICY_AUDIT, {})
    existing_blacklist = load_json(BLACKLIST, {"programs": []}).get("programs", [])
    blacklist_by_key = {entry.get("key"): entry for entry in existing_blacklist if isinstance(entry, dict) and entry.get("key")}
    seed_by_key = {}
    for entry in SEED_BLACKLIST:
        row = {"platform": entry["platform"], "program": entry["program"], "url": entry["url"]}
        seed_by_key[policy_key(row)] = {"key": policy_key(row), **entry, "decision": "blacklisted", "checked_at": 0,
                                       "fetch_status": "seeded from policy review"}
    for key, entry in seed_by_key.items():
        blacklist_by_key.setdefault(key, entry)

    priors = {policy_key(c): audits.get(policy_key(c)) or blacklist_by_key.get(policy_key(c)) or seed_by_key.get(policy_key(c)) for c in candidates}
    with ThreadPoolExecutor(max_workers=8) as ex:
        records = list(ex.map(lambda c: policy_verdict(c, priors[policy_key(c)], now), candidates))
    for c, record in zip(candidates, records):
        key = policy_key(c)
        audits[key] = record
        c["automation"] = record["decision"]
        c["policy_evidence"] = record.get("evidence")
        c["policy_checked_at"] = record.get("checked_at")
        if record["decision"] == "blacklisted":
            blacklist_by_key[key] = record
        else:
            blacklist_by_key.pop(key, None)
    POLICY_AUDIT.parent.mkdir(parents=True, exist_ok=True)
    POLICY_AUDIT.write_text(json.dumps(audits, indent=2))
    BLACKLIST.write_text(json.dumps({"generated": now, "programs": sorted(blacklist_by_key.values(), key=lambda x: (x["platform"], x["program"]))}, indent=2))

    banned = [c for c in candidates if c["automation"] == "blacklisted"]
    for b in banned:
        print(f"  blacklisted (explicit policy): {b['program']} — {b.get('policy_evidence') or 'prior explicit ban retained while policy page is unreadable'}")
    candidates = [c for c in candidates if c["automation"] == "default-allow"]
    candidates.sort(key=lambda c: (c["triage_h"] if c["triage_h"] is not None else 9999, -c["asset_count"]))

    # Keep the whole default-allow backlog available. The daily scheduler selects
    # only TOP entries, so queue size never becomes an instruction to scan them all.
    queue = candidates if top is None else candidates[:top]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"generated": __import__("time").time(), "programs": queue}, indent=2))
    OUT.chmod(0o644)
    print(f"\nqueue written: {OUT} ({len(queue)} programs; {len(banned)} explicitly blacklisted)")
    for c in queue[:12]:
        print(f"  [{c['automation']:<12}] {c['program']:<40} {c['asset_count']:>4} assets  ({c['platform']})")


if __name__ == "__main__":
    main()
