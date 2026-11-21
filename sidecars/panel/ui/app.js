// Better View UI. Renders /api/events snapshots. All transcript text goes through textContent.
// One screen per task: a Teamwork run (root conversation + every subagent) is one task, never a jump between agents.
// Two languages: every string is L(zh, en). The server decides (Antigravity's language, or the 中/EN switch)
// and sends it as state.lang, so the panel, verdicts and notifications always agree.

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...kids) {
  const el = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false && kid !== '') el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---------- language ----------
// Until the server says otherwise: the host's locale (Antigravity is an Electron app; its frames inherit it).
let LANG = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
const L = (zh, en) => (LANG === 'en' ? en : zh);
const T = (pair) => (Array.isArray(pair) ? L(pair[0], pair[1]) : pair);
function setDocLang() { document.documentElement.lang = LANG === 'en' ? 'en' : 'zh'; }
setDocLang();

// ---------- formatting ----------
const fmtDur = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const hr = Math.floor(m / 60);
  if (hr < 48) return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(hr / 24)}d`;
};
const ago = (ms) => L(`${fmtDur(ms)}前`, `${fmtDur(ms)} ago`);
const fmtTok = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (f) => `${Math.round(f * 100)}%`;
const clock = (t) => (Number.isFinite(t) ? new Date(t).toTimeString().slice(0, 5) : '');

const TOOL = {
  run_command: ['命令', 'Command'], read_file: ['读取', 'Read'], view_file: ['读取', 'Read'], edit_file: ['编辑', 'Edit'],
  write_file: ['写入', 'Write'], write_to_file: ['写入', 'Write'], replace_file_content: ['编辑', 'Edit'],
  multi_replace_file_content: ['编辑', 'Edit'], search_web: ['搜索', 'Search'], manage_task: ['任务', 'Task'],
  ask_question: ['提问', 'Question'], manage_subagents: ['团队', 'Team'], invoke_subagent: ['派出', 'Dispatch'],
  send_message: ['发消息', 'Message'], schedule: ['计划', 'Schedule'],
};
const toolName = (t) => (TOOL[t] ? T(TOOL[t]) : t || L('工具', 'Tool'));
const VERB = {
  run_command: ['运行命令', 'Running a command'], read_file: ['读取文件', 'Reading a file'], view_file: ['读取文件', 'Reading a file'],
  write_file: ['写入文件', 'Writing a file'], write_to_file: ['写入文件', 'Writing a file'], edit_file: ['编辑文件', 'Editing a file'],
  replace_file_content: ['编辑文件', 'Editing a file'], multi_replace_file_content: ['编辑文件', 'Editing a file'],
  search_web: ['搜索网页', 'Searching the web'], invoke_subagent: ['派出子 agent', 'Dispatching a subagent'],
  send_message: ['发送消息', 'Sending a message'], manage_task: ['管理后台任务', 'Managing a background task'],
  ask_question: ['向你提问', 'Asking you'], manage_subagents: ['管理团队', 'Managing the team'],
};

const PHASE = {
  THINKING: { label: ['思考中', 'Thinking'], cls: 'run', icon: '◌' },
  TOOL_RUNNING: { label: ['执行中', 'Running'], cls: 'run', icon: '▶' },
  WAITING_USER: { label: ['等你回复', 'Waiting for you'], cls: 'wait', icon: '?' },
  BG_TASK: { label: ['后台任务', 'Background task'], cls: 'run', icon: '⟳' },
  IDLE: { label: ['空闲', 'Idle'], cls: '', icon: '✓' },
};
// Stall verdict levels (server: lib/stall.mjs). Severity colors always ship with an icon and a label.
const LEVEL = {
  WAITING: { label: ['等你操作', 'Needs you'], icon: '?', cls: 'wait' },
  SLOW: { label: ['比平时慢', 'Slower than usual'], icon: '⚠', cls: 'slow' },
  STALLED: { label: ['疑似卡住', 'Looks stuck'], icon: '⚠', cls: 'stall' },
  HALTED: { label: ['已停止 · 未完成', 'Stopped · unfinished'], icon: '■', cls: 'stall' },
  DEAD: { label: ['服务已退出', 'Service exited'], icon: '✕', cls: 'stall' },
  STOPPED: { label: ['已停止', 'Stopped'], icon: '■', cls: '' }, // stopped by you: a state, not an alert
};
const levelLabel = (lv) => T(LEVEL[lv].label);
const ALERT = new Set(['STALLED', 'HALTED', 'DEAD']);
const RANK = { DEAD: 5, HALTED: 4, STALLED: 4, WAITING: 3, SLOW: 2, STOPPED: 1 };
const levelOf = (r) => (r?.verdict && LEVEL[r.verdict.level] ? r.verdict.level : null);

const STATUS = {
  DONE: ['✓', 's-ok', ['完成', 'Done']], ERROR: ['✕', 's-err', ['出错', 'Error']], RUNNING: ['◐', 's-run', ['运行中', 'Running']],
  BACKGROUND: ['⟳', 's-run', ['后台运行', 'In background']], CANCELED: ['⊘', 's-idle', ['已取消', 'Canceled']],
  KILLED: ['⊘', 's-idle', ['已终止', 'Killed']], ORPHANED: ['⊘', 's-err', ['服务重启后中断', 'Cut off by a restart']],
  UNFINISHED: ['⊘', 's-err', ['未完成（已停止）', 'Unfinished (stopped)']],
};
const FAMILY = { lead: ['协调', 'Lead'], explore: ['调研', 'Explore'], build: ['实现', 'Build'], review: ['审查', 'Review'] };
const YOU = () => L('你的会话', 'Your conversation');
const agentLabel = (m) => (m.team.depth === 0 ? YOU() : m.team.name);

// ---------- state ----------
let state = null;
let skew = 0;
let byId = new Map();
// What to show: the conversation you have open in Antigravity (state.focus). Picking a task here overrides
// that until you open another conversation in Antigravity.
let selected = null; // team root id being shown
let manualAt = null; // focus.at when the picker was last used; null = following Antigravity
let lastFocus = null;
let detailId = null; // an agent inside the selected team
const open = new Set(); // expanded sections, by key
const now = () => Date.now() + skew;
// embedded (?embed=1, or Antigravity's own plugin sidebar / aux pane: /sidebar, /aux): no page title
const PARAMS = new URLSearchParams(location.search);
const TOKEN = PARAMS.get('token');
if (PARAMS.has('embed') || /\/(sidebar|aux)\/?$/.test(location.pathname) || window.parent !== window) document.documentElement.dataset.embed = '1';
// Inside Antigravity the host opens the plugin page with ?conversationId=<the conversation it belongs to>
const HOST_CONV = /^[0-9a-f-]{36}$/.test(PARAMS.get('conversationId') || '') ? PARAMS.get('conversationId') : null;
// The host pushes its theme as CSS variables (shadcn names: --background, --foreground, ...). Map the ones we
// need onto our own tokens; never copy the whole set: the host's --muted is a background color, and names
// like that would silently repaint our text.
const HOST_THEME = { '--background': '--page', '--foreground': '--ink', '--secondary-foreground': '--ink-2', '--muted-foreground': '--ink-3', '--border': '--hair', '--link': '--ok' };
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.data?.type !== 'theme-change') return;
  const vars = e.data.payload?.cssVariables || {};
  const root = document.documentElement.style;
  for (const [from, to] of Object.entries(HOST_THEME)) if (typeof vars[from] === 'string' && vars[from].trim()) root.setProperty(to, vars[from]);
});

// ---------- tooltip ----------
const tip = $('tip');
let tipOwner = null; // the element the tip belongs to; an update that rebuilt it away hides the tip (no mouseleave comes)
/** `content`: text, or a function building text or a Node when the tip opens (so times in it are current). */
function showTip(el, content, x, y, below = 14) {
  if (tipOwner !== el || tip.style.display === 'none') {
    const c = typeof content === 'function' ? content() : content;
    tip.classList.toggle('rich', c instanceof Node);
    if (c instanceof Node) tip.replaceChildren(c);
    else tip.textContent = c;
  }
  tipOwner = el;
  tip.style.display = 'block';
  tip.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - tip.offsetWidth - 8))}px`;
  // under the pointer; above it when there's no room below (the activity log sits at the bottom)
  const h = tip.offsetHeight;
  tip.style.top = `${y + below + h > innerHeight - 8 ? Math.max(8, y - h - 10) : y + below}px`;
}
function hideTip() { tipOwner = null; tip.style.display = 'none'; }
const tips = new WeakMap(); // element -> its tip content, so a rebuilt element can take over the open tip
let pointer = null; // where the pointer opened the tip ([x, y]); null when focus opened it
function attachTip(el, text) {
  if (!text) return el;
  tips.set(el, text);
  el.addEventListener('mousemove', (e) => { pointer = [e.clientX, e.clientY]; showTip(el, text, e.clientX, e.clientY); });
  el.addEventListener('mouseleave', hideTip);
  // keyboard: the same details on focus (buttons and rows that take focus)
  el.addEventListener('focusin', () => { if (el.matches(':focus-visible, :has(:focus-visible)')) { pointer = null; const r = el.getBoundingClientRect(); showTip(el, text, r.left, r.bottom, 6); } });
  el.addEventListener('focusout', hideTip);
  return el;
}

