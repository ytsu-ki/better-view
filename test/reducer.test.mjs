import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, applyRow, phaseOf, snapshot, toolBrief } from '../sidecars/panel/lib/reducer.mjs';

const T0 = Date.parse('2026-11-16T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
let step = 0;
const row = (type, s, extra = {}) => ({ step_index: step++, type, status: 'DONE', source: 'MODEL', created_at: at(s), ...extra });
const call = (name, args) => ({ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)])) });

function run(rows) {
  step = 0;
  const r = createRun('c1');
  for (const x of rows) applyRow(r, typeof x === 'function' ? x() : x);
  return r;
}

test('user input extracts prompt and model, ignoring the trailing system hint', () => {
  const r = run([row('USER_INPUT', 0, { content: '<USER_REQUEST>\n修一下测试\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini X (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>' })]);
  assert.equal(r.prompt, '修一下测试');
  assert.equal(r.model, 'Gemini X (High)');
});

test('tool call is RUNNING until its GENERIC result arrives', () => {
  const r = run([
    row('USER_INPUT', 0, { content: '<USER_REQUEST>go</USER_REQUEST>' }),
    row('PLANNER_RESPONSE', 5, { input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 50, tool_calls: [call('run_command', { CommandLine: 'npm test', toolSummary: 'Run tests' })] }),
  ]);
  const now = T0 + 20_000;
  assert.equal(phaseOf(r, now), 'TOOL_RUNNING');
  const snap = snapshot(r, now);
  assert.equal(snap.current.tool, 'run_command');
  assert.equal(snap.current.brief, 'Run tests');
  assert.deepEqual(snap.context, { used: 5050, at: T0 + 5000, source: 'estimate' });

  applyRow(r, row('GENERIC', 30, { content: 'Created At: 2026-11-16T10:00:06Z\nCompleted At: 2026-11-16T10:00:29Z\nCommand exited with code 0.' }));
  assert.equal(phaseOf(r, now), 'THINKING');
  const tool = r.steps.find((s) => s.kind === 'tool');
  assert.equal(tool.status, 'DONE');
  assert.equal(tool.endedAt - tool.startedAt, 23_000);
});

test('non-zero exit marks the step as an error', () => {
  const r = run([
    row('PLANNER_RESPONSE', 1, { tool_calls: [call('run_command', { CommandLine: 'false' })] }),
    row('GENERIC', 2, { content: 'Command exited with code 1.' }),
  ]);
  assert.equal(r.steps.at(-1).status, 'ERROR');
  assert.equal(r.steps.at(-1).exitCode, 1);
});

test('parallel tool calls are answered in order', () => {
  const r = run([
    row('PLANNER_RESPONSE', 1, { tool_calls: [call('read_file', { Path: '/a/x.js' }), call('read_file', { Path: '/a/y.js' })] }),
    row('GENERIC', 2, { content: 'ok' }),
  ]);
  const snap = snapshot(r, T0 + 3000);
  assert.equal(snap.phase, 'TOOL_RUNNING');
  assert.equal(snap.current.brief, 'y.js');
  assert.equal(snap.current.parallel, 1);
});

