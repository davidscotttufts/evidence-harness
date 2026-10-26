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
  // ── cli integrity ──
  // integrity: npm dist.integrity of the version in `cli` (written by "hyvemind pin").
  // coolingOffDays: "pin" refuses a release younger than this.
  integrity: null,
  coolingOffDays: 14,
  // ── end cli integrity ──
  skills: {
    // No prefix: skill names are chosen to be distinct (ship-change, open-pr, …).
    // A project can still set one if it wants its own namespace.
    prefix: '',
    // Claude Code reads .claude/skills; .agents/skills is the cross-agent Agent Skills location.
    targets: ['.claude/skills', '.agents/skills'],
    include: 'all',
    exclude: [],
    // ── skills.defer ──
    // bundled skill → project skill that takes precedence where it applies. The bundled
    // one is still installed, with a header that says so.
    defer: {},
    // ── end skills.defer ──
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
  // ── external evidence (one source of truth for "done") ──
  // evidence.status: a commit-status context the project's own gate posts; when set it
  // IS the proof, and hyvemind posts no second status. train.via "external": the
  // project merges through its own path, and `hyvemind train` refuses to merge.
  evidence: { status: null },
  train: { via: 'hyvemind', message: null },
  // ── end external evidence ──
  evals: {
    agent: 'claude',
    agents: {
      // Read-only tools, identical in both arms: an eval observes, it never writes.
      // The prompt goes BEFORE --allowedTools: that flag is variadic and would swallow it.
      // cleanArgs/cleanEnv apply to both arms with --clean-profile: user-level settings,
      // skills and CLAUDE.md are left out (setting sources), no MCP servers, no auto-memory.
      // Auth is untouched. Agents get an allowlisted env; add an auth var with "env".
      claude: {
        command: ['claude', '-p', '{prompt}', '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git status:*),Bash(git log:*)'],
        authCheck: { command: ['claude', 'auth', 'status'] },
        cleanArgs: ['--setting-sources', 'project,local', '--strict-mcp-config'],
        cleanEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      },
      // codex's clean flags are `exec` options (rejected before the subcommand), so they
      // go at {clean}. Per `codex exec --help` (codex-cli 0.164.0): --ignore-user-config
      // skips $CODEX_HOME/config.toml (auth still uses CODEX_HOME), --ephemeral persists no
      // session files, --ignore-rules skips user and project execpolicy .rules files.
      codex: {
        command: ['codex', 'exec', '{clean}', '{prompt}'],
        authCheck: { command: ['codex', 'login', 'status'] },
        cleanArgs: ['--ignore-user-config', '--ephemeral', '--ignore-rules'],
      },
      // No cleanArgs: opencode's only candidate, --pure, just drops external plugins.
      // `opencode auth list` exits 0 with no credentials, so its check also needs a match.
      opencode: { command: ['opencode', 'run', '{prompt}'], authCheck: { command: ['opencode', 'auth', 'list'], match: '\\b[1-9]\\d* credentials?\\b' } },
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
  // ── cli integrity ──
  need(cfg.integrity === null || (typeof cfg.integrity === 'string' && /^sha(256|384|512)-[A-Za-z0-9+/]+=*$/.test(cfg.integrity)), 'integrity must be an npm dist.integrity string, e.g. "sha512-…"');
  need(Number.isInteger(cfg.coolingOffDays) && cfg.coolingOffDays >= 0, 'coolingOffDays must be a whole number of days ≥ 0');
  need(cfg.coolingOffWaived === undefined || typeof cfg.coolingOffWaived === 'string', 'coolingOffWaived must be the version the waiver covers, e.g. "0.3.0"');
  // ── end cli integrity ──
  need(typeof cfg.skills?.prefix === 'string' && /^[a-z0-9-]*$/.test(cfg.skills.prefix), 'skills.prefix must be lowercase letters, digits or "-"');
  need(Array.isArray(cfg.skills?.targets) && cfg.skills.targets.length > 0, 'skills.targets must be a non-empty array');
  need(cfg.skills?.include === 'all' || Array.isArray(cfg.skills?.include), 'skills.include must be "all" or an array');
  // ── skills.defer (bundled names are checked against the selection in install.mjs) ──
  need(isObject(cfg.skills?.defer) && Object.values(cfg.skills.defer).every((v) => typeof v === 'string' && /^[\w.:/-]+$/.test(v)),
    'skills.defer must map bundled skill names to project skill names (letters, digits, - _ . : /)');
  // ── end skills.defer ──
  need(Array.isArray(cfg.gates), 'gates must be an array');
  if (cfg.externalGate !== undefined) {
    need(isObject(cfg.externalGate) && typeof cfg.externalGate.run === 'string' && cfg.externalGate.run && typeof cfg.externalGate.done === 'string' && cfg.externalGate.done,
      'externalGate needs "run" (the project\'s own gate command) and "done" (what counts as done)');
    need(!cfg.gates.length, 'externalGate and gates are mutually exclusive: one definition of done');
  }
  // ── external evidence ──
  need(cfg.evidence?.status === null || (typeof cfg.evidence?.status === 'string' && cfg.evidence.status.trim() !== ''), 'evidence.status must be null or a commit-status context, e.g. "ci/local-verify"');
  need(['hyvemind', 'external'].includes(cfg.train?.via), 'train.via must be "hyvemind" or "external"');
  need(cfg.train?.message === null || typeof cfg.train?.message === 'string', 'train.message must be a string');
  // ── end external evidence ──
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
    need(a?.env === undefined || (Array.isArray(a.env) && a.env.every((x) => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x))), `evals.agents.${k}.env must be a list of environment variable NAMES`);
    need(!Array.isArray(a?.command) || (a.command[0] !== '{clean}' && a.command.every((t) => t === '{clean}' || !t.includes('{clean}'))), `evals.agents.${k}.command: {clean} must be a whole argument after the executable`);
    need(a?.cleanArgs === undefined || (Array.isArray(a.cleanArgs) && a.cleanArgs.every((x) => typeof x === 'string')), `evals.agents.${k}.cleanArgs must be an argv array`);
    need(a?.authCheck === undefined || (isObject(a.authCheck) && Array.isArray(a.authCheck.command) && a.authCheck.command.length > 0 && a.authCheck.command.every((x) => typeof x === 'string')), `evals.agents.${k}.authCheck.command must be an argv array`);
    if (a?.authCheck?.match !== undefined) { try { new RegExp(a.authCheck.match); } catch { errs.push(`evals.agents.${k}.authCheck.match is not a valid regex`); } }
    need(a?.cleanEnv === undefined || (isObject(a.cleanEnv) && Object.values(a.cleanEnv).every((x) => typeof x === 'string')), `evals.agents.${k}.cleanEnv must map names to string values`);
  }
  return errs;
}

export function resolveConfig(raw) {
  const preset = raw?.preset ?? DEFAULTS.preset;
  const cfg = merge(merge(DEFAULTS, loadPreset(preset)), raw ?? {});
  // externalGate REPLACES the preset's gates: a project with its own gate has one
  // definition of done. Only gates the project itself lists can conflict with it.
  if (raw?.externalGate !== undefined && raw?.gates === undefined) cfg.gates = [];
  // An exact registry version can never resolve to someone else's package.
  cfg.cli ??= `npx -y hyvemind@${pkgVersion()}`;
  const errs = validate(cfg);
  if (errs.length) throw new Error(`invalid ${CONFIG_FILE}:\n  - ${errs.join('\n  - ')}`);
  // Whether the project chose evals.agent itself; a built-in default yields to the host agent.
  Object.defineProperty(cfg.evals, 'agentFromProject', { value: raw?.evals?.agent !== undefined || loadPreset(preset)?.evals?.agent !== undefined });
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