// ---------- motion ----------
// The panel is rebuilt from scratch on every update (every 1.5-2 s), so motion can't live in the DOM. It lives
// here, keyed by what an element stands for: a value that changed glides from where it was, something that
// just appeared enters, a step that just finished pops, and nothing moves while nothing changes.
// prefers-reduced-motion turns all of it off: values jump, nothing enters, no screen transitions.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const calm = () => REDUCED.matches;
// previews and screenshot tools whose pane draws no frames: ?frames=timer drives the glides with timers instead
if (PARAMS.get('frames') === 'timer') window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);

// Tweened numbers (bars, rings, counters). First sight starts at `from` after `delay`; a new target starts
// from wherever the value is right now, so an update mid-glide never jumps.
const tweens = new Map(); // key -> {from, to, t0, dur, delay}
const easeOut = (x) => 1 - (1 - x) ** 3;
function tweenAt(s, t = performance.now()) {
  const x = (t - s.t0 - s.delay) / s.dur;
  return x >= 1 ? s.to : x <= 0 ? s.from : s.from + (s.to - s.from) * easeOut(x);
}
function tween(key, to, { from = 0, dur = 900, delay = 0 } = {}) {
  const t = performance.now();
  let s = tweens.get(key);
  if (!s) tweens.set(key, (s = { from: calm() ? to : from, to, t0: t, dur, delay }));
  else if (s.to !== to) Object.assign(s, { from: calm() ? to : tweenAt(s, t), to, t0: t, dur, delay: 0 });
  return s;
}
const gliding = new Set(); // {el, s, apply} still on their way
let frame = 0;
function step() {
  frame = 0;
  const t = performance.now();
  for (const g of gliding) {
    if (!g.el.isConnected) { gliding.delete(g); continue; }
    const v = tweenAt(g.s, t);
    g.apply(g.el, v);
    if (v === g.s.to) gliding.delete(g);
  }
  if (gliding.size) frame = requestAnimationFrame(step);
}
/** Paint `el` at the tween's current value now (apply(el, value)) and keep repainting it until it arrives. */
function glide(el, key, to, apply, opts) {
  const s = tween(key, to, opts);
  const v = tweenAt(s);
  apply(el, v);
  if (v !== s.to) { gliding.add({ el, s, apply }); frame ||= requestAnimationFrame(step); }
  return el;
}

// One-shot CSS animations that survive rebuilds: `fire` starts one; until it's over, every rebuilt element
// gets the class again with --d = its (negative) elapsed time, so it carries on instead of restarting.
const shots = new Map(); // key -> {at, end}
function fx(el, key, cls, fire = false, { delay = 0, dur = 700 } = {}) {
  if (!el || calm()) return el;
  const t = performance.now();
  if (fire) shots.set(key, { at: t + delay, end: t + delay + dur });
  const s = shots.get(key);
  if (!s) return el;
  if (t > s.end) { shots.delete(key); return el; }
  el.classList.add(cls);
  el.style.setProperty('--d', `${Math.round(s.at - t)}ms`);
  return el;
}

// What changed since the previous update (never on first sight), and what arrived on the screen in view
// (a screen you just switched to has nothing "arriving": it is simply there).
const last = new Map();
function changed(key, v) { const had = last.has(key), p = last.get(key); last.set(key, v); return had && p !== v; }
function rose(key, v) { const p = last.get(key); last.set(key, v); return p != null && v > p; }
const seen = new Set();
let fresh = true;
function arrived(key) { const n = !seen.has(key); seen.add(key); return n && !fresh; }

/** Looping animations restart whenever their element is rebuilt: pin them all to the document clock, so a spinner keeps turning across updates instead of snapping back every 2 s. */
function syncLoops() {
  for (const a of document.getAnimations?.() || []) {
    if (a.startTime !== 0 && a.effect?.getTiming?.().iterations === Infinity) a.startTime = 0;
  }
}

const fxLayer = document.body.appendChild(h('div', { class: 'fx', 'aria-hidden': 'true' }));
const afterRender = []; // run once the new DOM is in place and has positions
/** A small burst of confetti in the level colors from the middle of `el`: something big just finished. */
function burst(el, n = 16) {
  if (calm() || !el?.isConnected || !fxLayer.animate) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const css = getComputedStyle(document.documentElement);
  const colors = ['--l0', '--l1', '--l2', '--l3'].map((v) => css.getPropertyValue(v).trim());
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < n; i++) {
    const p = fxLayer.appendChild(h('i', { style: `left:${cx - 2.5}px;top:${cy - 2.5}px;background:${colors[i % colors.length]};${i % 3 ? '' : 'border-radius:50%'}` }));
    const a = (i / n) * 2 * Math.PI + Math.random() * 0.6;
    const d = 22 + Math.random() * 34;
    const dx = Math.cos(a) * d * 1.3, dy = Math.sin(a) * d - 10;
    const spin = (Math.random() * 2 - 1) * 280;
    const done = () => p.remove();
    p.animate([
      { transform: 'translate(0,0) rotate(0deg) scale(.6)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) rotate(${spin / 2}deg) scale(1)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx * 1.1}px,${dy + 18}px) rotate(${spin}deg) scale(.5)`, opacity: 0 },
    ], { duration: 950 + Math.random() * 350, easing: 'cubic-bezier(.15,.7,.35,1)' }).finished.then(done, done);
  }
}

/** The connection dot blinks whenever new data actually changed something: the panel is alive. */
let pulseSig = '';
function heartbeat(s) {
  const sig = JSON.stringify((s.runs || []).map((r) => [r.id, r.lastActivityAt, r.phase, r.checklist?.done]));
  if (sig === pulseSig) return;
  pulseSig = sig;
  const dot = $('conn').firstElementChild;
  if (!dot || calm()) return;
  dot.classList.remove('beat');
  void dot.offsetWidth;
  dot.classList.add('beat');
}

/** Change screens through a view transition: 'fwd' into an agent, 'back' out of one, 'fade' otherwise. */
function go(update, dir = 'fade') {
  if (calm() || !document.startViewTransition || document.hidden) { update(); return; }
  const root = document.documentElement;
  root.dataset.nav = dir;
  const clear = () => { if (root.dataset.nav === dir) delete root.dataset.nav; };
  let ran = false;
  const run = () => { if (!ran) { ran = true; update(); } };
  try {
    const vt = document.startViewTransition(run);
    vt.finished.then(clear, clear);
    // a transition waits for a frame; a pane that draws none (hidden, throttled) must not leave the click hanging
    setTimeout(() => { if (!ran) { vt.skipTransition(); run(); } }, 250);
  } catch { clear(); run(); }
}

