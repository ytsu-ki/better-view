// Stall detection: turns a run plus outside signals into one verdict with evidence.
// Levels, from benign to bad:
//   OK       nothing to report
//   WAITING  the agent needs you (question / approval) — not a stall, but you should look
//   SLOW     longer than this user's own history says is normal; keep an eye on it
//   STALLED  far past normal with no sign of progress
//   HALTED   Antigravity reports the conversation stopped, but the turn never finished
//   STOPPED  you stopped it (USER_CANCELED, or stop pressed before any reply): shown, never alerted
//   DEAD     the Antigravity background service is gone while the turn was running
// Thresholds come from the user's own transcripts (calibrate) and fall back to DEFAULTS.

import { phaseOf, turnOpen } from './reducer.mjs';
import { tr, fmtMs } from './i18n.mjs';

const MIN = 60_000;

export const DEFAULTS = {
  think: { slow: 2 * MIN, stalled: 5 * MIN },
  tool: { slow: 1 * MIN, stalled: 8 * MIN },
  errorIdle: 1 * MIN, // an error row with nothing after it for this long
  haltedGrace: 15_000, // LS idle while the transcript is open: allow for poll races
  bgQuiet: 5 * MIN, // background task log not growing
  minSamples: 20,
};

export const BUSY_RE = /RUNNING|BUSY|CANCELING/;

export function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Builds thresholds from the duration samples the reducer collected on every run. */
export function calibrate(runs, d = DEFAULTS) {
  const think = [], tools = {};
  for (const r of runs) {
    think.push(...r.samples.think);
    for (const [name, v] of Object.entries(r.samples.tools)) (tools[name] ??= []).push(...v);
  }
  const out = { think: { ...d.think, n: think.length }, tools: {}, tool: { ...d.tool } };
  if (think.length >= d.minSamples) {
    const p99 = quantile(think, 0.99);
    out.think = {
      slow: clamp(p99, d.think.slow * 0.75, 10 * MIN),
      stalled: clamp(2.5 * p99, d.think.stalled, 20 * MIN),
      p50: quantile(think, 0.5), p90: quantile(think, 0.9), p99, n: think.length,
    };
  }
  for (const [name, v] of Object.entries(tools)) {
    if (v.length < d.minSamples) continue;
    const p99 = quantile(v, 0.99);
    out.tools[name] = { slow: clamp(3 * p99, d.tool.slow, 15 * MIN), stalled: clamp(8 * p99, d.tool.stalled, 30 * MIN), p99, n: v.length };
  }
  return out;
}

export { fmtMs };

const TOOL_NAME = {
  run_command: ['命令', 'Command'], read_file: ['读取', 'Read'], edit_file: ['编辑', 'Edit'], write_file: ['写入', 'Write'],
  search_web: ['搜索', 'Web search'], manage_task: ['管理任务', 'Task'], manage_subagents: ['子 agent', 'Subagents'],
};
const toolName = (t) => (TOOL_NAME[t] ? tr(...TOOL_NAME[t]) : t);
const userCanceled = (t) => /USER_CANCELED/.test(t || '');
const ago = (ms) => tr(`${fmtMs(ms)}前`, `${fmtMs(ms)} ago`);

/**
 * ctx: {
 *   now, lsStatus (string|undefined), termination, hubGone (bool: hub vanished while this run was busy),
 *   hubRestart ({at, from, to}|null), exec ({state, waiting, attempt, maxAttempts, retryAt}|null),
 *   bgLogs (Map taskId -> {mtimeMs, size}), hubLog ({auth:{at,line}|null, network:{at,count,line}|null}),
 *   thresholds (from calibrate), connected (bool: hub reachable now)
 * }
 * Returns { level, title, since, evidence: string[], hint, bgQuiet: {taskId: ms} }. Text is in the current
 * display language (lib/i18n.mjs).
 */
