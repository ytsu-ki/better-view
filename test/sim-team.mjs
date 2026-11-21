// End-to-end Teamwork simulation (no real Antigravity data or credentials): the same shapes as a real
// /teamwork run sampled 2026-11-17 — root → Teamwork Coordinator → Project Orchestrator → explorers / workers /
// reviewer — with progress.md checklists that tick over time, one worker that stalls after an error, and a
// reviewer that joins late.
// Usage: node test/sim-team.mjs <agDir> [serverPort=47403]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AG = process.argv[2];
if (!AG) { console.error('usage: node test/sim-team.mjs <agDir> [port]'); process.exit(2); }
const PORT = process.argv[3] || '47403';
const LS_PORT = 47411;

rmSync(AG, { recursive: true, force: true });
mkdirSync(join(AG, 'daemon'), { recursive: true });
const PROJ = join(AG, 'scratch', 'todo-app');
const META = join(PROJ, '.agents', 'teamwork');
const statusFile = join(AG, 'fake-ls-status.json');
const status = {};
const setStatus = (id, s) => { status[id] = { ...status[id], ...s }; writeFileSync(statusFile, JSON.stringify(status)); };
writeFileSync(statusFile, '{}');

const kids = [];
const fakeLs = spawn(process.execPath, [join(ROOT, 'test/fake-ls.mjs'), String(LS_PORT)], { env: { ...process.env, FAKE_LS_STATUS_FILE: statusFile }, stdio: 'inherit' });
kids.push(fakeLs);
writeFileSync(join(AG, 'daemon', `hub_${LS_PORT}.json`), JSON.stringify({ pid: fakeLs.pid, httpPort: LS_PORT, httpsPort: 0, lsVersion: '2.29.0', csrfToken: 'fake' }));
const server = spawn(process.execPath, [join(ROOT, 'sidecars/panel/server.mjs')], {
  env: { ...process.env, BETTER_VIEW_AG_DIR: AG, BETTER_VIEW_PORT: PORT, BETTER_VIEW_CACHE: join(AG, 'models.json'), BETTER_VIEW_PREFS: join(AG, 'prefs.json'), BETTER_VIEW_NOTIFY: '0', ANTIGRAVITY_LS_ADDRESS: '', ANTIGRAVITY_CSRF_TOKEN: '' },
  stdio: 'inherit',
});
kids.push(server);
const stop = () => { for (const k of kids) try { k.kill(); } catch { /* gone */ } process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
server.on('exit', stop);

// ---- transcript helpers ----
let n = 0;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const conv = (title) => {
  const id = `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const dir = join(AG, 'brain', id, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  return { id, title, file: join(dir, 'transcript.jsonl'), step: 0, pending: [] };
};
const write = (c, type, extra = {}) => appendFileSync(c.file, JSON.stringify({ step_index: c.step++, type, status: 'DONE', source: 'MODEL', created_at: iso(), ...extra }) + '\n');
const args = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));
const plan = (c, calls, text = '') => write(c, 'PLANNER_RESPONSE', { input_tokens: 8000, cache_read_tokens: 40000, output_tokens: 200, content: text, tool_calls: calls.map(([name, a]) => ({ name, args: args(a) })) });
const result = (c, out, secs = 1) => { const t = Date.now(); write(c, 'GENERIC', { created_at: iso(t - secs * 1000), content: `Created At: ${iso(t - secs * 1000)}\nCompleted At: ${iso(t)}\n${out}` }); };
const sysmsg = (c, sender, text) => write(c, 'SYSTEM_MESSAGE', { source: 'SYSTEM', content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso()} sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${text}\n</SYSTEM_MESSAGE>` });
const final = (c, text) => plan(c, [], text);

