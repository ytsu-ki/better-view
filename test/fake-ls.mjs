// Fake language server for local UI/integration testing — no real Antigravity credentials involved.
// Usage: node test/fake-ls.mjs [port] [runningConversationId]
// Then:  ANTIGRAVITY_LS_ADDRESS=127.0.0.1:<port> ANTIGRAVITY_CSRF_TOKEN=fake node sidecars/panel/server.mjs

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { encodeEnvelope } from '../sidecars/panel/lib/hub.mjs';

const PORT = Number(process.argv[2] || 47400);
const RUNNING = process.argv[3] || '';
const P = '/exa.language_server_pb.LanguageServerService/';
const t0 = Date.now();

const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer((req, res) => {
  if (req.headers['x-codeium-csrf-token'] !== 'fake') { res.writeHead(401); return res.end('{"code":"unauthenticated"}'); }
  const method = req.url.replace(P, '');
  if (method === 'GetAllCascadeTrajectories') {
    // FAKE_LS_STATUS_FILE: {"<convId>": {"status": "CASCADE_RUN_STATUS_*", "title": "...", "termination": "..."}}, re-read per call
    if (process.env.FAKE_LS_STATUS_FILE) {
      let table = {};
      try { table = JSON.parse(readFileSync(process.env.FAKE_LS_STATUS_FILE, 'utf8')); } catch { /* not written yet */ }
      return json(res, { trajectorySummaries: Object.fromEntries(Object.entries(table).map(([id, c]) => [id, {
        status: c.status, annotations: { title: c.title }, latestExecutorTerminationReason: c.termination, trajectoryMetadata: { rootConversationId: id },
      }])) });
    }
    return json(res, { trajectorySummaries: RUNNING ? { [RUNNING]: { status: 'CASCADE_RUN_STATUS_RUNNING', stepCount: 140, annotations: { title: '（假数据）正在运行的会话' }, trajectoryMetadata: { rootConversationId: RUNNING } } } : {} });
  }
  if (method === 'RetrieveUserQuotaSummary') {
    const hour = 3600_000;
    // Shape mirrors the real 2.32 response: wrapped in `response`, one group per model family with the same
    // window names. The Claude/GPT 5-hour bucket is exhausted, so proto3 JSON omits its remainingFraction.
    return json(res, { response: { groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.22, resetTime: new Date(t0 + 98 * hour).toISOString() },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.58, resetTime: new Date(t0 + 4.3 * hour).toISOString() },
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.81, resetTime: new Date(t0 + 120 * hour).toISOString() },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: new Date(t0 + 1.2 * hour).toISOString() },
      ] },
      // a model with a pool of its own, untouched (Antigravity's Usage panel lists it as its own group)
      { displayName: 'Gemini 4 Argon', buckets: [
        { bucketId: 'argon-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: new Date(t0 + 168 * hour).toISOString() },
      ] },
    ] } });
  }
  if (method === 'StreamAgentStateUpdates') {
    res.writeHead(200, { 'Content-Type': 'application/connect+json' });
    let used = 410_000;
    const tick = () => {
      used += 7_000;
      res.write(encodeEnvelope({ update: { contextWindowUsage: { estimatedTokensUsed: String(used), maxContextTokens: '1048576', estimatedAfterCompaction: '120000' } } }));
    };
    tick();
    const iv = setInterval(tick, 2000);
    req.on('close', () => clearInterval(iv));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'unimplemented', message: method }));
}).listen(PORT, '127.0.0.1', () => console.log(`fake LS on 127.0.0.1:${PORT}, running=${RUNNING || '(none)'}`));
