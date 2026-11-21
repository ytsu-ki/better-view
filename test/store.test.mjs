// Store-level behaviour against a throwaway Antigravity data dir (no hub, no real data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AG = mkdtempSync(join(tmpdir(), 'bv-ag-'));
process.env.BETTER_VIEW_AG_DIR = AG;
process.env.BETTER_VIEW_NO_HUB = '1';
process.env.BETTER_VIEW_CACHE = join(AG, 'models.json');
const { Store } = await import('../sidecars/panel/lib/store.mjs');

const ID = '11111111-2222-4333-8444-555555555555';
const dir = join(AG, 'brain', ID, '.system_generated', 'logs');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'transcript.jsonl');
const line = (o) => JSON.stringify(o) + '\n';

test('alerts fire on transitions after startup, not for the state found at startup', () => {
  const t0 = Date.now();
  writeFileSync(file, line({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date(t0 - 5000).toISOString(), content: '<USER_REQUEST>build it</USER_REQUEST>' })
    + line({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(t0 - 4000).toISOString(), tool_calls: [{ name: 'run_command', args: { toolSummary: '"long build"' } }] }));
  const store = new Store();
  const alerts = [];
  store.on('alert', (a) => alerts.push(a));
  store.scan();
  store.evaluate(t0);
  assert.equal(store.convs.get(ID).verdict.level, 'OK');
  store.evaluate(t0 + 90_000);
  assert.equal(store.convs.get(ID).verdict.level, 'SLOW');
  assert.equal(alerts.length, 0, 'SLOW is shown, not notified');
  store.evaluate(t0 + 9 * 60_000);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].level, alerts[0].title], ['STALLED', 'build it']);
  store.evaluate(t0 + 10 * 60_000);
  assert.equal(alerts.length, 1, 'no repeat while the level holds');

  // the tool returns and the agent finishes: back to OK, no alert
  appendFileSync(file, line({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: new Date(t0).toISOString(), content: `Created At: ${new Date(t0).toISOString()}\nCompleted At: ${new Date(t0 + 600_000).toISOString()}\nok` })
    + line({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(t0 + 601_000).toISOString(), content: 'done' }));
  store.ingest(store.convs.get(ID));
  store.evaluate(t0 + 11 * 60_000);
  assert.equal(store.convs.get(ID).verdict.level, 'OK');
  const st = store.state().runs[0];
  assert.equal(st.verdict.level, 'OK');
  assert.ok(store.state().thresholds.think.slow > 0);
});

test('a conversation already stuck at startup is shown but not notified', () => {
  const store = new Store();
  const alerts = [];
  store.on('alert', (a) => alerts.push(a));
  writeFileSync(file, line({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'x' })
    + line({ step_index: 1, type: 'ERROR_MESSAGE', status: 'DONE', created_at: new Date().toISOString(), content: '' }));
  store.scan();
  const later = Date.now() + 5 * 60_000;
  store.evaluate(later);
  assert.equal(store.convs.get(ID).verdict.level, 'STALLED');
  store.evaluate(later + 1000);
  assert.equal(alerts.length, 0);
});

test('per-model quotas: vendors sharing a pool merge; Gemini skipped when the summary covers it; 0 omitted = used up', async () => {
  const { modelQuotas } = await import('../sidecars/panel/lib/store.mjs');
  const status = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Claude Opus 5.5', quotaInfo: { remainingFraction: 0.4, resetTime: '2026-11-20T00:00:00Z' } },
    { label: 'Claude Sonnet 5.5', quotaInfo: { remainingFraction: 0.4, resetTime: '2026-11-20T00:00:00Z' } },
    { label: 'GPT-6', quotaInfo: { resetTime: '2026-11-18T00:00:00Z' } },
    { label: 'Gemini 4 Hydrogen (High)', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-21T00:00:00Z' } },
    { label: 'Old model', disabled: true, quotaInfo: { remainingFraction: 1 } },
  ] } } };
  const q = modelQuotas(status, { skipFamilies: ['Gemini'] });
  assert.deepEqual(q.map((b) => [b.label, Math.round(b.usedFraction * 100), b.models.length]), [['Claude', 60, 2], ['GPT', 100, 1]]);
  assert.equal(modelQuotas(status).length, 3);
  // one pool shared across vendors (same fraction and reset): one bucket
  status.userStatus.cascadeModelConfigData.clientModelConfigs[2].quotaInfo = { remainingFraction: 0.4, resetTime: '2026-11-20T00:00:00Z' };
  assert.deepEqual(modelQuotas(status, { skipFamilies: ['Gemini'] }).map((b) => [b.label, b.models.length]), [['Claude · GPT', 3]]);
});
