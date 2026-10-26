# Rubric: engineering quality

Collections: one per feature area, plus **Technical Debt** and **Deferred Work**.

| Dimension | What A looks like |
|---|---|
| Correctness and reliability | Errors and edge cases handled; no known-broken paths; deterministic; failures are typed, never success-with-empty |
| Security and data handling | Input validated at the boundary; every read and write authorized by the same rule as its neighbours; secrets never logged; no injection, traversal or SSRF |
| Performance and scalability | No N+1 queries, unbounded loops or memory; no single-host assumptions; fan-out within rate and connection budgets |
| Observability | Enough logs, metrics and error reports to debug in production without a debugger |
| Tests | The critical paths have tests that can fail (`test-necessity`), not just smoke |
| Dependencies and supply chain | Current, maintained and pinned; no known vulnerabilities; lockfile reviewed |
| Maintainability | Clear structure and naming; low duplication; idiomatic for the stack |

## Technical Debt collection

Catalog the debt and grade it like any collection. Cross-reference each item to the
areas it affects.
- Dead, duplicated or commented-out code.
- Suppressions: `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`,
  `eslint-disable`, `# noqa`, `# type: ignore`, `//nolint`.
- Skipped or flaky tests.
- God objects, circular imports (barrel files re-exporting each other cause
  temporal-dead-zone crashes at load time).
- Hard-coded values that belong in config.

## Deferred-work scan

Grep finds the markers. Reading finds the prose ones.

```bash
git grep -nEi '\b(TODO|FIXME|HACK|XXX|WIP)\b|@deprecated' -- . ':(exclude)*lock*'
git grep -nEi 'in prod(uction)?|for now|in a real app|placeholder|temporar|not implemented|stub(bed)?|will (need|have) to|revisit|good enough|quick fix' -- . ':(exclude)*lock*'
```

Record each hit as `TODO-N`: the `file:line`, the verbatim text, the gap it implies,
and the area it affects. Decide which are real blockers and which are harmless notes.