/** parent invokes a subagent: planner call + "Created the following subagent" result */
function spawnAgent(parent, child, role, type, task) {
  plan(parent, [['invoke_subagent', { Role: role, TypeName: type, Model: 'inherit', Prompt: task }]]);
  result(parent, `Created the following subagent:\n{\n  "conversationId": "${child.id}",\n  "logAbsoluteUri": "file://${child.file}"\n}\nThe subagent will send you a message when it has completed its task or requires guidance.`);
  setStatus(child.id, { status: 'CASCADE_RUN_STATUS_RUNNING', title: child.title });
}
/** writes the agent's progress.md through a write_to_file call, like the real agents do */
function progress(c, name, items, note = '') {
  const path = join(META, name, 'progress.md');
  mkdirSync(dirname(path), { recursive: true });
  const md = `# Progress — ${name}\n\nLast visited: ${iso()}\n\n${items.map(([done, t]) => `- [${done === true ? 'x' : done === 'doing' ? '/' : ' '}] ${t}`).join('\n')}\n${note ? `\n## Notes\n- ${note}\n` : ''}`;
  writeFileSync(path, md);
  plan(c, [['write_to_file', { TargetFile: path, CodeContent: md, Overwrite: true, Description: 'update progress' }]]);
  result(c, `Created file file://${path} with ${md.length} bytes`);
}
const at = (sec, fn) => setTimeout(fn, sec * 1000);
/** what Antigravity writes when you open a conversation: annotations/<id>.pbtxt with last_user_view_time */
function view(c) {
  mkdirSync(join(AG, 'annotations'), { recursive: true });
  const t = Date.now();
  writeFileSync(join(AG, 'annotations', `${c.id}.pbtxt`), `title:"${c.title}" last_user_view_time:{seconds:${Math.floor(t / 1000)} nanos:${(t % 1000) * 1e6}}`);
  console.log(`[sim-team] you opened "${c.title}" in Antigravity`);
}

const root = conv('待办清单应用（Teamwork）');
const coord = conv('Teamwork Coordinator');
const orch = conv('Project Orchestrator');
const ex1 = conv('Survey Explorer Environment'), ex2 = conv('Survey Explorer Architecture');
const w1 = conv('M1 Storage Worker'), w2 = conv('M2 UI Worker'), w3 = conv('M3 Sync Worker');
const rv = conv('Independent Code Reviewer 1');

const MASTER = [
  'Read ORIGINAL_REQUEST.md and record DISPATCH.md / BRIEFING.md',
  'Phase 0: Survey (2 parallel Explorers)',
  'Phase 1: PROJECT.md with milestones and interface contracts',
  'Batch 1: M1 storage, M2 UI, M3 sync (3 workers)',
  'Batch 2: Independent review',
  'Final verification & report to Sentinel',
];
const master = (k, doing) => MASTER.map((t, i) => [i < k ? true : i === k && doing ? 'doing' : false, t]);

at(2, () => {
  setStatus(root.id, { status: 'CASCADE_RUN_STATUS_RUNNING', title: root.title });
  write(root, 'USER_INPUT', { source: 'USER', content: '<USER_REQUEST>\n/teamwork 分 3 个 worker 做一个带本地存储和同步的待办清单网页\n</USER_REQUEST>' });
  spawnAgent(root, coord, 'Teamwork Coordinator', 'teamwork', '做一个带本地存储和同步的待办清单网页');
  sysmsg(coord, root.id, '分 3 个 worker 做一个带本地存储和同步的待办清单网页');
  spawnAgent(coord, orch, 'Project Orchestrator', 'teamwork_orchestrator', 'todo app');
  sysmsg(orch, coord.id, `做一个带本地存储和同步的待办清单网页\nWorking directory: ${PROJ}\nIntegrity mode: development`);
  progress(orch, 'teamwork_orchestrator_main', master(1, true));
  for (const [c, role] of [[ex1, 'Survey Explorer Environment'], [ex2, 'Survey Explorer Architecture']]) {
    spawnAgent(orch, c, role, 'teamwork_explorer', 'survey');
    const name = c === ex1 ? 'teamwork_explorer_survey_1' : 'teamwork_explorer_survey_2';
    sysmsg(c, orch.id, `You are \`${name}\` (archetype: \`teamwork_explorer\`).\nYour working directory for metadata is:\n\`${META}/${name}/\``);
    progress(c, name, [[true, 'Read ORIGINAL_REQUEST.md'], ['doing', 'Probe runtimes and browsers'], [false, 'Write handoff.md']]);
  }
  console.log('[sim-team] t=2s root, coordinator, orchestrator, 2 explorers');
});

