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
//     "trials": 3,
//     "checks": [ { "type": "output-includes", "text": "…" },
//                 { "type": "output-excludes", "text": "…" },
//                 { "type": "output-matches", "pattern": "…", "flags": "i" },
//                 { "type": "file-exists", "path": "…" },
//                 { "type": "command", "run": "…" } ] }   // exit 0 = pass, run in the workspace
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PKG_ROOT, STATE_DIR, pkgVersion } from './config.mjs';
import { renderSkill } from './install.mjs';

export function loadScenarios(root, cfg, skill) {
  const dirs = [join(PKG_ROOT, 'skills', skill, 'evals'), join(root, cfg.evals.scenariosDir ?? '.hyve/scenarios', skill)];
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
  return dir;
}

// One run is an anecdote: below minRuns per arm the verdict is withheld, so a
// single lucky or unlucky trial can never recommend retiring a skill.
export function verdict(lift, threshold, runs = Infinity, minRuns = 3) {
  if (runs < minRuns) return 'insufficient-data';
  if (lift >= threshold) return 'earning';
  if (lift <= 0) return 'retire-candidate';
  return 'marginal';
}

export function runEvals(root, cfg, { skills, agent, model, trials, keep = false, log = () => {} }) {
  const agentName = agent ?? cfg.evals.agent;
  const agentCfg = cfg.evals.agents[agentName];
  if (!agentCfg) throw new Error(`no evals.agents.${agentName} in config`);
  const report = { tool: 'hyvemind', version: pkgVersion(), startedAt: new Date().toISOString(), agent: agentName, model: model ?? null, skills: [] };
  for (const skill of skills) {
    const scenarios = loadScenarios(root, cfg, skill);
    if (!scenarios.length) { report.skills.push({ skill, scenarios: 0, note: 'no scenarios' }); continue; }
    const tally = { bare: [0, 0], skill: [0, 0] };
    const runs = [];
    for (const sc of scenarios) {
      const n = trials ?? sc.trials ?? cfg.evals.trials;
      for (let t = 0; t < n; t++) {
        for (const arm of ['bare', 'skill']) {
          const dir = workspace(sc, cfg, skill, arm);
          try {
            const [cmd, ...args] = argv(agentCfg.command, { prompt: sc.prompt, workdir: dir, model });
            log(`  ${skill} · ${sc.id} · trial ${t + 1}/${n} · ${arm}`);
            const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: cfg.evals.timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HYVE_EVAL_ARM: arm } });
            const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
            const checks = r.error ? [{ type: 'agent-run', pass: false, error: r.error.message }] : score(sc.checks, output, dir);
            const pass = checks.every((c) => c.pass);
            tally[arm][0] += pass ? 1 : 0;
            tally[arm][1] += 1;
            runs.push({ scenario: sc.id, trial: t + 1, arm, pass, checks });
          } finally {
            if (!keep) rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
    const rate = (a) => (a[1] ? a[0] / a[1] : 0);
    const lift = +(rate(tally.skill) - rate(tally.bare)).toFixed(3);
    report.skills.push({
      skill, scenarios: scenarios.length, bare: rate(tally.bare), withSkill: rate(tally.skill), trials: tally.skill[1],
      lift, verdict: verdict(lift, cfg.evals.liftThreshold, tally.skill[1], cfg.evals.minRuns), runs,
    });
  }
  report.finishedAt = new Date().toISOString();
  const dir = join(root, STATE_DIR, 'evals');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `report-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return { report, file };
}
