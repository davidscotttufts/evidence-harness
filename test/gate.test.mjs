import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { evidenceFor, runGates } from '../src/gate.mjs';
import { git, workingTree } from '../src/git.mjs';
import { repo, write } from './helpers.mjs';

const cfg = (gates) => resolveConfig({ version: 1, gates });

test('workingTree tracks uncommitted and untracked edits without touching the real index', () => {
  const dir = repo({ 'a.txt': 'one\n' });
  const t0 = workingTree(dir);
  assert.equal(workingTree(dir), t0, 'stable');
  write(dir, { 'b.txt': 'new\n' });
  const t1 = workingTree(dir);
  assert.notEqual(t1, t0);
  assert.equal(git(dir, ['diff', '--cached', '--name-only']).out, '', 'real index untouched');
  write(dir, { 'a.txt': 'two\n' });
  assert.notEqual(workingTree(dir), t1);
});

test('the hash never trusts the real index: an edit it believes unchanged still changes the tree', () => {
  // A stat-trusting index misses edits whenever its cached size/mtime/ctime still match
  // (CI caught a same-second edit this way). assume-unchanged makes that deterministic.
  const dir = repo({ 'a.txt': 'one\n' });
  const t0 = workingTree(dir);
  git(dir, ['update-index', '--assume-unchanged', 'a.txt']);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  assert.equal(git(dir, ['status', '--porcelain']).out, '', 'the real index is fooled');
  assert.notEqual(workingTree(dir), t0, 'the evidence hash is not');
});

test('green gate is evidence for exactly that tree, and stops being evidence after an edit', async () => {
  const dir = repo();
  const { record } = await runGates(dir, cfg([{ name: 'ok', run: 'true' }]), { quiet: true });
  assert.equal(record.verdict, 'green');
  assert.equal(evidenceFor(dir).match?.treeAfter, record.treeAfter);
  write(dir, { 'x.txt': 'edit\n' });
  assert.equal(evidenceFor(dir).match, null);
});

test('a red gate stops later gates and is not evidence', async () => {
  const dir = repo();
  const { record } = await runGates(dir, cfg([{ name: 'bad', run: 'exit 3' }, { name: 'later', run: 'true' }]), { quiet: true });
  assert.equal(record.verdict, 'red');
  assert.equal(record.gates[0].exitCode, 3);
  assert.equal(record.gates[1].skipped, true);
  assert.equal(evidenceFor(dir).match, null);
  assert.equal(evidenceFor(dir).latest.verdict, 'red');
});

test('a gate that edits the tree yields "invalid", never green', async () => {
  const dir = repo();
  const { record } = await runGates(dir, cfg([{ name: 'formatter', run: 'echo changed > generated.txt' }]), { quiet: true });
  assert.equal(record.verdict, 'invalid');
  assert.equal(evidenceFor(dir).match, null);
});

test('a partial run (--only) is recorded but never counts as evidence', async () => {
  const dir = repo();
  const c = cfg([{ name: 'fast', run: 'true' }, { name: 'slow', run: 'true' }]);
  const { record, file } = await runGates(dir, c, { only: ['fast'], quiet: true });
  assert.equal(record.verdict, 'green');
  assert.equal(record.partial, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).gates.length, 1);
  assert.equal(evidenceFor(dir).match, null);
});

test('evidence files are ignored by git, so recording them does not change the tree', async () => {
  const dir = repo();
  await runGates(dir, cfg([{ name: 'ok', run: 'true' }]), { quiet: true });
  assert.match(git(dir, ['check-ignore', '.hyve/evidence/x.json']).out, /evidence/);
  assert.equal(git(dir, ['status', '--porcelain', '--', join('.hyve', 'evidence')]).out, '');
});
