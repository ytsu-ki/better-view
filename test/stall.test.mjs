import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, applyRow } from '../sidecars/panel/lib/reducer.mjs';
import { assess, calibrate, quantile, DEFAULTS, ALERT_LEVELS } from '../sidecars/panel/lib/stall.mjs';
import { parseGlog, classify, HubLog } from '../sidecars/panel/lib/hublog.mjs';
import { extractExec } from '../sidecars/panel/lib/store.mjs';
import { notify, alertText } from '../sidecars/panel/lib/notify.mjs';

const T0 = Date.parse('2026-11-16T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const local = (s) => new Date(T0 + s * 1000).toISOString().replace('Z', '+00:00');
let step = 0;
const row = (type, s, extra = {}) => ({ step_index: step++, type, status: 'DONE', source: 'MODEL', created_at: at(s), ...extra });
const call = (name, args = {}) => ({ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)])) });
const tool = (s, dur, extra = {}) => row('GENERIC', s, { content: `Created At: ${local(s)}\nCompleted At: ${local(s + dur)}\nCommand exited with code 0.`, ...extra });
const S = 1000, MIN = 60_000;
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING', IDLE = 'CASCADE_RUN_STATUS_IDLE';

function build(rows, seenAtLast) {
  step = 0;
  const r = createRun('c1');
  rows.forEach((x, i) => applyRow(r, x, i === rows.length - 1 ? seenAtLast : undefined));
  return r;
}
const user = (s) => row('USER_INPUT', s, { content: '<USER_REQUEST>go</USER_REQUEST>' });
const planner = (s, calls = []) => row('PLANNER_RESPONSE', s, { input_tokens: 10, output_tokens: 5, tool_calls: calls, content: calls.length ? '' : 'done' });

test('row timing: GENERIC ends at Completed At, a pending tool starts when its planner row landed', () => {
  const r = build([user(0), planner(1, [call('run_command', { toolSummary: 'build' })]), tool(20, 30), planner(51, [call('run_command', { toolSummary: 'test' })])], T0 + 70 * S);
  assert.equal(r.steps.find((s) => s.brief === 'build').endedAt, T0 + 50 * S);
  assert.equal(r.pending[0].startedAt, T0 + 70 * S, 'model call ran 51s→70s; the tool starts after it');
  assert.equal(r.lastRowAt, T0 + 70 * S);
  assert.deepEqual(r.samples.think, [19 * S], 'planner at 1s answered by a tool starting at 20s');
  assert.deepEqual(r.samples.tools.run_command, [30 * S]);
});

test('CHECKPOINT and ERROR_MESSAGE rows become system steps; the turn stays open', () => {
  const r = build([user(0), row('CHECKPOINT', 5, { source: 'SYSTEM', content: '# Resuming from a compaction\n...' }),
    row('ERROR_MESSAGE', 9, { content: 'Error: Malformed function call\nRetries remaining: 3' })]);
  assert.equal(r.steps.at(-2).brief, '上下文已压缩，从摘要继续');
  assert.deepEqual([r.lastError.brief, r.lastError.retriesLeft], ['Malformed function call', 3]);
  assert.equal(r.compactedAt, T0 + 5 * S);
});

// Real sequence (2.32, 2026-11-18): you send /compact, a restart notice may ride along, the checkpoint is written,
// and the hub goes idle with TERMINAL_CUSTOM_HOOK. That is a finished turn, not a halted one.
const compactRows = () => [
  row('USER_INPUT', 0, { content: '<USER_REQUEST>\n/compact\n</USER_REQUEST>' }),
  row('SYSTEM_MESSAGE', 2, { content: '<SYSTEM_MESSAGE>[Message] sender=system content=[Notice] All your subagents and background tasks have been stopped due to server restart.</SYSTEM_MESSAGE>' }),
  row('CHECKPOINT', 2, { source: 'SYSTEM', content: '# Resuming from a compaction\n...' }),
];
const HOOK = 'EXECUTOR_TERMINATION_REASON_TERMINAL_CUSTOM_HOOK';

test('your /compact ends the turn at its checkpoint: idle afterwards, never HALTED', () => {
  const r = build(compactRows());
  assert.equal(r.lastRow.final, true);
  assert.equal(r.steps.at(-1).brief, '上下文已压缩（你发送的 /compact）');
  const v = assess(r, { now: T0 + 90 * S, lsStatus: IDLE, termination: HOOK });
  assert.equal(v.level, 'OK');
});

