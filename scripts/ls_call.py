#!/usr/bin/env python3
"""Call a read-only method on the local Antigravity language server (via the live hub).

Usage: python3 scripts/ls_call.py <Method> ['{"json":"body"}']
  e.g. python3 scripts/ls_call.py GetSidecars
       python3 scripts/ls_call.py GetAllCascadeTrajectories

Picks the hub discovery file whose pid is still alive; sends the CSRF token only to 127.0.0.1.
"""
import glob
import json
import os
import sys
import urllib.request

SERVICE = "exa.language_server_pb.LanguageServerService"


def live_hub():
    for f in sorted(glob.glob(os.path.expanduser("~/.gemini/antigravity/daemon/hub_*.json")), key=os.path.getmtime, reverse=True):
        d = json.load(open(f))
        try:
            os.kill(int(d["pid"]), 0)
            return d
        except (OSError, KeyError, ValueError):
            continue
    sys.exit("no live hub found (is Antigravity running?)")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    method, body = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "{}")
    hub = live_hub()
    req = urllib.request.Request(
        f"http://127.0.0.1:{hub['httpPort']}/{SERVICE}/{method}",
        data=body.encode(),
        headers={"Content-Type": "application/json", "Connect-Protocol-Version": "1", "x-codeium-csrf-token": hub["csrfToken"]},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            text = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        text, status = e.read().decode(), e.code
    print(f"# hub pid {hub['pid']} · ls {hub.get('lsVersion')} · HTTP {status}", file=sys.stderr)
    try:
        print(json.dumps(json.loads(text), indent=2, ensure_ascii=False))
    except json.JSONDecodeError:
        print(text)


if __name__ == "__main__":
    main()
