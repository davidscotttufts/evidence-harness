# hyvemind

**Your coding agent says it's done. hyvemind checks.**

Agents, and the people running them, declare victory on evidence that could not have
failed. Each of these happened in one codebase, a TypeScript monorepo with about 3,900
test files and many agent sessions working on it in parallel:

- A deploy check got `200` for the new JavaScript bundle. The host rewrites unknown
  paths to `index.html`, so the 200 was the fallback page, and the app didn't load
  for anonymous visitors.
- A check that nobody else had deployed returned nothing, with exit code 0, on three
  deploys in a row. It was querying without the region, so it could never find a build.
- A background test run was reported as exit 0. It had crashed on a bad flag and run
  zero tests. The 0 came from the `echo` after it.
- The merge queue's key safety check ("what landed is what was tested") had no test
  that could fail. A sabotage probe found it.
- hyvemind's own "this exact tree" hash missed edits made in the same second as the
  last index write. CI on Linux caught it.
- An eval of our agent skills scored every skill 0%. A CLI flag had swallowed the
  prompt, and the report recommended deleting all of them.

hyvemind is the toolkit that came out of fixing those. It's a small CLI and a set of
[Agent Skills](https://agentskills.io) that make "done" mean *a check that could have
failed, on exactly this code*. It works with Claude Code, Codex, OpenCode, or anything
else that reads `AGENTS.md` and skill folders. It has no runtime dependencies.

```bash
npx -y hyvemind@0.3.1 init     # detects the project, installs skills + an AGENTS.md section
npx -y hyvemind@0.3.1 gate     # runs your gates; the verdict is bound to this exact tree
```

## What it checks

### A green run counts only for the tree it ran on

```
$ hyvemind gate
✓ test 32.2s
verdict: GREEN · tree b22d510c2d85

$ echo "// tweak" >> src/git.mjs
$ hyvemind evidence
no gate has run on tree 8afda7aa5217; run "hyvemind gate"
```

The verdict is tied to a hash of the working tree, including uncommitted and
untracked files. A partial run never counts. A gate that changes files while it runs
is `invalid`, not green. `hyvemind evidence --post` puts the result on the pull
request as a `hyvemind/gate` commit status, and only for a clean, gated commit.

### Tests that can't fail are found, then proven

```
$ hyvemind census backend/typescript/test/
2763 test files · 20727 cases
ceilings: A 2053 · B 689 · C 14 · D 0 · F 7
flags: STATUS_ONLY 302 · WEAK_ONLY 101 · SKIPPED 107 · CONDITIONAL 44 · DUPLICATE_BODY 35 · MOCK_ONLY 22
```

That is a real run on the monorepo above, and it took 7 seconds. `census` reads every
test case's syntax tree, using your project's own TypeScript. It flags cases that
assert nothing, assert only inside an `if`, check only a status code or a mock call,
or duplicate another case. Each file gets a grade *ceiling*. Reading alone never
deletes anything: `hyvemind probe` breaks the code a test claims to guard and checks
that **that test case** goes red, not just that its name appears somewhere in the
output.

### What merges is what was tested

```
$ hyvemind train 1          # hyvemind's own 0.2.0 release PR
train: #1
  GREEN on tree 6dc8242fa0f9
  merged; main tree == gated tree 6dc8242fa0f9

merged: #1 · red: — · conflicts: — · refused: — · gate runs: 1
```

The merge queue gates several PRs as one combined tree. It merges only if the base
didn't move, then checks that `main`'s new tree **is** the tree it tested. A red
train splits itself in half to name the culprit, and everything else lands (tested
with branches, not yet on a real red PR).
hyvemind's own releases go through it.

### Each task gets a fresh agent, and a check decides when it's done

```
$ hyvemind run plan.md
T1 — Add an `add` function · attempt 1/2
T1 done · review GO
T2 — Add a `clamp` function that uses nothing else · attempt 1/2
T2 done · review GO
```

Each task in a plan goes to a new agent process in its own worktree. It's accepted
only when the task's own exit command passes. A failed attempt is rolled back and
retried once, with the failing output. Then a separate agent reviews the diff and
must answer `VERDICT: GO`. One commit per task, and re-running resumes.

### Instructions that no longer help get noticed

Models improve every month. An instruction that prevented a mistake last year can
become context the model pays for and ignores. `hyvemind eval` runs each skill's
scenarios with and without the skill and reports the difference.

The first real run, on Claude Code ([full report](docs/evals/2026-10-26-claude.md)):

| Skill | Without | With | Lift |
|---|---:|---:|---:|
| `open-pr` | 2/6 | 6/6 | **+0.67** |
| `write-spec` | 4/8 | 8/8 | **+0.50** |
| `plan-tasks` | 0/3 on exit checks | 3/3 | **+0.50** after a rewrite |
| 10 others | 100% | 100% | 0 |

Without `open-pr`, the model never ran the gate before opening a PR. Without
`write-spec`, it wrote acceptance criteria like "search should be fast". `plan-tasks`
first measured marginal, so its rule was rewritten and measured again. The other ten
are already handled by today's model, *on these scenarios*. That's a prompt to write
harder scenarios and to test a second model, not yet a reason to delete them.

## The skills

| Skill | What it makes the agent do |
|---|---|
| `ship-change` | Go from spec to PR, sized to the change, stopping at every gate |
| `write-spec` | Write criteria a test can check; reuse what already exists |
| `design-review` | Name a concrete failure scenario for every finding |
| `plan-tasks` | Write tasks small enough for one fresh agent, each with a runnable exit check |
| `review-change` | Run the gate first, then review only for defects that matter |
| `cleanup` | Delete code only when it's proved dead, and report what looked dead but was kept |
| `test-necessity` | Grade tests by whether they can fail; fix or delete with evidence |
| `grade` | Grade code, data, UX, localization or two lists that should match, A–F, in a tracker that resumes instead of restarting |
| `open-pr` | Open a PR only with green evidence for this exact commit |
| `release` | Cut a version from the commits, tag the merge commit, and check the published artifact matches a local build |
| `evidence-rules` | What counts as proof (an empty result is suspect, a 200 isn't proof) |
| `parallel-work` | Git hygiene when several agents share one repository |
| `ai-exchange` | Grade every place your app talks to an LLM |
| `live-ai-check` | Run AI features against real models, with keys by name only |
| `skill-eval` | Measure each skill against the bare model |
| `mine-skills` | Find the skill chains you repeat by hand |

Install all of them, or pick some. A repo that already has its own gate keeps it
(`externalGate`), and hyvemind doesn't add a second definition of done.
`evidence.status` and `train.via` make the CLI read that gate's verdict and leave
merging to it.

## Works with

- **Any agent** that reads `AGENTS.md` and `.claude/skills` or `.agents/skills`.
- **[tracegate-ci](https://github.com/davidscotttufts/tracegate-ci)** (optional). Its
  broker queues all of a machine's CI work, so parallel agents' test runs stop
  starving each other. Its learned test selection is the deeper version of
  `hyvemind affected`.
- **npm provenance**: releases are published from GitHub Actions with a signed
  attestation, and skills pin an exact version.

## More

- [Reference](docs/reference.md): every command, the config file, presets, upgrading.
- [Design](docs/design.md): where this sits among other agent tools, and what's next.
- [Landscape](docs/landscape-2026-10.md): how hyvemind compares with the open-source agent tools, and what to adopt next.
- [Evals](docs/evals/): raw reports.

Apache-2.0
