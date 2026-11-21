import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRun, applyRow, snapshot, toolBrief } from '../sidecars/panel/lib/reducer.mjs';
import { buildTeams, familyOf, shortName } from '../sidecars/panel/lib/team.mjs';
import { parseChecklist, summarizeItems, lastNote, readProgress } from '../sidecars/panel/lib/checklist.mjs';

const T0 = Date.parse('2026-11-17T06:24:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const args = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));
function run(cid, rows) {
  const r = createRun(cid);
  rows.forEach((x, i) => applyRow(r, { step_index: i, status: 'DONE', source: 'MODEL', ...x }));
  return r;
}
const sys = (s, sender, body) => ({ type: 'SYSTEM_MESSAGE', created_at: at(s), content: `<SYSTEM_MESSAGE>\n[Message] timestamp=x sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${body}\n</SYSTEM_MESSAGE>` });
const invoke = (s, role, type) => ({ type: 'PLANNER_RESPONSE', created_at: at(s), tool_calls: [{ name: 'invoke_subagent', args: args({ Role: role, TypeName: type, Prompt: 'x' }) }] });
const created = (s, child) => ({ type: 'GENERIC', created_at: at(s), content: `Created At: ${at(s)}\nCompleted At: ${at(s + 1)}\nCreated the following subagent:\n{\n  "conversationId": "${child}",\n  "logAbsoluteUri": "file:///x"\n}` });

test('reducer reads team identity: parent, own name, spawned children with roles, progress file', () => {
  const orch = run(id(3), [
    sys(0, id(2), 'Build it\nWorking directory: /p'),
    invoke(1, 'M1 Kinematics Worker', 'teamwork_worker'), created(2, id(10)),
    { type: 'PLANNER_RESPONSE', created_at: at(3), tool_calls: [{ name: 'write_to_file', args: args({ TargetFile: '/p/.agents/teamwork/teamwork_orchestrator_main/progress.md', CodeContent: '- [x] a' }) }] },
    { type: 'GENERIC', created_at: at(3), content: `Created At: ${at(3)}\nCompleted At: ${at(4)}\nok` },
    { type: 'PLANNER_RESPONSE', created_at: at(5), tool_calls: [{ name: 'write_to_file', args: args({ TargetFile: '/p/.agents/teamwork/ORIGINAL_REQUEST.md', CodeContent: '- [ ] acceptance' }) }] },
  ]);
  assert.equal(orch.parentId, id(2));
  assert.deepEqual([...orch.children], [[id(10), { role: 'M1 Kinematics Worker', type: 'teamwork_worker' }]]);
  assert.equal(orch.checklistFile, '/p/.agents/teamwork/teamwork_orchestrator_main/progress.md', 'request files with acceptance criteria are not progress');
  const w = run(id(10), [sys(0, id(3), 'You are `worker_m1` (archetype: `teamwork_worker`).\nYour working directory: `/p/.agents/teamwork/worker_m1/`')]);
  assert.equal(w.agentName, 'worker_m1');
  const interviewer = run(id(11), [sys(0, id(2), 'Working directory: /p/.agents/teamwork/interviewer/ Relay to: x')]);
  assert.equal(interviewer.agentName, 'interviewer', 'name from the metadata directory when there is no "You are"');
});

test('reducer keeps one checklist item per user request when no progress file exists', () => {
  const r = run(id(1), [
    { type: 'USER_INPUT', created_at: at(0), content: '<USER_REQUEST>做个动画</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', created_at: at(5), content: 'done', tool_calls: [] },
    { type: 'USER_INPUT', created_at: at(9), content: '<USER_REQUEST>还有多少轮</USER_REQUEST>' },
    { type: 'USER_INPUT', created_at: at(12), content: '<USER_REQUEST>算了，先移动文件</USER_REQUEST>' },
  ]);
  assert.deepEqual(r.turns.map((t) => [t.text, t.done]), [['做个动画', true], ['还有多少轮', 'superseded'], ['算了，先移动文件', false]]);
  assert.equal(snapshot(r, T0 + 20_000).turns.length, 3);
});

test('tool briefs for the real Antigravity file tools show the file, not the full path', () => {
  assert.equal(toolBrief('write_to_file', args({ TargetFile: '/a/b/progress.md', Description: 'update' })), 'progress.md · update');
  assert.equal(toolBrief('view_file', args({ AbsolutePath: '/a/b/main.js', StartLine: 1, EndLine: 40 })), 'main.js:1-40');
  assert.equal(toolBrief('invoke_subagent', args({ Role: 'Reviewer 1', TypeName: 'teamwork_reviewer' })), 'Reviewer 1');
});

test('buildTeams: one team per root, breadth-first members, roles and families from the spawning call', () => {
  const runs = [
    { id: id(1), parentId: null, children: [[id(2), { role: 'Teamwork Coordinator', type: 'teamwork' }]], firstAt: 0, title: 'Bird' },
    { id: id(2), parentId: id(1), children: [[id(3), { role: 'Project Orchestrator', type: 'teamwork_orchestrator' }]], firstAt: 1 },
    { id: id(3), parentId: id(2), children: [[id(5), { role: 'Independent Code Reviewer 1', type: 'teamwork_reviewer' }], [id(4), { role: 'M1 Worker', type: 'teamwork_worker' }]], firstAt: 2 },
    { id: id(5), parentId: id(3), agentName: 'reviewer_1', children: [], firstAt: 9 },
    { id: id(4), parentId: id(3), agentName: 'worker_m1', children: [], firstAt: 5 },
    { id: id(9), parentId: null, children: [], firstAt: 3, title: 'Other task' },
  ];
  const { info, groups } = buildTeams(runs);
  assert.equal(groups.length, 2);
  const team = groups.find((g) => g.rootId === id(1));
  assert.deepEqual(team.memberIds, [id(1), id(2), id(3), id(4), id(5)]);
  assert.equal(team.isTeam, true);
  assert.deepEqual([info.get(id(4)).family, info.get(id(4)).name, info.get(id(4)).depth], ['build', 'M1 Worker', 3]);
  assert.deepEqual([info.get(id(5)).family, info.get(id(5)).name], ['review', 'Reviewer 1'], 'long role → short agent name');
  assert.equal(info.get(id(1)).name, '你的会话');
  assert.equal(groups.find((g) => g.rootId === id(9)).isTeam, false);
  // a child whose parent conversation isn't on disk becomes its own root instead of vanishing
  const orphan = buildTeams([{ id: id(7), parentId: id(99), children: [] }]);
  assert.equal(orphan.info.get(id(7)).rootId, id(7));
});

test('family and short names', () => {
  assert.equal(familyOf('teamwork_explorer'), 'explore');
  assert.equal(familyOf('teamwork_test_writer'), 'build');
  assert.equal(familyOf(null, 'victory_auditor_1'), 'review');
  assert.equal(familyOf('teamwork_interviewer'), 'lead');
  assert.equal(shortName('M2 UI Worker', 'worker_m2'), 'M2 UI Worker');
  assert.equal(shortName('Survey Explorer Environment', 'teamwork_explorer_survey_1'), 'Explorer Survey 1');
});

test('checklist parsing: states, nesting, current item, notes', () => {
  const md = `# Progress\n- [x] **Read** \`DISPATCH.md\`\n- [ ] Implement [kinematics](src/k.js)\n  - [x] wing curve\n  - [ ] tail\n- [ ] Report\n\n## Timeline\n- **06:37Z**: Implemented kinematics.js\n`;
  const items = parseChecklist(md);
  assert.deepEqual(items.map((i) => [i.state, i.text, i.depth]), [
    ['done', 'Read DISPATCH.md', 0], ['next', 'Implement kinematics', 0], ['done', 'wing curve', 1], ['todo', 'tail', 1], ['todo', 'Report', 0]]);
  assert.deepEqual(summarizeItems(items), { done: 1, total: 3 }, 'top-level items count');
  assert.equal(parseChecklist('- [/] doing it\n- [ ] later')[0].state, 'doing');
  assert.equal(lastNote(md), 'Implemented kinematics.js');
  const dir = mkdtempSync(join(tmpdir(), 'bv-ck-'));
  const f = join(dir, 'progress.md');
  writeFileSync(f, md);
  assert.equal(readProgress(f).items.length, 5);
  assert.equal(readProgress(join(dir, 'missing.md')), null);
});
