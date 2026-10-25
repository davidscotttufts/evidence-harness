# Changelog

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
