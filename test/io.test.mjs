import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlTailer } from '../sidecars/panel/lib/transcript.mjs';
import { encodeEnvelope, decodeEnvelopes, findAll } from '../sidecars/panel/lib/hub.mjs';
import { normalizeQuota, extractContext, decodePbString } from '../sidecars/panel/lib/store.mjs';

test('JsonlTailer reads increments, buffers partial lines, survives truncation', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'bv-')), 't.jsonl');
  const tail = new JsonlTailer(f);
  assert.deepEqual(tail.poll(), []); // missing file
  writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":');
  assert.deepEqual(tail.poll(), [{ a: 1 }, { a: 2 }]);
  appendFileSync(f, '3}\nnot json\n{"中":"文"}\n');
  assert.deepEqual(tail.poll(), [{ a: 3 }, { 中: '文' }]);
  assert.deepEqual(tail.poll(), []);
  writeFileSync(f, '{"b":1}\n'); // replaced with a shorter file
  assert.deepEqual(tail.poll(), [{ b: 1 }]);
});

test('Connect envelopes round-trip, split across chunks, with end-of-stream flag', () => {
  const a = encodeEnvelope({ x: 1 });
  const b = encodeEnvelope({ y: '二' });
  const end = Buffer.concat([Buffer.from([2, 0, 0, 0, 2]), Buffer.from('{}')]);
  const all = Buffer.concat([a, b, end]);
  const first = decodeEnvelopes(all.subarray(0, a.length + 3));
  assert.deepEqual(first.messages.map((m) => m.data), [{ x: 1 }]);
  const second = decodeEnvelopes(Buffer.concat([first.rest, all.subarray(a.length + 3)]));
  assert.deepEqual(second.messages.map((m) => [m.end, m.data]), [[false, { y: '二' }], [true, {}]]);
  assert.equal(second.rest.length, 0);
});

test('normalizeQuota reads RetrieveUserQuotaSummary groups and buckets', () => {
  const q = normalizeQuota({
    groups: [{ displayName: 'Gemini Pro', buckets: [
      { bucketId: 'pro-5h', displayName: '5 小时', window: '5h', remainingFraction: 0.25, resetTime: '2026-11-16T15:00:00Z' },
      { bucketId: 'pro-week', displayName: '本周', window: '7d', remainingFraction: 0.9 },
      { bucketId: 'off', displayName: 'off', remainingFraction: 1, disabled: true },
    ] }],
  });
  assert.equal(q.length, 2);
  assert.deepEqual(q[0], { group: 'Gemini Pro', id: 'pro-5h', label: '5 小时', short: '5 小时', window: '5h', usedFraction: 0.75, resetTime: '2026-11-16T15:00:00Z' });
  assert.ok(Math.abs(q[1].usedFraction - 0.1) < 1e-9);
});

test('normalizeQuota falls back to nested quotaInfo (GetUserStatus shape)', () => {
  const q = normalizeQuota({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Gemini Flash', quotaInfo: { remainingFraction: 0.6, resetTime: 'r' } },
  ] } } });
  assert.deepEqual(q.map((b) => [b.label, Math.round(b.usedFraction * 100)]), [['Gemini Flash', 40]]);
});

test('extractContext finds contextWindowUsage at any depth; int64 strings become numbers', () => {
  const ctx = extractContext({ update: { conversationUpdate: { contextWindowUsage: { estimatedTokensUsed: '151000', maxContextTokens: '1048576', estimatedAfterCompaction: '40000' } } } });
  assert.equal(ctx.used, 151000);
  assert.equal(ctx.max, 1048576);
  assert.equal(ctx.afterCompaction, 40000);
  assert.equal(extractContext({ nothing: true }), null);
  assert.equal(findAll({ a: [{ k: 1 }, { b: { k: 2 } }] }, 'k').length, 2);
});

test('decodePbString decodes octal UTF-8 escapes from text protos', () => {
  assert.equal(decodePbString('Todo \\345\\276\\205\\345\\212\\236\\346\\270\\205\\345\\215\\225'), 'Todo 待办清单');
  assert.equal(decodePbString('say \\"hi\\"\\n'), 'say "hi"\n');
});

test('normalizeQuota: omitted remainingFraction on an identified bucket means exhausted; short labels', async () => {
  const { normalizeQuota } = await import('../sidecars/panel/lib/store.mjs');
  const out = normalizeQuota({ groups: [{ buckets: [
    { bucketId: 'w', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.34, resetTime: '2026-11-21T02:22:46Z' },
    { bucketId: 'f', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-11-17T04:01:45Z' },
    { bucketId: 'x', displayName: 'Off', disabled: true },
    { displayName: 'by amount', remainingAmount: '12' },
  ] }] });
  assert.deepEqual(out.map((b) => [b.short, Math.round(b.usedFraction * 100)]), [['Weekly', 66], ['Five Hour', 100]]);
});

test('model limit cache round-trips and ignores junk', async () => {
  const { loadModelLimits, saveModelLimits } = await import('../sidecars/panel/lib/store.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const f = join(mkdtempSync(join(tmpdir(), 'bv-')), 'sub', 'models.json');
  assert.equal(loadModelLimits(f).size, 0);
  saveModelLimits(new Map([['Gemini 4 Hydrogen (Medium)', 1048576]]), f);
  assert.equal(loadModelLimits(f).get('Gemini 4 Hydrogen (Medium)'), 1048576);
  writeFileSync(f, '{"a":"x","b":-1,"c":5}');
  assert.deepEqual([...loadModelLimits(f)], [['c', 5]]);
});

test('parseAnnotation reads the title and when you last opened the conversation', async () => {
  const { parseAnnotation } = await import('../sidecars/panel/lib/store.mjs');
  const a = parseAnnotation('title:"Multi-Agent \\351\\270\\237" last_user_view_time:{seconds:1794899884 nanos:298000000}');
  assert.equal(a.viewedAt, 1794899884298);
  assert.equal(a.title, 'Multi-Agent 鸟');
  assert.deepEqual(parseAnnotation('title:"x"'), { title: 'x', viewedAt: null });
});
