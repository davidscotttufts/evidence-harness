import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { bundledSkills } from '../src/install.mjs';
import { agentArgv, agentEnv, argv, contradictions, dictatedLines, lintScenario, lintScenarios, historicalMedian, liftInterval, parseTargets, planEvals, preview, renderPreview, renderReport, runEvals, score, verdict, versionStamp, wilson } from '../src/evals.mjs';
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

test('agents get an allowlisted env, never the whole process.env; per-agent env names opt in', () => {
  const from = { PATH: '/bin', HOME: '/h', LC_ALL: 'C', LANG: 'en', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 's', MY_AGENT_AUTH: 'k' };
  assert.deepEqual(agentEnv({}, 'bare', from), { PATH: '/bin', HOME: '/h', LC_ALL: 'C', LANG: 'en', HYVE_EVAL_ARM: 'bare' });
  assert.deepEqual(agentEnv({ env: ['MY_AGENT_AUTH'] }, 'skill', from).MY_AGENT_AUTH, 'k');
  assert.equal(agentEnv({ env: ['MY_AGENT_AUTH'] }, 'skill', from).GITHUB_TOKEN, undefined);
  assert.equal(agentEnv({ cleanEnv: { X: '1' } }, 'bare', from, true).X, '1');
  assert.equal(agentEnv({ cleanEnv: { X: '1' } }, 'bare', from, false).X, undefined);
  const claude = resolveConfig({ version: 1 }).evals.agents.claude;
  assert.equal(claude.env, undefined, 'no vendor secret is passed through by default');
  assert.deepEqual(agentArgv(claude, { prompt: 'p' }, true).slice(0, 4), ['claude', '--setting-sources', 'project,local', '--strict-mcp-config']);
  assert.deepEqual(agentArgv(claude, { prompt: 'p' }, false).slice(0, 3), ['claude', '-p', 'p']);
});

test('a run never leaks a secret from the parent env to the agent, in either arm', async () => {
  process.env.HYVE_TEST_SECRET = 'leak-me';
  try {
    const dir = project('open-pr');
    const LEAK = `console.log(process.env.HYVE_TEST_SECRET||!process.env.HYVE_EVAL_ARM?'ANSWER: wrong':'ANSWER: right')`;
    const { report } = await runEvals(dir, cfg(LEAK, false), { skills: ['open-pr'], trials: 1 });
    assert.deepEqual(report.skills[0].runs.map((r) => r.pass), [true, true]);
  } finally { delete process.env.HYVE_TEST_SECRET; }
});

test('--clean-profile puts cleanArgs and cleanEnv in BOTH arms, and refuses an agent without cleanArgs', async () => {
  const dir = project('open-pr');
  const CLEAN = `console.log(process.execArgv.includes('--no-warnings')&&process.env.HYVE_CLEAN==='1'?'ANSWER: right':'ANSWER: wrong')`;
  const c = resolveConfig({ version: 1, skills: { include: ['open-pr'] }, evals: { agent: 'fake', includeBundled: false, agents: { fake: { command: ['node', '-e', CLEAN, '{prompt}'], cleanArgs: ['--no-warnings'], cleanEnv: { HYVE_CLEAN: '1' } } } } });
  const on = await runEvals(dir, c, { skills: ['open-pr'], trials: 1, cleanProfile: true });
  assert.deepEqual(on.report.skills[0].runs.map((r) => `${r.arm}:${r.pass}`), ['bare:true', 'skill:true']);
  assert.equal(on.report.cleanProfile, true);
  assert.match(renderReport(on.report), /Ran with --clean-profile/);
  const off = await runEvals(dir, c, { skills: ['open-pr'], trials: 1 });
  assert.deepEqual(off.report.skills[0].runs.map((r) => r.pass), [false, false]);
  await assert.rejects(runEvals(dir, cfg(ALWAYS, false), { skills: ['open-pr'], trials: 1, cleanProfile: true }), /has no cleanArgs/);
});

