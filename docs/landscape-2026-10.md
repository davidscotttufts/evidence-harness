# hyvemind and the open-source agent landscape (October 2026)

This compares hyvemind 0.3.0 with the active, well-rated open-source projects that try to
automate the software lifecycle with agents, and proposes what to adopt.

**Method.** Repositories, stars, licences and activity were read from the GitHub API on
2026-10-25. Features come from each project's README and docs at HEAD. A project counts
as active if it had a default-branch commit or a release within the last 60 days. Claims
the survey could not verify are marked *unverified*. hyvemind's side is its own code at
v0.3.0 (`5070804`), its two eval reports, and issue #17.

## 1. The field

The projects fall into two layers. hyvemind belongs to the second.

### Inner loop: agent runtimes that edit, run and test code

| Project | Stars | Reach | Notes |
|---|---:|---|---|
| OpenCode | 221k | Plan and build agents; TUI, desktop, server | Live model catalog; a model and an effort level per agent. Dropped its GitHub Action on 10-25 |
| Codex CLI | 131k | Code and test; `exec` for CI | OS-level sandbox and approval policy; AGENTS.md; skills |
| Pi | 118k | Code; RPC and SDK | Deliberately minimal; sub-agents and plan mode are extensions |
| Gemini CLI | 108k | Code, PR operations | Single-vendor; users are being moved to Antigravity CLI |
| **OpenHands** | 92k | Triage → code → test → review → CI → PR; scheduled and webhook automations | Swaps in other runtimes over ACP; a container per conversation; pinned benchmark repo |
| Cline | 71k | Plan/Act, headless JSON, cron agents, teams | Wide provider matrix |
| Goose | 56k | General agent with "recipes" | Separate planner model; 70+ MCP extensions |
| Qwen Code | 29k | Review, bugfix, batch; daemon; SDKs | Copies Claude Code's feature set |
| Kilo Code | 28k | Plan, code, debug; `run --auto` for CI fixes | 500+ models; can switch mid-task |
| **Open SWE** | 11k | Issue/Slack → sandbox → validate → PR → review → CI babysitting | Re-runs only the CI failures it has evidence are flaky |
| **mini-swe-agent** | 8.8k | Issue → patch | About 100 lines, bash only, any model; the fixed harness for a SWE-bench leaderboard |

Inactive, archived or not open source: Aider, SWE-agent (succeeded by mini), Roo Code,
Continue, Plandex, AutoCodeRover, Agentless, Devika, Devon, Sweep, Moatless, Refact, Kimi
CLI, and Claude Code itself (public repository, no open-source licence).

### Outer loop: the spec → plan → gate → review → merge procedures around a runtime

| Project | Stars | Artifact chain and gates | Distinctive mechanism |
|---|---:|---|---|
| Superpowers | 305k (*unverified* as adoption) | brainstorm → design → plan in 2–5 minute tasks → a fresh sub-agent per task → two-stage review → TDD | Skills are written test-first against a bare-model baseline |
| Spec Kit | 143k | constitution → spec → plan → tasks → implement → converge loop | 41 agent integrations; constitutional "phase −1" gates |
| Ruflo | 79k | missions and swarms; 314 MCP tools | Claims trajectory learning (*unverified*) |
| OpenSpec | 73k | propose → apply → archive | Changes are delta specs, merged into living specs on archive |
| BMAD | 55k | clarify → plan → build/verify → learn | Process scaled to the size of the change; an unattended epic loop |
| **Archon** | 24k | intake → build queue → merge queue | YAML graphs with bash loops (`until_bash`), approval waits, and a merge gate on review verdict + CI + a healthy base |
| CCPM | 8.4k | PRD → epic → GitHub sub-issues → parallel worktrees | Benchmarks each skill against no skill |
| cc-sdd | 3.7k | Kiro-style requirements → design → tasks → implement | Detects what the host agent can do and adapts |

The standards that hold the field together: **Agent Skills** (`SKILL.md`), **AGENTS.md**,
and the **Agent Client Protocol (ACP)**.

## 2. Where hyvemind stands: the twelve leading features

