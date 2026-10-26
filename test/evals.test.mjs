import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveConfig } from '../src/config.mjs';
import { argv, renderReport, runEvals, score, verdict } from '../src/evals.mjs';
import { repo, write } from './helpers.mjs';

// Fake agents: one that succeeds only when the skill is installed in its workspace,
// one that always succeeds (a model that no longer needs the skill).
const NEEDS_SKILL = `const fs=require('fs');console.log(fs.existsSync('.claude/skills/bee-pr/SKILL.md')?'ANSWER: right':'ANSWER: wrong')`;
const ALWAYS = `console.log('ANSWER: right')`;

const SCENARIO = JSON.stringify({ id: 'one', prompt: 'hi', checks: [{ type: 'output-includes', text: 'ANSWER: right' }] });
function project(skill) {
  const dir = repo();
  write(dir, { [`.hyve/scenarios/${skill}/one.json`]: SCENARIO });
  return dir;
}
const cfg = (code, includeBundled = true) => resolveConfig({
  version: 1,
  skills: { include: ['pr'] },
  evals: { agent: 'fake', agents: { fake: { command: ['node', '-e', code, '{prompt}'] } }, trials: 2, includeBundled },
});

test('lift is with-skill minus bare; a skill the model needs is "earning"', async () => {
  const dir = project('pr');
  const { report, file } = await runEvals(dir, cfg(NEEDS_SKILL), { skills: ['pr'], trials: 2, concurrency: 4 });
  const pr = report.skills[0];
  assert.ok(pr.scenarios >= 2, 'bundled + project scenarios both load');
  const projectRuns = pr.runs.filter((r) => r.scenario === 'one');
  assert.deepEqual(projectRuns.map((r) => `${r.arm}:${r.pass}`), ['bare:false', 'skill:true', 'bare:false', 'skill:true']);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).skills[0].runs.length > 0);
});

test('a model that passes bare gets lift 0 and "retire-candidate"; the report says what to do', async () => {
  const dir = project('review');
  const { report } = await runEvals(dir, cfg(ALWAYS, false), { skills: ['review'], trials: 3 });
  assert.equal(report.skills[0].bare, 1);
  assert.equal(report.skills[0].lift, 0);
  assert.equal(report.skills[0].verdict, 'retire-candidate');
  const md = renderReport(report);
  assert.match(md, /\| review \| 1 \| 3 \| 100% \| 100% \| 0 \| \*\*retire-candidate\*\* \|/);
  assert.match(md, /- \*\*review\*\* \(retire-candidate\): Propose retiring/);
  assert.match(md, /\| review \| one \| 3\/3 \| 3\/3 \|/);
});

test('verdict thresholds, argv placeholders, and check types', () => {
  assert.equal(verdict(0.25, 0.2), 'earning');
  assert.equal(verdict(0.1, 0.2), 'marginal');
  assert.equal(verdict(-0.1, 0.2), 'retire-candidate');
  assert.equal(verdict(0, 0.2, 2, 3), 'insufficient-data', 'too few runs never recommends retiring');
  assert.equal(verdict(0, 0.2, 6, 3, 0), 'no-signal', '0% in both arms is a broken scenario, not an obsolete skill');
  assert.equal(verdict(0, 0.2, 6, 3, 1), 'retire-candidate');
  assert.deepEqual(argv(['x', '--m', '{model}', '{prompt}'], { prompt: 'p', model: 'm1' }), ['x', '--m', 'm1', 'p']);
  assert.throws(() => argv(['{model}'], { prompt: 'p' }), /--model/);
  const dir = repo({ 'f.txt': '' });
  const s = score([
    { type: 'output-includes', text: 'a' }, { type: 'output-excludes', text: 'z' },
    { type: 'output-matches', pattern: 'A', flags: 'i' }, { type: 'file-exists', path: 'f.txt' },
    { type: 'command', run: 'test -f f.txt' }, { type: 'command', run: 'false' },
    { type: 'output-not-matches', pattern: 'stash' }, { type: 'output-not-matches', pattern: '^a$' },
  ], 'a', dir);
  assert.deepEqual(s.map((x) => x.pass), [true, true, true, true, true, false, true, false]);
});
