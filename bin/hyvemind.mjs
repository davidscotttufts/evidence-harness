#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, pkgVersion, readConfig, resolveConfig, writeConfig } from '../src/config.mjs';
import { detect } from '../src/detect.mjs';
import { doctor } from '../src/doctor.mjs';
import { affected } from '../src/affected.mjs';
import { renderReport, runEvals } from '../src/evals.mjs';
import { evidenceFor, runGates } from '../src/gate.mjs';
import { git } from '../src/git.mjs';
import { bundledSkills, installAgentsMd, installSkills, selectedSkills } from '../src/install.mjs';
import { mine } from '../src/mine.mjs';
import { runProbes } from '../src/probe.mjs';
import { runPlan } from '../src/run.mjs';
import { postStatus } from '../src/status.mjs';
import { githubForge, localForge, runTrain } from '../src/train.mjs';

const HELP = `hyvemind ${pkgVersion()}

Usage: hyvemind <command> [options]

  init      Detect the project, write ${CONFIG_FILE}, install skills + the AGENTS.md block
            --preset <name>   force a preset (openwop | node | python | generic)
            --dry-run         show what would change
  update    Re-install skills and the AGENTS.md block (keeps files you edited; --force overwrites)
  doctor    Check config, installed skills, collisions and the AGENTS.md block
  list      List bundled skills and whether this project installs them
  gate      Run the configured gates; record a verdict bound to the working tree
            --only <a,b>  run a subset (recorded as partial; never counts as evidence)
            --keep-going  run every gate even after a red one   --quiet
  evidence  Exit 0 if the CURRENT working tree has a full green gate record
            --post        publish it as a GitHub commit status (hyvemind/gate) on HEAD
                          (refused unless the tree is clean and gated); --dry-run prints it
  affected  List the tests a change can reach (static import graph; ALL when untraceable)
            --base <ref>  include commits since <ref>   --json   --run (affected.command)
  train <pr…>           Merge queue: gate several PRs as ONE train, merge on green, prove
                        main's tree == the gated tree, bisect a red train
            --base <branch>  --no-merge  --no-bisect  --local (ids are origin branches)
  run <plan.md>         Each plan task → a fresh agent in its own worktree; done = the
                        task's exit check; an independent reviewer must say GO
            --spec <file>  --only T1,T3  --no-review  --branch <name>
  probe <probes.json>   Sabotage probes: break the code, prove the test goes red
  eval [skill…]         Bare model vs with-skill on each skill's scenarios
            --agent <name>  --model <id>  --trials <n>  --concurrency <n>  --keep
            --report          also write the markdown decision table (.hyve/evals/REPORT.md, or --out <file>)
            --render <report.json>  render an existing report without running anything
  mine      Mine Claude Code transcripts for skill usage and chains
            --filter <substr>  --all  --root <dir>  --json

Global: --cwd <dir> (project root; default: the git toplevel of the current directory)
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: 'string' }, preset: { type: 'string' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' },
    only: { type: 'string' }, 'keep-going': { type: 'boolean' }, quiet: { type: 'boolean' },
    agent: { type: 'string' }, model: { type: 'string' }, trials: { type: 'string' }, keep: { type: 'boolean' },
    filter: { type: 'string' }, all: { type: 'boolean' }, root: { type: 'string' }, json: { type: 'boolean' },
    post: { type: 'boolean' }, base: { type: 'string' }, run: { type: 'boolean' }, 'no-merge': { type: 'boolean' },
    'no-bisect': { type: 'boolean' }, local: { type: 'boolean' }, spec: { type: 'string' }, 'no-review': { type: 'boolean' },
    branch: { type: 'string' }, concurrency: { type: 'string' }, report: { type: 'boolean' }, out: { type: 'string' }, render: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  },
});
const [cmd, ...rest] = positionals;

function projectRoot() {
  if (o.cwd) return resolve(o.cwd);
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  return top.status === 0 ? top.out : process.cwd();
}

function summarize(actions) {
  const counts = {};
  for (const a of actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  for (const a of actions.filter((x) => ['modified', 'foreign', 'orphan-modified'].includes(x.action))) {
    console.log(`  kept ${a.action === 'foreign' ? '(existed before hyvemind)' : a.action === 'orphan-modified' ? '(no longer produced, but edited locally: remove it yourself)' : '(edited locally)'}: ${a.rel}`);
  }
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}

async function main() {
  if (o.version) return console.log(pkgVersion());
  if (o.help || !cmd) return console.log(HELP);
  const root = projectRoot();

  switch (cmd) {
    case 'init': {
      const file = join(root, CONFIG_FILE);
      let raw;
      if (existsSync(file)) {
        raw = JSON.parse(readFileSync(file, 'utf8'));
        console.log(`${CONFIG_FILE} exists (preset ${raw.preset ?? 'generic'}); keeping it`);
      } else {
        const d = detect(root);
        const preset = o.preset ?? d.preset;
        // Installed as a devDependency → run that copy; otherwise the pinned registry default.
        const local = existsSync(join(root, 'node_modules/hyvemind/package.json'));
        raw = { $schema: 'https://raw.githubusercontent.com/davidscotttufts/hyvemind/main/schema/hyvemind.schema.json', version: 1, preset, ...(local ? { cli: 'npx hyvemind' } : {}), ...(o.preset ? {} : d.overrides) };
        console.log(`detected preset "${preset}" (${o.preset ? 'forced' : d.reason})`);
      }
      const cfg = resolveConfig(raw);
      const dry = Boolean(o['dry-run']);
      if (!dry && !existsSync(file)) writeConfig(root, raw);
      console.log(`skills: ${summarize(installSkills(root, cfg, { dryRun: dry, force: o.force }))}`);
      console.log(`agents md: ${summarize(installAgentsMd(root, cfg, { dryRun: dry }))}`);
      console.log(dry ? '(dry run: nothing written)' : `\nnext: review ${CONFIG_FILE} gates, then run "${cfg.cli} doctor" and "${cfg.cli} gate"`);
      return;
    }
    case 'update': {
      const cfg = readConfig(root);
      const dry = Boolean(o['dry-run']);
      console.log(`skills: ${summarize(installSkills(root, cfg, { dryRun: dry, force: o.force }))}`);
      console.log(`agents md: ${summarize(installAgentsMd(root, cfg, { dryRun: dry }))}`);
      return;
    }
    case 'doctor': {
      const checks = doctor(root);
      for (const c of checks) console.log(`${c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      if (checks.some((c) => c.ok === false)) process.exitCode = 1;
      return;
    }
    case 'list': {
      let chosen = null;
      try { chosen = selectedSkills(readConfig(root)); } catch { /* no config: just list */ }
      for (const s of bundledSkills()) {
        const desc = (readFileSync(new URL(`../skills/${s}/SKILL.md`, import.meta.url), 'utf8').match(/^description:\s*"?(.*?)"?$/m)?.[1] ?? '').slice(0, 96);
        console.log(`${chosen ? (chosen.includes(s) ? '●' : '○') + ' ' : ''}${s.padEnd(16)} ${desc}`);
      }
      return;
    }
    case 'gate': {
      const cfg = readConfig(root);
      const { record, file } = await runGates(root, cfg, { only: o.only?.split(','), keepGoing: o['keep-going'], quiet: o.quiet });
      for (const g of record.gates) console.log(`${g.skipped ? '–' : g.pass ? '✓' : '✗'} ${g.name}${g.skipped ? ' (skipped)' : ` ${(g.durationMs / 1000).toFixed(1)}s`}`);
      console.log(`verdict: ${record.verdict.toUpperCase()}${record.partial ? ' (partial)' : ''} · tree ${record.treeAfter.slice(0, 12)} · ${file}`);
      if (record.verdict === 'invalid') console.log('the working tree changed while the gates ran; this run proves nothing about either tree');
      if (record.verdict !== 'green') process.exitCode = 1;
      return;
    }
    case 'evidence': {
      if (o.post) {
        const r = postStatus(root, { dryRun: o['dry-run'] });
        if (r.reason) { console.log(`not posted: ${r.reason}`); process.exitCode = 1; return; }
        console.log(`${r.posted ? 'posted' : 'would post'} ${r.state} to ${r.slug}@${r.sha.slice(0, 12)} (hyvemind/gate): ${r.description}`);
        if (r.state !== 'success') process.exitCode = 1;
        return;
      }
      const { tree, match, latest } = evidenceFor(root);
      if (match) { console.log(`green · tree ${tree.slice(0, 12)} · ${match.finishedAt} · ${match.file}`); return; }
      console.log(latest ? `no green evidence for tree ${tree.slice(0, 12)}; latest run on it was ${latest.verdict}${latest.partial ? ' (partial)' : ''}` : `no gate has run on tree ${tree.slice(0, 12)}; run "hyvemind gate"`);
      process.exitCode = 1;
      return;
    }
    case 'probe': {
      if (!rest[0]) throw new Error('usage: hyvemind probe <probes.json>');
      const cfg = readConfig(root);
      const probes = JSON.parse(readFileSync(resolve(rest[0]), 'utf8'));
      const { results, srcStatus } = runProbes(root, cfg, probes);
      for (const r of results) console.log(JSON.stringify(r));
      console.log(`PROBED_SRC_STATUS: ${srcStatus}`);
      if (srcStatus !== 'clean') process.exitCode = 2;
      else if (results.some((r) => r.verdict !== 'witnessed')) process.exitCode = 1;
      return;
    }
    case 'eval': {
      const cfg = readConfig(root);
      const skills = rest.length ? rest : selectedSkills(cfg);
      if (o.render) {
        process.stdout.write(renderReport(JSON.parse(readFileSync(resolve(o.render), 'utf8'))));
        return;
      }
      const { report, file } = await runEvals(root, cfg, {
        skills, agent: o.agent, model: o.model, trials: o.trials ? Number(o.trials) : undefined, keep: o.keep,
        concurrency: o.concurrency ? Number(o.concurrency) : 1,
        log: (m) => process.stderr.write(`${m}\n`),
      });
      console.log(`agent ${report.agent}${report.model ? ` · model ${report.model}` : ''}`);
      console.log('skill            bare   skill  lift   verdict');
      for (const s of report.skills) {
        if (!s.trials) { console.log(`${s.skill.padEnd(16)} —      —      —      ${s.note}`); continue; }
        const pct = (x) => `${Math.round(x * 100)}%`.padEnd(6);
        console.log(`${s.skill.padEnd(16)} ${pct(s.bare)} ${pct(s.withSkill)} ${String(s.lift).padEnd(6)} ${s.verdict}`);
      }
      console.log(`report: ${file}`);
      if (o.report) {
        const md = o.out ? resolve(o.out) : join(root, '.hyve', 'evals', 'REPORT.md');
        writeFileSync(md, renderReport(report));
        console.log(`markdown: ${md}`);
      }
      return;
    }
    case 'affected': {
      const cfg = readConfig(root);
      const r = affected(root, cfg, { base: o.base ?? null });
      if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(r.all ? `ALL tests (${r.reason})` : r.reason);
      for (const t of r.tests) console.log(`  ${t}`);
      if (o.run) {
        const a = cfg.affected ?? {};
        const quote = (f) => `'${f.replace(/'/g, `'\\''`)}'`;
        const command = r.all ? (a.allCommand ?? cfg.gates.map((g) => g.run).join(' && ')) : r.tests.length ? (a.command ?? cfg.probe.command).replace('{test}', '{tests}').replace('{tests}', r.tests.map(quote).join(' ')) : null;
        if (!command) { console.log('nothing to run'); return; }
        console.log(`\n▶ ${command}`);
        process.exitCode = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' }).status ?? 1;
      }
      return;
    }
    case 'train': {
      if (!rest.length) throw new Error('usage: hyvemind train <pr> [<pr>…]');
      const cfg = readConfig(root);
      const base = o.base ?? cfg.train?.base ?? 'main';
      const forge = o.local ? localForge(root, base) : githubForge(root);
      const r = await runTrain(root, cfg, rest, {
        base, forge, merge: !o['no-merge'], bisect: !o['no-bisect'], quiet: o.quiet,
        log: (m) => console.log(m),
      });
      const label = (ids) => ids.map(forge.label).join(' ') || '—';
      console.log(`\nmerged: ${label(r.merged)} · gated (not merged): ${label(r.gated)} · red: ${label(r.red)} · conflicts: ${label(r.conflicts)} · refused: ${label(r.refused)} · gate runs: ${r.gates}`);
      if (r.red.length || r.conflicts.length || r.refused.length) process.exitCode = 1;
      return;
    }
    case 'run': {
      if (!rest[0]) throw new Error('usage: hyvemind run <plan.md>');
      const cfg = readConfig(root);
      const { report, file } = runPlan(root, cfg, rest[0], {
        spec: o.spec, only: o.only?.split(','), review: !o['no-review'], branch: o.branch, base: o.base,
        log: (m) => console.log(m),
      });
      for (const t of report.tasks) console.log(`${t.id.padEnd(4)} ${(t.status ?? '').padEnd(15)} ${t.title ?? ''}`);
      console.log(`branch ${report.branch} · worktree ${report.dir}\nreport: ${file}`);
      if (report.tasks.some((t) => !['done', 'already-done', 'no-change'].includes(t.status))) process.exitCode = 1;
      return;
    }
    case 'mine': {
      const r = mine({
        root: o.root, filter: o.all ? '' : (o.filter ?? root.replace(/[/.]/g, '-')),
        prefix: (() => { try { return readConfig(root).skills.prefix; } catch { return ''; } })(),
      });
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`sessions ${r.sessions} · invocations ${r.invocations} · filter ${r.filter ?? '<all>'}\n\ntop skills`);
      for (const [k, n] of r.top) console.log(`  ${String(n).padStart(4)}  ${k}`);
      console.log('\nchains (count · confidence)');
      for (const b of r.bigrams) console.log(`  ${String(b.count).padStart(4)}  ${b.confidence.toFixed(2)}  ${b.chain}`);
      console.log('\ntrigrams');
      for (const [k, n] of r.trigrams) console.log(`  ${String(n).padStart(4)}  ${k}`);
      return;
    }
    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`hyvemind: ${e.message}`); process.exitCode = e.fatal ? 2 : 1; });