| # | Leading feature | Best examples | hyvemind 0.3.0 |
|---|---|---|---|
| F1 | A model layer that works with any provider | OpenCode, Kilo, Pi | **Delegated.** Agents are argv templates (`claude`, `codex`, `opencode`); hyvemind holds no catalog |
| F2 | A model and effort level per role | OpenCode, Goose | **Partial.** `run` has separate implementer and reviewer commands, but no model or effort per role, and none recorded |
| F3 | Swappable runtime | OpenHands (ACP), Archon, Spec Kit | **Yes**, through argv templates. No ACP, so no structured permissions or events |
| F4 | A fixed benchmark to re-measure when models change | OpenHands benchmarks, mini-swe-agent | **Skills only.** `eval` measures skills against the bare model. Nothing measures coding success on *your* repo |
| F5 | Scaffolding that has to keep proving its value | CCPM, Superpowers | **Ahead.** Evals per skill, a `no-signal` verdict, two published rounds, and one skill improved by measuring it again |
| F6 | Separate plan and act phases | OpenCode, Cline, Kilo | **Yes.** `plan-tasks` → `run` |
| F7 | A fresh sub-agent per task, then an independent reviewer | Superpowers, cc-sdd, Archon | **Yes, serially.** `run` gives each task a fresh agent and needs a separate reviewer's GO. No parallel tasks |
| F8 | Code, not the agent, decides "done" | Archon, Spec Kit, Superpowers | **Ahead.** The verdict is bound to the working-tree hash; probes check that the failing case is the right one; the train proves what landed is what was tested |
| F9 | An isolated workspace per task | OpenHands, Open SWE, Codex | **Worktree only.** No container, no network policy, so unattended runs aren't safe |
| F10 | Permission rules and approvals sized to risk | OpenCode, Codex, Open SWE | **Left to the agent.** `run` uses `acceptEdits`; hyvemind sets no per-role tool or network policy |
| F11 | Event-driven lifecycle: issue → PR → review → CI babysitting | Open SWE, OpenHands | **Missing.** Every step starts by hand. Nothing watches issues or CI |
| F12 | A spec chain with a constitution and living specs | Spec Kit, OpenSpec, cc-sdd | **Partial.** `write-spec` plus `evidence-rules` act as a constitution, but specs aren't tracked after implementation and acceptance criteria aren't tied to tests |

### What hyvemind does that nobody else in the survey does

- **Tree-bound evidence.** "Green" means green for one working-tree hash. A partial run
  or a tree that changed during the gate never counts.
- **Case-level sabotage probes.** A test counts only if breaking its subject makes *that
  case* fail. On a 2,763-file suite, the census matches the original tool exactly.
- **A merge queue with a tree check.** Archon checks CI and the review verdict; only
  hyvemind proves the merged tree equals the gated tree, and bisects a red train.
