// Store: discovers conversations, tails their transcripts, merges language-server data
// (run status, titles, quota, live context window) and notifies listeners on change.

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { JsonlTailer } from './transcript.mjs';
import { createRun, applyRow, snapshot, turnOpen } from './reducer.mjs';
import { assess, calibrate, BUSY_RE, ALERT_LEVELS } from './stall.mjs';
import { HubLog } from './hublog.mjs';
import { buildTeams } from './team.mjs';
import { tr, currentLang, setLang, readPrefs, LANGS } from './i18n.mjs';
import { convMeta, prettyModel } from './ctxdb.mjs';
import { readProgress, summarizeItems } from './checklist.mjs';
import { AG_DIR, findEndpoint, unary, stream, findAll } from './hub.mjs';

const BRAIN = join(AG_DIR, 'brain');
const ANNOTATIONS = join(AG_DIR, 'annotations');
// Learned per-model context limits survive restarts, so an idle session still gets a denominator.
export const MODELS_CACHE = process.env.BETTER_VIEW_CACHE || join(homedir(), '.cache', 'better-view', 'models.json');

export function loadModelLimits(file = MODELS_CACHE) {
  try {
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    return new Map(Object.entries(obj).filter(([, v]) => Number.isFinite(v) && v > 0));
  } catch { return new Map(); }
}

export function saveModelLimits(map, file = MODELS_CACHE) {
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 1)); } catch { /* cache only */ }
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const shortLabel = (s) => String(s).replace(/\b(limit|remaining|quota)\b/gi, '').replace(/\s+/g, ' ').trim() || String(s);

