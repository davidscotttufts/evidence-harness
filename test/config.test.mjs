import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, resolveConfig } from '../src/config.mjs';
import { detect } from '../src/detect.mjs';
import { repo } from './helpers.mjs';

test('merge: objects merge, arrays replace (a project listing gates means exactly those gates)', () => {
  const out = merge({ a: { b: 1, c: 2 }, gates: [{ name: 'x' }] }, { a: { c: 3 }, gates: [{ name: 'y' }] });
  assert.deepEqual(out, { a: { b: 1, c: 3 }, gates: [{ name: 'y' }] });
});

test('resolveConfig layers defaults < preset < project', () => {
  const cfg = resolveConfig({ version: 1, preset: 'openwop', skills: { prefix: 'h-' } });
  assert.equal(cfg.gates[0].run, 'npm run ci');
  assert.equal(cfg.probe.lanes.frontend, 'frontend/react');
  assert.equal(cfg.skills.prefix, 'h-');
  assert.deepEqual(cfg.skills.targets, ['.claude/skills', '.agents/skills']);
});

test('cli defaults to an exact registry version, so npx can never resolve a look-alike', () => {
  assert.match(resolveConfig({ version: 1 }).cli, /^npx -y hyvemind@\d+\.\d+\.\d+$/);
  assert.equal(resolveConfig({ version: 1, cli: 'npx hyvemind' }).cli, 'npx hyvemind');
  assert.throws(() => resolveConfig({ version: 1, cli: 'npx harness' }), /cli must be a command that runs hyvemind/);
});

test('resolveConfig rejects broken config with every problem listed', () => {
  assert.throws(
    () => resolveConfig({ version: 1, gates: [{ name: 'x' }], probe: { command: 'npm test' }, review: { bannedPatterns: [{ pattern: '(' }] } }),
    (e) => /gates\[0\]\.run/.test(e.message) && /\{test\}/.test(e.message) && /valid regex/.test(e.message),
  );
  assert.throws(() => resolveConfig({ version: 1, preset: 'nope' }), /unknown preset/);
});

test('detect: openwop family, node scripts, python, generic', () => {
  const ow = repo({ 'package.json': JSON.stringify({ scripts: { ci: 'bash scripts/ci.sh' } }), 'backend/typescript/x': '', 'frontend/react/x': '' });
  assert.equal(detect(ow).preset, 'openwop');

  const node = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', dev: 'vite' } }) });
  const d = detect(node);
  assert.equal(d.preset, 'node');
  assert.deepEqual(d.overrides.gates.map((g) => g.name), ['lint', 'test']);
  assert.equal(d.overrides.probe.command, 'npx vitest run {test}');

  assert.equal(detect(repo({ 'pyproject.toml': '' })).preset, 'python');
  assert.equal(detect(repo()).preset, 'generic');
});

test('externalGate replaces a preset\'s gates; only gates the project lists itself conflict', () => {
  const cfg = resolveConfig({ version: 1, preset: 'openwop', externalGate: { run: 'make verify', done: 'make verify passes' } });
  assert.deepEqual(cfg.gates, [], 'the openwop preset gate (npm run ci) is replaced');
  assert.throws(() => resolveConfig({ version: 1, preset: 'openwop', externalGate: { run: 'x', done: 'y' }, gates: [{ name: 'a', run: 'b' }] }), /mutually exclusive/);
});

test('codex clean profile: the default links only the login into a temp CODEX_HOME (its flags do not skip AGENTS.md)', () => {
  const codex = resolveConfig({ version: 1 }).evals.agents.codex;
  assert.deepEqual(codex.cleanHome, { env: 'CODEX_HOME', from: '~/.codex', keep: ['auth.json'] });
  assert.throws(() => resolveConfig({ version: 1, evals: { agents: { codex: { cleanHome: { env: 'CODEX_HOME', from: '~/.codex', keep: ['../secrets'] } } } } }), /cleanHome must be/);
});
