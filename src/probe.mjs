// Sabotage probes: prove a test CAN fail by breaking the code it claims to guard.
//
// Probes file (JSON array):
//   { "id": "short-id",
//     "src": "<path from project root>",
//     "old": "<exact text; must occur exactly once in src>",
//     "new": "<replacement>",
//     "test": "<what to substitute for {test} in probe.command>",
//     "lane": "<key of probe.lanes; default 'default'>",       // optional
//     "expectRed": ["<substring of a FAILING case's name>"],      // optional; needs probe.format
//     "expectOutput": ["<substring the failing run must print>"], // optional
//     "env": { "NAME": "value" } }                              // optional
//
// Verdicts: witnessed (went red as expected) · vacuous (stayed green: the test cannot
// fail under this break) · other-red (red, but not with the expected output) ·
// error (could not apply, run timed out, or matched a probe.errorPatterns entry —
// red for the wrong reason is not a witness).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, isClean } from './git.mjs';
import { leaseShell } from './broker.mjs';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A child test runner that sees a parent's NODE_TEST_CONTEXT reports to that parent
// instead of through its exit code, so every break would look vacuous.
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Case-level results, so a witness is a FAILING case, not a name that appears
// somewhere in the output (a passing case's name would otherwise count).
//   vitest: --reporter=json --outputFile=<file>  → assertionResults[].status === 'failed'
//   node:   --test-reporter=tap                  → "not ok N - <title>" lines
//   output: no structure; expectRed is not available, only expectOutput
export function formatArgs(format, reportFile) {
  if (format === 'vitest') return ` --reporter=json --outputFile=${shq(reportFile)}`;
  if (format === 'node') return ' --test-reporter=tap';
  return '';
}

export function failingCases(format, { output, reportFile }) {
  if (format === 'vitest') {
    let r;
    try { r = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { return null; }
    return r.testResults.flatMap((t) => [
      ...t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName ?? a.title),
      ...(t.status === 'failed' && t.assertionResults.length === 0 ? [`(suite) ${t.name}`] : []),
    ]);
  }
  if (format === 'node') {
    const fails = [...output.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map((m) => m[1]);
    // A top-level file entry fails when any of its cases fails; keep only case lines when there are any.
    return fails;
  }
  return null;
}

export function verdictFor({ exitCode, timedOut, output, failing = null }, probe, cfg) {
  if (timedOut) return 'error';
  if (exitCode === 0) return 'vacuous';
  if (cfg.probe.errorPatterns.some((p) => new RegExp(p).test(output))) return 'error';
  if (probe.expectRed?.length) {
    if (!failing) return 'error'; // asked for case-level proof the runner did not give
    if (!probe.expectRed.every((s) => failing.some((f) => f.includes(s)))) return 'other-red';
  }
  if (probe.expectOutput?.length && !probe.expectOutput.every((s) => output.includes(s))) return 'other-red';
  return 'witnessed';
}

function restore(root, src, abs, text) {
  writeFileSync(abs, text);
  if (!isClean(root, src)) git(root, ['checkout', '--', src]);
  if (!isClean(root, src)) {
    throw Object.assign(new Error(`could not restore ${src}; fix it by hand before running more probes`), { fatal: true });
  }
}

export function runProbe(root, cfg, p) {
  const lane = p.lane ?? 'default';
  if (!(lane in cfg.probe.lanes)) return { id: p.id, verdict: 'error', error: `unknown lane ${lane}` };
  if (!isClean(root, p.src)) return { id: p.id, verdict: 'error', error: 'src has uncommitted changes; commit or stash them in your own worktree first' };
  const abs = join(root, p.src);
  const text = readFileSync(abs, 'utf8');
  const n = text.split(p.old).length - 1;
  if (n !== 1) return { id: p.id, verdict: 'error', error: `old text matched ${n} times (must be exactly 1)` };
  const format = cfg.probe.format ?? 'output';
  const reportFile = join(mkdtempSync(join(tmpdir(), 'hyve-probe-')), 'report.json');
  const cmd = leaseShell(cfg, 'probe', p.id, cfg.probe.command.replaceAll('{test}', shq(p.test)) + formatArgs(format, reportFile));
  try {
    writeFileSync(abs, text.replace(p.old, () => p.new));
    const r = spawnSync(cmd, {
      cwd: join(root, cfg.probe.lanes[lane]),
      shell: true,
      encoding: 'utf8',
      env: cleanEnv({ ...(p.env ?? {}), CI: '1' }),
      timeout: cfg.probe.timeoutSec * 1000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL';
    const failing = failingCases(format, { output, reportFile });
    const verdict = verdictFor({ exitCode: r.status, timedOut, output, failing }, p, cfg);
    return { id: p.id, verdict, exitCode: r.status, ...(failing ? { failing: failing.slice(0, 20) } : {}), ...(timedOut ? { error: 'timed out' } : {}), ...(verdict === 'error' && p.expectRed?.length && !failing ? { error: `expectRed needs probe.format vitest or node (got ${format})` } : {}), tail: output.trim().slice(-600) };
  } finally {
    restore(root, p.src, abs, text);
  }
}

// A probe edits files in the working tree. Two probes in one tree, or a pull or
// checkout during one, could capture a sabotaged file. A per-worktree lock refuses a
// second probe; a lock whose process is gone is reclaimed.
export function probeLockPath(root) {
  const p = git(root, ['rev-parse', '--git-path', 'hyve-probe.lock']).out;
  return p.startsWith('/') ? p : join(root, p);
}

export function acquireProbeLock(root) {
  const lock = probeLockPath(root);
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
    if (alive && pid !== process.pid) throw new Error(`another probe (pid ${pid}) is running in this worktree; wait for it, or use --isolate`);
  }
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

// --isolate: probe a throwaway worktree of HEAD instead of the live one, after the
// project's setup (train.setup, e.g. "npm ci"). The live tree is never touched.
export function isolatedTree(root, cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'hyve-probe-wt-'));
  const add = git(root, ['worktree', 'add', '-q', '--detach', dir, 'HEAD']);
  if (add.status !== 0) throw new Error(`git worktree add failed: ${add.err}`);
  const setup = cfg.probe.setup ?? cfg.train?.setup;
  if (setup) {
    const s = spawnSync(setup, { cwd: dir, shell: true, encoding: 'utf8', env: cleanEnv() });
    if (s.status !== 0) { git(root, ['worktree', 'remove', '--force', dir]); throw new Error(`probe setup failed: ${setup}`); }
  }
  return { dir, dispose: () => git(root, ['worktree', 'remove', '--force', dir]) };
}

export function runProbes(root, cfg, probes, { isolate = false } = {}) {
  const tree = isolate ? isolatedTree(root, cfg) : null;
  const where = tree ? tree.dir : root;
  const release = acquireProbeLock(where);
  try {
    const results = [];
    for (const p of probes) results.push(runProbe(where, cfg, p));
    const dirty = git(where, ['status', '--porcelain', '--', ...new Set(probes.map((p) => p.src))]).out;
    return { results, srcStatus: dirty || 'clean', ...(tree ? { isolated: tree.dir } : {}) };
  } finally {
    release();
    tree?.dispose();
  }
}
