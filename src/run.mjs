// Run a plan: each task goes to a FRESH agent process (fresh context) in a
// dedicated worktree, is accepted only when its own exit check passes, then is
// reviewed by an independent agent before the next task starts.
//
// Plan format (what bee-plan writes):
//   T2 — Add the parser
//     Depends on: T1
//     Files: src/parse.mjs, test/parse.test.mjs
//     Test first: …
//     Exit check: `node --test test/parse.test.mjs`
//
// The exit check is the first `backticked` command on the "Exit check:" line, or
// the whole value if there are no backticks. Done is decided by that command's
// exit code, never by the agent's own report.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { STATE_DIR } from './config.mjs';
import { argv } from './evals.mjs';
import { git } from './git.mjs';

export function parsePlan(text) {
  const tasks = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^\s*(?:[-*]\s*)?\**(T\d+)\**\s*[—–:-]+\s*(.+?)\s*$/);
    if (h) { cur = { id: h[1], title: h[2].replace(/\*+$/, '').trim(), deps: [], files: [], body: [line] }; tasks.push(cur); continue; }
    if (!cur) continue;
    cur.body.push(line);
    const kv = line.match(/^\s+([A-Za-z ]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    if (key === 'depends on') cur.deps = val.match(/T\d+/g) ?? [];
    else if (key === 'files') cur.files = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'exit check') cur.check = val.match(/`([^`]+)`/)?.[1] ?? val;
  }
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    t.body = t.body.join('\n').trimEnd();
    for (const d of t.deps) if (!ids.has(d)) throw new Error(`${t.id} depends on unknown task ${d}`);
    if (!t.check) throw new Error(`${t.id} has no "Exit check:"; every task needs one`);
  }
  return tasks;
}

// Dependency order (stable: plan order breaks ties). Throws on a cycle.
export function order(tasks) {
  const out = [], state = new Map();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (t, path) => {
    if (state.get(t.id) === 'done') return;
    if (state.get(t.id) === 'busy') throw new Error(`dependency cycle: ${[...path, t.id].join(' → ')}`);
    state.set(t.id, 'busy');
    for (const d of t.deps) visit(byId.get(d), [...path, t.id]);
    state.set(t.id, 'done');
    out.push(t);
  };
  for (const t of tasks) visit(t, []);
  return out;
}

const sh = (cmd, cwd, timeoutSec) => {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
};

function agentRun(command, prompt, cwd, timeoutSec) {
  const [cmd, ...args] = argv(command, { prompt, workdir: cwd });
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim(), error: r.error?.message };
}

export function implementPrompt(task, spec, failure) {
  return [
    'You are implementing ONE task of a larger plan. Change only what this task needs.',
    spec ? `\n## Spec\n${spec}` : '',
    `\n## Your task\n${task.body}`,
    `\n## Done means\nThis command exits 0, run from the repository root:\n    ${task.check}`,
    'Do not commit. Do not edit the exit check or any test to make it pass; fix the code.',
    failure ? `\n## Your previous attempt failed the exit check\n${failure.slice(-2000)}` : '',
  ].join('\n');
}

export function reviewPrompt(task, spec, diff) {
  return [
    'You are an independent reviewer. You did not write this change.',
    spec ? `\n## Spec\n${spec}` : '',
    `\n## Task\n${task.body}`,
    `\n## Diff\n${diff.slice(0, 60000)}`,
    '\nReview only for defects that matter: wrong behaviour, missing acceptance criteria, security, data loss, a test that cannot fail.',
    'End with exactly one line: "VERDICT: GO" or "VERDICT: NO-GO — <reason>".',
  ].join('\n');
}

