import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pkgVersion, resolveConfig } from '../src/config.mjs';
import { checkIntegrity, cliVersion, pin } from '../src/integrity.mjs';
import { repo, write } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/hyvemind.mjs', import.meta.url));
const V = pkgVersion();
const SHA = 'sha512-' + 'A'.repeat(86) + '==';
const OTHER = 'sha512-' + 'B'.repeat(86) + '==';
const NOW = Date.parse('2026-11-30T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

// A fake `npm` on its own dir: answers `npm view` from registry.json, or fails the way
// the real one does (E404 for an unpublished version, ENOTFOUND when offline).
function fakeNpm(dir, mode, { integrity = SHA, published = daysAgo(30) } = {}) {
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'registry.json'), JSON.stringify({ 'dist.integrity': integrity, time: { created: daysAgo(400), [V]: published } }));
  const body = {
    ok: `echo "$*" >> "${bin}/calls"; cat "${bin}/registry.json"`,
    e404: `echo "npm error code E404" >&2; echo "npm error 404 No match found for version" >&2; exit 1`,
    offline: `echo "npm error code ENOTFOUND" >&2; echo "npm error network request failed" >&2; exit 1`,
  }[mode];
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  return join(bin, 'npm');
}
const project = (over = {}) => {
  const dir = repo({ '.gitignore': 'fake-bin/\n' });
  write(dir, { 'hyvemind.json': JSON.stringify({ version: 1, ...over }, null, 2) });
  return dir;
};
const cfgOf = (dir) => resolveConfig(JSON.parse(readFileSync(join(dir, 'hyvemind.json'), 'utf8')));
const byName = (checks, name) => checks.find((c) => c.name === name);

test('cliVersion reads the exact registry version, and null for a local bin', () => {
  assert.equal(cliVersion(resolveConfig({ version: 1 })), V);
  assert.equal(cliVersion(resolveConfig({ version: 1, cli: 'npx -y hyvemind@1.2.3-rc.1' })), '1.2.3-rc.1');
  assert.equal(cliVersion(resolveConfig({ version: 1, cli: 'npx hyvemind' })), null);
});

test('pin records cli and integrity for a release past the cooling-off period', () => {
  const dir = project({ preset: 'generic' });
  const r = pin(dir, cfgOf(dir), { npm: fakeNpm(dir, 'ok'), now: NOW });
  assert.equal(r.pinned, true);
  const raw = JSON.parse(readFileSync(join(dir, 'hyvemind.json'), 'utf8'));
  assert.equal(raw.integrity, SHA);
  assert.equal(raw.cli, `npx -y hyvemind@${V}`, 'the version the hash belongs to is written too');
  assert.equal(raw.preset, 'generic', 'other keys kept');
  assert.match(readFileSync(join(dir, 'fake-bin/calls'), 'utf8'), new RegExp(`view hyvemind@${V.replace(/\./g, '\\.')} dist.integrity time --json`));
});

test('pin refuses a release younger than coolingOffDays and writes nothing, unless --allow-fresh', () => {
  const dir = project();
  const before = readFileSync(join(dir, 'hyvemind.json'), 'utf8');
  const npm = fakeNpm(dir, 'ok', { published: daysAgo(3) });
  const r = pin(dir, cfgOf(dir), { npm, now: NOW });
  assert.equal(r.pinned, false);
  assert.match(r.reason, /published 3 day\(s\) ago, inside the 14-day cooling-off period/);
  assert.equal(readFileSync(join(dir, 'hyvemind.json'), 'utf8'), before);
  assert.equal(pin(dir, cfgOf(dir), { npm, now: NOW, allowFresh: true }).pinned, true);
  // A shorter configured period admits the same release.
  const short = project({ coolingOffDays: 2 });
  assert.equal(pin(short, cfgOf(short), { npm: fakeNpm(short, 'ok', { published: daysAgo(3) }), now: NOW }).pinned, true);
});

test('pin refuses a local-bin cli, an unpublished version, and says when the registry is unreachable', () => {
  const local = project({ cli: 'npx hyvemind' });
  assert.throws(() => pin(local, cfgOf(local), { npm: fakeNpm(local, 'ok'), now: NOW }), /lockfile already pins/);
  const dir = project();
  assert.throws(() => pin(dir, cfgOf(dir), { npm: fakeNpm(dir, 'e404'), now: NOW }), /is not published on the npm registry/);
  assert.throws(() => pin(dir, cfgOf(dir), { npm: fakeNpm(dir, 'offline'), now: NOW }), /could not reach the npm registry \(offline\?\)/);
});

