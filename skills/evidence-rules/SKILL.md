---
name: evidence-rules
description: "The hive constitution: rules for what counts as evidence before you claim anything is done, fixed, green, safe or verified. Applies to every task. Use whenever you are about to report an outcome, cite a measurement, trust a check, or decide a test or gate result means something."
---

# Evidence rules

Each rule below came from a real failure where a confident claim turned out to be
false. When a rule and a shortcut conflict, the rule wins.

## Done means evidence for this exact tree

- A change is done when `{{cli}} evidence` exits 0. That means a **full** green
  gate run is recorded for the working tree **as it is now**. A green run on an
  earlier tree, a partial run (`--only`), or "the tests I ran passed" is not evidence.
- If the gate verdict is `invalid`, the tree changed while it ran. The run proves
  nothing about either tree. Find what changed it, then re-run.
- Report failures with their output. Report skipped steps as skipped. Do not soften
  a red into "mostly passing".

## A check is evidence only if it could have failed

- **Status code is not evidence.** A `200` from a catch-all route, an SPA rewrite or a
  cached page is a failed read that looks like success. Assert the content (type, body,
  a string only the new code contains).
- **An empty result with exit 0 is the most common sign of an inert check.** For
  example, a query scoped wrong, a filter that matches nothing, or a grep over the
  wrong directory. Before trusting it, prove the check can fail: point it at something
  that must match.
- **A test is evidence only if breaking the code turns it red.** Use
  `{{skill:test-necessity}}` / `{{cli}} probe` to show it.
- **Sabotage probes can be vacuous too.** A break that never runs (dead branch, wrong
  file, a mock that hides it) proves nothing. If a probe stays green, ask whether the
  break was reachable before you blame the test.

## Measure, don't recall

- **Measure the value now; don't trust what is written.** Versions, counts, limits and
  config drift. Re-read them before you act, and write the reading down with its date.
- **A citation is a claim, not evidence.** Docs, ADRs, comments and earlier
  summaries (including your own) can be stale. Check the mechanism before you copy it.
- **Enumeration is not coverage.** Listing what you looked at does not show you looked
  at everything. State the denominator: "graded 40 of 312 files".

## Experiments

- **Change one variable at a time.** If two things changed between a red run and a green
  run, you don't know which one fixed it.
- **Don't build the conclusion into the command.** For example, `grep … | head -1`
  when you expect one hit, or `|| true` on the step you are testing. Let the command
  show you the case you didn't expect.
- **Stitched excerpts can invent adjacency.** Don't join output from separate runs
  into one block and present it as a single observation.
- **A wait condition must be reachable.** Before you wait for "X becomes true", confirm
  X can become true. Put a time limit on the wait, and check at the limit.

## Never make it green by weakening the check

Do not delete or skip a failing test, loosen an assertion, add a suppression, raise a
timeout, or edit a gate to get green, unless the user explicitly asks you to. Fix the
cause. If the check itself is wrong, say so, show why, and change it in its own
reviewed step.
