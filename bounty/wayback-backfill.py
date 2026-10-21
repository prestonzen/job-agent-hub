#!/usr/bin/env python3
"""Backfill wayback CDX harvest for already-scanned program dirs.

For each /root/bbscans/<Program>/ with scope.json: harvest historical URLs
from archive.org (matchType=prefix, parallel, budgeted), then scope-filter
into urls.txt — same shape bounty-scan.sh now produces in-scan. Skips dirs
whose urls.txt is fresh (<6h, i.e. just re-scanned)."""
import json, pathlib, re, subprocess, sys, time

SCANS = pathlib.Path("/root/bbscans")
BUDGET = 240          # seconds per program
PER_DOMAIN_TIMEOUT = 25
PARALLEL = 3
FRESH = 6 * 3600

sys.path.insert(0, "/opt/bounty")
import scope  # noqa: E402


def domains_of(pd: pathlib.Path):
    doms = set()
    for fname in ("wildcards.txt", "direct.txt"):
        f = pd / fname
        if not f.is_file():
            continue
        for ln in f.read_text(errors="replace").splitlines():
            d = re.sub(r"^https?://", "", ln.strip()).split("/")[0]
            d = d.lstrip("*.")
            if d and "*" not in d:
                doms.add(d)
    return sorted(doms)[:40]


def harvest(pd: pathlib.Path, doms, deadline):
    raw = pd / "urls.raw.txt"
    with raw.open("w") as out:
        queue = list(doms)
        while queue and time.time() < deadline:
            batch, queue = queue[:PARALLEL], queue[PARALLEL:]
            procs = [subprocess.Popen(
                ["curl", "-s", "-m", str(PER_DOMAIN_TIMEOUT),
                 f"http://web.archive.org/cdx/search/cdx?url={d}&matchType=prefix&fl=original&limit=2000"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) for d in batch]
            for p in procs:
                data, _ = p.communicate()
                out.write(data.decode(errors="replace"))
    seen, lines = set(), []
    for ln in raw.read_text(errors="replace").splitlines():
        ln = ln.strip()
        if ln and ln.startswith("http") and ln not in seen:
            seen.add(ln)
            lines.append(ln)
    raw.write_text("\n".join(lines) + ("\n" if lines else ""))
    return len(lines)


def main():
    done = skipped = failed = 0
    for pd in sorted(SCANS.iterdir()):
        if not pd.is_dir():
            continue
        sf, wf, df = pd / "scope.json", pd / "wildcards.txt", pd / "direct.txt"
        ut = pd / "urls.txt"
        if not sf.is_file() or not (wf.is_file() or df.is_file()):
            continue
        if ut.is_file() and ut.stat().st_size > 0 and time.time() - ut.stat().st_mtime < FRESH:
            skipped += 1
            continue
        doms = domains_of(pd)
        if not doms:
            failed += 1
            continue
        try:
            rules = json.loads(sf.read_text())
            n = harvest(pd, doms, time.time() + BUDGET)
            kept = []
            for ln in (pd / "urls.raw.txt").read_text(errors="replace").splitlines():
                if ln.strip() and scope.in_scope(ln.strip(), rules):
                    kept.append(ln.strip())
            ut.write_text("\n".join(kept) + ("\n" if kept else ""))
            done += 1
            print(f"[backfill] {pd.name}: {n} raw -> {len(kept)} in-scope urls "
                  f"({sum(1 for k in kept if '.php' in k)} .php)", flush=True)
        except Exception as e:
            failed += 1
            print(f"[backfill] {pd.name}: FAILED {e}", flush=True)
    print(f"[backfill] done={done} skipped_fresh={skipped} failed={failed}", flush=True)


if __name__ == "__main__":
    main()
