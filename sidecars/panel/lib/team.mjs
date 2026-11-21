// Teamwork topology: which conversation spawned which, and how to show them as one team.
// Facts (sampled 2026-11-17, ls 2.29.0):
//  - the user's conversation calls invoke_subagent {Role, TypeName:"teamwork"} → a Coordinator, which spawns an
//    interviewer, a Project Orchestrator and finally a victory auditor; the orchestrator spawns explorers, workers,
//    a test writer, reviewers, challengers and an auditor
//  - every spawned conversation starts with a SYSTEM_MESSAGE "sender=<parent id>"; the parent's invoke_subagent
//    result names the child ("Created the following subagent: {conversationId}") and its Role/TypeName
//  - agents keep a checklist in .agents/teamwork/<name>/progress.md; the orchestrator's is the team's master list

import { tr } from './i18n.mjs';

// Four families, in fixed display order. Colors are assigned by family in the UI, never by rank.
export const FAMILIES = [
  { key: 'lead', label: '协调' },
  { key: 'explore', label: '调研' },
  { key: 'build', label: '实现' },
  { key: 'review', label: '审查' },
];

export function familyOf(type, name) {
  const s = `${type ?? ''} ${name ?? ''}`.toLowerCase();
  if (/explorer/.test(s)) return 'explore';
  if (/worker|test_writer/.test(s)) return 'build';
  if (/review|challeng|audit/.test(s)) return 'review';
  if (/orchestrator|interviewer|sentinel|teamwork|coordinator/.test(s)) return 'lead';
  return 'build';
}

/** worker_m1 → Worker M1, teamwork_explorer_survey_1 → Explorer Survey 1. */
export const prettyName = (s) => String(s ?? '').replace(/^teamwork_/, '').replace(/_/g, ' ').replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** A card-sized name: the role when it is short ("M2 UI Worker"), else the agent's own name ("Reviewer 1"). */
export function shortName(role, agentName) {
  if (role && role.length <= 20) return role;
  if (agentName) return prettyName(agentName);
  return role || '';
}

/**
 * runs: [{id, parentId, children: [[childId, {role, type}]], agentName, title, ...}]
 * Returns Map id -> {rootId, parentId, depth, role, type, family, name} for every run, and the team groups.
 */
export function buildTeams(runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const meta = new Map(); // child id -> {parentId, role, type} as declared by the parent
  for (const r of runs) for (const [cid, m] of r.children || []) meta.set(cid, { parentId: r.id, ...m });

  const parentOf = (id) => byId.get(id)?.parentId || meta.get(id)?.parentId || null;
  const rootOf = (id) => {
    let cur = id;
    for (let i = 0; i < 20; i++) {
      const p = parentOf(cur);
      if (!p || !byId.has(p)) return cur;
      cur = p;
    }
    return cur;
  };

  const info = new Map();
  for (const r of runs) {
    const m = meta.get(r.id) || {};
    let depth = 0;
    for (let cur = r.id; parentOf(cur) && byId.has(parentOf(cur)) && depth < 20; cur = parentOf(cur)) depth++;
    const parentId = parentOf(r.id);
    info.set(r.id, {
      rootId: rootOf(r.id),
      parentId: parentId && byId.has(parentId) ? parentId : null,
      depth,
      role: m.role || null,
      type: m.type || null,
      family: depth === 0 ? 'lead' : familyOf(m.type, r.agentName),
      name: depth === 0 ? tr('你的会话', 'Your conversation') : shortName(m.role, r.agentName) || r.title,
    });
  }

  const groups = new Map();
  for (const r of runs) {
    const root = info.get(r.id).rootId;
    if (!groups.has(root)) groups.set(root, { rootId: root, memberIds: [] });
    groups.get(root).memberIds.push(r.id);
  }
  // breadth-first member order: root, its children, grandchildren... (spawn order within a level)
  for (const g of groups.values()) {
    const start = (id) => byId.get(id)?.firstAt || 0;
    g.memberIds.sort((a, b) => info.get(a).depth - info.get(b).depth || start(a) - start(b));
    g.isTeam = g.memberIds.length > 1;
  }
  return { info, groups: [...groups.values()] };
}
