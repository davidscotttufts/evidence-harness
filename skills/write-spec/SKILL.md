---
name: write-spec
description: "Turn an idea, issue or PRD into a reviewed spec: problem, scope, testable acceptance criteria (WHEN/THEN), and — for structural changes — a numbered decision record (ADR) with alternatives and a phased plan. Grounds every claim in the existing code first. Use before building anything non-trivial."
---

# Write a spec

The aim is a document the next phase can build from and later check against. Without
acceptance criteria, "done" can't be checked.

## 1. Ground it in the code before you write anything

- Read `hyvemind.json` for `specs.dir` (where decision records live) and
  `specs.nextNumberCommand`.
- Find what already exists. Search for the feature's nouns and verbs across the repo
  and list related modules, routes, tables, configs and earlier decision records.
  **A spec that duplicates an existing system is the most expensive kind of mistake.**
- Read the earlier decision records that touch this area. If the new change overturns
  one, plan a **correction note** for it. Never edit its history.

## 2. Write the spec

```markdown
# <Title>

Status: Proposed
Date: <YYYY-MM-DD>

## Problem
Who has it, what it costs them today, and how we know (link the issue, data or user quote).

## Scope
In: …   Out (explicitly): …

## Acceptance criteria
- WHEN <situation> THEN <observable result>     ← each one becomes a test
- …

## Design
What changes where: modules, data, interfaces. Name the existing pieces you reuse.

## Alternatives considered
"Do nothing" plus at least one other. Score each on debt, foreclosure (what it rules
out later) and reversibility. Say why each lost, and what would change your mind.

## Gaps and risks
Gaps: what this doesn't yet cover, each with its path to closing (phase, issue).
Risks: security, data migration, performance, rollback, and every gap with no path
to closing. "None" needs a sentence of why.

## Plan
Phases, each independently shippable, each with its exit check.

## Open questions
- [ ] …
```

Rules:
- Every acceptance criterion must be **observable and falsifiable**. "Fast" is neither;
  "p95 < 300 ms on the list endpoint at 1k rows" is both.
- Mark anything you have not verified as **unverified**.
- **Big is not a reason to cut scope.** Split it into phases; dropping scope is the
  user's call.
- Keep it short. Cut any section that says nothing.

## 3. Structural changes get a numbered decision record

- Get the number from `specs.nextNumberCommand` if one is configured. Otherwise use
  the highest existing number + 1. In a repo with parallel branches, a directory listing
  can't see unmerged numbers, so prefer the command.
- File: `<specs.dir>/<NNNN>-<kebab-slug>.md`. Status moves `Proposed → Accepted →
  Implemented` (or `Superseded by NNNN`).
- When a phase ships, record it (phase → commit) in the record.

## 4. Gate

⛔ Show the spec to the user and wait for approval before design review. After the
review's corrections are folded in and the user agrees, set `Status: Accepted`.
No code is built against a spec or contract that is not Accepted.