// ---------- language switch ----------
// Click: the other language, saved for every Better View view and the notifications. Alt-click: follow
// Antigravity again.
const langBtn = $('lang');
langBtn.addEventListener('click', async (e) => {
  const want = e.altKey ? 'auto' : LANG === 'zh' ? 'en' : 'zh';
  if (want !== 'auto') go(() => { LANG = want; setDocLang(); render(); });
  try { await saveLang(want); } catch (err) { lastError = `lang: ${err.message}`; }
});
async function saveLang(lang) {
  if (window.BV_HOST) return window.BV_HOST.callTool('set_language', { lang });
  const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Sidecar-Token': TOKEN } : {}) };
  const res = await fetch('api/lang', { method: 'POST', headers, body: JSON.stringify({ lang }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
function renderLang() {
  langBtn.hidden = false;
  langBtn.textContent = LANG === 'zh' ? 'EN' : '中';
  langBtn.title = L(`切换到 English（当前：${state?.langAuto ? '跟随 Antigravity' : '手动选择'}；按住 Option 点击恢复跟随）`,
    `Switch to 中文 (now: ${state?.langAuto ? 'following Antigravity' : 'chosen by you'}; Option-click to follow Antigravity again)`);
  langBtn.setAttribute('aria-label', langBtn.title);
}

// ---------- usage: what's left ----------
const WINDOW = { '5h': ['5 小时', '5h'], daily: ['每日', 'Daily'], weekly: ['每周', 'Weekly'] };
const winName = (w) => (WINDOW[w] ? T(WINDOW[w]) : w || '');
/** "Resets in 6d 17h" / "3h 54m" / "12m", as Antigravity's Usage panel words it. */
function untilReset(iso) {
  const ms = Date.parse(iso || '') - now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.ceil(ms / 60_000), hr = Math.floor(m / 60), d = Math.floor(hr / 24);
  const dur = d ? `${d}d${hr % 24 ? ` ${hr % 24}h` : ''}` : hr ?`${hr}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  return L(`${dur}后重置`, `Resets in ${dur}`);
}
/** What a bucket is called inside its family: its window ("5 小时"), else its own short name (a per-model pool). */
const bucketName = (b) => (b.window ? L(`${winName(b.window)}额度`, `${winName(b.window)} limit`) : b.short || b.label);
/**
 * One ring per model family (Gemini, Claude · GPT, ...): the window closest to running out speaks for the family,
 * named under the ring when the family has more than one; the tooltip lists every window with its reset time.
 */
function quota(f, i = 0) {
  const rem = Math.max(0, 1 - f.usedFraction);
  const sev = rem <= 0.1 ? 'crit' : rem <= 0.3 ? 'warn' : '';
  const color = sev === 'crit' ? 'var(--critical)' : sev === 'warn' ? 'var(--warning)' : 'var(--ok)';
  const name = f.name || L('共享额度', 'Shared');
  const several = f.buckets.length > 1;
  const leftAt = (v) => (rem <= 0 && v <= 0.004 ? L('已用尽', 'Used up') : L(`剩 ${pct(v)}`, `${pct(v)} left`));
  const sub = (v) => (several && f.window ? `${winName(f.window)} · ${leftAt(v)}` : leftAt(v));
  // the ring draws itself in on first sight, one ring after another, and glides (with its number) on change
  const key = `q:${f.name || 'shared'}`;
  const opts = { delay: 150 + i * 110, dur: 1100 };
  const arc = glide(h('svg:circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round',
    pathLength: 100, 'stroke-dasharray': '100 200', transform: 'rotate(-90 12 12)' }), key, rem,
  (el, v) => { el.setAttribute('stroke-dashoffset', (100 - v * 100).toFixed(2)); el.style.opacity = v > 0.003 ? '' : '0'; }, opts);
  const svg = h('svg:svg', { viewBox: '0 0 24 24', role: 'img', 'aria-label': `${name} ${sub(rem)}` },
    h('svg:circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'var(--track)', 'stroke-width': 3 }), arc);
  const left = glide(h('span', { class: sev }), key, rem, (el, v) => { el.textContent = sub(v); }, opts);
  const el = h('div', { class: 'quota', tabindex: 0 }, svg, h('div', { class: 'q-l' }, h('b', {}, name), left));
  // crossing into amber or red: the ring gives one small jolt
  fx(el, `qping:${key}`, 'ping', changed(`qsev:${key}`, sev) && sev !== '', { dur: 900 });
  return attachTip(el, () => quotaTip(f, name));
}

/**
 * The tooltip, laid out like Antigravity's Usage panel: a heading, then one row per window ("Weekly limit … 92% left")
 * with when it resets underneath. Windows stay in the server's order; a model's own pool inside the family (a summary
 * group of its own, like "Gemini 4 Argon") gets its own heading. A window still at 100% has no reset to show.
 */
function quotaTip(f, name) {
  const box = h('div', { class: 'qt' }, h('b', { class: 'qt-h' }, name));
  let group = f.buckets.find((b) => b.group && b.group !== 'model')?.group;
  for (const b of f.buckets) {
    if (b.group && b.group !== 'model' && b.group !== group) box.append(h('b', { class: 'qt-h' }, (group = b.group)));
    const r = Math.max(0, 1 - b.usedFraction);
    const sev = r <= 0.1 ? 'crit' : r <= 0.3 ? 'warn' : '';
    const label = bucketName(b) === name ? L('额度', 'Limit') : bucketName(b);
    box.append(h('span', {}, label), h('span', { class: `qt-v ${sev}` }, r <= 0.004 ? L('已用尽', 'Used up') : L(`剩 ${pct(r)}`, `${pct(r)} left`)));
    const reset = r < 0.995 && untilReset(b.resetTime);
    if (reset) box.append(h('small', {}, reset));
  }
  const models = f.buckets.flatMap((b) => b.models || []);
  if (models.length > 1) box.append(h('small', { class: 'qt-m' }, L(`共用：${models.join('、')}`, `Shared by ${models.join(', ')}`)));
  return box;
}

function renderUsage() {
  const q = state.quota || {};
  const box = $('usage');
  // older servers send buckets only: one family each
  const fams = q.families || (q.buckets || []).map((b) => ({ ...b, name: b.short || b.label, buckets: [b] }));
  if (fams.length) box.replaceChildren(...fams.map(quota));
  else box.replaceChildren(h('div', { class: 'muted' }, state.ls?.ok
    ? (q.error ? L(`暂未取到用量（${q.error}）`, `Usage not available yet (${q.error})`) : L('读取用量中…', 'Reading usage…'))
    : L('连接 Antigravity 后显示余量', 'Usage shows once Antigravity is connected')));
}

// ---------- task selection ----------
const recent = (t) => now() - (t.lastActivityAt || 0) < 3600_000;
const teamOf = (id) => (state.teams || []).find((t) => t.memberIds.includes(id));
function pickTeam() {
  const teams = state.teams || [];
  if (!teams.length) return null;
  // the host's conversation wins over "most recently viewed" when the page is embedded in Antigravity
  const f = HOST_CONV && (state.runs || []).some((r) => r.id === HOST_CONV) ? { id: HOST_CONV, at: 1 } : state.focus;
  const following = manualAt == null || (f && f.at > manualAt);
  if (following) {
    manualAt = null;
    const t = f && teamOf(f.id);
    if (t && f.id + f.at !== lastFocus) {
      // you opened a conversation in Antigravity: show it (a subagent opens straight into its detail)
      lastFocus = f.id + f.at;
      selected = t.rootId;
      detailId = f.id !== t.rootId ? f.id : null;
    }
    if (!selected || !teams.some((x) => x.rootId === selected)) selected = (t || teams[0]).rootId;
  }
  return teams.find((t) => t.rootId === selected) || teams[0];
}

function teamIcon(t) {
  if (LEVEL[t.worst] && t.worst !== 'SLOW') return LEVEL[t.worst].icon;
  return t.active ? '◐' : '✓';
}
// The list is only rebuilt when an entry changed, and never while it has focus: replacing the options of an
// open dropdown closes it under your pointer. Whatever changed meanwhile lands when it loses focus.
let pickerSig = '';
let pickerLater = false;
function renderPicker(team) {
  const sel = $('picker');
  sel.setAttribute('aria-label', L('选择任务', 'Choose a task'));
  const following = manualAt == null;
  const label = (t) => `${teamIcon(t)} ${t.title}${t.isTeam ? L(`（${t.memberIds.length} 个 agent）`, ` (${t.memberIds.length} agents)`) : ''}`;
  const opts = [['__focus', following && team ? L(`◉ 当前：${team.title}`, `◉ Current: ${team.title}`) : L('◉ 回到 Antigravity 当前会话', '◉ Back to the conversation open in Antigravity')],
    ...(state.teams || []).slice(0, 30).map((t) => [t.rootId, label(t)])];
  const value = following ? '__focus' : team?.rootId;
  const sig = JSON.stringify([opts, value]);
  if (sig === pickerSig) return;
  if (document.activeElement === sel) { pickerLater = true; return; }
  pickerSig = sig;
  pickerLater = false;
  sel.replaceChildren(...opts.map(([v, text]) => h('option', { value: v }, text)));
  sel.value = value;
}
$('picker').addEventListener('blur', () => { if (pickerLater && state) renderPicker(pickTeam()); });
$('picker').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.blur(); // a choice made: the list may update again
  go(() => {
    if (v === '__focus') { manualAt = null; lastFocus = null; }
    else { manualAt = state.focus?.at ?? 0; selected = v; detailId = null; }
    open.clear();
    render();
  });
});

// ---------- pieces ----------
function agentState(r) {
  const lv = levelOf(r);
  if (lv && lv !== 'SLOW') return { icon: LEVEL[lv].icon, cls: lv === 'WAITING' ? 's-run' : lv === 'STOPPED' ? 's-idle' : 's-err', label: levelLabel(lv), pill: LEVEL[lv].cls };
  if (r.verdict?.waitingOn && r.turnOpen) return { icon: '◐', cls: 's-run', label: L(`等待 ${r.verdict.waitingOn} 个子 agent`, `Waiting on ${r.verdict.waitingOn} subagents`), pill: 'run', waiting: true };
  if (r.phase !== 'IDLE') return { icon: '◐', cls: lv === 'SLOW' ? 's-warn' : 's-run', label: lv === 'SLOW' ? levelLabel('SLOW') : PHASE[r.phase] ? T(PHASE[r.phase].label) : L('运行中', 'Running'), pill: lv === 'SLOW' ? 'slow' : 'run' };
  if (!r.turnOpen) return { icon: '✓', cls: 's-ok', label: L('已完成', 'Done'), pill: 'done' };
  return { icon: '○', cls: 's-idle', label: L('空闲', 'Idle'), pill: '' };
}

function head({ title, sub, st, meta, back, key }) {
  const pill = st && h('span', { class: `pill ${st.pill}` }, h('span', { class: 'dot' }), st.label);
  if (pill && key) fx(pill, `pill:${key}`, 'chg', changed(`hpill:${key}`, st.pill), { dur: 450 }); // a new status slides in
  return h('div', { class: 'head' },
    back && h('button', { class: 'back', onclick: back }, L('← 返回团队', '← Back to the team')),
    h('div', { class: 't' }, h('h1', { title }, title), pill),
    sub && h('div', { class: 'meta' }, sub),
    meta && h('div', { class: 'meta' }, meta));
}

function sinceSpan(t, live) {
  return live ? h('span', { class: 'num', 'data-since': t }, fmtDur(now() - t)) : h('span', { class: 'num' }, fmtDur(t));
}

/**
 * The verdict, with its evidence: never just "stuck", always why we think so and what to do. On a team's
 * screen (who = which agent) the card opens that agent's details: one click from the alarm to the agent.
 */
function alertCard(r, who) {
  const v = r.verdict;
  const lvKey = levelOf(r);
  const lv = LEVEL[lvKey];
  if (!lv) return null;
  const goTo = who ? (e) => {
    if (selecting()) return; // selecting evidence to copy it is not a click
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openAgent(r.id);
  } : null;
  const card = h('section', { class: `card alert ${lv.cls} ${goTo ? 'go' : ''}`, role: ALERT.has(v.level) ? 'alert' : 'status',
    tabindex: goTo ? 0 : null, onclick: goTo, onkeydown: goTo },
    h('div', { class: 'alert-head' },
      h('span', { class: 'alert-icon', 'aria-hidden': 'true' }, lv.icon),
      h('span', { class: 'alert-title' }, v.title || levelLabel(lvKey)),
      v.since && h('span', { class: 'num alert-since', 'data-since': v.since }, fmtDur(now() - v.since))),
    who && h('div', { class: 'who' }, h('span', {}, who), goTo && h('span', { class: 'open-it' }, L('查看详情 →', 'Details →'))));
  if (v.evidence?.length) card.append(h('ul', { class: 'evidence' }, v.evidence.map((e) => h('li', {}, e))));
  if (v.hint) card.append(h('div', { class: 'hint' }, L('建议：', 'Suggestion: '), v.hint));
  // a new verdict drops in; a stuck / stopped one also shakes once
  return fx(card, `al:${r.id}`, 'alert-in', r._fx?.lv === lvKey, { dur: 950 });
}

const CK_STATE = { done: ['已完成', 'Done'], doing: ['进行中', 'In progress'], next: ['下一项', 'Next'], todo: ['未开始', 'Not started'], dropped: ['已放弃', 'Dropped'] };
function checklistCard(owner, { title, ownerLabel } = {}) {
  const c = owner?.checklist;
  if (!c || (!c.items.length && !c.note)) return null;
  const key = `ck:${owner.id}`;
  const card = h('section', { class: 'card' });
  const doneAll = c.total > 0 && c.done === c.total;
  let counter = null;
  if (c.total) {
    const n = fx(h('span', {}, `${c.done}`), `ckn:${owner.id}`, 'bump', changed(`ckn:${owner.id}`, c.done), { dur: 450 });
    counter = h('span', { class: 'aside num' }, n, ` / ${c.total}${doneAll ? L(' · 全部完成', ' · all done') : ''}`);
    if (changed(`ckall:${owner.id}`, doneAll) && doneAll) afterRender.push(() => burst(counter, 14)); // the last step just got done
  }
  card.append(h('div', { class: 'card-h' }, h('h2', {}, title || L('任务清单', 'Checklist')), counter));
  if (c.items.length) {
    const LIMIT = 10;
    let items = c.items;
    if (!open.has(key) && items.length > LIMIT) {
      // the window around the current item; with nothing in progress, the most recent ones
      const cur = items.findIndex((i) => i.state === 'doing' || i.state === 'next');
      const start = cur < 0 ? items.length - LIMIT : Math.max(0, Math.min(cur - 3, items.length - LIMIT));
      items = items.slice(start, start + LIMIT);
    }
    // a fresh plan writes itself in line by line; a step that starts lights up, one that's done pops its check
    let n = 0;
    // an item's key is its text, plus which occurrence of that text it is ("Unit tests" under two milestones),
    // counted over the whole list so the window above doesn't change it
    const nth = new Map();
    const keys = new Map(c.items.map((i) => { const t = `${i.depth}:${i.text}`; const x = nth.get(t) || 0; nth.set(t, x + 1); return [i, `ck:${owner.id}:${t}#${x}`]; }));
    card.append(h('ul', { class: 'todo' }, items.map((i) => {
      const k = keys.get(i);
      const moved = changed(`cks:${k}`, i.state);
      const li = h('li', { class: `${i.state} d${i.depth}` },
        h('span', { class: 'ck', role: 'img', 'aria-label': CK_STATE[i.state] ? T(CK_STATE[i.state]) : i.state }),
        h('span', { class: 'tx' }, i.text));
      const a = arrived(k);
      fx(li, `ckin:${k}`, 'enter', a, { delay: a ? n++ * 70 : 0, dur: 420 });
      fx(li, `ckdone:${k}`, 'justdone', moved && i.state === 'done', { dur: 800 });
      return fx(li, `ckdoing:${k}`, 'justdoing', moved && i.state === 'doing', { dur: 1000 });
    })));
    if (c.items.length > LIMIT) card.append(h('button', { class: 'more', onclick: () => { open.has(key) ? open.delete(key) : open.add(key); render(); } }, open.has(key) ? L('收起', 'Show less') : L(`显示全部 ${c.items.length} 项`, `Show all ${c.items.length}`)));
  } else if (c.note) {
    card.append(h('div', { class: 'ink2' }, L('最新进展：', 'Latest: '), c.note));
  }
  if (ownerLabel) card.append(h('div', { class: 'src' }, L(`${ownerLabel} 的清单`, `${ownerLabel}'s list`)));
  return card;
}

function nowCard(r) {
  const cur = r.current;
  const card = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, L('当前', 'Now'))));
  if (!cur) { card.append(h('div', { class: 'muted' }, L('还没有步骤', 'No steps yet'))); return card; }
  const p = PHASE[r.phase] || PHASE.IDLE;
  const lv = levelOf(r);
  const halted = lv === 'HALTED' || lv === 'DEAD';
  const stopped = lv === 'STOPPED';
  const active = r.phase !== 'IDLE' && !halted && !stopped;
  let what = T(p.label);
  if (r.phase === 'TOOL_RUNNING') what = (VERB[cur.tool] ? T(VERB[cur.tool]) : L(`调用${toolName(cur.tool)}`, `Calling ${toolName(cur.tool)}`)) + (cur.parallel > 1 ? L(`（并行 ${cur.parallel} 个）`, ` (${cur.parallel} in parallel)`) : '');
  if (r.phase === 'IDLE') what = !cur.final ? L('空闲', 'Idle') : cur.kind === 'system' ? L('上下文已压缩，等待新指令', 'Context compacted; waiting for your next message') : L('已回复，等待新指令', 'Replied; waiting for your next message');
  if (r.verdict?.waitingOn && r.turnOpen && !lv) what = L(`等待 ${r.verdict.waitingOn} 个子 agent 完成`, `Waiting for ${r.verdict.waitingOn} subagents to finish`);
  if (halted) what = lv === 'DEAD' ? L('服务已退出，本轮中断', 'Service exited; turn cut off') : L('已停止，本轮未完成', 'Stopped; turn unfinished');
  if (stopped) what = r.verdict.title || levelLabel('STOPPED');
  const brief = halted && cur.kind === 'think' ? (r.lastError?.brief ?? '') : cur.brief;
  // what it's doing shimmers while it works (like Claude Code's spinner text); a new step slides in
  const body = h('div', { class: 'body' },
    h('div', { class: `what ${active ? 'shimmer' : ''}` }, what),
    brief && h('div', { class: `brief ${cur.tool === 'run_command' ? 'mono' : ''}` }, brief),
    (active || halted) && cur.startedAt && h('div', { class: `timer ${ALERT.has(lv) ? 'stall' : ''}` }, L('已持续 ', 'For '), sinceSpan(cur.startedAt, true)));
  fx(body, `now:${r.id}`, 'chg', changed(`now:${r.id}`, `${r.phase}|${cur.tool}|${cur.startedAt}|${lv || ''}`), { dur: 450 });
  card.append(h('div', { class: 'now' },
    h('div', { class: `icon ${halted ? 'halted' : ''}` }, halted || stopped ? LEVEL[lv].icon : active ? h('span', { class: r.phase === 'THINKING' ? 'spin' : 'beam' }, p.icon) : '✓'),
    body));
  const bg = (r.bgTasks || []).filter((b) => b.status === 'RUNNING');
  if (bg.length) {
    card.append(h('div', { class: 'bglist' }, h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:2px' }, L(`后台任务 ${bg.length}`, `Background tasks: ${bg.length}`)),
      h('ul', { class: 'log' }, bg.map((b) => {
        const quiet = r.verdict?.bgQuiet?.[b.id];
        return h('li', { class: 'solo' }, h('span', { class: 'tm' }, b.short), h('span', { class: 'ic s-run' }, '⟳'),
          // (a live clock: the server's quiet time grows every second, which alone must not redraw the panel)
          h('span', { class: 'tx' }, b.brief, quiet && h('span', { class: 'quiet' }, L(' · ', ' · no output for '), h('span', { 'data-since': state.now - quiet }, fmtDur(quiet)), L('无新输出', ''))),
          h('span', { class: 'dur num', 'data-since': b.startedAt }, fmtDur(now() - b.startedAt)));
      }))));
  }
  return card;
}