export function assess(run, ctx) {
  const { now, thresholds: th = calibrate([]) } = ctx;
  const d = DEFAULTS;
  const open = turnOpen(run);
  const phase = phaseOf(run, now, ctx.lsStatus);
  const evidence = [];
  const waitingOn = ctx.activeChildren || 0;
  const v = (level, title, since, hint) => ({ level, title, since, evidence, hint, phase, bgQuiet, waitingOn });

  // background tasks whose log stopped growing (annotation only — servers legitimately go quiet)
  const bgQuiet = {};
  for (const b of run.bg.values()) {
    if (b.status !== 'RUNNING') continue;
    const log = ctx.bgLogs?.get(b.id);
    const last = Math.max(log?.mtimeMs || 0, b.startedAt || 0);
    if (last && now - last > d.bgQuiet) bgQuiet[b.id] = now - last;
  }

  const sysHints = () => {
    const recent = (x) => x && now - x.at < 5 * MIN;
    if (recent(ctx.hubLog?.auth)) evidence.push(tr('Antigravity 日志：登录状态失效（You are not logged into Antigravity）', 'Antigravity log: signed out (You are not logged into Antigravity)'));
    if (recent(ctx.hubLog?.network)) evidence.push(tr(`Antigravity 日志：近 5 分钟 ${ctx.hubLog.network.count} 次网络错误（${ctx.hubLog.network.line}）`, `Antigravity log: ${ctx.hubLog.network.count} network errors in the last 5 minutes (${ctx.hubLog.network.line})`));
  };
  const pendingTool = (p) => tr(`未返回的工具：${toolName(p.tool)} ${p.brief}`, `Tool still pending: ${toolName(p.tool)} ${p.brief}`);

  const lastAct = run.lastRowAt;

  // 1. service gone mid-turn
  const pend = run.pending[0];
  const turnError = run.lastError && run.lastError.at >= (run.turnStartedAt || 0) ? run.lastError : null;
  if (ctx.hubGone && open) {
    evidence.push(tr('Antigravity 后台服务（agy hub）已不在运行', 'The Antigravity background service (agy hub) is no longer running'));
    if (pend) evidence.push(pendingTool(pend));
    if (turnError) evidence.push(tr(`退出前的错误：${turnError.brief}`, `Error before it exited: ${turnError.brief}`));
    evidence.push(tr(`最后活动：${ago(now - lastAct)}`, `Last activity: ${ago(now - lastAct)}`));
    return v('DEAD', tr('Antigravity 服务已退出，本轮中断', 'Antigravity service exited; this turn was cut off'), lastAct,
      tr('重新打开 Antigravity，在会话里发送“继续”', 'Reopen Antigravity and send "continue" in the conversation'));
  }

  // 2. waiting on the user (a question, even one asked alongside other tools, or the live state says so) — never a stall
  const ask = run.pending.find((p) => p.tool === 'ask_question');
  if (ask || ctx.exec?.waiting) {
    evidence.push(ask ? tr(`问题：${ask.brief}`, `Question: ${ask.brief}`) : tr('Antigravity 实时状态：等待你的操作（批准或回答）', 'Antigravity live status: waiting for you (approve or answer)'));
    return v('WAITING', tr('等你操作', 'Needs you'), ask?.startedAt ?? pend?.startedAt ?? lastAct, tr('到 Antigravity 会话中回答或批准', 'Answer or approve in the Antigravity conversation'));
  }

  // 2b. a Teamwork parent waiting on its subagents is idle by design (STATE_WAITING_FOR_SUBAGENTS):
  //     their own verdicts cover any stall; never flag the parent for the wait
  if (waitingOn > 0 && (!pend || /invoke_subagent|manage_subagents/.test(pend.tool))) return v('OK', '', lastAct, '');

  // 3. hub says idle but the transcript shows an unfinished turn
  const lsKnown = typeof ctx.lsStatus === 'string';
  if (lsKnown && !BUSY_RE.test(ctx.lsStatus) && open && now - lastAct > d.haltedGrace) {
    if (userCanceled(ctx.termination)) return v('STOPPED', tr('已由你停止', 'Stopped by you'), lastAct, '');
    // a compaction that ended the turn (TERMINAL_CUSTOM_HOOK is how the hub stops the executor after one; a
    // /compact request is already closed by the reducer, this covers compactions started some other way)
    if (run.lastRow?.compaction && /CUSTOM_HOOK/.test(ctx.termination || '')) return v('OK', '', lastAct, '');
    // Nothing ran for this turn: no reply and no tool since the user's message, and the termination reason is
    // the previous turn's (NO_TOOL_CALL = that turn ended normally). That is what pressing stop right after
    // sending looks like; no executor record is written then. A state, not an alarm.
    if (!run.turnModelRows && (!ctx.termination || /NO_TOOL_CALL|UNSPECIFIED/.test(ctx.termination))) {
      if (ctx.hubRestart && ctx.hubRestart.at > (run.turnStartedAt || 0)) evidence.push(tr(`之后 Antigravity 重启过（pid ${ctx.hubRestart.from} → ${ctx.hubRestart.to}）`, `Antigravity restarted afterwards (pid ${ctx.hubRestart.from} → ${ctx.hubRestart.to})`));
      evidence.push(tr(`发出消息后还没有回复：${ago(now - lastAct)}停下`, `No reply to the message yet; stopped ${ago(now - lastAct)}`));
      return v('STOPPED', tr('已停止，这轮还没有回复', 'Stopped before any reply'), lastAct, tr('如果不是你停止的，在会话里重新发送', "If you didn't stop it, send the message again"));
    }
    if (pend) evidence.push(pendingTool(pend));
    if (turnError) evidence.push(tr(`最后错误：${turnError.brief}`, `Last error: ${turnError.brief}`));
    if (ctx.termination && !/UNSPECIFIED/.test(ctx.termination)) evidence.push(tr('终止原因：', 'Termination reason: ') + ctx.termination.replace('EXECUTOR_TERMINATION_REASON_', ''));
    if (ctx.hubRestart && ctx.hubRestart.at > lastAct) evidence.push(tr(`服务在 ${ago(now - ctx.hubRestart.at)}重启过（pid ${ctx.hubRestart.from} → ${ctx.hubRestart.to}）`, `The service restarted ${ago(now - ctx.hubRestart.at)} (pid ${ctx.hubRestart.from} → ${ctx.hubRestart.to})`));
    evidence.push(tr(`最后活动：${ago(now - lastAct)}`, `Last activity: ${ago(now - lastAct)}`));
    sysHints();
    return v('HALTED', tr('Antigravity 已停止，但本轮没有完成', 'Antigravity stopped, but the turn never finished'), lastAct,
      tr('在会话里发送“继续”，或重新描述剩余任务', 'Send "continue" in the conversation, or restate what is left'));
  }

  // 4. running: compare elapsed time with this user's history
  if (phase === 'TOOL_RUNNING') {
    const t = th.tools[pend.tool] ?? th.tool;
    const el = now - pend.startedAt;
    const name = toolName(pend.tool);
    if (el > t.slow) {
      evidence.push(tr(`${name}已运行 ${fmtMs(el)}：${pend.brief}`, `${name} running for ${fmtMs(el)}: ${pend.brief}`));
      if (t.p99) evidence.push(tr(`你的历史中 99% 的${name}在 ${fmtMs(t.p99)} 内完成（${t.n} 次）`, `In your history 99% of ${name} calls finished within ${fmtMs(t.p99)} (${t.n} runs)`));
      evidence.push(tr('前台命令的输出要等结束才写入，期间看不到进展', "A foreground command's output is only written when it ends, so progress isn't visible meanwhile"));
      sysHints();
      const level = el > t.stalled ? 'STALLED' : 'SLOW';
      return v(level, level === 'STALLED' ? tr(`疑似卡住：${name}长时间未返回`, `Looks stuck: ${name} hasn't returned`) : tr(`${name}比平时慢`, `${name} slower than usual`), pend.startedAt,
        tr('若 Antigravity 在等你批准命令，请到会话中确认；否则可在会话中停止后发送“继续”', 'If Antigravity is waiting for you to approve the command, confirm it in the conversation; otherwise stop it there and send "continue"'));
    }
    return v('OK', '', pend.startedAt, '');
  }

  if (phase === 'THINKING') {
    const el = now - lastAct;
    const afterError = run.lastRow?.type === 'ERROR_MESSAGE' || run.lastRow?.status === 'ERROR';
    const req = ctx.exec;
    if (req?.attempt > 1) {
      const of = req.maxAttempts ? `/${req.maxAttempts}` : '';
      // retryAt is an RFC 3339 string in proto3 JSON; anything unparsable, or a time already past, says nothing
      const left = req.retryAt ? Date.parse(req.retryAt) - now : NaN;
      const wait = Number.isFinite(left) && left >= 1000 ? fmtMs(left) : '';
      evidence.push(tr(`模型请求重试中：第 ${req.attempt}${of} 次${wait ? `，${wait}后重试` : ''}`, `Retrying the model request: attempt ${req.attempt}${of}${wait ? `, next in ${wait}` : ''}`));
    }
    if (afterError && el > d.errorIdle) {
      evidence.push(tr(`出错后 ${fmtMs(el)} 没有新动作`, `Nothing new for ${fmtMs(el)} after the error`), tr('错误：', 'Error: ') + (run.lastError?.brief ?? tr('工具报错', 'tool error')));
      sysHints();
      return v('STALLED', tr('报错后停住了', 'Stuck after an error'), lastAct, tr('在会话里发送“继续”，或描述如何绕过这个错误', 'Send "continue", or describe how to get around the error'));
    }
    if (!open && el > th.think.slow) {
      // transcript ends with a final reply yet the hub reports busy: a new call we can't see yet, or a stale
      // status. Not enough to call it stuck — show it, never alarm on it.
      evidence.push(tr(`Antigravity 显示运行中，但 ${fmtMs(el)} 内没有写入新步骤`, `Antigravity shows it running, but no new step in ${fmtMs(el)}`));
      return v('SLOW', tr('运行中但没有新步骤', 'Running, no new steps'), lastAct, '');
    }
    if (el > th.think.slow || req?.attempt > 1) {
      evidence.unshift(tr(`模型已 ${fmtMs(el)} 没有产出新步骤`, `No new step from the model for ${fmtMs(el)}`));
      if (th.think.p99) evidence.push(tr(`你的历史中 99% 的模型调用在 ${fmtMs(th.think.p99)} 内返回（${th.think.n} 次）`, `In your history 99% of model calls returned within ${fmtMs(th.think.p99)} (${th.think.n} calls)`));
      sysHints();
      const level = el > th.think.stalled ? 'STALLED' : 'SLOW';
      return v(level, level === 'STALLED' ? tr('疑似卡住：模型长时间无响应', 'Looks stuck: the model has not responded') : (req?.attempt > 1 ? tr('模型请求在重试', 'Model request retrying') : tr('模型思考比平时久', 'Model thinking longer than usual')), lastAct,
        level === 'STALLED' ? tr('可在会话中停止后发送“继续”', 'Stop it in the conversation, then send "continue"') : '');
    }
    return v('OK', '', lastAct, '');
  }

  if (!lsKnown && open && phase === 'IDLE') {
    // file-only, turn left open for hours: it ended abnormally at some point
    evidence.push(tr(`最后活动：${ago(now - lastAct)}`, `Last activity: ${ago(now - lastAct)}`), tr('未连接 Antigravity，仅凭文件判断', 'Not connected to Antigravity; judged from files only'));
    return v('HALTED', tr('本轮没有正常结束', "The turn didn't finish normally"), lastAct, '');
  }
  return v('OK', '', lastAct, '');
}

export const ALERT_LEVELS = new Set(['STALLED', 'HALTED', 'DEAD']);
