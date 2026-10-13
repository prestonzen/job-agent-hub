#!/usr/bin/env python3
"""Queue fresh, existing scanner/Dark Moon evidence for offline review. Never scans targets.

Runs on CT 134 each minute. Content hashes deduplicate durable Hub tasks; failures retry
next tick. Each batch is small enough to review without losing the evidence to compression.
"""
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path

HUB = 'https://jobhunter.prestonzen.com'
ROOT = Path('/root/bbscans')

def main():
    token = Path('/etc/hub-admin-token').read_text().strip()
    catalog = json.loads(Path('/opt/bounty/queue.json').read_text())['programs']
    safe = lambda s: re.sub(r'[^A-Za-z0-9]+', '-', s).strip('-')
    programs = {safe(p['program']): p for p in catalog}
    count = 0
    for folder in sorted(ROOT.iterdir()):
        p = programs.get(folder.name)
        if not folder.is_dir() or not p:
            continue  # no provenance to an existing scoped program
        # One scanner batch per 40 observations, plus every actual validation log.
        files = [*sorted(folder.glob('engage-*.log')), folder / 'nuclei.clean.txt']
        for f in files:
            if not f.is_file():
                continue
            if time.time() - f.stat().st_mtime < 120:
                continue  # do not ingest partially written live artifacts
            raw = f.read_text(errors='replace')
            raw = re.sub(r'\x1b\[[0-9;]*m', '', raw)
            if f.name == 'nuclei.clean.txt':
                lines = [l for l in raw.splitlines() if re.match(r'^\[[^]]+\]\s+\[', l)]
                groups = ['\n'.join(lines[i:i+40]) for i in range(0,len(lines),40)]
            else:
                groups = [raw[:22000]]
            for i, evidence in enumerate(groups):
                if not evidence.strip():
                    continue
                digest = hashlib.sha256((p['program']+'\n'+f.name+'\n'+evidence).encode()).hexdigest()
                provenance = json.dumps({k:v for k,v in p.items() if k in ('program','platform','url','scope','domains','targets','in_scope')})
                payload = dict(sourceKey='artifact:'+digest, program=p['program'],
                    platform=p.get('platform','unknown'), target='existing artifact batch',
                    source=f'CT134:{f} batch {i+1}; mtime={int(f.stat().st_mtime)}',offlineOnly=True,
                    evidence=f'Existing artifact only. Scanner findings are unverified; log confirmation markers are not proof. No target access authorized by this task.\nProgram provenance: {provenance[:1200]}\n\n{evidence}')
                request = urllib.request.Request(HUB+'/api/admin/cyber',data=json.dumps(payload).encode(),
                    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'curl/8.5.0'})
                with urllib.request.urlopen(request,timeout=30) as response:
                    item=json.load(response)
                if item['status']=='pending':
                    count += 1
    print(f'[cyber-feed] {count} pending artifact batches; content hashes prevent duplicate review')

if __name__ == '__main__':
    main()
