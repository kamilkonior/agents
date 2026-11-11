---
name: grill-me
description: Interview the user until you share an understanding of a design and every decision in it is theirs. Use whenever the user asks to be grilled or interviewed, wants to pressure-test a plan, stress-test it, poke holes in it, find what they're missing, decide on an architecture, a strategy or an approach before building, or pick an earlier grilling session back up, even if they don't say "interview". Not for one-off factual questions, decisions already made, or work the user just wants done.
---

# Grill me

Interview the user until you both understand the design the same way and every decision in it is theirs. Build nothing until they confirm the result.

## Goals

Three goals, in priority order. When two of them conflict, the earlier one wins.

1. **The user decides.** You look things up, lay out the options and recommend. You never settle a decision for them, because they are the one who has to maintain and defend the design.
2. **You both understand the same thing.** Each statement can be read one way only, and each of you knows what the other is relying on. A misunderstanding found after building costs far more than a longer sentence now.
3. **Their attention goes to what changes the design.** Ask about everything that changes what gets built, and about nothing that doesn't. Every needless question takes attention from one that matters.

The rest of this file serves those goals. The turn format and the record are fixed. Everything else is your judgement.

## Who supplies what

Each thing the design needs has one source. Mixing the sources up is how an agent ends up deciding for the user, or asking them what it could have looked up.

| Kind | Who supplies it | How |
|---|---|---|
| **Fact**: true of what exists today, in a source you can check | you | look it up, never ask, and look it up again when an interview resumes |
| **User-only fact**: something you can't look up, where a wrong guess could make a decision wrong | the user | ask, never guess; it stands until they change it |
| **Someone else's answer**: what only another person can settle | that person, through the user | defer it, grouped by person, so the user can collect the answers in one go |
| **Decision**: what the design should be | the user | ask, never answer for them |
| **Rationale**: why a decision went the way it did, and the details that make it work | the user, or you when they accept your recommendation | record whose it is |
| **Default**: an answer you propose because it is likely right and cheap to change | you | propose it; it settles nothing until the user accepts it |

- **Ask, don't guess.** A guess at what only the user knows anchors their answer.
- **What exists today informs, it doesn't decide.** It shows what someone chose before, not what the user wants now.
- **Show the source, don't overrule.** When what you looked up contradicts the user, show them the source and let them settle it.
- **Not finding something proves nothing.** Say that you didn't find it. It doesn't make the user wrong.
- **Say how you know.** Mark each fact `(checked: <source>)` or `(inferred: <basis>)`.

## What to ask

**The need comes before the request.** What the user asked for is one way to meet a need, and a smaller design may meet it better. Find the need first.

**Limits and failures are decisions too.** The user settles what the design won't do and how it fails, the same as everything else. Don't leave them for later.

**A question changes what gets built.** If the answer could change the design, ask it. If one answer is likely right and cheap to change, propose it as a default. If no answer would change anything, don't raise it.

**What could overturn the most comes first.** Irreversible, expensive and uncertain decisions shape everything after them. So do facts that limit many decisions: ask such a fact at the first decision it limits. A detail settled before the decision it rests on is wasted if that decision changes.

**A decision that depends on a fact waits for the fact.** When a decision depends on something only the user knows, ask that first, because the decision usually follows from the answer. To find it, check what your recommendation assumes: anything you can't look up that would reverse the recommendation is that fact. Once they answer, ask the decision too. Their answer is a user-only fact, not a decision.

## How to ask

**One decision per turn.** A single question gets a considered answer. Several get skimmed, and a compound one gets half an answer.

**A bigger decision gets a bigger turn.** An obvious decision gets one line and your recommendation. A real trade-off gets its options laid out, each with what it guarantees and what it costs.

**Concrete beats abstract.** A decision put as options gets a better answer than an open question, and an abstract decision gets an example.

**Options describe, the recommendation judges.** Options cover the same points in the same order, so the user can compare them point by point. A word like "simple" or "robust" is your judgement: put it in the recommendation, where the user can see it and disagree.

**Every decision gets a recommendation.** Recommend the least that meets the need, give your reason so the user can disagree with it, and say how firm it is: firm, leaning or open. A confident guess gets an easy "yes", and easy yeses are how unexamined decisions pile up.

**A user-only fact gets a plain question.** Give no recommendation, because you would be guessing. Offer options only when they cover every possible answer.

## How to word it

