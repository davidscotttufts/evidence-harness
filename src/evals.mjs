// Scaffold economics: does a skill still make the CURRENT model better than it is bare?
//
// Each scenario runs in a fresh scratch workspace twice per trial: once with no skill
// ("bare") and once with the skill installed ("skill"). The same checks score both arms.
// lift = pass-rate(skill) − pass-rate(bare). When a stronger model's bare pass rate
// catches up, lift falls toward 0 and the skill is a candidate to thin or retire.
//
// Scenario file (JSON): skills/<skill>/evals/*.json (bundled) or
// <evals.scenariosDir>/<skill>/*.json (the project's own):
//   { "id": "…", "prompt": "…", "fixture": "<dir relative to the scenario file>",
//     "setup": "<shell, run in the workspace before the agent; optional>",
//     "trials": 3,
//     "checks": [ { "type": "output-includes", "text": "…" },
//                 { "type": "output-excludes", "text": "…" },
//                 { "type": "output-matches", "pattern": "…", "flags": "i" },
//                 { "type": "output-not-matches", "pattern": "…" },
//                 { "type": "file-exists", "path": "…" },
//                 { "type": "command", "run": "…" } ],   // exit 0 = pass, run in the workspace
//     "good": "<an output that should pass>", "bad": "<a plausible wrong output>" }  // optional; string or list; see lintScenario
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { PKG_ROOT, STATE_DIR, pkgVersion } from './config.mjs';
import { renderSkill } from './install.mjs';
import { leaseArgv } from './broker.mjs';
import { sample as sampleLoad } from './contention.mjs';

export function loadScenarios(root, cfg, skill) {
  const own = join(root, cfg.evals.scenariosDir ?? '.hyve/scenarios', skill);
  const dirs = cfg.evals.includeBundled === false ? [own] : [join(PKG_ROOT, 'skills', skill, 'evals'), own];
  const out = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
      const file = join(d, f);
      out.push({ ...JSON.parse(readFileSync(file, 'utf8')), file });
    }
  }
  return out;
}

export function argv(command, vars) {
  return command.map((t) => t.replace(/\{(prompt|workdir|model)\}/g, (_, k) => {
    if (vars[k] == null) throw new Error(`agent command uses {${k}} but no value was given (pass --model?)`);
    return vars[k];
  }));
}

export function score(checks, output, workdir) {
  return checks.map((c) => {
    let pass;
    switch (c.type) {
      case 'output-includes': pass = output.includes(c.text); break;
      case 'output-excludes': pass = !output.includes(c.text); break;
      case 'output-matches': pass = new RegExp(c.pattern, c.flags ?? '').test(output); break;
      case 'output-not-matches': pass = !new RegExp(c.pattern, c.flags ?? '').test(output); break;
      case 'file-exists': pass = existsSync(join(workdir, c.path)); break;
      case 'command': pass = spawnSync(c.run, { cwd: workdir, shell: true, timeout: 120000, env: agentEnv() }).status === 0; break;
      default: throw new Error(`unknown check type ${c.type}`);
    }
    return { type: c.type, pass };
  });
}

