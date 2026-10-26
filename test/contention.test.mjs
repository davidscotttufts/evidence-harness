import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.mjs';
import { competitors, sample } from '../src/contention.mjs';
import { runGates } from '../src/gate.mjs';
import { repo } from './helpers.mjs';

// Fake process table: our own suite, another worktree's suite (two workers), a stopped
// suite, a watcher, and an unrelated process.
const PS = [
  '101 1 S node /x/node_modules/vitest/vitest.mjs run',
  '102 1 S node /y/node_modules/vitest/vitest.mjs run',
  '103 102 S node /y/node_modules/vitest/dist/worker.js vitest',
  '104 1 T npx playwright test',
  '105 1 S vitest --watch',
  '106 1 S node server.js',
].join('\n');
const CWD = { 101: '/repo', 102: '/repo-other-worktree', 103: '/repo-other-worktree', 104: '/elsewhere', 105: '/elsewhere', 106: '/elsewhere' };

test('competitors: other directories only, one per directory, never stopped processes or watchers', () => {
  const c = competitors('/repo', { ps: () => PS, cwd: (pid) => CWD[pid] });
  assert.deepEqual(c.map((x) => x.dir), ['/repo-other-worktree']);
  assert.match(c[0].command, /vitest/);
  assert.equal(sample('/repo', { ps: () => PS, cwd: (pid) => CWD[pid] }).contended, true);
  assert.equal(sample('/repo', { ps: () => '', cwd: () => null }).competitors.length, 0);
});

test('the gate records contention on its evidence, and skips sampling when a broker queues the work', async () => {
  const dir = repo();
  const busy = { load1: 30, cores: 8, busy: true, competitors: [{ dir: '/other', pid: 1, command: 'vitest run' }], contended: true };
  const { record } = await runGates(dir, resolveConfig({ version: 1, gates: [{ name: 'x', run: 'exit 1' }] }), { quiet: true, contention: busy });
  assert.equal(record.verdict, 'red');
  assert.equal(record.contention.contended, true);
  const sampled = await runGates(dir, resolveConfig({ version: 1, gates: [{ name: 'x', run: 'true' }] }), { quiet: true });
  assert.equal(typeof sampled.record.contention.load1, 'number');
  const brokered = await runGates(dir, resolveConfig({ version: 1, gates: [{ name: 'x', run: 'true' }], broker: { command: 'true' } }), { quiet: true });
  assert.equal(brokered.record.contention, undefined);
});
