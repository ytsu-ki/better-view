// A stand-in for Antigravity's MCP Apps host, to test the panel end to end without the real app:
// spawns mcp/server.mjs over stdio, serves a host page that loads the app resource into a sandboxed iframe
// (srcdoc, allow-scripts only — like the real sandbox, no same-origin storage or network), answers
// ui/initialize with a host context (theme + spec style variables) and forwards the app's tools/call.
// Usage: node test/mcp-host-sim.mjs [port=47406] [theme=dark|light]   (env BETTER_VIEW_NO_HUB etc. pass through)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 47406);
const THEME = process.argv[3] || 'dark';

const mcp = spawn('/bin/sh', [join(ROOT, 'mcp/run.sh')], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const waiting = new Map();
let seq = 0;
createInterface({ input: mcp.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  waiting.get(msg.id)?.(msg);
  waiting.delete(msg.id);
});
const rpc = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  waiting.set(id, resolve);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host-sim', version: '1' } });

const VARS = THEME === 'dark'
  ? { '--color-background-primary': '#1e1f22', '--color-background-secondary': '#2a2b2f', '--color-text-primary': '#e8e8ea', '--color-text-secondary': '#a9abb2', '--color-text-tertiary': '#7c7e86', '--color-border-primary': '#34363b', '--font-sans': 'Inter, -apple-system, sans-serif' }
  : { '--color-background-primary': '#ffffff', '--color-background-secondary': '#f3f4f6', '--color-text-primary': '#1f1f1f', '--color-text-secondary': '#5f6368', '--color-text-tertiary': '#80868b', '--color-border-primary': '#e3e3e3', '--font-sans': 'Inter, -apple-system, sans-serif' };

const HOST = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Host sim</title>
<style>html,body{margin:0;height:100%;background:${VARS['--color-background-primary']}}iframe{border:0;width:100%;height:100vh;display:block}</style>
<iframe id="app" sandbox="${process.env.SIM_SAME_ORIGIN ? 'allow-scripts allow-same-origin' : 'allow-scripts'}"></iframe>
<script>
const frame = document.getElementById('app');
const log = (...a) => console.log('[host]', ...a);
const ctx = { theme: ${JSON.stringify(THEME)}, platform: 'web', displayMode: 'inline', locale: 'zh-CN', styles: { variables: ${JSON.stringify(VARS)} } };
window.hostLog = [];
async function call(method, params) { return (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method, params }) })).json(); }
window.addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data; window.hostLog.push(m.method || ('response ' + m.id));
  const reply = (body) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, ...body }, '*');
  if (m.method === 'ui/initialize') reply({ result: { protocolVersion: '2026-01-26', hostInfo: { name: 'host-sim', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: ctx } });
  else if (m.method === 'tools/call') { const r = await call('tools/call', m.params); reply(r.error ? { error: r.error } : { result: r.result }); }
  else if (m.method === 'ui/notifications/initialized') { frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } }, '*'); }
});
(async () => { const r = await call('resources/read', { uri: 'ui://better-view/panel.html' }); frame.srcdoc = r.result.contents[0].text; })();
</script>`;

createServer(async (req, res) => {
  if (req.url === '/rpc' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const { method, params } = JSON.parse(body);
    const r = await rpc(method, params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HOST);
}).listen(PORT, '127.0.0.1', () => console.log(`[host-sim] http://127.0.0.1:${PORT}/ (${THEME})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { mcp.kill(); process.exit(0); });
