---
name: parallel-work
description: "Safe git hygiene when several agents or sessions share one repository: branch from the remote base in your own worktree, never stash/clean/reset a shared tree, stage explicit paths, re-check branch and staged diff before every commit, and clean up only your own artifacts. Use before any multi-session or multi-agent work, or whenever another session might be editing."
---

# Parallel work

Assume another session is editing this checkout right now.

## Start

```bash
git fetch origin
git worktree add ../<repo>-<task> -b <branch> origin/main   # from the REMOTE base, not local main
cd ../<repo>-<task> && <install dependencies for real>        # don't symlink node_modules
```

- Branch from `origin/<base>`. Local `main` falls behind constantly.
- Never `git checkout -b` in the shared checkout. It moves the working tree out from
  under other sessions.
- If `git worktree add` says the branch already exists, another session has probably
  claimed it. Pick a new name; don't adopt it.

## Shared queue (advisory)

Worktrees share one git common dir, so a note there is seen by every session:
`$(git rev-parse --git-common-dir)/hyvemind-queue.md`, one line per claim
(branch, files or area, session, date).

- Before trusting it, reconcile it with reality: `git ls-remote --heads origin`,
  open/merged PR state. A claim whose branch is merged or gone is stale; mark it so.
- Add your own claim; edit only your own lines.
- It is advisory. Never impose a hold, freeze or lock on another session; if you
  overlap, tell the user and let them decide.

## While working

- **Never** run `git stash`, `git clean`, `git reset --hard`, or delete a branch you
  didn't create, in a tree others use. Before discarding anything, diff it against the
  remote. If it differs, it is someone's unpushed work.
- Before every commit, check `git branch --show-current` and `git diff --cached`.
  A parallel checkout can move you, and a parallel write can land between add and
  commit.
- Stage explicit paths only.
- Commit and push to a branch to preserve work. Don't rely on stash.
- Don't run two heavy test suites at the same time on one machine. Worker starvation
  produces failures that look real and aren't.

## Fan-out to subagents

- Give each subagent its own worktree and a task with **no file overlap** with the
  others.
- Give each one only what it needs: the spec, its task, the files, and the exit check.
- Review each result against the spec yourself before merging it into your branch.

## Finish

Remove a branch or worktree only after proving it landed: after `git fetch`,
`git merge-base --is-ancestor <branch> origin/<base>` exits 0, or (for squash or
rebase merges) `git cherry origin/<base> <branch>` shows no `+` lines. "The PR says
merged" is not proof. Then remove **your own** worktrees, branches, queue lines,
background processes and temp files (`git worktree remove`, `git push origin
--delete <branch>`). Never remove anything you didn't create.