- **Measured scaffolding**, with the honesty guards learned the hard way: `no-signal`,
  and (in #17) `saturated` and `harmful`.
- **Deference.** `externalGate`, `evidence.status` and `train.via: external` let hyvemind
  sit inside a repo that already has a gate and a release process, without competing.
- **Supply chain.** OIDC publishing with provenance, `pin` with an integrity check and a
  cooling-off period, and a 14-day default.

### What hyvemind should not copy

Ruflo-style agent zoos (98 agents, 314 tools), BMAD-style persona theatre, consensus
protocols between LLM agents, and anything that needs a hosted service to work. Every
measurement so far says that more instruction text only pays when it targets a mistake
the model still makes.

## 3. Proposal

The gaps, ranked by how much each would move hyvemind toward "the whole lifecycle,
unattended, without trusting the agent's word". Each proposal keeps the core rule:
**code decides done.**

### P1. Intake → PR → merge, event-driven (closes F11)

**Borrowed from:** Open SWE, OpenHands automations, Archon's intake and queues.

**Shape:** `hyvemind intake` turns a labelled GitHub issue into a spec draft
(`write-spec`), then waits at a human gate for approval. An approved spec becomes a plan
(`plan-tasks`). `run` executes it in a worktree, then `open-pr` opens the PR with posted
evidence, and the PR is queued for `train`. It ships two ways:
- a GitHub Action, triggered by a label or a comment;
- a local `hyvemind watch` for repos whose gate is local, like the ones this grew out of.

**CI babysitting:**
- `hyvemind ci-watch` re-runs a red CI job **only** when the same test has *passed on the
  same tree* before, which is evidence that it's flaky.
- Otherwise it files the failure against the PR.

That is stricter than Open SWE's rule and fits hyvemind's evidence model.

**Human gates:**
- spec approval, push and merge are always gated;
- "attention items" (Archon) collect the decisions an agent couldn't make.

### P2. Sandboxed `run` (closes F9 and F10; a prerequisite for P1 running unattended)

**Borrowed from:** OpenHands (a container per conversation), Codex (OS sandbox and
execpolicy), Open SWE (a sandbox per thread).

**Shape:** `run --sandbox docker|podman` mounts the task worktree into a container. The
container has no network by default, plus an allowlist (for example the package registry
during install). Each role gets its own tool policy:
- the implementer may edit and run tests, but never push;
- the reviewer is read-only.

Secrets are never mounted. The worktree remains the escape hatch for repos that can't
containerize.

### P3. A repo-task benchmark from your own history (closes F4)

**Borrowed from:** OpenHands benchmarks, mini-swe-agent, Commit0.

**Shape:** `hyvemind bench` picks N merged PRs that added or changed tests. For each one:
1. check out the parent commit;
2. give the agent the PR's title and description as the task;
3. score by running the PR's own new tests, witnessed by a probe, so a trivial pass doesn't count.

The output is pass@k per agent × model. This complements `eval`: `eval` asks whether the
skills help, and `bench` asks whether this agent can do this repo's work. Both re-run when
`refresh-model-catalog` changes the default model.

### P4. Parallel tasks and models per role (closes F2, and F7 at scale)

**Borrowed from:** Superpowers, cc-sdd spec batches, Claude Squad, OpenCode's per-agent models.

**Shape:**
- `run --parallel N` runs plan tasks that share no dependency and no file in separate
  worktrees, then merges them through the same exit-check-and-review rules.
- Roles (`planner`, `implementer`, `reviewer`) each get a model and an effort level.
- Every run report records model, effort, tokens, cost and duration per task.

That record is what P3 and `eval` need to compare cost against lift.

### P5. Specs that stay true (extends F12)

**Borrowed from:** OpenSpec (delta specs, archive), Spec Kit (converge).

**Shape:** `hyvemind converge <spec>` checks that every WHEN/THEN acceptance criterion
maps to a test, and that a probe witnesses each of those tests. A criterion with no
witnessed test is open. On merge, the spec's delta is archived into a living spec.

This is the outer-loop version of what `test-necessity` does for tests, and nobody in the
survey has it: Spec Kit's converge trusts the agent's report.

### P6. Every incident becomes a scenario (extends F5)

**Borrowed from:** Superpowers' transcript diagnosis and the learning claims in Ruflo, but
measured.

**Shape:** `hyvemind lesson "<what went wrong>"` drafts three things from one incident:
- an `evidence-rules` entry;
- an eval scenario that reproduces the mistake;
- a `good`/`bad` example pair that `npm test` lints (#17).

The scenario has to show `no-signal`-free lift before the rule ships. This is how the
saturated skills get harder scenarios without anyone guessing.

### P7. Evals you can trust and compare across models (finishes F1 and F5; #17)

**Borrowed from:** CCPM's with/without benchmarks, plus the statistics they lack.

**Shape:** the #17 items (`saturated`, per-scenario `harmful`, Wilson intervals, cost
preview, a clean profile, kept failure outputs, single-scenario runs), plus
`eval --matrix claude,codex,opencode`, so a skill is retired only when it's saturated on
every model you use.

### P8. ACP and capability detection (deepens F3)

**Borrowed from:** OpenHands' Agent Canvas and cc-sdd.

**Shape:**
- An ACP executor for `run`, `bench` and `eval`: structured events and permission
  requests instead of parsing stdout.
- Skills that check what the host agent can do (sub-agents, background tasks) and fall
  back gracefully.

## 4. Order and ownership

| Release | Contents | Why this order |
|---|---|---|
| 0.4 | P7 (evals, #17), P2 (sandbox), the #17 train and census fixes | Measurement and safety come before autonomy |
| 0.5 | P1 (intake → PR → merge, CI babysitting), P4 (parallel, roles, cost) | The unattended loop, now safe and measured |
| 0.6 | P3 (bench), P5 (converge), P6 (lessons), P8 (ACP) | Compounding: the loop measures and improves itself |

Each feature lands like 0.3.0 did:
- through the merge queue, with tests and self-probes;
- with eval scenarios for any new skill text;
- with a dated report in `docs/evals/` whenever a lift claim changes.
