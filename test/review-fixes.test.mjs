// Fixes from the 2026-11-18 review (DESIGN.md §0.15): hub choice, quota families, the notifier lease,
// parallel questions, whose checklist, text decoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const AG = mkdtempSync(join(tmpdir(), 'bv-ag-'));
process.env.BETTER_VIEW_AG_DIR = AG;
const { findEndpoint } = await import('../sidecars/panel/lib/hub.mjs');
const { normalizeQuota, quotaFamilies, parseAnnotation, decodePbString, checklistOf } = await import('../sidecars/panel/lib/store.mjs');
const { takeLease, attachNotifier, LEASE_MS } = await import('../sidecars/panel/lib/notify.mjs');
const { createRun, applyRow, phaseOf, snapshot } = await import('../sidecars/panel/lib/reducer.mjs');
const { assess } = await import('../sidecars/panel/lib/stall.mjs');
const { JsonlTailer } = await import('../sidecars/panel/lib/transcript.mjs');

const T0 = Date.parse('2026-11-16T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const call = (name, args = {}) => ({ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)])) });
const planner = (s, calls) => ({ type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(s), tool_calls: calls, content: '' });
const build = (rows) => { const r = createRun('c1'); for (const x of rows) applyRow(r, x); return r; };

test('two live hubs: the one that started this process wins, else the newest discovery file', () => {
  const dir = join(AG, 'daemon');
  mkdirSync(dir, { recursive: true });
  const hub = (port, pid, ageS) => {
    const f = join(dir, `hub_${port}.json`);
    writeFileSync(f, JSON.stringify({ pid, httpPort: port, csrfToken: 'x', lsVersion: String(port) }));
    const t = Date.now() / 1000 - ageS;
    utimesSync(f, t, t);
  };
  hub(57430, 111, 60); // Gemini's agy hub: sorts first by name
  hub(57828, 222, 600); // Antigravity's hub: older file
  const alive = () => true;
  assert.equal(findEndpoint({ dir, ppid: 222, alive }).pid, 222, 'our parent hub, though its file is older and sorts later');
  assert.equal(findEndpoint({ dir, ppid: 111, alive }).pid, 111);
  assert.equal(findEndpoint({ dir, ppid: 999, alive }).pid, 111, 'no parent among them: the newest file');
  assert.equal(findEndpoint({ dir, ppid: 222, alive: (pid) => pid !== 222 }).pid, 111, 'a dead hub is never chosen');
  rmSync(dir, { recursive: true });
});

test('quota 2.32: groups wrapped in response, one per family, same window names, exhausted bucket kept', () => {
  const resp = { response: { groups: [
    { displayName: 'Gemini Models', buckets: [
      { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9 },
      { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.4 }] },
    { displayName: 'Claude and GPT models', buckets: [
      { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1 },
      { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-11-18T10:00:00Z' }] },
  ] } };
  const buckets = normalizeQuota(resp);
  assert.deepEqual(buckets.map((b) => [b.group, b.window, Math.round(b.usedFraction * 100)]), [
    ['Gemini Models', 'weekly', 10], ['Gemini Models', '5h', 60], ['Claude and GPT models', 'weekly', 0], ['Claude and GPT models', '5h', 100]]);
  // the per-model pool from GetUserStatus joins its family instead of making a third ring
  const fams = quotaFamilies([...buckets, { group: 'model', label: 'Claude · GPT', short: 'Claude · GPT', window: null, usedFraction: 0.2, models: ['Claude Opus 5.5 (High)'] }]);
  assert.deepEqual(fams.map((f) => [f.name, f.window, Math.round(f.usedFraction * 100), f.buckets.length]), [['Gemini', '5h', 60, 2], ['Claude · GPT', '5h', 100, 3]]);
  // ties go to the shorter window; group-less buckets (the 2.29 shared pool) are one unnamed family
  const tie = quotaFamilies(normalizeQuota({ groups: [{ buckets: [
    { bucketId: 'w', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.5 },
    { bucketId: 'f', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.5 }] }] }));
  assert.deepEqual(tie.map((f) => [f.name, f.window]), [[null, '5h']]);
});

test('notifier lease: one holder while it is alive and recent; a dead or quiet holder is replaced', () => {
  const f = join(AG, 'lease.json');
  const alive = (pid) => pid !== 3;
  assert.equal(takeLease(f, { pid: 1, now: 1000, alive }), true, 'first one takes it');
  assert.equal(takeLease(f, { pid: 2, now: 2000, alive }), false, 'holder alive and recent');
  assert.equal(takeLease(f, { pid: 1, now: 3000, alive }), true, 'the holder renews');
  assert.equal(takeLease(f, { pid: 2, now: 3000 + LEASE_MS + 1, alive }), true, 'quiet past the lease: the next one takes over');
  assert.equal(takeLease(f, { pid: 1, now: 3000 + LEASE_MS + 2, alive }), false);
  writeFileSync(f, JSON.stringify({ pid: 3, at: 3000 + LEASE_MS + 5 }));
  assert.equal(takeLease(f, { pid: 1, now: 3000 + LEASE_MS + 6, alive }), true, 'holder process gone');
});

test('attachNotifier groups one pass of alerts per level and asks the lease before every notification', { skip: process.platform !== 'darwin' }, async () => {
  const store = new EventEmitter();
  const sent = [];
  let mayNotify = true;
  attachNotifier(store, { log: () => {}, lease: () => mayNotify, send: (title, subtitle) => sent.push([title, subtitle]), wait: 5 });
  for (const t of ['A', 'B']) store.emit('alert', { id: t, title: t, level: 'STALLED', headline: 'stuck', evidence: [], hint: '' });
  store.emit('alert', { id: 'C', title: 'C', level: 'WAITING', headline: 'needs you', evidence: [], hint: '' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 2, 'STALLED ×2 grouped, WAITING alone');
  assert.match(sent[0][1], /A.+B/);
  mayNotify = false; // another process holds the lease
  store.emit('finished', { title: 'X', turnMs: 5 * 60_000, summary: '' });
  assert.equal(sent.length, 2);
});

test('a question asked alongside another tool still waits for you', () => {
  const r = build([planner(1, [call('run_command', { CommandLine: 'sleep 999' }), call('ask_question', { questions: [{ question: 'Which DB?' }] })])]);
  assert.equal(phaseOf(r, T0 + 600_000), 'WAITING_USER');
  assert.equal(snapshot(r, T0 + 600_000).current.tool, 'ask_question');
  const v = assess(r, { now: T0 + 3600_000, lsStatus: 'CASCADE_RUN_STATUS_RUNNING' });
  assert.equal(v.level, 'WAITING');
  assert.match(v.evidence[0], /Which DB\?/);
});

test("only the agent's own files become its checklist; a gone or empty one falls back to task.md", () => {
  const edit = (path) => build([planner(1, [call('write_to_file', { TargetFile: path, CodeContent: '- [ ] x' })])]).checklistFile;
  assert.equal(edit('/Users/me/proj/TODO.md'), null, "your project's TODO.md");
  assert.equal(edit('/Users/me/proj/docs/plan.md'), null);
  assert.equal(edit('/p/.agents/teamwork/worker_m1/progress.md'), '/p/.agents/teamwork/worker_m1/progress.md');
  const art = `/x/brain/${'a'.repeat(8)}-1111-2222-3333-${'b'.repeat(12)}/task.md`;
  assert.equal(edit(art), art);

  const ID = '11111111-2222-3333-4444-555555555555';
  mkdirSync(join(AG, 'brain', ID), { recursive: true });
  writeFileSync(join(AG, 'brain', ID, 'task.md'), '- [x] a\n- [/] b\n');
  const gone = checklistOf({ id: ID, checklistFile: join(AG, 'nope', 'progress.md'), turnStartedAt: 0 });
  assert.deepEqual([gone.file, gone.done, gone.total], [`${ID}/task.md`, 1, 2]);
  const emptyFile = join(AG, 'empty-progress.md');
  writeFileSync(emptyFile, '# notes, no checkboxes\n');
  assert.equal(checklistOf({ id: ID, checklistFile: emptyFile, turnStartedAt: 0 }).total, 2);
});

test('annotations: "title: ..." with a space; raw emoji and a bad \\x survive', () => {
  assert.equal(parseAnnotation('title: "Remember me on login"\nlast_user_view_time: { seconds: 1 }').title, 'Remember me on login');
  assert.equal(decodePbString('ok 🚀 \\346\\226\\260'), 'ok 🚀 新');
  assert.equal(decodePbString('a\\xZZ'), 'axZZ');
  assert.equal(decodePbString('a\\x41b'), 'aAb');
  assert.equal(decodePbString('end\\'), 'end\\');
});

test('JsonlTailer: a character split across two reads stays intact; truncation says reset', () => {
  const f = join(AG, 't.jsonl');
  const line = Buffer.from(JSON.stringify({ t: '中文' }) + '\n');
  const cut = line.indexOf(Buffer.from('文')) + 1; // inside the 3-byte character
  writeFileSync(f, line.subarray(0, cut));
  const tail = new JsonlTailer(f);
  assert.deepEqual(tail.poll(), []);
  appendFileSync(f, line.subarray(cut));
  assert.deepEqual(tail.poll(), [{ t: '中文' }]);
  assert.equal(tail.reset, false);
  writeFileSync(f, '{"t":1}\n');
  assert.deepEqual(tail.poll(), [{ t: 1 }]);
  assert.equal(tail.reset, true);
});