export function runPlan(root, cfg, planFile, opts = {}) {
  const log = opts.log ?? (() => {});
  const runCfg = { agent: ['claude', '-p', '--permission-mode', 'acceptEdits', '{prompt}'], reviewer: ['claude', '-p', '{prompt}'], maxAttempts: 2, timeoutSec: 1800, ...(cfg.run ?? {}) };
  const tasks = order(parsePlan(readFileSync(resolve(root, planFile), 'utf8')));
  const spec = opts.spec ? readFileSync(resolve(root, opts.spec), 'utf8') : null;
  const name = basename(planFile).replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const branch = opts.branch ?? `hyve/run-${name}`;
  const dir = resolve(root, opts.dir ?? join('..', `${basename(root)}-hyve-run-${name}`));
  const base = opts.base ?? 'HEAD';
  const only = opts.only ? new Set(opts.only) : null;

  if (!existsSync(dir)) {
    const exists = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0;
    const add = exists ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, base];
    const r = git(root, add);
    if (r.status !== 0) throw new Error(`git ${add.join(' ')}: ${r.err}`);
  }
  const done = new Set(git(dir, ['log', '--format=%s']).out.split('\n').map((s) => s.match(/^(T\d+):/)?.[1]).filter(Boolean));
  const report = { plan: planFile, branch, dir, startedAt: new Date().toISOString(), tasks: [] };

  for (const task of tasks) {
    if (only && !only.has(task.id)) continue;
    if (done.has(task.id)) { report.tasks.push({ id: task.id, status: 'already-done' }); log(`${task.id} already committed on ${branch}; skipping`); continue; }
    const blocked = task.deps.find((d) => !done.has(d));
    if (blocked) { report.tasks.push({ id: task.id, status: 'blocked', on: blocked }); log(`${task.id} blocked on ${blocked}`); break; }

    const entry = { id: task.id, title: task.title, check: task.check, attempts: [] };
    report.tasks.push(entry);
    let failure = null;
    for (let a = 1; a <= runCfg.maxAttempts; a++) {
      log(`${task.id} — ${task.title} · attempt ${a}/${runCfg.maxAttempts}`);
      const agent = agentRun(runCfg.agent, implementPrompt(task, spec, failure), dir, runCfg.timeoutSec);
      const check = sh(task.check, dir, runCfg.timeoutSec);
      entry.attempts.push({ agentExit: agent.code, ...(agent.error ? { agentError: agent.error } : {}), checkExit: check.code });
      if (check.code === 0) break;
      // Always non-empty: a check that fails silently (grep -q, test -f) still tells
      // the next attempt THAT it failed and with which command.
      failure = `\`${task.check}\` exited ${check.code}${check.out ? `:\n${check.out}` : ' with no output'}`;
      git(dir, ['checkout', '-q', '--', '.']); // a failed attempt leaves nothing behind
      git(dir, ['clean', '-q', '-fd']);
    }
    if (entry.attempts.at(-1).checkExit !== 0) {
      entry.status = 'failed-check';
      log(`${task.id} FAILED its exit check after ${runCfg.maxAttempts} attempt(s): ${task.check}`);
      break;
    }
    git(dir, ['add', '-A']);
    const diff = git(dir, ['diff', '--cached']).out;
    if (!diff) {
      entry.status = 'no-change';
      log(`${task.id}: exit check passes with no change; nothing to commit (was it already done, or is the check vacuous?)`);
      done.add(task.id);
      continue;
    }
    if (opts.review !== false) {
      const rev = agentRun(runCfg.reviewer, reviewPrompt(task, spec, diff), dir, runCfg.timeoutSec);
      const verdict = rev.out.match(/VERDICT:\s*(GO|NO-GO)\b(.*)$/m);
      entry.review = verdict ? `${verdict[1]}${verdict[2]}`.trim() : 'no verdict';
      if (!verdict || verdict[1] !== 'GO') {
        entry.status = 'review-blocked';
        writeFileSync(join(dir, `.hyve-review-${task.id}.txt`), rev.out);
        git(dir, ['reset', '-q']);
        log(`${task.id} review: ${entry.review}. Changes left uncommitted in ${dir} for you.`);
        break;
      }
    }
    const c = git(dir, ['commit', '-q', '-m', `${task.id}: ${task.title}`, '-m', `Exit check: ${task.check}\nReview: ${entry.review ?? 'skipped'}`]);
    if (c.status !== 0) throw new Error(`commit failed: ${c.err}`);
    entry.status = 'done';
    done.add(task.id);
    log(`${task.id} done${entry.review ? ` · review ${entry.review}` : ''}`);
  }
  report.finishedAt = new Date().toISOString();
  const out = join(root, STATE_DIR, 'runs');
  mkdirSync(out, { recursive: true });
  const file = join(out, `run-${name}-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return { report, file };
}
