# Design

## Position in the landscape

The research behind this repo (October 2026) split the field into two layers:

- **Inner-loop agents** edit, run and test code: OpenHands, OpenCode, Codex CLI,
  Pi, Cline, Goose, Qwen Code, Kilo, Open SWE, mini-swe-agent.
- **Outer-loop frameworks** wrap them with spec → plan → gate → review → merge
  procedures: Spec Kit, Superpowers, OpenSpec, BMAD, Archon, cc-sdd, CCPM.

hyvemind is an **outer loop** and deliberately owns no inner loop. Coding
agents improve every month, so hyvemind speaks the standards they all read
(Agent Skills, AGENTS.md) and leaves the coding to whichever agent is best this
month.

## What it takes from the field

| Leading feature | Where it comes from | Here |
|---|---|---|
| Portable procedures as text | Agent Skills, Spec Kit's 41 integrations | `skills/*/SKILL.md` installed to `.claude/skills` and `.agents/skills`, plus an AGENTS.md block |
| Process sized to the change | BMAD, cc-sdd | `ship-change` classifies changes as trivial, contained or structural |
| Fresh subagent per task plus an independent reviewer | Superpowers, cc-sdd, Archon | `ship-change` step 4, `plan-tasks` task sizing |
| Code decides when it's done | Archon `until_bash`, Spec Kit converge | `hyvemind gate` / `evidence` |
| Proof that scaffolding still pays | CCPM with/without, Superpowers RED baseline | `hyvemind eval` with per-model lift and verdicts |

## What it adds that the field lacks

1. **Evidence bound to a tree hash.** Most frameworks trust "tests passed". Here a
   verdict is tied to the exact files on disk (including untracked files), and a gate
   that changes the tree while it runs is `invalid`.
2. **Sabotage probes.** No surveyed framework checks whether an *existing* test can
   fail.
3. **Retirement by evidence.** CCPM and Superpowers produce with/without evidence, but
   nothing acts on it. `eval` produces a verdict per skill and model, guarded against
   acting on too few runs.

## Integration with the app

The research proposal (phases P0–P7) puts the outer loop *inside* openwop-app as chain
packs, kanban stacks and approval cards. This repo is phase P0/P1 as a standalone
tool: portable skills, plus the scaffold-economics eval. The app's chain packs can call
the same CLI (`gate`, `evidence`, `probe`) as mechanical exit checks, so the in-app
workflow and the terminal workflow share one definition of "done".

## One definition of done

A repo that already has a merge gate must not get a second one from hyvemind. Two
"done" signals on a PR (say `ci/local-verify` and `hyvemind/gate`) can disagree, and
two merge paths (the repo's queue and `hyvemind train`) can race. The config splits the
problem by audience:

- `externalGate {run, done}` is for **agents**: the AGENTS.md block names the
  project's gate and its definition of done, in prose. hyvemind runs neither.
- `evidence.status` is the same definition of done for the **CLI**: the commit-status
  context that `done` refers to. `hyvemind evidence` reads it (latest post on a clean
  HEAD) instead of local gate records, and `evidence --post` stops posting
  `hyvemind/gate`.
- `train.via: "external"` removes the second merge path: `hyvemind train` refuses
  and points at the project's own (`train.message`).

They are separate keys because they are separable: a repo may have a gate that posts
no status (externalGate alone), or a status-posting CI that it still wants hyvemind's
skills to drive (evidence.status alone).

## Shipped in 0.2.0 (the 0.1 roadmap)

- Running each plan task through its own agent (`hyvemind run`): a fresh agent per
  task, its own worktree, its own exit check, and an independent reviewer.
- GitHub evidence lane (`hyvemind evidence --post`) and merge queue
  (`hyvemind train`): tree-hash check and bisect on red.
- Test-impact selection (`hyvemind affected`): a static, conservative counterpart to
  openwop-app's Tracegate.
- Bundled eval scenarios aimed at failures the skills exist to prevent, plus a
  markdown decision report.

## Next

- ACP adapter for `run`, so any ACP agent can implement tasks without per-agent argv.
- Parallel `run` for tasks with no dependency between them and no file overlap.
- CI babysitting: re-run only failures that `probe`/history show to be flaky.
- Learned test selection: record what each test actually executed, as Tracegate does,
  instead of only the static graph.
