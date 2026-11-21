import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// a private prefs file, and no env override, so the saved choice decides
const dir = mkdtempSync(join(tmpdir(), 'bv-i18n-'));
process.env.BETTER_VIEW_PREFS = join(dir, 'prefs.json');
delete process.env.BETTER_VIEW_LANG;
const { setLang, currentLang, systemLang, tr, fmtMs } = await import('../sidecars/panel/lib/i18n.mjs');
const { createRun, applyRow } = await import('../sidecars/panel/lib/reducer.mjs');
const { assess } = await import('../sidecars/panel/lib/stall.mjs');
const { decodeBreakdown } = await import('../sidecars/panel/lib/ctxdb.mjs');

test('saved choice wins; auto follows the system language', () => {
  assert.equal(setLang('en'), 'en');
  assert.equal(tr('中', 'en'), 'en');
  assert.equal(fmtMs(65_000), '1m 5s');
  assert.deepEqual(JSON.parse(readFileSync(process.env.BETTER_VIEW_PREFS, 'utf8')), { lang: 'en' });
  assert.equal(setLang('zh'), 'zh');
  assert.equal(fmtMs(65_000), '1 分 5 秒');
  assert.equal(setLang('auto'), systemLang());
  assert.ok(['zh', 'en'].includes(currentLang()));
});

test('verdicts come out in English when English is chosen', () => {
  setLang('en');
  const T0 = Date.parse('2026-11-17T00:00:00Z');
  const r = createRun('x');
  applyRow(r, { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date(T0).toISOString(), content: '<USER_REQUEST>go</USER_REQUEST>' });
  const v = assess(r, { now: T0 + 600_000, lsStatus: 'CASCADE_RUN_STATUS_IDLE', termination: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL' });
  assert.equal(v.level, 'STOPPED');
  assert.equal(v.title, 'Stopped before any reply');
  assert.match(v.evidence.join('\n'), /stopped 10m 0s ago/);
  setLang('auto');
});

// protobuf writer for the test fixture: just enough to build gen_metadata → 1 → 9 → 10
const vint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const fld = (f, v) => (typeof v === 'number' ? [...vint(f * 8), ...vint(v)] : [...vint(f * 8 + 2), ...vint(v.length), ...v]);
const str = (s) => [...Buffer.from(s)];
const msg = (...parts) => parts.flat();

test('context breakdown decodes from the conversation store', () => {
  const group = (name, tokens, kids) => msg(fld(1, str(name)), fld(4, tokens), ...kids.map(([n, t]) => fld(5, msg(fld(1, str(n)), fld(3, t)))));
  const bd = msg(fld(1, group('System Prompt', 12805, [['skills', 3143], ['identity', 99]])), fld(1, group('Tools', 8298, [])), fld(1, group('Chat Messages', 148, [])), fld(2, 21251));
  const meta = msg(fld(1, 21251), fld(3, bd), fld(4, 840000));
  const blob = Uint8Array.from(fld(1, msg(fld(2, 7), fld(9, msg(fld(10, meta))))));
  const out = decodeBreakdown(blob);
  assert.equal(out.used, 21251);
  assert.equal(out.max, 840000);
  assert.deepEqual(out.groups.map((g) => [g.name, g.tokens]), [['System Prompt', 12805], ['Tools', 8298], ['Chat Messages', 148]]);
  assert.equal(out.groups[0].top[0].name, 'skills');
  assert.equal(decodeBreakdown(Uint8Array.from([1, 2, 3])), null);
});
