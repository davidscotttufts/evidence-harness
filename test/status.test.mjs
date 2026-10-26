import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { runGates } from '../src/gate.mjs';
import { postStatus, repoSlug, statusFor } from '../src/status.mjs';
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
