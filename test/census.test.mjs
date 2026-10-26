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
  // A comment swallowed an assertion (Book AI #278: `…; // note … expect(…)` on one line).
  assert.deepEqual(flags("it('a', () => { const r = f(); expect(r.a).toBe(1); // r.b too: expect(r.b).toBe(2)\n});"), ['COMMENTED_ASSERT']);
  assert.deepEqual(flags("it('a', () => {\n  /* assert.equal(g(), 3); */\n  assert.equal(f(), 2);\n});"), ['COMMENTED_ASSERT'], 'a block comment too');
  assert.deepEqual(flags("it('a', () => {\n  assert.equal(f(), 2);\n  // expect(late).toBe(1)\n});"), ['COMMENTED_ASSERT'], 'a comment after the last statement');
  assert.deepEqual(flags("it('a', () => { // the result must match what we assert below\n  assert.equal(f(), 2); });"), [''], 'prose about asserting is not an assertion');
  assert.deepEqual(flags("it('a', () => {\n  // this used to read `expect(x).toBeTruthy()`, which passed on any value\n  assert.equal(f(), 2);\n});"), [''], 'a call quoted in backticks is history, not a swallowed assertion');
  assert.deepEqual(flags("// expect(x) in the header is fine\nit('a', () => { assert.equal(f(), 2); });"), [''], 'only comments inside the body count');
  // An unused local is a hint, never a flag or a cap.
  const hinted = one("it('a', () => { const got = f(); const { b, _skip } = g(); const used = 1; assert.equal(used + b, 2); });").cases[0];
  assert.deepEqual([hinted.flags, hinted.hints], [[], ['UNUSED_LOCAL:got']]);
  assert.equal(one("it('a', () => { const x = f(); assert.equal(x, 1); });").cases[0].hints, undefined);
  // The note says whether an unused local sits beside real assertions or in a case with none.
  const note = (src) => ceiling(one(src)).reasons.find((x) => x.includes('never read'));
  assert.match(note("// ADR 0001\nit('a', () => { const got = f(); assert.equal(g(), 1); });"), /1 case\(s\) declare a local they never read; each case asserts elsewhere/);
  assert.match(note("// ADR 0001\nit('a', () => { const got = f(); });"), /\(1 with no assertion at all\)/);
  assert.equal(one("it('a', () => { const { drop, ...rest } = f(); assert.equal(g(rest), 1); });").cases[0].hints, undefined, 'naming a field to leave it out of ...rest is a use');
  assert.deepEqual(flags("it('a', () => {\n  // the direction we could not assert (its set was empty)\n  assert.equal(f(), 2);\n});"), [''], 'prose with a space before the paren is not a call');
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
