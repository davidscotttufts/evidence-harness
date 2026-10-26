# Changelog

## 0.3.0 — unreleased

- **Skills drop the `bee-` prefix** and use distinct names instead: ship-change,
  write-spec, plan-tasks, review-change, open-pr, evidence-rules, mine-skills and
  live-ai-check. design-review, test-necessity, parallel-work, skill-eval and
  ai-exchange are unchanged. `skills.prefix` now defaults to `''`.
- **`update` removes skills it installed but no longer produces.** Untouched ones are
  removed; edited ones are kept and reported. This migrates 0.2.x `bee-*` installs.
- **`externalGate`**: a repo keeps its own gate and definition of done. `doctor`
  warns when an installed skill would add a competing one.
- **`broker`**: an optional tracegate-ci lease for gates, train gates, probes and
  eval agent runs.
- **`census`**: an AST census of every test case, ported from openwop-app's
  `test-census.mjs`. On openwop-app's 2,763 backend test files it gives every file the
  same ceiling as the original, and runs in 7 s. The ledger is keyed on blob sha, and
  a recorded grade survives only while the file is unchanged.
- **Probes witness at case level**: with `probe.format: vitest|node`, `expectRed` must
  match a case that **failed**. `expectOutput` substring matching can be fooled by a
  passing case's name; a test shows exactly that.
- `mine` asks for consent (or `--yes`) before reading transcripts.
- **New `grade` skill** with rubric files for code, data, UX, i18n and parity. It
  restores the method of openwop-app's six grade-* skills: a resumed tracker, coverage
  arithmetic, mechanical checks first, evidence from both sides, caps (an accessibility
  blocker caps an area at D), an independent grader plus a refute pass, an S/M/L path
  to A+, and a human verification checklist. The data rubric carries the six-class
  generator scan.
- Fixed: `ENOBUFS` from git on repos with tens of thousands of files.
- README rewritten around the problem and real output; the reference moved to
  `docs/reference.md`.

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
