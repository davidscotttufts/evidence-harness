---
name: open-pr
description: "Open a pull request only when the current working tree has green gate evidence: verifies with {{cli}} evidence, writes the title and body from the actual diff (what, why, how verified, risk), uses Conventional Commits and sign-off. Pushes the branch freely; asks the user before opening the PR or posting anything others see. Use whenever a change is ready to propose."
---

# Open a PR

## 1. Preconditions (all mechanical)

1. `{{cli}} evidence` exits 0; its output names the proof source (local gate record,
   or the project's own commit status when `evidence.status` is set). If not, run
   the gate: the project's own (AGENTS.md) or `{{cli}} gate`. With only
   `externalGate` and no status, its `done` rule decides.
2. `git status` is clean. Uncommitted work means the evidence doesn't describe what you
   are about to push.
3. You are on a feature branch, not the default branch. Check with
   `git branch --show-current`, because another session can move you.
4. The branch is up to date with the base (`git fetch` and confirm it isn't behind). If
   you rebase, the tree changes: gate again.

## 2. Make the evidence visible

After committing, run `{{cli}} evidence --post`: it sets a `hyvemind/gate` status on
HEAD, and refuses an uncommitted tree. When `evidence.status` is set, `--post` posts
nothing: the project's own gate posts that status and `--post` only reports it, so
run the project's gate (see AGENTS.md) to get the status onto HEAD.

## 3. Commit hygiene

- Stage explicit paths; never `git add -A` in a shared checkout.
- Review `git diff --cached` before committing.
- Conventional Commits: `feat(scope): …`, `fix(scope): …`, `docs: …`. Cite the decision
  record if there is one (`(ADR 0042 §3)`).
- Sign off (`git commit -s`) if the project uses DCO.

## 4. Write the PR from the diff

```markdown
## What
<one paragraph: the change, in user terms>

## Why
<the problem; link the issue / spec / decision record>

## How it was verified
- `{{cli}} gate` green on tree <hash>
- <probes run, manual checks, screenshots — only what you actually did>

## Risk & rollback
<what could break, how to turn it off or revert>
```

Describe only what the diff does. Leave out anything that was planned but not built,
and say which checks were skipped.

## 5. Push, then gate

- Pushing your feature branch to the project's own remote preserves work: do it
  without asking (`git push -u origin <branch>`). Never push to the default branch,
  an upstream remote, or a branch you didn't create.
- ⛔ Opening the PR and posting any comment are visible to others. Show the user the
  title, body and target branch, and wait for an explicit yes before `gh pr create`
  or any `gh pr comment`/review.
