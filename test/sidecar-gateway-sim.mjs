// A stand-in for Antigravity's sidecar gateway: starts the panel server as a sidecar (port + UI token
// injected) and proxies to it, answering 401 to any request without the token, in ?token= or the
// X-Sidecar-Token header, like the real gateway does. Open http://127.0.0.1:<port>/aux?token=sim
// Usage: node test/sidecar-gateway-sim.mjs [port=47407]
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 47407);
const BACKEND = PORT + 100;
const TOKEN = 'sim';
const child = spawn(process.execPath, [join(ROOT, 'sidecars/panel/server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: String(BACKEND), ANTIGRAVITY_SIDECAR_UI_TOKEN: TOKEN, BETTER_VIEW_NOTIFY: '0',
    // the 中/EN switch writes here, not to your real prefs
    BETTER_VIEW_PREFS: process.env.BETTER_VIEW_PREFS || join(tmpdir(), `bv-sim-prefs-${PORT}.json`) },
});
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ok = url.searchParams.get('token') === TOKEN || req.headers['x-sidecar-token'] === TOKEN;
  console.log(`[gateway] ${ok ? 200 : 401} ${req.method} ${url.pathname}`);
  if (!ok) { res.writeHead(401); return res.end('unauthorized'); }
  const up = request({ host: '127.0.0.1', port: BACKEND, path: req.url, method: req.method, headers: { ...req.headers, host: `gateway-sim:${PORT}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`[gateway-sim] http://127.0.0.1:${PORT}/aux?token=${TOKEN}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(); process.exit(0); });
