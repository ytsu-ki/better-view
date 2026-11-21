// MCP Apps bridge (SEP-1865, as implemented by Antigravity 2.32): only active when the panel runs inside the
// host's sandboxed frame. JSON-RPC 2.0 over postMessage to window.parent:
//   app → host  ui/initialize, ui/notifications/initialized, tools/call {name: "state"} (polled)
//   host → app  responses, ui/notifications/tool-input, ui/notifications/host-context-changed, pings
// The panel reads window.BV_HOST: if present it is the data source instead of /api/events.
(() => {
  if (window.parent === window) return;
  const PROTOCOL = '2026-01-26';
  const POLL_MS = 1500;
  let seq = 0;
  const pending = new Map();
  const send = (msg) => window.parent.postMessage(msg, '*');
  const notify = (method, params = {}) => send({ jsonrpc: '2.0', method, params });
  const request = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs);
  });

  // host theme → the panel's tokens (spec variable names, each with our own fallback)
  const MAP = {
    '--color-background-primary': '--page', '--color-background-secondary': '--sunk',
    '--color-text-primary': '--ink', '--color-text-secondary': '--ink-2', '--color-text-tertiary': '--ink-3', '--color-text-info': '--ok',
    '--color-border-primary': '--hair', '--color-text-warning': '--warning', '--color-text-danger': '--critical',
  };
  function applyContext(ctx) {
    if (!ctx) return;
    const root = document.documentElement;
    if (ctx.theme === 'dark' || ctx.theme === 'light') root.dataset.theme = ctx.theme;
    const vars = ctx.styles?.variables || {};
    for (const [from, to] of Object.entries(MAP)) if (typeof vars[from] === 'string' && vars[from]) root.style.setProperty(to, vars[from]);
    if (typeof vars['--font-sans'] === 'string') root.style.setProperty('font-family', vars['--font-sans']);
  }

  const host = { conversationId: null, onConversation: null };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && !m.method) { // a response to one of ours
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message || 'host error')) : p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/host-context-changed') applyContext(m.params);
    else if (m.method === 'ui/notifications/tool-input') {
      const conv = m.params?.arguments?.conversationId;
      if (typeof conv === 'string') { host.conversationId = conv; host.onConversation?.(conv); }
    }
    if (m.id != null && m.method) send({ jsonrpc: '2.0', id: m.id, result: {} }); // ping, resource-teardown, ...
  });

  host.start = async (onState, onError) => {
    try {
      const init = await request('ui/initialize', { protocolVersion: PROTOCOL, appInfo: { name: 'Better View', version: '1' }, appCapabilities: {} });
      applyContext(init?.hostContext);
      host.onLocale?.(init?.hostContext?.locale); // the host's language, until the server's state says otherwise
      notify('ui/notifications/initialized');
    } catch (err) { onError(err); }
    const poll = async () => {
      try {
        const r = await request('tools/call', { name: 'state', arguments: {} });
        if (r?.structuredContent) onState(r.structuredContent); else onError(new Error('empty state'));
      } catch (err) { onError(err); }
      setTimeout(poll, POLL_MS);
    };
    poll();
  };
  host.callTool = (name, args = {}) => request('tools/call', { name, arguments: args });
  window.BV_HOST = host;
})();
