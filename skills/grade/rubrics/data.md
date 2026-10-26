# Rubric: data integrity and lifecycle

Collections: one per data domain, plus **Referential-Integrity Debt** and **Orphaned
Data**. A domain earns A+ when its invariants are explicit, enforced (by a constraint
or by tested code) and observable, and its full lifecycle (create, change, merge,
delete, retain, purge) leaves no orphans.

**Soft references count as debt until proven safe.** An id of another entity stored
inside JSON, a key-value row or a blob, with no foreign key and no **tested** cleanup
on delete, is a latent orphan. The burden of proof is on the code.

| Dimension | What A looks like |
|---|---|
| Model correctness | Entities match the domain; ownership unambiguous; ids stable |
| Referential integrity and cascades | Hard relations are FKs with a deliberate `ON DELETE`; soft references have tested cleanup; teardown is driven by introspection or a registry, **never a hand-kept list** |
| Consistency and duplication | Uniqueness enforced by constraint; one source of truth per fact; ids on re-runnable paths are deterministic |
| Isolation | Every row is keyed by its owner or tenant, and every query filters by it |
| Lifecycle and retention | Merge, rekey and delete flows rewrite keys as well as content; purge/TTL for unbounded logs |
| Schema and migrations | Ordered, reviewable migrations, in sync with the code models |
| Seed and demo data | Idempotent seeders that exercise the real create paths, with realistic linked records |
| Privacy | Personal data identified; erasure honoured on every store, including logs and caches |

## Generator scan (find the code that MAKES orphans and duplicates)

Tracing deletions finds orphans after the fact. These six patterns create them. Grep,
then read each hit to classify it. Each one found becomes `GEN-N`.

1. **Merge, move or rekey that rewrites content but not the row key.** A key that
   embeds the old owner id is then orphaned (when listed by prefix) or duplicated
   (when filtered by content).
2. **A random id on a re-runnable path.** For example `randomUUID` in a seed, an
   "ensure", or a first-visit auto-create. Every re-run makes a duplicate. Random ids
   are *correct* for runs, events, requests, tokens and explicit user creates; they
   are dangerous only when **durable + per-owner + re-runnable**.
3. **An idempotency guard keyed by an identity that rotates** (an anonymous session,
   a per-browser id), so every rotation looks like a first write.
4. **A silent auto-create on a hot path for ephemeral users**, whose data is later
   merged into a real account and multiplied by the merge.
5. **A hand-kept list of tables or collections to cascade.** A new store silently
   escapes it. Introspection or self-registration is complete by construction.
6. **Cleanup blind spots**: stores whose content carries no owner id, or tables with
   an owner embedded in the key but no owner column. Neither a merge nor a purge can
   find them.

The cure is usually one of three: a deterministic id that isn't embedded under a
parent, a key-rewrite pass in the merge, or introspection in place of a list.

## Live probes

If a database is reachable, run **read-only** probes: orphan counts per soft
reference, duplicate counts per natural key. Never run a mutating statement against
a shared database without explicit instruction. Prove each probe can return nonzero
(point it at a key prefix known to exist) before trusting a zero. Otherwise, list the
probes in the human verification checklist.