test('a compaction mid-turn keeps the turn open; one that ended with the custom hook is not a halt', () => {
  const mid = build([user(0), planner(1, [call('run_command', { toolSummary: 'build' })]), tool(3, 5), row('CHECKPOINT', 9, { source: 'SYSTEM', content: '# Resuming from a compaction\n...' })]);
  assert.notEqual(mid.lastRow.final, true, 'the agent carries on from the summary');
  assert.equal(mid.steps.at(-1).brief, '上下文已压缩，从摘要继续');
  assert.equal(assess(mid, { now: T0 + 90 * S, lsStatus: IDLE, termination: HOOK }).level, 'OK');
  // the same open turn stopped for another reason still is one
  assert.equal(assess(mid, { now: T0 + 90 * S, lsStatus: IDLE, termination: 'EXECUTOR_TERMINATION_REASON_ERROR' }).level, 'HALTED');
});

test('calibrate: defaults below minSamples, user percentiles above it', () => {
  const r = createRun('x');
  assert.deepEqual(calibrate([r]).think.slow, DEFAULTS.think.slow);
  r.samples.think = Array.from({ length: 100 }, (_, i) => (i + 1) * 2 * S); // p99 = 200s
  r.samples.tools.run_command = Array.from({ length: 100 }, () => 5 * S);
  const th = calibrate([r]);
  assert.equal(th.think.p99, 200 * S);
  assert.equal(th.think.slow, 200 * S);
  assert.equal(th.think.stalled, 500 * S);
  assert.equal(th.tools.run_command.slow, DEFAULTS.tool.slow, 'fast tools are floored, not 15s');
  assert.equal(quantile([3, 1, 2], 0.5), 2);
});

test('foreground tool: OK → SLOW → STALLED as it outlives the history', () => {
  const r = build([user(0), planner(1, [call('run_command', { toolSummary: 'pnpm install' })])], T0 + 2 * S);
  const v = (sec) => assess(r, { now: T0 + sec * S, lsStatus: RUNNING });
  assert.equal(v(30).level, 'OK');
  assert.equal(v(2 + 70).level, 'SLOW');
  const st = v(2 + 9 * 60);
  assert.equal(st.level, 'STALLED');
  assert.match(st.evidence[0], /命令已运行 9 分 0 秒：pnpm install/);
});

test('model silent after an error row → STALLED after a minute (the b857 case)', () => {
  const r = build([user(0), planner(1, [call('read_file', { Path: '/a' })]), tool(3, 1), row('ERROR_MESSAGE', 10, { content: '' })]);
  assert.equal(assess(r, { now: T0 + 40 * S, lsStatus: RUNNING }).level, 'OK');
  const v = assess(r, { now: T0 + 100 * S, lsStatus: RUNNING });
  assert.equal(v.level, 'STALLED');
  assert.equal(v.title, '报错后停住了');
});

test('model thinking long → SLOW, then STALLED; retries are surfaced immediately', () => {
  const r = build([user(0), planner(1, [call('read_file', { Path: '/a' })]), tool(3, 1)]);
  assert.equal(assess(r, { now: T0 + 60 * S, lsStatus: RUNNING }).level, 'OK');
  assert.equal(assess(r, { now: T0 + 4 * S + 3 * MIN, lsStatus: RUNNING }).level, 'SLOW');
  assert.equal(assess(r, { now: T0 + 4 * S + 6 * MIN, lsStatus: RUNNING }).level, 'STALLED');
  const retry = assess(r, { now: T0 + 30 * S, lsStatus: RUNNING, exec: { attempt: 2, maxAttempts: 5 } });
  assert.equal(retry.level, 'SLOW');
  assert.match(retry.evidence.join(), /重试中：第 2\/5 次/);
});

test('hub says idle but the turn never finished → HALTED (unless the user canceled)', () => {
  const r = build([user(0), planner(1, [call('run_command', { toolSummary: 'deploy' })])], T0 + 2 * S);
  assert.equal(assess(r, { now: T0 + 10 * S, lsStatus: IDLE }).level, 'OK', 'grace for poll races');
  const v = assess(r, { now: T0 + 60 * S, lsStatus: IDLE, termination: 'EXECUTOR_TERMINATION_REASON_ERROR', hubRestart: { at: T0 + 30 * S, from: 1, to: 2 } });
  assert.equal(v.level, 'HALTED');
  assert.match(v.evidence.join('\n'), /未返回的工具：命令 deploy[\s\S]*终止原因：ERROR[\s\S]*pid 1 → 2/);
  assert.equal(assess(r, { now: T0 + 60 * S, lsStatus: IDLE, termination: 'EXECUTOR_TERMINATION_REASON_USER_CANCELED' }).level, 'STOPPED');
});

