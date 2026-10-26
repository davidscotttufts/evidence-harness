import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.match(run(dir, 'eval', '--render', 'r.json').stdout, /\| pr \| 1 \| 3 \| 0% \[0–56%\] \| 100% \[44–100%\] \| \+1 \[\+0\.21, \+1\] \| — \| \*\*earning\*\* \|/);

  // eval: preview first; never starts unattended without --yes.
  writeFileSync(join(dir, 'hyvemind.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'hyvemind.json'), 'utf8')), evals: { agent: 'boom', agents: { boom: { command: ['node', '-e', 'require("fs").writeFileSync("/dev/null","");process.exit(9)', '{prompt}'] } } } }));
  const dry = run(dir, 'eval', 'open-pr', '--dry-run');
  assert.equal(dry.status, 0, `eval --dry-run must only preview: ${dry.stderr}`);
  assert.match(dry.stderr, /eval plan: 1 skill\(s\) · \d+ scenario\(s\) · 3 trial\(s\) × 2 arms = \d+ agent runs \(boom\)/);
  assert.ok(!existsSync(join(dir, '.hyve/evals')), 'a dry run runs nothing');
  const noYes = run(dir, 'eval', 'open-pr:commands-before-pr');
  assert.equal(noYes.status, 1, 'a non-TTY eval without --yes must refuse to start');
  assert.match(noYes.stderr, /eval plan: .* = 6 agent runs/);
  assert.match(noYes.stderr, /re-run with --yes/);
  assert.match(run(dir, 'eval', 'open-pr', '--scenario', 'nope', '--dry-run').stderr, /open-pr: no scenario nope/);

  assert.match(run(dir, 'train').stderr, /usage: hyvemind train/);
  assert.match(run(dir, 'run').stderr, /usage: hyvemind run/);
});

test('doctor with an external gate: warns only on the real gaps (no machine check, a second merge path)', () => {
  const dir = repo();
  const write = (extra) => writeFileSync(join(dir, 'hyvemind.json'), JSON.stringify({ version: 1, externalGate: { run: 'make verify', done: 'make verify passes' }, skills: { include: ['write-spec', 'open-pr', 'ship-change'] }, ...extra }));
  write({});
  assert.equal(run(dir, 'update').status, 0);
  const loose = run(dir, 'doctor').stdout;
  assert.match(loose, /✓ gate — external: make verify/);
  assert.match(loose, /! external evidence — externalGate is set without evidence\.status/);
  assert.match(loose, /! merge path — ship-change would merge through hyvemind's train/);
  assert.doesNotMatch(loose, /open-pr/, 'open-pr defers to the external gate now');
  assert.match(loose, /✓ cli integrity — not pinned/, 'integrity is wired into doctor (offline when unpinned)');
  write({ evidence: { status: 'ci/local-verify' }, train: { via: 'external' } });
  const tight = run(dir, 'doctor').stdout;
  assert.doesNotMatch(tight, /external evidence|merge path/);
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

test('evidence.status + train.via external: evidence names its source, --post defers, train refuses', () => {
  const dir = repo({ '.gitignore': 'bin/\n.hyve/\n', 'hyvemind.json': JSON.stringify({ version: 1, evidence: { status: 'ci/local-verify' }, train: { via: 'external', message: 'merges go through the release queue' } }) });
  sh(dir, 'git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  const fake = join(dir, 'bin');
  mkdirSync(fake);
  writeFileSync(join(fake, 'gh'), `#!/bin/sh\necho "$*" >> "${dir}/bin/calls"\necho '[{"context":"ci/local-verify","state":"success","created_at":"2026-10-25T10:00:00Z"}]'\n`);
  chmodSync(join(fake, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${fake}:${process.env.PATH}` };
  const go = (...args) => spawnSync('node', [BIN, ...args], { cwd: dir, encoding: 'utf8', env });

  const ev = go('evidence');
  assert.equal(ev.status, 0, ev.stdout + ev.stderr);
  assert.match(ev.stdout, /proof: commit status "ci\/local-verify" = success/);
  const post = go('evidence', '--post');
  assert.equal(post.status, 0, post.stdout + post.stderr);
  assert.match(post.stdout, /not posting hyvemind\/gate: "ci\/local-verify" \(evidence\.status\) is authoritative/);
  assert.doesNotMatch(readFileSync(join(fake, 'calls'), 'utf8'), /POST/);
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  assert.equal(go('evidence').status, 1, 'dirty tree: not proof');

  const train = go('train', '12');
  assert.notEqual(train.status, 0);
  assert.match(train.stderr, /merges go through the release queue/);
});
