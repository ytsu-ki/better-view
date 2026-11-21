// Pure state machine: transcript rows -> run state -> view snapshot.
// Facts it relies on (verified against real transcripts, ls 2.29.0):
//  - rows are appended once, after each step completes; step_index never repeats
//  - a PLANNER_RESPONSE's tool_calls are answered by the following GENERIC rows, in order
//  - a background command leaves a GENERIC row with status RUNNING whose content names the task id;
//    completion arrives later as a SYSTEM_MESSAGE: Task id "<id>" finished|was canceled with result
//  - a server restart is announced by "All your subagents and background tasks have been stopped"
//  - created_at is when a step STARTED: a PLANNER_RESPONSE's is the start of the model call, a GENERIC's
//    the start of the tool (its content carries Completed At). The append time of the last row is only
//    known from the file's mtime, which the caller passes as seenAt.
//  - a SYSTEM_MESSAGE always wakes the agent (next row is a model call), so a turn is open until the
//    last row is a PLANNER_RESPONSE without tool calls

import { tr } from './i18n.mjs';

const TIMELINE_LIMIT = 80;
const STALE_WITHOUT_LS_MS = 2 * 60 * 60 * 1000;
const SAMPLE_CAP = 2000;

const ts = (iso) => (iso ? Date.parse(iso) : NaN);
const stripMd = (s) => s.replace(/\*\*|__|`/g, '').replace(/^#{1,6}\s+/, '').replace(/^[-*>]\s+/, '');
const clip = (s, n = 140) => { s = stripMd(String(s ?? '').replace(/\s+/g, ' ').trim()); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => String(p ?? '').split('/').filter(Boolean).pop() || String(p ?? '');

function parseArg(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export function toolBrief(name, rawArgs = {}) {
  const a = Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [k, parseArg(v)]));
  if (a.toolSummary) return clip(a.toolSummary);
  switch (name) {
    case 'run_command': return clip(a.CommandLine);
    case 'read_file':
    case 'view_file': return clip(base(a.Path ?? a.AbsolutePath) + (a.StartLine ? `:${a.StartLine}-${a.EndLine ?? ''}` : ''));
    case 'edit_file':
    case 'write_file':
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content': return clip(base(a.Path ?? a.TargetFile) + (a.Description ? ` · ${a.Description}` : ''));
    case 'invoke_subagent': return clip(a.Role ? `${a.Role}` : a.TypeName ?? '');
    case 'send_message': return clip(a.Message ?? '');
    case 'search_web': return clip(a.query);
    case 'manage_task': return clip(`${a.Action ?? ''} ${a.TaskId ? taskShort(a.TaskId) : ''}`);
    case 'ask_question': { // questions: [{question, options, is_multi_select}]
      const qs = Array.isArray(a.questions) ? a.questions : [];
      const first = qs[0]?.question;
      return first ? clip(qs.length > 1 ? tr(`${first}（共 ${qs.length} 个问题）`, `${first} (${qs.length} questions)`) : first) : tr('等待你回答问题', 'Waiting for your answer');
    }
    default: {
      const first = Object.values(a).find((v) => typeof v === 'string');
      return clip(first ?? '');
    }
  }
}

export const taskShort = (id) => String(id).split('/').pop();

export function createRun(id) {
  return {
    id,
    rows: 0,
    firstAt: NaN,
    lastRowAt: NaN,
    lastRow: null,
    turnStartedAt: NaN,
    turnModelRows: 0, // model rows (replies, tool results) since the last user message
    prompt: '',
    model: null,
    steps: [],
    pending: [],
    bg: new Map(),
    tokens: { in: 0, out: 0, cacheRead: 0 },
    context: null,
    restartAt: NaN,
    compactedAt: NaN,
    lastError: null,
    openThink: null, // think step whose model call has not been closed by the next row yet
    samples: { think: [], tools: {} }, // completed durations (ms) for threshold calibration
    // Teamwork: a subagent's first row is a SYSTEM_MESSAGE whose sender is the conversation that spawned it
    parentId: null,
    agentName: null, // e.g. worker_m1 (from "You are `x`" or its .agents/teamwork/<x>/ directory)
    brief: '', // what it was asked to do (first message)
    children: new Map(), // childId -> {role, type} from invoke_subagent results
    checklistFile: null, // last markdown checklist this conversation wrote (progress.md, task.md, ...)
    turns: [], // [{text, startedAt, endedAt, done}] — fallback checklist: one item per user request
    compactTurn: false, // this turn's request is /compact: the compaction checkpoint ends it
    seq: 0,
  };
}

function pushStep(run, step) {
  step.id = ++run.seq;
  run.steps.push(step);
  if (run.steps.length > TIMELINE_LIMIT * 2) run.steps.splice(0, run.steps.length - TIMELINE_LIMIT);
  return step;
}

/** Updates a background task and the timeline step that launched it. */
function setTask(run, id, status, t) {
  const task = run.bg.get(id);
  if (!task) return;
  task.status = status;
  task.endedAt = t;
  const step = run.steps.find((s) => s.taskId === id);
  if (step) { step.status = status; step.endedAt = t; }
}

const sample = (arr, v) => { if (v >= 0 && Number.isFinite(v)) { arr.push(v); if (arr.length > SAMPLE_CAP) arr.shift(); } };

/** True while the agent owes a response: the last row is not a final model reply (or the checkpoint of a /compact). */
export const turnOpen = (run) => !!run.lastRow && !run.lastRow.final;

/**
 * Applies one transcript row. seenAt (ms) is when the row was observed on disk — pass the file mtime for
 * the last row of a batch; it is the best available end time for a step whose end the row doesn't carry.
 */
export function applyRow(run, row, seenAt) {
  const t = ts(row.created_at);
  run.rows++;
  if (Number.isNaN(run.firstAt)) run.firstAt = t;
  const content = typeof row.content === 'string' ? row.content : '';
  const completedM = row.type === 'GENERIC' ? content.match(/^Completed At: (\S+)/m) : null;
  const createdM = row.type === 'GENERIC' ? content.match(/^Created At: (\S+)/m) : null;
  const startAt = createdM && !Number.isNaN(ts(createdM[1])) ? ts(createdM[1]) : t;
  const endAt = completedM && !Number.isNaN(ts(completedM[1])) ? ts(completedM[1]) : t;
  run.lastRowAt = Math.max(Number.isNaN(run.lastRowAt) ? -Infinity : run.lastRowAt, endAt, seenAt ?? -Infinity);
  run.lastRow = { type: row.type, status: row.status, step: row.step_index, final: row.type === 'PLANNER_RESPONSE' && !(row.tool_calls || []).length };

  if (run.rows === 1 && row.type === 'SYSTEM_MESSAGE') {
    const sender = content.match(/sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (sender) run.parentId = sender[1];
    const body = content.replace(/^[\s\S]*?content=/, '').replace(/<\/SYSTEM_MESSAGE>[\s\S]*$/, '');
    const name = body.match(/You are `([^`]+)`/) || body.match(/\.agents\/teamwork\/([^/\s`]+)\//);
    if (name) run.agentName = name[1];
    // what it was asked to do: the "Task:" section when there is one, minus working-directory boilerplate
    const task = body.match(/\bTask:\s*([\s\S]+)/);
    const text = (task ? task[1] : body.replace(/You are `[^`]+` \(archetype: `[^`]+`\)\.?/, ''))
      .split('\n').filter((l) => !/working directory|^\s*`?\/|Read these files|^\s*\d+\.\s+`?\//i.test(l)).join(' ');
    run.brief = clip(text, 200);
  }

  // The next row closes the previous model call; a model call answered by a tool row is a clean sample.
  if (run.openThink) {
    const th = run.openThink;
    th.endedAt = Math.max(th.startedAt, startAt);
    if (row.type === 'GENERIC' && th.hadCalls) sample(run.samples.think, th.endedAt - th.startedAt);
    run.openThink = null;
  }

  switch (row.type) {
    case 'USER_INPUT': {
      for (const p of run.pending) { p.status = 'CANCELED'; p.endedAt = t; }
      run.pending = [];
      run.turnStartedAt = t;
      run.turnModelRows = 0;
      const req = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
      run.prompt = clip(req ? req[1] : content, 200);
      run.compactTurn = /^\/compact\b/i.test(req ? req[1].trim() : '');
      const model = content.match(/`Model Selection` from .*? to (.+?)(?:\.(?:\s|$)|\n|$)/m);
      if (model) run.model = model[1].trim();
      pushStep(run, { kind: 'user', brief: run.prompt, startedAt: t, endedAt: t, status: 'DONE' });
      for (const u of run.turns) if (!u.done) u.done = 'superseded';
      run.turns.push({ text: run.prompt, startedAt: t, done: false });
      if (run.turns.length > 30) run.turns.shift();
      break;
    }

    case 'PLANNER_RESPONSE': {
      run.turnModelRows++;
      const inT = row.input_tokens ?? 0, cache = row.cache_read_tokens ?? 0, outT = row.output_tokens ?? 0;
      run.tokens.in += inT; run.tokens.out += outT; run.tokens.cacheRead += cache;
      if (row.input_tokens != null) run.context = { used: inT + cache + outT, at: t, source: 'estimate' };
      const calls = row.tool_calls || [];
      const text = content.trim();
      // the model call started at t; it ended when this row hit the disk (seenAt) or when the next row starts
      const end = seenAt != null && seenAt >= t ? seenAt : undefined;
      const think = pushStep(run, {
        kind: 'think', brief: clip(text.split('\n')[0] || (calls.length ? '' : tr('回复完成', 'Replied')), 160),
        startedAt: t, endedAt: end ?? t, status: 'DONE', outTokens: outT, final: calls.length === 0,
      });
      if (end == null) { think.hadCalls = calls.length > 0; run.openThink = think; }
      if (!calls.length && run.turns.length) { const u = run.turns[run.turns.length - 1]; if (!u.done) { u.done = true; u.endedAt = end ?? t; } }
      for (const c of calls) {
        if (!/write_to_file|replace_file_content|write_file|edit_file/.test(c.name)) continue;
        const target = String(parseArg(c.args?.TargetFile ?? c.args?.Path ?? '') ?? '');
        // only progress-style files: requests/briefs also carry checkboxes (acceptance criteria) that never get ticked;
        // and only the agent's own (Teamwork's .agents/ folders, its artifacts in brain/<id>/): a TODO.md or plan.md
        // it edits in your project is your file, not its checklist
        if (/(^|\/)(progress|task|tasks|todo|plan|checklist)\.md$/i.test(target) && /(^|\/)\.agents\/|\/brain\/[0-9a-f-]{36}\//i.test(target)) run.checklistFile = target;
      }
      for (const c of calls) {
        const step = pushStep(run, { kind: 'tool', tool: c.name, brief: toolBrief(c.name, c.args), args: c.args, startedAt: end ?? t, status: 'RUNNING' });
        run.pending.push(step);
      }
      break;
    }

    case 'GENERIC': {
      run.turnModelRows++;
      let step = run.pending.shift();
      if (!step) step = pushStep(run, { kind: 'tool', tool: 'tool', brief: clip(content.split('\n').find((l) => l && !/^(Created|Completed) At:/.test(l)) ?? ''), startedAt: t, status: 'RUNNING' });
      if (createdM) step.startedAt = startAt;
      const bgId = content.match(/background task with task id: (\S+)/);
      if (row.status === 'RUNNING' && bgId) {
        step.status = 'BACKGROUND';
        step.taskId = bgId[1];
        run.bg.set(bgId[1], { id: bgId[1], brief: step.brief, startedAt: step.startedAt, status: 'RUNNING', stepId: step.id });
      } else {
        step.status = row.status === 'ERROR' ? 'ERROR' : /Tool execution was canceled/.test(content) ? 'CANCELED' : 'DONE';
        step.endedAt = endAt;
        if (createdM && completedM && step.status === 'DONE') sample(run.samples.tools[step.tool] ??= [], endAt - startAt);
        const exit = content.match(/exited with code (-?\d+)/);
        if (exit) { step.exitCode = Number(exit[1]); if (step.exitCode !== 0) step.status = 'ERROR'; }
        const created = content.match(/Created the following subagent:\s*\{\s*"conversationId":\s*"([0-9a-f-]{36})"/);
        if (created) {
          const a = Object.fromEntries(Object.entries(step.args || {}).map(([k, v]) => [k, parseArg(v)]));
          run.children.set(created[1], { role: a.Role ?? null, type: a.TypeName ?? null });
        }
        if (step.tool === 'manage_task') {
          const a = Object.fromEntries(Object.entries(step.args || {}).map(([k, v]) => [k, parseArg(v)]));
          const task = a.TaskId && run.bg.get(a.TaskId);
          if (task && a.Action === 'kill' && task.status === 'RUNNING') setTask(run, task.id, 'KILLED', step.endedAt);
        }
      }
      delete step.args;
      break;
    }

    case 'SYSTEM_MESSAGE': {
      if (/All your subagents and background tasks have been stopped/.test(content)) {
        run.restartAt = t;
        for (const task of run.bg.values()) if (task.status === 'RUNNING') setTask(run, task.id, 'ORPHANED', t);
        pushStep(run, { kind: 'system', brief: tr('服务重启：所有子 agent 和后台任务已被停止', 'Service restarted: all subagents and background tasks were stopped'), startedAt: t, endedAt: t, status: 'ERROR' });
      }
      for (const m of content.matchAll(/Task id "([^"]+)" (finished|was canceled) with result/g)) {
        if (!run.bg.has(m[1])) run.bg.set(m[1], { id: m[1], brief: '', startedAt: NaN });
        const tail = content.slice(m.index, m.index + 400);
        const exit = tail.match(/exited with code (-?\d+)/);
        setTask(run, m[1], m[2] === 'finished' ? (exit && Number(exit[1]) !== 0 ? 'ERROR' : 'DONE') : 'CANCELED', t);
      }
      break;
    }

    case 'CHECKPOINT': {
      if (/compaction/i.test(content)) {
        run.compactedAt = t;
        run.lastRow.compaction = true;
        if (run.compactTurn) {
          // your /compact: compacting is the whole turn; it is done once the checkpoint is written (the hub
          // then goes idle, terminated by TERMINAL_CUSTOM_HOOK) and the agent waits for your next message
          run.lastRow.final = true;
          pushStep(run, { kind: 'system', brief: tr('上下文已压缩（你发送的 /compact）', 'Context compacted (your /compact)'), startedAt: t, endedAt: t, status: 'DONE', final: true });
          const u = run.turns[run.turns.length - 1];
          if (u && !u.done) { u.done = true; u.endedAt = t; }
        } else {
          // an automatic compaction mid-turn: the agent carries on with its next model call
          pushStep(run, { kind: 'system', brief: tr('上下文已压缩，从摘要继续', 'Context compacted; continuing from a summary'), startedAt: t, endedAt: t, status: 'DONE' });
        }
      }
      break;
    }

    case 'ERROR_MESSAGE': {
      const first = content.split('\n').map((l) => l.replace(/^Error:\s*/, '')).find((l) => l.trim());
      const left = content.match(/Retries remaining: (\d+)/);
      run.lastError = { at: t, brief: clip(first || tr('模型返回错误（无详情）', 'The model returned an error (no details)')), retriesLeft: left ? Number(left[1]) : null };
      pushStep(run, { kind: 'system', brief: run.lastError.brief, startedAt: t, endedAt: t, status: 'ERROR' });
      break;
    }
    default:
      break;
  }
  return run;
}

/** Phase of the agent right now. lsStatus is CASCADE_RUN_STATUS_* when the hub is reachable. */
export function phaseOf(run, now, lsStatus) {
  const bgRunning = [...run.bg.values()].some((b) => b.status === 'RUNNING');
  const idle = bgRunning ? 'BG_TASK' : 'IDLE';
  const lsKnown = typeof lsStatus === 'string';
  const lsBusy = lsKnown && /RUNNING|BUSY|CANCELING/.test(lsStatus);
  if (lsKnown && !lsBusy) return idle;
  if (!lsKnown && (!turnOpen(run) || now - run.lastRowAt > STALE_WITHOUT_LS_MS)) return idle;
  // a question asked alongside other tools still waits for you, whichever of them was called first
  if (run.pending.length) return run.pending.some((p) => p.tool === 'ask_question') ? 'WAITING_USER' : 'TOOL_RUNNING';
  return turnOpen(run) || lsBusy ? 'THINKING' : idle; // hub busy after a final reply: a new model call is in flight
}

const pub = (s) => ({ id: s.id, kind: s.kind, tool: s.tool, brief: s.brief, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, taskId: s.taskId, exitCode: s.exitCode, outTokens: s.outTokens, final: s.final });

export function snapshot(run, now, extra = {}) {
  const phase = phaseOf(run, now, extra.lsStatus);
  let current;
  if (phase === 'TOOL_RUNNING' || phase === 'WAITING_USER') {
    const p = phase === 'WAITING_USER' ? run.pending.find((x) => x.tool === 'ask_question') : run.pending[0];
    current = { ...pub(p), parallel: run.pending.length };
  } else if (phase === 'THINKING') {
    current = { kind: 'think', brief: tr('模型思考中', 'Model thinking'), startedAt: run.lastRowAt, status: 'RUNNING' };
  } else {
    const last = run.steps[run.steps.length - 1];
    current = last ? pub(last) : null;
  }
  const bgTasks = [...run.bg.values()]
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, 20)
    .map((b) => ({ ...b, short: taskShort(b.id) }));
  return {
    id: run.id,
    phase,
    current,
    prompt: run.prompt,
    model: run.model,
    rows: run.rows,
    firstAt: run.firstAt,
    lastActivityAt: run.lastRowAt,
    turnStartedAt: run.turnStartedAt,
    tokens: run.tokens,
    context: extra.liveContext || run.context,
    bgTasks,
    restartAt: run.restartAt,
    compactedAt: run.compactedAt,
    lastError: run.lastError,
    turnOpen: turnOpen(run),
    parentId: run.parentId,
    agentName: run.agentName,
    brief: run.brief,
    children: [...run.children],
    checklistFile: run.checklistFile,
    turns: run.turns.slice(-15),
    timeline: run.steps.slice(-TIMELINE_LIMIT).map(pub),
  };
}
