---
name: live-qualify
description: "Run an application's LLM-powered flows against REAL model vendors with the user's own keys, on a local test stack only, and record what actually happens: pass, app bug, vendor refusal, quota, or contract mismatch. Gives static reviews live evidence. Keys never pass through the agent; failures are recorded, never auto-fixed. Use before claiming an AI feature works, after changing prompts or model versions, or when a grader holds a feature below A for 'never run live'."
---

# Live qualification

Static review can't tell you whether a real model, today, produces output your code
accepts. Live runs find a class of bugs nothing else does: closed parsers that
reject fields the model was never told were forbidden, length limits the prompt
never stated, a model version that changed its output style. This skill runs the
real thing and records the result honestly.

## Hard rules

1. **Keys never pass through you.** The user binds keys in the app's own settings
   or secret store. You refer to them only by name. Never read, print, log, echo or
   paste a key value, not even partly. If a command would print a secret, don't run
   it.
2. **A local test stack only.** Never point a live run at a deployed or production
   environment, and never enable test-only seams on one.
3. **Spend is the user's call.** Before any paid run, state how many calls you'll
   make, with which models and keys, and get a yes. Inventory and dry runs cost
   nothing and need no approval.
4. **Nothing goes outside the stack.** Any step that sends email, posts, pays or
   publishes is stopped at its approval gate or mocked. Record it as "not exercised".
5. **Failures don't fix themselves.** Record them and report them. Ask before you
   fix anything.
6. **Classify honestly.**
   - A vendor refusal or a quota error is **never** a pass, and never an app bug.
   - A failed run is never retried on another key just to get a green result.

## Steps

1. **Inventory (free).** List every flow that calls a model: workflows, agents,
   AI features. Give each one's inputs, its expected output contract, and how it is
   triggered. State the denominator.
2. **Fixtures.** For each flow, build a realistic input from the feature's own
   sample data. Never invent personal data that looks real.
3. **Dry run (free).** Instantiate each flow with a mock or no-op model to catch
   wiring and fixture gaps before spending anything.
4. **Live run (approved).** Run each flow on the user's chosen vendor and models.
   Record for each run: the flow, model, credential *name*, duration, the run's own
   final status, and any output that failed validation.
5. **Classify each result:**

   | Outcome | Meaning |
   |---|---|
   | pass | The app accepted the model's output, and the flow reached its end |
   | app-bug | The app rejected valid output, or crashed (file it) |
   | contract-gap | The model produced what the prompt asked for, but the validator refused it: prompt and schema disagree (see `{{skill:ai-exchange}}`) |
   | vendor-refusal | The vendor declined (safety, policy, unsupported feature) |
   | quota | Rate limit or quota. This says nothing about the app |
   | not-exercised | Stopped at an external side effect, by design |

6. **Tracker.** Keep `docs/LIVE-QUALIFICATION.md`:
   - a summary;
   - one results table per run, newest first, dated, with the models used;
   - open failures;
   - flows not yet qualified.

   Re-runs add to it; they never start it over.
7. **Report.** For example: "qualified N of M flows on <model> (<date>)", the
   failures by class, and what has still never run live.
