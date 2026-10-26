// Supply-chain pinning for the CLI the skills run (`npx -y hyvemind@<version>`).
//
// An exact version stops npx resolving a look-alike, but not a compromised publish of
// that version's name on a registry mirror, nor a malicious release you upgraded to the
// day it appeared. Two guards cover those: `integrity` records npm's dist.integrity for
// the pinned version, so a registry serving different bytes is caught; and a cooling-off
// period refuses to pin a release younger than `coolingOffDays`, because most malicious
// releases are found and unpublished within days.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, pkgVersion, writeConfig } from './config.mjs';

const DAY = 86_400_000;

// The exact registry version the skills run, or null when `cli` runs a local bin.
export function cliVersion(cfg) {
  return cfg.cli.match(/\bhyvemind@(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/)?.[1] ?? null;
}

// `npm view hyvemind@<v> dist.integrity time --json`. Throws with a message that says
// which of "offline" or "not published" it was, since they call for different action.
export function registryInfo(version, { npm = 'npm' } = {}) {
  const r = spawnSync(npm, ['view', `hyvemind@${version}`, 'dist.integrity', 'time', '--json'], { encoding: 'utf8' });
  const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
  if (r.error || r.status !== 0) {
    if (/E404|is not in this registry|No match found/.test(out)) throw new Error(`hyvemind@${version} is not published on the npm registry`);
    if (r.error?.code === 'ENOENT') throw new Error(`"${npm}" is not installed; cannot check the registry`);
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network|offline/i.test(out)) {
      throw Object.assign(new Error('could not reach the npm registry (offline?)'), { offline: true });
    }
    throw new Error(`npm view hyvemind@${version} failed: ${out.trim().slice(0, 300)}`);
  }
  const j = JSON.parse(r.stdout);
  const published = j.time?.[version];
  return { integrity: j['dist.integrity'] ?? null, published: published ? new Date(published) : null };
}

// Whole days since publishing; a registry clock ahead of ours counts as 0.
export const ageDays = (published, now) => Math.max(0, Math.floor((now - published.getTime()) / DAY));

// Doctor checks, in doctor's shape: { ok: true | false | 'warn', name, detail }.
// Touches the network only when `integrity` is set, so an unpinned project's doctor
// stays offline-safe.
export function checkIntegrity(root, cfg, { npm = 'npm', now = Date.now() } = {}) {
  const checks = [];
  const add = (ok, name, detail = '') => checks.push({ ok, name, detail });
  const v = cliVersion(cfg);
  const running = pkgVersion();
  if (v) add(v === running ? true : 'warn', 'cli version', v === running ? `${v} (running)` : `skills run ${v}, but this is hyvemind ${running}; checks below are for ${v}`);
  if (!cfg.integrity) {
    add(true, 'cli integrity', v ? `not pinned (optional: "hyvemind pin" records dist.integrity for ${v})` : 'local install: the lockfile holds the hash');
    return checks;
  }
  if (!v) {
    add('warn', 'cli integrity', `"integrity" is set but cli (${cfg.cli}) is not an exact registry version; with a local install the lockfile holds the hash`);
    return checks;
  }
  let info;
  try { info = registryInfo(v, { npm }); } catch (e) {
    add(e.offline ? 'warn' : false, 'cli integrity', e.offline ? `${e.message}; the pin for ${v} could not be verified` : e.message);
    return checks;
  }
  add(info.integrity === cfg.integrity ? true : false, 'cli integrity',
    info.integrity === cfg.integrity
      ? `hyvemind@${v} matches the pinned ${cfg.integrity.slice(0, 20)}…`
      : `the registry serves hyvemind@${v} as ${String(info.integrity).slice(0, 20)}…, not the pinned ${cfg.integrity.slice(0, 20)}…; do not run it until you know why`);
  if (info.published) {
    const age = ageDays(info.published, now);
    add(age >= cfg.coolingOffDays ? true : 'warn', 'cli cooling-off',
      `hyvemind@${v} published ${info.published.toISOString().slice(0, 10)} (${age} day(s) ago; cooling-off ${cfg.coolingOffDays})`);
  }
  return checks;
}

// Records `cli` and `integrity` for the version the skills run, refusing a release
// younger than coolingOffDays unless allowFresh. Writes nothing on refusal.
export function pin(root, cfg, { npm = 'npm', now = Date.now(), allowFresh = false, dryRun = false } = {}) {
  const v = cliVersion(cfg);
  if (!v) throw new Error(`cli (${cfg.cli}) is not an exact registry version; with hyvemind as a devDependency the lockfile already pins its hash`);
  const info = registryInfo(v, { npm });
  if (!info.integrity) throw new Error(`the registry reports no dist.integrity for hyvemind@${v}`);
  const age = info.published ? ageDays(info.published, now) : null;
  if (age === null && !allowFresh) throw new Error(`the registry reports no publish time for hyvemind@${v}; cannot check the cooling-off period (--allow-fresh to pin anyway)`);
  if (age !== null && age < cfg.coolingOffDays && !allowFresh) {
    return { pinned: false, version: v, age, reason: `hyvemind@${v} was published ${age} day(s) ago, inside the ${cfg.coolingOffDays}-day cooling-off period; wait, or pass --allow-fresh` };
  }
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`no ${CONFIG_FILE} in ${root}`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  // Write cli too: the integrity belongs to one version, and an implicit default cli
  // would move to a new version on upgrade while the old hash stayed behind.
  const next = { ...raw, cli: cfg.cli, integrity: info.integrity };
  if (!dryRun) writeConfig(root, next);
  return { pinned: !dryRun, dryRun, version: v, age, integrity: info.integrity, fresh: age !== null && age < cfg.coolingOffDays };
}
