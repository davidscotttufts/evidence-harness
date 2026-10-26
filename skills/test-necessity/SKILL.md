---
name: test-necessity
description: "Grade tests A–F by whether they can actually fail: for each test, break the code it claims to guard with a sabotage probe ({{cli}} probe) and record whether it goes red. A is kept, B/C are fixed up to A, D/F are deleted with evidence. Use to audit a suite, check new tests in a PR, or decide whether a specific test is still needed."
---

# Test necessity

Ask one question of every test, and answer it with evidence:

> **If this test were deleted today, what real defect could reach the main branch
> that cannot reach it now?**

If the answer is "nothing", the test costs gate time, can fail for reasons unrelated
to behaviour, and makes reviewers think something is covered when it isn't.

## Grades

| Grade | Meaning | Outcome |
|---|---|---|
| A | A probe turns it red; it asserts behaviour; it is deterministic; its purpose is clear | Keep |
| B | Witnessed, but has weak assertions, shape-pinning, or redundant cases | Fix to A |
| C | Witnessed only partly (some claims stay green under their break) | Fix to A |
| D | Vacuous: no break of its subject turns it red | Delete, unless protected |
| F | Its subject is gone, it is skipped, or it only asserts mocks or status codes | Delete |

**Protected** (upgrade these; never delete them): security, authorization and tenancy
tests; regression tests that cite an incident; contract and conformance tests.

## Method

1. **Census.** Run `{{cli}} census`. It reads every test case's syntax tree and flags
   cases with no assertion, assertions only under `if`/`catch`/an unrun callback,
   status-only, mock-only, weak-only or snapshot-only checks, skips, `.only`, and
   duplicate bodies. It gives each file a **ceiling**, which caps the grade but never
   sets it. Probe the D/F-ceiling files first. Its ledger is keyed on blob sha, so
   later runs re-queue only changed files. State the denominator from its summary.
2. **Probe.** For each test, write one or more probes. Each probe makes a minimal,
   realistic break in the code the test claims to guard. Typical breaks: flip a
   comparison, drop a guard, return early, off-by-one, swallow an error.
   ```json
   [{ "id": "auth-skip", "src": "src/auth.ts", "old": "if (!user) throw", "new": "if (false) throw",
      "test": "src/auth.test.ts", "expectRed": ["rejects anonymous"] }]
   ```
   With `probe.format` set (`vitest`/`node`), `expectRed` must match a case that
   actually **failed**. A name merely printed in the output doesn't count.
   Run `{{cli}} probe probes.json` in your own worktree (it edits files and
   restores them; never run two at once in one worktree). Verdicts:
   - `witnessed`: the test went red. The claim is backed.
   - `vacuous`: the test stayed green. Before you blame the test, check the break was
     reachable (see `{{skill:evidence-rules}}`).
   - `other-red`: something failed, but not the expected case. Investigate.
   - `error`: red for the wrong reason (timeout, environment). This is not a witness.
3. **Grade and act.** Fix B/C up to A: sharpen the assertions, cut redundant cases,
   use realistic fixtures, add a one-line header saying what the test guards and which
   probe witnessed it. Then probe again. Delete D/F in focused commits, with the
   probe result in each commit message, and remove any helpers or fixtures they leave
   orphaned.
4. **Track.** Keep a tracker file (for example `docs/TEST-ASSESSMENT.md`) with one row
   per file: grade, probe ids, action, commit. Later runs resume from it. State
   coverage as "N of M files graded".

## In a PR

For each test the PR adds, write at least one probe and run it. A new test whose probe
is `vacuous` is a review BLOCKER.