export function normalizeQuota(resp) {
  // RetrieveUserQuotaSummary: {groups:[{displayName, buckets:[...]}], buckets:[...]} — wrapped in {response: ...}
  // since 2.32, which has one group per model family ("Gemini Models", "Claude and GPT models"), each with the
  // same window names. GetUserStatus: nested quotaInfo.
  const out = [];
  const seen = new Set();
  // proto3 JSON omits zero values: a bucket that still identifies itself but has no
  // remainingFraction (and no remainingAmount) is exhausted, not unknown.
  const push = (b, group) => {
    let remaining = typeof b.remainingFraction === 'number' ? b.remainingFraction : null;
    if (remaining == null && b.remainingAmount == null && (b.resetTime || b.bucketId)) remaining = 0;
    if (remaining == null || b.disabled) return;
    const label = b.displayName || b.label || b.modelOrAlias?.model || b.bucketId || group || 'quota';
    const key = `${group ?? ''}|${b.bucketId || label}|${b.window ?? b.refreshWindowLabel ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      group: group || null,
      id: b.bucketId || null,
      label,
      short: shortLabel(label),
      window: b.window || b.refreshWindowLabel || null,
      usedFraction: Math.min(1, Math.max(0, 1 - remaining)),
      resetTime: b.resetTime || null,
    });
  };
  // every list of buckets, wherever the response nests it; a holder's displayName names the group
  for (const holder of findAll(resp, 'buckets')) {
    if (!Array.isArray(holder.buckets)) continue;
    const group = typeof holder.displayName === 'string' && holder.displayName ? holder.displayName : null;
    for (const b of holder.buckets) if (b && typeof b === 'object') push(b, group);
  }
  if (!out.length) {
    const owned = new Set();
    for (const cfg of findAll(resp, 'quotaInfo')) {
      if (!cfg.quotaInfo) continue;
      owned.add(cfg.quotaInfo);
      push({ ...cfg.quotaInfo, displayName: cfg.label || cfg.displayName || cfg.modelOrAlias?.model }, null);
    }
    for (const holder of findAll(resp, 'remainingFraction')) {
      if (!owned.has(holder)) push({ ...holder, displayName: holder.displayName || holder.label }, null);
    }
  }
  return out;
}

const FAMILIES = [['Claude', /claude|anthropic|opus|sonnet|haiku/i], ['GPT', /\bgpt|openai|\bo[1-9]\b/i], ['Gemini', /gemini|argon|hydrogen/i]];
const familyOf = (label) => FAMILIES.find(([, re]) => re.test(label))?.[0] ?? null;

/** "Claude and GPT models" → "Claude · GPT"; a bucket without a vendor group is named by its own label, or null (the shared pool). */
function familyName(b) {
  const src = b.group && b.group !== 'model' ? b.group : b.label;
  const found = FAMILIES.filter(([, re]) => re.test(src)).map(([f]) => f);
  if (found.length) return found.join(' · ');
  return b.group && b.group !== 'model' ? shortLabel(b.group.replace(/\bmodels?\b/gi, '')) : null;
}

const WINDOW_RANK = { '5h': 0, daily: 1, weekly: 2 };
/**
 * One entry per model family: the window closest to running out speaks for the family (a 5-hour limit at 90%
 * matters more than a weekly one at 40%); every window stays listed for the tooltip. Ties go to the shorter window.
 */
export function quotaFamilies(buckets) {
  const fams = new Map();
  for (const b of buckets) {
    const name = familyName(b);
    const f = fams.get(name) ?? { name, buckets: [] };
    f.buckets.push(b);
    fams.set(name, f);
  }
  return [...fams.values()].map((f) => {
    const worst = f.buckets.reduce((w, b) => (b.usedFraction > w.usedFraction + 1e-9
      || (Math.abs(b.usedFraction - w.usedFraction) <= 1e-9 && (WINDOW_RANK[b.window] ?? 9) < (WINDOW_RANK[w.window] ?? 9)) ? b : w));
    return { name: f.name, usedFraction: worst.usedFraction, window: worst.window, resetTime: worst.resetTime, label: worst.label, buckets: f.buckets };
  });
}

/**
 * Per-model quotas from GetUserStatus (model configs: {label, disabled, quotaInfo: {remainingFraction, resetTime}}).
 * Models that share a pool (identical remaining fraction and reset time — e.g. every Claude model and GPT-OSS
 * draw on one non-Gemini pool) become one bucket named after their vendors ("Claude · GPT"); a vendor split
 * over several pools names the models instead. proto3 JSON omits 0, so a quotaInfo with a reset time
 * but no remainingFraction is used up.
 */
export function modelQuotas(status, { skipFamilies = [] } = {}) {
  const pools = new Map(); // remaining|reset -> {families, labels, remaining, resetTime}
  for (const cfg of findAll(status, 'quotaInfo')) {
    const q = cfg.quotaInfo;
    const label = cfg.label || cfg.displayName || cfg.modelOrAlias?.model;
    if (!q || !label || cfg.disabled) continue;
    const remaining = typeof q.remainingFraction === 'number' ? q.remainingFraction : q.resetTime ? 0 : null;
    if (remaining == null) continue;
    const family = familyOf(label) ?? label;
    if (skipFamilies.includes(family)) continue;
    const key = `${remaining.toFixed(4)}|${q.resetTime || ''}`;
    const pool = pools.get(key) ?? { families: [], labels: [], remaining, resetTime: q.resetTime || null };
    if (!pool.families.includes(family)) pool.families.push(family);
    if (!pool.labels.includes(label)) pool.labels.push(label);
    pools.set(key, pool);
  }
  const perFamily = {};
  for (const p of pools.values()) for (const f of p.families) perFamily[f] = (perFamily[f] || 0) + 1;
  return [...pools.values()].map((p) => {
    const label = p.families.every((f) => perFamily[f] === 1) ? p.families.join(' · ') : p.labels.join(' / ');
    return { group: 'model', label, short: shortLabel(label), models: p.labels, window: null, usedFraction: Math.min(1, Math.max(0, 1 - p.remaining)), resetTime: p.resetTime };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/** Pulls execution hints out of an AgentStateUpdate: waiting-on-user and model request retries. */
export function extractExec(update) {
  const states = findAll(update, 'executionState').map((o) => o.executionState).filter((x) => typeof x === 'string');
  const waitingSteps = findAll(update, 'waitingSteps').map((o) => o.waitingSteps).filter((x) => Array.isArray(x) && x.length);
  const waitingFlag = findAll(update, 'waitingForInput').some((o) => o.waitingForInput === true);
  const mr = findAll(update, 'modelRequest').map((o) => o.modelRequest).filter((x) => x && typeof x === 'object').pop();
  if (!states.length && !waitingSteps.length && !waitingFlag && !mr) return null;
  const state = states.pop() ?? null;
  return {
    state,
    waiting: /WAITING_FOR_USER/.test(state || '') || waitingSteps.length > 0 || waitingFlag,
    attempt: mr?.attempt != null ? Number(mr.attempt) : null,
    maxAttempts: mr?.maxAttempts != null ? Number(mr.maxAttempts) : null,
    retryAt: mr?.retryAt ?? null,
    at: Date.now(),
  };
}

export function extractContext(update) {
  const cw = findAll(update, 'contextWindowUsage').map((o) => o.contextWindowUsage).filter(Boolean).pop();
  if (!cw) return null;
  const num = (v) => (v == null ? null : Number(v)); // int64 arrives as string in proto3 JSON
  const used = num(cw.estimatedTokensUsed), max = num(cw.maxContextTokens);
  if (used == null && max == null) return null;
  return { used, max, afterCompaction: num(cw.estimatedAfterCompaction), source: 'live', at: Date.now() };
}

const LEVEL_RANK = { DEAD: 5, HALTED: 4, STALLED: 4, WAITING: 3, SLOW: 2, STOPPED: 1, OK: 0 };

/** The checklist shown for one conversation: its progress file if it keeps one, else one item per user request. */
export function checklistOf(r) {
  // the agent's own list: a checklist file it wrote (a Teamwork progress.md, or an artifact), else task.md in
  // its artifacts directory (brain/<id>/), which the Better View rule (rules/AGENTS.md) asks it to keep —
  // Antigravity's planning-mode format. A written file that is gone or has no checkboxes falls back to task.md.
  let prog = r.checklistFile ? readProgress(r.checklistFile) : null;
  let path = r.checklistFile;
  if (!prog?.items.length && r.id) {
    const art = join(BRAIN, r.id, 'task.md');
    const p = art !== path ? readProgress(art) : null;
    if (p && (p.items.length || !prog)) { prog = p; path = art; }
  }
  const file = path ? path.split('/').slice(-2).join('/') : null;
  if (prog?.items.length) {
    const sum = summarizeItems(prog.items);
    // a finished list from an earlier request: not this turn's, so not shown
    if (sum.total && sum.done === sum.total && Number.isFinite(r.turnStartedAt) && prog.mtimeMs < r.turnStartedAt) return null;
    return { source: 'file', file, items: prog.items.slice(0, 80), note: prog.note, updatedAt: prog.mtimeMs, ...sum };
  }
  return prog?.note ? { source: 'note', file, items: [], note: prog.note, done: 0, total: 0 } : null;
}

export class Store extends EventEmitter {
  constructor({ pollMs = 1000, lsPollMs = 4000, quotaPollMs = 60000, evalMs = 2000 } = {}) {
    super();
    this.hubLog = new HubLog();
    this.hubLogSummary = { auth: null, network: null };
    this.hubPid = null;
    this.hubRestart = null; // {at, from, to}
    this.thresholds = calibrate([]);
    this.evaluated = false; // first pass is a baseline: no alerts for states that predate startup
    this.convs = new Map(); // id -> {tailer, run, title, ls, liveContext, stream}
    this.ls = { endpoint: null, ok: false, error: null, lsVersion: null };
    this.quota = { buckets: [], at: null, error: null };
    this.opts = { pollMs, lsPollMs, quotaPollMs, evalMs };
    this.timers = [];
    this.dirty = false;
    this.maxByModel = loadModelLimits(); // model name -> maxContextTokens learned from live streams
    this.lang = currentLang();
  }

  start() {
    this.scan();
    this.timers.push(setInterval(() => this.scan(), 5000));
    this.timers.push(setInterval(() => this.pollTranscripts(), this.opts.pollMs));
    this.timers.push(setInterval(() => this.pollLs(), this.opts.lsPollMs));
    this.timers.push(setInterval(() => this.pollQuota(), this.opts.quotaPollMs));
    this.timers.push(setInterval(() => this.flush(), 250));
    this.timers.push(setInterval(() => this.evaluate(), this.opts.evalMs));
    this.timers.push(setInterval(() => { this.thresholds = calibrate([...this.convs.values()].map((c) => c.run)); }, 60_000));
    this.thresholds = calibrate([...this.convs.values()].map((c) => c.run));
    this.pollLs().then(() => { this.evaluate(); this.pollQuota(); });
  }

  stop() {
    this.timers.forEach(clearInterval);
    for (const c of this.convs.values()) c.stream?.abort();
  }

  touch() { this.dirty = true; }
  flush() { if (this.dirty) { this.dirty = false; this.emit('change'); } }

  scan() {
    let ids = [];
    try { ids = readdirSync(BRAIN).filter((d) => ID_RE.test(d)); } catch { return; }
    for (const id of ids) {
      if (this.convs.has(id)) continue;
      const file = join(BRAIN, id, '.system_generated', 'logs', 'transcript.jsonl');
      try { statSync(file); } catch { continue; }
      const ann = readAnnotation(id);
      const conv = { id, file, tailer: new JsonlTailer(file), run: createRun(id), title: ann.title, viewedAt: ann.viewedAt, annMtime: ann.mtimeMs, ls: null, liveContext: null, stream: null };
      this.convs.set(id, conv);
      this.ingest(conv);
    }
  }

  /** Switch the display language (null/'auto' = follow Antigravity) and re-render every text we produced. */
  setLang(lang) {
    setLang(lang);
    this.relang();
    this.touch(); // following Antigravity again may keep the language but changes state.langAuto
    return currentLang();
  }

  /** Text in runs (step briefs) and verdicts is produced in the language of the moment: rebuild it all. */
  relang() {
    const lang = currentLang();
    if (lang === this.lang) return;
    this.lang = lang;
    for (const conv of this.convs.values()) {
      conv.tailer = new JsonlTailer(conv.file);
      conv.run = createRun(conv.id);
      this.ingest(conv);
      if (conv.verdict) conv.verdict = this.verdictFor(conv); // same level, new language: no alert
    }
    this.touch();
  }

  ingest(conv) {
    const rows = conv.tailer.poll();
    // the file was truncated or replaced: the tailer starts over, so does the run (or every count doubles)
    if (conv.tailer.reset) { conv.tailer.reset = false; conv.run = createRun(conv.id); this.touch(); }
    if (!rows.length) return false;
    // only the newest row's append time is known: the file mtime
    rows.forEach((r, i) => applyRow(conv.run, r, i === rows.length - 1 ? conv.tailer.mtimeMs : undefined));
    conv.exec = null; // a new step supersedes any live waiting/retry hint
    this.touch();
    return true;
  }

  pollTranscripts() {
    for (const conv of this.convs.values()) {
      this.ingest(conv);
      this.pollAnnotation(conv);
    }
  }

  /** Antigravity rewrites annotations/<id>.pbtxt (title, last_user_view_time) when you open a conversation. */
  pollAnnotation(conv) {
    let st;
    try { st = statSync(join(ANNOTATIONS, `${conv.id}.pbtxt`)); } catch { return; }
    if (st.mtimeMs === conv.annMtime) return;
    const ann = readAnnotation(conv.id);
    conv.annMtime = ann.mtimeMs;
    if (ann.title && ann.title !== conv.title) conv.title = ann.title;
    if (ann.viewedAt && ann.viewedAt !== conv.viewedAt) { conv.viewedAt = ann.viewedAt; this.touch(); }
  }

  /** The conversation you have open in Antigravity: the most recently viewed one. */
  focus() {
    let best = null;
    for (const c of this.convs.values()) if (c.viewedAt && (!best || c.viewedAt > best.viewedAt)) best = c;
    return best ? { id: best.id, at: best.viewedAt } : null;
  }

  async pollLs() {
    const ep = findEndpoint();
    if (!ep) {
      // no live hub process: conversations that were busy lost their executor
      for (const conv of this.convs.values()) {
        if (BUSY_RE.test(conv.ls?.status || '')) conv.hubGone = true;
        if (conv.ls) { conv.ls = null; this.touch(); }
        conv.stream?.abort(); conv.stream = null;
      }
      this.setLs(null, tr('Antigravity 未运行或无法连接（仅文件模式）', 'Antigravity is not running or unreachable (files only)'));
      return;
    }
    if (ep.pid && this.hubPid && ep.pid !== this.hubPid) this.hubRestart = { at: Date.now(), from: this.hubPid, to: ep.pid };
    if (ep.pid) this.hubPid = ep.pid;
    try {
      const resp = await unary(ep, 'GetAllCascadeTrajectories');
      this.setLs(ep, null);
      for (const conv of this.convs.values()) conv.hubGone = false;
      for (const [id, s] of Object.entries(resp.trajectorySummaries || {})) {
        const conv = this.convs.get(id);
        if (!conv) continue;
        const ls = { status: s.status, stepCount: s.stepCount, summary: s.summary, rootId: s.trajectoryMetadata?.rootConversationId, termination: s.latestExecutorTerminationReason, lastModifiedTime: s.lastModifiedTime };
        if (JSON.stringify(ls) !== JSON.stringify(conv.ls)) { conv.ls = ls; this.touch(); }
        if (s.annotations?.title && s.annotations.title !== conv.title) { conv.title = s.annotations.title; this.touch(); }
        const seen = Date.parse(s.annotations?.lastUserViewTime ?? '');
        if (seen > (conv.viewedAt || 0)) { conv.viewedAt = seen; this.touch(); }
        this.syncStream(conv, ep);
      }
    } catch (e) {
      // nothing listening at the hub's address any more: it exited (the address injected into a sidecar never
      // changes, so this is the only way to see that) — busy conversations lost their executor
      const gone = e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED';
      this.setLs(null, tr('连接 Antigravity 失败：', 'Could not connect to Antigravity: ') + e.message);
      for (const conv of this.convs.values()) {
        if (gone && BUSY_RE.test(conv.ls?.status || '')) { conv.hubGone = true; conv.stream?.abort(); conv.stream = null; }
        if (conv.ls) { conv.ls = null; this.touch(); }
      }
    }
  }

  setLs(ep, error) {
    const next = { endpoint: ep?.name ?? null, ok: !!ep && !error, error, lsVersion: ep?.lsVersion ?? null };
    if (JSON.stringify(next) !== JSON.stringify(this.ls)) { this.ls = next; this.touch(); }
  }

  // Keep a live StreamAgentStateUpdates subscription only while a conversation is busy.
  syncStream(conv, ep) {
    const busy = BUSY_RE.test(conv.ls?.status || '');
    if (busy && !conv.stream) {
      const ctrl = new AbortController();
      conv.stream = ctrl;
      (async () => {
        try {
          for await (const update of stream(ep, 'StreamAgentStateUpdates', { conversationId: conv.id, subscriberId: 'better-view' }, ctrl.signal)) {
            const exec = extractExec(update);
            if (exec) { conv.exec = exec; this.touch(); }
            const ctx = extractContext(update);
            if (ctx) {
              conv.liveContext = { ...conv.liveContext, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null)) };
              if (ctx.max && conv.run.model && this.maxByModel.get(conv.run.model) !== ctx.max) {
                this.maxByModel.set(conv.run.model, ctx.max);
                saveModelLimits(this.maxByModel);
              }
              this.touch();
            }
          }
        } catch (e) {
          if (!ctrl.signal.aborted) conv.streamError = e.message;
        } finally {
          if (conv.stream === ctrl) conv.stream = null;
          conv.exec = null;
        }
      })();
    } else if (!busy && conv.stream) {
      conv.stream.abort();
      conv.stream = null;
    }
  }

  async pollQuota() {
    const ep = findEndpoint();
    if (!ep) return;
    // The summary has the shared pools (weekly, 5-hour, Gemini); Claude, GPT and other vendors' models carry
    // their own quotaInfo on each model config in GetUserStatus (what Antigravity's "quota reached for <model>"
    // message reads). Both, merged.
    const errors = [];
    let summary = [], perModel = [];
    try { summary = normalizeQuota(await unary(ep, 'RetrieveUserQuotaSummary')); } catch (e) { errors.push(`RetrieveUserQuotaSummary: ${e.message}`); }
    try {
      const status = await unary(ep, 'GetUserStatus');
      perModel = modelQuotas(status, { skipFamilies: summary.length ? ['Gemini'] : [] });
      if (!summary.length && !perModel.length) summary = normalizeQuota(status);
    } catch (e) { errors.push(`GetUserStatus: ${e.message}`); }
    const buckets = [...summary, ...perModel];
    if (buckets.length) this.quota = { buckets, families: quotaFamilies(buckets), at: Date.now(), error: errors.join('; ') || null, via: perModel.length ? 'summary+models' : 'summary' };
    else this.quota = { ...this.quota, error: errors.join('; ') || null };
    this.touch();
  }

  bgLogs(conv) {
    const m = new Map();
    for (const b of conv.run.bg.values()) {
      if (b.status !== 'RUNNING') continue;
      try {
        const st = statSync(join(BRAIN, conv.id, '.system_generated', 'tasks', `${b.id.split('/').pop()}.log`));
        m.set(b.id, { mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* no log yet */ }
    }
    return m;
  }

  /** Spawned conversations of this one whose turn is still open. */
  activeChildren(conv) {
    let n = 0;
    for (const c of this.convs.values()) {
      if (c === conv || !(c.run.parentId === conv.id || conv.run.children.has(c.id))) continue;
      if (turnOpen(c.run) && !c.hubGone) n++;
    }
    return n;
  }

  verdictFor(conv, now = Date.now()) {
    return assess(conv.run, {
      activeChildren: this.activeChildren(conv),
      now,
      lsStatus: conv.ls?.status,
      termination: conv.ls?.termination,
      hubGone: !!conv.hubGone,
      hubRestart: this.hubRestart,
      exec: conv.exec,
      bgLogs: this.bgLogs(conv),
      hubLog: this.hubLogSummary,
      thresholds: this.thresholds,
    });
  }

  /**
   * Re-assesses every conversation (time passing alone can change a verdict). Emits 'alert' when a
   * conversation newly enters an alert/waiting level, and 'finished' when a long turn completes.
   */
  evaluate(now = Date.now()) {
    this.relang(); // another Better View process (or prefs.json) may have switched the language
    this.hubLogSummary = this.hubLog.poll(now);
    const baseline = !this.evaluated;
    this.evaluated = true;
    for (const conv of this.convs.values()) {
      const prev = conv.verdict;
      const v = this.verdictFor(conv, now);
      conv.verdict = v;
      const changed = !prev || prev.level !== v.level || prev.phase !== v.phase || prev.title !== v.title
        || Object.keys(prev.bgQuiet).join() !== Object.keys(v.bgQuiet).join();
      if (!changed) continue;
      this.touch();
      if (baseline || !prev) continue;
      const fresh = now - conv.run.lastRowAt < 60 * 60_000 || conv.hubGone;
      let title = conv.title || conv.run.prompt || conv.id.slice(0, 8);
      if (conv.run.parentId) {
        let root = conv;
        for (let i = 0; i < 20 && root.run.parentId && this.convs.has(root.run.parentId); i++) root = this.convs.get(root.run.parentId);
        title = `${root.title || root.run.prompt || tr('团队任务', 'Team task')} · ${conv.run.agentName || tr('子 agent', 'subagent')}`;
      }
      if ((ALERT_LEVELS.has(v.level) || v.level === 'WAITING') && v.level !== prev.level && fresh) {
        this.emit('alert', { id: conv.id, title, level: v.level, headline: v.title, evidence: v.evidence, hint: v.hint });
      }
      const wasBusy = /THINKING|TOOL_RUNNING/.test(prev.phase);
      const turnMs = conv.run.lastRowAt - conv.run.turnStartedAt;
      if (!conv.run.parentId && wasBusy && /IDLE|BG_TASK/.test(v.phase) && v.level === 'OK' && !conv.run.pending.length && turnMs >= 3 * 60_000) {
        this.emit('finished', { id: conv.id, title, turnMs, summary: conv.run.steps.at(-1)?.brief ?? '' });
      }
    }
  }

  state() {
    const now = Date.now();
    const runs = [...this.convs.values()].map((c) => {
      let live = c.liveContext && (c.liveContext.used != null || c.liveContext.max != null)
        ? { ...c.run.context, ...c.liveContext, used: c.liveContext.used ?? c.run.context?.used, source: c.stream ? 'live' : 'last-live' }
        : null;
      if (!live && c.run.context && this.maxByModel.has(c.run.model)) live = { ...c.run.context, max: this.maxByModel.get(c.run.model) };
      // what fills the window, as Antigravity measured it on the latest model call (conversations/<id>.db)
      const meta = convMeta(c.id);
      const bd = meta?.breakdown;
      if (bd) {
        live = live ?? (c.run.context ? { ...c.run.context } : { used: bd.used, source: 'db' });
        live = { ...live, max: live.max ?? bd.max, breakdown: { total: bd.total, groups: bd.groups } };
      }
      return {
        ...snapshot(c.run, now, { lsStatus: c.ls?.status, liveContext: live }),
        title: c.title || c.ls?.summary || c.run.prompt || c.id.slice(0, 8),
        // the model that actually ran last (subagents' transcripts never name theirs)
        model: prettyModel(meta?.model) || c.run.model || null,
        modelId: meta?.model ?? null,
        lsStatus: c.ls?.status ?? null,
        rootId: c.ls?.rootId ?? null,
        termination: c.ls?.termination ?? null,
        streamError: c.streamError ?? null,
        verdict: c.verdict ? { ...c.verdict, bgQuiet: c.verdict.bgQuiet } : null,
        exec: c.exec ?? null,
      };
    });
    runs.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

    // team structure, checklists and per-agent progress
    const { info, groups } = buildTeams(runs);
    const byId = new Map(runs.map((r) => [r.id, r]));
    for (const r of runs) {
      r.team = info.get(r.id);
      r.checklist = checklistOf(r);
      r.progress = r.checklist?.total ? r.checklist.done / r.checklist.total : r.turnOpen ? null : 1;
      delete r.turns;
    }
    const teams = groups.map((g) => {
      const members = g.memberIds.map((id) => byId.get(id));
      const root = byId.get(g.rootId);
      const master = members.find((m) => m.checklist?.source === 'file' && m.checklist.total > 0) || root;
      const worst = members.reduce((w, m) => (LEVEL_RANK[m.verdict?.level] ?? 0) > (LEVEL_RANK[w] ?? 0) ? m.verdict.level : w, 'OK');
      return {
        rootId: g.rootId,
        isTeam: g.isTeam,
        title: root.title,
        memberIds: g.memberIds,
        lastActivityAt: Math.max(...members.map((m) => m.lastActivityAt || 0)),
        active: members.filter((m) => m.phase !== 'IDLE').length,
        finished: members.filter((m) => !m.turnOpen).length,
        worst,
        checklistOwner: master?.checklist ? master.id : null,
      };
    }).sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    const th = this.thresholds;
    return { now, lang: this.lang, langAuto: !LANGS.includes(readPrefs().lang) && !process.env.BETTER_VIEW_LANG, ls: this.ls, quota: this.quota, runs, teams, focus: this.focus(), hubLog: this.hubLogSummary, thresholds: { think: th.think, tools: th.tools, tool: th.tool } };
  }
}

/** title and last_user_view_time from annotations/<id>.pbtxt (text proto; non-ASCII as octal escapes). */
export function parseAnnotation(text) {
  const t = text.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
  const v = text.match(/last_user_view_time:\s*\{\s*seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?/);
  return { title: t ? decodePbString(t[1]) : null, viewedAt: v ? Number(v[1]) * 1000 + Math.floor(Number(v[2] || 0) / 1e6) : null };
}

function readAnnotation(id) {
  const file = join(ANNOTATIONS, `${id}.pbtxt`);
  try { return { ...parseAnnotation(readFileSync(file, 'utf8')), mtimeMs: statSync(file).mtimeMs }; } catch { return { title: null, viewedAt: null, mtimeMs: null }; }
}

/** Protobuf text format escapes non-ASCII as octal bytes (\344\275\240); decode back to UTF-8. */
export function decodePbString(s) {
  const bytes = [];
  const chars = [...s]; // by code point: a raw emoji is one character, not two halves
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '\\' || i + 1 >= chars.length) { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const rest = chars.slice(i + 1, i + 4).join('');
    const oct = rest.match(/^[0-7]{1,3}/);
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += oct[0].length; continue; }
    const hex = chars[i + 1] === 'x' && chars.slice(i + 2, i + 4).join('').match(/^[0-9a-fA-F]{1,2}/);
    if (hex) { bytes.push(parseInt(hex[0], 16)); i += 1 + hex[0].length; continue; }
    const map = { n: 10, t: 9, r: 13, '"': 34, "'": 39, '\\': 92 };
    const n = chars[i + 1];
    if (n in map) bytes.push(map[n]); else bytes.push(...Buffer.from(n, 'utf8'));
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}