test('a {clean} placeholder puts cleanArgs after a subcommand with --clean-profile and drops out without it', async () => {
  const codex = resolveConfig({ version: 1 }).evals.agents.codex;
  assert.deepEqual(agentArgv(codex, { prompt: 'p' }, true), ['codex', 'exec', '--ignore-user-config', '--ephemeral', '--ignore-rules', 'p']);
  assert.deepEqual(agentArgv(codex, { prompt: 'p' }, false), ['codex', 'exec', 'p']);
  assert.deepEqual(resolveConfig({ version: 1 }).evals.agents.opencode.cleanArgs, undefined, 'opencode --pure only drops plugins: no cleanArgs');
  // Without {clean}, today's placement (right after the executable) is kept.
  assert.deepEqual(agentArgv({ command: ['x', 'sub', '{prompt}'], cleanArgs: ['--c'] }, { prompt: 'p' }, true), ['x', '--c', 'sub', 'p']);
  assert.deepEqual(agentArgv({ command: ['x', 'sub', '{clean}', '{prompt}'] }, { prompt: 'p' }, true), ['x', 'sub', 'p']);
  // A real run: node, like codex, rejects these flags before its "subcommand" (the -e
  // script), so the fake agent passes only when they land after it, in order, in BOTH arms.
  const dir = project('open-pr');
  const SUB = `const a=process.argv.slice(1);console.log(JSON.stringify(a)===JSON.stringify(process.env.HYVE_WANT==='clean'?['exec','--ignore-user-config','--ephemeral','hi']:['exec','hi'])?'ANSWER: right':'ANSWER: wrong')`;
  const c = (want) => resolveConfig({ version: 1, skills: { include: ['open-pr'] }, evals: { agent: 'fake', includeBundled: false, agents: { fake: { command: ['node', '-e', SUB, 'exec', '{clean}', '{prompt}'], cleanArgs: ['--ignore-user-config', '--ephemeral'], cleanEnv: { HYVE_WANT: want } } } } });
  write(dir, { '.hyve/scenarios/open-pr/one.json': JSON.stringify({ id: 'one', prompt: 'hi', checks: [{ type: 'output-includes', text: 'ANSWER: right' }] }) });
  const on = await runEvals(dir, c('clean'), { skills: ['open-pr'], trials: 1, cleanProfile: true });
  assert.deepEqual(on.report.skills[0].runs.map((r) => `${r.arm}:${r.pass}`), ['bare:true', 'skill:true']);
  const off = await runEvals(dir, c('clean'), { skills: ['open-pr'], trials: 1 });
  assert.deepEqual(off.report.skills[0].runs.map((r) => `${r.arm}:${r.pass}`), ['bare:true', 'skill:true'], 'without --clean-profile {clean} expands to nothing');
  // {clean} is a whole argument after the executable, never the executable or part of one.
  const bad = (command) => () => resolveConfig({ version: 1, evals: { agents: { claude: { command } } } });
  assert.throws(bad(['{clean}', '{prompt}']), /\{clean\} must be a whole argument/);
  assert.throws(bad(['x', '--flag={clean}', '{prompt}']), /\{clean\} must be a whole argument/);
});

test('failed runs keep their full output under .hyve/evals/<run-id>/; passes only with keep; tail is 2,000 chars', async () => {
  const dir = project('open-pr');
  const LOUD = `const fs=require('fs');console.log('x'.repeat(5000));console.log(fs.existsSync('.claude/skills/open-pr/SKILL.md')?'ANSWER: right':'ANSWER: wrong')`;
  const { report } = await runEvals(dir, cfg(LOUD, false), { skills: ['open-pr'], trials: 1 });
  const [bare, skill] = report.skills[0].runs;
  assert.equal(bare.output, join('.hyve', 'evals', report.runId, 'open-pr', 'one', 'bare-1.txt'));
  assert.ok(readFileSync(join(dir, bare.output), 'utf8').length > 5000, 'the full output, not a tail');
  assert.equal(bare.tail.length, 2000);
  assert.equal(skill.output, undefined, 'a pass keeps nothing by default');
  assert.match(renderReport(report, {}, { linkBase: '..' }), new RegExp(`open-pr · one · bare trial 1: \\[output\\]\\(\\.\\./\\.hyve/evals/${report.runId}/open-pr/one/bare-1\\.txt\\)`));
  const kept = await runEvals(dir, cfg(LOUD, false), { skills: ['open-pr'], trials: 1, keep: true });
  assert.ok(existsSync(join(dir, kept.report.skills[0].runs[1].output)), '--keep keeps passes too');
});

