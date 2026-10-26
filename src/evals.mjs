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
  const report = { tool: 'hyvemind', version: pkgVersion(), startedAt: new Date().toISOString(), agent: agentName, model: model ?? null,
    thresholds: { liftThreshold: cfg.evals.liftThreshold, minRuns: cfg.evals.minRuns }, skills: [] };
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
    report.skills.push(summarize({ skill, scenarios: scenarios.length, size: skillSize(skill, cfg), runs }, report.thresholds));
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
  'earning (low n)': 'Probably keep, but the lift interval still includes 0: run more trials before citing the lift.',
  marginal: 'Thin it: cut the steps the bare model already does, then re-run.',
  saturated: 'Unmeasured below ceiling: both arms pass every run, so these scenarios cannot show lift. Write a scenario the bare model still fails; do not retire on this.',
  'retire-candidate': 'Propose retiring it, or rewrite its scenarios to target a failure the bare model still makes. Needs the same verdict on a second model or run first.',
  'insufficient-data': 'Run more trials before deciding anything.',
  'no-signal': 'Neither arm passes: fix the scenario (or the skill) before reading anything into it.',
};

// Markdown summary of an eval report: the decision table people act on. Verdicts and
// intervals are recomputed from the runs, so an old report renders with today's rules.
export function renderReport(report, fallback = {}) {
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
  lines.push('', 'Caveat: the bare arm can still see user-level skills and global instructions unless the eval ran from a clean profile.');
  return lines.join('\n') + '\n';
}
