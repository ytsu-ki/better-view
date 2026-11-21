// macOS system notifications via osascript. Text travels as argv, never spliced into the script,
// so titles containing quotes or AppleScript can't inject code. Off with BETTER_VIEW_NOTIFY=0.
//
// Several Better View processes watch the same conversations at once: the plugin sidecar, one MCP server per
// host app (Antigravity, Gemini), a standalone `npm start`. Only one may notify. A lease file decides
// (~/.cache/better-view/notifier-<data dir hash>.json, {pid, at}): the process that notified last keeps the job
// while it is alive and has notified within LEASE_MS; after that, the first one to see something new takes it.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { tr } from './i18n.mjs';
import { AG_DIR, isAlive } from './hub.mjs';

const SCRIPT = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)', '-e', 'end run'];

export const notifyEnabled = () => process.platform === 'darwin' && process.env.BETTER_VIEW_NOTIFY !== '0';

// one lease per watched data directory: a test run on a temporary one never silences the real panel
export const LEASE_FILE = process.env.BETTER_VIEW_LEASE
  || join(homedir(), '.cache', 'better-view', `notifier-${createHash('sha1').update(AG_DIR).digest('hex').slice(0, 8)}.json`);
export const LEASE_MS = 30_000;

/** True when this process may notify now (and records that it does); false while another one holds the job. */
export function takeLease(file = LEASE_FILE, { pid = process.pid, now = Date.now(), alive = isAlive } = {}) {
  let cur = null;
  try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (cur && cur.pid !== pid && alive(cur.pid) && now - cur.at < LEASE_MS) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${pid}`;
    writeFileSync(tmp, JSON.stringify({ pid, at: now }));
    renameSync(tmp, file);
    return JSON.parse(readFileSync(file, 'utf8')).pid === pid; // two takers at once: the last rename wins
  } catch { return true; } // no writable cache: a duplicate beats silence
}

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function notify(title, subtitle, body, run = execFile) {
  if (!notifyEnabled()) return false;
  run('/usr/bin/osascript', [...SCRIPT, clip(title, 60), clip(body, 200), clip(subtitle, 80)], { timeout: 5000 }, (err) => { if (err) console.error(`[notify] osascript failed: ${err.message}`); });
  return true;
}

const ICON = { STALLED: '🔴', HALTED: '🔴', DEAD: '⛔', WAITING: '🔵' };

/** Text for a store 'alert' event. */
export function alertText(a) {
  return {
    title: `${ICON[a.level] ?? '⚠'} ${a.headline}`,
    subtitle: a.title,
    body: [a.evidence?.[0], a.hint].filter(Boolean).join(' · '),
  };
}

/** Several alerts of one level at once (e.g. the hub died under three runs) become one notification. */
export function groupText(level, alerts) {
  if (alerts.length === 1) return alertText(alerts[0]);
  const a = alerts[0];
  return {
    title: `${ICON[level] ?? '⚠'} ${a.headline}${tr(`（${alerts.length} 个会话）`, ` (${alerts.length} conversations)`)}`,
    subtitle: alerts.map((x) => x.title).join(tr('、', ', ')),
    body: a.hint || a.evidence?.[0] || '',
  };
}

export function finishedText(f) {
  const m = Math.round(f.turnMs / 60000);
  return { title: tr(`✅ 已完成（用时 ${m} 分钟）`, `✅ Done (${m} min)`), subtitle: f.title, body: f.summary };
}

/**
 * Turns a Store's 'alert' and 'finished' events into notifications. Alerts landing together (one evaluation
 * pass) are grouped per level into a single notification. log gets one line per alert (the MCP server keeps
 * titles out of its log file: it passes a log that drops them).
 */
export function attachNotifier(store, { log = (a) => console.log(`[alert] ${a.level} ${a.title}: ${a.headline}`), lease = () => takeLease(), send = notify, wait = 500 } = {}) {
  const deliver = (t) => { if (notifyEnabled() && lease()) send(t.title, t.subtitle, t.body); };
  let pending = [];
  store.on('alert', (a) => {
    log(a);
    if (!pending.length) setTimeout(() => {
      const byLevel = new Map();
      for (const x of pending) byLevel.set(x.level, [...(byLevel.get(x.level) || []), x]);
      pending = [];
      for (const [level, list] of byLevel) deliver(groupText(level, list));
    }, wait);
    pending.push(a);
  });
  store.on('finished', (f) => deliver(finishedText(f)));
}
