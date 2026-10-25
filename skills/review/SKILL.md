---
name: review
description: "Senior code review of the current branch: runs the full hyvemind gate first, scans the diff for the project's banned patterns, then reviews for correctness, security/authorization, data integrity, error honesty, tests and simplicity. Findings are severity-ordered with concrete failure scenarios; ends with a GO / NO-GO for opening a PR."
---

# Review the change

## 1. Gate first

Run `{{cli}} gate`. If it is not green, that is the first and blocking finding.
Report the failing gate's output and stop. Don't review code that won't merge.

## 2. Mechanical scan of the diff

Get the diff against the base branch: `git diff $(git merge-base HEAD origin/main)`, or
whatever base the project uses. Check every **added** line against
`review.bannedPatterns` in `hyvemind.json` (each has a `pattern` and a
`message`). Each hit is a BLOCKER unless the line carries a justification the user has
already accepted.

## 3. Read the diff for defects

Read the whole change, including the tests. Look for:

| Area | Ask |
|---|---|
| Correctness | Off-by-one, null/empty, concurrency, ordering, time zones, retries that run twice |
| Error honesty | Does any failure come back as success (empty list, default value, swallowed catch)? Invalid input should be a typed error. |
| Security | Is every new read/write authorized by the **same** check as its neighbours? Injection, path traversal, SSRF, secrets in logs, unsafe deserialization. |
| Data integrity | Orphans on delete, non-idempotent writes, missing transactions, migrations without rollback |
| Tests | Does each new test fail if the behaviour breaks? If in doubt, probe it (`{{skill:test-necessity}}`). Tests should assert behaviour, not incidental shape. |
| Simplicity | Code that duplicates an existing helper, dead code, speculative abstraction |
| Scope | Changes unrelated to the stated goal belong in their own PR |

Don't report style preferences a formatter or linter would catch.

## 4. Report

```
VERDICT: GO | NO-GO
Gate: green · tree <hash> (from `{{cli}} evidence`)

[BLOCKER] <file>:<line> — <one-line defect>
  Scenario: <inputs/state> → <wrong outcome>
  Fix: <specific change>
[MAJOR] …
[MINOR] …
```

Every finding needs a scenario you could turn into a failing test. If you can't
write one, drop the finding.

⛔ Any BLOCKER means NO-GO: go back to implementation, then review again.
