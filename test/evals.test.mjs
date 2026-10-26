import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveConfig } from '../src/config.mjs';
import { argv, liftInterval, renderReport, runEvals, score, verdict, wilson } from '../src/evals.mjs';
import { repo, write } from './helpers.mjs';

// Fake agents: one that succeeds only when the skill is installed in its workspace,
// one that always succeeds (a model that no longer needs the skill).
const NEEDS_SKILL = `const fs=require('fs');console.log(fs.existsSync('.claude/skills/open-pr/SKILL.md')?'ANSWER: right':'ANSWER: wrong')`;
const ALWAYS = `console.log('ANSWER: right')`;

const SCENARIO = JSON.stringify({ id: 'one', prompt: 'hi', checks: [{ type: 'output-includes', text: 'ANSWER: right' }] });
function project(skill) {
  const dir = repo();
  write(dir, { [`.hyve/scenarios/${skill}/one.json`]: SCENARIO });
  return dir;
}
const cfg = (code, includeBundled = true) => resolveConfig({
  version: 1,
  skills: { include: ['open-pr'] },
  evals: { agent: 'fake', agents: { fake: { command: ['node', '-e', code, '{prompt}'] } }, trials: 2, includeBundled },
});

test('lift is with-skill minus bare; a skill the model needs is "earning"', async () => {
  const dir = project('open-pr');
  const { report, file } = await runEvals(dir, cfg(NEEDS_SKILL), { skills: ['open-pr'], trials: 2, concurrency: 4 });
  const pr = report.skills[0];
  assert.ok(pr.scenarios >= 2, 'bundled + project scenarios both load');
  const projectRuns = pr.runs.filter((r) => r.scenario === 'one');
  assert.deepEqual(projectRuns.map((r) => `${r.arm}:${r.pass}`), ['bare:false', 'skill:true', 'bare:false', 'skill:true']);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).skills[0].runs.length > 0);
});

test('a model that passes bare in every run is "saturated", not retire-candidate; the report says what to do', async () => {
  const dir = project('review-change');
  const { report } = await runEvals(dir, cfg(ALWAYS, false), { skills: ['review-change'], trials: 3 });
  assert.equal(report.skills[0].bare, 1);
  assert.equal(report.skills[0].lift, 0);
  assert.equal(report.skills[0].verdict, 'saturated');
  assert.ok(report.skills[0].size.words > 100, 'the rendered skill size is recorded');
  assert.equal(report.skills[0].size.approxTokens, Math.round(report.skills[0].size.words * 1.3));
  const md = renderReport(report);
  assert.match(md, /\| review-change \| 1 \| 3 \| 100% \[44–100%\] \| 100% \[44–100%\] \| 0 \[-0\.56, \+0\.56\] \| \d+ \(≈\d+\) \| \*\*saturated\*\* \|/);
  assert.match(md, /- \*\*review-change\*\* \(saturated\): Unmeasured below ceiling/);
  assert.match(md, /\| review-change \| one \| 3\/3 \| 3\/3 \| 0 \| — \|/);
  assert.doesNotMatch(md, /Look at these first/);
});

// Branches on the prompt: "harm" passes only WITHOUT the skill, "never" never passes.
const MIXED = `const fs=require('fs');const has=fs.existsSync('.claude/skills/write-spec/SKILL.md');const p=process.argv[1];
console.log(p==='harm'?(has?'ANSWER: wrong':'ANSWER: right'):p==='never'?'nope':(has?'ANSWER: right':'ANSWER: wrong'))`;

