// Display language, shared by every Better View process (sidecar, MCP App server, always-on service):
// the panel, the verdicts and the system notifications all speak it.
//
// Default: Antigravity's language. Antigravity (an Electron app) takes its UI locale from the system's
// preferred languages, so we read the same list: AppleLanguages[0] on macOS, else $LANG. A choice made in
// the panel's 中/EN switch is saved to prefs.json and wins; BETTER_VIEW_LANG wins over both (tests, CI).
// Only Chinese and English: anything that isn't Chinese shows English.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const PREFS_FILE = process.env.BETTER_VIEW_PREFS || join(homedir(), '.cache', 'better-view', 'prefs.json');
export const LANGS = ['zh', 'en'];

const norm = (s) => (/^zh/i.test(String(s || '')) ? 'zh' : 'en');

let system = null;
/** The system's first preferred language, which is what Antigravity shows. Read once per process. */
export function systemLang() {
  if (system) return system;
  let first = '';
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000 });
      first = out.match(/"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)"?/)?.[1] || '';
    } catch { /* not readable: fall through */ }
  }
  system = norm(first || process.env.LC_ALL || process.env.LANG || 'en');
  return system;
}

let cache = { mtimeMs: -1, prefs: {} };
export function readPrefs(file = PREFS_FILE) {
  let st;
  try { st = statSync(file); } catch { return {}; }
  if (st.mtimeMs !== cache.mtimeMs) {
    try { cache = { mtimeMs: st.mtimeMs, prefs: JSON.parse(readFileSync(file, 'utf8')) || {} }; } catch { cache = { mtimeMs: st.mtimeMs, prefs: {} }; }
  }
  return cache.prefs;
}

/** 'zh' | 'en': env override, then the saved choice, then the system (= Antigravity) language. */
export function currentLang() {
  if (process.env.BETTER_VIEW_LANG) return norm(process.env.BETTER_VIEW_LANG);
  const p = readPrefs().lang;
  return LANGS.includes(p) ? p : systemLang();
}

/** Save the panel's choice; 'auto' (or anything unknown) goes back to following Antigravity. */
export function setLang(lang, file = PREFS_FILE) {
  const prefs = { ...readPrefs(file) };
  if (LANGS.includes(lang)) prefs.lang = lang; else delete prefs.lang;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(prefs, null, 2));
  return currentLang();
}

/** Pick the string for the current language. */
export const tr = (zh, en) => (currentLang() === 'en' ? en : zh);

/** Durations in prose ("3 分 4 秒" / "3m 4s"). */
export function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const en = currentLang() === 'en';
  if (s < 60) return en ? `${s}s` : `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return en ? `${m}m ${s % 60}s` : `${m} 分 ${s % 60} 秒`;
  return en ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
