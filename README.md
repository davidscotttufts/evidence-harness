# hyvemind 🐝

*myndhyve, flipped.* A hive of SDLC skills for coding agents. It gives your agent a
gated **spec → design review → plan → implement → review → PR** workflow, where "done"
is decided by evidence and never by the agent's own say-so. It also measures, for each
model you use, whether each skill still makes that model better than it is on its own.

The idea comes from real honeybees. When a swarm picks a new home, scout bees inspect
the site and dance for it, and the swarm moves only once enough scouts have
**independently checked it** and agree. hyvemind applies the same rule to code: a
claim counts only after it has been verified.

- **Works with any agent.** Skills are plain [Agent Skills](https://agentskills.io)
  (`SKILL.md`) installed to `.claude/skills` and `.agents/skills`, plus a managed
  [AGENTS.md](https://agents.md) block. They work with Claude Code, Codex, OpenCode,
  and anything else that reads those files.
- **Evidence-gated.** `hyvemind gate` ties a gate verdict to a hash of the exact
  working tree. A green run on yesterday's tree, a partial run, or a gate that edited
  files while it ran never counts as evidence.
- **Adapts as models improve.** `hyvemind eval` runs each skill's scenarios with and
  without the skill. When a newer model catches up, the skill's lift drops to zero,
  which is evidence for thinning or retiring it.
- **Proves tests can fail.** `hyvemind probe` breaks the code a test is supposed to
  guard and records whether the test goes red.
- **Evidence on the PR.** `hyvemind evidence --post` publishes the verdict as a
  `hyvemind/gate` commit status, but only for a clean, gated commit.
- **Merge queue.** `hyvemind train` gates several PRs in one run, merges them only if
  the base didn't move, proves the base's tree is the gated tree, and bisects a red
  train to name the culprit.
- **One fresh agent per task.** `hyvemind run plan.md` gives each plan task to a new
  agent in its own worktree. The task's own exit check decides done, and an
  independent reviewer must say GO.
- **Only the tests that matter, unless unsure.** `hyvemind affected` walks the import
  graph from your change to the tests it can reach, and selects everything when it
  can't trace a change.
- **No dependencies.** Node ≥ 20 and git.

It grew out of the skill suite used to build the [OpenWOP](https://github.com/openwop)
app, generalised so any repository can use it. The research behind it compares 12
active open-source coding agents and 8 SDLC frameworks; it is in the openwop-app repo
at `docs/research/sdlc-agent-landscape-and-proposal-2026-10-25.md`.

## Install into a project

```bash
npx -y hyvemind@0.2.0 init      # detects the project, writes hyvemind.json,
                                # installs the skills and the AGENTS.md block
npx -y hyvemind@0.2.0 doctor    # checks that everything is wired up
npx -y hyvemind@0.2.0 gate      # runs your gates and records evidence
```

Installed skills call the CLI as `npx -y hyvemind@<exact version>` (the `cli` field in
`hyvemind.json`). Because the version is exact, `npx` can never resolve a look-alike
package. If you'd rather pin hyvemind as a dev dependency, install it first:

```bash
npm i -D hyvemind@0.2.0                                  # from npm
npm i -D github:davidscotttufts/hyvemind#v0.2.0          # or straight from GitHub
npx hyvemind init                                        # writes "cli": "npx hyvemind"
```

Commit `hyvemind.json`, the installed skills, `AGENTS.md` and `.hyve/manifest.json`.
Evidence and eval reports under `.hyve/` are git-ignored automatically.

### Presets

`init` picks a preset based on what the repo already has. Use `--preset` to override.

| Preset | Detected by | Gates | Notes |
|---|---|---|---|
| `openwop` | root `ci` script + `backend/typescript` + `frontend/react` | `npm run ci` | openwop-app and its white-label forks (kicktodo, bookai, …). Vitest probe lanes for backend and frontend, ADR numbers from `scripts/check-adr-refs.mjs --next`, and a ban on in-tree workflows |
| `node` | `package.json` | whichever of `lint`, `typecheck`, `test`, `build` exist | vitest-aware probe command |
| `python` | `pyproject.toml` / `setup.py` | `python -m pytest -q` | |
| `generic` | anything else | none (add your own) | |

To install only some of the skills (for example, in a repo that already has its own
stronger review skill):

```json
{ "version": 1, "preset": "openwop", "skills": { "include": ["evidence", "skill-eval", "skill-miner"] } }
```

### Upgrading

Change the version in `cli` (or bump the dev dependency), then run `update`.
`update` replaces the skills hyvemind installed. It **keeps** any skill file you
edited, and any same-named skill that existed before hyvemind, and reports both.
`--force` overwrites them. Skill names are chosen so they don't collide with common project skills
(`review`, `plan`, `pr`). Set `skills.prefix` if you want your own namespace.

### A project that already has its own gate

Some repos already have an established merge gate with its own queue, lock and status
check. Point hyvemind at it rather than adding a second definition of done:

```json
{ "version": 1, "preset": "openwop",
  "externalGate": { "run": "node scripts/local-ci.mjs --pr <n> --post",
                    "done": "the `ci/local-verify` status is success on the PR head" },
  "skills": { "include": ["write-spec", "design-review", "plan-tasks", "parallel-work", "skill-eval"] } }
```

The `AGENTS.md` block then names that gate and that definition of done. hyvemind runs
neither. `doctor` warns if a skill that uses hyvemind's own gate, evidence or train is
also installed (`ship-change`, `open-pr`, `review-change`, `evidence-rules`).

### Optional: a machine-wide CI broker (tracegate-ci)

When several agent sessions share one machine, their test suites starve each other.
[tracegate-ci](https://github.com/davidscotttufts/tracegate-ci)'s broker is one
capacity-aware queue for all of a machine's CI work. Configure it and hyvemind wraps
every gate, train gate, sabotage probe and eval agent run in `tracegate lease`:

```json
"broker": { "command": "tracegate", "tokens": { "eval": 1 } }
```

hyvemind never depends on it. Without `broker`, commands run directly. `doctor`
checks that the broker is reachable. For Vitest projects, tracegate can also be the
gate itself, running only what a change can affect once that has been earned:
`"gates": [{ "name": "backend", "run": "tracegate run --lane backend -- vitest run" }]`.
hyvemind still ties the verdict to the exact tree.

## The skills

| Skill | Phase | What it does |
|---|---|---|
| `ship-change` | all | The pipeline from spec to PR, stopping at each gate. Sizes the process to the change (trivial / contained / structural) |
| `write-spec` | requirements | A spec grounded in the existing code; WHEN/THEN acceptance criteria; a numbered decision record for structural changes |
| `design-review` | design | Architecture review in which every finding names a concrete failure scenario; ends GO / NO-GO |
| `plan-tasks` | planning | Dependency-ordered tasks, each sized for one fresh-context session and each with its own exit check |
| `review-change` | review | Runs the full gate first, scans for banned patterns, then reviews the change for defects |
| `test-necessity` | test | Grades tests A–F with sabotage probes; fixes B/C up to A, deletes D/F with evidence |
| `open-pr` | release | Opens a PR only when the current tree has green evidence, and asks before pushing |
| `evidence-rules` | always | The hive constitution: what counts as evidence (a status code doesn't, an empty result is suspect, change one variable at a time…) |
| `parallel-work` | always | Git hygiene for many sessions or agents in one repo: separate worktrees, never stash a shared tree |
| `skill-eval` | meta | Scaffold economics: how much each skill lifts the model compared with the model bare |
| `mine-skills` | meta | Mines Claude Code transcripts for repeated skill chains and proposes combined skills |
| `ai-exchange` | review (AI) | Grades every place the app talks to an LLM: runtime schemas from the source of truth, state read before writing, validated output with one bounded repair, gated apply |
| `live-ai-check` | test (AI) | Runs the app's AI flows against real vendors on a local stack, with key names only. Classifies results honestly: pass, app-bug, contract-gap, vendor-refusal, quota |

## CLI

```
hyvemind init | update | doctor | list
hyvemind gate [--only a,b] [--keep-going] [--quiet]
hyvemind evidence [--post [--dry-run]]  # exit 0 only if the current tree has a full green gate
hyvemind affected [--base ref] [--json] [--run]
hyvemind train <pr…> [--no-merge] [--no-bisect] [--local] [--base branch]
hyvemind run plan.md [--spec spec.md] [--only T1,T2] [--no-review]
hyvemind probe probes.json             # sabotage probes
hyvemind eval [skill…] [--agent claude|codex|opencode] [--model id] [--trials n] [--concurrency n] [--report] [--render report.json]
hyvemind mine [--all] [--json]         # Claude Code transcript mining
```

### Gate evidence

Each run writes `.hyve/evidence/gate-<time>.json` containing `head`, `treeBefore`,
`treeAfter`, each gate's exit code and duration, and a `verdict`:

- **`green`**: every gate passed and the tree did not change.
- **`red`**: a gate failed. Later gates are skipped unless you pass `--keep-going`.
- **`invalid`**: the working tree changed during the run (a formatter, codegen, or a
  concurrent edit), so the run proves nothing about either tree.

The tree hash covers tracked **and untracked** files, minus ignored ones. It is
computed in a throwaway index, so your staging area is never touched.

### Posting evidence to a PR

`hyvemind evidence --post` sets a `hyvemind/gate` commit status on HEAD through the `gh`
CLI: `success` for a full green run, `failure` for a red one, and `error` for an
invalid one. It **refuses** to post when:
- the working tree differs from HEAD (evidence for uncommitted edits describes no
  commit);
- the only run is a partial one (`--only`);
- nothing has been gated.

`--dry-run` prints the call without making it.

### Merge queue

```bash
hyvemind train 412 415 419          # GitHub PRs
hyvemind train --local feat-a feat-b # branches on origin, merged with git
```

The train is `origin/<base>` plus each head merged in order. It runs in a persistent
worktree (`train.dir`, default `../<repo>-hyve-train`), so installed dependencies
survive between trains (`train.setup`, for example `npm ci`, runs before each gate).

- **Green:** it merges each PR, then checks that the base's new tree **equals** the
  gated tree. If not, it stops with `TREE MISMATCH`.
- **Base moved during the gate:** it rebuilds and gates again (`train.retries`,
  default 1), and otherwise refuses to merge.
- **Red:** it splits the train in half and gates each half; green halves merge and
  the culprit is named and left open.
- **A PR that doesn't merge cleanly onto the train:** reported and skipped.
- One train per clone at a time. Never `--delete-branch` (it would close stacked PRs).

### Running a plan

`hyvemind run plan.md` reads the task format that `plan-tasks` writes:

```
T2 — Add the parser
  Depends on: T1
  Files: src/parse.mjs
  Exit check: `node --test test/parse.test.mjs`
```

For each task, in dependency order, on branch `hyve/run-<plan>` in its own worktree:
1. A **fresh** agent process implements it (`run.agent`, default Claude Code with
   `acceptEdits`).
2. The task's exit check decides whether it's done. A failed attempt is rolled back
   and retried once, with the failing command and its output passed to the agent.
3. An **independent** reviewer (`run.reviewer`) must end with `VERDICT: GO`.
4. One commit per task. Re-running resumes after the last committed task.

### Affected tests

`hyvemind affected` walks the JS/TS import graph backwards from changed files:
- committed since `--base`, uncommitted, and untracked changes all count;
- static and dynamic imports, `require`, TS `.js`→`.ts`, `index` files, and
  `affected.aliases` are followed.

It selects **all** tests when a change can't be traced:
- `package.json`, lockfiles, test/build config, or `.env` (`affected.fullRunOn`);
- any non-code file that isn't ignored, such as a JSON fixture.

Docs and skills select nothing (`affected.ignore`). `--run` runs `affected.command`
with `{tests}`. It's for fast inner loops; the full gate still decides "done".

### Probes

```json
[{ "id": "auth-skip", "src": "src/auth.ts", "old": "if (!user) throw", "new": "if (false) throw",
   "test": "src/auth.test.ts", "lane": "default", "expectOutput": ["rejects anonymous"] }]
```

For each probe, hyvemind:

1. replaces `old` with `new` in `src` (`old` must occur exactly once);
2. runs `probe.command` with `{test}` filled in, from the `probe.lanes[lane]` directory;
3. restores the file and **verifies** the restore.

It refuses to touch a file that has uncommitted changes. Each probe gets one verdict:
`witnessed`, `vacuous`, `other-red` or `error`. A failure that matches
`probe.errorPatterns` (red for the wrong reason) never counts as a witness.

### Evals

Scenarios live in `skills/<skill>/evals/*.json` (bundled with hyvemind) and
`.hyve/scenarios/<skill>/*.json` (your own). Each scenario runs in a fresh scratch git
repo twice, once bare and once with the skill. Both runs are scored mechanically, by
output patterns, files or commands. Agents are argv templates in `evals.agents`:

```json
"evals": { "agent": "claude", "agents": { "claude": { "command": ["claude", "-p", "{prompt}"] },
                                          "codex":  { "command": ["codex", "exec", "{prompt}"] } } }
```

Verdicts:

- `no-signal`: neither arm ever passes, so the scenario (or the skill) is broken.
- `earning`: lift ≥ `liftThreshold` (default 0.2).
- `marginal`: lift is positive but below the threshold.
- `retire-candidate`: lift ≤ 0.
- `insufficient-data`: fewer than `minRuns` runs (default 3). Never retire a skill on
  one run.

**Measured results:** [docs/evals/2026-10-26-claude.md](docs/evals/2026-10-26-claude.md) has two
132-run evals on Claude Code. `spec` (+0.50), `pr` (+0.67) and, after a
measured rewrite, `plan` (+0.50) clearly earn their place. The other ten are saturated on today's model *for
these scenarios*, which is a prompt to write harder scenarios and to check a second
model, not to retire anything yet.

Caveat: the bare run can still see user-level skills (`~/.claude/skills`) and global
instructions. For a strict baseline, run evals from a clean profile.

## Configuration

See [`schema/hyvemind.schema.json`](schema/hyvemind.schema.json). Values merge in this
order: defaults, then the preset, then `hyvemind.json`. Objects merge; arrays replace.

## Development

```bash
npm test                                          # node:test
node bin/hyvemind.mjs probe test/self-probes.json # hyvemind probes its own tests
```

Each core guarantee has a self-probe showing that its test goes red when the guarantee
is broken. The guarantees covered: tree-bound evidence, partial runs never counting,
local edits being kept, probes restoring the file, eval lift, and chain splitting in
the miner.

## Releasing

Releases publish from GitHub Actions with npm trusted publishing (OIDC) and
provenance, so no npm token is stored anywhere. To release:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then `git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`.

[`publish.yml`](.github/workflows/publish.yml) checks that the tag matches the
version, runs the tests and self-probes, and publishes. It refuses to overwrite a
version already on npm with different contents.

The package's trusted publisher is configured once at
`npmjs.com/package/hyvemind/access`: GitHub Actions, `davidscotttufts/hyvemind`,
`publish.yml`.

## License

Apache-2.0
