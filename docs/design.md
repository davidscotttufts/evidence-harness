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
| Process sized to the change | BMAD, cc-sdd | `bee-ship` classifies changes as trivial, contained or structural |
| Fresh subagent per task plus an independent reviewer | Superpowers, cc-sdd, Archon | `bee-ship` step 4, `bee-plan` task sizing |
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

## Roadmap

- Executor adapters to run plan tasks through an ACP agent, with a worktree per task.
- GitHub lane: open the PR, read checks, re-run only flake-triaged failures.
- Merge-queue mode: gate a train of PRs once, check the tree hash, and bisect on red
  (port of openwop-app `merge-train.sh`).
- Harder bundled eval scenarios aimed at failures current models still make.
