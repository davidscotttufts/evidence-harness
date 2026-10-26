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
//                 { "type": "command", "run": "…" } ] }   // exit 0 = pass, run in the workspace
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PKG_ROOT, STATE_DIR, pkgVersion } from './config.mjs';
import { renderSkill } from './install.mjs';
import { leaseArgv } from './broker.mjs';

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
      case 'command': pass = spawnSync(c.run, { cwd: workdir, shell: true, timeout: 120000 }).status === 0; break;
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
    const r = spawnSync(scenario.setup, { cwd: dir, shell: true, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com' } });
    if (r.status !== 0) throw new Error(`scenario ${scenario.id} setup failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return dir;
}

// One run is an anecdote: below minRuns per arm the verdict is withheld, so a
// single lucky or unlucky trial can never recommend retiring a skill.
export function verdict(lift, threshold, runs = Infinity, minRuns = 3, withSkill = null) {
  if (runs < minRuns) return 'insufficient-data';
  // Neither arm ever passes: the skill doesn't help either, so the scenario (or the
  // skill) is broken. That is not evidence the model has outgrown the skill.
  if (withSkill === 0 && lift === 0) return 'no-signal';
  if (lift >= threshold) return 'earning';
  if (lift <= 0) return 'retire-candidate';
  return 'marginal';
}

function runAgent(cmd, args, cwd, timeoutSec, arm) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, HYVE_EVAL_ARM: arm }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => { if (out.length < 8 * 1024 * 1024) out += d.toString(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
    child.on('error', (e) => { clearTimeout(timer); done({ output: out, error: e.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ output: out, ...(signal === 'SIGKILL' ? { error: 'timed out' } : {}), code }); });
  });
}

// Runs every (scenario × trial × arm) job, up to `concurrency` at once. Each job gets
// its own scratch workspace, so concurrent runs never see each other's files.
export async function runEvals(root, cfg, { skills, agent, model, trials, keep = false, concurrency = 1, log = () => {} }) {
  const agentName = agent ?? cfg.evals.agent;
  const agentCfg = cfg.evals.agents[agentName];
  if (!agentCfg) throw new Error(`no evals.agents.${agentName} in config`);
  const report = { tool: 'hyvemind', version: pkgVersion(), startedAt: new Date().toISOString(), agent: agentName, model: model ?? null, skills: [] };
  const jobs = [];
  const bySkill = new Map();
  for (const skill of skills) {
    const scenarios = loadScenarios(root, cfg, skill);
    bySkill.set(skill, { scenarios, runs: [] });
    for (const sc of scenarios) {
      const n = trials ?? sc.trials ?? cfg.evals.trials;
      for (let t = 0; t < n; t++) for (const arm of ['bare', 'skill']) jobs.push({ skill, sc, trial: t + 1, n, arm });
    }
  }
  let next = 0, finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const dir = workspace(j.sc, cfg, j.skill, j.arm);
      try {
        const [cmd, ...args] = leaseArgv(cfg, 'eval', `${j.skill}/${j.sc.id}`, argv(agentCfg.command, { prompt: j.sc.prompt, workdir: dir, model }));
        const r = await runAgent(cmd, args, dir, cfg.evals.timeoutSec, j.arm);
        const checks = r.error ? [{ type: 'agent-run', pass: false, error: r.error }] : score(j.sc.checks, r.output, dir);
        const pass = checks.every((c) => c.pass);
        bySkill.get(j.skill).runs.push({ scenario: j.sc.id, trial: j.trial, arm: j.arm, pass, checks, ...(pass ? {} : { tail: r.output.trim().slice(-400) }) });
        log(`  [${++finished}/${jobs.length}] ${j.skill} · ${j.sc.id} · trial ${j.trial}/${j.n} · ${j.arm}: ${pass ? 'pass' : 'FAIL'}`);
      } finally {
        if (!keep) rmSync(dir, { recursive: true, force: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  for (const skill of skills) {
    const { scenarios, runs } = bySkill.get(skill);
    if (!scenarios.length) { report.skills.push({ skill, scenarios: 0, note: 'no scenarios' }); continue; }
    runs.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.trial - b.trial || a.arm.localeCompare(b.arm));
    const tally = (arm) => { const r = runs.filter((x) => x.arm === arm); return [r.filter((x) => x.pass).length, r.length]; };
    const rate = (a) => (a[1] ? a[0] / a[1] : 0);
    const [b, w] = [tally('bare'), tally('skill')];
    const lift = +(rate(w) - rate(b)).toFixed(3);
    report.skills.push({
      skill, scenarios: scenarios.length, bare: rate(b), withSkill: rate(w), trials: w[1],
      lift, verdict: verdict(lift, cfg.evals.liftThreshold, w[1], cfg.evals.minRuns, rate(w)), runs,
    });
  }
  report.finishedAt = new Date().toISOString();
  const dir = join(root, STATE_DIR, 'evals');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `report-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return { report, file };
}

const ACTION = {
  earning: 'Keep.',
  marginal: 'Thin it: cut the steps the bare model already does, then re-run.',
  'retire-candidate': 'Propose retiring it, or rewrite its scenarios to target a failure the bare model still makes. Needs the same verdict on a second model or run first.',
  'insufficient-data': 'Run more trials before deciding anything.',
  'no-signal': 'Neither arm passes: fix the scenario (or the skill) before reading anything into it.',
};

// Markdown summary of an eval report: the decision table people act on.
export function renderReport(report) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [
    `# hyvemind skill evals`,
    '',
    `Agent **${report.agent}**${report.model ? ` · model \`${report.model}\`` : ''} · hyvemind ${report.version} · ${report.startedAt}`,
    '',
    'Each scenario runs in a fresh scratch repo twice per trial: once **bare** (no skill) and once **with** the skill. Lift = with − bare.',
    '',
    '| Skill | Scenarios | Runs/arm | Bare | With skill | Lift | Verdict |',
    '|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const s of report.skills) {
    if (!s.trials) { lines.push(`| ${s.skill} | 0 | 0 | — | — | — | no scenarios |`); continue; }
    lines.push(`| ${s.skill} | ${s.scenarios} | ${s.trials} | ${pct(s.bare)} | ${pct(s.withSkill)} | ${s.lift > 0 ? '+' : ''}${s.lift} | **${s.verdict}** |`);
  }
  lines.push('', '## What to do', '');
  for (const s of report.skills.filter((x) => x.trials)) lines.push(`- **${s.skill}** (${s.verdict}): ${ACTION[s.verdict]}`);
  lines.push('', '## Per scenario', '', '| Skill | Scenario | Bare | With skill |', '|---|---|---:|---:|');
  for (const s of report.skills.filter((x) => x.trials)) {
    for (const id of [...new Set(s.runs.map((r) => r.scenario))]) {
      const arm = (a) => { const r = s.runs.filter((x) => x.scenario === id && x.arm === a); return `${r.filter((x) => x.pass).length}/${r.length}`; };
      lines.push(`| ${s.skill} | ${id} | ${arm('bare')} | ${arm('skill')} |`);
    }
  }
  lines.push('', 'Caveat: the bare arm can still see user-level skills and global instructions unless the eval ran from a clean profile.');
  return lines.join('\n') + '\n';
}
