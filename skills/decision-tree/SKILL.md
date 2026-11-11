---
name: decision-tree
description: Persistent memory for decisions. Records questions, options, selections, reasons and follow-ups as a tree in an append-only log, and answers what is open next and what is already settled. Use it whenever decisions should outlive the conversation or be worked through in order, such as an interview, a design review, a planning session or a long list of open questions, even if the user only says "keep track of this" or "where were we?". Other skills can build on it.
---

# Decision tree

A memory for decisions. The CLI stores a tree, validates every write and reports what is open. It has no opinion on how the tree is used.

## Running it

```
node <this skill's directory>/scripts/decision-tree.js --log <path> --op <op> [flags]
node <this skill's directory>/scripts/decision-tree.js --log <path> --query <query> [flags]
```

Requires Node 20+. `DECISION_TREE_LOG` can stand in for `--log`, which wins if both are set. In zsh, a command kept in a variable isn't split into words, so `$CLI --op …` fails; a shell function works.

A log is a `.jsonl` file holding one tree with any number of roots. The same path resumes it, several agents can share it, and the tree is rebuilt from it on every call, so a hand edit can corrupt it. Change it only through the CLI.

Results are XML on stdout. A failed call prints one line on stderr, exits 1 and writes nothing. The item it names is the one to act on: `Q2 is off-path, hidden by Q1b` means select `Q1b` first.

## The tree

| Item | Id | What it is |
|---|---|---|
| question | `Q1` | Something to decide. Settled once options are selected. |
| option | `Q1a` | A possible answer, up to 26 per question. |
| follow-up | `F1` | A topic that isn't a question yet. It holds no options until promoted. |

Ids are never reused, so excluding an option leaves a gap in the letters. `--target` names an existing item, and `--origin` says where a new one hangs.

### Origin

`--origin` sets when an item comes up and what it disappears with. The CLI accepts any valid origin and can't tell when one is wrong.

| Origin | The item |
|---|---|
| an option | is on the path only while that option is selected |
| a question | is on the path whatever the selection is |
| a follow-up | is on the path once that follow-up is promoted |
| none | is a root |

### States

| State | Meaning | Comes back by |
|---|---|---|
| `open` | waiting to be handled | |
| `settled` | question answered, or follow-up promoted | |
| `off-path` | under an unselected option or unpromoted follow-up | selecting or promoting it |
| `deferred` | excluded for later, or under something that was | `restore` on the excluded item |
| `not-applicable` | excluded as dropped, or under something that was | `restore` on the excluded item |
| `frozen` | a superseded question or option, and everything under it | never |

### Walk order

`next` returns the first open item in this order:

1. Roots, in the order they were added.
2. Under a settled question: the answer's questions, the answer's follow-ups, the question's own questions, its own follow-ups.
3. Root follow-ups last.

New work under an answer comes before later roots. An open question stays at the front until it is selected, excluded or superseded. While a focus is active, `next` stays inside it.

`<next></next>` means nothing is open. Deferred items remain in the tree, and nothing restores them automatically.

## Operations

`…` means repeatable. Every other flag can be given once.

| `--op` | Effect |
|---|---|
| `add-question --text T [--option A]… [--origin ID]` | Adds a question. |
| `add-option --origin QID --text T` | Adds an option to a question. |
| `add-follow-up --text T [--origin ID]` | Records a follow-up. |
| `select-option --target OID… [--rationale R]` | Makes these options, all of one question, its whole selection, replacing any earlier one and its rationale. To add an option to a selection, pass them all again. `R` records why. |
| `clear-selection --target QID` | Withdraws a question's whole selection and its rationale. The question is open again with every option still on offer. What hung under the answer goes off the path, and returns if that option is selected again. Fails if nothing is selected. |
| `promote-follow-up --target FID [--text T] [--option A]…` | Creates a question under the follow-up, worded as `T` or as the follow-up, with the follow-up's tags. The follow-up stays as history under its own id. |
| `supersede-question --target QID --text T [--option A]…` | Puts a new question in the old one's place, with its tags, the focus if it held it, and only the options given. The old question and everything under it are frozen; no answers or children carry over. |
| `supersede-option --target OID --text T` | Adds a new option to the same question, with the next free letter, and freezes the old option and everything under it. Nothing carries over. If the old option was selected, the question's whole selection is dropped and the question is open again. |
| `exclude --target ID --reason deferred\|not-applicable [--note N]` | Takes an item and everything under it out of the walk. Until it is restored, the item and what is under it accept only `add-question`, `add-option`, `add-follow-up`, `tag` and `untag`. Excluding every selected option reopens the question. |
| `restore --target ID` | Brings back the item the exclusion was made on, with everything under it. A selection returns unless a newer one replaced it or it was cleared. |
| `focus --target ID` | Puts an item with something open at the head of `next`. Only the latest focus counts. It ends when nothing is open inside it, or its item is excluded or goes off the path, and it never comes back. Superseding the focused question moves it to the replacement. |
| `tag` / `untag --target ID --tag T…` | Adds or removes tags on a question or follow-up. |

## Queries

| `--query` | Returns |
|---|---|
| `next [--trail]` | the first open item, with the path to it if `--trail` is given. It is the only query a focus affects. |
| `status [--target ID]` | open, settled and deferred items in one compact hierarchy; off-path, not-applicable and frozen items are left out. An item inside a decided option goes if that answer changes, and one beside `<decided>` stays. `--target` limits it to that item and what's under it, and prints an empty `<status></status>` for an item it leaves out. |
| `tree [--state S]… [--target ID]` | the full structure, with every option. It keeps the ancestors of a match. `--target` limits it to that item and what's under it. |
| `items [--tag T] [--target ID [--trail]] [--state S]… [--limit N]` | a flat list in walk order. `--target` finds one item in any state unless `--state` is given. `--limit` doesn't say whether more exist. |

`S` is `open` (the default), `settled`, `off-path`, `deferred`, `not-applicable`, `frozen` or `all`. It never filters options.

## Judgement calls

| Situation | Consider |
|---|---|
| Not ready to decide | `exclude --reason deferred` with the blocker as `--note` frees the walk, and `restore` brings it back once the blocker clears. Items waiting on the same person can share a tag, so `--query items --tag T --state deferred` lists them together. |
| A question's premise changed | `supersede-question` with the corrected wording, because patching answers leaves decisions standing on the old premise. `--query tree --target QID --state all` shows what it would freeze, and the normal ops rebuild what still holds from `<before>`, including open items and viable options. |
| An option's meaning changed | Rewording isn't possible. `supersede-option` with the corrected wording, because `exclude` would leave what was decided under the old wording restorable. The normal ops rebuild what still holds from `<before>`. |
| Stopping before everything is decided | A pause needs nothing. To close the tree, `exclude --reason deferred` each open item, top-level items first. |
| An option is ruled out | `exclude` on the option, with `--reason not-applicable`. |
| A question's answer is in doubt | `clear-selection` reopens the question without removing or replacing anything. `exclude` on the chosen option also reopens it, but takes that option off the offer. |
