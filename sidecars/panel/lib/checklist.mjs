// Markdown task lists -> checklist items. Used for the "任务清单" card.
//   - [x] done   - [/] or [-] in progress   - [ ] to do   (indentation = nesting)
import { statSync, readFileSync } from 'node:fs';

const ITEM = /^(\s*)[-*+]\s+\[([ xX\/\-~])\]\s+(.+?)\s*$/;
const strip = (s) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();

export function parseChecklist(md) {
  const items = [];
  for (const line of String(md ?? '').split('\n')) {
    const m = ITEM.exec(line);
    if (!m) continue;
    const mark = m[2];
    items.push({
      text: strip(m[3]),
      state: mark === 'x' || mark === 'X' ? 'done' : mark === ' ' ? 'todo' : 'doing',
      depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)),
    });
  }
  // the first unfinished top-level item is what's being worked on, unless one is explicitly marked
  if (!items.some((i) => i.state === 'doing')) {
    const next = items.find((i) => i.state === 'todo');
    if (next && items.some((i) => i.state === 'done')) next.state = 'next';
  }
  return items;
}

export function summarizeItems(items) {
  const top = items.filter((i) => i.depth === 0);
  const list = top.length ? top : items;
  return { done: list.filter((i) => i.state === 'done').length, total: list.length };
}

/** Last plain bullet (not a checkbox) — progress logs like "- **06:37Z**: Implemented kinematics.js". */
export function lastNote(md) {
  const bullets = String(md ?? '').split('\n').filter((l) => /^\s*[-*+]\s+/.test(l) && !ITEM.test(l));
  const last = bullets.pop();
  return last ? strip(last.replace(/^\s*[-*+]\s+/, '').replace(/^\*\*[^*]+\*\*:?\s*/, '')).slice(0, 160) : null;
}

const cache = new Map(); // path -> {mtimeMs, value}
/** Reads a progress file: {items, note, mtimeMs}; re-parses only when it changed; null when missing. */
export function readProgress(path) {
  let st;
  try { st = statSync(path); } catch { cache.delete(path); return null; }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value;
  try {
    const md = readFileSync(path, 'utf8');
    value = { items: parseChecklist(md), note: lastNote(md), mtimeMs: st.mtimeMs };
  } catch { return hit?.value ?? null; /* unreadable right now: try again next time */ }
  cache.set(path, { mtimeMs: st.mtimeMs, value });
  return value;
}
