import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { localForge, runTrain } from '../src/train.mjs';
import { git } from '../src/git.mjs';
import { repo, sh, write } from './helpers.mjs';

// origin (bare) + a clone with three change branches pushed:
//   ok-a adds a.txt, ok-b adds b.txt, bad adds BAD (the gate fails when BAD exists)
function world() {
  const top = mkdtempSync(join(tmpdir(), 'hyve-train-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const root = repo({ '.gitignore': '.hyve/\n' });
  sh(root, 'git', ['remote', 'add', 'origin', origin]);
  sh(root, 'git', ['push', '-q', 'origin', 'main']);
  const branch = (name, files) => {
    sh(root, 'git', ['checkout', '-q', '-b', name, 'main']);
    write(root, files);
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-q', '-m', name]);
    sh(root, 'git', ['push', '-q', 'origin', name]);
    sh(root, 'git', ['checkout', '-q', 'main']);
  };
  branch('ok-a', { 'a.txt': 'a\n' });
  branch('ok-b', { 'b.txt': 'b\n' });
  branch('bad', { BAD: 'x\n' });
  branch('clash-1', { 'README.md': 'one\n' });
  branch('clash-2', { 'README.md': 'two\n' });
  return { root, origin, dir: join(top, 'train') };
}

const cfg = (run = 'test ! -f BAD') => resolveConfig({ version: 1, gates: [{ name: 'ci', run }] });
const originTree = (w) => git(w.root, ['ls-tree', '--name-only', '-r', 'origin/main']).out;
const fetch = (w) => sh(w.root, 'git', ['fetch', '-q', 'origin']);

test('a green train merges every change and main ends on exactly the gated tree', async () => {
  const w = world();
  const r = await runTrain(w.root, cfg(), ['ok-a', 'ok-b'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true });
  assert.deepEqual(r.merged, ['ok-a', 'ok-b']);
  assert.equal(r.gates, 1, 'two changes, one gate');
  fetch(w);
  assert.match(originTree(w), /a\.txt[\s\S]*b\.txt/);
});

test('a red train bisects: the culprit is left open, the rest lands', async () => {
  const w = world();
  const r = await runTrain(w.root, cfg(), ['ok-a', 'bad', 'ok-b'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true });
  assert.deepEqual(r.red, ['bad']);
  assert.deepEqual([...r.merged].sort(), ['ok-a', 'ok-b']);
  fetch(w);
  assert.doesNotMatch(originTree(w), /BAD/);
});

test('--no-bisect stops on red and merges nothing', async () => {
  const w = world();
  const r = await runTrain(w.root, cfg(), ['ok-a', 'bad'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true, bisect: false });
  assert.deepEqual(r.red, ['ok-a', 'bad']);
  assert.deepEqual(r.merged, []);
});

test('a change that conflicts with the train is named and skipped', async () => {
  const w = world();
  const r = await runTrain(w.root, cfg(), ['clash-1', 'clash-2'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true });
  assert.deepEqual(r.conflicts, ['clash-2']);
  assert.deepEqual(r.merged, ['clash-1']);
});

// The gate itself pushes an unrelated commit to origin/main the first time it runs,
// like a peer merging while the train is gating.
function peerPushesOnce(w) {
  const marker = join(w.root, '..', `peer-${Date.now()}`);
  const peer = `if [ ! -f "${marker}" ]; then touch "${marker}"; d=$(mktemp -d); git clone -q "${w.origin}" "$d" && cd "$d" && git -c user.email=p@x -c user.name=p commit -q --allow-empty -m peer && git push -q origin HEAD:main; fi; true`;
  return cfg(peer);
}

test('base moved during the gate: rebuild and re-gate once, then merge', async () => {
  const w = world();
  const r = await runTrain(w.root, peerPushesOnce(w), ['ok-a'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true, retries: 1 });
  assert.deepEqual(r.merged, ['ok-a']);
  assert.equal(r.gates, 2);
});

test('base moved and no retries left: refuse to merge an untested tree', async () => {
  const w = world();
  const r = await runTrain(w.root, peerPushesOnce(w), ['ok-a'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true, retries: 0 });
  assert.deepEqual(r.refused, ['ok-a']);
  fetch(w);
  assert.doesNotMatch(originTree(w), /a\.txt/);
});

test('--no-merge gates and leaves merging to you; one train per clone', async () => {
  const w = world();
  const r = await runTrain(w.root, cfg(), ['ok-a'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true, merge: false });
  assert.deepEqual(r.gated, ['ok-a']);
  const common = git(w.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  assert.ok(!existsSync(join(common, 'hyve-train.lock')), 'lock released');
  sh(w.root, 'mkdir', [join(common, 'hyve-train.lock')]);
  await assert.rejects(runTrain(w.root, cfg(), ['ok-a'], { forge: localForge(w.root, 'main'), dir: w.dir, quiet: true }), /another train/);
});

test('if what lands on main is not the gated tree, the train stops loudly (TREE MISMATCH)', async () => {
  const w = world();
  const honest = localForge(w.root, 'main');
  // A forge that merges, then lets something else land on main too: the tree on
  // main is no longer the tree that was gated.
  const sneaky = {
    ...honest,
    merge(id, sha, dir) {
      honest.merge(id, sha, dir);
      write(dir, { 'sneaked.txt': 'not gated\n' });
      sh(dir, 'git', ['add', 'sneaked.txt']);
      sh(dir, 'git', ['-c', 'user.email=s@x', '-c', 'user.name=s', 'commit', '-qm', 'sneak']);
      sh(dir, 'git', ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    },
  };
  await assert.rejects(runTrain(w.root, cfg(), ['ok-a'], { forge: sneaky, dir: w.dir, quiet: true }), /TREE MISMATCH/);
});
