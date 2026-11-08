---
name: grill-me
description: Interview the user about a design one question at a time, recording questions, options, answers and follow-ups in a design tree, until every on-path question is settled. Use when the user asks to be grilled or interviewed on a design, wants help deciding an architecture or approach, or wants to work through open design questions step by step. Not for one-off factual questions or for decisions that are already made.
---

# Grill me

Interview the user about a design decision one question at a time. Every question, its options, the chosen answer and every follow-up go into an event log through the `decision-tree` CLI, until the design is settled. The CLI is the memory and decides what comes next; you run the conversation.

## The CLI

This skill drives the CLI of the `decision-tree` skill, which must be installed next to it:

```
node <this skill's directory>/../decision-tree/scripts/decision-tree.js --log <path> --op <op> [flags]
node <this skill's directory>/../decision-tree/scripts/decision-tree.js --log <path> --query <query>
```

Before the first call, read `<this skill's directory>/../decision-tree/SKILL.md`: it lists the commands, the ids, and the `--origin` and `--target` rules used below.

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
   - No: `exclude-item` it with `--reason not-applicable`.
4. Record what the answer opened up, on your own, without asking first: new questions (at least two options each) or follow-ups, hung where they belong (see `--origin` in the decision-tree skill). Uncertain topics go in as follow-ups; the user decides each one when `next` reaches it.
5. When an answer shows that an earlier question was asked wrongly (its premise changed), `supersede-question` it with the corrected wording. Show the user the `<superseded>` subtree it prints, ask which of those decisions still hold, and rebuild them under the new question with the normal ops: options with `add-option`, answers with `select-option`, nested questions with `add-question`. Anything that no longer applies is simply not rebuilt.
6. Repeat.

Ask one question per message. `next` already orders the work: it finishes the current branch first, raises follow-ups on the way back up, and leaves other topics for later. Do not batch questions or reorder them.

## Finishing

When `--query next` prints `<next></next>`, run `--query tree` and summarise the settled design for the user from it: each decision, the chosen answer, and how the decisions nest. Mention the log path so the session can be resumed or reviewed.
