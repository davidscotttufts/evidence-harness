import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { failingCases, runProbe, runProbes } from '../src/probe.mjs';
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

test('case-level witnessing: a passing case named in the output is NOT a witness', () => {
  // Two cases; the break fails only "picks larger". The passing case is named
  // "smaller sanity", and its name appears in the output either way.
  const SRC2 = 'export const max = (a, b) => (a > b ? a : b);\n';
  const T = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {max} from '../src/max.mjs';\ntest('picks larger', () => { assert.equal(max(1, 2), 2); });\ntest('smaller sanity', () => { assert.equal(typeof max, 'function'); });\n";
  const dir = repo({ 'src/max.mjs': SRC2, 'test/t.test.mjs': T });
  const node = resolveConfig({ version: 1, probe: { command: 'node --test {test}', format: 'node', lanes: { default: '.' } } });
  const out = resolveConfig({ version: 1, probe: { command: 'node --test {test}', lanes: { default: '.' } } });
  const p = { id: 'x', src: 'src/max.mjs', old: 'a > b', new: 'a < b', test: 'test/t.test.mjs' };
  const right = runProbe(dir, node, { ...p, expectRed: ['picks larger'] });
  assert.equal(right.verdict, 'witnessed');
  assert.ok(right.failing.includes('picks larger'));
  assert.equal(runProbe(dir, node, { ...p, expectRed: ['smaller sanity'] }).verdict, 'other-red', 'named but passing');
  assert.equal(runProbe(dir, out, { ...p, expectOutput: ['smaller sanity'] }).verdict, 'witnessed', 'the old substring check is fooled');
  assert.match(runProbe(dir, out, { ...p, expectRed: ['picks larger'] }).error, /needs probe.format/);
});

test('vitest JSON report: failing cases and a suite that failed to load', () => {
  const dir = repo();
  const f = join(dir, 'r.json');
  writeFileSync(f, JSON.stringify({ testResults: [
    { name: 'a.test.ts', status: 'failed', assertionResults: [{ fullName: 'refund > rejects anonymous', status: 'failed' }, { fullName: 'refund > ok', status: 'passed' }] },
    { name: 'b.test.ts', status: 'failed', assertionResults: [] },
  ] }));
  assert.deepEqual(failingCases('vitest', { reportFile: f, output: '' }), ['refund > rejects anonymous', '(suite) b.test.ts']);
  assert.equal(failingCases('vitest', { reportFile: join(dir, 'missing.json'), output: '' }), null);
});
