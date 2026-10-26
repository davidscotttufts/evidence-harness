import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { leaseArgv, leaseShell } from '../src/broker.mjs';
import { runGates } from '../src/gate.mjs';
import { repo, write } from './helpers.mjs';

// A fake broker: logs its lease arguments, then runs the command after `--`.
function fakeBroker(dir) {
  write(dir, { 'fake-broker': `#!/bin/sh\necho "$@" >> "${dir}/broker.log"\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n` });
  chmodSync(join(dir, 'fake-broker'), 0o755);
  return join(dir, 'fake-broker');
}

test('without a broker, commands run unwrapped', () => {
  const cfg = resolveConfig({ version: 1 });
  assert.equal(leaseShell(cfg, 'gate', 'ci', 'npm test'), 'npm test');
  assert.deepEqual(leaseArgv(cfg, 'eval', 'x', ['claude', '-p', 'hi']), ['claude', '-p', 'hi']);
});

test('with a broker, gates run through `lease` with the right class, and the verdict still holds', async () => {
  const dir = repo({ '.gitignore': 'fake-broker\nbroker.log\n.hyve/\n' });
  const cfg = resolveConfig({ version: 1, gates: [{ name: 'ok', run: 'echo "it\'s fine"' }, { name: 'bad', run: 'exit 4' }], broker: { command: fakeBroker(dir) } });
  const { record } = await runGates(dir, cfg, { quiet: true, keepGoing: true });
  assert.deepEqual(record.gates.map((g) => g.exitCode), [0, 4], 'exit codes pass through the broker');
  assert.equal(record.verdict, 'red');
  const log = readFileSync(join(dir, 'broker.log'), 'utf8');
  assert.match(log, /^lease --class gate --label hyvemind:gate:ok --quiet -- sh -c echo "it's fine"$/m);
  assert.deepEqual(leaseArgv(cfg, 'eval', 'pr/x', ['claude', '-p', 'q']).slice(1, 9), ['lease', '--class', 'agent', '--label', 'hyvemind:eval:pr/x', '--quiet', '--tokens', '1']);
});
