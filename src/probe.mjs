// Sabotage probes: prove a test CAN fail by breaking the code it claims to guard.
//
// Probes file (JSON array):
//   { "id": "short-id",
//     "src": "<path from project root>",
//     "old": "<exact text; must occur exactly once in src>",
//     "new": "<replacement>",
//     "test": "<what to substitute for {test} in probe.command>",
//     "lane": "<key of probe.lanes; default 'default'>",       // optional
//     "expectOutput": ["<substring the failing run must print>"], // optional
//     "env": { "NAME": "value" } }                              // optional
//
// Verdicts: witnessed (went red as expected) · vacuous (stayed green: the test cannot
// fail under this break) · other-red (red, but not with the expected output) ·
// error (could not apply, run timed out, or matched a probe.errorPatterns entry —
// red for the wrong reason is not a witness).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

export function verdictFor({ exitCode, timedOut, output }, probe, cfg) {
  if (timedOut) return 'error';
  if (exitCode === 0) return 'vacuous';
  if (cfg.probe.errorPatterns.some((p) => new RegExp(p).test(output))) return 'error';
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
  const cmd = leaseShell(cfg, 'probe', p.id, cfg.probe.command.replaceAll('{test}', shq(p.test)));
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
    const verdict = verdictFor({ exitCode: r.status, timedOut, output }, p, cfg);
    return { id: p.id, verdict, exitCode: r.status, ...(timedOut ? { error: 'timed out' } : {}), tail: output.trim().slice(-600) };
  } finally {
    restore(root, p.src, abs, text);
  }
}

export function runProbes(root, cfg, probes) {
  const results = [];
  for (const p of probes) results.push(runProbe(root, cfg, p));
  const dirty = git(root, ['status', '--porcelain', '--', ...new Set(probes.map((p) => p.src))]).out;
  return { results, srcStatus: dirty || 'clean' };
}
