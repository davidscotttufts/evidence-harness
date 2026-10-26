import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import { chooseAgent, disagreements, historicalMedian, installed, loggedIn, matrixPreview, planEvals, preview, renderPreview, renderReport, runMatrix, selectAgents } from '../src/evals.mjs';
import { repo, write } from './helpers.mjs';

// Two fake agent binaries that behave differently on the same scenario:
// "strong" answers right with or without the skill (the skill is saturated on it),
// "weak" answers right only when the skill is installed (the skill earns its place).
const BIN_DIR = mkdtempSync(join(tmpdir(), 'hyve-fake-agents-'));
function fakeAgent(name, body) {
  const file = join(BIN_DIR, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const STRONG = fakeAgent('hyve-fake-strong', `console.log('ANSWER: right')`);
const WEAK = fakeAgent('hyve-fake-weak', `const fs=require('fs');console.log(fs.existsSync('.claude/skills/open-pr/SKILL.md')?'ANSWER: right':'ANSWER: wrong')`);

const SCENARIO = JSON.stringify({ id: 'one', prompt: 'hi', checks: [{ type: 'output-includes', text: 'ANSWER: right' }] });
const AGENTS = {
  strong: { command: [STRONG, '{prompt}'] },
  weak: { command: [WEAK, '{prompt}'] },
  ghost: { command: ['hyve-agent-that-is-not-installed', '{prompt}'] },
};
const cfg = () => resolveConfig({ version: 1, skills: { include: ['open-pr'] }, evals: { agent: 'strong', agents: AGENTS, trials: 3, includeBundled: false } });
function project() {
  const dir = repo();
  write(dir, { '.hyve/scenarios/open-pr/one.json': SCENARIO });
  return dir;
}

test('matrix: each agent gets its own runs, verdicts and intervals; nothing is pooled across agents', async () => {
  const dir = project();
  const c = cfg();
  const { report, file } = await runMatrix(dir, c, { agents: ['strong', 'weak'], skills: ['open-pr'], trials: 3, concurrency: 2 });
  assert.deepEqual(report.agents.map((a) => a.agent), ['strong', 'weak']);
  const [strong, weak] = report.agents.map((a) => a.skills[0]);
  assert.equal(strong.runs.length, 6, 'strong ran only its own 3 trials × 2 arms');
  assert.equal(weak.runs.length, 6, 'weak ran only its own 3 trials × 2 arms');
  assert.deepEqual([strong.bare, strong.withSkill, strong.verdict], [1, 1, 'saturated']);
  assert.deepEqual([weak.bare, weak.withSkill, weak.lift, weak.verdict], [0, 1, 1, 'earning'], 'a pooled bare rate would be 0.5, not 0');
  assert.deepEqual(weak.ci.bare, [0, 0.562]);
  assert.deepEqual(strong.ci.bare, [0.438, 1]);
  // Failed runs are kept per agent, so two agents never overwrite each other's outputs.
  assert.ok(weak.runs.filter((r) => !r.pass).every((r) => r.output.startsWith(join('.hyve', 'evals', report.runId, 'weak', 'open-pr'))));
  assert.ok(existsSync(join(dir, weak.runs.find((r) => !r.pass).output)));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.matrix, true);
  assert.deepEqual(saved.agents.map((a) => a.skills[0].runs.length), [6, 6]);
  // The next preview estimates each agent from its own past runs.
  assert.equal(historicalMedian(dir, 'weak').runs, 6);
  assert.equal(historicalMedian(dir).runs, 12);
});

test('matrix: agents whose binary is not installed are skipped with the reason, never run', () => {
  const c = resolveConfig({ version: 1, evals: { agent: 'strong', agents: { strong: { command: ['hyve-fake-strong', '{prompt}'] }, ghost: AGENTS.ghost } } });
  assert.equal(installed('hyve-fake-strong', BIN_DIR), true, 'a bare name is looked up on PATH');
  assert.equal(installed('hyve-fake-strong', '/nonexistent'), false);
  assert.equal(installed(WEAK), true, 'a path is checked directly');
  const all = selectAgents(c, null, BIN_DIR);
  assert.ok(all.agents.includes('strong'));
  assert.ok(!all.agents.includes('ghost'));
  assert.deepEqual(all.skipped.find((x) => x.agent === 'ghost'), { agent: 'ghost', reason: 'not installed' });
  assert.deepEqual(selectAgents(c, ['strong', 'ghost'], BIN_DIR), { agents: ['strong'], skipped: [{ agent: 'ghost', reason: 'not installed' }] });
  assert.throws(() => selectAgents(c, ['ghost'], BIN_DIR), /none of ghost can run \(ghost: not installed\)/);
  assert.throws(() => selectAgents(c, ['nope'], BIN_DIR), /no evals\.agents\.nope in config/);
  const plan = planEvals(project(), cfg(), { skills: ['open-pr'], trials: 1 });
  assert.match(renderPreview(matrixPreview(plan, cfg(), { agents: ['strong'], skipped: [{ agent: 'ghost', reason: 'not installed' }] })), /skipped ghost: not installed/);
});

test('matrix report: a disagreements list of skills whose verdict depends on the agent; --render reads both report shapes', async () => {
  const dir = project();
  const { report } = await runMatrix(dir, cfg(), { agents: ['strong', 'weak'], skipped: [{ agent: 'ghost', reason: 'not installed' }], skills: ['open-pr'], trials: 3 });
  assert.deepEqual(report.disagreements, [{ skill: 'open-pr', verdicts: [{ agent: 'strong', verdict: 'saturated', lift: 0 }, { agent: 'weak', verdict: 'earning', lift: 1 }] }]);
  const md = renderReport(JSON.parse(JSON.stringify(report)));
  assert.match(md, /^# hyvemind skill evals \(matrix\)/);
  assert.match(md, /Skipped: ghost \(not installed\)\./);
  assert.match(md, /## Disagreements\n\n- \*\*open-pr\*\*: strong saturated \(0\), weak earning \(\+1\)\./);
  assert.match(md, /\| Skill \| Scenarios \| strong bare \| strong skill \| strong lift \| strong verdict \| weak bare \| weak skill \| weak lift \| weak verdict \|/);
  assert.match(md, /\| open-pr \| 1 \| 100% \| 100% \| 0 \[-0\.56, \+0\.56\] \| \*\*saturated\*\* \| 0% \| 100% \| \+1 \[\+0\.21, \+1\] \| \*\*earning\*\* \|/);
  assert.match(md, /\| open-pr \| one \| 3\/3 \| 3\/3 \| 0\/3 \| 3\/3 \| — \|/);
  assert.match(md, /- weak · open-pr · one · bare trial 1: \[output\]/);
  // Agreement: two agents that behave the same produce no disagreement.
  const same = await runMatrix(dir, cfg(), { agents: ['strong', 'strong'], skills: ['open-pr'], trials: 3 });
  assert.deepEqual(same.report.disagreements, []);
  assert.match(renderReport(same.report), /## Disagreements\n\nNone/);
  assert.deepEqual(disagreements([{ agent: 'a', skills: [{ skill: 'x', scenarios: 0, note: 'no scenarios' }] }, { agent: 'b', skills: [] }]), [], 'a skill with no runs has no verdict to disagree on');
  // An old single-agent report still renders the single-agent table.
  assert.match(renderReport({ agent: 'claude', version: '0', startedAt: 'then', skills: report.agents[0].skills }), /^# hyvemind skill evals\n\nAgent \*\*claude\*\*/);
});

test('matrix: refuses --model and agents without cleanArgs under --clean-profile before anything runs', async () => {
  const dir = project();
  await assert.rejects(runMatrix(dir, cfg(), { agents: ['strong', 'weak'], skills: ['open-pr'], model: 'm' }), /--model applies to one agent/);
  await assert.rejects(runMatrix(dir, cfg(), { agents: ['strong', 'weak'], skills: ['open-pr'], cleanProfile: true }), /evals\.agents\.strong, evals\.agents\.weak have no cleanArgs/);
  assert.ok(!existsSync(join(dir, '.hyve/evals')), 'nothing ran');
});

const BIN = fileURLToPath(new URL('../bin/hyvemind.mjs', import.meta.url));
const cli = (cwd, ...args) => spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8' });

test('matrix consent covers the whole matrix: the preview totals every agent and nothing starts without --yes', () => {
  const dir = project();
  writeFileSync(join(dir, 'hyvemind.json'), JSON.stringify({ version: 1, skills: { include: ['open-pr'] }, evals: { agent: 'strong', agents: AGENTS, includeBundled: false } }));
  const dry = cli(dir, 'eval', 'open-pr', '--agent', 'strong,weak,ghost', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /eval matrix: 2 agent\(s\) = 12 agent runs in total/);
  assert.match(dry.stderr, /\n  strong: 1 skill\(s\) · 1 scenario\(s\) · 3 trial\(s\) × 2 arms = 6 runs/);
  assert.match(dry.stderr, /\n  weak: .* = 6 runs/);
  assert.match(dry.stderr, /skipped ghost: not installed/);
  assert.match(dry.stderr, /at most 2\.0 h/, 'the upper bound adds up both agents (2 × 6 runs × 600 s)');
  const noYes = cli(dir, 'eval', 'open-pr', '--agent', 'strong,weak');
  assert.equal(noYes.status, 1, 'a non-TTY matrix without --yes must refuse to start');
  assert.match(noYes.stderr, /= 12 agent runs in total/);
  assert.match(noYes.stderr, /re-run with --yes/);
  assert.ok(!existsSync(join(dir, '.hyve/evals')), 'no agent ran');
  const yes = cli(dir, 'eval', 'open-pr', '--agent', 'strong,weak', '--yes', '--report');
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /disagreement · open-pr: strong saturated, weak earning/);
  assert.match(readFileSync(join(dir, '.hyve/evals/REPORT.md'), 'utf8'), /## Disagreements/);
  const json = yes.stdout.match(/report: (.+)/)[1];
  assert.match(cli(dir, 'eval', '--render', json).stdout, /\| open-pr \| 1 \| 100% \| 100% \|/);
});

test('agents run on their own login: a matrix skips an agent that is not logged in; the check reads exit code (and match), never keeps output', () => {
  const out = fakeAgent('hyve-fake-auth', `const s=process.argv[2];process.stdout.write(s==='zero'?'\\x1b[90m0 credentials\\x1b[0m':s==='two'?'2 credentials user@example.com':'');process.exit(s==='fail'?1:0)`);
  const c = resolveConfig({ version: 1, evals: { agent: 'strong', agents: {
    strong: { command: [STRONG, '{prompt}'], authCheck: { command: [out, 'ok'] } },
    weak: { command: [WEAK, '{prompt}'], authCheck: { command: [out, 'fail'] } },
    listed: { command: [STRONG, '{prompt}'], authCheck: { command: [out, 'zero'], match: '\\b[1-9]\\d* credentials?\\b' } },
    nocheck: { command: [STRONG, '{prompt}'] },
  } } });
  const sel = selectAgents(c, ['strong', 'weak', 'listed', 'nocheck'], BIN_DIR);
  assert.deepEqual(sel.agents, ['strong', 'nocheck']);
  assert.deepEqual(sel.skipped, [{ agent: 'weak', reason: 'not logged in' }, { agent: 'listed', reason: 'not logged in' }], 'exit 1, and exit 0 without a match, are both "not logged in"');
  assert.equal(JSON.stringify(sel).includes('@'), false, 'nothing the status command printed is kept');
  assert.equal(loggedIn({ command: [], authCheck: { command: [out, 'two'], match: '\\b[1-9]\\d* credentials?\\b' } }), true);
  assert.equal(loggedIn({ command: [], authCheck: { command: ['hyve-no-such-binary'] } }), false, 'a check that cannot start is not logged in');
  // The check runs with the agent's allowlisted env (no API keys) and a timeout.
  let seen;
  const had = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-passed';
  try {
    loggedIn({ command: [], authCheck: { command: ['x'] } }, { run: (cmd, args, o) => { seen = { ...o, env: { ...o.env } }; return { status: 0 }; } });
  } finally {
    if (had === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = had;
  }
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined, 'a key in our env never reaches the check');
  assert.ok(seen.env.PATH, 'the allowlisted env still carries PATH');
  assert.ok(seen.timeout > 0 && seen.timeout <= 30_000);
  assert.throws(() => selectAgents(c, ['weak'], BIN_DIR), /none of weak can run \(weak: not logged in\)/);
  assert.throws(() => resolveConfig({ version: 1, evals: { agent: 'a', agents: { a: { command: ['a', '{prompt}'], authCheck: { command: 'a status' } } } } }), /authCheck\.command must be an argv array/);
});

test('single-agent eval: --agent, then the project evals.agent, then the host agent (Claude Code), then the default; the preview says which', () => {
  const builtin = resolveConfig({ version: 1 });
  assert.deepEqual(chooseAgent(builtin, 'codex', { CLAUDECODE: '1' }), { agent: 'codex', why: '--agent' });
  assert.deepEqual(chooseAgent(builtin, null, { CLAUDECODE: '1' }), { agent: 'claude', why: 'host agent: running inside Claude Code' });
  assert.deepEqual(chooseAgent(builtin, null, {}), { agent: 'claude', why: 'configured default' });
  const own = resolveConfig({ version: 1, evals: { agent: 'codex' } });
  assert.deepEqual(chooseAgent(own, null, { CLAUDECODE: '1' }), { agent: 'codex', why: 'evals.agent in config' }, 'a project choice beats the host');
  const plan = planEvals(project(), cfg(), { skills: ['open-pr'], trials: 1 });
  assert.match(renderPreview(preview(plan, cfg(), { agent: 'claude', why: 'host agent: running inside Claude Code' })), /agent runs \(claude, host agent: running inside Claude Code\)/);
});