test('background task lifecycle: RUNNING row, then finished system message', () => {
  const id = 'c1/task-7';
  const r = run([
    row('PLANNER_RESPONSE', 1, { tool_calls: [call('run_command', { CommandLine: 'sleep 100' })] }),
    row('GENERIC', 2, { status: 'RUNNING', content: `Created At: 2026-11-16T10:00:02Z\nTool is running as a background task with task id: ${id}\nTask Description: sleep 100` }),
    row('PLANNER_RESPONSE', 3, { content: '已在后台运行。' }),
  ]);
  assert.equal(r.bg.get(id).status, 'RUNNING');
  assert.equal(phaseOf(r, T0 + 10_000), 'BG_TASK');
  assert.equal(phaseOf(r, T0 + 10_000, 'CASCADE_RUN_STATUS_IDLE'), 'BG_TASK');

  applyRow(r, row('SYSTEM_MESSAGE', 50, { source: 'SYSTEM', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=x sender=${id} priority=MESSAGE_PRIORITY_HIGH content=Task id "${id}" finished with result:\nCommand exited with code 0.` }));
  assert.equal(r.bg.get(id).status, 'DONE');
  assert.equal(r.steps.find((s) => s.taskId === id).status, 'DONE');
  assert.equal(phaseOf(r, T0 + 60_000, 'CASCADE_RUN_STATUS_IDLE'), 'IDLE');
});

test('canceled background task and kill via manage_task', () => {
  const r = run([
    row('PLANNER_RESPONSE', 1, { tool_calls: [call('run_command', { CommandLine: 'a' }), call('run_command', { CommandLine: 'b' })] }),
    row('GENERIC', 2, { status: 'RUNNING', content: 'background task with task id: c1/task-1' }),
    row('GENERIC', 2, { status: 'RUNNING', content: 'background task with task id: c1/task-2' }),
    row('SYSTEM_MESSAGE', 5, { content: 'content=Task id "c1/task-1" was canceled with result:\nTool execution was canceled' }),
    row('PLANNER_RESPONSE', 6, { tool_calls: [call('manage_task', { Action: 'kill', TaskId: 'c1/task-2' })] }),
    row('GENERIC', 7, { content: 'killed' }),
  ]);
  assert.equal(r.bg.get('c1/task-1').status, 'CANCELED');
  assert.equal(r.bg.get('c1/task-2').status, 'KILLED');
  assert.equal(r.steps.find((s) => s.taskId === 'c1/task-2').status, 'KILLED');
});

test('server restart orphans running background tasks', () => {
  const r = run([
    row('PLANNER_RESPONSE', 1, { tool_calls: [call('run_command', { CommandLine: 'a' })] }),
    row('GENERIC', 2, { status: 'RUNNING', content: 'background task with task id: c1/task-9' }),
    row('SYSTEM_MESSAGE', 9, { content: '[Notice] All your subagents and background tasks have been stopped due to server restart.' }),
  ]);
  assert.equal(r.bg.get('c1/task-9').status, 'ORPHANED');
  assert.ok(Number.isFinite(r.restartAt));
  assert.equal(r.steps.at(-1).kind, 'system');
});

test('ask_question pending means waiting for the user', () => {
  const r = run([row('PLANNER_RESPONSE', 1, { tool_calls: [call('ask_question', { questions: ['x?'] })] })]);
  assert.equal(phaseOf(r, T0 + 5000), 'WAITING_USER');
});

test('new user input cancels tool calls that never got a result', () => {
  const r = run([
    row('PLANNER_RESPONSE', 1, { tool_calls: [call('run_command', { CommandLine: 'hang' })] }),
    row('USER_INPUT', 100, { content: '<USER_REQUEST>stop</USER_REQUEST>' }),
  ]);
  assert.equal(r.pending.length, 0);
  assert.equal(r.steps.find((s) => s.kind === 'tool').status, 'CANCELED');
});

test('without the hub, a long-silent conversation reads as idle, a fresh one as thinking', () => {
  const r = run([row('USER_INPUT', 0, { content: 'hi' })]);
  assert.equal(phaseOf(r, T0 + 60_000), 'THINKING');
  assert.equal(phaseOf(r, T0 + 3 * 3600_000), 'IDLE');
  assert.equal(phaseOf(r, T0 + 3 * 3600_000, 'CASCADE_RUN_STATUS_RUNNING'), 'THINKING');
});

test('toolBrief falls back per tool when there is no toolSummary', () => {
  assert.equal(toolBrief('read_file', { Path: '"/x/y/z.ts"', StartLine: '10', EndLine: '20' }), 'z.ts:10-20');
  assert.equal(toolBrief('manage_task', { Action: '"kill"', TaskId: '"abc/task-3"' }), 'kill task-3');
  assert.equal(toolBrief('search_web', { query: '"antigravity sidecar"' }), 'antigravity sidecar');
});
