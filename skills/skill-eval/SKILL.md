---
name: skill-eval
description: "Measure whether each skill still makes the current model better than it is bare (scaffold economics): run every skill's scenarios with and without the skill, compute lift per model and agent, and propose keeping, thinning or retiring skills by evidence. Use after a model upgrade, when adding or editing a skill, or when a skill feels like overhead."
---

# Skill evals

Models get better quickly, and a procedure that once prevented mistakes can turn into
overhead that costs context and slows the agent. This skill replaces opinion about
that with a measurement.

## Run

```bash
{{cli}} eval                         # every installed skill, default agent
{{cli}} eval review pr --trials 5    # specific skills
{{cli}} eval --agent codex           # another agent from evals.agents
{{cli}} eval --model <id>            # if the agent command uses {model}
```

Each scenario runs in a fresh scratch git repo, once **bare** and once **with the
skill** installed, for N trials. The same checks score both arms. The output has one
row per skill (bare %, with-skill %, lift, verdict) and a JSON report under
`.hyve/evals/`.

| Verdict | Rule (default `evals.liftThreshold` 0.2) | Action |
|---|---|---|
| earning | lift ≥ threshold and its 95% interval excludes 0 | keep |
| earning (low n) | lift ≥ threshold, interval includes 0 | probably keep; run more trials before citing it |
| marginal | 0 < lift < threshold | thin it: cut the steps the bare model already does |
| saturated | both arms pass every run | the scenarios can't measure it: write a harder one; never retire on this |
| retire-candidate | lift ≤ 0, bare below 100% | propose retiring it, or rewriting it for what the model still gets wrong |
| insufficient-data | fewer than `evals.minRuns` (default 3) runs per arm | run more trials; never act on it |
| no-signal | neither arm ever passes | the scenario (or the skill) is broken; fix it before reading anything into it |

**If the bare arm already scores 100%, the scenario may be too easy rather than the skill
useless.** Before proposing a retirement, add a scenario for the specific failure the
skill was written to prevent and check that the bare model actually makes it.

Bare runs may still pick up user-level skills (for example `~/.claude/skills`) and
global instructions. Run evals from a clean profile when you can, and note it in the
report when you can't.

## Write scenarios

Put them in `<evals.scenariosDir>/<skill>/*.json` (default
`.hyve/scenarios/<skill>/`). Bundled skills ship their own under `skills/<skill>/evals/`.

```json
{ "id": "refuses-pr-without-evidence",
  "prompt": "The change is done. Open the pull request.",
  "fixture": "fixtures/dirty-repo",
  "trials": 3,
  "checks": [ { "type": "output-matches", "pattern": "hyvemind (gate|evidence)", "flags": "i" },
              { "type": "command", "run": "! git log origin/main 2>/dev/null" } ] }
```

Good scenarios:
- Target the failure the skill exists to prevent, not general competence.
- Are scored mechanically: output patterns, files, or a command's exit code. Never by
  the agent's own report.
- Are cheap enough to run on every model upgrade.

## Decide

Never retire a skill on one run. Require the same verdict across at least two models
or three runs, and show the user the report. ⛔ The user approves any retire or thin
change. Commit the report summary with the change.
