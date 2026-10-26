---
name: design-review
description: "Senior architecture review of a spec, a design, or a set of competing options before code is written: boundaries, duplication and naming collisions, coupling, data flow, failure modes, authorization, migration/rollback, testability. Produces severity-ordered findings with concrete failure scenarios, or a recommendation between options."
---

# Design review

Review it like the person who will be paged when it breaks. Every finding has to name
a **concrete failure scenario**: inputs or state, then the wrong outcome. A finding
without one is a style preference, and you leave it out.

## Inputs

The spec or design doc, the code it touches, and any earlier decision records in
`specs.dir`. If you are choosing between options, read all of them before judging any.

## Checklist

1. **Duplication and collisions.** Does this already exist under another name? Search
   for the domain nouns, route paths, table and collection names, config keys and
   event names. A second system that does the same job will drift from the first.
2. **Generator scan.** When the design fixes a problem (duplicates, orphans, drift),
   find the code that **generates** it, not just its instances: the writer that
   duplicates, the id that isn't idempotent on re-run, the hand-kept list that
   falls behind. A fix for instances only comes back.
3. **Boundaries.** Does a module reach into another's internals? Would the new
   dependencies create a cycle? Does each piece of state have exactly one owner?
4. **Data flow and integrity.** Where is each piece of data created, changed and
   deleted? What happens to dependents on delete? Is an operation that runs twice
   idempotent? Who wins when two writers collide?
5. **Failure modes.** Timeouts, partial failure, retries, a dependency that is down.
   Does an error ever look like success (an empty list or a default value standing in
   for a failure)?
6. **Authorization and tenancy.** Is every new read and write checked by the **same**
   rule the existing route uses? Fail closed. Never trust a caller-supplied
   owner, tenant or role.
7. **Model-facing surfaces** (if AI is involved): apply `{{skill:ai-exchange}}`'s
   dimensions to each new model call.
8. **Migration and rollback.** Can it ship dark? Can it roll back without data loss?
   What happens to existing data?
9. **Testability.** Can each acceptance criterion become a test that would fail if the
   behaviour broke?

## Output

```
VERDICT: GO | GO-WITH-CHANGES | NO-GO

[BLOCKER] <title> — <file/section>
  Scenario: <inputs/state> → <wrong outcome>
  Fix: <specific change>
[MAJOR] …
[MINOR] …
```

For competing options, always include **do nothing**. Score options × debt,
foreclosure (what it rules out later) and reversibility, then make one
recommendation with the deciding reason and **what would change your mind**. Don't
present a survey without a decision. Never recommend cutting scope because the work
is big; recommend phases. A finding the spec can't close goes in its risk register.

⛔ Any BLOCKER stops the pipeline until the spec is corrected.
