import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, pkgVersion, readConfig } from './config.mjs';
import { isRepo } from './git.mjs';
import { BLOCK_END, installSkills, readManifest } from './install.mjs';

// Each check: { ok: true | false | 'warn', name, detail }
export function doctor(root) {
  const checks = [];
  const add = (ok, name, detail = '') => checks.push({ ok, name, detail });
  add(isRepo(root), 'git repository', isRepo(root) ? '' : 'gate evidence is bound to git trees; run inside a repo');
  let cfg;
  try { cfg = readConfig(root); add(true, CONFIG_FILE, `preset ${cfg.preset}`); } catch (e) { add(false, CONFIG_FILE, e.message); return checks; }
  add(cfg.gates.length > 0 ? true : 'warn', 'gates', cfg.gates.length ? cfg.gates.map((g) => g.name).join(' → ') : 'none configured; "hyvemind gate" will refuse to run');
  const m = readManifest(root);
  add(m.version === pkgVersion() ? true : 'warn', 'installed version', m.version ? `${m.version} (hyvemind is ${pkgVersion()})` : 'skills not installed; run "hyvemind init"');
  const plan = installSkills(root, cfg, { dryRun: true });
  const by = (a) => plan.filter((p) => p.action === a);
  const stale = by('write').length + by('update').length;
  add(stale === 0 ? true : 'warn', 'skills current', stale ? `${stale} file(s) would change; run "hyvemind update"` : `${by('same').length} file(s)`);
  if (by('modified').length) add('warn', 'skills edited locally', by('modified').map((p) => p.rel).join(', '));
  if (by('foreign').length) add('warn', 'name collisions', `${by('foreign').map((p) => p.rel).join(', ')} existed before hyvemind; change skills.prefix or remove them`);
  for (const p of cfg.agentsMd.paths) {
    const f = join(root, p);
    const has = existsSync(f) && readFileSync(f, 'utf8').includes(BLOCK_END);
    add(has ? true : 'warn', `${p} block`, has ? '' : 'missing; run "hyvemind update"');
  }
  // Skills run `cfg.cli`. A pinned `npx -y hyvemind@x.y.z` is safe anywhere; a bare
  // `npx hyvemind` is safe only when it resolves locally or globally — otherwise npx
  // would download whatever the npm registry serves under that name.
  if (/@\d+\.\d+\.\d+/.test(cfg.cli)) {
    add(true, 'cli', `${cfg.cli} (exact registry version)`);
  } else {
    const local = existsSync(join(root, 'node_modules/.bin/hyvemind'));
    const global = !local && spawnSync('sh', ['-c', 'command -v hyvemind'], { encoding: 'utf8' }).status === 0;
    add(local || global ? true : 'warn', 'cli', local ? `${cfg.cli} → node_modules/.bin` : global ? `${cfg.cli} → global install` : `"${cfg.cli}" does not resolve locally; install hyvemind as a devDependency or pin "cli" to an exact version`);
  }
  const ign = join(root, '.hyve/.gitignore');
  add(existsSync(ign) ? true : 'warn', 'evidence ignored by git', existsSync(ign) ? '' : 'run "hyvemind update"');
  return checks;
}