test('skill:scenario and --scenario select single scenarios; a filter that matches nothing is an error', () => {
  assert.deepEqual(parseTargets(['write-spec:a', 'write-spec:b', 'grade']), [{ skill: 'write-spec', ids: ['a', 'b'] }, { skill: 'grade', ids: null }]);
  assert.deepEqual(parseTargets(['grade'], ['x']), [{ skill: 'grade', ids: ['x'] }]);
  const dir = repo();
  write(dir, { '.hyve/scenarios/open-pr/one.json': SCENARIO, '.hyve/scenarios/open-pr/two.json': SCENARIO.replace('"one"', '"two"') });
  const c = cfg(ALWAYS, false);
  const plan = planEvals(dir, c, { skills: parseTargets(['open-pr:two']), trials: 2 });
  assert.deepEqual([...new Set(plan.jobs.map((j) => j.sc.id))], ['two']);
  assert.equal(plan.jobs.length, 4);
  assert.throws(() => planEvals(dir, c, { skills: parseTargets(['open-pr:nope']) }), /no scenario nope \(have: one, two\)/);
});

test('cost preview: runs × arms × trials, concurrency, a timeout upper bound and a historical median', () => {
  const dir = repo();
  write(dir, { '.hyve/scenarios/open-pr/one.json': SCENARIO });
  const c = cfg(ALWAYS, false);
  const plan = planEvals(dir, c, { skills: ['open-pr'], trials: 3 });
  assert.equal(historicalMedian(dir), null);
  const p = preview(plan, c, { concurrency: 4 });
  assert.deepEqual([p.skills, p.scenarios, p.trials, p.arms, p.runs, p.concurrency, p.upperBoundSec, p.estimateSec], [1, 1, [3], 2, 6, 4, 2 * 600, null]);
  assert.match(renderPreview(p), /1 skill\(s\) · 1 scenario\(s\) · 3 trial\(s\) × 2 arms = 6 agent runs \(fake\) · concurrency 4/);
  assert.match(renderPreview(p), /at most 20 min/);
  write(dir, { '.hyve/evals/report-a.json': JSON.stringify({ skills: [{ runs: [{ ms: 1000 }, { ms: 30000 }, { ms: 90000 }] }] }) });
  const h = historicalMedian(dir);
  assert.equal(h.sec, 30);
  assert.equal(preview(plan, c, { concurrency: 4, history: h }).estimateSec, 60);
});

test('reports are stamped version+sha[-dirty] from a git checkout, the plain version from a package', () => {
  const v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.match(versionStamp(), new RegExp(`^${v.replace(/\./g, '\\.')}\\+[0-9a-f]{7,}(-dirty)?$`));
  assert.equal(versionStamp(mkdtempSync(join(tmpdir(), 'hyve-pkg-'))), v);
});

test('every bundled scenario lints: each good passes all checks, each bad fails one, none unlinted', () => {
  const r = lintScenarios(mkdtempSync(join(tmpdir(), 'hyve-lint-')), resolveConfig({ version: 1 }), bundledSkills());
  assert.ok(r.counts.scenarios >= 50);
  assert.deepEqual(r.rows.filter((x) => x.errors.length).map((x) => `${x.skill}/${x.id}: ${x.errors.join('; ')}`), []);
  assert.equal(r.counts.unlinted, 0, 'every bundled scenario carries good and bad examples');
});

