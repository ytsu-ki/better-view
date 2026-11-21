// Tails the Antigravity hub log (~/.gemini/antigravity/cli.log -> log/cli-<ts>.log, glog format) for
// supporting evidence only: lost login and network failures. Telemetry upload errors are noise
// (they fail constantly on a healthy machine) and are ignored.

import { openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AG_DIR } from './hub.mjs';

const LINE_RE = /^([IEW])(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+\s+\d+\s+\S+\]\s?(.*)$/;
const NOISE_RE = /play\.googleapis\.com|clearcut|ListExperiments|errorreport\.go.*Post "https:\/\/play/i;
const AUTH_RE = /not logged into Antigravity|Failed to get OAuth token|error getting token source/i;
const NET_RE = /no such host|connection refused|connection reset|i\/o timeout|network is unreachable|TLS handshake timeout|context deadline exceeded|": EOF\b/i;
const WINDOW = 5 * 60_000;
const BACKLOG = 64 * 1024;

/** Parses one glog line into {level, at, msg} (local time; glog lines carry no year). */
export function parseGlog(line, now = Date.now()) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const year = new Date(now).getFullYear();
  let at = new Date(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  if (at - now > 86_400_000) at = new Date(year - 1, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return { level: m[1], at, msg: m[7] };
}

export function classify(msg) {
  if (NOISE_RE.test(msg)) return null;
  if (AUTH_RE.test(msg)) return 'auth';
  if (NET_RE.test(msg)) return 'network';
  return null;
}

const short = (msg) => msg.replace(/https?:\/\/\S+/g, (u) => u.replace(/^(https?:\/\/[^/]+).*/, '$1')).slice(0, 90);

export class HubLog {
  constructor(file = join(AG_DIR, 'cli.log')) {
    this.link = file;
    this.real = null;
    this.offset = 0;
    this.partial = '';
    this.auth = null;
    this.net = []; // [{at, line}]
  }

  poll(now = Date.now()) {
    let real, st;
    try { real = realpathSync(this.link); st = statSync(real); } catch { return this.summary(now); }
    if (real !== this.real || st.size < this.offset) { // new hub session or truncated: read the recent tail
      this.real = real; this.offset = Math.max(0, st.size - BACKLOG); this.partial = ''; this.auth = null; this.net = [];
      this.decoder = new StringDecoder('utf8');
    }
    if (st.size > this.offset) {
      const fd = openSync(real, 'r');
      try {
        const buf = Buffer.alloc(st.size - this.offset);
        const n = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += n;
        const lines = (this.partial + this.decoder.write(buf.subarray(0, n))).split('\n'); // keeps a split character's bytes
        this.partial = lines.pop();
        for (const l of lines) this.ingest(l, now);
      } finally { closeSync(fd); }
    }
    return this.summary(now);
  }

  ingest(line, now = Date.now()) {
    const p = parseGlog(line, now);
    if (!p) return;
    const kind = p.level === 'I' ? null : classify(p.msg);
    if (kind === 'auth') this.auth = { at: p.at, line: short(p.msg) };
    else if (kind === 'network') this.net.push({ at: p.at, line: short(p.msg) });
    // any later successful model call clears a stale auth complaint
    else if (p.level === 'I' && /generateContent/.test(p.msg) && this.auth && p.at > this.auth.at) this.auth = null;
  }

  summary(now = Date.now()) {
    this.net = this.net.filter((x) => now - x.at < WINDOW);
    const auth = this.auth && now - this.auth.at < WINDOW ? this.auth : null;
    // a single EOF happens on healthy machines; three in five minutes is a pattern
    const network = this.net.length >= 3 ? { at: this.net[this.net.length - 1].at, count: this.net.length, line: this.net[this.net.length - 1].line } : null;
    return { auth, network };
  }
}
