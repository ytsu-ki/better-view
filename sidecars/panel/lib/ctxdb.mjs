// What fills the context window, and which model ran, as Antigravity recorded it for the latest model call.
//
// Every conversation has a SQLite store, ~/.gemini/antigravity/conversations/<id>.db. Its gen_metadata table
// holds one protobuf per model call; inside it, ContextWindowMetadata (path 1 → 9 → 10) is
//   1: estimated tokens in use   3: TokenBreakdown   4: context limit
// and TokenBreakdown is { 1: repeated group { 1: name ("System Prompt" | "Tools" | "Chat Messages" | …),
// 4: tokens, 5: repeated child { 1: name, 3: tokens } }, 2: total }.
// The model id of that call sits at 3 → 28 (also 1 → 19), e.g. "claude-opus-5-5-medium": it is how a subagent's
// model is known at all (its transcript never says). Read-only, cached by file mtime. Needs node:sqlite (Node 22.5+); without it there is simply no breakdown.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { AG_DIR } from './hub.mjs';

export const CONV_DB_DIR = join(AG_DIR, 'conversations');

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older Node: feature off */ }
export const available = () => DatabaseSync != null;

// ---- minimal protobuf reader (wire types 0, 1, 2, 5) ----
function varint(b, i) {
  let r = 0, mul = 1;
  for (;;) {
    if (i >= b.length) throw new Error('truncated');
    const x = b[i++];
    r += (x & 0x7f) * mul;
    if (x < 0x80) return [r, i];
    mul *= 128;
  }
}
export function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let key; [key, i] = varint(b, i);
    const f = Math.floor(key / 8), w = key % 8;
    if (f === 0) throw new Error('bad field');
    let v;
    if (w === 0) [v, i] = varint(b, i);
    else if (w === 1) { v = b.subarray(i, i + 8); i += 8; }
    else if (w === 5) { v = b.subarray(i, i + 4); i += 4; }
    else if (w === 2) { let n; [n, i] = varint(b, i); v = b.subarray(i, i + n); i += n; if (i > b.length) throw new Error('truncated'); }
    else throw new Error(`wire type ${w}`);
    out.push({ f, w, v });
  }
  return out;
}
const first = (fs, f) => fs.find((x) => x.f === f)?.v;
const text = (v) => (v ? Buffer.from(v).toString('utf8') : '');

/** The model id of one gen_metadata blob ("gemini-4-hydrogen-tiered-high"), or null. */
export function decodeModel(blob) {
  try {
    const top = fields(blob);
    const cfg = first(top, 3);
    const id = (cfg && text(first(fields(cfg), 28))) || (() => { const m = first(top, 1); return m ? text(first(fields(m), 19)) : ''; })();
    return /^[a-z0-9][\w.-]{2,80}$/i.test(id) ? id : null;
  } catch { return null; }
}

/** "claude-opus-5-5-medium" → "Claude Opus 5.5 · Medium", "gemini-4-hydrogen-tiered-high" → "Gemini 4 Hydrogen · High". */
export function prettyModel(id) {
  if (!id) return null;
  const parts = String(id).toLowerCase().split('-').filter((p) => p && p !== 'tiered');
  const effort = /^(minimal|low|medium|high|xhigh|max)$/.test(parts.at(-1)) ? parts.pop() : null;
  const words = [];
  for (const p of parts) {
    const prev = words.at(-1);
    if (/^\d+$/.test(p) && prev && /^\d+$/.test(prev)) words[words.length - 1] = `${prev}.${p}`; // 5-5 → 5.5
    else words.push(p);
  }
  const name = words.map((w) => (w === 'gpt' ? 'GPT' : w === 'oss' ? 'OSS' : /^\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
  const E = { xhigh: 'XHigh' };
  return effort ? `${name} · ${E[effort] ?? effort[0].toUpperCase() + effort.slice(1)}` : name;
}

/** Decode one gen_metadata blob into {used, max, total, groups:[{name, tokens, top:[{name, tokens}]}]}, or null. */
export function decodeBreakdown(blob) {
  try {
    let m = blob;
    for (const f of [1, 9, 10]) { m = first(fields(m), f); if (!m) return null; }
    const meta = fields(m);
    const bd = first(meta, 3);
    if (!bd) return null;
    const bf = fields(bd);
    const groups = bf.filter((x) => x.f === 1 && x.w === 2).map(({ v }) => {
      const g = fields(v);
      const kids = g.filter((x) => x.f === 5 && x.w === 2).map(({ v: c }) => { const k = fields(c); return { name: text(first(k, 1)), tokens: first(k, 3) || 0 }; });
      return { name: text(first(g, 1)), tokens: first(g, 4) || 0, top: kids.sort((a, b) => b.tokens - a.tokens).slice(0, 3) };
    }).filter((g) => g.name && g.tokens > 0);
    if (!groups.length) return null;
    return { used: first(meta, 1) ?? null, max: first(meta, 4) ?? null, total: first(bf, 2) ?? groups.reduce((s, g) => s + g.tokens, 0), groups };
  } catch { return null; }
}

const cache = new Map(); // id -> {stamp, value}
/** The latest model call of a conversation: {model, breakdown} (either may be null), or null without a store. */
export function convMeta(id, dir = CONV_DB_DIR) {
  if (!DatabaseSync) return null;
  const file = join(dir, `${id}.db`);
  let st;
  try { st = statSync(file); } catch { return null; }
  let wal = 0;
  try { wal = statSync(`${file}-wal`).mtimeMs; } catch { /* no WAL file right now */ }
  const stamp = Math.max(st.mtimeMs, wal);
  const hit = cache.get(id);
  if (hit && hit.stamp === stamp) return hit.value;
  let value = null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    if (row?.data) value = { model: decodeModel(row.data), breakdown: decodeBreakdown(row.data) };
  } catch {
    // busy or mid-write: keep what we had, and don't remember this stamp, so the next call reads again
    return hit?.value ?? null;
  } finally { try { db?.close(); } catch { /* ignore */ } }
  cache.set(id, { stamp, value });
  return value;
}

/** The latest model call's context breakdown for a conversation, or null. */
export const contextBreakdown = (id, dir) => convMeta(id, dir)?.breakdown ?? null;
