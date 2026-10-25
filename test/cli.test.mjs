import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo } from './helpers.mjs';

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