// ---------- context ----------
const severity = (f) => (f >= 0.9 ? 'crit' : f >= 0.7 ? 'warn' : 'ok');
// Where the tokens come from (Antigravity's own groups). Fixed color per source, never by rank; anything under
// 5% of the window's contents folds into "other", so only the main shares are named.
const SOURCES = [
  { match: /^system prompt$/i, cls: 'seg-sys', label: ['系统提示', 'System prompt'] },
  { match: /^tools$/i, cls: 'seg-tools', label: ['工具定义', 'Tools'] },
  { match: /^chat messages$/i, cls: 'seg-msgs', label: ['对话消息', 'Messages'] },
];
const OTHER = { cls: 'seg-other', label: ['其他', 'Other'] };
function contextSources(bd) {
  const total = bd.total || bd.groups.reduce((s, g) => s + g.tokens, 0);
  if (!total) return [];
  const out = SOURCES.map((s) => ({ ...s, tokens: 0, top: [] }));
  const other = { ...OTHER, tokens: 0, top: [], parts: [] };
  for (const g of bd.groups) {
    const s = out.find((x) => x.match.test(g.name));
    if (s && g.tokens / total >= 0.05) { s.tokens += g.tokens; s.top = g.top || []; } else { other.tokens += g.tokens; other.parts.push(g); }
  }
  return [...out.filter((s) => s.tokens > 0), ...(other.tokens > 0 ? [other] : [])].map((s) => ({ ...s, share: s.tokens / total }));
}
const SRC_LABEL = { live: ['实时', 'live'], 'last-live': ['最近实时值', 'last live value'], db: ['Antigravity 记录', 'Antigravity record'] };

