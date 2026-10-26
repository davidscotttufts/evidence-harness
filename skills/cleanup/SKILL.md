---
name: cleanup
description: "Remove dead code only when it is proved dead: zero references AND no dynamic path to it (string-built imports, registries, reflection, config/manifests, plugin loaders, exports other packages use). Protects public API, migrations, security, compliance, generated code and anything cited as evidence. Reports what looked dead but was kept, and why. Small commits, each citing its proof. Use for dead-code sweeps, orphan removal after a change, or 'is this still used?'."
---

# Cleanup

Deleting live code is a silent outage: the reference you missed was built from a
string, read from a manifest, or lives in another package. "No grep hits" is the
start of the proof, not the proof.

## 1. Prove it dead

A unit (file, export, function, route, flag, config key) is dead only when **both**
hold, and you can show the commands:

1. **Zero static references.** Search the whole repo, every workspace package, by
   name *and* by path (`foo`, `./foo`, `foo.js`, the kebab and camel spellings).
   Exclude only its own definition and its own tests.
2. **No dynamic path.** Search for the ways code is reached without naming it:
   - string-built imports (`import(\`./handlers/${x}\`)`, `require(name)`);
   - registries and maps keyed by string, decorators, reflection, DI containers;
   - config, manifests, routes files, CI/workflow files, scripts in `package.json`;
   - plugin or pack loaders that scan a directory;
   - exports of a published package (other repos import them; you can't grep them).

An empty search is suspect until it can fail: point the same search at a unit you
know is live and see it hit (`{{skill:evidence-rules}}`).

## 2. Protected: never delete here

Public API and published exports · migrations (even applied ones) · security, auth
and tenancy code · compliance and retention logic · generated code (fix the
generator, or leave it) · anything cited as upgrade or verification evidence (a doc,
checker or decision record names it). Raise these with the user instead.

## 3. Tests are not judged here

A test whose subject you delete goes with it. Whether any other test is still
needed is `{{skill:test-necessity}}`'s call, made with probes, not here.

## 4. Remove

- One unit (or one tight cluster) per commit. The message cites the proof: the
  static search, the dynamic searches, and "not protected because …".
- Remove what the deletion orphans: helpers, fixtures, config keys, docs, the
  dependency in the manifest.
- Run the full gate after each commit. A red gate means the proof was wrong: revert
  that commit, and record what you missed.

## 5. Report

- Removed: unit, proof, commit.
- **Kept:** each unit that looked dead but was saved, with the reason (dynamic path
  found at file:line, protected category, cited as evidence).
- The denominator: "examined N candidates: removed R, kept K".