at(8, () => {
  for (const [c, name] of [[ex1, 'teamwork_explorer_survey_1'], [ex2, 'teamwork_explorer_survey_2']]) {
    progress(c, name, [[true, 'Read ORIGINAL_REQUEST.md'], [true, 'Probe runtimes and browsers'], [true, 'Write handoff.md']]);
    plan(c, [['send_message', { Recipient: orch.id, Message: 'Survey complete' }]]); result(c, 'Message sent');
    final(c, 'Survey complete. Handoff written.');
    setStatus(c.id, { status: 'CASCADE_RUN_STATUS_IDLE' });
  }
  progress(orch, 'teamwork_orchestrator_main', master(3, true));
  for (const [c, role, name] of [[w1, 'M1 Storage Worker', 'worker_m1'], [w2, 'M2 UI Worker', 'worker_m2'], [w3, 'M3 Sync Worker', 'worker_m3']]) {
    spawnAgent(orch, c, role, 'teamwork_worker', role);
    sysmsg(c, orch.id, `You are \`${name}\` (archetype: \`teamwork_worker\`).\nYour working directory for metadata is:\n\`${META}/${name}/\``);
    progress(c, name, [[true, 'Read PROJECT.md and DISPATCH.md'], ['doing', `Implement ${role.split(' ')[1].toLowerCase()} module`], [false, 'Unit tests'], [false, 'handoff.md + report']]);
  }
  plan(w1, [['run_command', { CommandLine: 'node tests/unit/storage.test.js', toolSummary: '运行存储模块单测' }]]);
  plan(w2, [['run_command', { CommandLine: 'npx serve -l 5173', toolSummary: '启动预览服务器并截图检查布局' }]]);
  plan(w3, [['view_file', { AbsolutePath: `${PROJ}/src/sync.js` }]]);
  result(w3, 'Showing lines 1-80');
  write(w3, 'ERROR_MESSAGE', { source: 'SYSTEM', content: 'Error: Your previous response contained an improperly formatted function call\nRetries remaining: 2' });
  console.log('[sim-team] t=8s explorers done; 3 workers start (M3 hits an error and goes quiet)');
});

at(8.5, () => view(root));
at(25, () => view(w2));
at(45, () => view(root));
at(20, () => {
  result(w1, 'Command exited with code 0.\n6 passed, 0 failed', 10);
  progress(w1, 'worker_m1', [[true, 'Read PROJECT.md and DISPATCH.md'], [true, 'Implement storage module'], [true, 'Unit tests'], ['doing', 'handoff.md + report']]);
  console.log('[sim-team] t=20s M1 tests pass');
});
at(30, () => {
  progress(w1, 'worker_m1', [[true, 'Read PROJECT.md and DISPATCH.md'], [true, 'Implement storage module'], [true, 'Unit tests'], [true, 'handoff.md + report']]);
  final(w1, 'M1 storage module done, 6/6 tests pass.');
  setStatus(w1.id, { status: 'CASCADE_RUN_STATUS_IDLE' });
  spawnAgent(orch, rv, 'Independent Code Reviewer 1', 'teamwork_reviewer', 'review M1');
  sysmsg(rv, orch.id, `You are \`reviewer_1\` (archetype: \`teamwork_reviewer\`).\nYour working directory for metadata is:\n\`${META}/reviewer_1/\``);
  progress(rv, 'reviewer_1', [['doing', 'Inspect src/storage.js'], [false, 'Run all unit suites'], [false, 'Write verdict']]);
  console.log('[sim-team] t=30s M1 done; reviewer joins');
});

// The finish (SIM_FINISH_AT seconds, default 150: after the stall has shown for a while): M3 gets past its
// error, M2 and the reviewer wrap up, the orchestrator ticks off its last steps, and every agent goes idle.
// The panel's end-of-team moment (end cap + confetti) and the checklist's all-done moment play here.
const FINISH = Number(process.env.SIM_FINISH_AT || 150);
at(FINISH, () => {
  progress(w3, 'worker_m3', [[true, 'Read PROJECT.md and DISPATCH.md'], [true, 'Implement sync module'], [true, 'Unit tests'], [true, 'handoff.md + report']]);
  progress(w2, 'worker_m2', [[true, 'Read PROJECT.md and DISPATCH.md'], [true, 'Implement ui module'], [true, 'Unit tests'], [true, 'handoff.md + report']]);
  progress(rv, 'reviewer_1', [[true, 'Inspect src/storage.js'], [true, 'Run all unit suites'], ['doing', 'Write verdict']]);
  progress(orch, 'teamwork_orchestrator_main', master(5, true));
  for (const c of [w2, w3]) { final(c, 'Module done, tests pass.'); setStatus(c.id, { status: 'CASCADE_RUN_STATUS_IDLE' }); }
  console.log(`[sim-team] t=${FINISH}s M2 and M3 done; the reviewer writes its verdict`);
});
at(FINISH + 6, () => {
  progress(rv, 'reviewer_1', [[true, 'Inspect src/storage.js'], [true, 'Run all unit suites'], [true, 'Write verdict']]);
  final(rv, 'Verdict: approve.');
  setStatus(rv.id, { status: 'CASCADE_RUN_STATUS_IDLE' });
  progress(orch, 'teamwork_orchestrator_main', master(6, false));
  for (const c of [orch, coord, root]) { final(c, 'All milestones done.'); setStatus(c.id, { status: 'CASCADE_RUN_STATUS_IDLE' }); }
  console.log(`[sim-team] t=${FINISH + 6}s everyone done`);
});
