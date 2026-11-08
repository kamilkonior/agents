---
name: decision-tree
description: A CLI that records decisions as a tree in an append-only event log, with questions, options, answers and follow-ups, and says what to decide next. Use when a skill or task needs a persistent, resumable record of open and settled decisions, such as an interview, a design review or a planning session. Other skills call this CLI instead of keeping decisions in conversation text.
---

# Decision tree

A memory for decisions. Each question, its options, the chosen answer and every follow-up go into an event log. The CLI validates every write, keeps the tree in order and answers two queries: what to decide next, and what has been settled. It stores and orders the tree; how to run the conversation belongs to the skill that calls it.

## The CLI

```
node <this skill's directory>/scripts/decision-tree.js --log <path> --op <op> [flags]
node <this skill's directory>/scripts/decision-tree.js --log <path> --query <query>
```

Requires Node 20+. Every call needs `--log`. Results print as XML on stdout; errors print as one line on stderr with exit code 1 and write nothing.

| Command | Does |
|---|---|
| `--op add-question --text T --option A --option B [--origin ID]` | adds a question with at least two options; prints `<question>` |
| `--op add-option --origin QID --text T` | adds one more option to a question |
| `--op select-option --target OID` | answers a question; a later selection replaces an earlier one |
| `--op add-follow-up --text T [--origin ID]` | records a candidate topic that isn't ready to be a question |
| `--op promote-follow-up --target FID --option A --option B` | turns a follow-up into a question under it |
| `--op exclude-item --target ID --reason R` | takes a question, option or follow-up and everything under it out of the tree; `R` is `not-applicable`, or `deferred` to keep it as out of scope for later |
| `--op restore-item --target ID` | brings an excluded item back with everything under it; an item hidden only by an excluded ancestor cannot be restored on its own |
| `--op supersede-question --target QID --text T` | replaces a question with a reworded one in its place, without options; the old question and everything under it leave the tree and are frozen: ops on them fail; prints `<supersede>` with the new question and the old subtree, listing every option with the chosen one marked, as context for rebuilding what still holds |
| `--op focus-item --target ID` | puts a question or follow-up at the head of `next`: its subtree is worked through first; only the latest focus counts, it ends for good once its subtree has no open items, moves to the replacement when its question is superseded, and ends when it is excluded |
| `--query next` | the one thing to decide now: `<next>` with a `<question>` or a `<follow-up>`, or an empty `<next></next>` when done |
| `--query tree` | the settled tree: answers on the chosen path, open questions with their options, then a `<deferred>` section listing items excluded as `deferred`, each with where it hung |

Ids: questions are `Q1`, `Q2`…; options are their question's id plus a letter (`Q1a`, `Q1b`…); follow-ups are `F1`, `F2`….

`--origin` says where something hangs:
- under an **option** when it only matters because that option was chosen;
- under a **question** when it matters whatever the answer is;
- under a **follow-up** when it only matters if that follow-up is pursued;
- no origin for a root: a question or follow-up that depends on nothing else in the tree.

`--target` names the existing item an op acts on.

`next` orders the work: it finishes the current branch first, raises follow-ups on the way back up, and leaves other topics for later. A focus, while active, comes before all of that.

## The log

One log holds one tree, which can have any number of root questions. It is a `.jsonl` file at a path the calling skill chooses, and calling the CLI again with the same path resumes it. Never edit a log by hand: it is the source of truth, and the tree is rebuilt from it on every call.
