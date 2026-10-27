# hyvemind reference

Every command, the config file and the presets. For what hyvemind is and why, see the [README](../README.md).

## Install into a project

```bash
npx -y hyvemind@0.3.1 init      # detects the project, writes hyvemind.json,
                                # installs the skills and the AGENTS.md block
npx -y hyvemind@0.3.1 doctor    # checks that everything is wired up
npx -y hyvemind@0.3.1 gate      # runs your gates and records evidence
```

Installed skills call the CLI as `npx -y hyvemind@<exact version>` (the `cli` field in
`hyvemind.json`). Because the version is exact, `npx` can never resolve a look-alike
package. If you'd rather pin hyvemind as a dev dependency, install it first:

```bash
npm i -D hyvemind@0.3.1                                  # from npm
npm i -D github:davidscotttufts/hyvemind#v0.3.1          # or straight from GitHub
npx hyvemind init                                        # writes "cli": "npx hyvemind"
```

Commit `hyvemind.json`, the installed skills, `AGENTS.md` and `.hyve/manifest.json`.
Evidence and eval reports under `.hyve/` are git-ignored automatically.

### Pinning the CLI (supply chain)

An exact version stops `npx` resolving a look-alike package, but not different bytes
served under that version, nor a malicious release adopted the day it appeared. Pin the
content too:

```bash
npx -y hyvemind@0.3.1 pin       # writes "cli" and "integrity" (npm dist.integrity) into hyvemind.json
```

- **Integrity.** `integrity` is npm's `dist.integrity` (`sha512-…`) for the version in
  `cli`. `doctor` compares it with `npm view hyvemind@<version> dist.integrity` and fails
  if the registry serves something else. Offline, it warns that the pin could not be
  verified. With no `integrity`, `doctor` does not use the network.
- **Cooling-off.** `pin` refuses a release younger than `coolingOffDays` (default 14),
  because most malicious releases are caught and unpublished within days.
  `--allow-fresh` overrides this for a release you have reviewed. `doctor` reports
  the publish date against the same rule.
- **Or let a lockfile hold the hash.** Where the project has a `package.json`, install
  hyvemind as a devDependency instead (above). The lockfile records its integrity, and
  `"cli": "npx hyvemind"` (what `init` writes when it finds the local install; the
  `{{cli}}` token in every skill renders from it) makes skills call
  `node_modules/.bin/hyvemind` without ever downloading. `integrity` is then not
  needed.

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
{ "version": 1, "preset": "openwop", "skills": { "include": ["evidence-rules", "skill-eval", "mine-skills"] } }
```

To keep a bundled skill but let a project skill for the same job win, defer it:

```json
"skills": { "defer": { "review-change": "review", "open-pr": "pr" } }
```

The bundled skill is still installed, with a short header after its frontmatter: when
the project skill (`review`) is installed, follow it instead, and use this one only
where that skill doesn't apply. Deferring a skill that isn't bundled, or one the
project excludes, is an error. Turning a defer on or off is an ordinary content change
for `update`: untouched copies are rewritten, edited ones are kept and reported.

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

#### Let hyvemind read that gate's verdict: `evidence.status` and `train.via`

`externalGate` tells agents, in prose, what the gate is and what done means. When that
gate posts a commit status, two more keys let the CLI itself defer to it, so there is
exactly one definition of done and one merge path:

```json
"externalGate": { "run": "node scripts/local-ci.mjs --pr <n> --post",
                  "done": "the `ci/local-verify` status is success on the PR head" },