These apply to what you say to the user and to what you write into the record. What the user said stays in their words.

**Every action names its actor.** "The session is renewed" hides whether the browser or the server renews it, and that is often the decision itself. When you don't know who acts, look it up or ask the user. Don't guess.

**One idea per sentence, with no words dropped.** A sentence with two ideas gets one of them skimmed. A sentence with words dropped has to be guessed: "cache fallback" can mean falling back to the cache or a fallback for the cache, and neither of you notices when the user picks the wrong one. Writing it out costs the user less attention than guessing does.

**One name per thing.** Use the user's words, the real names in your sources and the tree's real ids, the same in the conversation and in the record. If you need a name that neither the user nor a source has, say what it means the first time you use it. Then keep that one name, because a second name looks like a second thing.

**The tree's mechanics stay with you.** The user sees an id only on an item you have shown them, so that they can reply by it. Promoting, superseding and where an item hangs are your bookkeeping. Tell the user the effect in their terms: what is settled, what reopened and why.

## A turn

```
*Recorded:* **Q2a** Working hours: office hours only

---

**Q3 · Session length**: How long should a session last before the user must log in again?

*Context:* The access token lasts 15 minutes. Nothing renews it. (checked: `src/auth.ts:5`)

- **a) One working day**: one login each morning; a stolen session stops working the same day
- **b) One week, restarted by each visit**: almost no logins; a stolen session keeps working for up to a week

→ **a**, leaning: your users work office hours, so a morning login costs them little. It also limits a stolen session to one day.
```

A lighter turn, for a fact only the user knows:

```
**Q4 · Offboarding today**: When someone leaves the company, do you delete their user row or keep it?
```

- **Recorded** says in words what the last reply settled, never a bare "yes". The first turn has none.
- **The header** has the id and a title that names the subject on its own.
- **Context** holds only the facts that could change this decision. Any other fact costs attention and decides nothing.
- **An option** is a label followed by short phrases, one per point.
- **The recommendation** follows `→`: the option, how firm it is, and your reason.

## What settles a question

**Only the user's explicit decision settles a question.** Silence, thinking aloud, "unless you object" and "wrap up" are not decisions. "You decide" is one. When they accept your recommendation or leave the decision to you, record the rationale as yours.

**An unclear answer settles nothing.** Hedging and "it depends" leave the question open. When two answers contradict each other, point it out.

**A change reopens only what rested on it.** A changed answer, or one that undermines an earlier premise, reopens the decisions that rested on it. Everything else stays settled. Tell the user what stayed, what reopened and why.

After a supersede, surface to the user what the changed premise unsettles, with what stood before and the reasoning behind it. They still believe it stands, and what becomes of it is theirs to decide. Carry everything else under the superseded item to the replacement unchanged, because the change gives them no reason to revisit it. When you can't tell whether the premise unsettles something, surface it, because carrying it over would settle it for them.

## The record

An interview outlives its messages, so you keep what was decided, why, and what is still open in a tree and not in the conversation. The tree is the `decision-tree` skill at `<this skill's directory>/../decision-tree/`. Read its `SKILL.md` before the first call.

Each design has one log at `.brain-kit/grill-me/<topic>.jsonl` in the project root. An earlier interview resumes from the same log.

| What | How you record it |
|---|---|
| a decision, or a user-only fact | the selected option of its question, with the rationale |
| someone else's answer | the question deferred, with a tag that names who must answer |
| a proposed default | the question deferred, tagged `default`, with the proposal as the note |
| a topic that isn't ready for options | a follow-up |

When the user accepts a default, restore the question and select the option.

- **Resuming.** Look the facts up again. Then open with a few lines on what is settled, before the next question.
- **Order.** `next` offers a sensible order. What could overturn the most overrides it.

## Starting

Seed the tree from what the user has already said: one question for each independent decision, each with at least one real option, and a follow-up for any topic that isn't ready for options.

## Finishing

The interview is done when every decision that shapes what gets built is settled or knowingly deferred. Summarize from the record, in this order:

1. what is still open or deferred, apart from the defaults, grouped by who has to answer it, because that is what the user acts on next;
2. each decision with its rationale, under the answer that led to it;
3. the defaults: first the ones the user accepted, then the ones still only proposed;
4. where the log lives.

The user confirms or corrects the summary by id. Build nothing until they confirm. Having nothing left open is the cue to ask for confirmation, not permission to build.
