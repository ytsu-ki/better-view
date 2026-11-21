// Demo of the task list: a fake Antigravity data dir with one conversation whose task.md (the artifact the
// Better View rule asks for) advances a step every few seconds, served by the panel in standalone mode.
// Usage: node test/demo-checklist.mjs [port=47408]
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.argv[2] || '47408';
const AG = mkdtempSync(join(tmpdir(), 'bv-demo-'));
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const logs = join(AG, 'brain', ID, '.system_generated', 'logs');
mkdirSync(logs, { recursive: true });
mkdirSync(join(AG, 'annotations'), { recursive: true });
const iso = (t) => new Date(t).toISOString();
const t0 = Date.now() - 5000;
const row = (o) => appendFileSync(join(logs, 'transcript.jsonl'), JSON.stringify({ status: 'DONE', ...o }) + '\n');
row({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: iso(t0), content: '<USER_REQUEST>给登录页加上记住我功能</USER_REQUEST>' });
row({ step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: iso(t0 + 2000), tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"npm test"' } }] });
writeFileSync(join(AG, 'annotations', `${ID}.pbtxt`), `title: "Remember me on login"\nlast_user_view_time: { seconds: ${Math.floor(Date.now() / 1000)} }\n`);

const STEPS = ['读登录页和会话代码', '加“记住我”勾选框', '延长 cookie 有效期', '写测试', '跑测试并修复'];
let at = 0;
const write = () => writeFileSync(join(AG, 'brain', ID, 'task.md'),
  STEPS.map((s, i) => `- [${i < at ? 'x' : i === at ? '/' : ' '}] ${s}`).join('\n') + '\n');
write();
setInterval(() => { at = (at + 1) % (STEPS.length + 1); write(); }, 4000);

const child = spawn(process.execPath, [join(ROOT, 'sidecars/panel/server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, BETTER_VIEW_AG_DIR: AG, BETTER_VIEW_PORT: PORT, BETTER_VIEW_NO_HUB: '1', BETTER_VIEW_NOTIFY: '0', BETTER_VIEW_PREFS: join(AG, 'prefs.json') },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(); process.exit(0); });