test('per-scenario rows flag a harmful scenario and a no-signal scenario the skill average hides', async () => {
  const dir = repo();
  const sc = (id, prompt) => JSON.stringify({ id, prompt, checks: [{ type: 'output-includes', text: 'ANSWER: right' }] });
  write(dir, { '.hyve/scenarios/write-spec/a.json': sc('helps', 'help'), '.hyve/scenarios/write-spec/b.json': sc('hurts', 'harm'), '.hyve/scenarios/write-spec/c.json': sc('broken', 'never') });
  const { report } = await runEvals(dir, cfg(MIXED, false), { skills: ['write-spec'], trials: 3, concurrency: 4 });
  const s = report.skills[0];
  assert.equal(s.lift, 0, 'one helping and one harmful scenario cancel out at the skill level');
  const by = Object.fromEntries(s.byScenario.map((r) => [r.id, r]));
  assert.deepEqual(by.hurts.flags, ['harmful']);
  assert.deepEqual([by.hurts.bare, by.hurts.skill], [{ pass: 3, runs: 3 }, { pass: 0, runs: 3 }]);
  assert.deepEqual(by.broken.flags, ['no-signal']);
  assert.deepEqual(by.helps.flags, []);
  assert.equal(by.helps.lift, 1);
  const md = renderReport(report);
  const top = md.slice(0, md.indexOf('| Skill |'));
  assert.match(top, /write-spec · `hurts`: bare 3\/3, with skill 0\/3\. \*\*harmful\*\*/);
  assert.match(top, /write-spec · `broken`: .*\*\*no-signal\*\*/);
  assert.match(md, /\| write-spec \| hurts \| 3\/3 \| 0\/3 \| -1 \| harmful \|/);
});

test('--render of an old report (no per-scenario rows, old verdicts) recomputes them from its runs', () => {
  const run = (scenario, arm, pass) => ({ scenario, trial: 1, arm, pass, checks: [] });
  const old = { agent: 'claude', version: '0.2.0', startedAt: 'then', skills: [{
    skill: 'x', scenarios: 1, bare: 1, withSkill: 1, trials: 3, lift: 0, verdict: 'retire-candidate',
    runs: [1, 2, 3].flatMap(() => [run('s', 'bare', true), run('s', 'skill', true)]),
  }] };
  const md = renderReport(old, { liftThreshold: 0.2, minRuns: 3 });
  assert.match(md, /\*\*saturated\*\*/);
  assert.doesNotMatch(md, /retire-candidate/);
  assert.match(md, /\| x \| s \| 3\/3 \| 3\/3 \| 0 \| — \|/);
  assert.match(md, /\| — \| \*\*saturated\*\* \|/, 'an old report has no size: shown as —');
});

test('Wilson and Newcombe intervals match published values; earning needs the lift interval to clear 0 (low n)', () => {
  // Newcombe (1998), Table II example: 56/70 vs 48/80 → method 10 gives 0.0524 to 0.3339.
  const [lo, hi] = liftInterval({ pass: 56, runs: 70 }, { pass: 48, runs: 80 });
  assert.equal(+lo.toFixed(4), 0.0524);
  assert.equal(+hi.toFixed(4), 0.3339);
  assert.deepEqual(wilson(0, 3).map((x) => +x.toFixed(4)), [0, 0.5615]);
  assert.deepEqual(wilson(3, 3).map((x) => +x.toFixed(4)), [0.4385, 1]);
  // 3/3 vs 0/3 clears 0; 3/3 vs 1/3 (lift +0.67) does not: one flipped run could explain it.
  assert.ok(liftInterval({ pass: 3, runs: 3 }, { pass: 0, runs: 3 })[0] > 0);
  assert.equal(verdict(0.667, 0.2, 3, 3, 1, 1 / 3, liftInterval({ pass: 3, runs: 3 }, { pass: 1, runs: 3 })[0]), 'earning (low n)');
  assert.equal(verdict(1, 0.2, 3, 3, 1, 0, 0.206), 'earning');
});

test('verdict thresholds, argv placeholders, and check types', () => {
  assert.equal(verdict(0.25, 0.2), 'earning');
  assert.equal(verdict(0.1, 0.2), 'marginal');
  assert.equal(verdict(-0.1, 0.2), 'retire-candidate');
  assert.equal(verdict(0, 0.2, 2, 3), 'insufficient-data', 'too few runs never recommends retiring');
  assert.equal(verdict(0, 0.2, 6, 3, 0), 'no-signal', '0% in both arms is a broken scenario, not an obsolete skill');
  assert.equal(verdict(0, 0.2, 6, 3, 1, 1), 'saturated', '100% in both arms cannot measure the skill');
  assert.equal(verdict(0, 0.2, 6, 3, 0.5, 0.5), 'retire-candidate', 'no lift below the ceiling');
  assert.equal(verdict(-0.33, 0.2, 6, 3, 0.67, 1), 'retire-candidate', 'worse than a perfect bare arm');
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
