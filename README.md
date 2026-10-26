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
- **No dependencies.** Node ≥ 20 and git.

It grew out of the skill suite used to build the [OpenWOP](https://github.com/openwop)
app, generalised so any repository can use it. The research behind it compares 12
active open-source coding agents and 8 SDLC frameworks; it is in the openwop-app repo
at `docs/research/sdlc-agent-landscape-and-proposal-2026-10-25.md`.

## Install into a project

```bash
npx -y hyvemind@0.1.0 init      # detects the project, writes hyvemind.json,
                                # installs the skills and the AGENTS.md block
npx -y hyvemind@0.1.0 doctor    # checks that everything is wired up
npx -y hyvemind@0.1.0 gate      # runs your gates and records evidence
```

Installed skills call the CLI as `npx -y hyvemind@<exact version>` (the `cli` field in
`hyvemind.json`). Because the version is exact, `npx` can never resolve a look-alike
package. If you'd rather pin hyvemind as a dev dependency, install it first:

```bash
npm i -D hyvemind@0.1.0                                  # from npm
npm i -D github:davidscotttufts/hyvemind#v0.1.0          # or straight from GitHub
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
`--force` overwrites them. Skills are installed with a `bee-` prefix
(`skills.prefix`), so they never collide with a project's own `review` or `plan`.

## The skills

| Skill | Phase | What it does |
|---|---|---|
| `bee-ship` | all | The pipeline from spec to PR, stopping at each gate. Sizes the process to the change (trivial / contained / structural) |
| `bee-spec` | requirements | A spec grounded in the existing code; WHEN/THEN acceptance criteria; a numbered decision record for structural changes |
| `bee-design-review` | design | Architecture review in which every finding names a concrete failure scenario; ends GO / NO-GO |
| `bee-plan` | planning | Dependency-ordered tasks, each sized for one fresh-context session and each with its own exit check |
| `bee-review` | review | Runs the full gate first, scans for banned patterns, then reviews the change for defects |
| `bee-test-necessity` | test | Grades tests A–F with sabotage probes; fixes B/C up to A, deletes D/F with evidence |
| `bee-pr` | release | Opens a PR only when the current tree has green evidence, and asks before pushing |
| `bee-evidence` | always | The hive constitution: what counts as evidence (a status code doesn't, an empty result is suspect, change one variable at a time…) |
| `bee-parallel-work` | always | Git hygiene for many sessions or agents in one repo: separate worktrees, never stash a shared tree |
| `bee-skill-eval` | meta | Scaffold economics: how much each skill lifts the model compared with the model bare |
| `bee-skill-miner` | meta | Mines Claude Code transcripts for repeated skill chains and proposes combined skills |

## CLI

```
hyvemind init | update | doctor | list
hyvemind gate [--only a,b] [--keep-going] [--quiet]
hyvemind evidence                      # exit 0 only if the current tree has a full green gate
hyvemind probe probes.json             # sabotage probes
hyvemind eval [skill…] [--agent claude|codex|opencode] [--model id] [--trials n]
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

- `earning`: lift ≥ `liftThreshold` (default 0.2).
- `marginal`: lift is positive but below the threshold.
- `retire-candidate`: lift ≤ 0.
- `insufficient-data`: fewer than `minRuns` runs (default 3). Never retire a skill on
  one run.

**First live run (2026-10-25, Claude Code):** the bundled starter scenarios for
`evidence` and `test-necessity` scored 100% bare and 100% with the skill (one trial).
That means the starter scenarios are too easy for the current model. The next step is
a scenario aimed at a failure the model still makes. Treat the bundled scenarios as
smoke tests, and write your own for the mistakes your agents actually make.

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
