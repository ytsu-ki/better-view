// Better View as an MCP App: shows the panel inside Antigravity's own side pane ("+" menu) and, where the
// host enables it, as a full-page entry in the left sidebar. This path needs no experiment flag, unlike
// plugin sidecar UIs (`enable-ui-sidecars`, server-side and off for most accounts as of 2.32).
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0 (no SDK, no dependencies). stdout carries only
// protocol messages; logs go to stderr. The panel HTML is assembled from sidecars/panel/ui on every read,
// so UI edits show up the next time the view opens.
//
// Tools
//   open   entrypoints aux_pane + global; launches with {} and returns a short ack (the app renders itself)
//   state  app-only: the full panel state, polled by the app through the host (no network, no CSP opening)

import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Store } from '../sidecars/panel/lib/store.mjs';
import { inlinePage } from '../sidecars/panel/lib/page.mjs';
import { attachNotifier } from '../sidecars/panel/lib/notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(HERE, '..', 'plugin.json'), 'utf8')).version;
export const APP_URI = 'ui://better-view/panel.html';
const APP_MIME = 'text/html;profile=mcp-app';
// Antigravity doesn't surface plugin servers' stderr, so lifecycle and request methods (never params or results)
// also go to a small file: ~/Library/Logs/better-view/mcp.log (BETTER_VIEW_MCP_LOG overrides, '0' turns it off).
const LOG_FILE = process.env.BETTER_VIEW_MCP_LOG ?? join(homedir(), 'Library', 'Logs', 'better-view', 'mcp.log');
function log(...a) {
  const line = `${new Date().toISOString()} [${process.pid}] ${a.join(' ')}\n`;
  process.stderr.write(`[better-view-mcp] ${line}`);
  if (!LOG_FILE || LOG_FILE === '0') return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    try { if (statSync(LOG_FILE).size > 1_000_000) renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    appendFileSync(LOG_FILE, line);
  } catch {}
}

/** One self-contained document: the panel's HTML with its CSS, the host bridge and the app inlined. */
export const appHtml = (uiDir) => inlinePage({ bridge: true, uiDir });

export const TOOLS = [
  {
    name: 'open',
    title: 'Better View',
    description: 'Opens the Better View panel (task checklist, every agent of a Teamwork run, remaining quota, context, stall detection). UI only: call it only when the user asks to open Better View.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: {
      ui: { resourceUri: APP_URI },
      'ui/resourceUri': APP_URI,
      'com.google.antigravity/ui': { entrypoints: [{ type: 'aux_pane', title: 'Better View' }, { type: 'global', title: 'Better View' }] },
    },
  },
  // The two below are for the panel only (visibility: ['app']). Hosts that list them to the model anyway get a
  // description that says so: `state` returns every conversation on this machine, hundreds of KB.
  {
    name: 'set_language',
    title: 'Better View language',
    description: "Internal to the Better View panel UI (its 中/EN switch): sets the panel's display language to 'zh', 'en' or 'auto'. Do not call this from the assistant; to change the language, the user clicks the switch in the panel.",
    inputSchema: { type: 'object', properties: { lang: { type: 'string', enum: ['zh', 'en', 'auto'] } }, required: ['lang'], additionalProperties: false },
    _meta: { ui: { resourceUri: APP_URI, visibility: ['app'] } },
  },
  {
    name: 'state',
    title: 'Better View state',
    description: 'Internal data feed of the Better View panel UI, polled by the panel itself. Never call this from the assistant: it returns the raw data of every conversation on this machine (hundreds of KB), which is not meant for a chat context. To show progress, use the open tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { resourceUri: APP_URI, visibility: ['app'] } },
  },
];

/** Pure request handler: returns a JSON-RPC result object, or throws {code, message}. */
export function handle(method, params, ctx) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'better-view', title: 'Better View', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = params?.name;
      if (name === 'open') return { content: [{ type: 'text', text: 'Better View panel opened.' }], structuredContent: { opened: true } };
      if (name === 'set_language') {
        const lang = ctx.setLang(params?.arguments?.lang);
        return { content: [{ type: 'text', text: `Better View language: ${lang}` }], structuredContent: { lang } };
      }
      if (name === 'state') return { content: [{ type: 'text', text: 'Better View panel state.' }], structuredContent: ctx.state() };
      throw { code: -32602, message: `unknown tool: ${name}` };
    }
    case 'resources/list':
      return { resources: [{ uri: APP_URI, name: 'Better View', mimeType: APP_MIME }] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read':
      if (params?.uri !== APP_URI) throw { code: -32602, message: `unknown resource: ${params?.uri}` };
      return { contents: [{ uri: APP_URI, mimeType: APP_MIME, text: ctx.html(), _meta: { ui: { prefersBorder: false } } }] };
    default:
      throw { code: -32601, message: `method not found: ${method}` };
  }
}

function main() {
  const store = new Store();
  store.start();
  // stall / done notifications, shared with the other Better View processes through a lease (lib/notify.mjs);
  // the log file gets the level only, never a conversation's title
  attachNotifier(store, { log: (a) => log(`alert ${a.level}`) });
  const ctx = { state: () => store.state(), html: () => appHtml(), setLang: (l) => store.setLang(l) };
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  let stateLogged = false;
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    if (msg.id === undefined || msg.id === null) return log(`notify ${msg.method}`); // nothing to answer
    if (msg.method !== 'tools/call' || msg.params?.name !== 'state') log(`${msg.method}${msg.params?.name ? ' ' + msg.params.name : ''}${msg.params?.uri ? ' ' + msg.params.uri : ''}${msg.params?.clientInfo ? ' from ' + msg.params.clientInfo.name + ' ' + (msg.params.clientInfo.version || '') + ' proto ' + msg.params.protocolVersion : ''}`);
    else if (!stateLogged) { stateLogged = true; log('tools/call state (first; later polls not logged)'); }
    try {
      out({ jsonrpc: '2.0', id: msg.id, result: handle(msg.method, msg.params, ctx) });
    } catch (e) {
      out({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } });
    }
  });
  rl.on('close', () => { log('stdin closed, exiting'); store.stop(); process.stdout.write('', () => process.exit(0)); }); // flush pending replies first
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { log(`${sig}, exiting`); process.exit(0); });
  process.on('uncaughtException', (e) => { log(`uncaught: ${e?.stack || e}`); process.exit(1); });
  log(`v${VERSION} ready (cwd ${process.cwd()})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
