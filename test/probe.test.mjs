import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { runProbe, runProbes } from '../src/probe.mjs';
import { repo, write } from './helpers.mjs';

const SRC = 'export const max = (a, b) => (a > b ? a : b);\n';
const STRONG = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {max} from '../src/max.mjs';\ntest('picks larger', () => { assert.equal(max(1, 2), 2); assert.equal(max(5, 3), 5); });\n";
const WEAK = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {max} from '../src/max.mjs';\ntest('exists', () => { assert.equal(typeof max, 'function'); });\n";

const fixture = () => repo({ 'src/max.mjs': SRC, 'test/strong.test.mjs': STRONG, 'test/weak.test.mjs': WEAK });
const cfg = resolveConfig({ version: 1, probe: { command: 'node --test {test}', lanes: { default: '.' }, errorPatterns: ['ENVIRONMENT_BROKEN'] } });
const flip = { src: 'src/max.mjs', old: 'a > b', new: 'a < b' };

test('a test that can fail is witnessed; a test that cannot is vacuous; src is restored', () => {
  const dir = fixture();
  const { results, srcStatus } = runProbes(dir, cfg, [
    { id: 'strong', ...flip, test: 'test/strong.test.mjs', expectOutput: ['picks larger'] },
    { id: 'weak', ...flip, test: 'test/weak.test.mjs' },
  ]);
  assert.deepEqual(results.map((r) => r.verdict), ['witnessed', 'vacuous']);
  assert.equal(srcStatus, 'clean');
  assert.equal(readFileSync(join(dir, 'src/max.mjs'), 'utf8'), SRC);
});

test('red with the wrong output is other-red; red matching an errorPattern is error', () => {
  const dir = fixture();
  assert.equal(runProbe(dir, cfg, { id: 'x', ...flip, test: 'test/strong.test.mjs', expectOutput: ['some other case'] }).verdict, 'other-red');
  const env = resolveConfig({ version: 1, probe: { command: 'echo ENVIRONMENT_BROKEN; exit 1 # {test}', lanes: { default: '.' }, errorPatterns: ['ENVIRONMENT_BROKEN'] } });
  assert.equal(runProbe(dir, env, { id: 'y', ...flip, test: 'whatever' }).verdict, 'error');
});

test('refuses a dirty src, an ambiguous old string, and an unknown lane', () => {
  const dir = fixture();
  assert.match(runProbe(dir, cfg, { id: 'a', src: 'src/max.mjs', old: 'a', new: 'z', test: 't' }).error, /matched \d+ times/);
  assert.match(runProbe(dir, cfg, { id: 'b', ...flip, test: 't', lane: 'nope' }).error, /unknown lane/);
  write(dir, { 'src/max.mjs': SRC + '// wip\n' });
  const r = runProbe(dir, cfg, { id: 'c', ...flip, test: 'test/strong.test.mjs' });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /uncommitted/);
  assert.match(readFileSync(join(dir, 'src/max.mjs'), 'utf8'), /\/\/ wip/, 'never touches a dirty file');
});