test('stop pressed right after sending: no reply yet, stale termination → STOPPED, not HALTED', () => {
  // previous turn ended normally (NO_TOOL_CALL); the new message got no reply before the user stopped it
  const r = build([user(0), planner(1), user(100), row('SYSTEM_MESSAGE', 100, { source: 'SYSTEM', content: 'notice' })], T0 + 101 * S);
  const v = assess(r, { now: T0 + 400 * S, lsStatus: IDLE, termination: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL' });
  assert.equal(v.level, 'STOPPED');
  assert.ok(!ALERT_LEVELS.has(v.level));
  // the model did start this turn and the hub stopped with an error: still a real halt
  const r2 = build([user(0), planner(1, [call('run_command', { toolSummary: 'x' })]), tool(2, 1)], T0 + 4 * S);
  assert.equal(assess(r2, { now: T0 + 400 * S, lsStatus: IDLE, termination: 'EXECUTOR_TERMINATION_REASON_ERROR' }).level, 'HALTED');
});

test('hub process gone mid-turn → DEAD; a finished turn is never flagged', () => {
  const open = build([user(0), planner(1, [call('run_command', { toolSummary: 'x' })])]);
  assert.equal(assess(open, { now: T0 + 5 * S, hubGone: true }).level, 'DEAD');
  const done = build([user(0), planner(1)]);
  for (const ctx of [{ hubGone: true }, { lsStatus: IDLE }, {}]) {
    assert.equal(assess(done, { now: T0 + 3 * 3600 * S, ...ctx }).level, 'OK', JSON.stringify(ctx));
  }
  // hub busy after a final reply: shown as SLOW at most, never an alert
  assert.equal(assess(done, { now: T0 + 3 * 3600 * S, lsStatus: RUNNING }).level, 'SLOW');
});

test('waiting on the user is WAITING, never a stall — even when the hub reports idle', () => {
  const q = build([user(0), planner(1, [call('ask_question', { questions: [{ question: 'which?', options: ['a', 'b'] }] })])]);
  assert.equal(q.pending[0].brief, 'which?');
  assert.equal(assess(q, { now: T0 + 3600 * S, lsStatus: IDLE }).level, 'WAITING');
  const approval = build([user(0), planner(1, [call('run_command', { toolSummary: 'rm -rf build' })])]);
  assert.equal(assess(approval, { now: T0 + 3600 * S, lsStatus: RUNNING, exec: { waiting: true } }).level, 'WAITING');
});

test('quiet background task is annotated, not alarmed', () => {
  const r = build([user(0), planner(1, [call('run_command', { toolSummary: 'dev server' })]),
    row('GENERIC', 2, { status: 'RUNNING', content: `Created At: ${local(2)}\nTool is running as a background task with task id: c1/task-2` }), planner(3)]);
  const v = assess(r, { now: T0 + 20 * MIN, lsStatus: IDLE, bgLogs: new Map([['c1/task-2', { mtimeMs: T0 + 5 * MIN, size: 10 }]]) });
  assert.equal(v.level, 'OK');
  assert.equal(v.bgQuiet['c1/task-2'], 15 * MIN);
});

test('hub log: glog parsing, telemetry noise ignored, network needs a pattern, auth cleared by a model call', () => {
  const now = new Date(2026, 10, 16, 12, 0, 0).getTime();
  const p = parseGlog('E1116 11:59:30.123456   32052 client.go:93] something broke', now);
  assert.deepEqual([p.level, p.at, p.msg], ['E', new Date(2026, 10, 16, 11, 59, 30).getTime(), 'something broke']);
  assert.equal(classify('Post "https://play.googleapis.com/log": EOF'), null);
  assert.equal(classify('error getting token source: You are not logged into Antigravity.'), 'auth');
  assert.equal(classify('Get "https://www.googleapis.com/oauth2/v2/userinfo": dial tcp: lookup www.googleapis.com: no such host'), 'network');

  const h = new HubLog('/nonexistent');
  h.ingest('W1116 11:58:00.0 1 cache.go:1] Failed: dial tcp: lookup x: no such host', now);
  h.ingest('W1116 11:58:10.0 1 cache.go:1] Failed: dial tcp: lookup x: no such host', now);
  assert.equal(h.summary(now).network, null, 'two errors are not a pattern');
  h.ingest('W1116 11:58:20.0 1 cache.go:1] Failed: dial tcp: lookup x: no such host', now);
  assert.equal(h.summary(now).network.count, 3);
  h.ingest('E1116 11:58:30.0 1 errorreport.go:1] error getting token source: You are not logged into Antigravity.', now);
  assert.ok(h.summary(now).auth);
  h.ingest('I1116 11:59:00.0 1 http_helpers.go:1] URL: https://x/v1internal:generateContent Trace: 0x1', now);
  assert.equal(h.summary(now).auth, null);
  assert.equal(h.summary(now + 10 * MIN).network, null, 'old errors age out');
});

test('stall evidence includes hub log hints', () => {
  const r = build([user(0), planner(1, [call('read_file', { Path: '/a' })]), tool(3, 1)]);
  const v = assess(r, { now: T0 + 7 * MIN, lsStatus: RUNNING, hubLog: { auth: { at: T0 + 6 * MIN, line: '' }, network: null } });
  assert.match(v.evidence.join(), /登录状态失效/);
});

test('extractExec reads waiting state and model retries from a state update', () => {
  assert.equal(extractExec({ contextWindowUsage: {} }), null);
  const e = extractExec({ update: { executionStatus: { executionState: 'STATE_WAITING_FOR_USER', modelRequest: { attempt: '3', maxAttempts: 5, retryAt: '2026-11-16T10:00:05Z' } } } });
  assert.deepEqual([e.waiting, e.attempt, e.maxAttempts], [true, 3, 5]);
  assert.equal(extractExec({ x: { waitingSteps: [{ stepIndex: 4 }] } }).waiting, true);
  assert.equal(extractExec({ x: { executionState: 'STATE_RUNNING' } }).waiting, false);
});

test('notifications pass text as argv, never inside the AppleScript', () => {
  const calls = [];
  const prev = process.env.BETTER_VIEW_NOTIFY;
  delete process.env.BETTER_VIEW_NOTIFY;
  try {
    const t = alertText({ level: 'STALLED', title: 'evil" & do shell script "rm', headline: '疑似卡住', evidence: ['命令已运行 9 分'], hint: '发送继续' });
    const sent = notify(t.title, t.subtitle, t.body, (...a) => calls.push(a));
    if (process.platform !== 'darwin') return assert.equal(sent, false);
    const [bin, args] = calls[0];
    assert.equal(bin, '/usr/bin/osascript');
    const script = args.filter((_, i) => args[i - 1] === '-e').join('\n');
    assert.doesNotMatch(script, /evil|疑似/);
    assert.ok(args.includes('evil" & do shell script "rm'));
    assert.equal(t.title, '🔴 疑似卡住');
    assert.equal(t.body, '命令已运行 9 分 · 发送继续');
  } finally {
    if (prev !== undefined) process.env.BETTER_VIEW_NOTIFY = prev;
  }
});

test('alerts of one level landing together become one notification', async () => {
  const { groupText } = await import('../sidecars/panel/lib/notify.mjs');
  const mk = (title) => ({ level: 'DEAD', title, headline: '服务已退出', evidence: ['e'], hint: '重新打开' });
  assert.equal(groupText('DEAD', [mk('a')]).subtitle, 'a');
  const g = groupText('DEAD', [mk('a'), mk('b'), mk('c')]);
  assert.deepEqual([g.title, g.subtitle, g.body], ['⛔ 服务已退出（3 个会话）', 'a、b、c', '重新打开']);
});

test('a Teamwork parent waiting on its subagents is never flagged, even when the hub calls it idle', () => {
  const r = build([user(0), planner(1, [call('invoke_subagent', { Role: 'Teamwork Coordinator' })]), tool(2, 1)]);
  for (const lsStatus of [RUNNING, IDLE]) {
    const v = assess(r, { now: T0 + 30 * MIN, lsStatus, activeChildren: 2 });
    assert.equal(v.level, 'OK', lsStatus);
    assert.equal(v.waitingOn, 2);
  }
  assert.equal(assess(r, { now: T0 + 30 * MIN, lsStatus: RUNNING, activeChildren: 0 }).level, 'STALLED', 'children done: back to normal rules');
});
