// Client for the local Antigravity language server (Connect protocol, JSON encoding).
// Endpoint: the address injected into sidecars, else the live hub's discovery file.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SERVICE = 'exa.language_server_pb.LanguageServerService';
export const AG_DIR = process.env.BETTER_VIEW_AG_DIR || join(homedir(), '.gemini', 'antigravity');

export function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Several hubs can be alive at once (Antigravity's own, Gemini's `agy --hub`, each with a discovery file in
 * daemon/). The one that started this process wins: plugin MCP servers and sidecars are children of their
 * hub, and a panel inside Antigravity must not read another app's hub. Otherwise the newest file.
 * @returns {{name:string, base:string, csrf:string, pid?:number, lsVersion?:string} | null}
 */
export function findEndpoint({ dir = join(AG_DIR, 'daemon'), ppid = process.ppid, alive = isAlive } = {}) {
  if (process.env.BETTER_VIEW_NO_HUB) return null;
  const ls = process.env.ANTIGRAVITY_LS_ADDRESS;
  if (ls && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return { name: 'sidecar-env', base: /^https?:\/\//.test(ls) ? ls : `http://${ls}`, csrf: process.env.ANTIGRAVITY_CSRF_TOKEN };
  }
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^hub_\d+\.json$/.test(f)); } catch { return null; }
  const hubs = [];
  for (const f of files) {
    try {
      const file = join(dir, f);
      const d = JSON.parse(readFileSync(file, 'utf8'));
      if (alive(d.pid) && d.httpPort && d.csrfToken) hubs.push({ d, mtimeMs: statSync(file).mtimeMs });
    } catch { /* unreadable discovery file */ }
  }
  const mine = (x) => Number(x.d.pid) === ppid;
  hubs.sort((a, b) => mine(b) - mine(a) || b.mtimeMs - a.mtimeMs);
  const d = hubs[0]?.d;
  return d ? { name: `hub:${d.pid}`, pid: Number(d.pid), base: `http://127.0.0.1:${d.httpPort}`, csrf: d.csrfToken, lsVersion: d.lsVersion } : null;
}

const headers = (ep, type) => ({ 'Content-Type': type, 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': ep.csrf });

export async function unary(ep, method, body = {}, timeoutMs = 8000) {
  const res = await fetch(`${ep.base}/${SERVICE}/${method}`, {
    method: 'POST', headers: headers(ep, 'application/json'), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!res.ok) throw Object.assign(new Error(json?.message || `HTTP ${res.status}`), { status: res.status, code: json?.code });
  return json ?? {};
}

// ---- Connect streaming: each message is [flags:1][length:4 BE][payload]. flags&2 marks end-of-stream.
export function encodeEnvelope(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(5);
  head.writeUInt8(0, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** Splits a byte buffer into complete envelopes; returns {messages, rest}. */
export function decodeEnvelopes(buf) {
  const messages = [];
  let off = 0;
  while (buf.length - off >= 5) {
    const flags = buf.readUInt8(off);
    const len = buf.readUInt32BE(off + 1);
    if (buf.length - off - 5 < len) break;
    const raw = buf.subarray(off + 5, off + 5 + len).toString('utf8');
    let data;
    try { data = JSON.parse(raw); } catch { data = { _unparsed: raw.slice(0, 200) }; }
    messages.push({ end: (flags & 2) !== 0, data });
    off += 5 + len;
  }
  return { messages, rest: buf.subarray(off) };
}

/** Server-streaming call. Yields message objects; throws on an end-of-stream error. */
export async function* stream(ep, method, body, signal) {
  const res = await fetch(`${ep.base}/${SERVICE}/${method}`, {
    method: 'POST', headers: headers(ep, 'application/connect+json'), body: encodeEnvelope(body), signal,
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  let rest = Buffer.alloc(0);
  for await (const chunk of res.body) {
    const { messages, rest: r } = decodeEnvelopes(Buffer.concat([rest, chunk]));
    rest = r;
    for (const m of messages) {
      if (m.end) {
        if (m.data?.error) throw new Error(`${method}: ${m.data.error.code} ${m.data.error.message || ''}`);
        return;
      }
      yield m.data;
    }
  }
}

/** Depth-first search for every object that owns `key`. Tolerates unknown nesting. */
export function findAll(obj, key, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return out;
  if (Array.isArray(obj)) { for (const v of obj) findAll(v, key, out, depth + 1); return out; }
  if (key in obj) out.push(obj);
  for (const v of Object.values(obj)) if (v && typeof v === 'object') findAll(v, key, out, depth + 1);
  return out;
}
