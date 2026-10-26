---
name: plan
description: "Turn an approved spec into a phased, dependency-ordered task list where every task fits one fresh-context session and has its own exit check. Discovers the existing surface first and classifies the change. Use after a spec is approved and before implementation."
---

# Plan the work

## 1. Classify the change

| Class | Means |
|---|---|
| UI-only | presentation, no new data or API |
| Module | contained in one package or module |
| Cross-cutting | a shared seam (auth, persistence, config, events) |
| Interface | a public API, wire format, schema or CLI contract other parties depend on |

An **Interface** change needs the contract settled and reviewed before the code
depends on it.

## 2. Discover before you plan

List the files, modules and tests each task will touch, by searching the repo, not
from memory. If a task can't name its files, it isn't ready.

## 3. Write tasks

Each task:

```
T3 — <imperative title>
  Depends on: T1
  Files: src/a.ts, src/a.test.ts
  Test first: <the failing test that defines done>
  Exit check: `<command that exits 0 when the task is done>`   ← in backticks
  Size: S (≤ 1 h) | M (≤ ½ day)   ← anything larger gets split
```

Rules:
- **The exit check is a command in backticks**, exactly `Exit check: \`<command>\``.
  `hyvemind run` executes the first backticked span, and its exit code is the only
  thing that marks the task done. Prose such as "tests pass", or `npm test` without
  backticks, is not a check. A check must fail before the task is implemented.
- **One fresh-context session per task.** A subagent given only the spec, this task and
  its files should be able to finish it. If it can't, split the task.
- **Order by dependency, then by risk.** The riskiest unknown goes first, while it is
  still cheap to change course.
- **Independently shippable phases.** Group tasks into phases that can each merge on
  their own, ideally behind a flag.
- **Include the unglamorous tasks:** migrations, docs, config, cleanup of anything the
  change orphans.
- Name tasks that can run in parallel (no shared files), and the worktrees for them
  (`{{skill:parallel-work}}`).

## 4. Run it

This format is machine-readable. `{{cli}} run plan.md --spec spec.md` gives each task
to a **fresh agent** in its own worktree, accepts it only when its exit check exits 0
(with one repair attempt that is told the failure), has an independent reviewer
say GO, and commits one task per commit. Re-running resumes after the last
committed task.

## 5. Output

The task list, a short dependency diagram if it helps, and the list of exit checks the
reviewer will run. Save it next to the spec or in the PR description draft.
