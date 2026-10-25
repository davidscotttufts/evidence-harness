import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(root, args, env = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

export function isRepo(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

export function head(root) {
  const r = git(root, ['rev-parse', 'HEAD']);
  return r.status === 0 ? r.out : null;
}

// Hash of the WORKING tree (tracked + untracked, minus ignored files), computed in a
// throwaway index so the real index is never touched. Two runs on identical files give
// the same hash; any edit, even uncommitted, changes it. This is what a gate verdict is
// bound to: "green" means green for exactly this tree.
//
// The index starts EMPTY, so every file is hashed from its bytes. Seeding it from a
// copy of the real index looked faster but trusts cached size+mtime: the copy's fresh
// timestamp defeats git's racy-entry check, so a same-size edit made in the same second
// as the last index write hashed as unchanged (caught in CI). ~1.7 s for 13k files.
export function workingTree(root) {
  const dir = mkdtempSync(join(tmpdir(), 'hyve-idx-'));
  const index = join(dir, 'index');
  try {
    const env = { GIT_INDEX_FILE: index };
    const add = git(root, ['add', '-A', '--', '.'], env);
    if (add.status !== 0) throw new Error(`git add failed: ${add.err}`);
    const tree = git(root, ['write-tree'], env);
    if (tree.status !== 0) throw new Error(`git write-tree failed: ${tree.err}`);
    return tree.out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function isClean(root, path) {
  return git(root, ['diff', '--quiet', 'HEAD', '--', path]).status === 0;
}
