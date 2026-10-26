# Rubric: parity between two inventories

Use it whenever two lists must agree:
- API routes ↔ client methods or CLI commands;
- feature flags ↔ docs;
- a schema ↔ the prompt that describes it;
- the events a service emits ↔ the handlers that consume them;
- declared capabilities ↔ implemented ones.

**Parity is a join of two inventories.** Build both mechanically, then join them.
Never answer by grepping one side.

1. **Inventory side A** with a resolver that sees what the system actually exposes:
   the router's registered routes, the registry's entries, the built artifact. Not a
   grep of source text, which counts dead code, comments and duplicates. (One audit
   measured about 1,130 "gaps" by grep; about 90 were real.)
2. **Inventory side B** the same way.
3. **Join** into a table with one row per item:
   - **Covered**: present on both sides. Cite both, with `file:line`.
   - **Uncovered**: on A, missing on B. This is a coverage gap.
   - **Orphaned**: on B, its A side is gone. This is drift, and it usually fails at
     runtime.
4. **Check that both sides declare the same contract**: versions, names, parameters
   and required fields. "Declared" must equal "implemented" in both directions.
5. **Run a live smoke** where one is possible. Mocked tests have stayed green while
   dozens of commands returned 404 against the real service.

| Dimension | What A looks like |
|---|---|
| Coverage | Every item on A that should have a B counterpart has one |
| No orphans | Nothing on B points at something A no longer has |
| Contract agreement | Names, versions and required fields match exactly |
| Enforcement | A test (or a check in the gate) fails when the two drift apart |

The best fix for any parity gap ships with that test, so the drift can't come back.
