#!/usr/bin/env python3
"""Capture what a Teamwork (native swarm) run leaves on disk, for M0.

Usage:
  python3 scripts/sample_teamwork.py start     # before starting the Teamwork task
  python3 scripts/sample_teamwork.py collect   # after it finishes (or while it runs)

`collect` copies every file under ~/.gemini that changed since `start`
(transcripts, messages, board.jsonl, annotations ...) into samples/<timestamp>/
and writes STRUCTURE.md describing record types, tool names and id relations.
Samples contain your conversation content: they stay local (samples/ is git-ignored).
Read-only towards Antigravity; makes no network calls.
"""
import collections
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "samples"
MARKER = SAMPLES / ".marker"
GEMINI = Path.home() / ".gemini"
SKIP_DIRS = {"tempmediaStorage", "cache", "bin", "builtin", "scratch", "node_modules"}
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4", ".xlsx", ".pdf"}
MAX_COPY = 50 * 1024 * 1024
SWARM_HINTS = ("subagent", "swarm", "worker", "roster", "board", "send_message", "invoke_", "manage_")


def start():
    SAMPLES.mkdir(exist_ok=True)
    (SAMPLES / ".gitignore").write_text("*\n")
    MARKER.write_text(str(time.time()))
    print(f"marker set at {time.ctime()}. Now run a Teamwork task, then: python3 {sys.argv[0]} collect")


def changed_files(since):
    for dirpath, dirnames, filenames in os.walk(GEMINI):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            p = Path(dirpath) / f
            try:
                st = p.stat()
            except OSError:
                continue
            if st.st_mtime >= since and p.suffix.lower() not in SKIP_SUFFIX and st.st_size <= MAX_COPY:
                yield p


def jsonl_rows(p):
    rows = []
    with open(p, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def keyset(d):
    return ",".join(sorted(d.keys())) if isinstance(d, dict) else type(d).__name__


def analyze(files, out):
    lines = ["# Teamwork sample structure", ""]
    lines += ["## Changed files", ""] + [f"- `{f.relative_to(GEMINI)}` ({f.stat().st_size} B)" for f in files] + [""]

    for f in files:
        if f.suffix == ".jsonl":
            rows = jsonl_rows(f)
            if not rows:
                continue
            lines += [f"## `{f.relative_to(GEMINI)}` — {len(rows)} rows", ""]
            shapes = collections.Counter(keyset(r) for r in rows)
            lines += ["Key sets:"] + [f"- {n} × `{k}`" for k, n in shapes.most_common(10)]
            for field in ("type", "kind", "event", "status", "source", "sender", "recipient", "channel"):
                c = collections.Counter(str(r.get(field)) for r in rows if isinstance(r, dict) and field in r)
                if c:
                    lines.append(f"- `{field}`: " + ", ".join(f"{k}×{v}" for k, v in c.most_common(12)))
            tools = collections.Counter()
            swarm_calls = []
            for r in rows:
                for t in (r.get("tool_calls") or []) if isinstance(r, dict) else []:
                    name = t.get("name", "?")
                    tools[name] += 1
                    if any(h in name for h in SWARM_HINTS) and len(swarm_calls) < 15:
                        swarm_calls.append({"step": r.get("step_index"), "name": name, "args": t.get("args")})
            if tools:
                lines.append("- tools: " + ", ".join(f"{k}×{v}" for k, v in tools.most_common(20)))
            if swarm_calls:
                lines += ["", "Swarm-related tool calls (args truncated):", "```"]
                lines += [json.dumps(c, ensure_ascii=False)[:400] for c in swarm_calls]
                lines += ["```"]
            if "board" in f.name:
                lines += ["", "First board records (truncated):", "```"]
                lines += [json.dumps(r, ensure_ascii=False)[:400] for r in rows[:8]]
                lines += ["```"]
            lines.append("")
        elif f.suffix == ".json" and "messages" in f.parts:
            try:
                m = json.loads(f.read_text())
                lines.append(f"- message `{f.name}`: sender=`{m.get('sender')}` recipient=`{m.get('recipient')}` title=`{(m.get('renderDetails') or {}).get('messageTitle')}`")
            except Exception:
                pass

    (out / "STRUCTURE.md").write_text("\n".join(lines) + "\n")


def collect():
    if not MARKER.exists():
        sys.exit("run `start` first")
    since = float(MARKER.read_text())
    out = SAMPLES / time.strftime("%Y%m%d-%H%M%S")
    files = sorted(changed_files(since))
    for f in files:
        dest = out / f.relative_to(GEMINI)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(f, dest)
        except OSError as e:
            print("skip", f, e)
    out.mkdir(parents=True, exist_ok=True)
    analyze(files, out)
    print(f"{len(files)} files -> {out}\nsummary: {out / 'STRUCTURE.md'}")


if __name__ == "__main__":
    {"start": start, "collect": collect}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
