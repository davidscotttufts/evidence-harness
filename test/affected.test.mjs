import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.mjs';
import { affected, failingFilesFromVitest, globRe, importsOf, observe, readTrustLedger, resolveSpec, trust } from '../src/affected.mjs';
import { repo, sh, write } from './helpers.mjs';

// math.ts ← calc.ts ← calc.test.ts ; util.mjs ← util.test.mjs ; lonely.test.ts imports nothing local
const FILES = {
  'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  'src/calc.ts': "import { add } from './math.js';\nexport const twice = (x: number) => add(x, x);\n",
  'src/calc.test.ts': "import { twice } from './calc';\n",
  'lib/util.mjs': 'export const id = (x) => x;\n',
  'test/util.test.mjs': "const { id } = await import('../lib/util.mjs');\n",
  'test/lonely.test.ts': "import { describe } from 'vitest';\n",
  'src/aliased.test.ts': "import { add } from '@/math';\n",
  'fixtures/data.json': '{}\n',
};
const cfg = (affectedCfg = {}) => resolveConfig({ version: 1, affected: affectedCfg });

test('importsOf and resolveSpec: static, dynamic, require, TS .js→.ts, index files, aliases', () => {
  assert.deepEqual(importsOf("import a from './a';\nexport * from \"./b\";\nconst c = require('./c');\nawait import('./d');\nimport './e.css';"), ['./a', './b', './c', './d', './e.css']);
  const files = new Set(['src/math.ts', 'src/x/index.ts']);
  assert.equal(resolveSpec('./math.js', 'src/calc.ts', files), 'src/math.ts');
  assert.equal(resolveSpec('./x', 'src/calc.ts', files), 'src/x/index.ts');
  assert.equal(resolveSpec('react', 'src/calc.ts', files), null);
  assert.equal(resolveSpec('@/math', 'src/a.ts', files, { '@/': 'src/' }), 'src/math.ts');
  assert.ok(globRe('**/package.json').test('package.json') && globRe('**/package.json').test('a/b/package.json'));
  assert.ok(globRe('docs/**').test('docs/a/b.md') && !globRe('*.md').test('docs/a.md'));
});

test('a change selects exactly the tests that transitively import it', () => {
  const dir = repo(FILES);
  assert.deepEqual(affected(dir, cfg(), { changed: ['src/math.ts'] }).tests, ['src/calc.test.ts']);
  assert.deepEqual(affected(dir, cfg({ aliases: { '@/': 'src/' } }), { changed: ['src/math.ts'] }).tests, ['src/aliased.test.ts', 'src/calc.test.ts']);
  assert.deepEqual(affected(dir, cfg(), { changed: ['lib/util.mjs'] }).tests, ['test/util.test.mjs']);
  assert.deepEqual(affected(dir, cfg(), { changed: ['test/lonely.test.ts'] }).tests, ['test/lonely.test.ts'], 'a changed test selects itself');
});

test('anything the graph cannot trace selects ALL tests; docs and skills select none', () => {
  const dir = repo(FILES);
  assert.equal(affected(dir, cfg(), { changed: ['package.json'] }).all, true);
  assert.equal(affected(dir, cfg(), { changed: ['frontend/package-lock.json'] }).all, true);
  const fx = affected(dir, cfg(), { changed: ['fixtures/data.json'] });
  assert.equal(fx.all, true);
  assert.match(fx.reason, /cannot trace/);
  const docs = affected(dir, cfg(), { changed: ['README.md', '.claude/skills/x/SKILL.md'] });
  assert.equal(docs.all, false);
  assert.deepEqual(docs.tests, []);
});

test('changedFiles reads committed (vs base), uncommitted and untracked changes', () => {
  const dir = repo(FILES);
  sh(dir, 'git', ['checkout', '-q', '-b', 'feature']);
  write(dir, { 'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n' });
  sh(dir, 'git', ['commit', '-qam', 'edit']);
  write(dir, { 'lib/util.mjs': 'export const id = (y) => y;\n', 'src/new.test.ts': "import './math';\n" });
  const r = affected(dir, cfg(), { base: 'main' });
  assert.deepEqual(r.changed, ['lib/util.mjs', 'src/math.ts', 'src/new.test.ts']);
  assert.deepEqual(r.tests, ['src/calc.test.ts', 'src/new.test.ts', 'test/util.test.mjs']);
});

test('earned trust: shadow until N clean observations over D days; one miss resets it', () => {
  const dir = repo(FILES);
  const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
  const sel = { all: false, tests: ['src/calc.test.ts'] };
  for (let i = 0; i < 3; i++) observe(dir, sel, ['src/calc.test.ts'], day(i * 4));
  assert.equal(trust(readTrustLedger(dir), { minObservations: 3, minDays: 7 }).mode, 'trusted');
  const { misses } = observe(dir, sel, ['src/calc.test.ts', 'test/util.test.mjs'], day(13));
  assert.deepEqual(misses, ['test/util.test.mjs'], 'a failing test outside the selection is a miss');
  const t = trust(readTrustLedger(dir), { minObservations: 3, minDays: 7 });
  assert.equal(t.mode, 'shadow');
  assert.equal(t.clean, 0);
  observe(dir, { all: true, tests: [] }, ['anything.test.ts'], day(14));
  assert.equal(trust(readTrustLedger(dir), { minObservations: 3, minDays: 7 }).clean, 1, 'a run-everything selection cannot miss');
  assert.deepEqual(failingFilesFromVitest(dir, { testResults: [{ name: `${dir}/a.test.ts`, status: 'failed' }, { name: `${dir}/b.test.ts`, status: 'passed' }] }), ['a.test.ts']);
});
