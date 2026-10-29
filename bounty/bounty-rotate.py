#!/usr/bin/env python3
"""Rotate /opt/bounty/priority.txt after a batch: move just-scanned programs
to the end so the next batch picks the unscanned tail first."""
import pathlib, sys

PRI = pathlib.Path("/opt/bounty/priority.txt")
if len(sys.argv) >= 3 and sys.argv[1] == "--file":
    scanned = [l.strip() for l in pathlib.Path(sys.argv[2]).read_text().splitlines() if l.strip()]
else:
    scanned = [l.strip() for l in sys.argv[1:] if l.strip()]
lines = [l.strip() for l in PRI.read_text().splitlines() if l.strip()]
if not scanned or not lines:
    sys.exit(0)
scanned_lower = {s.lower() for s in scanned}
rest = [l for l in lines if l.lower() not in scanned_lower]
PRI.write_text("\n".join(rest + scanned) + "\n")
print(f"rotated {len(scanned)} programs to end of priority.txt")
