import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_DEFAULTS, runInSandbox, runtimeHealth } from '../src/sandbox.mjs';

// The sandbox against a REAL container runtime (sandbox.test.mjs uses a fake one).
// Opt-in: HYVE_SANDBOX_REAL=podman|docker. It pulls node:22-bookworm on first run.
// First passed on Podman 6.1.4 (macOS arm64 VM), 2026-10-26.
const RUNTIME = process.env.HYVE_SANDBOX_REAL;
const SKIP = RUNTIME ? false : 'set HYVE_SANDBOX_REAL=podman|docker to run against a real runtime';

test('real runtime: checks run isolated (no network, allowlisted env, no host home), setup may use the network, files stay the user\'s', { skip: SKIP, timeout: 900_000 }, () => {
  const sb = { ...SANDBOX_DEFAULTS, runtime: RUNTIME };
  assert.equal(runtimeHealth(sb).ok, true, `${RUNTIME} is not running`);
  // Under $HOME: Podman and Docker Desktop VMs share it by default.
  const dir = mkdtempSync(join(homedir(), '.hyve-sandbox-test-'));
  const had = { secret: process.env.HYVE_SECRET_CANARY, ci: process.env.CI };
  process.env.HYVE_SECRET_CANARY = 'should-not-pass';
  process.env.CI = 'true';
  try {
    assert.equal(runInSandbox(sb, dir, 'exit 0', 600).code, 0);
    assert.equal(runInSandbox(sb, dir, 'exit 3', 120).code, 3, 'a failing check keeps its exit code');
    const fetch = `node -e "require('https').get('https://registry.npmjs.org',()=>process.exit(0)).on('error',()=>process.exit(7))"`;
    assert.equal(runInSandbox(sb, dir, fetch, 120).code, 7, 'checks have no network');
    assert.equal(runInSandbox(sb, dir, fetch, 120, { network: true }).code, 0, 'setup has network when allowed');
    assert.equal(runInSandbox(sb, dir, 'test -z "$HYVE_SECRET_CANARY" && test "$CI" = true', 120).code, 0, 'only allowlisted env gets in');
    assert.equal(runInSandbox(sb, dir, `test ! -e ${homedir()}/.ssh && test ! -e /Users && test ! -e "$HOME/.ssh"`, 120).code, 0, 'no host home or credentials');
    assert.equal(runInSandbox(sb, dir, 'echo hi > /work/out.txt', 120).code, 0);
    assert.equal(statSync(join(dir, 'out.txt')).uid, process.getuid(), 'files written in /work are the user\'s, not root\'s');
    assert.notEqual(runInSandbox(sb, dir, 'chown 0:0 /work/out.txt', 120).code, 0, 'no privilege to chown');
  } finally {
    for (const [k, v] of [['HYVE_SECRET_CANARY', had.secret], ['CI', had.ci]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true }); // the mkdtemp dir made above, nothing else
  }
});
