import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// a fake Antigravity data dir: brain/<id>/task.md is the agent's artifact (written per rules/AGENTS.md)
const AG = mkdtempSync(join(tmpdir(), 'bv-ag-'));
process.env.BETTER_VIEW_AG_DIR = AG;
const { checklistOf } = await import('../sidecars/panel/lib/store.mjs');
const { parseChecklist } = await import('../sidecars/panel/lib/checklist.mjs');
const ID = '11111111-2222-3333-4444-555555555555';
const task = join(AG, 'brain', ID, 'task.md');
mkdirSync(join(AG, 'brain', ID), { recursive: true });

test('Antigravity task format: [ ] to do, [/] in progress, [x] done', () => {
  const items = parseChecklist('- [x] Read the code\n- [/] Fix the bug\n- [ ] Run the tests\n  - [ ] unit');
  assert.deepEqual(items.map((i) => [i.state, i.depth]), [['done', 0], ['doing', 0], ['todo', 0], ['todo', 1]]);
});

test('the artifact task.md is the checklist; your messages are never listed', () => {
  writeFileSync(task, '- [x] Plan\n- [/] Build\n- [ ] Test\n');
  const c = checklistOf({ id: ID, turnStartedAt: 0, turns: [{ text: 'hello', done: true }] });
  assert.equal(c.source, 'file');
  assert.deepEqual([c.done, c.total], [1, 3]);
  assert.equal(c.items[1].state, 'doing');
  // no list file at all: nothing, not a list of messages
  assert.equal(checklistOf({ id: 'none', turns: [{ text: 'hello', done: true }] }), null);
});

test("a finished list from an earlier request is hidden once a new request starts", () => {
  writeFileSync(task, '- [x] Plan\n- [x] Build\n');
  const t = Date.now() / 1000 - 600;
  utimesSync(task, t, t);
  assert.equal(checklistOf({ id: ID, turnStartedAt: Date.now() - 60_000 }), null);
  assert.equal(checklistOf({ id: ID, turnStartedAt: Date.now() - 3600_000 }).total, 2);
});
