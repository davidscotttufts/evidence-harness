---
name: mine-skills
description: "Mine Claude Code session transcripts for how skills are actually used: frequency, and the chains run by hand again and again (A → B → C). Proposes composite skills for repeated chains and new skills for repeated manual work, each backed by counts and confidence. Local and read-only; asks before each run and reports aggregates only, never transcript content."
---

# Skill miner

Proposals come from your history, not from guesses. Each one cites how many times the
pattern actually happened.

## 1. Mine (local, read-only, asked first)

Transcripts hold whole sessions, including anything ever pasted into them: keys,
customer data, private code. `{{cli}} mine` reads the JSONL files under
`~/.claude/projects` on this machine and makes no network calls.

- ⛔ Ask the user before **each** run, naming the scope (this project or `--all`).
- Report aggregates only: skill names, counts, chains, session ids. Never quote,
  summarise or paste transcript content, in the report or in chat, and don't name
  what a session contained, not even to say it was left out: an example is its session
  id and the step order. To understand a manual step, describe its shape ("edits the
  changelog, then tags"), not its text.

```bash
{{cli}} mine                 # sessions of this project (and its worktrees)
{{cli}} mine --all           # every project under ~/.claude/projects
{{cli}} mine --json > mine.json
```

The output has top skills, bigram chains with **confidence** (how often A is
immediately followed by B, out of all runs of A), trigrams, and recent session
sequences. Installed bee skills are counted under their unprefixed names.

## 2. Find proposals

- **Composite skill:** a chain with count ≥ 5 and confidence ≥ 0.5. Package it as one
  skill that **calls the existing skills in order** with gates between them, like
  `{{skill:ship-change}}` does. Never copy their content into it.
- **New skill:** the same manual multi-step work repeated across sessions with no
  skill behind it (look at recent sequences and at what happens between skill calls).
- **Retire signal:** a skill nobody has run in 60+ days. Check it with
  `{{skill:skill-eval}}` before proposing removal.

## 3. Report

A table per proposal: the pattern, count, confidence, example session ids, and the
proposed skill name and steps. Write it to `SKILL_MINING_REPORT.md`, or to the user if they
prefer.

## 4. Scaffold (only when asked)

⛔ Ask before writing files. A new skill gets `SKILL.md` with a precise description
(the description decides when an agent loads it) and at least one eval scenario
(`{{skill:skill-eval}}`). That way its value is measured from day one.
