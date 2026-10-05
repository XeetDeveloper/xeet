#!/usr/bin/env python3
"""Deploy ~/Projects/xeet/site to Vercel (project `xeet`) via the REST API.

No CLI, no Node. Run ./build.sh first so the extension zip on the page is
current — this script uploads whatever is on disk.

    export VERCEL_TOKEN="..."      # or source ~/.config/vercel.env
    python3 deploy.py
"""
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

CAFILE = "/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None
SSLCTX = ssl.create_default_context(cafile=CAFILE)

TOKEN = os.environ.get("VERCEL_TOKEN")
if not TOKEN:
    sys.exit("VERCEL_TOKEN is not set (try: source ~/.config/vercel.env)")

ROOT = os.path.expanduser("~/Projects/xeet/site")
PROJECT = "xeet"
API = "https://api.vercel.com"

# source-only files never reach the CDN
SKIP_DIRS = {".claude", ".git", "node_modules", "__pycache__"}
SKIP_FILES = {".DS_Store", ".predeploy-allow"}


def req(method, url, data=None, headers=None, raw=False):
    h = {"Authorization": f"Bearer {TOKEN}"}
    if headers:
        h.update(headers)
    body = data if raw else (json.dumps(data).encode() if data is not None else None)
    if data is not None and not raw:
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, context=SSLCTX) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


# 1. collect
files = []
for dp, dns, fns in os.walk(ROOT):
    dns[:] = [d for d in dns if d not in SKIP_DIRS]
    for fn in fns:
        if fn in SKIP_FILES:
            continue
        full = os.path.join(dp, fn)
        if os.path.islink(full) and not os.path.exists(full):
            continue
        with open(full, "rb") as f:
            b = f.read()
        rel = os.path.relpath(full, ROOT)
        files.append((rel, b, hashlib.sha1(b).hexdigest(), len(b)))
print(f"collected {len(files)} files, {sum(f[3] for f in files):,} B")

# 2. upload
for rel, b, sha, size in files:
    st, _ = req(
        "POST",
        f"{API}/v2/files",
        data=b,
        raw=True,
        headers={"x-vercel-digest": sha, "Content-Type": "application/octet-stream"},
    )
    print(f"  upload {rel:34s} {size:>8,}B -> {st}")
    if st not in (200, 201):
        sys.exit("upload failed")

# 3. deploy
payload = {
    "name": PROJECT,
    "files": [{"file": rel, "sha": sha, "size": size} for rel, _, sha, size in files],
    "target": "production",
    "projectSettings": {"framework": None},
}
st, res = req("POST", f"{API}/v13/deployments?forceNew=1", data=payload)
print("deployment:", st)
if st not in (200, 201):
    print(json.dumps(res, indent=2)[:1500])
    sys.exit(1)

dep_id, url = res.get("id"), res.get("url")
print("id:", dep_id)
print("url: https://" + (url or ""))

# 4. wait for READY
for _ in range(60):
    time.sleep(3)
    st, d = req("GET", f"{API}/v13/deployments/{dep_id}")
    state = d.get("readyState") or d.get("state")
    print("  ", state)
    if state in ("READY", "ERROR", "CANCELED"):
        break
print("aliases:", d.get("alias"))
