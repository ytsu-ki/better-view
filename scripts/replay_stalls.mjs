// Replays real transcripts and asks the stall detector, one second before each row arrived,
// what it would have said. Prints every non-OK verdict, plus false-alarm counts.
// Usage: node scripts/replay_stalls.mjs [--ls running|unknown] [--all]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRun, applyRow, turnOpen } from '../sidecars/panel/lib/reducer.mjs';
import { assess, calibrate } from '../sidecars/panel/lib/stall.mjs';
import { AG_DIR } from '../sidecars/panel/lib/hub.mjs';

const lsMode = process.argv.includes('--ls') ? process.argv[process.argv.indexOf('--ls') + 1] : 'running';
const showAll = process.argv.includes('--all');
const brain = join(AG_DIR, 'brain');
const ids = readdirSync(brain).filter((d) => /^[0-9a-f-]{36}$/.test(d));
const load = (id) => { try { return readFileSync(join(brain, id, '.system_generated/logs/transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// thresholds from full history, as the live store would have them
const full = ids.map((id) => { const r = createRun(id); for (const row of load(id)) applyRow(r, row); return r; });
const th = calibrate(full);
// subagent lifetimes, so a parent waiting on running children is replayed as such
const life = full.map((r) => ({ id: r.id, parentId: r.parentId, from: r.firstAt, to: r.lastRowAt }));
const activeChildrenAt = (pid, t) => life.filter((c) => c.parentId === pid && c.from <= t && t < c.to).length;

// When did row i land on disk? GENERIC: its Completed At. PLANNER_RESPONSE: when the next step started
// (the model call ends right before its tools run). Everything else: created_at.
const field = (row, name) => { const m = typeof row.content === 'string' && row.content.match(new RegExp(`^${name}: (\\S+)`, 'm')); return m ? Date.parse(m[1]) : NaN; };
const startOf = (row) => (row.type === 'GENERIC' && !Number.isNaN(field(row, 'Created At')) ? field(row, 'Created At') : Date.parse(row.created_at));
function landed(rows, i) {
  const r = rows[i];
  if (r.type === 'GENERIC' && !Number.isNaN(field(r, 'Completed At'))) return field(r, 'Completed At');
  // a model call that ran tools ended when its first tool started; a final reply's end isn't recorded
  // (the next row may be a wake-up minutes later), so take its start
  if (r.type === 'PLANNER_RESPONSE' && rows[i + 1]?.type === 'GENERIC') return Math.max(Date.parse(r.created_at), startOf(rows[i + 1]));
  return Date.parse(r.created_at);
}

const counts = {};
for (const id of ids) {
  const rows = load(id);
  const run = createRun(id);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    applyRow(run, r, landed(rows, i));
    const next = rows[i + 1];
    if (!next) continue;
    const at = landed(rows, i + 1) - 1000; // the last moment before the next row lands
    if (!turnOpen(run)) continue; // agent idle, waiting for the user: never a stall
    const lsStatus = lsMode === 'running' ? 'CASCADE_RUN_STATUS_RUNNING' : undefined;
    const v = assess(run, { now: at, lsStatus, thresholds: th, activeChildren: activeChildrenAt(id, at) });
    counts[v.level] = (counts[v.level] || 0) + 1;
    const userNext = next.type === 'USER_INPUT';
    if (v.level !== 'OK' || (showAll && userNext)) {
      console.log(`${id.slice(0, 8)} #${r.step_index}→#${next.step_index} ${next.type}${userNext ? '(用户插话)' : ''}  ${v.level}  ${v.title}`);
      for (const e of v.evidence) console.log(`     · ${e}`);
    }
  }
}
console.log('\nverdicts over open-turn gaps:', counts, ` (ls=${lsMode})`);
