// Merge queue: gate SEVERAL changes in ONE gate run, then merge them — and prove
// that what landed is what was gated. Port of openwop-app's scripts/merge-train.sh.
//
// The train is origin/<base> plus each change's head merged in order. If the base
// has not moved when the gate goes green, merging the same heads in the same order
// produces the same tree, and the train checks that it did (tree of the new base ==
// tree that was gated). If the base moved, the train is rebuilt and re-gated
// (train.retries, default 1) instead of merging an untested tree.
//
// A red train with more than one change bisects itself: each half is re-gated on
// the current base; green halves merge; the culprit is named and left open.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runGates } from './gate.mjs';
import { git } from './git.mjs';

const must = (dir, args) => {
  const r = git(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
};

// ── forges ──────────────────────────────────────────────────────────────────
// A forge resolves a change id to a head commit and merges it into the base.

// GitHub pull requests through the gh CLI. Never --delete-branch (a stacked PR
// would be auto-closed), and every merge is verified with `gh pr view`, because
// `gh pr merge` can exit non-zero from a worktree after the merge has landed.
export function githubForge(root, gh = 'gh') {
  const run = (args) => spawnSync(gh, args, { cwd: root, encoding: 'utf8' });
  const view = (id, fields) => {
    const r = run(['pr', 'view', String(id), '--json', fields]);
    if (r.status !== 0) throw new Error(`gh pr view ${id}: ${(r.stderr || '').trim()}`);
    return JSON.parse(r.stdout);
  };
  return {
    name: 'github',
    label: (id) => `#${id}`,
    head(trainDir, id) {
      const pr = view(id, 'headRefOid,state');
      if (pr.state !== 'OPEN') throw new Error(`#${id} is ${pr.state}, not OPEN`);
      must(trainDir, ['fetch', '-q', 'origin', `pull/${id}/head`]);
      return pr.headRefOid;
    },
    merge(id, sha) {
      run(['pr', 'merge', String(id), '--merge', '--match-head-commit', sha]);
      if (view(id, 'state').state !== 'MERGED') throw new Error(`#${id} did not merge`);
    },
  };
}

// Branches on origin, merged with git itself. Used by tests and by repos without a
// forge; the change id is the branch name.
export function localForge(root, base) {
  return {
    name: 'local',
    label: (id) => id,
    head(trainDir, id) {
      must(trainDir, ['fetch', '-q', 'origin', id]);
      return must(trainDir, ['rev-parse', 'FETCH_HEAD']);
    },
    merge(id, sha, trainDir) {
      must(trainDir, ['fetch', '-q', 'origin', base]);
      must(trainDir, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
      must(trainDir, ['merge', '-q', '--no-ff', '--no-edit', '-m', `Merge ${id}`, sha]);
      must(trainDir, ['push', '-q', 'origin', `HEAD:refs/heads/${base}`]);
    },
  };
}

// ── the train ───────────────────────────────────────────────────────────────

export function trainDirFor(root, cfg) {
  return resolve(root, cfg.train?.dir ?? join('..', `${basename(root)}-hyve-train`));
}

function acquireLock(root) {
  const common = must(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lock = join(common, 'hyve-train.lock');
  try { mkdirSync(lock); } catch {
    throw new Error(`another train holds ${lock}; one train per clone at a time (remove it only if no train is running)`);
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

export async function runTrain(root, cfg, ids, opts = {}) {
  const base = opts.base ?? cfg.train?.base ?? 'main';
  const forge = opts.forge ?? githubForge(root);
  const bisect = opts.bisect ?? true;
  const merge = opts.merge ?? true;
  let retries = opts.retries ?? cfg.train?.retries ?? 1;
  const log = opts.log ?? (() => {});
  const dir = opts.dir ?? trainDirFor(root, cfg);
  const release = acquireLock(root);
  const result = { merged: [], red: [], conflicts: [], gated: [], refused: [], gates: 0 };
  try {
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      must(root, ['fetch', '-q', 'origin', base]);
      must(root, ['worktree', 'add', '-q', '--detach', dir, 'FETCH_HEAD']);
    }

    const build = (group) => {
      must(dir, ['fetch', '-q', 'origin', base]);
      const baseSha = must(dir, ['rev-parse', 'FETCH_HEAD']);
      must(dir, ['checkout', '-q', '-f', '--detach', baseSha]);
      must(dir, ['clean', '-q', '-fd']); // keeps ignored files (installed deps) between trains
      const heads = [];
      for (const id of group) {
        const sha = forge.head(dir, id);
        const m = git(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', `train: ${forge.label(id)}`, sha]);
        if (m.status !== 0) {
          git(dir, ['merge', '--abort']);
          return { conflict: id };
        }
        heads.push({ id, sha });
      }
      return { baseSha, heads };
    };

    const gate = async () => {
      if (cfg.train?.setup) {
        const s = spawnSync(cfg.train.setup, { cwd: dir, shell: true, stdio: opts.quiet ? 'ignore' : 'inherit' });
        if (s.status !== 0) throw new Error(`train.setup failed: ${cfg.train.setup}`);
      }
      result.gates++;
      const { record } = await runGates(dir, cfg, { quiet: opts.quiet });
      return record;
    };

    const ride = async (group) => {
      log(`train: ${group.map(forge.label).join(' ')}`);
      const built = build(group);
      if (built.conflict) {
        log(`  conflict: ${forge.label(built.conflict)} does not merge cleanly onto the train`);
        result.conflicts.push(built.conflict);
        const rest = group.filter((g) => g !== built.conflict);
        if (rest.length) await ride(rest);
        return;
      }
      const record = await gate();
      const tree = must(dir, ['rev-parse', 'HEAD^{tree}']);
      if (record.verdict !== 'green') {
        log(`  ${record.verdict.toUpperCase()}: ${group.map(forge.label).join(' ')}`);
        if (group.length > 1 && bisect) {
          const mid = Math.ceil(group.length / 2);
          await ride(group.slice(0, mid));
          await ride(group.slice(mid));
        } else {
          result.red.push(...group);
        }
        return;
      }
      log(`  GREEN on tree ${tree.slice(0, 12)}`);
      if (!merge) { result.gated.push(...group); return; }
      must(dir, ['fetch', '-q', 'origin', base]);
      if (must(dir, ['rev-parse', 'FETCH_HEAD']) !== built.baseSha) {
        if (retries > 0) {
          retries--;
          log(`  ${base} moved during the gate; rebuilding and re-gating`);
          await ride(group);
        } else {
          log(`  ${base} moved during the gate; the gated tree is not what would land. Not merging.`);
          result.refused.push(...group);
        }
        return;
      }
      for (const { id, sha } of built.heads) forge.merge(id, sha, dir);
      must(dir, ['fetch', '-q', 'origin', base]);
      const landed = must(dir, ['rev-parse', 'FETCH_HEAD^{tree}']);
      if (landed !== tree) {
        throw new Error(`TREE MISMATCH: ${base} is ${landed.slice(0, 12)} but the gated tree was ${tree.slice(0, 12)}. Investigate before merging anything else.`);
      }
      log(`  merged; ${base} tree == gated tree ${tree.slice(0, 12)}`);
      result.merged.push(...group);
    };

    await ride(ids);
    return result;
  } finally {
    release();
  }
}
