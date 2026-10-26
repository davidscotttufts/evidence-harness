---
name: grade
description: "Grade part of a codebase A–F against an explicit rubric and keep the result in a durable tracker: code quality, data integrity, UX and accessibility, localization, or parity between two inventories (rubrics/*.md). Evidence for every grade, gaps classed Blocker/Improvement/Nice, an ordered path to A+, stable IDs, and resume-don't-restart. Use for audits, due diligence on inherited code, production-readiness reviews, or tracking quality over time. Tests use test-necessity; LLM call sites use ai-exchange."
---

# Grade

A grade is a tool for deciding what to fix next, not a trophy. **An A+ is not
"bulletproof"; it is honest.** The risks are identified, mitigated and covered by
tests, and the remaining risk is written down.

## Pick the rubric

| Dimension | Rubric | Typical tracker |
|---|---|---|
| Engineering quality | `rubrics/code.md` | `docs/assessments/CODE.md` |
| Data integrity and lifecycle | `rubrics/data.md` | `docs/assessments/DATA.md` |
| UX, visual design, accessibility | `rubrics/ux.md` | `docs/assessments/UX.md` |
| Localization | `rubrics/i18n.md` | `docs/assessments/I18N.md` |
| Two inventories that should match (API ↔ client, routes ↔ CLI, features ↔ docs, schema ↔ prompt) | `rubrics/parity.md` | `docs/assessments/PARITY-<name>.md` |
| Tests | use `{{skill:test-necessity}}` | |
| LLM call sites | use `{{skill:ai-exchange}}` | |

Read the rubric file before grading. It holds the dimensions, the grade caps and the
scans for that dimension. This file holds the method they all share.

## Step 0: Resume, never restart

1. Find the tracker. If it exists, read it fully. You are **updating** it: keep
   ticked items and earlier grades, re-grade only what's in scope, and add a dated
   changelog line. Never silently drop a collection.
2. If it doesn't exist, create it from the template at the end.
3. **Grade the code, not the documents.** Decision records, manifests, READMEs,
   feature flags and directory listings describe intent. Any grade based on them
   instead of on code you read (or ran) is downgraded and marked "from docs". If local
   is behind the remote base, grade the remote base (`git fetch` and use a worktree).

## Step 1: Scope

State the resolved scope before you start:
- **No argument**: the whole repository.
- **A path**: that subtree.
- **A named area** (a feature, a data domain, a screen): single-area mode. Inventory
  and grade only that area, and update only its section.
- **A named concern** (for example "orphans" or "keyboard access"): sweep every area
  for that concern only.

## Step 2: Inventory (fan out)

Map the terrain cheaply first (`git ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn`).
Then, for anything larger than a few dozen files, **send parallel scouts**, one per
top-level area, each returning a structured inventory. Reading a large tree in one
context is slow and loses detail.

Group the inventory into **collections**: one per user-facing area, plus the debt
collections the rubric names (for example Technical Debt or Accessibility Debt).
Shared code goes to the areas that depend on it, or to a clearly labelled
Cross-Cutting collection. Nothing is left unattributed.

**Coverage arithmetic, stated in the tracker:** graded + out-of-scope + unreachable =
total. A pass that read 40 of 312 files and reports on the codebase is a false claim.

## Step 3: Mechanical checks first

Run every check that can be run before forming an opinion: the rubric's scans, the
project's linters and type checks, and `{{cli}} census` for tests. A mechanical
finding is cited as such. Opinion only fills the gaps that machines can't reach.

## Step 4: Grade

Apply the rubric's dimensions to every collection, the same way for each, so letters
compare across collections.

- **A+**: risks identified, mitigated and test-covered; remaining risk stated.
- **A**: sound; only minor, non-blocking polish left.
- **B**: generally sound; a few real gaps to close before production.
- **C**: works, with material gaps across several dimensions.
- **D**: significant defects or risks; not production-ready.
- **F**: broken, unsafe, or missing where it must exist.

**Every grade cites evidence** (`file:line`, a function, a command and its output).
Where two sides must agree (a schema and its consumer, a route and its client), cite
**both sides**. A letter without evidence is an opinion and doesn't go in the tracker.
**Caps apply**: if the rubric says a blocker caps an area at D, it does, however good
the rest looks.

## Step 5: The author never grades their own work

If you wrote or changed the code being graded in this session, don't grade it
yourself. Give an **independent grader** (a fresh subagent) the sources and the
rubric, **without** your own score. Where you and the grader disagree, the grader's
grade stands until evidence settles it. Before finalizing any D or F, run one
**refute pass**: try to show the finding is wrong (a guard elsewhere, a test you
missed, dead code). Findings that survive are recorded.

## Step 6: Gaps and the path to A+

For each collection, name what keeps it below A. Classify each gap:
- **Blocker**: fix before production.
- **Improvement**: should fix.
- **Nice**: optional.

Then write an **ordered** path to A+. Each step is:
- incremental: reviewable and testable on its own;
- specific: names the file and the change, not "improve error handling";
- annotated with effort (S/M/L) and the risk it retires.

Some things static reading can't establish (visual quality, real data, live
behaviour). List them in a **human verification checklist**. No area gets an A+ on
static evidence alone where the rubric says verification is needed.

## Step 7: Write the tracker

```markdown
# <Dimension> assessment — <scope>
> Last updated: <date> · Scope: <…> · Method: <mechanical checks + N scouts + independent grader>

## Grade summary
| Collection | Grade | Target | Open blockers | Open gaps |
|---|---|---|---|---|

## Coverage
Graded: N · Out of scope: N · Unreachable: N · Total: N. Assumptions: …

## <Collection> — Grade: <X>
**Evidence:** per dimension, with file:line.
**Gaps:**
- [ ] `ABC-1` (Blocker) <gap> — `src/x.ts:42` — effort M
**Path to A+:** ordered steps referencing the gap IDs.

## Human verification checklist
- [ ] …

## Changelog
- <date>: <what was re-graded, closed or added>
```

IDs are stable across runs: never renumber, and never reuse a closed ID. Use the
real date for "Last updated" and the changelog.

## Step 8: Remediate (only when asked)

Fix one gap ID at a time, with a test that fails before the fix
(`{{skill:test-necessity}}` can show it can fail). Verify, then tick the item,
re-grade the collection, update the summary counts, and add a changelog line.
Report failures and skipped steps as they are.
