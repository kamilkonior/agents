---
name: grill-me
description: Interview the user about a design one question at a time, recording questions, options, answers and follow-ups in a design tree, until every on-path question is settled. Use when the user asks to be grilled or interviewed on a design, wants help deciding an architecture or approach, or wants to work through open design questions step by step. Not for one-off factual questions or for decisions that are already made.
---

# Grill me

Interview the user about a design decision one question at a time. Every question, its options, the chosen answer and every follow-up go into an event log through the `designtree` CLI, until the design is settled. The CLI is the memory and decides what comes next; you run the conversation.

## The CLI

```
node <this skill's directory>/scripts/designtree.js --log <path> --op <op> [flags]
node <this skill's directory>/scripts/designtree.js --log <path> --query <query>
```

Requires Node 20+. Every call needs `--log`. Results print as XML on stdout; errors print as one line on stderr with exit code 1 and write nothing.

| Command | Does |
|---|---|
| `--op add-question --text T --option A --option B [--origin ID]` | adds a question with at least two options; prints `<question>` |
| `--op add-option --origin QID --text T` | adds one more option to a question |
| `--op select-option --target OID` | answers a question; a later selection replaces an earlier one |
| `--op add-follow-up --text T [--origin ID]` | records a candidate topic that isn't ready to be a question |
| `--op promote-follow-up --target FID --option A --option B` | turns a follow-up into a question under it |
| `--op dismiss-follow-up --target FID` | drops a follow-up and everything under it |
| `--query next` | the one thing to ask now: `<next>` with a `<question>` or a `<follow-up>`, or an empty `<next></next>` when done |
| `--query tree` | the settled design: answers on the chosen path, open questions with their options |

Ids: questions are `Q1`, `Q2`…; options are their question's id plus a letter (`Q1a`, `Q1b`…); follow-ups are `F1`, `F2`….

`--origin` says where something hangs:
- under an **option** when it only matters because that option was chosen;
- under a **question** when it matters whatever the answer is;
- under a **follow-up** when it only matters if that follow-up is pursued;
- no origin for a question or follow-up about the design as a whole.

`--target` names the existing item an op acts on.

## The session log

Use one log per session: `.grill-me/<topic>.jsonl` in the project root, where `<topic>` is a short slug for what is being designed (for example `.grill-me/event-storage.jsonl`). To resume a session, call the CLI with the same path; list `.grill-me/` to find earlier sessions. Never mix two designs in one log.

## Starting

1. Pick the log path from what the user wants to design.
2. Seed the tree with what is already clear from the user's description: one root question per independent topic, each with at least two real options. Anything worth raising but not ready for options becomes a follow-up.
3. Keep seeding as you learn: new topics become new roots or follow-ups during the session.

## Each turn

1. Run `--query next`.
2. If it is a **question**, ask the user exactly that question with its options, and nothing else in the same message. Show the options as a short list the user can pick from, and say they may answer in their own words.
   - The user picks an option: `select-option` it.
   - The user answers with something not listed: `add-option` with their answer, then `select-option` it.
   - The user isn't ready to decide: leave the question open and record what is blocking them as a follow-up under it.
3. If it is a **follow-up**, ask the user whether it is worth deciding.
   - Yes: `promote-follow-up` it with at least two options you draft.
   - No: `dismiss-follow-up` it.
4. Record what the answer opened up, on your own, without asking first: new questions (at least two options each) or follow-ups, hung where they belong (see `--origin` above). Uncertain topics go in as follow-ups; the user decides each one when `next` reaches it.
5. Repeat.

Ask one question per message. `next` already orders the work: it finishes the current branch first, raises follow-ups on the way back up, and leaves other topics for later. Do not batch questions or reorder them.

## Finishing

When `--query next` prints `<next></next>`, run `--query tree` and summarise the settled design for the user from it: each decision, the chosen answer, and how the decisions nest. Mention the log path so the session can be resumed or reviewed.
