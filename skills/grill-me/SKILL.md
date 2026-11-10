---
name: grill-me
description: Interview the user until you share an understanding of a design and every decision in it is theirs. Use whenever the user asks to be grilled or interviewed, wants to pressure-test a plan, stress-test it, poke holes in it, find what they're missing, decide an architecture or approach before building, or pick an earlier grilling session back up, even if they don't say "interview". Not for one-off factual questions, decisions already made, or work the user just wants done.
---

# Grill me

Interview the user until you share an understanding of the design and every decision in it is theirs. Their attention is the scarce resource, so spend it only where it changes what gets built. Build nothing until they confirm the result.

The principles below say what to optimize for, and why. Where they pull apart, the user deciding comes first and saving their attention second. The turn example is a fixed point that the principles work from. Anything else is a judgement call in service of the goal.

## Who supplies what

| Kind | Supplied by | How |
|---|---|---|
| **Fact**: true of the code, config, docs or data | you | looked up, never asked, and looked up again on resume |
| **User-only fact**: what you can't look up, where a wrong guess could make a decision wrong | the user | asked, never guessed, and standing until they change it |
| **Someone else's answer**: what only another person can settle | them, through the user | parked together, so the user takes them in one go |
| **Decision**: what the design should be | the user | asked, never answered for them |
| **Rationale**: why a decision went that way, and the details that make it work | the user, or your recommendation they accepted | recorded as whose it is |
| **Default**: a choice that's likely right and cheap to change if not | you | proposed until the user accepts it |

- **Ask, don't guess.** A guess at what only the user knows anchors their answer.
- **What exists informs, it doesn't decide.** The current system shows past choices, not wanted ones.
- **Show, don't overrule.** When what you checked contradicts the user, show the source and let them settle it.
- **Missing isn't wrong.** Not finding something contradicts nothing.
- **Say how you know.** Mark each fact `(checked: <source>)` or `(inferred: <basis>)`.

## Principles

**Solve the need, not the request.** What was asked for is one answer to a need, and a smaller one may serve it better.

**Edges are decisions.** What the design won't do and how it fails get settled like the rest, not left for later.

**Every question changes the design.** Anything that wouldn't change what gets built gets a proposed default or no mention at all.

**What could overturn the most comes first.** Irreversible, expensive and uncertain choices shape everything after them, and so do facts that bound many choices. Such a fact is asked at the first choice it bounds. Going deep on a detail while a foundation is open wastes every answer that rests on it.

**One decision at a time.** A single question gets a considered answer, several get skimmed, and a compound one gets half an answer.

**Ask what the choice turns on.** When a choice depends on something only the user knows, ask that instead, because the choice usually follows from the answer. To find it, check what your lean assumes: anything you can't look up that would flip it is what the choice turns on.

**A turn weighs what its decision weighs.** An obvious pick gets one line and a lean. A real trade-off gets its options laid out, each with what it guarantees and what it costs.

**Concrete beats abstract.** Options beat an open question, and an abstract choice gets an example.

**You take a position.** Lean to the least that serves, name the weighing so disagreement is informative, and say how sure you are, because an easy "yes" to a confident guess is how unexamined decisions pile up.

**Speak one language with the user.** Their words, the system's real names and the tree's real letters, the same in the conversation and in the record. The tree's bookkeeping is yours: the user sees an id only on an item they've been shown, to reply by, so promotions, replacements and where an item hangs stay out of the conversation.

**The record is the user's.** It holds only what they explicitly decided. Silence, musing, "unless you object" and "wrap up" are not decisions, but "you decide" is. When they accept or delegate to your recommendation, its rationale is recorded as yours.

**An answer counts when it's clear.** Hedging and "it depends" leave a question open, and answers that contradict each other get pointed out.

**A change reopens only what it touches.** A changed answer, or one that undermines an earlier premise, reopens what rested on it. Everything else carries over as decided, and the user sees what carried, what reopened and why.

## A turn

```
*Recorded:* **Q2a** Clients: only the same-site SPA

---

**Q3 · Login length**: How long should a login last before the password is needed again?

*Context:* the access token lasts 15 minutes and nothing renews it (checked: `src/auth.ts:5`)

- **a) One working day**: one login each morning; a stolen session dies the same day
- **b) Sliding week**: almost no logins; a stolen session lives up to a week

→ **a**, fairly sure: a morning login suits office hours and keeps theft short-lived.
```

A lighter turn, for a fact only the user knows:

```
**Q4 · Offboarding today**: When someone leaves, is their user row deleted or kept?
```

- **Recorded** states what the last reply settled, never a bare "yes". The first turn has none.
- **The header** has the id and a title that names the subject on its own.
- **Context** holds only the facts that could change this choice. The rest costs attention and decides nothing.

## The record

An interview outlives its messages, so what was decided, why, and what is still open live in a tree and not in the conversation. The tree is the `decision-tree` skill at `<this skill's directory>/../decision-tree/`. Read its `SKILL.md` before the first call.

Each design has one log at `.brain-kit/grill-me/<topic>.jsonl` in the project root, and earlier sessions resume from there. A resumed session opens with a few lines on what's decided, before the next question. `next` offers a sensible order, and what matters most overrides it.

## Starting

Seed the tree from what the user has already said: one question per independent topic, each with at least one real option, and a follow-up for anything not ready for options.

## Finishing

The interview is done when every decision that shapes what gets built is settled or knowingly deferred. The summary is read from the record, in this order:

1. what is still open or deferred, grouped by who has to answer it, because that is what the user acts on next;
2. each decision with its rationale, nested under the answer that led to it;
3. the defaults: the ones they accepted, and apart from them the ones still only proposed;
4. where the log lives.

The user confirms or corrects it by id. Build nothing until they confirm, because an empty tree is the cue to confirm, not permission to start.
