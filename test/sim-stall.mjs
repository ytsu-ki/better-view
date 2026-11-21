// End-to-end stall simulation with no real Antigravity data or credentials.
// Builds a throwaway Antigravity data dir, a fake hub (discovery file + fake LS), starts the panel
// server against it, then writes transcripts over time so each verdict happens live:
//   t≈3s   four conversations appear (all look normal)
//   t≈10s  "部署"      hub reports idle while the turn is open      → HALTED  (alert ~15s later)
//   t≈12s  "重构"      agent asks a question                         → WAITING (alert)
//   t≈63s  "修复登录"  error row, then silence for a minute          → STALLED (alert, with network evidence)
//          "构建"      pnpm install running past the 1-minute floor → SLOW    (shown, not notified)
//   t=KILL fake hub process exits                                     → DEAD    (alert for busy conversations)
// Usage: node test/sim-stall.mjs <agDir> [serverPort=47402] [killAtSec=100]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AG = process.argv[2];
if (!AG) { console.error('usage: node test/sim-stall.mjs <agDir> [port] [killAtSec]'); process.exit(2); }
const PORT = process.argv[3] || '47402';
const KILL_AT = Number(process.argv[4] || 100);
const LS_PORT = 47410;

rmSync(AG, { recursive: true, force: true });
mkdirSync(join(AG, 'daemon'), { recursive: true });
const statusFile = join(AG, 'fake-ls-status.json');
const status = {};
const setStatus = (id, s) => { status[id] = { ...status[id], ...s }; writeFileSync(statusFile, JSON.stringify(status)); };
writeFileSync(statusFile, '{}');

const kids = [];
const fakeLs = spawn(process.execPath, [join(ROOT, 'test/fake-ls.mjs'), String(LS_PORT)], { env: { ...process.env, FAKE_LS_STATUS_FILE: statusFile }, stdio: 'inherit' });
kids.push(fakeLs);
writeFileSync(join(AG, 'daemon', `hub_${LS_PORT}.json`), JSON.stringify({ pid: fakeLs.pid, httpPort: LS_PORT, httpsPort: 0, lsVersion: '2.29.0', csrfToken: 'fake' }));

const server = spawn(process.execPath, [join(ROOT, 'sidecars/panel/server.mjs')], {
  env: { ...process.env, BETTER_VIEW_AG_DIR: AG, BETTER_VIEW_PORT: PORT, BETTER_VIEW_CACHE: join(AG, 'models.json'), BETTER_VIEW_PREFS: join(AG, 'prefs.json'), ANTIGRAVITY_LS_ADDRESS: '', ANTIGRAVITY_CSRF_TOKEN: '' },
  stdio: 'inherit',
});
kids.push(server);
const stop = () => { for (const k of kids) try { k.kill(); } catch { /* gone */ } process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
server.on('exit', stop);

// ---- transcript helpers ----
let n = 0;
const conv = (title) => {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const dir = join(AG, 'brain', id, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  return { id, title, file: join(dir, 'transcript.jsonl'), step: 0 };
};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const write = (c, type, extra = {}) => appendFileSync(c.file, JSON.stringify({ step_index: c.step++, type, status: 'DONE', source: 'MODEL', created_at: iso(), ...extra }) + '\n');
const user = (c, text) => write(c, 'USER_INPUT', { source: 'USER', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting \`Model Selection\` from None to Gemini 4 Hydrogen (Medium). No need to comment on this change.</USER_SETTINGS_CHANGE>` });
const plan = (c, calls, text = '') => write(c, 'PLANNER_RESPONSE', { input_tokens: 9000, cache_read_tokens: 60000, output_tokens: 300, content: text, tool_calls: calls.map(([name, args]) => ({ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)])) })) });
const done = (c, secs = 2, out = 'ok') => { const t = Date.now(); write(c, 'GENERIC', { created_at: iso(t - secs * 1000), content: `Created At: ${iso(t - secs * 1000)}\nCompleted At: ${iso(t)}\n${out}` }); };
const glog = (lvl, msg) => { const d = new Date(); const p = (x, w = 2) => String(x).padStart(w, '0'); return `${lvl}${p(d.getMonth() + 1)}${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000000   4242 cache.go:189] ${msg}\n`; };
const at = (sec, fn) => setTimeout(fn, sec * 1000);

const A = conv('构建项目'), B = conv('修复登录 bug'), C = conv('部署到预发环境'), D = conv('重构数据层');
const RUN = 'CASCADE_RUN_STATUS_RUNNING';

at(3, () => {
  for (const c of [A, B, C, D]) setStatus(c.id, { status: RUN, title: c.title });
  user(A, '安装依赖并构建');
  plan(A, [['run_command', { CommandLine: 'pnpm install && pnpm build', toolSummary: 'pnpm install 并构建' }]]);

  user(B, '登录后跳回首页的 bug 修一下');
  plan(B, [['read_file', { Path: '/repo/src/auth/session.ts' }]]);
  done(B, 1, 'Showing lines 1-80');
  write(B, 'ERROR_MESSAGE', { source: 'SYSTEM', content: '' });
  mkdirSync(join(AG, 'log'), { recursive: true });
  const logFile = join(AG, 'log', 'cli-sim.log');
  writeFileSync(logFile, ['dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host', 'Post "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent": EOF', 'dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host']
    .map((m) => glog('W', `Failed to refresh cache in background: ${m}`)).join(''));
  symlinkSync(logFile, join(AG, 'cli.log'));

  user(C, '部署到 staging');
  plan(C, [['run_command', { CommandLine: './scripts/deploy.sh staging', toolSummary: '部署到 staging' }]]);

  user(D, '把数据层改成 repository 模式');
  console.log('[sim] t=3s  four conversations written');
});
at(10, () => { setStatus(C.id, { status: 'CASCADE_RUN_STATUS_IDLE', termination: 'EXECUTOR_TERMINATION_REASON_ERROR' }); console.log('[sim] t=10s 部署: hub now reports IDLE'); });
at(12, () => {
  plan(D, [['ask_question', { questions: [{ question: '保留现有 DAO 接口做兼容层吗？', options: ['(Recommended) 保留', '直接替换'], is_multi_select: false }, { question: '要同时补迁移脚本吗？', options: ['是', '否'], is_multi_select: false }] }]], '需要先确认一件事');
  console.log('[sim] t=12s 重构: asked a question');
});
at(KILL_AT, () => { fakeLs.kill(); console.log(`[sim] t=${KILL_AT}s fake hub process killed`); });
