import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { git } from '../src/git.mjs';
import { runPlan } from '../src/run.mjs';
import { containerArgv, sandboxConfig } from '../src/sandbox.mjs';
import { repo } from './helpers.mjs';

// A fake container runtime: logs its argv, then runs the `sh -c` command in the host
// directory mounted at /work, with an EMPTY environment except the -e pairs it was given.
function fakeRuntime(dir) {
  const bin = join(dir, 'fake-runtime');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'), { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'runtime.log'))}, JSON.stringify(a) + '\\n');
const host = a[a.indexOf('-v') + 1].split(':')[0];
const env = { PATH: process.env.PATH };
a.forEach((x, i) => { if (x === '-e') { const [k, ...v] = a[i + 1].split('='); env[k] = v.join('='); } });
const cmd = a[a.length - 1];
const r = spawnSync('sh', ['-c', cmd], { cwd: host, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('containerArgv: no network, mounted worktree, dropped caps, only allowlisted env', () => {
  process.env.HYVE_TEST_SECRET = 'do-not-leak';
  process.env.LANG = 'en_US.UTF-8';
  const sb = sandboxConfig(resolveConfig({ version: 1, run: { sandbox: { runtime: 'podman', env: ['LANG'] } } }));
  const a = containerArgv(sb, '/tmp/wt', 'npm test');
  assert.deepEqual(a.slice(0, 5), ['podman', 'run', '--rm', '--network', 'none']);
  assert.ok(a.includes('--cap-drop') && a.includes('no-new-privileges'));
  assert.ok(a.includes('/tmp/wt:/work'));
  assert.ok(a.includes('LANG=en_US.UTF-8'));
  assert.ok(!a.join(' ').includes('do-not-leak'), 'an env var not on the allowlist never reaches the container');
  assert.deepEqual(a.slice(-3), ['sh', '-c', 'npm test']);
  assert.equal(containerArgv(sb, '/tmp/wt', 'npm ci', { network: true })[4], 'bridge');
  assert.equal(sandboxConfig(resolveConfig({ version: 1 })), null, 'off unless configured or requested');
  assert.equal(sandboxConfig(resolveConfig({ version: 1 }), 'docker').runtime, 'docker', '--sandbox docker turns it on');
});

const PLAN = 'T1 — Create the greeting\n  Files: greet.txt\n  Exit check: `grep -q hello greet.txt && test -z "$HYVE_TEST_SECRET"`\n';
const IMPLEMENT = "const p=process.argv[1];const f=p.match(/Files: (\\S+)/)[1];require('fs').writeFileSync(f,'hello\\n')";
const GO = "console.log('VERDICT: GO')";

test('sandboxed run: the exit check runs in the container (no network, no leaked env), after setup with network', () => {
  const root = repo({ '.gitignore': '.hyve/\nfake-runtime\nruntime.log\n', 'plan.md': PLAN });
  process.env.HYVE_TEST_SECRET = 'do-not-leak';
  const cfg = resolveConfig({ version: 1, run: {
    agent: ['node', '-e', IMPLEMENT, '{prompt}'], reviewer: ['node', '-e', GO, '{prompt}'],
    sandbox: { runtime: fakeRuntime(root), setup: 'echo setup-ran > .setup-marker', env: [] },
  } });
  const dir = join(root, '..', `${Date.now()}-wt`);
  const { report } = runPlan(root, cfg, 'plan.md', { dir });
  assert.equal(report.tasks[0].status, 'done', JSON.stringify(report.tasks[0]));
  const calls = readFileSync(join(root, 'runtime.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2, 'setup, then the check');
  assert.equal(calls[0][calls[0].indexOf('--network') + 1], 'bridge', 'setup may use the network');
  assert.equal(calls[1][calls[1].indexOf('--network') + 1], 'none', 'the check may not');
  assert.match(calls[1].at(-1), /grep -q hello greet\.txt/);
  assert.equal(report.sandbox.checkNetwork, 'none');
  assert.equal(git(dir, ['log', '--format=%s', '-1']).out, 'T1: Create the greeting');
});

test('without a sandbox, the same check sees the host environment (which is why the sandbox exists)', () => {
  const root = repo({ '.gitignore': '.hyve/\n', 'plan.md': PLAN });
  process.env.HYVE_TEST_SECRET = 'do-not-leak';
  const cfg = resolveConfig({ version: 1, run: { agent: ['node', '-e', IMPLEMENT, '{prompt}'], reviewer: ['node', '-e', GO, '{prompt}'], maxAttempts: 1 } });
  const { report } = runPlan(root, cfg, 'plan.md', { dir: join(root, '..', `${Date.now()}-wt2`) });
  assert.equal(report.tasks[0].status, 'failed-check', 'the host secret is visible, so the check fails');
  delete process.env.HYVE_TEST_SECRET;
});

test('sandboxed roles default to read/edit tools: no shell for the agent', async () => {
  const { SANDBOXED_ROLES } = await import('../src/sandbox.mjs');
  const tools = (argv) => argv[argv.indexOf('--allowedTools') + 1].split(',');
  assert.ok(!tools(SANDBOXED_ROLES.implementer).some((t) => /^Bash/.test(t)));
  assert.deepEqual(tools(SANDBOXED_ROLES.reviewer), ['Read', 'Grep', 'Glob']);
});
