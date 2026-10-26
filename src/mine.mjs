// Mine Claude Code transcripts for how skills are actually used and chained.
// Port of openwop-app's skill-miner/mine.sh to dependency-free Node.
//
// Detection, per JSONL line (file order is chronological):
//   - a user slash command: exactly one <command-name>/foo</command-name> on the line
//     (lines listing several are compaction summaries and are skipped)
//   - an agent Skill tool call: "name":"Skill","input":{"skill":"foo"
// Chains split on reset skills, so polling and message-bus noise doesn't fuse unrelated work.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const DEFAULT_RESET = ['clear', 'crosstalk', 'loop', 'model', 'compact'];

// Renamed skills count as one. hyvemind's own renames are built in; a project adds
// its own with mine.aliases (old name → current name).
export const BUILTIN_ALIASES = {
  'bee-ship': 'ship-change', 'bee-spec': 'write-spec', 'bee-plan': 'plan-tasks', 'bee-review': 'review-change',
  'bee-pr': 'open-pr', 'bee-evidence': 'evidence-rules', 'bee-skill-miner': 'mine-skills', 'bee-live-qualify': 'live-ai-check',
  'bee-design-review': 'design-review', 'bee-test-necessity': 'test-necessity', 'bee-parallel-work': 'parallel-work',
  'bee-skill-eval': 'skill-eval', 'bee-ai-exchange': 'ai-exchange',
};

export function canon(name, prefix = '', aliases = {}) {
  let s = name.replace(/^\//, '').replace(/:.*$/, '');
  s = aliases[s] ?? BUILTIN_ALIASES[s] ?? s;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return s;
}

export function extract(line) {
  const out = [];
  const cmds = [...line.matchAll(/<command-name>\/?([^<\s]+)[^<]*<\/command-name>/g)];
  if (cmds.length === 1) out.push({ source: 'user', skill: cmds[0][1] });
  for (const m of line.matchAll(/"name":"Skill","input":\{"skill":"([^"]+)"/g)) out.push({ source: 'agent', skill: m[1] });
  return out;
}

function* jsonlFiles(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* jsonlFiles(p);
    else if (e.endsWith('.jsonl')) yield { path: p, mtime: st.mtimeMs };
  }
}

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const ranked = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export function mine({ root = join(homedir(), '.claude/projects'), filter = '', prefix = '', reset = DEFAULT_RESET, top = 20, aliases = {} } = {}) {
  const freq = new Map(), bigrams = new Map(), trigrams = new Map(), outgoing = new Map();
  const sessions = [];
  let invocations = 0;
  for (const f of jsonlFiles(root)) {
    const project = basename(join(f.path, '..'));
    if (filter && !project.includes(filter)) continue;
    const seq = [];
    for (const line of readFileSync(f.path, 'utf8').split('\n')) {
      for (const inv of extract(line)) { seq.push(canon(inv.skill, prefix, aliases)); invocations++; }
    }
    if (!seq.length) continue;
    sessions.push({ project, session: basename(f.path, '.jsonl'), mtime: f.mtime, seq });
    let p1 = null, p2 = null;
    for (const s of seq) {
      bump(freq, s);
      if (reset.includes(s)) { p1 = p2 = null; continue; }
      if (p2 && p2 !== s) { bump(bigrams, `${p2} -> ${s}`); bump(outgoing, p2); }
      if (p1 && p2 && p2 !== s && p1 !== p2) bump(trigrams, `${p1} -> ${p2} -> ${s}`);
      p1 = p2; p2 = s;
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  // Confidence of A -> B: of the times A was followed by another skill, how often that
  // skill was B. Runs of A that ended a session or hit a reset followed by nothing, so
  // they don't count against B.
  const confidence = ranked(bigrams, top).map(([k, n]) => {
    const a = k.split(' -> ')[0];
    return { chain: k, count: n, confidence: +(n / (outgoing.get(a) ?? n)).toFixed(2) };
  });
  return {
    root, filter: filter || null, sessions: sessions.length, invocations,
    top: ranked(freq, top), bigrams: confidence, trigrams: ranked(trigrams, top),
    recent: sessions.slice(0, 10).map((s) => ({ project: s.project, seq: s.seq.join(' > ') })),
  };
}
