import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { BLOCK_BEGIN, BLOCK_END, agentsBlock, bundledSkills, installAgentsMd, installSkills, render, upsertBlock } from '../src/install.mjs';
import { repo, write } from './helpers.mjs';

const cfg = (over = {}) => resolveConfig({ version: 1, gates: [{ name: 'test', run: 'npm test' }], ...over });

test('render resolves cross-references, with no prefix by default and an optional one', () => {
  const src = '---\nname: ship-change\n---\nthen run {{skill:review-change}} and {{skill:open-pr}}';
  const plain = render(src, 'ship-change', '');
  assert.match(plain, /^name: ship-change$/m);
  assert.match(plain, /run review-change and open-pr/);
  const ns = render(src, 'ship-change', 'acme-');
  assert.match(ns, /^name: acme-ship-change$/m);
  assert.match(ns, /run acme-review-change and acme-open-pr/);
  assert.doesNotMatch(ns, /\{\{skill:/);
});

test('{{cli}} renders to the configured command in skills and the AGENTS.md block', () => {
  assert.equal(render('run `{{cli}} gate`', 'open-pr', '', 'npx -y hyvemind@9.9.9'), 'run `npx -y hyvemind@9.9.9 gate`');
  const dir = repo();
  const c = cfg({ cli: 'npx hyvemind' });
  installSkills(dir, c);
  installAgentsMd(dir, c);
  assert.match(readFileSync(join(dir, '.claude/skills/open-pr/SKILL.md'), 'utf8'), /`npx hyvemind evidence`/);
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /`npx hyvemind gate`/);
  for (const s of bundledSkills()) {
    assert.doesNotMatch(readFileSync(join(dir, '.claude/skills', s, 'SKILL.md'), 'utf8'), /\{\{cli\}\}/, s);
  }
});

test('every bundled skill renders with no unresolved tokens and a description', () => {
  for (const s of bundledSkills()) {
    const text = render(readFileSync(new URL(`../skills/${s}/SKILL.md`, import.meta.url), 'utf8'), s, '');
    assert.match(text, new RegExp(`^name: ${s}$`, 'm'), s);
    assert.match(text, /^description: .{40,}/m, s);
    assert.doesNotMatch(text, /\{\{/, s);
  }
});

test('install writes every skill to every target, then is idempotent', () => {
  const dir = repo();
  const c = cfg();
  const first = installSkills(dir, c);
  assert.ok(first.every((a) => a.action === 'write'));
  for (const s of bundledSkills()) {
    assert.ok(existsSync(join(dir, '.claude/skills', s, 'SKILL.md')), s);
    assert.ok(existsSync(join(dir, '.agents/skills', s, 'SKILL.md')), s);
  }
  assert.ok(!existsSync(join(dir, '.claude/skills/open-pr/evals')), 'eval scenarios are not installed');
  assert.ok(installSkills(dir, c).every((a) => a.action === 'same'));
});

test('update keeps a skill the project edited, and one that existed before hyvemind', () => {
  const dir = repo({ '.claude/skills/plan-tasks/SKILL.md': 'our own plan skill\n' });
  const c = cfg();
  installSkills(dir, c);
  const foreign = join(dir, '.claude/skills/plan-tasks/SKILL.md');
  assert.equal(readFileSync(foreign, 'utf8'), 'our own plan skill\n');

  const edited = join(dir, '.claude/skills/review-change/SKILL.md');
  writeFileSync(edited, readFileSync(edited, 'utf8') + '\nlocal rule\n');
  const plan = installSkills(dir, c);
  assert.equal(plan.find((a) => a.rel.endsWith('review-change/SKILL.md') && a.rel.startsWith('.claude')).action, 'modified');
  assert.equal(plan.find((a) => a.rel === '.claude/skills/plan-tasks/SKILL.md').action, 'foreign');
  assert.match(readFileSync(edited, 'utf8'), /local rule/);

  installSkills(dir, c, { force: true });
  assert.doesNotMatch(readFileSync(edited, 'utf8'), /local rule/);
  assert.doesNotMatch(readFileSync(foreign, 'utf8'), /our own plan skill/);
});

test('include/exclude select skills', () => {
  const dir = repo();
  installSkills(dir, cfg({ skills: { include: ['open-pr', 'review-change'], exclude: ['review-change'] } }));
  assert.ok(existsSync(join(dir, '.claude/skills/open-pr/SKILL.md')));
  assert.ok(!existsSync(join(dir, '.claude/skills/review-change')));
  assert.throws(() => installSkills(dir, cfg({ skills: { include: ['nope'] } })), /unknown skills: nope/);
  const block = agentsBlock(cfg({ skills: { include: ['evidence-rules'] } }));
  assert.match(block, /evidence-rules/);
  assert.doesNotMatch(block, /\b(open-pr|ship-change)\b/, 'never points agents at a skill that is not installed');
});

test('AGENTS.md block is inserted once, replaced in place, and leaves the rest alone', () => {
  const dir = repo();
  write(dir, { 'AGENTS.md': '# Project\n\nOur rules.\n' });
  installAgentsMd(dir, cfg());
  const once = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(once, /^# Project\n\nOur rules\.\n\n<!-- hyvemind:begin/);
  assert.match(once, /`npm test`/);
  installAgentsMd(dir, cfg({ gates: [{ name: 'ci', run: 'npm run ci' }] }));
  const twice = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(twice.split(BLOCK_END).length - 1, 1);
  assert.match(twice, /`npm run ci`/);
  assert.doesNotMatch(twice, /`npm test`/);
  assert.match(upsertBlock('x\n' + BLOCK_BEGIN + '\nold\n' + BLOCK_END + '\ny\n', 'NEW'), /^x\nNEW\ny\n$/);
});

test('externalGate: the AGENTS.md block points at the project gate and claims no second done', () => {
  const c = resolveConfig({ version: 1, externalGate: { run: 'node scripts/local-ci.mjs --pr <n> --post', done: 'the `ci/local-verify` status is success on the PR head' }, skills: { include: ['write-spec', 'plan-tasks'] } });
  const block = agentsBlock(c);
  assert.match(block, /this project's own `node scripts\/local-ci\.mjs --pr <n> --post`\. hyvemind does not run or replace it/);
  assert.match(block, /Done means:\*\* the `ci\/local-verify` status is success/);
  assert.doesNotMatch(block, /hyvemind@[\d.]+ (gate|evidence)/);
  assert.throws(() => resolveConfig({ version: 1, externalGate: { run: 'x', done: 'y' }, gates: [{ name: 'a', run: 'b' }] }), /mutually exclusive/);
  assert.throws(() => resolveConfig({ version: 1, externalGate: { run: 'x' } }), /externalGate needs/);
});

test('update removes skills it installed but no longer produces; edited ones are kept and reported', () => {
  const dir = repo();
  installSkills(dir, cfg({ skills: { prefix: 'bee-' } })); // an install from the prefixed era
  const edited = join(dir, '.claude/skills/bee-open-pr/SKILL.md');
  writeFileSync(edited, readFileSync(edited, 'utf8') + '\nour note\n');
  const actions = installSkills(dir, cfg()); // no prefix now
  assert.ok(!existsSync(join(dir, '.claude/skills/bee-write-spec')), 'untouched old skill removed, dir included');
  assert.ok(existsSync(join(dir, '.claude/skills/write-spec/SKILL.md')), 'new name installed');
  assert.ok(existsSync(edited), 'edited old skill kept');
  assert.equal(actions.find((a) => a.rel === '.claude/skills/bee-open-pr/SKILL.md').action, 'orphan-modified');
  assert.ok(actions.some((a) => a.rel === '.claude/skills/bee-write-spec/SKILL.md' && a.action === 'remove'));
});