/** Context of the conversation on screen, right under the quota. */
function renderContext(r) {
  const box = $('ctx');
  box.setAttribute('aria-label', L('上下文', 'Context'));
  const c = r?.context;
  if (!c || c.used == null) { box.replaceChildren(); return; }
  const src = T(SRC_LABEL[c.source] || ['估算', 'estimate']);
  const who = r.team?.depth ? r.team.name : '';
  const title = h('span', {}, L('上下文', 'Context'), who && ` · ${who}`);
  if (!c.max) {
    box.replaceChildren(h('div', { class: 'row' }, title, h('b', { class: 'num' }, L(`约 ${fmtTok(c.used)} tokens · 上限未知`, `~${fmtTok(c.used)} tokens · limit unknown`))));
    return;
  }
  const f = Math.min(1, c.used / c.max);
  const sev = severity(f);
  const parts = c.breakdown ? contextSources(c.breakdown) : [];
  // the bar grows in on first sight of a conversation and glides with every model call; when it grows, a glint runs over it
  const key = `ctx:${r.id}`;
  const opts = { delay: 250, dur: 1000 };
  const fill = glide(h('i', {}), key, f, (el, v) => { el.style.width = `${Math.max(v * 100, parts.length && v > 0 ? 1.5 : 0).toFixed(2)}%`; }, opts);
  for (const p of parts) {
    fill.append(attachTip(h('span', { class: p.cls, style: `flex:${p.tokens} 1 0` }),
      [`${T(p.label)} · ${fmtTok(p.tokens)} · ${pct(p.share)}`, ...(p.parts || p.top).slice(0, 3).map((k) => `  ${k.name}: ${fmtTok(k.tokens)}`)].join('\n')));
  }
  const meter = h('div', { class: `meter ${parts.length ? 'seg' : sev}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': c.max, 'aria-valuenow': c.used, 'aria-label': L('上下文用量', 'Context used') },
    fill,
    c.afterCompaction != null && c.afterCompaction < c.used && h('b', { style: `left:${((c.afterCompaction / c.max) * 100).toFixed(1)}%` }));
  attachTip(meter, [L(`已用 ${c.used.toLocaleString()} / ${c.max.toLocaleString()}`, `${c.used.toLocaleString()} of ${c.max.toLocaleString()} used`),
    c.afterCompaction != null && L(`压缩后约 ${c.afterCompaction.toLocaleString()}（刻线）`, `About ${c.afterCompaction.toLocaleString()} after compaction (tick)`),
    L(`来源：${src}`, `Source: ${src}`)].filter(Boolean).join('\n'));
  // (only for real growth, and not more than once every 10 s: a busy agent grows its context on every step)
  const grown = rose(`ctxu:${key}`, c.used) && c.used - (last.get(`ctxg:${key}`)?.used ?? 0) >= c.max * 0.005;
  const calmFor = performance.now() - (last.get(`ctxg:${key}`)?.at ?? -Infinity) < 10_000;
  if (grown && !calmFor) last.set(`ctxg:${key}`, { used: c.used, at: performance.now() });
  else if (!last.has(`ctxg:${key}`)) last.set(`ctxg:${key}`, { used: c.used, at: -Infinity });
  fx(meter, `glint:${key}`, 'glint', grown && !calmFor, { dur: 1100 });
  // hovering a legend entry lights its segment up (and the other way round): style.css, with :has()
  const legend = parts.length > 0 && h('div', { class: 'legend' }, parts.map((p) =>
    h('span', { 'data-k': p.cls }, h('i', { class: p.cls, 'aria-hidden': 'true' }), T(p.label), h('span', { class: 'num' }, fmtTok(p.tokens)))));
  const total = glide(h('b', { class: `num ${sev === 'ok' ? '' : sev}` }), key, f,
    (el, v) => { el.textContent = `${fmtTok(v === f ? c.used : Math.round(v * c.max))} / ${fmtTok(c.max)} · ${pct(v)}`; }, opts);
  box.replaceChildren(...[h('div', { class: 'row' }, title, total), meter, legend].filter(Boolean));
}

// ---------- team flow ----------
// A Teamwork run as a diagram, like Claude Code's subagent picture: boxes colored by level (your session,
// coordinator, leads, workers), arrows from each agent to the ones it sent, a batch of workers fanned out in
// rows of three. Each box: a 1-3 word job, the model, a progress bar with %, a one-word status. Click = details.
const FAMILY_ORDER = ['lead', 'explore', 'build', 'review'];
/** Level colors (style.css --l0..--l3): orange, violet, green, blue; deeper levels alternate green / blue. */
const levelVar = (d) => `var(--l${d <= 3 ? d : d % 2 ? 3 : 2})`;
// what the role word says the agent does; worker/writer add nothing beyond the rest of the role
const KIND = [[/explorer|survey/i, ['调研', 'survey']], [/reviewer/i, ['审查', 'review']], [/challenger/i, ['质疑', 'challenge']], [/auditor/i, ['审计', 'audit']],
  [/orchestrator/i, ['编排', 'orchestrate']], [/coordinator/i, ['协调', 'coordinate']], [/interviewer/i, ['访谈', 'interview']], [/sentinel/i, ['值守', 'watch']]];
const FILLER = /^(teamwork|independent|agent|tier|worker|writer|explorer|survey|reviewer|challenger|auditor|orchestrator|coordinator|interviewer|sentinel|project|task|the|m\d+|\d+)$/i;
/** "Survey Explorer Environment" → "environment survey", "M1 Kinematics Worker" → "kinematics", "Independent Code Reviewer 1" → "code review". */
function shortJob(r) {
  if (r.team.depth === 0) return L('主会话', 'main session');
  const src = String(r.team.role || r.agentName || r.team.name || '').replace(/_/g, ' ');
  const kind = KIND.find(([re]) => re.test(src))?.[1];
  const words = src.split(/\s+/).filter((w) => w && !FILLER.test(w)).slice(-2)
    .map((w) => (/^[A-Z0-9/+.&-]+$/.test(w) ? w : w.toLowerCase()));
  return [...words, kind && T(kind)].filter(Boolean).join(' ') || r.team.name;
}
const SHORT_STATUS = { done: ['完成', 'done'], run: ['运行中', 'running'], slow: ['偏慢', 'slow'], wait: ['等你', 'needs you'], stall: ['卡住', 'stuck'] };
function shortStatus(r) {
  const st = agentState(r);
  const lv = levelOf(r);
  if (lv === 'STOPPED') return { icon: '■', cls: 's-idle', text: L('已停止', 'stopped') };
  if (lv === 'HALTED' || lv === 'DEAD') return { icon: LEVEL[lv].icon, cls: 's-err', text: L('中断', 'halted') };
  if (st.waiting) return { icon: '◐', cls: 's-run', text: L(`等 ${r.verdict.waitingOn} 个`, `waiting ×${r.verdict.waitingOn}`), spin: true };
  const pair = SHORT_STATUS[st.pill];
  if (!pair) return { icon: '○', cls: 's-idle', text: L('空闲', 'idle') };
  return { icon: st.icon, cls: st.cls, text: T(pair), spin: st.pill === 'run' || st.pill === 'slow' };
}
/** "Gemini 4 Hydrogen · High" stays; vendor words a family name already implies go ("Claude Opus 5.5" → "Opus 5.5"). */
const shortModel = (m) => String(m || '').replace(/^Claude\s+/, '');
// The model most of the team runs on: said once above the diagram, so a box names its model only when it differs.
let teamModel = null;
function commonModel(members) {
  const n = new Map();
  for (const m of members) if (m.model) n.set(m.model, (n.get(m.model) || 0) + 1);
  const [best, count] = [...n].sort((a, b) => b[1] - a[1])[0] || [];
  return count >= 2 ? best : null;
}

/** Working right now (not stuck, stopped or cut off): its box carries a light around its border, its arrow a drip. */
const busy = (r) => r.phase !== 'IDLE' && !ALERT.has(levelOf(r)) && levelOf(r) !== 'STOPPED';
// Boxes entering: the first time a team's diagram is shown it builds itself top-down, box after box; after
// that only an agent that just joined drops in (its arrow grows first). teamCard sets this while it builds.
const flowSeen = new Map(); // team root id -> ids already drawn
let flowIn = null; // {cascade, known, n}
let foldFired = null; // the group just folded / unfolded by a click
const entering = (r) => !!flowIn && (flowIn.cascade || !flowIn.known.has(r.id));
const STEP_MS = 75;
const peek = () => (flowIn?.cascade ? Math.min(flowIn.n * STEP_MS, 1500) : 0);
const slot = () => { const d = peek(); if (flowIn?.cascade) flowIn.n++; return d; };
const openAgent = (id) => go(() => { detailId = id; render(); scrollTo(0, 0); }, 'fwd');

function flowBox(r, { single = false, enter = false, delay = 0 } = {}) {
  const st = shortStatus(r);
  const c = r.checklist;
  const active = r.phase !== 'IDLE';
  const frac = c?.total ? c.done / c.total : !r.turnOpen ? 1 : null;
  // the bar (and its %) fills once the box has landed, then glides with every finished step
  const key = `bar:${r.id}`;
  const opts = { delay: delay + 220, dur: 900 };
  const fill = frac != null && glide(h('i', {}), key, frac, (el, v) => { el.style.width = `${(v * 100).toFixed(1)}%`; }, opts);
  const num = h('span', { class: 'num' });
  if (frac != null) glide(num, key, frac, (el, v) => { el.textContent = `${Math.round(v * 100)}%`; }, opts);
  else num.textContent = active ? '…' : '—';
  const box = h('button', { class: `fbox ${single ? 'single' : ''} ${st.cls === 's-err' ? 'stall' : ''} ${busy(r) ? 'live' : ''}`, style: `--lc: ${levelVar(r.team.depth)}`, 'data-d': r.team.depth, onclick: () => openAgent(r.id) },
    h('span', { class: 'fb-job' }, shortJob(r)),
    r.model && r.model !== teamModel && h('span', { class: `fb-model ${teamModel ? 'odd' : ''}` }, shortModel(r.model)),
    h('span', { class: 'fb-bar' }, h('span', { class: `track ${frac == null && active ? 'busy' : ''}` }, fill), num),
    h('span', { class: `fb-st ${st.cls}` }, st.spin ? h('i', { class: 'ring' }) : st.icon, ' ', st.text));
  if (single) fx(box, `in:${r.id}`, 'drop', enter, { delay, dur: 480 });
  fx(box, `done:${r.id}`, 'justdone', r._fx?.pill === 'done', { dur: 1300 }); // just finished: a glow ring, the ✓ pops
  fx(box, `shk:${r.id}`, 'shake', ALERT.has(r._fx?.lv), { dur: 550 }); // just got stuck: one shake
  const dur = active ? fmtDur(now() - (r.turnStartedAt || r.firstAt)) : fmtDur((r.lastActivityAt || 0) - (r.firstAt || 0));
  return attachTip(box, [agentLabel(r) + (r.team.role && r.team.role !== r.team.name ? ` · ${r.team.role}` : ''), r.model, c?.total && L(`清单 ${c.done}/${c.total}`, `Checklist ${c.done}/${c.total}`), `${agentState(r).label} · ${dur}`, r.brief && r.brief.slice(0, 240)].filter(Boolean).join('\n'));
}
/**
 * A connector (line, dot, arrowhead) down to `to` (an agent or a list of them): while one of them works, the
 * dot runs down it in their level color; `at` (%) moves it under one box of a row; it grows in with `enter`.
 */
function link({ at = null, to = null, key = null, enter = false, delay = 0 } = {}) {
  const list = to == null ? [] : Array.isArray(to) ? to : [to];
  const style = [at != null && `--at:${at}%`, list.length && `--lc:${levelVar(list[0].team.depth)}`].filter(Boolean).join(';');
  const el = h('div', { class: `flink ${list.some(busy) ? 'live' : ''}`, 'aria-hidden': 'true', style: style || null }, h('i', {}));
  return key ? fx(el, `lk:${key}`, 'grow', enter, { delay, dur: 380 }) : el;
}

/** Boxes in rows of three under one bus; each box gets an arrow from the bus (with a drip while it works). */
function fanRows(list) {
  const cols = Math.min(3, list.length);
  const rows = [];
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
  return h('div', { class: `fan ${rows.length > 1 ? 'multi' : ''}`, style: `--cols:${cols}` },
    rows.map((row) => {
      const rowDelay = peek();
      // each row's bus ends over its own last box (a short last row must not reach into empty columns)
      const el = h('div', { class: 'frow', style: `--busr:${(100 - ((row.length - 0.5) / cols) * 100).toFixed(2)}%` }, row.map((m, j) => {
        const enter = entering(m);
        const delay = flowIn?.cascade ? slot() : 140;
        const cell = h('div', { class: 'fcell', style: `--lc:${levelVar(m.team.depth)};--i:${j}` }, busy(m) && h('i', { class: 'drip' }), flowBox(m));
        return fx(cell, `in:${m.id}`, 'drop', enter, { delay, dur: 480 });
      }));
      return fx(el, `bus:${row[0].id}`, 'busgrow', row.some(entering), { delay: rowDelay, dur: 420 });
    }));
}

function fanGroup(parent, fam, list, kids, team) {
  const finished = list.filter((m) => !m.turnOpen).length;
  const busyNow = list.some((m) => m.phase !== 'IDLE' || (levelOf(m) && levelOf(m) !== 'STOPPED'));
  const key = `fam:${parent.id}:${fam}`;
  const folded = open.has(key) ? false : open.has(`-${key}`) ? true : finished === list.length && team.active > 0;
  const toggle = () => { open.delete(key); open.delete(`-${key}`); open.add(folded ? key : `-${key}`); foldFired = key; render(); foldFired = null; };
  const anyIn = list.some(entering);
  const fired = foldFired === key;
  const lk = link({ to: list, key: `fh:${key}`, enter: anyIn, delay: peek() });
  const head = h('button', { class: 'fan-h', onclick: toggle, 'aria-expanded': String(!folded), style: `--lc: ${levelVar(parent.team.depth)}` },
    h('span', { class: `caret ${folded ? '' : 'open'}` }, '▸'), h('span', { class: 'who' }, shortJob(parent)), ' → ', h('b', {}, T(FAMILY[fam])),
    h('span', { class: 'num' }, ` ${finished}/${list.length}${finished === list.length ? ' ✓' : busyNow ? L(' · 进行中', ' · running') : ''}`));
  fx(head, `fhd:${key}`, 'drop', anyIn, { delay: slot(), dur: 420 });
  fx(head, `fold:${key}`, 'unfold', fired, { dur: 320 });
  const out = [lk, head];
  if (folded) out.push(fx(h('div', { class: 'chips' }, list.map((m) => h('button', { class: 'chip', onclick: () => openAgent(m.id) }, `${shortStatus(m).icon} ${shortJob(m)}`))), `fold:${key}:c`, 'unfold', fired, { dur: 380 }));
  else out.push(link({ to: list, key: `fr:${key}`, enter: anyIn, delay: peek() }), fx(fanRows(list), `fold:${key}:r`, 'unfold', fired, { dur: 380 }));
  for (const m of folded ? [] : list) if (kids.get(m.id)?.length) out.push(...childFlow(m, kids, team, true));
  return out;
}

/** What r sent, below it: one helper straight down; several fan out; many of different kinds fan out per kind. */
function childFlow(r, kids, team, labelled = false) {
  const children = (kids.get(r.id) || []).slice().sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));
  if (!children.length) return [];
  const out = [];
  const anyIn = children.some(entering);
  // a subtree that doesn't hang straight under its box says whose it is
  if (labelled) {
    out.push(link({ to: children, key: `lb:${r.id}`, enter: anyIn, delay: peek() }),
      fx(h('div', { class: 'fan-h static', style: `--lc: ${levelVar(r.team.depth)}` }, h('span', { class: 'who' }, shortJob(r)), ' →'), `lbh:${r.id}`, 'drop', anyIn, { delay: slot(), dur: 420 }));
  }
  const fams = [...new Set(children.map((c) => c.team.family))];
  if (children.length >= 4 && fams.length >= 2) {
    for (const fam of FAMILY_ORDER.filter((f) => fams.includes(f))) out.push(...fanGroup(r, fam, children.filter((c) => c.team.family === fam), kids, team));
    return out;
  }
  if (children.length === 1) {
    const c = children[0];
    const enter = entering(c);
    const delay = flowIn?.cascade ? slot() : 160;
    out.push(link({ to: c, key: c.id, enter, delay: Math.max(0, delay - 120) }), flowBox(c, { single: true, enter, delay }), ...childFlow(c, kids, team));
    return out;
  }
  out.push(link({ to: children, key: `fan:${r.id}`, enter: anyIn, delay: peek() }), fanRows(children));
  // the parent's line continues from under the box whose own team comes next
  const withKids = children.filter((c) => kids.get(c.id)?.length);
  for (const c of withKids) {
    const i = children.indexOf(c);
    const cols = Math.min(3, children.length);
    const lastRow = Math.floor(i / cols) === Math.floor((children.length - 1) / cols);
    if (withKids.length === 1 && lastRow) {
      const sub = kids.get(c.id);
      out.push(link({ at: ((i % cols) + 0.5) / cols * 100, to: sub, key: `sub:${c.id}`, enter: sub.some(entering), delay: peek() }), ...childFlow(c, kids, team).slice(1));
    } else out.push(...childFlow(c, kids, team, true));
  }
  return out;
}

function teamCard(team, members) {
  const card = h('section', { class: 'card' });
  const done = members.filter((m) => !m.turnOpen).length;
  const running = members.filter((m) => m.phase !== 'IDLE').length;
  card.append(h('div', { class: 'card-h' }, h('h2', {}, L('团队', 'Team')), h('span', { class: 'aside num' },
    L(`${members.length} 个 agent · ${done} 完成 · ${running} 运行中`, `${members.length} agents · ${done} done · ${running} running`))));
  const kids = new Map();
  for (const m of members) if (m.team.parentId && byId.has(m.team.parentId)) {
    if (!kids.has(m.team.parentId)) kids.set(m.team.parentId, []);
    kids.get(m.team.parentId).push(m);
  }
  const root = byId.get(team.rootId);
  // legend: one color per level; hovering one dims every other level (style.css, :has())
  const depths = [...new Set(members.map((m) => m.team.depth))].sort((a, b) => a - b);
  teamModel = commonModel(members);
  const odd = teamModel ? members.filter((m) => m.model && m.model !== teamModel).length : 0;
  card.append(h('div', { class: 'mlegend' }, depths.map((d) => {
    const n = members.filter((m) => m.team.depth === d).length;
    return h('span', { 'data-d': d }, h('i', { style: `background:${levelVar(d)}` }), d === 0 ? L('主会话', 'main session') : L(`第 ${d} 层`, `level ${d}`), d ? h('span', { class: 'num' }, ` ×${n}`) : null);
  }), teamModel && h('span', { class: 'mmodel' }, L('模型 ', 'Model '), h('b', {}, shortModel(teamModel)),
    odd ? L(`（${odd} 个不同，框内标出）`, ` (${odd} differ, marked in their boxes)`) : '')));
  const known = flowSeen.get(team.rootId);
  flowIn = { cascade: !known, known: known || new Set(), n: 0 };
  const flow = h('div', { class: 'flow' }, flowBox(root, { single: true, enter: entering(root), delay: slot() }), ...childFlow(root, kids, team));
  const orphans = members.filter((m) => m.id !== root.id && !(m.team.parentId && byId.has(m.team.parentId)));
  for (const m of orphans) {
    const enter = entering(m);
    const delay = flowIn.cascade ? slot() : 160;
    flow.append(link({ to: m, key: m.id, enter, delay: Math.max(0, delay - 120) }), flowBox(m, { single: true, enter, delay }));
  }
  if (!team.active && done === members.length) {
    // the whole team just finished: the end cap lands and throws a little confetti
    const fend = h('div', { class: 'fend', style: `--lc: ${levelVar(0)}` }, L('↩ 回到主会话 · 全部完成', '↩ back to main session · all done'));
    const fire = team._done || flowIn.cascade;
    const delay = flowIn.cascade ? slot() : 300;
    flow.append(link({ key: `end:${team.rootId}`, enter: fire, delay: Math.max(0, delay - 120) }), fx(fend, `fend:${team.rootId}`, 'land', fire, { delay, dur: 650 }));
    // (by then an update may have rebuilt the cap: look it up again)
    if (team._done) afterRender.push(() => setTimeout(() => burst($('run').querySelector('.fend'), 18), Math.max(0, delay + 150)));
  }
  flowSeen.set(team.rootId, new Set(members.map((m) => m.id)));
  flowIn = null;
  teamModel = null;
  card.append(flow);
  return card;
}

// ---------- activity log ----------
// Reading files is how an agent looks around: a run of finished reads by one agent is one row ("Read 6 files"),
// which opens on a click. Errors, edits, commands and dispatches always keep their own rows.
const READS = new Set(['read_file', 'view_file']);
const isRead = (s) => s.kind === 'tool' && READS.has(s.tool) && s.status === 'DONE';
function foldReads(rows) {
  const out = [];
  for (const s of rows) {
    const prev = out[out.length - 1];
    const run = prev?.reads ?? (prev && isRead(prev) ? [prev] : null);
    if (isRead(s) && run && run[0].who === s.who) {
      // (newest first: s is the oldest so far, and its id stays the group's as newer reads join; the row's
      // time is the newest read's, where it sits in the list)
      const reads = [...run, s];
      out[out.length - 1] = { kind: 'reads', reads, who: s.who, id: s.id, status: 'DONE', startedAt: run[0].startedAt,
        ms: reads.reduce((t, x) => t + Math.max(0, (x.endedAt - x.startedAt) || 0), 0) };
    } else out.push(s);
  }
  return out;
}
function logCard(members, multi) {
  const key = `log:${members[0]?.id}`;
  const rows = [];
  for (const m of members) {
    const halted = /HALTED|DEAD/.test(levelOf(m) || '');
    for (const s of m.timeline || []) {
      if (s.kind === 'user') continue;
      if (s.kind === 'think' && !s.final && (s.endedAt - s.startedAt) < 20000) continue;
      rows.push({ ...s, status: halted && s.status === 'RUNNING' ? 'UNFINISHED' : s.status, who: m });
    }
  }
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (!rows.length) return null;
  const folded = foldReads(rows);
  const LIMIT = 12;
  const shown = open.has(key) ? folded.slice(0, 120) : folded.slice(0, LIMIT);
  const list = h('ul', { class: 'log' });
  let n = 0;
  const row = (s, sub = false) => {
    // keyed by the step's own id (a group: its oldest read's, which stays put as newer reads join it)
    const k = `row:${s.who.id}:${s.id}`;
    const reads = s.kind === 'reads' ? s.reads : null;
    const rk = reads && `rd:${k}`;
    const [icon, cls, labelPair] = s.kind === 'think' ? ['·', 's-idle', ['回复', 'Reply']] : STATUS[s.status] || STATUS.DONE;
    const label = T(labelPair);
    const ms = reads ? s.ms : s.endedAt - s.startedAt;
    const dur = Number.isFinite(ms) && ms >= 1000 ? fmtDur(ms) : '';
    // distinct files, oldest first (a file read twice, in two ranges, counts once)
    const names = reads && [...new Set(reads.slice().reverse().map((x) => x.brief?.replace(/:\d+-\d*$/, '')).filter(Boolean))];
    const nFiles = reads && (names.length || reads.length);
    const text = reads ? [h('span', { class: 'tool' }, toolName('read_file')), h('span', { class: 'caret' }, open.has(rk) ? '▾' : '▸'), L(`${nFiles} 个文件：`, `${nFiles} file${nFiles > 1 ? 's' : ''}: `), names.slice(0, 3).join(L('、', ', ')), names.length > 3 ? L(' 等', ' …') : '']
      : s.kind === 'tool' ? [h('span', { class: 'tool' }, toolName(s.tool)), s.brief] : [s.brief || L('回复完成', 'Replied')];
    const toggle = reads && ((e) => {
      if (selecting() || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      open.has(rk) ? open.delete(rk) : open.add(rk);
      render();
    });
    const li = h('li', { class: `${s.kind === 'reads' ? 'tool reads' : s.kind} ${multi ? '' : 'solo'} ${sub ? 'sub' : ''}`, tabindex: reads ? 0 : null, role: reads ? 'button' : null,
      'aria-expanded': reads ? String(open.has(rk)) : null, onclick: toggle, onkeydown: toggle },
      h('span', { class: 'tm num' }, sub ? '' : clock(s.startedAt)),
      fx(h('span', { class: `ic ${cls}`, 'aria-label': label }, icon), `st:${k}`, 'pop', changed(`st:${k}`, s.status), { dur: 450 }),
      multi && h('span', { class: 'who' }, h('i', { class: `sw ${s.who.team.family}` }), agentLabel(s.who)),
      h('span', { class: 'tx' }, ...text),
      h('span', { class: 'dur num' }, dur));
    attachTip(li, [multi && (s.who.team.role || s.who.team.name), reads ? L(`读取 ${nFiles} 个文件，共 ${reads.length} 次（点击展开）`, `Read ${nFiles} files in ${reads.length} reads (click to list them)`) : s.kind === 'tool' ? `${toolName(s.tool)} · ${label}` : label,
      reads ? names.slice(0, 12).join('\n') : s.brief,
      s.exitCode != null && L(`退出码 ${s.exitCode}`, `Exit code ${s.exitCode}`), dur && L(`耗时 ${dur}`, `Took ${dur}`)].filter(Boolean).join('\n'));
    const a = arrived(k);
    list.append(fx(li, k, 'enter', a, { delay: a ? Math.min(n++, 12) * 40 : 0, dur: 420 }));
    if (reads && open.has(rk)) for (const x of reads) row(x, true);
  };
  for (const s of shown) row(s);
  const card = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, L('活动记录', 'Activity')), h('span', { class: 'aside' }, multi ? L('全部 agent，最新在上', 'All agents, newest first') : L('最新在上', 'Newest first'))), list);
  if (folded.length > LIMIT) card.append(h('button', { class: 'more', onclick: () => { open.has(key) ? open.delete(key) : open.add(key); render(); } }, open.has(key) ? L('收起', 'Show less') : L(`显示更早的 ${Math.min(folded.length, 120) - LIMIT} 条`, `Show ${Math.min(folded.length, 120) - LIMIT} earlier`)));
  return card;
}

// ---------- screens ----------
function teamStatus(team, members) {
  const worst = members.filter((m) => levelOf(m)).sort((a, b) => RANK[levelOf(b)] - RANK[levelOf(a)])[0];
  if (worst && levelOf(worst) !== 'SLOW') return { label: levelLabel(levelOf(worst)), pill: LEVEL[levelOf(worst)].cls };
  if (team.active) return { label: worst ? levelLabel('SLOW') : L('运行中', 'Running'), pill: worst ? 'slow' : 'run' };
  const root = byId.get(team.rootId);
  return root?.turnOpen ? { label: L('空闲', 'Idle'), pill: '' } : { label: L('已完成', 'Done'), pill: 'done' };
}


function taskScreen(team) {
  const members = team.memberIds.map((id) => byId.get(id)).filter(Boolean);
  const root = byId.get(team.rootId);
  const turnStart = Number.isFinite(root.turnStartedAt) ? root.turnStartedAt : root.firstAt;
  const meta = [
    root.model,
    team.isTeam && L(`${members.length} 个 agent`, `${members.length} agents`),
    turnStart && team.active && h('span', {}, L('已运行 ', 'Running for '), sinceSpan(turnStart, true)),
  ].filter(Boolean).map((x) => (x instanceof Node ? x : h('span', {}, x)));
  const out = [head({ title: team.title, st: teamStatus(team, members), meta, key: team.rootId })];

  // problems first, most severe first, each saying which agent
  const alerts = members.filter((m) => levelOf(m) && levelOf(m) !== 'STOPPED').sort((a, b) => RANK[levelOf(b)] - RANK[levelOf(a)]).slice(0, 3);
  for (const m of alerts) out.push(alertCard(m, team.isTeam ? `${agentLabel(m)}${m.team.role && m.team.role !== m.team.name ? ` · ${m.team.role}` : ''}` : null));

  const owner = byId.get(team.checklistOwner);
  out.push(checklistCard(owner, { ownerLabel: team.isTeam && owner && owner.id !== root.id ? owner.team.name : null }));
  if (team.isTeam) out.push(teamCard(team, members));
  else out.push(nowCard(root));
  out.push(logCard(members, team.isTeam));
  return out;
}

function agentScreen(team, r) {
  const st = agentState(r);
  const t = r.team;
  const lead = t.parentId && byId.get(t.parentId);
  const reports = (state.runs || []).filter((x) => x.team?.parentId === r.id).length;
  const meta = [r.model, t.role && t.role !== t.name && t.role,
    lead && h('button', { class: 'linkish', onclick: () => go(() => { detailId = lead.team.depth === 0 ? null : lead.id; render(); }, 'back') }, L('上级：', 'Reports to: '), agentLabel(lead)),
    reports > 0 && L(`下属 ${reports} 个`, `${reports} reports`)]
    .filter(Boolean).map((x) => (x instanceof Node ? x : h('span', {}, x)));
  return [
    head({ title: t.depth === 0 ? team.title : t.name, st: { label: st.label, pill: st.pill }, meta, key: r.id, back: () => go(() => { detailId = null; render(); }, 'back') }),
    alertCard(r),
    r.brief && h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, L('分配的任务', 'Assigned task'))), h('div', { class: 'ink2' }, r.brief)),
    checklistCard(r, { title: L('它的清单', 'Its checklist') }),
    nowCard(r),
    logCard([r], false),
  ];
}

function render() {
  if (!state) return;
  byId = new Map((state.runs || []).map((r) => [r.id, r]));
  renderLang();
  const live = state.ls?.ok;
  const conn = $('conn');
  conn.className = `conn ${live ? 'live' : 'off'}`;
  conn.lastChild.textContent = live ? L('已连接 Antigravity', 'Connected to Antigravity') : L('仅文件模式', 'Files only');
  conn.title = state.ls?.error || state.ls?.endpoint || '';
  renderUsage();
  const team = pickTeam();
  renderPicker(team);
  const main = $('run');
  if (!team) { renderContext(null); main.replaceChildren(h('div', { class: 'empty' }, L('还没有发现 Antigravity 会话', 'No Antigravity conversations yet'))); settle(); return; }
  const others = (state.teams || []).filter((t) => t.rootId !== team.rootId && ALERT.has(t.worst) && recent(t));
  const banner = others.length > 0 && h('button', { class: 'others', onclick: () => go(() => { manualAt = state.focus?.at ?? 0; selected = others[0].rootId; detailId = null; render(); }) },
    L(`⚠ 另有 ${others.length} 个任务需要注意：${others[0].title}`, `⚠ ${others.length} other task${others.length > 1 ? 's' : ''} need${others.length > 1 ? '' : 's'} attention: ${others[0].title}`));
  const agent = detailId && team.memberIds.includes(detailId) ? byId.get(detailId) : null;
  if (!agent) detailId = null;
  const screen = `${team.rootId}/${agent?.id || ''}`;
  fresh = screen !== lastScreen;
  lastScreen = screen;
  renderContext(agent || byId.get(team.rootId));
  const parts = [banner, ...(agent ? agentScreen(team, agent) : taskScreen(team))].filter(Boolean);
  // first paint: the sections rise in one after another
  parts.forEach((el, i) => fx(el, `boot:${i}`, 'rise', !booted, { delay: 80 + i * 70, dur: 520 }));
  main.replaceChildren(...parts);
  document.title = (state.teams || []).some((t) => ALERT.has(t.worst) && recent(t)) ? '⚠ Better View' : 'Better View';
  settle();
}
let lastScreen = null;
let booted = false;
function settle() {
  booted = true;
  if (tipOwner && !tipOwner.isConnected) {
    // its element was rebuilt (every update while agents work): whatever now sits under the pointer, the same
    // thing redrawn, keeps the tip open with its current content; nothing there (or a focus tip) closes it
    let el = pointer && document.elementFromPoint(...pointer);
    while (el && !tips.has(el)) el = el.parentElement;
    if (el) showTip(el, tips.get(el), ...pointer);
    else hideTip();
  }
  syncLoops();
  for (const f of afterRender.splice(0)) f();
}

/** Per agent and team, what this update changed; the one-shot effects (done glow, shake, confetti) key off it. */
function noteChanges() {
  for (const r of state.runs || []) {
    const lv = levelOf(r) || '';
    const pill = agentState(r).pill;
    r._fx = { lv: changed(`lv:${r.id}`, lv) ? lv : null, pill: changed(`pill:${r.id}`, pill) ? pill : null };
  }
  for (const t of state.teams || []) {
    const ms = t.memberIds.map((id) => byId.get(id)).filter(Boolean);
    const allDone = !t.active && ms.length > 0 && ms.every((m) => !m.turnOpen);
    t._done = changed(`tdone:${t.rootId}`, allDone) && allDone;
  }
}

// live clocks without re-rendering
setInterval(() => {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmtDur(now() - Number(el.dataset.since));
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = ago(now() - Number(el.dataset.ago));
}, 1000);

// Updates arrive every 1.5-2 s. One that changes nothing but the clock is not drawn (the live clocks tick on
// their own), and while you hold a text selection in the panel no update is drawn, so a command or an error
// can be selected and copied; the newest one is drawn once the selection is gone (or after 30 s).
let dataSig = '';
let held = null; // {s, since}
const HOLD_MS = 30_000;
function selecting() {
  const sel = document.getSelection?.();
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && document.body.contains(sel.anchorNode) && !tip.contains(sel.anchorNode);
}
function accept(s) {
  if (selecting()) {
    held = { s, since: held?.since ?? performance.now() };
    if (performance.now() - held.since < HOLD_MS) return;
  }
  held = null;
  skew = s.now - Date.now();
  // (how long a background task has been quiet grows with the clock: which tasks are quiet is what counts)
  const sig = JSON.stringify(s, (k, v) => (k === 'now' ? undefined : k === 'bgQuiet' && v ? Object.keys(v) : v));
  if (sig === dataSig && state) { state.now = s.now; return; }
  dataSig = sig;
  state = s;
  if (s.lang === 'zh' || s.lang === 'en') { LANG = s.lang; setDocLang(); }
  byId = new Map((s.runs || []).map((r) => [r.id, r]));
  noteChanges();
  heartbeat(s);
  render();
}
document.addEventListener('selectionchange', () => { if (held && !selecting()) accept(held.s); });

// Where the data comes from, in order: the MCP Apps host bridge (inside Antigravity's side pane), the
// sidecar gateway (iframe URL carries ?token=; the gateway only passes requests with the X-Sidecar-Token
// header, which EventSource cannot send, so poll), or the local server's event stream (standalone/native).
let gotState = false;
let lastError = '';
function showConn(text, title = '') {
  const conn = $('conn');
  conn.className = 'conn off';
  conn.lastChild.textContent = text;
  conn.title = title;
}
function received(s) { gotState = true; accept(s); }
function failed(mode, err) {
  lastError = `${mode}: ${err?.message || err}`;
  showConn(gotState ? L('数据暂停更新，重试中…', 'Updates paused, retrying…') : L('读取数据中…', 'Loading…'), lastError);
}

function connect() {
  const mode = window.BV_HOST ? 'mcp' : TOKEN ? 'sidecar' : 'sse';
  showConn(L('连接中…', 'Connecting…'));
  $('run').firstChild.replaceChildren(L('加载中', 'Loading'), h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  // nothing after a while: say why, in the panel itself (embedded hosts have no visible console)
  setTimeout(() => { if (!gotState) showConn(L(`未收到数据（${lastError || mode + ': 无响应'}）`, `No data (${lastError || mode + ': no response'})`), lastError); }, 10000);

  if (mode === 'mcp') {
    window.BV_HOST.onLocale = (locale) => { if (!state && locale) { LANG = /^zh/i.test(locale) ? 'zh' : 'en'; setDocLang(); } };
    return window.BV_HOST.start(received, (err) => failed(mode, err));
  }
  if (mode === 'sidecar') {
    const poll = async () => {
      try {
        const res = await fetch('api/state', { headers: { 'X-Sidecar-Token': TOKEN }, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        received(await res.json());
      } catch (err) { failed(mode, err); }
      setTimeout(poll, 2000);
    };
    return poll();
  }
  const es = new EventSource('api/events');
  es.onmessage = (e) => received(JSON.parse(e.data));
  es.onerror = () => { failed(mode, 'event stream error'); showConn(L('与本地服务断开，重连中…', 'Disconnected from the local service, reconnecting…'), lastError); };
}
connect();