test('lint: a good that fails a check, or a bad that passes every check, is an error; no examples is unlinted', () => {
  const checks = [{ type: 'output-matches', pattern: 'ANSWER:\\s*no\\b' }];
  assert.deepEqual(lintScenario({ id: 'x', prompt: 'p', checks, good: 'ANSWER: no', bad: 'ANSWER: yes' }).errors, []);
  assert.match(lintScenario({ id: 'x', prompt: 'p', checks, good: 'ANSWER: yes', bad: 'ANSWER: yes' }).errors.join(), /good fails output-matches/);
  assert.match(lintScenario({ id: 'x', prompt: 'p', checks, good: 'ANSWER: no', bad: ['ANSWER: yes', 'ANSWER: no'] }).errors.join(), /bad\[1\] passes every check/);
  assert.match(lintScenario({ id: 'x', prompt: 'p', checks, good: 'ANSWER: no' }).errors.join(), /good without bad/);
  const none = lintScenario({ id: 'x', prompt: 'p', checks });
  assert.deepEqual([none.linted, none.errors], [false, []]);
  const partial = lintScenario({ id: 'x', prompt: 'p', checks: [...checks, { type: 'command', run: 'true' }], good: 'ANSWER: no', bad: 'ANSWER: yes' });
  assert.match(partial.partial, /command check\(s\) need the agent's workspace/);
  assert.deepEqual(partial.errors, []);
});

test('lint: a placeholder line whose verbatim echo passes the checks is a placeholder-echo-passes error', () => {
  const prompt = "End your answer with exactly one line of the form 'GRADE: <letter>'.";
  // Any non-space token after "GRADE:" passes, including the placeholder "<letter>" itself.
  const loose = contradictions({ prompt, checks: [{ type: 'output-matches', pattern: 'GRADE:\\s*\\S+' }] });
  assert.match(loose.errors.join(), /placeholder-echo-passes: "GRADE: <letter>" printed verbatim passes/);
  assert.match(lintScenario({ id: 'x', prompt, checks: [{ type: 'output-matches', pattern: 'GRADE:\\s*\\S+' }], good: 'GRADE: F', bad: 'nothing' }).errors.join(), /placeholder-echo-passes/);
  // A check that wants a real letter rejects the echo: no error.
  assert.deepEqual(contradictions({ prompt, checks: [{ type: 'output-matches', pattern: 'GRADE:\\s*F\\b' }] }), { errors: [], warnings: [] });
  // Each line of a two-label template is checked on its own label.
  const two = contradictions({ prompt: 'Be brief, then end with exactly two lines: PUSH: <ask or go>  and  PR: <ask or go>', checks: [{ type: 'output-matches', pattern: 'PUSH:\\s*ask' }, { type: 'output-includes', text: 'PR:' }] });
  assert.deepEqual(two.errors, ['placeholder-echo-passes: "PR: <ask or go>" printed verbatim passes the checks on PR:, so they can\'t tell copying the placeholder from answering']);
});

test('lint flags a prompt that dictates a line its own checks reject (the contradiction check)', () => {
  const checks = [{ type: 'output-matches', pattern: 'GRADE:\\s*unverified\\b', flags: 'i' }];
  assert.deepEqual(dictatedLines('Be brief, then end with exactly two lines: PUSH: ask | go  and  PR: ask | go').map((d) => [d.label, d.alternatives]), [['PUSH', ['ask', 'go']], ['PR', ['ask', 'go']]]);
  assert.deepEqual(dictatedLines("End with exactly one line: SCOPE-STATED: yes  or  SCOPE-STATED: no, then nothing else.")[0].alternatives, ['yes', 'no']);
  assert.equal(dictatedLines("End your answer with exactly one line of the form 'GRADE: <letter>'.")[0].template, true);
  // Dictated word for word: obeying the prompt fails the scenario.
  assert.match(contradictions({ prompt: 'End with exactly one line: GRADE: A', checks }).errors.join(), /dictates "GRADE: A", which fails its own checks/);
  // A menu with no passing answer.
  assert.match(contradictions({ prompt: 'End with exactly one line: GRADE: A | B', checks }).errors.join(), /no answer the prompt offers/);
  // Round 2's docs-are-not-the-code: the model echoed "GRADE: A | unverified" verbatim in every run.
  const old = contradictions({ prompt: 'Be brief, then end with exactly one line: GRADE: A | unverified', checks });
  assert.deepEqual(old.errors, []);
  assert.match(old.warnings.join(), /menu-echo: "GRADE: A \| unverified" printed verbatim fails/);
  assert.deepEqual(contradictions({ prompt: 'End with exactly one line: GRADE: <the letter, or unverified>', checks }), { errors: [], warnings: [] });
  // A forbidden pattern the prompt itself dictates.
  assert.match(contradictions({ prompt: 'End with exactly one line: CMD: git add -A', checks: [{ type: 'output-not-matches', pattern: 'git add -A' }] }).errors.join(), /fails its own checks/);
});
