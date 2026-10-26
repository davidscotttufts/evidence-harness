---
name: ai-exchange
description: "Grade every place an application talks to an LLM, A–F, on the quality of information exchange: can the model get the schemas it must conform to at runtime, are those schemas generated from the single source of truth (not hand-copied into prompts), can it read the state it is changing, is it sent only the data it needs within a bounded context, is its output validated with a bounded repair loop, and is anything durable gated. Classifies each call as tool-mediated, prompt-stuffed or blind. Use when auditing AI features, agents, LLM-calling code, or prompt↔schema drift."
---

# AI exchange audit

Some code depends on what a model returns. It only works if the model can **ask**
for the shapes it must produce, **read** what it is about to change, and have its
output **validated and repaired** against the same source of truth the code uses.
A model fed a hand-copied schema, whose output is parsed by hope, is a **blind
interaction**: it guesses, the copy drifts, and failures look like success.

## 1. Inventory every model call

Search for every place a model is invoked: SDK clients (`anthropic`, `openai`,
`generateText`, `chat.completions`, `messages.create`), agent and tool
definitions, prompt files (`prompts/`, `*.prompt.md`, template strings with
"You are"), structured-output helpers, and any `JSON.parse` of a completion.
**State the denominator** ("graded 14 of 14 call sites").

## 2. Classify each call's grounding pattern

| Pattern | What it looks like | Ceiling |
|---|---|---|
| **Tool-mediated** | Schemas and current state come from the live source at call time (a catalog or read tool, or a schema generated from the type/validator). Output is validated, and a repair loop is in place | A+ |
| **Prompt-stuffed** | The schema or catalog is static text inside the prompt. It may be accurate today, but nothing keeps it in sync | C |
| **Blind** | A free-text prompt, no declared output contract, output parsed with regex or `JSON.parse` and used | D/F |

The defect in a prompt-stuffed call is **the copy itself**, not its content.
Accurate hand-copied schemas still drift.

## 3. Grade A–F on these dimensions

| Dimension | A looks like |
|---|---|
| Schema discoverability | The model can obtain the schemas it must match at runtime (tool or generated injection), not only from prose |
| Single source of truth | Every schema string the model sees is generated from the same validator or type the code checks with, or a test pins the two together |
| State readability | The model reads current state before writing, with no blind overwrites |
| Output contract | A declared schema is validated (closed-world) before anything is applied |
| Repair loop | Validation errors go back to the model for **one bounded** retry. Invalid output is a **typed failure**, never success-with-empty or a placeholder |
| Apply safety | Output reaches durable state only through validation, a human gate, or both |
| Tool honesty | Every tool the prompt promises is actually available, and none is available that the prompt never explains |
| Data minimisation | The model gets only the fields the task needs, read through the governed surface that applies privacy filtering. Count fields sent vs needed |
| Context economy | Context is bounded: a slice, not the whole document, when a slice suffices. Measured per call (tokens or characters), not assumed |

The scale:

- **A+**: tool-mediated, runtime schemas from the source of truth, state read
  before writing, validated output, repair loop, gated apply.
- **B**: grounded, but one of those is missing.
- **C**: prompt-stuffed.
- **D**: blind, with some parse guard.
- **F**: blind on a call that **writes state**, or a prompt copy that has
  **already drifted**. Cite the diff.

Back every grade with evidence from **both sides**: the code-side source (validator,
type, file:line) and the model-side entry (prompt file:line, tool list), or proof
that one of them is missing.

## 4. The checks that most often find real defects

- `catch { return {} }`, `?? []`, or `|| defaultValue` after parsing model output. That is
  **success-with-empty**: the caller cannot tell the model failed.
- Schema text in a prompt that differs from the validator. Diff them, never eyeball.
- A "repair" loop that retries without passing the errors back.
- **Absence scans.** Search for the checks that should exist and don't: output used
  with no validator, a repair loop with no bound, an apply with no approval step, a
  raw record sent where a filtered read exists. An absence is a finding: cite the
  empty search, and show the same search hits where the check does exist.

## 5. Report

Write a tracker (for example `docs/AI-EXCHANGE.md`):
- one section per call site: pattern, grade, evidence, gaps;
- an ordered path to A+;
- a changelog.

Re-runs update the tracker; they never start it over. For each gap you fix, add a
test that pins the prompt schema to the validator, so the drift cannot come back
(`{{skill:test-necessity}}` can show that the test fails when the two diverge).
