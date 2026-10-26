// Test-impact selection: which tests can a change affect?
//
// Builds a static import graph of the JS/TS files in the repo, walks it backwards
// from every changed file, and returns the test files it reaches. It is a SPEED
// tool for inner loops, never a substitute for the gate:
//   - any changed file the graph cannot trace (config, lockfiles, JSON fixtures,
//     anything not code and not ignored) selects ALL tests;
//   - dynamic imports with non-literal specifiers are invisible, so the full gate
//     still runs before "done" (hyvemind gate / evidence).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { git } from './git.mjs';

export const CODE = /\.(m|c)?(j|t)sx?$/;
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export const AFFECTED_DEFAULTS = {
  testPattern: '(^|/)__tests__/|[./](test|spec)\\.(m|c)?(j|t)sx?$',
  // Changes that can affect any test without an import edge: run everything.
  fullRunOn: ['package.json', '**/package.json', '*lock*', '**/*lock*', '**/tsconfig*.json', '**/vitest.config.*', '**/vite.config.*', '**/jest.config.*', 'hyvemind.json', '**/.env*'],
  // Changes that cannot affect a test.
  ignore: ['**/*.md', 'docs/**', '.claude/**', '.agents/**', '.hyve/**', '.github/**', 'LICENSE*'],
  aliases: {},
};

export function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (file, globs) => globs.some((g) => globRe(g).test(file));

export function importsOf(src) {
  const out = new Set();
  const re = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|vi\.mock\(\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) out.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
  return [...out];
}

// Resolve a specifier from `from` (repo-relative) to a repo-relative file, or null
// for packages and anything unresolvable.
export function resolveSpec(spec, from, files, aliases = {}) {
  let target = null;
  for (const [prefix, to] of Object.entries(aliases)) {
    if (spec.startsWith(prefix)) { target = normalize(join(to, spec.slice(prefix.length))); break; }
  }
  if (!target) {
    if (!spec.startsWith('.')) return null;
    target = normalize(join(dirname(from), spec));
  }
  const tries = [target, ...EXTS.map((e) => target + e), ...EXTS.map((e) => join(target, `index${e}`))];
  // TS ESM convention: import './x.js' resolves to ./x.ts
  if (/\.(m|c)?js$/.test(target)) tries.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => target.replace(/\.(m|c)?js$/, e)));
  return tries.find((t) => files.has(t)) ?? null;
}

export function changedFiles(root, base) {
  const set = new Set();
  const add = (out) => out.split('\n').filter(Boolean).forEach((f) => set.add(f));
  if (base) {
    const r = git(root, ['diff', '--name-only', `${base}...HEAD`]);
    if (r.status !== 0) throw new Error(`cannot diff against ${base}: ${r.err}`);
    add(r.out);
  }
  add(git(root, ['diff', '--name-only', 'HEAD']).out);
  add(git(root, ['ls-files', '--others', '--exclude-standard']).out);
  return [...set].sort();
}

export function affected(root, cfg, { base = null, changed = null } = {}) {
  const opt = { ...AFFECTED_DEFAULTS, ...(cfg.affected ?? {}) };
  const testRe = new RegExp(opt.testPattern);
  const files = new Set([
    ...git(root, ['ls-files']).out.split('\n'),
    ...git(root, ['ls-files', '--others', '--exclude-standard']).out.split('\n'),
  ].filter((f) => f && CODE.test(f) && existsSync(join(root, f))));
  const changes = changed ?? changedFiles(root, base);

  const forced = changes.filter((f) => matchesAny(f, opt.fullRunOn));
  if (forced.length) return { all: true, reason: `changed: ${forced.join(', ')}`, changed: changes, tests: [] };
  const untraceable = changes.filter((f) => !CODE.test(f) && !matchesAny(f, opt.ignore));
  if (untraceable.length) return { all: true, reason: `cannot trace non-code change(s): ${untraceable.join(', ')}`, changed: changes, tests: [] };

  const dependents = new Map();
  for (const f of files) {
    for (const spec of importsOf(readFileSync(join(root, f), 'utf8'))) {
      const dep = resolveSpec(spec, f, files, opt.aliases);
      if (!dep) continue;
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(f);
    }
  }
  const seen = new Set(changes.filter((f) => CODE.test(f)));
  const queue = [...seen];
  while (queue.length) {
    for (const d of dependents.get(queue.pop()) ?? []) if (!seen.has(d)) { seen.add(d); queue.push(d); }
  }
  const tests = [...seen].filter((f) => testRe.test(f) && files.has(f)).sort();
  return { all: false, reason: `${changes.length} changed file(s) reach ${tests.length} test file(s)`, changed: changes, tests };
}

export const relativeTo = (root, cwd, f) => relative(cwd, join(root, f));
