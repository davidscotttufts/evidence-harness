import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, sh } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/hyvemind.mjs', import.meta.url));
const run = (cwd, ...args) => spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8' });

test('init → doctor → gate → evidence, end to end in a node project', () => {
  const dir = repo({ 'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }) });

  const dry = run(dir, 'init', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /detected preset "node"/);
  assert.ok(!existsSync(join(dir, 'hyvemind.json')), 'dry run writes nothing');

  const init = run(dir, 'init');
  assert.equal(init.status, 0, init.stderr);
  const cfg = JSON.parse(readFileSync(join(dir, 'hyvemind.json'), 'utf8'));
  assert.deepEqual(cfg.gates, [{ name: 'test', run: 'npm run test' }]);
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /hyvemind:begin/);

  const doc = run(dir, 'doctor');
  assert.equal(doc.status, 0, doc.stdout);
  assert.match(doc.stdout, /✓ skills current/);

  assert.equal(run(dir, 'evidence').status, 1, 'no evidence before a gate');
  const gate = run(dir, 'gate', '--quiet');
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /verdict: GREEN/);
  assert.equal(run(dir, 'evidence').status, 0);
});

test('list, help and unknown commands', () => {
  const dir = repo();
  assert.match(run(dir, 'list').stdout, /test-necessity/);
  assert.match(run(dir, '--help').stdout, /Usage: hyvemind/);
  assert.equal(run(dir, 'bogus').status, 1);
  assert.match(run(dir, 'gate').stderr, /run "hyvemind init" first/);
});

test('v0.2 commands: affected --json, evidence --post refusal, eval --render, train usage', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node -e 0' } }),
    'src/a.mjs': 'export const a = 1;\n',
    'src/a.test.mjs': "import { a } from './a.mjs';\n",
  });
  assert.equal(run(dir, 'init').status, 0);
  assert.equal(JSON.parse(run(dir, 'affected', '--json').stdout).all, true, 'uncommitted config change: run everything');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-qm', 'hyvemind']);
  writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 2;\n');
  const aff = JSON.parse(run(dir, 'affected', '--json').stdout);
  assert.deepEqual(aff.tests, ['src/a.test.mjs']);

  const post = run(dir, 'evidence', '--post', '--dry-run');
  assert.equal(post.status, 1);
  assert.match(post.stdout, /not posted: .*uncommitted/);

  const report = { agent: 'claude', version: '0', startedAt: 'now', skills: [{ skill: 'pr', scenarios: 1, trials: 3, bare: 0, withSkill: 1, lift: 1, verdict: 'earning', runs: [] }] };
  writeFileSync(join(dir, 'r.json'), JSON.stringify(report));
  assert.match(run(dir, 'eval', '--render', 'r.json').stdout, /\| pr \| 1 \| 3 \| 0% \| 100% \| \+1 \| \*\*earning\*\* \|/);

  assert.match(run(dir, 'train').stderr, /usage: hyvemind train/);
  assert.match(run(dir, 'run').stderr, /usage: hyvemind run/);
});

test('doctor warns when an external gate is paired with skills that add a second done/merge path', () => {
  const dir = repo();
  writeFileSync(join(dir, 'hyvemind.json'), JSON.stringify({ version: 1, externalGate: { run: 'make verify', done: 'make verify passes' }, skills: { include: ['write-spec', 'open-pr'] } }));
  assert.equal(run(dir, 'update').status, 0);
  const out = run(dir, 'doctor').stdout;
  assert.match(out, /✓ gate — external: make verify/);
  assert.match(out, /! competing skills — open-pr use hyvemind gate\/evidence\/train/);
});

test('mine reads transcripts only with consent', () => {
  const dir = repo();
  const r = run(dir, 'mine', '--root', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Re-run with --yes to consent/);
  const ok = run(dir, 'mine', '--root', dir, '--yes', '--json');
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).sessions, 0);
});

test('affected --observe: a failure outside the selection is a MISS and resets trust', () => {
  const dir = repo({
    '.gitignore': '.hyve/\n',
    'src/a.mjs': 'export const a = 1;\n', 'src/a.test.mjs': "import { a } from './a.mjs';\n",
    'src/b.mjs': 'export const b = 1;\n', 'src/b.test.mjs': "import { b } from './b.mjs';\n",
  });
  // The "full run" reports src/b.test.mjs failing, though only src/a.mjs changed.
  const fake = `node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({testResults:[{name:require('path').resolve('src/b.test.mjs'),status:'failed'}]}))" {report}`;
  writeFileSync(join(dir, 'hyvemind.json'), JSON.stringify({ version: 1, agentsMd: { paths: [] }, affected: { observeCommand: fake } }));
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-qm', 'cfg']);
  writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 2;\n');
  const r = run(dir, 'affected', '--observe', '--quiet');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /MISS: src\/b\.test\.mjs failed outside the selection/);
  assert.match(run(dir, 'affected', '--status').stdout, /SHADOW: 0\/20 .*last miss/);
});