test('checkIntegrity: matching pin passes; a registry serving other bytes fails; offline warns', () => {
  const dir = project({ integrity: SHA });
  const ok = checkIntegrity(dir, cfgOf(dir), { npm: fakeNpm(dir, 'ok'), now: NOW });
  assert.equal(byName(ok, 'cli version').ok, true);
  assert.equal(byName(ok, 'cli integrity').ok, true);
  assert.equal(byName(ok, 'cli cooling-off').ok, true);
  const bad = checkIntegrity(dir, cfgOf(dir), { npm: fakeNpm(dir, 'ok', { integrity: OTHER }), now: NOW });
  assert.equal(byName(bad, 'cli integrity').ok, false);
  assert.match(byName(bad, 'cli integrity').detail, /not the pinned/);
  const off = checkIntegrity(dir, cfgOf(dir), { npm: fakeNpm(dir, 'offline'), now: NOW });
  assert.equal(byName(off, 'cli integrity').ok, 'warn');
  assert.match(byName(off, 'cli integrity').detail, /offline/);
  const fresh = checkIntegrity(dir, cfgOf(dir), { npm: fakeNpm(dir, 'ok', { published: daysAgo(1) }), now: NOW });
  assert.equal(byName(fresh, 'cli cooling-off').ok, 'warn');
});

test('checkIntegrity: unpinned never touches the network; a version mismatch warns', () => {
  const dir = project();
  const npm = fakeNpm(dir, 'ok');
  const checks = checkIntegrity(dir, cfgOf(dir), { npm, now: NOW });
  assert.equal(byName(checks, 'cli integrity').ok, true);
  assert.match(byName(checks, 'cli integrity').detail, /not pinned/);
  assert.throws(() => readFileSync(join(dir, 'fake-bin/calls')), /ENOENT/, 'npm not called');
  const other = project({ cli: 'npx -y hyvemind@0.0.1' });
  assert.equal(byName(checkIntegrity(other, cfgOf(other), { npm, now: NOW }), 'cli version').ok, 'warn');
});

test('integrity and coolingOffDays are validated', () => {
  assert.equal(resolveConfig({ version: 1 }).coolingOffDays, 14);
  assert.equal(resolveConfig({ version: 1 }).integrity, null);
  assert.throws(() => resolveConfig({ version: 1, integrity: 'md5-abc' }), /integrity must be/);
  assert.throws(() => resolveConfig({ version: 1, coolingOffDays: -1 }), /coolingOffDays must be/);
});

test('hyvemind pin from the CLI, with npm faked on PATH', () => {
  const dir = project();
  const npm = fakeNpm(dir, 'ok', { published: new Date(Date.now() - 2 * 86_400_000).toISOString() });
  const env = { ...process.env, PATH: `${join(dir, 'fake-bin')}:${process.env.PATH}` };
  const go = (...args) => spawnSync('node', [BIN, ...args], { cwd: dir, encoding: 'utf8', env });
  assert.ok(npm);
  const refused = go('pin');
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stdout, /not pinned: .*cooling-off/);
  const forced = go('pin', '--allow-fresh');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, new RegExp(`pinned hyvemind@${V.replace(/\./g, '\\.')} sha512-`));
  assert.equal(JSON.parse(readFileSync(join(dir, 'hyvemind.json'), 'utf8')).integrity, SHA);
});

test('--allow-fresh records a waiver for exactly that version; doctor honours it; re-pinning a mature version drops it', () => {
  const dir = project();
  const npm = fakeNpm(dir, 'ok', { published: daysAgo(3) });
  const r = pin(dir, cfgOf(dir), { npm, now: NOW, allowFresh: true });
  assert.equal(r.waived, V);
  assert.equal(cfgOf(dir).coolingOffWaived, V);
  const c = byName(checkIntegrity(dir, cfgOf(dir), { npm, now: NOW }), 'cli cooling-off');
  assert.equal(c.ok, true);
  assert.match(c.detail, /WAIVED for this version/);
  const mature = fakeNpm(dir, 'ok', { published: daysAgo(30) });
  pin(dir, cfgOf(dir), { npm: mature, now: NOW });
  assert.equal(cfgOf(dir).coolingOffWaived, undefined, 'a waiver never outlives the fresh version it covered');
});
