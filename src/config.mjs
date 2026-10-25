// Project configuration: hyvemind.json at the project root, merged over a preset.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = 'hyvemind.json';
export const STATE_DIR = '.hyve';

export const DEFAULTS = {
  version: 1,
  preset: 'generic',
  skills: {
    prefix: 'bee-',
    // Claude Code reads .claude/skills; .agents/skills is the cross-agent Agent Skills location.
    targets: ['.claude/skills', '.agents/skills'],
    include: 'all',
    exclude: [],
  },
  agentsMd: { paths: ['AGENTS.md'] },
  gates: [],
  probe: {
    command: 'npm test -- {test}',
    lanes: { default: '.' },
    timeoutSec: 600,
    errorPatterns: [],
  },
  review: { bannedPatterns: [] },
  specs: { dir: 'docs/decisions', nextNumberCommand: null },
  evals: {
    agent: 'claude',
    agents: {
      claude: { command: ['claude', '-p', '{prompt}'] },
      codex: { command: ['codex', 'exec', '{prompt}'] },
      opencode: { command: ['opencode', 'run', '{prompt}'] },
    },
    trials: 3,
    timeoutSec: 600,
    liftThreshold: 0.2,
    minRuns: 3,
  },
};

export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Arrays replace, objects merge: a project that lists gates means exactly those gates.
export function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function loadPreset(name) {
  const file = join(PKG_ROOT, 'presets', `${name}.json`);
  if (!existsSync(file)) throw new Error(`unknown preset "${name}" (looked for ${file})`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function validate(cfg) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  need(cfg.version === 1, 'version must be 1');
  need(typeof cfg.cli === 'string' && /\bhyvemind\b/.test(cfg.cli), 'cli must be a command that runs hyvemind');
  need(typeof cfg.skills?.prefix === 'string' && /^[a-z0-9-]*$/.test(cfg.skills.prefix), 'skills.prefix must be lowercase letters, digits or "-"');
  need(Array.isArray(cfg.skills?.targets) && cfg.skills.targets.length > 0, 'skills.targets must be a non-empty array');
  need(cfg.skills?.include === 'all' || Array.isArray(cfg.skills?.include), 'skills.include must be "all" or an array');
  need(Array.isArray(cfg.gates), 'gates must be an array');
  for (const [i, g] of (cfg.gates ?? []).entries()) {
    need(typeof g?.name === 'string' && g.name, `gates[${i}].name is required`);
    need(typeof g?.run === 'string' && g.run, `gates[${i}].run is required`);
  }
  need(typeof cfg.probe?.command === 'string' && cfg.probe.command.includes('{test}'), 'probe.command must contain {test}');
  need(isObject(cfg.probe?.lanes) && 'default' in cfg.probe.lanes, 'probe.lanes must include "default"');
  need(Array.isArray(cfg.review?.bannedPatterns), 'review.bannedPatterns must be an array');
  for (const [i, p] of (cfg.review?.bannedPatterns ?? []).entries()) {
    try { new RegExp(p.pattern); } catch { errs.push(`review.bannedPatterns[${i}].pattern is not a valid regex`); }
  }
  need(isObject(cfg.evals?.agents) && cfg.evals.agent in cfg.evals.agents, 'evals.agent must name an entry in evals.agents');
  for (const [k, a] of Object.entries(cfg.evals?.agents ?? {})) {
    need(Array.isArray(a?.command) && a.command.some((t) => t.includes('{prompt}')), `evals.agents.${k}.command must be an argv array containing {prompt}`);
  }
  return errs;
}

export function resolveConfig(raw) {
  const preset = raw?.preset ?? DEFAULTS.preset;
  const cfg = merge(merge(DEFAULTS, loadPreset(preset)), raw ?? {});
  // An exact registry version can never resolve to someone else's package.
  cfg.cli ??= `npx -y hyvemind@${pkgVersion()}`;
  const errs = validate(cfg);
  if (errs.length) throw new Error(`invalid ${CONFIG_FILE}:\n  - ${errs.join('\n  - ')}`);
  return cfg;
}

export function readConfig(root) {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`no ${CONFIG_FILE} in ${root} — run "hyvemind init" first`);
  return resolveConfig(JSON.parse(readFileSync(file, 'utf8')));
}

export function writeConfig(root, raw) {
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify(raw, null, 2) + '\n');
}

export function pkgVersion() {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
}
