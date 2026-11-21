// Better View server. Runs either as an Antigravity sidecar (port injected by the host)
// or standalone: `node server.mjs` then open http://127.0.0.1:47321/
// Read-only towards Antigravity. Listens on loopback only.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { inlinePage } from './lib/page.mjs';
import { notifyEnabled, attachNotifier } from './lib/notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, 'ui');
const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.BETTER_VIEW_PORT || '', 10) || 47321;
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const store = new Store();
const clients = new Set();

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function serveStatic(res, rel) {
  const file = join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) return send(res, 403, 'text/plain', 'forbidden');
  try { return send(res, 200, TYPES[extname(file)] || 'application/octet-stream', readFileSync(file)); } catch { return send(res, 404, 'text/plain', 'Not found'); }
}

/** The host's UI token, from the x-sidecar-token header, ?token=, or the cookie we set after the first. */
function tokenFrom(req, url) {
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === 'bv_token');
  return req.headers['x-sidecar-token'] || url.searchParams.get('token') || (cookie ? decodeURIComponent(cookie[1] || '') : '');
}
const sameToken = (a) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(UI_TOKEN);
  return UI_TOKEN !== '' && x.length === y.length && timingSafeEqual(x, y);
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // Reject DNS-rebinding style requests: our own loopback host names are accepted; any other Host only
  // with the UI token the host gave us (standalone mode has none, so loopback only).
  const loopback = ALLOWED_HOSTS.has(req.headers.host || '');
  const token = tokenFrom(req, url);
  if (!loopback && !sameToken(token)) return send(res, 421, 'text/plain', 'misdirected');
  if (UI_TOKEN && url.searchParams.get('token') && sameToken(token)) {
    // page loaded with ?token=: later requests that reach us directly carry the cookie (the host's gateway wants the header)
    res.setHeader('Set-Cookie', `bv_token=${encodeURIComponent(UI_TOKEN)}; Path=/; HttpOnly; SameSite=Strict`);
  }
  // the one write: the panel's 中/EN switch (saved to prefs.json, shared by every Better View process)
  if (req.method === 'POST' && url.pathname === '/api/lang') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 256) req.destroy(); });
    req.on('end', () => {
      let lang = null;
      try { lang = JSON.parse(body || '{}').lang ?? null; } catch { return send(res, 400, 'text/plain', 'bad json'); }
      send(res, 200, 'application/json', JSON.stringify({ lang: store.setLang(lang) }));
    });
    return;
  }
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'read-only');

  switch (url.pathname) {
    case '/': case '/sidebar': case '/aux': return send(res, 200, TYPES['.html'], inlinePage()); // one request: see lib/page.mjs
    case '/api/state': return send(res, 200, 'application/json', JSON.stringify(store.state()));
    case '/api/events': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(store.state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    default:
      if (/^\/[\w.-]+\.(js|css|svg)$/.test(url.pathname)) return serveStatic(res, url.pathname.slice(1));
      return send(res, 404, 'text/plain', 'Not found');
  }
});

// system notifications: stall/halt/dead/waiting transitions and long turns that finished. Every Better View
// process does this; a lease (lib/notify.mjs) makes sure only one of them actually notifies.
attachNotifier(store);

store.on('change', () => {
  if (!clients.size) return;
  const msg = `data: ${JSON.stringify(store.state())}\n\n`;
  for (const c of clients) c.write(msg);
});
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000);

server.listen(PORT, '127.0.0.1', () => {
  store.start();
  console.log(`[better-view] http://127.0.0.1:${PORT}/  (${process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ? 'sidecar' : 'standalone'} mode, notifications ${notifyEnabled() ? 'on' : 'off'})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.stop(); server.close(); process.exit(0); });
