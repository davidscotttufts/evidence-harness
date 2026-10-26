import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveConfig } from '../src/config.mjs';
import { ceiling, censusFile, CENSUS_DEFAULTS, runCensus } from '../src/census.mjs';
import { repo, sh, write } from './helpers.mjs';

// The census parses with typescript, a devDependency. In a fresh checkout without
// `npm ci` it is absent: skip with a clear reason instead of a crash at import time.
let ts = null;
try { ts = createRequire(import.meta.url)('typescript'); } catch { /* not installed */ }
const SKIP = ts ? false : 'typescript is not installed: run npm ci';
const cfg = resolveConfig({ version: 1 });
const one = (src) => censusFile(ts, 'x.test.ts', src, CENSUS_DEFAULTS);
const flags = (src) => one(src).cases.map((c) => c.flags.sort().join(','));

test('per-case flags: each can-it-fail and weak-claim shape is recognised', { skip: SKIP }, () => {
  assert.deepEqual(flags("it('a', () => { const x = 1; });"), ['NO_ASSERT']);
  assert.deepEqual(flags("it('a', () => { if (x) expect(x).toBe(1); });"), ['CONDITIONAL']);
  assert.deepEqual(flags("it('a', () => { p.then((v) => expect(v).toBe(1)); });"), ['CONDITIONAL'], 'an unrun callback is conditional');
  assert.deepEqual(flags("it('a', () => { [1].forEach((v) => expect(v).toBe(1)); });"), [''], 'loops are fine');
  assert.deepEqual(flags("it('a', () => { expect(x).toBeDefined(); expect(y).toBeTruthy(); });"), ['WEAK_ONLY']);
  assert.deepEqual(flags("it('a', () => { expect(res.status).toBe(200); });"), ['STATUS_ONLY']);
  assert.deepEqual(flags("it('a', () => { expect(fn).toHaveBeenCalledWith(1); });"), ['MOCK_ONLY']);
  assert.deepEqual(flags("it('a', () => { expect(tree).toMatchSnapshot(); });"), ['SNAPSHOT_ONLY']);
  assert.deepEqual(flags("it.skip('a', () => { expect(1).toBe(1); });"), ['SKIPPED']);
  assert.deepEqual(flags("test('a', { skip: true }, () => { assert.equal(1, 1); });"), ['SKIPPED'], 'node:test skip option');
  assert.deepEqual(flags("it.only('a', () => { expect(1).toBe(1); });"), ['ONLY']);
  assert.deepEqual(flags("it('a', () => { assert.equal(f(1), 2); });"), [''], 'node:test assert counts');
  assert.deepEqual(flags("const check = (v) => { if (!v) throw new Error(); };\nit('a', () => { check(f()); });"), [''], 'a local assertion helper counts');
  assert.deepEqual(flags("it('a', () => { screen.getByText('Saved'); });"), [''], 'a throwing Testing Library query is an assertion');
  const gated = one("const run = process.env.KEY ? describe : describe.skip;\nrun('live', () => { it('a', () => { expect(1).toBe(1); }); });");
  assert.deepEqual(gated.cases[0].flags, ['SKIPPED'], 'an env-gated suite is skipped');
});

test('per-file signals and ceilings', { skip: SKIP }, () => {
  const f = one("/** Guards the refund rule (ADR 0012). */\nit('a', () => { const x = y as any; setTimeout(done, 50); expect(x).toBe(1); });");
  assert.equal(f.casts, 1);
  assert.equal(f.sleeps, 1);
  assert.equal(f.headerRef, true);
  assert.deepEqual(ceiling(f).reasons.slice(0, 2), ['1 laundering cast(s)', '1 fixed sleep(s) without fake timers']);
  assert.equal(ceiling(one("/** see #123 */\nit('a', () => {});")).ceiling, 'F');
  assert.equal(ceiling(one("/** see #123 */\nit('a', () => { if (x) expect(x).toBe(1); });\nit('b', () => {});")).ceiling, 'D');
  assert.equal(ceiling(one("/** see #123 */\nit('a', () => { expect(f(1)).toBe(2); });")).ceiling, 'A');
  assert.equal(ceiling(one("it('a', () => { expect(f(1)).toBe(2); });")).ceiling, 'B', 'no header saying why');
  assert.equal(ceiling(one("/** see #123 */\nit('a', () => { expect(f(1)).toBe(2); });\nit.skip('b', () => { expect(1).toBe(1); });")).ceiling, 'C');
});

test('runCensus: duplicate bodies across files, blob-keyed ledger, grades survive only while unchanged', { skip: SKIP }, () => {
  const long = "it('dup', () => { const value = computeSomethingLong(1, 2, 3); expect(value).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 }); expect(other(value)).toBe(true); expect(formatTotal(value.a + value.b)).toBe('3.00 USD'); });\n";
  const dir = repo({ 'a.test.ts': `/** #1 */\n${long}`, 'b.test.ts': `/** #2 */\n${long}`, 'src/x.ts': 'export {};\n' });
  const first = runCensus(dir, cfg, { ts });
  assert.equal(first.summary.files, 2, 'only test files');
  assert.equal(first.summary.flags.DUPLICATE_BODY, 2);
  assert.deepEqual(first.files.map((f) => f.status), ['new', 'new']);
  first.files[0].grade = 'D'; // a grader records grades on both files
  first.files[1].grade = 'A';
  write(dir, { 'b.test.ts': `/** #2 */\nit('changed', () => { expect(g(2)).toBe(3); });\n` });
  sh(dir, 'git', ['commit', '-qam', 'edit b']);
  const second = runCensus(dir, cfg, { ts, previous: first });
  assert.deepEqual(second.files.map((f) => [f.file, f.status, f.grade ?? null]), [['a.test.ts', 'unchanged', 'D'], ['b.test.ts', 'changed', null]]);
  assert.equal(second.summary.flags.DUPLICATE_BODY, 0);
  assert.equal(second.summary.changed, 1);
});
