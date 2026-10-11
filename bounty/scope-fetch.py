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

ASSET_TYPES = {"domain", "wildcard", "url", "website", "api", "other"}

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
            if not p.get("offers_bounties"):
                continue
            in_scope = p.get("targets", {}).get("in_scope", [])
            assets = sorted({
                t["asset_identifier"]
                for t in in_scope
                if t.get("type", "").lower() in ASSET_TYPES and t.get("asset_identifier")
            })
            wild = [a for a in assets if "*" in a]
            if not assets:
                continue
            candidates.append({
                "platform": platform,
                "program": p.get("name", "?"),
                "url": p.get("url", ""),
                "assets": assets,
                "wildcards": wild,
                "asset_count": len(assets),
                "max_bounty": p.get("max_bounty") or None,
                "automation": "unchecked",
            })
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
