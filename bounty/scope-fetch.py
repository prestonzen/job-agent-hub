#!/usr/bin/env python3
"""scope-fetch.py — build the bug bounty target queue from bounty-targets-data.

Pulls the hourly-updated JSON dumps (HackerOne, Bugcrowd, Intigriti, YesWeHack),
keeps paying programs with domain/wildcard/URL assets in scope, checks each
candidate's policy page for an explicit automation clause, and writes a ranked
queue to /opt/bounty/queue.json for bounty-scan.sh to work through.

Usage:  python3 scope-fetch.py [--top N] [--no-policy-check]
"""

import json
import re
import ssl
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DATA = {
    "hackerone": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/hackerone_data.json",
    "bugcrowd": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/bugcrowd_data.json",
    "intigriti": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/intigriti_data.json",
    "yeswehack": "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/yeswehack_data.json",
}

OUT = Path("/opt/bounty/queue.json")

# Web-scannable asset classes (the dumps use asset_type with UPPERCASE enums; some entries
# carry neither key — accept those when the identifier itself looks like a host or URL).
ASSET_TYPES = {"domain", "wildcard", "url", "website", "api", "other", "cidr"}
SKIP_TYPES = {"source_code", "hardware", "smart_contract", "android_play_store", "android_apk",
              "apple_app_store", "ios", "windows_app_store", "executable", "blockchain"}
HOSTLIKE = re.compile(r"^\*?\.?[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(/|$|\?)", re.I)
URLLIKE = re.compile(r"^https?://", re.I)

# Policy signals. Programs that explicitly bless automation go first; explicit bans are dropped.
AUTO_OK = re.compile(r"(automated (scanning|testing|tools).{0,80}(allow|permit|ok|fine|accept)|(allow|permit|welcome).{0,80}automated)", re.I | re.S)
AUTO_BAN = re.compile(r"(no|prohibit|not allowed|forbidden|do not use).{0,80}(automated|scanner|scanning|automation)|(automated|scanner).{0,80}(no|prohibit|not allowed|forbidden|banned)", re.I | re.S)
RATE_LIMIT = re.compile(r"(rate limit|requests per second|rps|throttl)", re.I)

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) bounty-scope-fetcher (good-faith security research)"}
CTX = ssl.create_default_context()


def fetch(url: str, timeout: int = 30) -> bytes | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout, context=CTX) as r:
            return r.read()
    except Exception:
        return None


def policy_verdict(url: str) -> str:
    """Fetch the program policy page; look for an automation clause."""
    if not url:
        return "unknown"
    body = fetch(url, timeout=15)
    if not body:
        return "unknown"
    text = re.sub(r"<[^>]+>", " ", body.decode("utf-8", "ignore"))
    if AUTO_BAN.search(text):
        return "banned"
    if AUTO_OK.search(text):
        return "allowed"
    if RATE_LIMIT.search(text):
        return "rate-limited"  # automation mentioned only via rate limits: tolerated with care
    return "unspecified"


def norm_program(platform: str, p: dict) -> dict | None:
    """Normalize one program entry from any of the 4 platform dumps. None = skip."""
    if platform == "hackerone":
        pays = bool(p.get("offers_bounties"))
        ident_of = lambda t: t.get("asset_identifier")  # noqa: E731
        type_of = lambda t: (t.get("asset_type") or t.get("type") or "")  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = None
    elif platform == "bugcrowd":
        pays = bool(p.get("max_payout"))
        ident_of = lambda t: t.get("target") or t.get("uri")  # noqa: E731
        type_of = lambda t: t.get("type") or ""  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = p.get("max_payout") or None
    elif platform == "intigriti":
        pays = bool(p.get("max_bounty"))
        ident_of = lambda t: t.get("endpoint")  # noqa: E731
        type_of = lambda t: t.get("type") or ""  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = p.get("max_bounty") or None
    else:  # yeswehack
        pays = bool(p.get("max_bounty")) and p.get("public", True) and not p.get("disabled")
        ident_of = lambda t: t.get("target")  # noqa: E731
        type_of = lambda t: t.get("type") or ""  # noqa: E731
        url = p.get("url", "")
        name = p.get("name", "?")
        maxb = p.get("max_bounty") or None

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
        if atype in SKIP_TYPES:
            continue
        if atype in ASSET_TYPES or HOSTLIKE.match(ident) or URLLIKE.match(ident):
            assets.add(ident)
    if not assets:
        return None
    return {
        "platform": platform,
        "program": name,
        "url": url,
        "assets": sorted(assets),
        "wildcards": sorted(a for a in assets if "*" in a),
        "asset_count": len(assets),
        "max_bounty": maxb,
        "automation": "unchecked",
    }


def main() -> None:
    top = 40
    check_policy = True
    args = sys.argv[1:]
    if "--no-policy-check" in args:
        check_policy = False
        args.remove("--no-policy-check")
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

    # Biggest attack surface first.
    candidates.sort(key=lambda c: -c["asset_count"])
    candidates = candidates[: top * 2]  # check policy on 2x, keep top N after filtering

    if check_policy:
        print(f"checking policies for {len(candidates)} candidates...")
        with ThreadPoolExecutor(max_workers=8) as ex:
            verdicts = list(ex.map(lambda c: policy_verdict(c["url"]), candidates))
        for c, v in zip(candidates, verdicts):
            c["automation"] = v
        banned = [c for c in candidates if c["automation"] == "banned"]
        for b in banned:
            print(f"  dropped (automation banned): {b['program']}")
        candidates = [c for c in candidates if c["automation"] != "banned"]
        # Order: allowed > rate-limited > unspecified > unknown, then scope size.
        rank = {"allowed": 0, "rate-limited": 1, "unspecified": 2, "unknown": 3, "unchecked": 2}
        candidates.sort(key=lambda c: (rank.get(c["automation"], 3), -c["asset_count"]))

    queue = candidates[:top]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"generated": __import__("time").time(), "programs": queue}, indent=2))
    OUT.chmod(0o644)
    print(f"\nqueue written: {OUT} ({len(queue)} programs)")
    for c in queue[:12]:
        print(f"  [{c['automation']:<12}] {c['program']:<40} {c['asset_count']:>4} assets  ({c['platform']})")


if __name__ == "__main__":
    main()
