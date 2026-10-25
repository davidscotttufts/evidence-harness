import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { BLOCK_BEGIN, BLOCK_END, agentsBlock, bundledSkills, installAgentsMd, installSkills, render, upsertBlock } from '../src/install.mjs';
import { repo, write } from './helpers.mjs';

const cfg = (over = {}) => resolveConfig({ version: 1, gates: [{ name: 'test', run: 'npm test' }], ...over });

test('render prefixes the skill name and resolves cross-references', () => {
  const out = render('---\nname: ship\n---\nthen run {{skill:review}} and {{skill:pr}}', 'ship', 'bee-');
  assert.match(out, /^name: bee-ship$/m);
  assert.match(out, /run bee-review and bee-pr/);
  assert.doesNotMatch(out, /\{\{skill:/);
});

test('{{cli}} renders to the configured command in skills and the AGENTS.md block', () => {
  assert.equal(render('run `{{cli}} gate`', 'pr', 'bee-', 'npx -y hyvemind@9.9.9'), 'run `npx -y hyvemind@9.9.9 gate`');
  const dir = repo();
  const c = cfg({ cli: 'npx hyvemind' });
  installSkills(dir, c);
  installAgentsMd(dir, c);
  assert.match(readFileSync(join(dir, '.claude/skills/bee-pr/SKILL.md'), 'utf8'), /`npx hyvemind evidence`/);
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /`npx hyvemind gate`/);
  for (const s of bundledSkills()) {
    assert.doesNotMatch(readFileSync(join(dir, '.claude/skills', `bee-${s}`, 'SKILL.md'), 'utf8'), /\{\{cli\}\}/, s);
  }
});

test('every bundled skill renders with no unresolved tokens and a description', () => {
  for (const s of bundledSkills()) {
    const text = render(readFileSync(new URL(`../skills/${s}/SKILL.md`, import.meta.url), 'utf8'), s, 'bee-');
    assert.match(text, new RegExp(`^name: bee-${s}$`, 'm'), s);
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
    assert.ok(existsSync(join(dir, '.claude/skills', `bee-${s}`, 'SKILL.md')), s);
    assert.ok(existsSync(join(dir, '.agents/skills', `bee-${s}`, 'SKILL.md')), s);
  }
  assert.ok(!existsSync(join(dir, '.claude/skills/bee-pr/evals')), 'eval scenarios are not installed');
  assert.ok(installSkills(dir, c).every((a) => a.action === 'same'));
});

test('update keeps a skill the project edited, and one that existed before hyvemind', () => {
  const dir = repo({ '.claude/skills/bee-plan/SKILL.md': 'our own plan skill\n' });
  const c = cfg();
  installSkills(dir, c);
  const foreign = join(dir, '.claude/skills/bee-plan/SKILL.md');
  assert.equal(readFileSync(foreign, 'utf8'), 'our own plan skill\n');

  const edited = join(dir, '.claude/skills/bee-review/SKILL.md');
  writeFileSync(edited, readFileSync(edited, 'utf8') + '\nlocal rule\n');
  const plan = installSkills(dir, c);
  assert.equal(plan.find((a) => a.rel.endsWith('bee-review/SKILL.md') && a.rel.startsWith('.claude')).action, 'modified');
  assert.equal(plan.find((a) => a.rel === '.claude/skills/bee-plan/SKILL.md').action, 'foreign');
  assert.match(readFileSync(edited, 'utf8'), /local rule/);

  installSkills(dir, c, { force: true });
  assert.doesNotMatch(readFileSync(edited, 'utf8'), /local rule/);
  assert.doesNotMatch(readFileSync(foreign, 'utf8'), /our own plan skill/);
});

test('include/exclude select skills', () => {
  const dir = repo();
  installSkills(dir, cfg({ skills: { include: ['pr', 'review'], exclude: ['review'] } }));
  assert.ok(existsSync(join(dir, '.claude/skills/bee-pr/SKILL.md')));
  assert.ok(!existsSync(join(dir, '.claude/skills/bee-review')));
  assert.throws(() => installSkills(dir, cfg({ skills: { include: ['nope'] } })), /unknown skills: nope/);
  const block = agentsBlock(cfg({ skills: { include: ['evidence'] } }));
  assert.match(block, /bee-evidence/);
  assert.doesNotMatch(block, /bee-(pr|ship)\b/, 'never points agents at a skill that is not installed');
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
