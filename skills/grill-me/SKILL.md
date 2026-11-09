---
name: grill-me
description: Interview the user about a design one question at a time, recording every question, option, decision and open topic in a decision tree, until the design is settled. Use whenever the user asks to be grilled or interviewed, wants to pressure-test a plan, poke holes in it, find what they're missing, decide an architecture or approach, work through open design questions, or pick an earlier grilling session back up, even if they don't say "interview". Not for one-off factual questions or decisions already made.
---

# Grill me

An interview that turns a loose idea into a settled design the user decided. That comes first; within it, spend as little of the user's effort as possible. You find what needs deciding, look things up and lay out the choice. The user decides. The tree remembers and sets the order.

Where a case isn't covered here, the reasons given decide it.

## The tree

Before the first call, read `<this skill's directory>/../decision-tree/SKILL.md`. It covers the commands, where items hang, and what each situation does to the tree, none of which is repeated here. The CLI is at `<this skill's directory>/../decision-tree/scripts/decision-tree.js`.

- Keep one log per design at `.grill-me/<topic>.jsonl` in the project root. List `.grill-me/` to find earlier sessions, and call with the same path to resume one.
- Refer to items by id, so "reopen Q3" means the same thing all session.
- Read whatever you show about the state from the CLI's output, not from memory, so the two can't drift apart.
- The tree keeps decisions, not facts. Look facts up again on resume.

## Who supplies what

| Kind | Supplied by | How |
|---|---|---|
| **Fact**: true of the code, config or docs | you | looked up, never asked |
| **User-only fact**: budget, traffic, deadlines, team skills | the user | asked, never guessed |
| **Decision**: what the design should be | the user | asked, never answered for them |

A guessed user-only fact anchors the answer, so ask it before the decisions that depend on it. What a lookup finds is a recommendation and not a decision, because existing code shows past choices rather than wanted ones.

Mark every fact you show as `(checked: <source>)` or `(inferred: <basis>)`, so the user can tell them apart before deciding.

## Starting

Seed the tree from what the user has already said: one root question per independent topic, each with at least one real option to react to, and a follow-up for anything not ready for options. Add the blockers, risks and irreversible choices first, because roots come up in the order they were added. Keep adding as you learn.

## Each turn

Run `--query next` and ask exactly what it returns. Ask one question and nothing else, because a single question gets a considered answer and several get skimmed. Then wait.

```
*Recorded:* **Q4a** Launch date: end of March

---

**Q5 · Token storage**: Where should refresh tokens live?

*Context:* auth already issues JWTs (checked: `src/auth.ts:42`)

- **a) httpOnly cookie**: survives reloads; needs CSRF protection
- **b) In memory, with silent refresh**: lost on a hard reload; no CSRF exposure

→ **a**, because surviving reloads outweighs a one-time CSRF setup
```

- **Recorded** states what the last reply settled, never a bare "yes". The first turn has none.
- **The header** has the id and a title that names the subject on its own.
- **Context** holds only the facts this decision rests on.

**The question.** Ask only if the answer changes the design; anything else becomes a follow-up or is excluded. Give an abstract question a concrete example, such as a command and its output. Use the user's terms and real identifiers. When a question is truly binary, or only one option is viable, word it so "yes" accepts the recommendation.

**The options.** List only ones you wouldn't rule out, because padding makes the recommendation look obvious. Go from the simplest up, compare each on the same factors in the same order, and add no extra scope. Say the user may answer in their own words.

**The recommendation.** Lean to the least that serves, and name the weighing so the user can disagree with it. Its firmness depends on who knows more:

| The deciding factor is | Recommendation |
|---|---|
| a fact | firm: `→ **a**, because X outweighs Y` |
| the user's priority | conditional: `→ **a** if X matters more to you, **b** if Y does` |
| a user-only fact still unknown | none; ask the fact first |

**A follow-up** is first a question of whether it's worth deciding. If yes, `promote-follow-up` it with at least one option you draft. If no, `exclude` it.

## Reading replies

| The user | Do |
|---|---|
| picks one or more options | `select-option` them in one call |
| answers in their own words | `add-option` the answer, then select it |
| says "yes" | select the recommendation |
| says "no" | select the alternative, asking for one only if it isn't clear |
| thinks out loud ("what if…?") | record nothing and keep discussing the same question |
| replies in a way that matches no option | record nothing until it's clarified |
| asks a side question | answer it, then ask the same question again |
| isn't ready to decide | `exclude --reason deferred` with what's blocking them as `--note` |
| says it doesn't belong to this design | `exclude`: `deferred` if wanted later or out of scope, `not-applicable` if it doesn't matter, with their reason as `--note` |
| says "wrap up" or "good enough" | `exclude --reason deferred` what `--query items` still lists, then finish |

Record what a reply opened up without asking first, because an addition costs nothing to undo. Put uncertain topics in as follow-ups. Each point the user raises ends up recorded, so nothing they said is lost.

Removal is different, because it takes everything underneath. When you exclude something, say what goes with it, and confirm first if the user didn't ask for it.

## When the design shifts

- **A changed answer.** Reply with only what changed and what it reopens: "changing Q5 reopens Q8".
- **A premise changed.** Superseding can't be undone, so confirm first, because everything under the question was decided on the old premise. Show the `<superseded>` subtree, ask which decisions still hold, including whether a rejected option is now the better fit, and rebuild those under the new question.
- **Back again.** `restore` what the user wants to revisit.
- **"Let's settle X first."** `focus` it.
- **Resuming.** Look the facts up again and ask the next question with its trail, so it isn't asked cold.

## Pace

- A format request ("shorter") holds for the rest of the session, and terse replies get terse turns.
- When the user tires, offer a pause. Don't lean harder on your recommendations, because low attention is when unexamined decisions pile up.
- The goal is a settled design, not an exhaustive one. When what's left no longer changes what gets built next, offer to defer it.

## Finishing

When `--query next` prints `<next></next>`, run `--query status` and summarise from it, in this order: the deferred items, because they are what the user still acts on; then each decision and its answer, nested under the answer that led to it; then the log path. Ask the user to confirm or correct by id.

Build nothing on the design until they confirm. An empty tree is the cue to confirm, not permission to start.
