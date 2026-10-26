import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { runGates } from '../src/gate.mjs';
import { checkEvidence, postStatus, repoSlug, statusFor } from '../src/status.mjs';
import { repo, sh, write } from './helpers.mjs';

const cfg = (run) => resolveConfig({ version: 1, gates: [{ name: 'ci', run }] });

// A fake `gh` that records its argv, so the post is asserted without the network.
function fakeGh(dir) {
  const bin = join(dir, 'fake-gh');
  write(dir, { 'fake-gh': `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/gh-args"\n` });
  chmodSync(bin, 0o755);
  return bin;
}

function githubRepo() {
  // .hyve/ is committed (or ignored) in a real install; here it is ignored.
  const dir = repo({ '.gitignore': 'fake-gh\ngh-args\n.hyve/\n' });
  sh(dir, 'git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  return dir;
}

test('repoSlug reads ssh and https GitHub remotes', () => {
  const dir = repo();
  sh(dir, 'git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  assert.equal(repoSlug(dir), 'acme/widgets');
});

test('green evidence on the committed tree posts success to that commit', async () => {
  const dir = githubRepo();
  await runGates(dir, cfg('true'), { quiet: true });
  const gh = fakeGh(dir);
  const r = postStatus(dir, { gh });
  assert.equal(r.posted, true);
  assert.equal(r.state, 'success');
  const args = readFileSync(join(dir, 'gh-args'), 'utf8').split('\n');
  assert.ok(args.includes(`repos/acme/widgets/statuses/${r.sha}`));
  assert.ok(args.includes('state=success'));
  assert.ok(args.includes('context=hyvemind/gate'));
});

test('a red run posts failure naming the failed gate', async () => {
  const dir = githubRepo();
  await runGates(dir, cfg('exit 1'), { quiet: true });
  assert.equal(postStatus(dir, { gh: fakeGh(dir) }).state, 'failure');
});

test('refuses: no evidence, uncommitted edits, or only a partial run', async () => {
  const dir = githubRepo();
  assert.match(postStatus(dir, { gh: fakeGh(dir) }).reason, /no gate has run/);
  await runGates(dir, cfg('true'), { quiet: true });
  write(dir, { 'new.txt': 'uncommitted\n' });
  assert.match(postStatus(dir, { gh: fakeGh(dir) }).reason, /uncommitted/);
  const partial = { tree: 't', match: null, latest: { verdict: 'green', partial: true, gates: [] } };
  assert.match(statusFor(partial, 't').refuse, /partial/);
});

// ── evidence.status: the project's own gate status is the proof ─────────────

// A fake `gh` that records every call and answers the statuses read from a file,
// so tests choose what the forge "has" on the commit.
function fakeGhWithStatuses(dir, statuses) {
  write(dir, { 'statuses.json': JSON.stringify(statuses) });
  const bin = join(dir, 'fake-gh');
  write(dir, { 'fake-gh': `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/gh-calls"\ncase "$*" in *statuses\\?per_page*) cat "${dir}/statuses.json";; esac\n` });
  chmodSync(bin, 0o755);
  return bin;
}
const extRepo = () => {
  const dir = repo({ '.gitignore': 'fake-gh\ngh-calls\nstatuses.json\n.hyve/\n' });
  sh(dir, 'git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  return dir;
};
const extCfg = (over = {}) => resolveConfig({ version: 1, evidence: { status: 'ci/local-verify' }, ...over });
const st = (state, created_at, context = 'ci/local-verify') => ({ state, context, created_at, description: `${state} run`, target_url: 'https://ci.example/1' });

test('evidence.status: a success status on a clean HEAD is the proof, and the output names its source', () => {
  const dir = extRepo();
  const gh = fakeGhWithStatuses(dir, [st('success', '2026-10-25T10:00:00Z'), st('failure', '2026-10-25T11:00:00Z', 'other/ci')]);
  const r = checkEvidence(dir, extCfg(), { gh });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'external');
  assert.match(r.message, /proof: commit status "ci\/local-verify" = success on HEAD/);
  assert.match(readFileSync(join(dir, 'gh-calls'), 'utf8'), new RegExp(`repos/acme/widgets/commits/${r.sha}/statuses`));
});

test('evidence.status: the latest post for the context wins (a re-run that failed is not done)', () => {
  const dir = extRepo();
  const older = st('success', '2026-10-25T10:00:00Z');
  const newer = st('failure', '2026-10-25T12:00:00Z');
  assert.equal(checkEvidence(dir, extCfg(), { gh: fakeGhWithStatuses(dir, [older, newer]) }).ok, false);
  assert.match(checkEvidence(dir, extCfg(), { gh: fakeGhWithStatuses(dir, [newer, older]) }).message, /is failure on HEAD/);
  const fixed = st('success', '2026-10-25T13:00:00Z');
  assert.equal(checkEvidence(dir, extCfg(), { gh: fakeGhWithStatuses(dir, [older, newer, fixed]) }).ok, true);
});

test('evidence.status: uncommitted edits are never covered by a green status, and the forge is not asked', () => {
  const dir = extRepo();
  const gh = fakeGhWithStatuses(dir, [st('success', '2026-10-25T10:00:00Z')]);
  write(dir, { 'src.txt': 'uncommitted\n' });
  const r = checkEvidence(dir, extCfg(), { gh });
  assert.equal(r.ok, false);
  assert.match(r.message, /working tree differs from HEAD/);
  assert.throws(() => readFileSync(join(dir, 'gh-calls')), /ENOENT/);
});

test('evidence.status: no status yet points at the project gate (externalGate.run)', () => {
  const dir = extRepo();
  const c = extCfg({ externalGate: { run: 'node scripts/local-ci.mjs --pr <n> --post', done: 'ci/local-verify is success' } });
  const r = checkEvidence(dir, c, { gh: fakeGhWithStatuses(dir, [st('success', '2026-10-25T10:00:00Z', 'other/ci')]) });
  assert.equal(r.ok, false);
  assert.match(r.message, /no "ci\/local-verify" status on HEAD .*local-ci\.mjs/);
});

test('evidence.status: a local green gate record is not proof (one source of truth)', async () => {
  const dir = extRepo();
  const c = extCfg({ gates: [{ name: 'ci', run: 'true' }] });
  await runGates(dir, c, { quiet: true });
  assert.equal(checkEvidence(dir, c, { gh: fakeGhWithStatuses(dir, []) }).ok, false);
  assert.equal(checkEvidence(dir, cfg('true')).source, 'local', 'unset: local records, as before');
  assert.equal(checkEvidence(dir, cfg('true')).ok, true);
});

test('evidence --post with evidence.status never posts hyvemind/gate, and reports the external status', () => {
  const dir = extRepo();
  const gh = fakeGhWithStatuses(dir, [st('success', '2026-10-25T10:00:00Z')]);
  const r = postStatus(dir, { gh, cfg: extCfg() });
  assert.equal(r.posted, false);
  assert.equal(r.deferred, true);
  assert.equal(r.external.ok, true);
  const calls = readFileSync(join(dir, 'gh-calls'), 'utf8');
  assert.doesNotMatch(calls, /POST|hyvemind\/gate/);
});

test('evidence.status and train.via are validated', () => {
  assert.equal(resolveConfig({ version: 1 }).evidence.status, null);
  assert.equal(resolveConfig({ version: 1 }).train.via, 'hyvemind');
  assert.throws(() => resolveConfig({ version: 1, evidence: { status: '' } }), /evidence\.status must be/);
  assert.throws(() => resolveConfig({ version: 1, train: { via: 'bors' } }), /train\.via must be/);
  assert.throws(() => resolveConfig({ version: 1, train: { message: 3 } }), /train\.message must be/);
});
