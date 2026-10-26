---
name: ship-change
description: "Take a feature or change from idea to an open PR as one gated pipeline: spec → design review → plan → implement → review → PR, stopping at every gate. Each phase exits on a mechanical check, not on the agent's say-so. Use for any non-trivial change; start mid-pipeline by naming a phase ('ship from review')."
---

# Ship a change

```
{{skill:write-spec}} → {{skill:design-review}} → {{skill:plan-tasks}} → implement → {{skill:review-change}} → {{skill:open-pr}}
```

This skill **orchestrates** the other bee skills. It reimplements none of them.
Pass each phase's artifact into the next. **Stop at every ⛔ gate** and wait for the
user. `{{skill:evidence-rules}}` applies throughout.

## Size the process to the change

Before anything else, classify the change and say which class you picked:

| Class | Examples | Phases |
|---|---|---|
| **Trivial** | typo, copy, a one-line fix with an obvious test | implement → review → PR |
| **Contained** | a bug fix or small feature inside one module | plan → implement → review → PR |
| **Structural** | a new module or seam, cross-cutting behaviour, data/auth/API change | the full pipeline |

When unsure, go one class up. A change that touches persistence, auth, a public API or
a wire format is **Structural**, however small the diff.

## Phases

1. **Spec** with `{{skill:write-spec}}`. Produces a spec with testable acceptance criteria
   and, for Structural changes, a decision record in the project's `specs.dir`.
   ⛔ The user approves the spec.
2. **Design review** with `{{skill:design-review}}`. Fold its corrections back into
   the spec. ⛔ Stop on any boundary collision, duplicated system, or unsafe data or
   auth path.
3. **Plan** with `{{skill:plan-tasks}}`. Phased tasks, each sized for one fresh-context
   session and each with its own check.
4. **Implement**, one plan task at a time. `{{cli}} run plan.md --spec <spec>` automates
   this step: a fresh agent per task, the task's own exit check, and an independent
   reviewer. Or do it by hand:
   - Work in your own branch or worktree (`{{skill:parallel-work}}`).
   - Write the test first and watch it fail for the right reason.
   - When a task is large, give it to a **fresh subagent** with only the spec, the
     task and the files it needs, then review its result against the spec yourself.
   - **Inner loop:** `{{cli}} affected --run` runs only the tests your change can
     reach, and everything when it can't tell.
   - **Exit check per task:** the task's own check passes. Never move on with a red task.
5. **Review** with `{{skill:review-change}}`. It starts with `{{cli}} gate` (full).
   ⛔ Stop on any blocker, go back to step 4, then review again.
6. **PR** with `{{skill:open-pr}}`. ⛔ The user approves before anything outward-facing
   (push, PR, comment).
7. **Merge.** Several approved PRs can go through one gate with
   `{{cli}} train <pr> <pr>…`. It merges on green only if the base did not move,
   verifies that the base's tree is the tree it gated, and bisects a red train to
   find the culprit.

## Running it

- Announce each phase ("**Phase 3/6: plan**") and show what it produced.
- **Resume anywhere.** "I already have the spec" means start at design review.
- Re-sync with the base branch at each milestone. In a shared repo, assume other
  sessions are pushing.
- Keep a short running log in the PR description draft: phase, artifact, exit evidence.

## Stop conditions

- A ⛔ gate trips → stop, summarize, wait.
- A check fails → fix it before advancing. Never review or open a PR on red code.
- Two attempts at the same failure have not worked → stop and report what you tried.
  Don't try a third variation without new information.
