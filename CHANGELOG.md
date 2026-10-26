# Changelog

## Unreleased

- **Honest eval verdicts** (#17). New `saturated` verdict when both arms pass every
  run (previously `retire-candidate`). Reports carry per-scenario rows with pass counts,
  lift and `harmful` / `no-signal` flags, listed at the top of the markdown report.
  Each arm gets a 95% Wilson interval and lift a Newcombe hybrid score interval; a skill
  is `earning` only when that interval excludes 0, otherwise `earning (low n)`. The
  report shows each skill's rendered words (≈ tokens) next to its lift. `--render`
  recomputes all of this from an old report's runs.

## 0.3.0 — 2026-10-26

- Evals round 2 (`docs/evals/2026-10-26-claude-r2.md`): the 12 changed skills re-measured. `write-spec` and `mine-skills` rules sharpened from the failing runs (now earning); `evidence-rules` scenario `docs-are-not-the-code` fixed (it dictated the wrong answer).
- **`doctor`** runs the integrity checks (`hyvemind pin`). With `externalGate`, it
  now warns only about real gaps: no `evidence.status` (agents follow prose that
  `evidence` can't check), and `ship-change` installed while `train.via` isn't
  `external` (a second merge path). The old blanket "competing skills" warning is
  gone, because those skills now defer to the external gate.

- **Skills drop the `bee-` prefix** and use distinct names instead: ship-change,
  write-spec, plan-tasks, review-change, open-pr, evidence-rules, mine-skills and
  live-ai-check. design-review, test-necessity, parallel-work, skill-eval and
  ai-exchange are unchanged. `skills.prefix` now defaults to `''`.
- **`update` removes skills it installed but no longer produces.** Untouched ones are
  removed; edited ones are kept and reported. This migrates 0.2.x `bee-*` installs.
- **`externalGate`**: a repo keeps its own gate and definition of done. `doctor`
  warns when an installed skill would add a competing one.
- **`hyvemind pin`** and **`integrity`** / **`coolingOffDays`** (default 14): pin
  records npm's `dist.integrity` for the version in `cli`, and refuses a release
  younger than the cooling-off period unless `--allow-fresh`. `src/integrity.mjs`
  exports `checkIntegrity` for `doctor`: version match, registry integrity (with a
  clear offline message) and publish age.
- **`broker`**: an optional tracegate-ci lease for gates, train gates, probes and
  eval agent runs.
- **`skills.defer`**: map a bundled skill to a project skill that takes precedence.
  The bundled skill is still installed, with a header saying to follow the project
  skill where it applies. Unknown or excluded names are errors; `update` treats
  (un)deferring like any other content change and keeps edited copies.
- **`census`**: an AST census of every test case, ported from openwop-app's
  `test-census.mjs`. On openwop-app's 2,763 backend test files it gives every file the
  same ceiling as the original, and runs in 7 s. The ledger is keyed on blob sha, and
  a recorded grade survives only while the file is unchanged.
- **`mine-skills`**: mining is local (reads `~/.claude/projects`, no network). It asks
  before each run and reports aggregates only, never transcript content.
- **`open-pr`**: pushing your own branch needs no approval; opening the PR or posting a
  comment does.
- **Skills name the new config:** `open-pr`, `evidence-rules` and `ship-change` read
  correctly with or without `evidence.status` (the project's status is the proof;
  `--post` only reports it) and `train.via: "external"` (follow where `train` points);
  `release` runs `hyvemind pin` when upgrading the CLI.
- **New skill `cleanup`**: dead code is removed only when proved dead (zero
  references and no dynamic path); protected categories; reports what it kept.
- **New skill `release`**: SemVer from commits, lockstep bump, tag the merge sha,
  verify the published artifact against a local build; asks before tagging.
- **`live-ai-check`**: loopback-only target and a key allowlist; pause on 429 with a
  recorded resume point; switch keys only on quota exhaustion; re-run a known-good
  case to attribute a refusal; never loosen a validator to pass.
- **`parallel-work`**: an advisory queue file in the git common dir, reconciled
  with remote branches and PR state before it is trusted; no holds on other sessions;
  a branch or worktree is removed only after `merge-base --is-ancestor` or `git cherry`
  proves it landed.
- **`design-review`, `write-spec`, `ship-change`**: "do nothing" is always an
  alternative; options are scored on debt, foreclosure and reversibility with "what
  would change my mind"; gap and risk registers (a gap with no path to closing is a
  risk); never cut scope because the work is big, phase it; nothing is built before
  the spec is `Accepted`. `design-review` adds a generator scan: find the code that
  generates the problem, not just its instances. `ship-change` merges through the
  project's own process when an external gate/status is configured.
- **`evidence-rules`**: grade the code, not the documents (a claim from an ADR,
  manifest, README or tracker is downgraded until checked); grade `origin/<base>`
  when the checkout is behind.
- **`review-change`**: the author never grades their own change; a refute pass on
  every finding and every "looks fine"; coverage arithmetic in the report.
- **`ai-exchange`**: data-minimisation and context-economy dimensions (fields sent
  vs needed, bounded context, measured), and absence scans for the checks that should
  exist and don't.
- **Probes witness at case level**: with `probe.format: vitest|node`, `expectRed` must
  match a case that **failed**. `expectOutput` substring matching can be fooled by a
  passing case's name; a test shows exactly that.
- `mine` asks for consent (or `--yes`) before reading transcripts.
- **`mine`**: confidence now divides by the runs of A that were followed by a skill,
  not all runs of A. Renamed skills merge (built-in aliases for hyvemind's own
  renames, plus `mine.aliases`).
- **`gate` records contention**: load, and test suites running from other
  directories (not stopped ones, not watchers). A red result under contention is
  reported as "re-run when quiet". `--wait <min>` waits for quiet. Skipped when a
  broker queues the work.
- **`affected` earns trust**: it stays in SHADOW until 20 observations over 7 days
  with no miss (`--observe` runs everything and checks every failure was selected);
  one miss resets it. `--status` shows where it stands.
- **New `grade` skill** with rubric files for code, data, UX, i18n and parity. It
  restores the method of openwop-app's six grade-* skills: a resumed tracker, coverage
  arithmetic, mechanical checks first, evidence from both sides, caps (an accessibility
  blocker caps an area at D), an independent grader plus a refute pass, an S/M/L path
  to A+, and a human verification checklist. The data rubric carries the six-class
  generator scan.
- Fixed: `ENOBUFS` from git on repos with tens of thousands of files.
- README rewritten around the problem and real output; the reference moved to
  `docs/reference.md`.
- **`evidence.status`**: one source of truth for done. When set, `hyvemind evidence`
  takes a `success` commit status of that context on a clean HEAD (latest by
  `created_at`) as the proof, names the proof source in its output, and
  `evidence --post` posts no `hyvemind/gate` beside it.
- **`train.via: "external"`**: `hyvemind train` refuses to merge and prints
  `train.message` (where merges go instead), with no git changes.

## 0.2.0 — 2026-10-26

- **`evidence --post`**: publishes gate evidence as a `hyvemind/gate` GitHub commit
  status. It refuses uncommitted trees, partial runs, and trees that were never gated.
- **`train`**: a merge queue, ported from openwop-app's `merge-train.sh`.
  - Gates several PRs in one run, and merges only if the base didn't move.
  - After merging, checks that the base's tree equals the gated tree
    (`TREE MISMATCH` otherwise).
  - Rebuilds and gates again once if the base moved; bisects a red train; skips a PR
    that conflicts.
  - Takes a lock so only one train runs per clone. Works with GitHub (`gh`) or plain
    git branches (`--local`).
- **`run`**: executes a `bee-plan` plan.
  - One fresh agent per task, in its own worktree.
  - Done is decided by the task's exit check, with one bounded repair attempt that is
    told the failure.
  - An independent reviewer must answer VERDICT: GO. One commit per task, and
    re-runs resume.
- **`affected`**: test-impact selection from the JS/TS import graph. Selects ALL tests
  for config, lockfiles, or any change it can't trace.
- **Evals**:
  - `--concurrency`, `--report` (a markdown table of decisions) and `--render`.
  - New verdict `no-signal`: both arms score 0%, so the scenario is broken. A
    broken run is no longer read as "retire".
  - `setup` and `output-not-matches` for scenarios; `evals.includeBundled`.
  - The default Claude eval command allows read-only tools (Read, Grep, Glob, git
    diff/status/log) in both arms. The prompt goes before `--allowedTools`, a
    variadic flag that otherwise swallows it.
  - 33 bundled scenarios across 13 skills, aimed at failures the skill exists to
    prevent. They replace the v0.1 starter scenarios, which scored 100% without the
    skill.
- **New skills**: `bee-ai-exchange` (grades LLM↔app information exchange) and
  `bee-live-qualify` (real-vendor runs; keys by name only; results classified
  honestly).
- `bee-plan` writes exit checks in backticks, so `run` can execute them. `bee-ship`,
  `bee-pr` and `bee-review` point at `run`, `affected`, `train` and `evidence --post`.
- 20 self-probes. Each one breaks a core guarantee and shows that its test turns red.
- **First real evals** ([docs/evals/2026-10-26-claude.md](docs/evals/2026-10-26-claude.md)), on Claude Code:
  - Earning: `spec` +0.50, `pr` +0.67, and `plan` +0.50 after a measured rewrite of its exit-check rule.
  - Saturated on these scenarios: the other ten skills. That is not a retirement verdict until a second model or harder scenarios are tested.

## 0.1.0 — 2026-10-25

First release (initially published as `evidence-harness`; renamed to hyvemind the same day, before any use).

- CLI: `init`, `update`, `doctor`, `list`, `gate`, `evidence`, `probe`, `eval`, `mine`.
- Gate verdicts bound to a working-tree hash (`green` / `red` / `invalid`); partial
  runs never count as evidence.
- Sabotage probes with verified restore and `errorPatterns`.
- Skill evals: bare vs with-skill lift per agent and model, with a minimum-runs guard.
- Transcript miner for skill chains (port of openwop-app's `skill-miner/mine.sh`).
- Skills call the CLI through a configurable `cli`, defaulting to an exact registry version.
- 11 `bee-` skills: ship, spec, design-review, plan, review, test-necessity, pr, evidence,
  parallel-work, skill-eval, skill-miner.
- Presets: `openwop`, `node`, `python`, `generic`.