"evidence": { "status": "ci/local-verify" },
"train": { "via": "external", "message": "merges go through the release queue" }
```

- **`evidence.status`**: `hyvemind evidence` exits 0 only when the latest status with
  that context on HEAD (by `created_at`, read with
  `gh api repos/{owner}/{repo}/commits/{sha}/statuses`) is `success` **and** the
  working tree is clean and equal to HEAD. Uncommitted edits are never covered by a
  status on HEAD, however green. The output names the proof source
  (`proof: commit status "ci/local-verify" …` or `proof: local gate record …`), and
  local gate records are not consulted while the key is set.
- **`evidence --post`** posts nothing when `evidence.status` is set: it says the
  external status is authoritative, reports it, and exits 0.
- **`train.via: "external"`**: `hyvemind train` refuses to merge, prints
  `train.message`, exits non-zero, and touches no git state.

Set `evidence.status` to the status named in `externalGate.done`. Unset (the
default), evidence comes from local `hyvemind gate` records, as before. The reasoning
is in [design.md](design.md#one-definition-of-done).

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
| `review-change` | review | Independent of the author: runs the full gate first, scans for banned patterns, reviews for defects, refutes its own findings, and accounts for every file |
| `cleanup` | maintenance | Removes dead code only with proof (no static references and no dynamic path); protected categories kept; reports what looked dead but was saved |
| `test-necessity` | test | Grades tests A–F with sabotage probes; fixes B/C up to A, deletes D/F with evidence |
| `grade` | audit | Grades code, data, UX, localization, or two lists that should match (`rubrics/*.md`), A–F, in a tracker that resumes instead of restarting; evidence for every grade, an independent grader, and an ordered path to A+ |
| `open-pr` | release | Opens a PR only when the current tree has green evidence; pushes the branch freely, asks before the PR or any comment |
| `release` | release | SemVer from commits (a migration forces a minor), lockstep version bump, tag the merge commit, verify the published artifact against a local build; asks before tagging or publishing |
| `evidence-rules` | always | The hive constitution: what counts as evidence (a status code doesn't, an empty result is suspect, change one variable at a time…) |
| `parallel-work` | always | Git hygiene for many sessions or agents in one repo: separate worktrees, never stash a shared tree, an advisory shared queue, delete a branch only once proved landed |
| `skill-eval` | meta | Scaffold economics: how much each skill lifts the model compared with the model bare |
| `mine-skills` | meta | Mines Claude Code transcripts (locally, after asking) for repeated skill chains and proposes combined skills; reports aggregates only |
| `ai-exchange` | review (AI) | Grades every place the app talks to an LLM: runtime schemas from the source of truth, state read before writing, only the data it needs, validated output with one bounded repair, gated apply |
| `live-ai-check` | test (AI) | Runs the app's AI flows against real vendors on a loopback-only stack, with allowlisted key names only; paces and resumes on 429. Classifies results honestly: pass, app-bug, contract-gap, vendor-refusal, quota |

## CLI

```
hyvemind init | update | doctor | list
hyvemind pin [--allow-fresh] [--dry-run]  # record npm's dist.integrity for the version in "cli"
hyvemind gate [--only a,b] [--keep-going] [--quiet]
hyvemind evidence [--post [--dry-run]]  # exit 0 only if the current tree has a full green gate
hyvemind affected [--base ref] [--json] [--run]
hyvemind train <pr…> [--no-merge] [--no-bisect] [--local] [--base branch]
hyvemind run plan.md [--spec spec.md] [--only T1,T2] [--no-review]
hyvemind probe probes.json             # sabotage probes
hyvemind eval [skill[:scenario]…] [--scenario id]… [--agent claude|codex|opencode] [--model id] [--trials n] [--concurrency n]
              [--matrix | --agent a,b,c] [--wait min] [--dry-run] [--yes] [--keep] [--clean-profile] [--report] [--render report.json]
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

With `evidence.status` set, the project's own gate posts the status that means done,
and `--post` does not add `hyvemind/gate` beside it (see
[A project that already has its own gate](#a-project-that-already-has-its-own-gate)).

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
- `train.via: "external"` turns the train off for a project that merges some other
  way; it refuses and prints `train.message`.

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

### Sandboxed runs

`hyvemind run plan.md --sandbox podman` (or `docker`, or `run.sandbox` in hyvemind.json)
moves **code execution** into a container. The agent loop stays on the host: it needs
your login, and mounting credentials into a container is what a sandbox should avoid.

- **Checks run in the container.** Each task's exit check runs with the worktree
  mounted at `/work`, `--network none`, `--cap-drop ALL`, `no-new-privileges`, and
  memory and CPU limits.
- **Setup may use the network.** An optional `run.sandbox.setup` (for example
  `npm ci`) runs before each check; turn its network off with `setupNetwork: false`.
- **Environment is allowlisted.** Only the variables in `run.sandbox.env` (default:
  CI, NODE_ENV, LANG, TZ) get in. No home directory, no tokens, no SSH agent.
- **The agent loses its shell.** While sandboxed, the implementer defaults to
  `Read,Grep,Glob,Edit,Write` and the reviewer to `Read,Grep,Glob`. Anything the agent
  writes runs only inside the container, through the exit check, and it gets the
  failing output back. Setting `run.agent` yourself replaces this policy; the run
  report says so.

`doctor` checks that the runtime is installed and running. The image defaults to
`node:22-bookworm` (`run.sandbox.image`). OpenHands splits the work the same way: the
agent loop runs on the host and its actions run in the sandbox.

**Verified on real Podman** (6.1.4, macOS arm64 VM, 2026-10-26):
- a passing check exits 0, and a failing one returns its own code;
- checks have no network (an HTTPS fetch fails), and setup has it when allowed;
- a host variable outside the allowlist is absent while `CI` gets through;
- `/Users`, `~/.ssh`, `~/.codex` and `~/.claude` are absent;
- files written in `/work` are owned by the host user, not root;
- `chown` is refused.

To re-run it against your runtime: `HYVE_SANDBOX_REAL=podman npm test` (or `docker`).
Without that variable the real-runtime test is skipped.

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

### Census

`hyvemind census [path…]` reads every test file's syntax tree with the project's own
`typescript` package, flags cases that cannot fail or claim little, and gives each
file a grade ceiling. The ledger (`--out`, default `.hyve/census.json`) is keyed on
each file's git blob sha. Commit it if you track grades: a grade recorded on a file
survives only while the file is unchanged, and changed files are re-queued. `--md`
writes a summary table. Settings: `census.testPattern`, `census.headerRef` (what a
test's header must cite to count as saying why it exists), `census.typescriptFrom`.

The syntax tree has no comments, so the census also reads each case body's comments.
`COMMENTED_ASSERT` marks a case with an `expect(` or `assert(` call inside a comment, a
claim the case meant to make and doesn't run. One was swallowed by `…; // note … expect(…)`
on a single line. It caps the file like a weak claim (B). A call quoted in backticks
counts as prose about an assertion, so write history as `` `expect(x).toBe(1)` ``.
`UNUSED_LOCAL` is a hint, never a cap: a `const`/`let` the body declares and never reads,
often the value an assertion was meant to check. It's for JS lanes and projects without
`noUnusedLocals`. A `_` prefix, or a field named only to leave it out of `...rest`, is
not reported.

### Probes

```json
[{ "id": "auth-skip", "src": "src/auth.ts", "old": "if (!user) throw", "new": "if (false) throw",
   "test": "src/auth.test.ts", "lane": "default", "expectRed": ["rejects anonymous"] }]
```

For each probe, hyvemind:

1. replaces `old` with `new` in `src` (`old` must occur exactly once);
2. runs `probe.command` with `{test}` filled in, from the `probe.lanes[lane]` directory;
3. restores the file and **verifies** the restore.

It refuses to touch a file that has uncommitted changes, and takes a per-worktree lock, so a
second probe in the same tree refuses to start; a lock left by a dead process is
reclaimed. A probe edits files in place, so don't pull or check out in that tree while it
runs. Use `--isolate` to probe a throwaway worktree of `HEAD` instead (dependencies are
installed by `probe.setup`, defaulting to `train.setup`), which never touches the live tree. With `probe.format` set to
`vitest` or `node`, it reads the runner's structured result, and `expectRed` must name
cases that actually **failed**. `expectOutput` only checks that text appears in the
output, which a passing case's name can satisfy. Each probe gets one verdict:
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
- `saturated`: both arms pass every run. These scenarios cannot measure the skill;
  write one the bare model still fails ("unmeasured below ceiling"), don't retire it.
- `earning`: lift ≥ `liftThreshold` (default 0.2) **and** the 95% lift interval excludes 0.
- `earning (low n)`: lift ≥ `liftThreshold`, but the interval still includes 0, so a
  flipped run or two could explain it. Run more trials before citing it.
- `marginal`: lift is positive but below the threshold.
- `retire-candidate`: lift ≤ 0 with the bare arm below 100%.
- `insufficient-data`: fewer than `minRuns` runs (default 3). Never retire a skill on
  one run.

Uncertainty: each arm gets a 95% Wilson score interval. The lift interval is
Newcombe's hybrid score interval for a difference of proportions (method 10 in
Newcombe 1998): with skill arm (p₁, l₁, u₁) and bare arm (p₂, l₂, u₂),
`lower = d − √((p₁−l₁)² + (u₂−p₂)²)` and `upper = d + √((u₁−p₁)² + (p₂−l₂)²)`, where
d = p₁ − p₂. It treats the two arms as independent samples. At 3 runs per arm only
3/3 vs 0/3 clears 0.

Per scenario: the report has a row per scenario (bare and skill pass counts, lift) and
flags `harmful` (the skill arm passes less often than bare) and `no-signal` (neither
arm passes). Flagged scenarios are listed at the top of the markdown report, because a
skill-level average hides them. The report also shows each skill's rendered size in
words, with tokens approximated as words × 1.3, next to its lift.

`--render <report.json>` recomputes verdicts, intervals and per-scenario rows from the
report's runs, so a report from an older hyvemind renders with today's rules.

**Measured results:** [docs/evals/2026-10-26-claude.md](evals/2026-10-26-claude.md) has two
132-run evals on Claude Code. `spec` (+0.50), `pr` (+0.67) and, after a
measured rewrite, `plan` (+0.50) clearly earn their place. The other ten are saturated on today's model *for
these scenarios*, which is a prompt to write harder scenarios and to check a second
model, not to retire anything yet.

#### Scenario lint

A scenario can carry example outputs: `good` (an answer that should pass) and `bad`
(a plausible wrong answer, typically the one the prompt's trap invites). Each is a
string or a list of strings. `hyvemind eval --lint` checks them with no model calls,
and so does `npm test` for every bundled scenario:

- every `good` must pass all of the scenario's checks;
- every `bad` must fail at least one;
- a scenario without either is counted as **unlinted**. That is reported, not an error.

`output-*` checks are linted from the string. `file-exists` and `command` checks read
the workspace the agent changed, which a string can't stand in for, so a scenario that
has them is linted on its output checks only and marked **partial** with that reason.

**Contradiction check.** The lint reads the lines the prompt tells the model to print,
for example "end with exactly one line: `GRADE: <letter>`" or "exactly two lines:
`PUSH: ask | go` and `PR: ask | go`". It then scores each line against the checks that
name its label (plus every `output-excludes` / `output-not-matches` check):

- A line dictated word for word that fails those checks is an **error**: obeying the
  prompt would fail the scenario.
- A menu (`a | b`, or `LABEL: a  or  LABEL: b`) where no offered answer passes is an
  **error**.
- Templates (`<…>`) are not scored as answers.
- A `LABEL: a | b` menu that fails when echoed verbatim is a **warning** (`menu-echo`).
  Round 2's `docs-are-not-the-code` prompt said `GRADE: A | unverified`, and the model
  printed exactly that in every run of both arms. `LABEL: <a or b>` is unambiguous.
- The reverse, a verbatim echo that *passes*, is also a **warning**
  (`menu-echo-passes`): the checks can't tell copying the menu from answering.
- Templates are checked for one thing: a placeholder line (`LABEL: <a or b>`) printed
  verbatim must fail the checks that name its label. If it passes, that is an
  **error** (`placeholder-echo-passes`), because the scenario can't tell copying the
  placeholder from answering. Example: `GRADE:\s*\S+` accepts `GRADE: <letter>`.

#### Running evals

**Cost preview and consent.** Before any agent starts, `eval` prints the plan to stderr:
skills, scenarios, trials, the two arms, total agent runs, concurrency, and a duration.
The duration is an upper bound (every run hitting `timeoutSec`) and, when an earlier
report under `.hyve/evals/` recorded run times, an estimate from their median. On a
TTY it asks `[y/N]`. Otherwise it refuses to start without `--yes`. `--dry-run` prints
the preview and exits.

**One scenario.** `hyvemind eval write-spec:do-nothing-alternative` runs only that
scenario. `--scenario <id>` (repeatable) filters every named skill. A filter that
matches no scenario is an error. The report row then says which scenarios it covers
(`selected`).

**Environment.** Agent processes get an allowlisted environment, never the whole
`process.env`: `PATH`, `HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `USER` and
`HYVE_EVAL_ARM`. Scenario `setup` and `command` checks get the same list (plus git
identity for setup). If your agent authenticates with an environment variable, name it
in that agent's `env`, for example:

```json
"evals": { "agents": { "claude": { "env": ["ANTHROPIC_API_KEY"] }, "codex": { "env": ["OPENAI_API_KEY"] } } }
```

Only names go in config. Values come from your environment. No auth variable is
passed by default, so an agent that logs in through its own credential store (Claude
Code's login, for example) needs nothing here. A broker (`broker`) that needs its own
variables gets them the same way.

**Load.** An agent run that times out on a starved machine reads like a skill
failure. So, as the gate does, `eval` samples the machine (other test suites, load
average) before every job and records the busiest sample on the report as
`contention`: `contended`, `samples`, `contendedSamples`, `load1`, `cores` and
`competitors`. When any job started contended, the CLI and the markdown report say so,
and its failures should be re-run rather than read. `--wait <min>` makes each job wait
for the machine to quiet down first, up to `min` minutes for the whole run. With a
`broker` configured, the broker queues the work and nothing is sampled.

**Logins, not API keys.** Agents run on their own login: the Claude Code or Codex
subscription you are already signed in with. API keys are not in the allowlisted env,
so a run never bills a key unless the agent's `env` names one. Each built-in agent has
an `authCheck`, its CLI's status command (`claude auth status`, `codex login status`,
`opencode auth list`). It runs with the agent's env and a 15 s timeout. Only its exit
code counts, plus a `match` regex for a CLI that exits 0 either way (`opencode`). Its
output is never printed or stored, because status commands print account emails. An
agent with no `authCheck` is assumed logged in.

**Which agent.** A single-agent eval runs, in order: `--agent`; the project's
`evals.agent`; the agent hyvemind is running inside (Claude Code sets `CLAUDECODE=1`);
the built-in default. Codex sets no documented marker, so inside Codex the default
applies; set `evals.agent` or pass `--agent codex`. The preview names the agent and the
reason, and an agent that isn't logged in is refused before the preview asks to start.

**Matrix (`--matrix`, or `--agent a,b,c`).** Runs the selected scenarios once per
agent. `--matrix` uses every agent in `evals.agents` whose command binary is
installed (a bare name is looked up on `PATH`, a path is checked directly) and logged
in. `--agent a,b,c` names the agents. A configured agent that isn't installed is
skipped and listed as `not installed`; one whose `authCheck` fails is skipped as `not
logged in`. A name missing from
`evals.agents` is an error.

- **Nothing is pooled.** Each agent gets its own runs, verdicts and intervals, and its
  kept outputs go under `.hyve/evals/<run-id>/<agent>/`. Agents run one after another,
  each at `--concurrency`.
- **One consent covers the whole matrix.** The preview gives the total agent runs
  across agents first, then each agent's share and duration, then the skipped agents.
  `--yes` (or `y` on a TTY) starts all of it, and `--dry-run` prints that breakdown and
  exits. The duration estimate uses each agent's own past runs.
- **The report.** The JSON report has `matrix: true`, an `agents` list with one section
  per agent (that agent's `skills`, shaped like a single-agent report's), `skipped`,
  and `disagreements`. The markdown has one table with a column group per agent
  (bare / skill / lift / verdict) and a per-scenario table. It opens with
  **Disagreements**: skills measured on two or more agents whose verdicts differ, for
  example `saturated` on one and `earning` on another. That signal is the reason to
  run a matrix. A saturated reading on one agent says nothing about the others.
  `--render` reads both single-agent and matrix reports.
- **Per-agent settings.** `--model` is refused for a matrix, because a model id belongs
  to one vendor. Put the model in each agent's `command` instead. `--clean-profile`
  applies each agent's own `cleanArgs`/`cleanEnv`. It is refused, before anything
  runs, if any selected agent has no `cleanArgs`. Each agent's `env` passes through as
  usual, and no vendor auth variable is assumed.

**Kept outputs.** Every failing run's full output (up to the 8 MB capture cap) is saved
to `.hyve/evals/<run-id>/<skill>/<scenario>/<arm>-<trial>.txt`, and the run records the
path as `output`. `--keep` also keeps passing runs' output, plus the scratch
workspaces. The report keeps the last 2,000 characters inline as `tail`. The markdown
report links each failed run's file.

**Version.** Reports are stamped `<version>+<short sha>` when hyvemind runs from a git
checkout, with `-dirty` added when that checkout has changes, and the plain version
when it runs from an installed package.

**Clean profile (`--clean-profile`).** By default the bare arm is not fully bare: an
agent CLI loads the user's own skills, global instructions, settings, MCP servers and
memory in both arms. `--clean-profile` adds the agent's `cleanArgs` and sets its
`cleanEnv`, in **both** arms. `eval` refuses `--clean-profile` for an agent that has no
`cleanArgs`.

Where `cleanArgs` go: if the agent's `command` has a `{clean}` argument, they are
spread there, and without `--clean-profile` `{clean}` expands to nothing. Use it for a
CLI whose flags must follow a subcommand (`["codex", "exec", "{clean}", "{prompt}"]`).
A command with no `{clean}` keeps the original placement, right after the executable.
`{clean}` must be a whole argument and can't be the executable.

The default for `claude`:

```json
"cleanArgs": ["--setting-sources", "project,local", "--strict-mcp-config"],
"cleanEnv": { "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1" }
```

What is documented (Claude Code CLI reference, memory and authentication docs):
- `--setting-sources` selects which settings sources load (`user`, `project`, `local`).
- Project skills in `.claude/skills` depend on the `project` source, so the skill arm still works.
- `--strict-mcp-config` with no `--mcp-config` loads no MCP servers.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns off auto-memory.
- Authentication does not depend on setting sources, so login keeps working.

What is **not** documented, and so not guaranteed: that leaving out the `user` source
also drops `~/.claude/skills`, `~/.claude/CLAUDE.md` and user plugins (the docs imply
it but don't state it). Verify on your machine with a canary before citing a clean
baseline. Put a uniquely named skill in `~/.claude/skills`, run one scenario with
`--clean-profile --keep`, and check that neither arm's kept output mentions it.

Rejected options:
- `--safe-mode` also disables project skills, so the skill arm would be bare too.
- `--bare` never reads OAuth or the keychain, and needs an API key.
- `CLAUDE_CONFIG_DIR` pointed at an empty directory loses the login.
- Copying credentials into a temporary profile was ruled out. (Codex's `cleanHome` *links* the login and never copies it.)

hyvemind never reads, copies or prints credential files or tokens.

The default for `codex` comes from `codex exec --help` text only (codex-cli 0.164.0).
These are `exec` options, which codex rejects before the subcommand, so they sit at
`{clean}`:

```json
"command": ["codex", "exec", "{clean}", "{prompt}"],
"cleanArgs": ["--ignore-user-config", "--ephemeral", "--ignore-rules"]
```

- `--ignore-user-config`: "Do not load `$CODEX_HOME/config.toml`; auth still uses
  `CODEX_HOME`".
- `--ephemeral`: "Run without persisting session files to disk".
- `--ignore-rules`: "Do not load user or project execpolicy `.rules` files". These
  are command-approval rules, not instructions.

**Measured (2026-10-26, codex-cli 0.164.0): these flags do NOT skip
`$CODEX_HOME/AGENTS.md`.** With a canary there ("end every reply with CANARY-7731"),
every run followed it, both with and without the three flags. No `exec` flag skips that
file. So the codex default also has a `cleanHome`:

```json
"cleanHome": { "env": "CODEX_HOME", "from": "~/.codex", "keep": ["auth.json"] }
```

With `--clean-profile`, each run gets a fresh `0700` temp dir (outside the repo) holding
only **links** to the `keep` files, the login allowlist, with `CODEX_HOME` pointed at it.
Codex logs in through the link and finds no user instructions, config or memory. With
the canary in place, the run without the clean profile followed it and the run with it
did not. The login file was unchanged, and no temp dir was left behind.

- **The login is linked, never copied, read or logged.** If codex refreshes its token
  by replacing the link with a file, that file is **moved** back (one atomic rename), so
  no second copy ever exists. The move happens only if the real file is exactly as it
  was when the run started (mtime and size) and no other writer holds
  `.auth.json.hyvemind.lock`. Otherwise the fresher real file wins and the refreshed one
  is dropped. A temp dir on another volume skips the move.
- **The dir is removed** when the run ends, after a timeout kill, and on SIGINT/SIGTERM.
- **The preview says so before anything runs:** `clean profile: a temp CODEX_HOME with
  only auth.json linked from ~/.codex (login only; …)`.

The three flags are still passed. They keep config.toml, session files and `.rules` out.

`opencode` has no default `cleanArgs`, so `--clean-profile` refuses it. Its only
candidate, `--pure` (opencode 1.19.4: "run without external plugins"), drops plugins
only. The help doesn't say that it drops user instructions or skills, so it isn't a
clean profile.

Check either agent with the canary method above before citing a clean baseline.

## Configuration

See [`schema/hyvemind.schema.json`](../schema/hyvemind.schema.json). Values merge in this
order: defaults, then the preset, then `hyvemind.json`. Objects merge; arrays replace.

## Development

```bash
npm ci                                            # once per fresh checkout: the census tests need typescript (dev only)
npm test                                          # node:test
node bin/hyvemind.mjs probe test/self-probes.json # hyvemind probes its own tests
```

Each core guarantee has a self-probe showing that its test goes red when the guarantee
is broken. The guarantees covered: tree-bound evidence, partial runs never counting,
local edits being kept, probes restoring the file, eval lift, eval verdicts
(saturated, earning vs low n, per-scenario harmful/no-signal flags, the lift
interval, old reports re-rendered, the eval safety rails, `{clean}` placement, scenario lint including `placeholder-echo-passes`, the eval matrix: no pooling across agents, skipping agents that are not installed, the disagreements list, one consent for the whole matrix), and chain splitting in the miner.

## Releasing

Releases publish from GitHub Actions with npm trusted publishing (OIDC) and
provenance, so no npm token is stored anywhere. To release:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then `git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`.

[`publish.yml`](../.github/workflows/publish.yml) checks that the tag matches the
version, runs the tests and self-probes, and publishes. It refuses to overwrite a
version already on npm with different contents.

The package's trusted publisher is configured once at
`npmjs.com/package/hyvemind/access`: GitHub Actions, `davidscotttufts/hyvemind`,
`publish.yml`.

## License

Apache-2.0