function workspace(scenario, cfg, skill, arm) {
  const dir = mkdtempSync(join(tmpdir(), `hyve-eval-${arm}-`));
  if (scenario.fixture) cpSync(join(dirname(scenario.file), scenario.fixture), dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (arm === 'skill') {
    for (const target of cfg.skills.targets) {
      for (const f of renderSkill(skill, cfg)) {
        const abs = join(dir, target, `${cfg.skills.prefix}${skill}`, f.rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
    }
  }
  // Optional: shape the workspace before the agent sees it (e.g. commit a base and
  // leave a change uncommitted so the agent reviews a real diff). Runs in both arms, after the skill is installed, so the skill's own files are
  // part of the base and never show up in the diff the agent sees.
  if (scenario.setup) {
    const r = spawnSync(scenario.setup, { cwd: dir, shell: true, encoding: 'utf8', env: { ...agentEnv(), GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com' } });
    if (r.status !== 0) throw new Error(`scenario ${scenario.id} setup failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return dir;
}

// One run is an anecdote: below minRuns per arm the verdict is withheld, so a
// single lucky or unlucky trial can never recommend retiring a skill.
// `bare` and `liftLow` are optional so a caller without counts still gets a verdict;
// runEvals and renderReport always pass both.
export function verdict(lift, threshold, runs = Infinity, minRuns = 3, withSkill = null, bare = null, liftLow = null) {
  if (runs < minRuns) return 'insufficient-data';
  // Neither arm ever passes: the skill doesn't help either, so the scenario (or the
  // skill) is broken. That is not evidence the model has outgrown the skill.
  if (withSkill === 0 && lift === 0) return 'no-signal';
  // Both arms at ceiling: these scenarios cannot measure the skill at all. That calls
  // for a harder scenario, not a retirement.
  if (bare === 1 && withSkill === 1) return 'saturated';
  // A big lift on 3 runs per arm can still be luck: "earning" needs the lift interval to clear 0.
  if (lift >= threshold) return liftLow == null || liftLow > 0 ? 'earning' : 'earning (low n)';
  if (lift <= 0) return 'retire-candidate';
  return 'marginal';
}

// Wilson score interval for k passes in n runs. Unlike the normal approximation it
// stays honest at small n and at 0% / 100%, where that one collapses to zero width.
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const half = (z / d) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// 95% interval for lift = p(skill) − p(bare): Newcombe's hybrid score method
// ("method 10", Newcombe 1998), which combines the two arms' Wilson intervals:
//   lower = d − √((p₁ − l₁)² + (u₂ − p₂)²),  upper = d + √((u₁ − p₁)² + (p₂ − l₂)²)
// with arm 1 = skill, arm 2 = bare. It treats the arms as independent samples.
export function liftInterval(skill, bare) {
  const p1 = skill.pass / skill.runs, p2 = bare.pass / bare.runs;
  const [l1, u1] = wilson(skill.pass, skill.runs), [l2, u2] = wilson(bare.pass, bare.runs);
  const d = p1 - p2;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)];
}

const r3 = (x) => +x.toFixed(3);
const tally = (rs) => ({ pass: rs.filter((x) => x.pass).length, runs: rs.length });

// Per-scenario rows, so one scenario the skill makes WORSE (harmful) or that nobody
// can pass (no-signal, usually a scenario bug) is not averaged away in the skill row.
export function scenarioRows(runs) {
  return [...new Set(runs.map((r) => r.scenario))].map((id) => {
    const bare = tally(runs.filter((r) => r.scenario === id && r.arm === 'bare'));
    const skill = tally(runs.filter((r) => r.scenario === id && r.arm === 'skill'));
    const rb = bare.runs ? bare.pass / bare.runs : 0, rs = skill.runs ? skill.pass / skill.runs : 0;
    const flags = [];
    if (rs < rb) flags.push('harmful');
    if (bare.runs && skill.runs && !bare.pass && !skill.pass) flags.push('no-signal');
    return { id, bare, skill, lift: r3(rs - rb), flags };
  });
}

// Size of the skill as installed (rendered text files). Tokens are approximate
// (words × 1.3): enough to see "lift per word", not a tokenizer.
export function skillSize(skill, cfg) {
  try {
    const words = renderSkill(skill, cfg).reduce((n, f) => n + (typeof f.content === 'string' ? f.content.split(/\s+/).filter(Boolean).length : 0), 0);
    return { words, approxTokens: Math.round(words * 1.3) };
  } catch { return null; }
}

// Skill row from its runs. Old reports (no per-scenario rows) and runs-less reports
// come through here too, so --render can rebuild every field from what they kept.
export function summarize(s, { liftThreshold = 0.2, minRuns = 3 } = {}) {
  let b, w, rows;
  if (s.runs?.length) {
    const runs = s.runs;
    [b, w] = [tally(runs.filter((x) => x.arm === 'bare')), tally(runs.filter((x) => x.arm === 'skill'))];
    rows = scenarioRows(runs);
  } else {
    // A report that dropped its runs still has rates and runs per arm.
    [b, w] = [{ pass: Math.round(s.bare * s.trials), runs: s.trials }, { pass: Math.round(s.withSkill * s.trials), runs: s.trials }];
    rows = [];
  }
  const rate = (a) => (a.runs ? a.pass / a.runs : 0);
  const lift = +(rate(w) - rate(b)).toFixed(3);
  const li = liftInterval(w, b).map(r3);
  return {
    ...s, bare: rate(b), withSkill: rate(w), trials: w.runs, lift,
    counts: { bare: b, withSkill: w },
    ci: { bare: wilson(b.pass, b.runs).map(r3), withSkill: wilson(w.pass, w.runs).map(r3), lift: li },
    verdict: verdict(lift, liftThreshold, w.runs, minRuns, rate(w), rate(b), li[0]),
    byScenario: rows,
  };
}

// What an agent process may see. Never the whole process.env: a shell's env carries
// tokens for every service the user works with, and the eval needs none of them. An
// agent's own auth var (if it uses one) is opted in per agent with evals.agents.<name>.env.
export const ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'SHELL', 'USER'];

export function agentEnv(agentCfg = {}, arm, from = process.env, clean = false) {
  const names = new Set([...ENV_ALLOW, ...(agentCfg.env ?? [])]);
  const env = {};
  for (const [k, v] of Object.entries(from)) if (names.has(k) || k.startsWith('LC_')) env[k] = v;
  // cleanEnv holds fixed values (e.g. a "disable memory" switch), never secrets.
  if (clean) Object.assign(env, agentCfg.cleanEnv ?? {});
  if (arm) env.HYVE_EVAL_ARM = arm;
  return env;
}

// Clean-profile args go into BOTH arms, so the only difference between the arms stays
// the installed skill. Where they go: at a "{clean}" token in the command if it has one
// (spread there with --clean-profile, dropped without it), for CLIs whose flags must
// follow a subcommand ("codex exec {clean} …"); otherwise right after the executable.
export const CLEAN_TOKEN = '{clean}';
export function agentArgv(agentCfg, vars, clean = false) {
  const cleanArgs = clean ? agentCfg.cleanArgs ?? [] : [];
  if (agentCfg.command.includes(CLEAN_TOKEN)) {
    return agentCfg.command.flatMap((t) => (t === CLEAN_TOKEN ? cleanArgs : argv([t], vars)));
  }
  const [exe, ...rest] = argv(agentCfg.command, vars);
  return [exe, ...cleanArgs, ...rest];
}

function runAgent(cmd, args, cwd, timeoutSec, env) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => { if (out.length < 8 * 1024 * 1024) out += d.toString(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
    const ms = () => Date.now() - started;
    child.on('error', (e) => { clearTimeout(timer); done({ output: out, error: e.message, ms: ms() }); });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ output: out, ...(signal === 'SIGKILL' ? { error: 'timed out' } : {}), code, ms: ms() }); });
  });
}

// "skill" or "skill:scenario" targets, plus --scenario ids that apply to every skill.
// A filter that matches nothing is an error: a typo would otherwise run zero jobs and
// report "no scenarios" as if the skill had none.
export function parseTargets(args, scenarioIds = []) {
  const map = new Map();
  for (const a of args) {
    const [skill, id] = a.split(':');
    if (!map.has(skill)) map.set(skill, new Set());
    if (id) map.get(skill).add(id);
  }
  for (const set of map.values()) for (const id of scenarioIds) set.add(id);
  return [...map].map(([skill, ids]) => ({ skill, ids: ids.size ? [...ids] : null }));
}

// The job list, before anything runs: the cost preview and the run use the same plan.
export function planEvals(root, cfg, { skills, trials }) {
  const jobs = [];
  const bySkill = new Map();
  for (const t of skills.map((x) => (typeof x === 'string' ? { skill: x, ids: null } : x))) {
    let scenarios = loadScenarios(root, cfg, t.skill);
    if (t.ids) {
      const missing = t.ids.filter((id) => !scenarios.some((sc) => sc.id === id));
      if (missing.length && missing.length === t.ids.length) throw new Error(`${t.skill}: no scenario ${missing.join(', ')} (have: ${scenarios.map((x) => x.id).join(', ') || 'none'})`);
      scenarios = scenarios.filter((sc) => t.ids.includes(sc.id));
    }
    bySkill.set(t.skill, { scenarios, runs: [], selected: t.ids });
    for (const sc of scenarios) {
      const n = trials ?? sc.trials ?? cfg.evals.trials;
      for (let i = 0; i < n; i++) for (const arm of ['bare', 'skill']) jobs.push({ skill: t.skill, sc, trial: i + 1, n, arm });
    }
  }
  return { jobs, bySkill };
}

// Median seconds per agent run from the newest prior report that recorded durations.
// With `agent`, only that agent's runs count (single-agent reports and matrix sections alike).
export function historicalMedian(root, agent = null) {
  const dir = join(root, STATE_DIR, 'evals');
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => /^report-.*\.json$/.test(x)).sort().reverse()) {
    let r;
    try { r = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const sections = r.agents ?? [{ agent: r.agent, skills: r.skills ?? [] }];
    const ms = sections.filter((a) => !agent || a.agent === agent).flatMap((a) => a.skills ?? [])
      .flatMap((s) => (s.runs ?? []).map((x) => x.ms)).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    if (ms.length) return { sec: ms[Math.floor(ms.length / 2)] / 1000, from: f, runs: ms.length };
  }
  return null;
}

// What a run will cost, so nobody spends a few hundred model calls by accident.
export function preview(plan, cfg, { concurrency = 1, agent, why = null, history = null } = {}) {
  const c = Math.max(1, concurrency);
  const waves = Math.ceil(plan.jobs.length / c);
  const scenarios = [...plan.bySkill.values()].reduce((n, s) => n + s.scenarios.length, 0);
  const trials = [...new Set(plan.jobs.map((j) => j.n))].sort((a, b) => a - b);
  return {
    agent: agent ?? cfg.evals.agent, ...(why ? { why } : {}), skills: plan.bySkill.size, scenarios, trials, arms: 2, runs: plan.jobs.length, concurrency: c,
    upperBoundSec: waves * cfg.evals.timeoutSec,
    estimateSec: history ? Math.round(waves * history.sec) : null, history,
  };
}

const dur = (sec) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);

export function renderPreview(p) {
  if (p.matrix) {
    // One consent covers the whole matrix, so the total comes first and every agent's share is listed.
    return [
      `eval matrix: ${p.agents.length} agent(s) = ${p.runs} agent runs in total · concurrency ${p.concurrency} per agent, agents one after another`,
      ...p.agents.map((a) => `  ${a.agent}: ${a.skills} skill(s) · ${a.scenarios} scenario(s) · ${a.trials.join('/') || 0} trial(s) × ${a.arms} arms = ${a.runs} runs · ${a.estimateSec != null ? `about ${dur(a.estimateSec)}, ` : ''}at most ${dur(a.upperBoundSec)}`),
      ...p.skipped.map((x) => `  skipped ${x.agent}: ${x.reason}`),
      `duration: ${p.estimateSec != null ? `about ${dur(p.estimateSec)}; ` : ''}at most ${dur(p.upperBoundSec)} (every run hitting timeoutSec)`,
    ].join('\n');
  }
  return [
    `eval plan: ${p.skills} skill(s) · ${p.scenarios} scenario(s) · ${p.trials.join('/') || 0} trial(s) × ${p.arms} arms = ${p.runs} agent runs (${p.agent}${p.why ? `, ${p.why}` : ''}) · concurrency ${p.concurrency}`,
    `duration: ${p.estimateSec != null ? `about ${dur(p.estimateSec)} (median ${p.history.sec.toFixed(0)} s/run over ${p.history.runs} runs in ${p.history.from}); ` : ''}at most ${dur(p.upperBoundSec)} (every run hitting timeoutSec)`,
  ].join('\n');
}

// "0.3.0+abc1234[-dirty]" when hyvemind runs from a git checkout, so a report says which
// code produced it; the plain version from an installed package (no .git of its own).
export function versionStamp(pkgRoot = PKG_ROOT) {
  const v = pkgVersion();
  if (!existsSync(join(pkgRoot, '.git'))) return v;
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: pkgRoot, encoding: 'utf8' });
  if (sha.status !== 0) return v;
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: pkgRoot, encoding: 'utf8' }).stdout.trim() !== '';
  return `${v}+${sha.stdout.trim()}${dirty ? '-dirty' : ''}`;
}

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');

// Runs every (scenario × trial × arm) job, up to `concurrency` at once. Each job gets
// its own scratch workspace, so concurrent runs never see each other's files.
// Output of every FAILED run is kept under .hyve/evals/<run-id>/ (passes too with keep),
// so a failure can be diagnosed without rerunning on a guess.
export async function runEvals(root, cfg, { skills, agent, model, trials, keep = false, cleanProfile = false, concurrency = 1, plan = null, wait = 0, sampler, pollMs, log = () => {} }) {
  const agentName = agent ?? cfg.evals.agent;
  const agentCfg = cfg.evals.agents[agentName];
  if (!agentCfg) throw new Error(`no evals.agents.${agentName} in config`);
  if (cleanProfile && !agentCfg.cleanArgs?.length) throw new Error(`--clean-profile: evals.agents.${agentName} has no cleanArgs (see docs/reference.md, Evals)`);
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const report = { tool: 'hyvemind', version: versionStamp(), startedAt, runId, agent: agentName, model: model ?? null,
    cleanProfile: Boolean(cleanProfile), concurrency: Math.max(1, concurrency),
    thresholds: { liftThreshold: cfg.evals.liftThreshold, minRuns: cfg.evals.minRuns }, skills: [] };
  const load = loadWatch(root, cfg, { wait, sampler, pollMs, log });
  report.skills = await runAgentJobs(root, cfg, { agentName, plan: plan ?? planEvals(root, cfg, { skills, trials }), model, keep, cleanProfile, concurrency, outDir: [runId], thresholds: report.thresholds, load, log });
  if (load) report.contention = load.summary();
  return { report, file: writeReport(root, report) };
}

// Load watch, as the gate does: an agent run that times out on a starved machine reads
// like a skill failure. Sampled before every job; with `wait` (minutes), a job waits for
// the machine to quiet down first (the budget is shared by the whole run). The report
// records the busiest sample, so a contended run's failures are read as "re-run when
// quiet". With a broker configured, the broker queues the work instead: no sampling.
function loadWatch(root, cfg, { wait = 0, sampler = sampleLoad, pollMs = 15_000, log = () => {} } = {}) {
  if (cfg.broker) return null;
  const until = Date.now() + Number(wait || 0) * 60_000;
  let samples = 0, contendedSamples = 0, worst = null;
  const take = () => {
    const s = sampler(root);
    samples++;
    if (s.contended) contendedSamples++;
    if (!worst || (s.contended && !worst.contended) || (s.contended === worst.contended && s.load1 > worst.load1)) worst = s;
    return s;
  };
  return {
    async before() {
      let s = take();
      while (s.contended && Date.now() < until) {
        log(`  waiting: load ${s.load1} on ${s.cores} cores; ${s.competitors.map((c) => c.dir).join(', ') || 'no other suite'}`);
        await new Promise((r) => setTimeout(r, pollMs));
        s = take();
      }
      return s;
    },
    summary: () => ({ ...worst, contended: contendedSamples > 0, samples, contendedSamples }),
  };
}

function writeReport(root, report) {
  report.finishedAt = new Date().toISOString();
  const dir = join(root, STATE_DIR, 'evals');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `report-${report.runId}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}

// One agent's share of a run: its own jobs, its own runs, its own skill rows. A matrix
// calls this once per agent with a fresh copy of the plan, so nothing is pooled.
async function runAgentJobs(root, cfg, { agentName, plan, model, keep, cleanProfile, concurrency, outDir, thresholds, label = '', load = null, log }) {
  const agentCfg = cfg.evals.agents[agentName];
  const { jobs, bySkill } = plan;
  let next = 0, finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (load) await load.before();
      const dir = workspace(j.sc, cfg, j.skill, j.arm);
      try {
        const [cmd, ...args] = leaseArgv(cfg, 'eval', `${j.skill}/${j.sc.id}`, agentArgv(agentCfg, { prompt: j.sc.prompt, workdir: dir, model }, cleanProfile));
        const r = await runAgent(cmd, args, dir, cfg.evals.timeoutSec, agentEnv(agentCfg, j.arm, process.env, cleanProfile));
        const checks = r.error ? [{ type: 'agent-run', pass: false, error: r.error }] : score(j.sc.checks, r.output, dir);
        const pass = checks.every((c) => c.pass);
        let output;
        if (!pass || keep) {
          output = join(STATE_DIR, 'evals', ...outDir, safe(j.skill), safe(j.sc.id), `${j.arm}-${j.trial}.txt`);
          mkdirSync(dirname(join(root, output)), { recursive: true });
          writeFileSync(join(root, output), r.output);
        }
        bySkill.get(j.skill).runs.push({ scenario: j.sc.id, trial: j.trial, arm: j.arm, pass, ms: r.ms, checks, ...(output ? { output } : {}), ...(pass ? {} : { tail: r.output.trim().slice(-2000) }) });
        log(`  [${label}${++finished}/${jobs.length}] ${j.skill} · ${j.sc.id} · trial ${j.trial}/${j.n} · ${j.arm}: ${pass ? 'pass' : 'FAIL'}`);
      } finally {
        if (!keep) rmSync(dir, { recursive: true, force: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const skills = [];
  for (const [skill, { scenarios, runs, selected }] of bySkill) {
    if (!scenarios.length) { skills.push({ skill, scenarios: 0, note: 'no scenarios' }); continue; }
    runs.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.trial - b.trial || a.arm.localeCompare(b.arm));
    skills.push(summarize({ skill, scenarios: scenarios.length, ...(selected ? { selected } : {}), size: skillSize(skill, cfg), runs }, thresholds));
  }
  return skills;
}

// ── Matrix: the same scenarios on several agents ──────────────────────────────
// A verdict read on one agent is a claim about that agent. Running the selection once
// per agent shows whether "saturated" or "earning" holds across agents or depends on one.

// Is an agent's executable present? A bare name is looked up on PATH (as spawn does);
// a path is checked directly. Nothing is run.
export function installed(exe, PATH = process.env.PATH ?? '') {
  const ok = (p) => { try { accessSync(p, fsConstants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  if (exe.includes('/')) return ok(resolve(exe));
  return PATH.split(delimiter).filter(Boolean).some((d) => ok(join(d, exe)));
}

// Is the agent logged in? Agents run on their own login (a subscription, not an API key:
// keys are not in the allowlisted env), so an agent without one fails every run. Runs
// the agent's authCheck with the agent's env and a short timeout; only the exit code
// (and, for a CLI that exits 0 regardless, a `match` on its output) is used. The output
// itself is never printed or stored: status commands print account emails and org ids.
// No authCheck configured: assumed logged in.
export function loggedIn(agentCfg, { run = spawnSync, env = agentEnv(agentCfg), timeoutMs = 15_000 } = {}) {
  const chk = agentCfg.authCheck;
  if (!chk) return true;
  const [cmd, ...args] = chk.command;
  const r = run(cmd, args, { env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return false;
  if (!chk.match) return true;
  // eslint-disable-next-line no-control-regex
  return new RegExp(chk.match).test(`${r.stdout ?? ''}`.replace(/\x1b\[[0-9;]*m/g, ''));
}

// Which agent a single-agent eval runs, and why: --agent; else the project's evals.agent;
// else the agent hyvemind is running inside (Claude Code sets CLAUDECODE=1); else the
// built-in default. Codex sets no documented marker, so inside Codex it is the default.
export function chooseAgent(cfg, flag = null, env = process.env) {
  if (flag) return { agent: flag, why: '--agent' };
  if (cfg.evals.agentFromProject) return { agent: cfg.evals.agent, why: 'evals.agent in config' };
  if (env.CLAUDECODE === '1' && cfg.evals.agents.claude) return { agent: 'claude', why: 'host agent: running inside Claude Code' };
  return { agent: cfg.evals.agent, why: 'configured default' };
}

// Which agents a matrix runs: the names asked for (default: every configured agent),
// minus the ones whose binary isn't installed or that aren't logged in, listed with the reason.
export function selectAgents(cfg, names = null, PATH = process.env.PATH ?? '', isLoggedIn = loggedIn) {
  const configured = Object.keys(cfg.evals.agents);
  const want = [...new Set(names ?? configured)];
  const unknown = want.filter((n) => !cfg.evals.agents[n]);
  if (unknown.length) throw new Error(`no evals.agents.${unknown.join(', evals.agents.')} in config (have: ${configured.join(', ')})`);
  const agents = [], skipped = [];
  for (const n of want) {
    if (!installed(cfg.evals.agents[n].command[0], PATH)) skipped.push({ agent: n, reason: 'not installed' });
    else if (!isLoggedIn(cfg.evals.agents[n])) skipped.push({ agent: n, reason: 'not logged in' });
    else agents.push(n);
  }
  if (!agents.length) throw new Error(`eval matrix: none of ${want.join(', ')} can run (${skipped.map((x) => `${x.agent}: ${x.reason}`).join(', ')})`);
  return { agents, skipped };
}

// Refuse what can't work on every agent BEFORE the preview asks for consent.
export function checkMatrix(cfg, agents, { model = null, cleanProfile = false } = {}) {
  // A model id names one vendor's model; the same --model on three agents would be wrong on two.
  if (model) throw new Error('--model applies to one agent; for a matrix, set each model in evals.agents.<name>.command');
  const needModel = agents.filter((a) => cfg.evals.agents[a].command.some((t) => t.includes('{model}')));
  if (needModel.length) throw new Error(`eval matrix: ${needModel.join(', ')} use {model} in their command; put the model in the command instead`);
  const noClean = cleanProfile ? agents.filter((a) => !cfg.evals.agents[a].cleanArgs?.length) : [];
  if (noClean.length) throw new Error(`--clean-profile: ${noClean.map((a) => `evals.agents.${a}`).join(', ')} ha${noClean.length > 1 ? 've' : 's'} no cleanArgs (see docs/reference.md, Evals)`);
}

// A fresh copy of a plan's per-skill run lists, so each agent fills its own.
const freshPlan = (plan) => ({ jobs: plan.jobs, bySkill: new Map([...plan.bySkill].map(([k, v]) => [k, { ...v, runs: [] }])) });

export function matrixPreview(plan, cfg, { agents, skipped = [], concurrency = 1, history = () => null } = {}) {
  const per = agents.map((a) => preview(plan, cfg, { concurrency, agent: a, history: history(a) }));
  return {
    matrix: true, agents: per, skipped, runs: per.reduce((n, p) => n + p.runs, 0), concurrency: Math.max(1, concurrency),
    // Agents run one after another, so durations add up.
    upperBoundSec: per.reduce((n, p) => n + p.upperBoundSec, 0),
    estimateSec: per.every((p) => p.estimateSec != null) ? per.reduce((n, p) => n + p.estimateSec, 0) : null,
  };
}

export async function runMatrix(root, cfg, { agents, skipped = [], skills, model = null, trials, keep = false, cleanProfile = false, concurrency = 1, plan = null, wait = 0, sampler, pollMs, log = () => {} }) {
  checkMatrix(cfg, agents, { model, cleanProfile });
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const thresholds = { liftThreshold: cfg.evals.liftThreshold, minRuns: cfg.evals.minRuns };
  const report = { tool: 'hyvemind', version: versionStamp(), startedAt, runId, matrix: true, model: null,
    cleanProfile: Boolean(cleanProfile), concurrency: Math.max(1, concurrency), thresholds, agents: [], skipped };
  const base = plan ?? planEvals(root, cfg, { skills, trials });
  const load = loadWatch(root, cfg, { wait, sampler, pollMs, log });
  for (const agentName of agents) {
    const skillRows = await runAgentJobs(root, cfg, { agentName, plan: freshPlan(base), model: null, keep, cleanProfile, concurrency, outDir: [runId, safe(agentName)], thresholds, label: `${agentName} `, load, log });
    report.agents.push({ agent: agentName, skills: skillRows });
  }
  report.disagreements = disagreements(report.agents, thresholds);
  if (load) report.contention = load.summary();
  return { report, file: writeReport(root, report) };
}

// Skills measured on two or more agents whose verdicts differ: saturated on one and
// earning on another means the reading depends on the agent, not only on the skill.
export function disagreements(agentSections, th = {}) {
  const rows = new Map();
  for (const a of agentSections) {
    for (const s of a.skills) {
      if (!s.trials) continue;
      const x = summarize(s, th);
      if (!rows.has(s.skill)) rows.set(s.skill, []);
      rows.get(s.skill).push({ agent: a.agent, verdict: x.verdict, lift: x.lift });
    }
  }
  return [...rows].filter(([, v]) => v.length > 1 && new Set(v.map((x) => x.verdict)).size > 1).map(([skill, verdicts]) => ({ skill, verdicts }));
}

// ── Scenario lint ─────────────────────────────────────────────────────────────
// A scenario is a claim about which outputs are right. `good` / `bad` (a string or a
// list of strings) are example outputs that make the claim testable without a model:
// every good must pass every check, every bad must fail at least one. A scenario
// whose checks reject its own right answer measures nothing (round 2's
// docs-are-not-the-code failed every run in both arms for exactly that reason).
const OUTPUT_CHECKS = new Set(['output-includes', 'output-excludes', 'output-matches', 'output-not-matches']);
const examples = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Lines the prompt tells the model to print, e.g. "end with exactly one line: GRADE: <letter>"
// or "exactly two lines: PUSH: ask | go  and  PR: ask | go". Grouped by label, with
// the alternatives a menu offers ("a | b", "LABEL: a  or  LABEL: b").
export function dictatedLines(prompt) {
  const groups = new Map();
  const intro = /exactly (?:one|two|three|\d+) lines?(?: of the form)?\s*:?\s*|(?:output|print|write) (?:this|the following) (?:line )?verbatim\s*:\s*/gi;
  for (const m of prompt.matchAll(intro)) {
    const seg = prompt.slice(m.index + m[0].length).split('\n')[0];
    const parts = [...seg.matchAll(/\b([A-Z][A-Z0-9-]*):[ \t]*/g)];
    for (let i = 0; i < parts.length; i++) {
      const label = parts[i][1];
      let v = seg.slice(parts[i].index + parts[i][0].length, i + 1 < parts.length ? parts[i + 1].index : undefined);
      v = v.split(/,\s*then\b|\s{2,}(?:and|or)\s{2,}/)[0].replace(/['"`]?\.?\s*$/, '').replace(/^['"`]/, '').trim();
      if (!groups.has(label)) groups.set(label, { label, values: [] });
      groups.get(label).values.push(v);
    }
  }
  return [...groups.values()].map((g) => {
    const alts = g.values.flatMap((v) => v.split(/\s*\|\s*/)).filter(Boolean);
    return { label: g.label, written: g.values.map((v) => `${g.label}: ${v}`), alternatives: alts, template: alts.some((a) => /<[^>]+>/.test(a)) };
  });
}

// A check "is about" a dictated line when it names the line's label ("GRADE:").
const mentions = (c, label) => String(c.pattern ?? c.text ?? '').toLowerCase().includes(`${label.toLowerCase()}:`);
const passes = (c, out) => score([c], out, null)[0].pass;

export function contradictions(sc) {
  const out = { errors: [], warnings: [] };
  const checks = (sc.checks ?? []).filter((c) => OUTPUT_CHECKS.has(c.type));
  for (const d of dictatedLines(sc.prompt ?? '')) {
    const positive = checks.filter((c) => (c.type === 'output-matches' || c.type === 'output-includes') && mentions(c, d.label));
    const negative = checks.filter((c) => c.type === 'output-excludes' || c.type === 'output-not-matches');
    const lineOk = (line) => positive.every((c) => passes(c, line)) && negative.every((c) => passes(c, line));
    if (d.template) {
      // A placeholder ("GRADE: <letter>") is not an answer. If echoing it verbatim passes
      // the checks that name its label, they can't tell copying the prompt from answering it.
      if (positive.length) for (const w of d.written) if (lineOk(w)) out.errors.push(`placeholder-echo-passes: "${w}" printed verbatim passes the checks on ${d.label}:, so they can't tell copying the placeholder from answering`);
      continue;
    }
    if (d.alternatives.length === 1) {
      // A line the prompt dictates word for word: obeying the prompt must not fail the scenario.
      if (!lineOk(d.written[0])) out.errors.push(`the prompt dictates "${d.written[0]}", which fails its own checks`);
      continue;
    }
    if (!d.alternatives.some((a) => lineOk(`${d.label}: ${a}`))) out.errors.push(`no answer the prompt offers for ${d.label}: (${d.alternatives.join(' | ')}) passes the checks`);
    // Models sometimes echo a menu as written ("GRADE: A | unverified" in round 2).
    else if (d.written.length === 1 && !lineOk(d.written[0])) out.warnings.push(`menu-echo: "${d.written[0]}" printed verbatim fails the checks; "${d.label}: <${d.alternatives.join(' or ')}>" is unambiguous`);
    // The dual: an echo that PASSES gives credit for copying the menu, not for answering.
    else if (d.written.length === 1 && positive.length) out.warnings.push(`menu-echo-passes: "${d.written[0]}" printed verbatim passes the checks, so they can't tell an echo from an answer`);
  }
  return out;
}

export function lintScenario(sc) {
  const r = { id: sc.id, file: sc.file, errors: [], warnings: [], partial: null, linted: false };
  const good = examples(sc.good), bad = examples(sc.bad);
  for (const [k, xs] of [['good', good], ['bad', bad]]) if (xs.some((x) => typeof x !== 'string')) r.errors.push(`${k} must be a string or a list of strings`);
  const c = contradictions(sc);
  r.errors.push(...c.errors);
  r.warnings.push(...c.warnings);
  if (!good.length && !bad.length) return r;
  r.linted = true;
  const lintable = (sc.checks ?? []).filter((x) => OUTPUT_CHECKS.has(x.type));
  const skipped = [...new Set((sc.checks ?? []).filter((x) => !OUTPUT_CHECKS.has(x.type)).map((x) => x.type))];
  // file-exists and command checks read the workspace the agent changed: a string can't stand in for that.
  if (skipped.length) r.partial = `${skipped.join(', ')} check(s) need the agent's workspace, not an output string; only output checks were linted`;
  if (!good.length) r.errors.push('bad without good: add a right answer too');
  if (!bad.length) r.errors.push('good without bad: add a plausible wrong answer too');
  good.forEach((g, i) => {
    const failed = lintable.filter((x) => !passes(x, g));
    if (failed.length) r.errors.push(`good${good.length > 1 ? `[${i}]` : ''} fails ${failed.map((x) => `${x.type} ${JSON.stringify(x.pattern ?? x.text)}`).join(', ')}`);
  });
  bad.forEach((b, i) => {
    if (lintable.every((x) => passes(x, b))) r.errors.push(`bad${bad.length > 1 ? `[${i}]` : ''} passes every ${skipped.length ? 'output ' : ''}check: the scenario cannot tell it from a right answer`);
  });
  return r;
}

export function lintScenarios(root, cfg, skills) {
  const rows = skills.flatMap((skill) => loadScenarios(root, cfg, skill).map((sc) => ({ skill, ...lintScenario(sc) })));
  return {
    rows,
    counts: {
      scenarios: rows.length, linted: rows.filter((r) => r.linted).length, unlinted: rows.filter((r) => !r.linted).length,
      partial: rows.filter((r) => r.partial).length, errors: rows.filter((r) => r.errors.length).length, warnings: rows.filter((r) => r.warnings.length).length,
    },
  };
}

const ACTION = {
  earning: 'Keep.',
  'earning (low n)': 'Probably keep, but the lift interval still includes 0: run more trials before citing the lift.',
  marginal: 'Thin it: cut the steps the bare model already does, then re-run.',
  saturated: 'Unmeasured below ceiling: both arms pass every run, so these scenarios cannot show lift. Write a scenario the bare model still fails; do not retire on this.',
  'retire-candidate': 'Propose retiring it, or rewrite its scenarios to target a failure the bare model still makes. Needs the same verdict on a second model or run first.',
  'insufficient-data': 'Run more trials before deciding anything.',
  'no-signal': 'Neither arm passes: fix the scenario (or the skill) before reading anything into it.',
};

// Markdown summary of an eval report: the decision table people act on. Verdicts and
// intervals are recomputed from the runs, so an old report renders with today's rules.
// A contended run's failures say more about the machine than about the skill.
const contendedNote = (report) => {
  const c = report.contention;
  if (!c?.contended) return [];
  return [`> **Contended run.** ${c.contendedSamples} of ${c.samples} jobs started on a busy machine (worst: load ${c.load1} on ${c.cores} cores). Failures and timeouts here are not evidence about a skill; re-run when quiet (\`--wait <min>\`).`, ''];
};

export function renderReport(report, fallback = {}, { linkBase = '' } = {}) {
  if (Array.isArray(report.agents)) return renderMatrix(report, fallback, { linkBase });
  const th = report.thresholds ?? fallback;
  const skills = report.skills.map((s) => (s.trials ? summarize(s, th) : s));
  const pct = (x) => `${Math.round(x * 100)}%`;
  const ci = ([lo, hi]) => `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`;
  const sgn = (x) => `${x > 0 ? '+' : ''}${+x.toFixed(2)}`;
  const flagged = skills.filter((s) => s.trials).flatMap((s) => s.byScenario.filter((r) => r.flags.length).map((r) => ({ ...r, name: s.skill })));
  const lines = [
    `# hyvemind skill evals`,
    '',
    `Agent **${report.agent}**${report.model ? ` · model \`${report.model}\`` : ''} · hyvemind ${report.version} · ${report.startedAt}`,
    '',
  ];
  lines.push(...contendedNote(report));
  if (flagged.length) {
    lines.push('## Look at these first', '');
    for (const r of flagged) {
      const why = r.flags.map((f) => (f === 'harmful' ? '**harmful**: the skill arm passes less often than bare' : '**no-signal**: neither arm ever passes (usually a scenario bug)')).join('; ');
      lines.push(`- ${r.name} · \`${r.id}\`: bare ${r.bare.pass}/${r.bare.runs}, with skill ${r.skill.pass}/${r.skill.runs}. ${why}.`);
    }
    lines.push('');
  }
  lines.push(
    'Each scenario runs in a fresh scratch repo twice per trial: once **bare** (no skill) and once **with** the skill. Lift = with − bare.',
    'Brackets are 95% intervals (Wilson per arm; Newcombe hybrid score for lift). A lift is **earning** only when its interval excludes 0; otherwise **earning (low n)**.',
    'Words are the rendered skill as installed; tokens ≈ words × 1.3 (approximate).',
    '',
    '| Skill | Scenarios | Runs/arm | Bare [95% CI] | With skill [95% CI] | Lift [95% CI] | Words (≈tokens) | Verdict |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  );
  for (const s of skills) {
    if (!s.trials) { lines.push(`| ${s.skill} | 0 | 0 | — | — | — | — | no scenarios |`); continue; }
    const size = s.size ? `${s.size.words} (≈${s.size.approxTokens})` : '—';
    lines.push(`| ${s.skill} | ${s.scenarios} | ${s.trials} | ${pct(s.bare)} [${ci(s.ci.bare)}] | ${pct(s.withSkill)} [${ci(s.ci.withSkill)}] | ${sgn(s.lift)} [${sgn(s.ci.lift[0])}, ${sgn(s.ci.lift[1])}] | ${size} | **${s.verdict}** |`);
  }
  lines.push('', '## What to do', '');
  for (const s of skills.filter((x) => x.trials)) lines.push(`- **${s.skill}** (${s.verdict}): ${ACTION[s.verdict]}`);
  lines.push('', '## Per scenario', '', '| Skill | Scenario | Bare | With skill | Lift | Flags |', '|---|---|---:|---:|---:|---|');
  for (const s of skills.filter((x) => x.trials)) {
    for (const r of s.byScenario) lines.push(`| ${s.skill} | ${r.id} | ${r.bare.pass}/${r.bare.runs} | ${r.skill.pass}/${r.skill.runs} | ${sgn(r.lift)} | ${r.flags.join(', ') || '—'} |`);
  }
  const failed = skills.filter((x) => x.trials).flatMap((s) => (s.runs ?? []).filter((r) => !r.pass && r.output).map((r) => ({ ...r, name: s.skill })));
  if (failed.length) {
    lines.push('', '## Failed runs', '');
    for (const r of failed) lines.push(`- ${r.name} · ${r.scenario} · ${r.arm} trial ${r.trial}: [output](${(linkBase ? `${linkBase}/` : '') + r.output})`);
  }
  lines.push('', report.cleanProfile
    ? 'Ran with --clean-profile: both arms got the agent\'s cleanArgs/cleanEnv. See docs/reference.md for what that does and does not exclude.'
    : 'Caveat: the bare arm can still see user-level skills and global instructions unless the eval ran with --clean-profile.');
  return lines.join('\n') + '\n';
}

// A matrix report: one table with a column group per agent, and the skills whose verdict
// depends on the agent listed first, since that is what the matrix is for.
function renderMatrix(report, fallback = {}, { linkBase = '' } = {}) {
  const th = report.thresholds ?? fallback;
  const agents = report.agents.map((a) => ({ agent: a.agent, skills: a.skills.map((s) => (s.trials ? summarize(s, th) : s)) }));
  const names = agents.map((a) => a.agent);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const sgn = (x) => `${x > 0 ? '+' : ''}${+x.toFixed(2)}`;
  const skillNames = [...new Set(agents.flatMap((a) => a.skills.map((s) => s.skill)))];
  const row = (a, skill) => a.skills.find((s) => s.skill === skill);
  const lines = [
    '# hyvemind skill evals (matrix)',
    '',
    `Agents ${names.map((n) => `**${n}**`).join(', ')} · hyvemind ${report.version} · ${report.startedAt}`,
    '',
  ];
  lines.push(...contendedNote(report));
  if (report.skipped?.length) lines.push(`Skipped: ${report.skipped.map((x) => `${x.agent} (${x.reason})`).join(', ')}.`, '');
  const dis = disagreements(report.agents, th);
  lines.push('## Disagreements', '');
  if (dis.length) {
    for (const d of dis) lines.push(`- **${d.skill}**: ${d.verdicts.map((v) => `${v.agent} ${v.verdict} (${sgn(v.lift)})`).join(', ')}. The verdict depends on the agent: don't retire or keep on one agent's reading.`);
  } else lines.push('None: every skill measured on two or more agents got the same verdict on each.');
  lines.push('');
  const flagged = agents.flatMap((a) => a.skills.filter((s) => s.trials).flatMap((s) => s.byScenario.filter((r) => r.flags.length).map((r) => ({ ...r, name: s.skill, agent: a.agent }))));
  if (flagged.length) {
    lines.push('## Look at these first', '');
    for (const r of flagged) lines.push(`- ${r.agent} · ${r.name} · \`${r.id}\`: bare ${r.bare.pass}/${r.bare.runs}, with skill ${r.skill.pass}/${r.skill.runs}. ${r.flags.map((f) => `**${f}**`).join(', ')}.`);
    lines.push('');
  }
  lines.push(
    'Each agent ran its own runs: verdicts and intervals are per agent, and nothing is pooled across agents.',
    'Bare / with skill are pass rates; lift = with − bare with its 95% interval (Newcombe hybrid score).',
    '',
    `| Skill | Scenarios | ${names.map((n) => `${n} bare | ${n} skill | ${n} lift | ${n} verdict`).join(' | ')} |`,
    `|---|---:|${names.map(() => '---:|---:|---:|---|').join('')}`,
  );
  for (const skill of skillNames) {
    const any = agents.map((a) => row(a, skill)).find((s) => s?.trials);
    const cells = agents.map((a) => {
      const s = row(a, skill);
      if (!s?.trials) return '— | — | — | ' + (s?.note ?? '—');
      return `${pct(s.bare)} | ${pct(s.withSkill)} | ${sgn(s.lift)} [${sgn(s.ci.lift[0])}, ${sgn(s.ci.lift[1])}] | **${s.verdict}**`;
    });
    lines.push(`| ${skill} | ${any?.scenarios ?? 0} | ${cells.join(' | ')} |`);
  }
  lines.push('', '## Per scenario', '', `| Skill | Scenario | ${names.map((n) => `${n} bare | ${n} skill`).join(' | ')} | Flags |`, `|---|---|${names.map(() => '---:|---:|').join('')}---|`);
  for (const skill of skillNames) {
    const ids = [...new Set(agents.flatMap((a) => (row(a, skill)?.byScenario ?? []).map((r) => r.id)))];
    for (const id of ids) {
      const per = agents.map((a) => row(a, skill)?.byScenario?.find((r) => r.id === id));
      const flags = per.flatMap((r, i) => (r?.flags ?? []).map((f) => `${names[i]}: ${f}`));
      lines.push(`| ${skill} | ${id} | ${per.map((r) => (r ? `${r.bare.pass}/${r.bare.runs} | ${r.skill.pass}/${r.skill.runs}` : '— | —')).join(' | ')} | ${flags.join(', ') || '—'} |`);
    }
  }
  const failed = agents.flatMap((a) => a.skills.filter((x) => x.trials).flatMap((s) => (s.runs ?? []).filter((r) => !r.pass && r.output).map((r) => ({ ...r, name: s.skill, agent: a.agent }))));
  if (failed.length) {
    lines.push('', '## Failed runs', '');
    for (const r of failed) lines.push(`- ${r.agent} · ${r.name} · ${r.scenario} · ${r.arm} trial ${r.trial}: [output](${(linkBase ? `${linkBase}/` : '') + r.output})`);
  }
  lines.push('', report.cleanProfile
    ? 'Ran with --clean-profile: every agent got its own cleanArgs/cleanEnv in both arms.'
    : 'Caveat: each bare arm can still see that agent\'s user-level skills and global instructions unless the eval ran with --clean-profile.');
  return lines.join('\n') + '\n';
}
