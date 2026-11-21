import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, TOOLS, APP_URI, appHtml } from '../mcp/server.mjs';

const ctx = { state: () => ({ runs: [], teams: [] }), html: () => '<html></html>' };

test('MCP: tools declare the side-pane and sidebar entrypoints; state is app-only', () => {
  const open = TOOLS.find((t) => t.name === 'open');
  assert.equal(open._meta.ui.resourceUri, APP_URI);
  assert.ok(APP_URI.startsWith('ui://'), 'hosts drop UI metadata unless the URI is ui://');
  assert.deepEqual(open._meta['com.google.antigravity/ui'].entrypoints.map((e) => e.type), ['aux_pane', 'global']);
  assert.deepEqual(open.inputSchema.required, undefined, 'entrypoint launches call with {}');
  assert.deepEqual(TOOLS.find((t) => t.name === 'state')._meta.ui.visibility, ['app']);
});

test('MCP: protocol answers', () => {
  assert.equal(handle('initialize', { protocolVersion: '2025-06-18' }, ctx).capabilities.resources.listChanged, false);
  assert.deepEqual(handle('tools/call', { name: 'state', arguments: {} }, ctx).structuredContent, { runs: [], teams: [] });
  assert.equal(handle('tools/call', { name: 'open', arguments: {} }, ctx).structuredContent.opened, true);
  const r = handle('resources/read', { uri: APP_URI }, ctx).contents[0];
  assert.equal(r.mimeType, 'text/html;profile=mcp-app');
  assert.throws(() => handle('resources/read', { uri: 'ui://other' }, ctx), (e) => e.code === -32602);
  assert.throws(() => handle('nope', {}, ctx), (e) => e.code === -32601);
});

test('MCP: the app is one self-contained document (default CSP blocks external files)', () => {
  const html = appHtml();
  assert.ok(html.length < 10 * 1024 * 1024);
  assert.doesNotMatch(html, /<link[^>]+stylesheet|<script[^>]+src=/, 'no external stylesheet or script');
  assert.match(html, /window\.BV_HOST = host/);
  assert.equal((html.match(/<\/script>/g) || []).length, 2, 'inlined code cannot close its own script tag');
});

test('sidecar page is self-contained too, without the MCP bridge', async () => {
  const { inlinePage } = await import('../sidecars/panel/lib/page.mjs');
  const html = inlinePage();
  assert.doesNotMatch(html, /href="style\.css"|src="app\.js"/);
  assert.doesNotMatch(html, /BV_HOST = host/);
  assert.match(html, /X-Sidecar-Token/);
  assert.match(appHtml(), /BV_HOST = host/);
});
