---
name: decision-tree
description: A CLI memory for decisions. Records questions, options, selections and follow-ups as a tree in an append-only log, and answers what to decide next and what is already settled. Use it whenever decisions need to outlive the conversation or be worked through in order, such as an interview, a design review, a planning session or a long list of open questions, even if the user only says "keep track of this" or "where were we?". Other skills call this CLI instead of tracking decisions in conversation text.
---

# Decision tree

A memory for decisions. The CLI stores each question, option, selection and follow-up, validates every write, and keeps the tree in order. It has no opinion on how a conversation should go: that belongs to you, or to the skill calling it.

## Running it

```
node <this skill's directory>/scripts/decision-tree.js --log <path> --op <op> [flags]
node <this skill's directory>/scripts/decision-tree.js --log <path> --query <query>
```

`--op` writes and `--query` only reads. Every call needs `--log` or the `DECISION_TREE_LOG` environment variable; `--log` wins when both are set. Requires Node 20+.

Results print as XML on stdout. A failed call prints one line on stderr, exits with code 1 and writes nothing, so it is always safe to fix the call and run it again.

## The model

- A **question** is something to decide. It can have any number of **options**.
- A question is settled once one or more of its options are **selected**.
- A **follow-up** is a topic worth raising that isn't ready to be a question. It stays a follow-up until it is promoted or excluded.
- Ids are `Q1`, `Q2`… for questions, `F1`, `F2`… for follow-ups, and the question's id plus a letter for options (`Q1a`, `Q1b`…), up to 26 per question. Ids are never reused, so an id you saw earlier still means the same item.

`--origin` says where a new item hangs. The place matters, because it decides when the item comes up:

- under an **option** when it only matters if that option is selected; it stays hidden otherwise;
- under a **question** when it matters whatever the selection is;
- under a **follow-up** when it only matters if that follow-up is pursued;
- no origin for a root: something that depends on nothing else in the tree.

`--target` names the existing item an op acts on.

Some behaviour worth expecting:

- If every selected option is excluded, the question opens again. Restoring the option brings the selection back, unless a newer selection replaced it. A question never falls back to an earlier selection.
- A focus ends for good once its subtree has nothing open, even if new work appears there later. Excluding the focused item ends the focus too, and restoring it doesn't bring the focus back. So does a changed answer that takes the focused item off the path, and selecting that answer again doesn't bring it back. Superseding the focused question moves the focus to the replacement.

## Commands

| Build | |
|---|---|
| `--op add-question --text T [--option A]… [--origin ID]` | adds a question; prints `<question>` |
| `--op add-option --origin QID --text T` | adds one more option to a question; prints `<option>` |
| `--op add-follow-up --text T [--origin ID]` | records a topic that isn't ready to be a question; prints `<follow-up>` |

| Decide | |
|---|---|
| `--op select-option --target OID [--target OID]…` | selects one or more options of one question; a later selection replaces the whole earlier one; prints `<selection>` |
| `--op promote-follow-up --target FID [--option A]…` | turns a follow-up into a question under it; prints `<question>` |

| Change | |
|---|---|
| `--op supersede-question --target QID --text T [--option A]…` | replaces a question with a reworded one in its place, keeping its tags; the old question and everything under it are frozen; prints `<supersede>` |

| Remove | |
|---|---|
| `--op exclude --target ID --reason R [--note N]` | takes a question, option or follow-up and everything under it out of the tree; `R` is `deferred` (kept for later, listed in `tree`) or `not-applicable` (dropped); `N` records why |
| `--op restore --target ID` | brings an excluded item back with everything under it |

| Order | |
|---|---|
| `--op focus --target ID` | puts a question or follow-up at the head of `next` until its subtree has nothing open |

| Label | |
|---|---|
| `--op tag --target ID --tag T [--tag T]…` | adds tags to a question or follow-up; prints the item with its tags |
| `--op untag --target ID --tag T [--tag T]…` | removes tags; fails if the item doesn't have one of them |

| Read | |
|---|---|
| `--query next [--trail]` | the one thing to handle now; `--trail` adds the path from the root down to it |
| `--query tree` | the settled tree, open questions and deferred items |
| `--query status [--target ID]` | where the decisions stand now: one hierarchy of what's open, settled and deferred; `ID` limits it to one question or follow-up and what's under it, and prints nothing for an item `status` leaves out; prints `<status>` |
| `--query items [--tag T] [--target ID [--trail]] [--state S]… [--limit N]` | a flat list of questions and follow-ups, each marked with its state; `T` keeps only items with that tag; `ID` finds one item, in any state unless `S` is given; `--trail` adds the path from the root down to that item, even when it's off the path; `N` keeps only the first N matches in walk order, and nothing marks that more exist; `S` is `open` (the default), `settled`, `off-path`, `deferred`, `not-applicable`, `frozen` or `all`; an item excluded directly shows its `<note>`, and an item hidden by another names it in `<hidden-by>`; a focus doesn't limit it; prints `<items>` |

## Output

`--query next` prints one open item, or nothing when the tree is done:

```xml
<next>
  <question>
    <id>Q2</id>
    <text>Which database?</text>
    <options>
      <option><id>Q2a</id><text>SQLite</text></option>
      <option><id>Q2b</id><text>Postgres</text></option>
    </options>
  </question>
</next>
```

```xml
<next>
  <follow-up><id>F1</id><text>Audit needs?</text></follow-up>
</next>
```

```xml
<next></next>
```

`--query tree` nests the settled path. A settled question has `<selected>`; an open one has `<options>`. Deferred items come last, with their note and where they hung:

```xml
<tree>
  <question>
    <id>Q1</id>
    <text>Where do events live?</text>
    <selected>
      <option><id>Q1b</id><text>a database</text></option>
    </selected>
    <question>
      <id>Q2</id>
      <text>Which database?</text>
      <options>
        <option><id>Q2a</id><text>SQLite</text></option>
        <option><id>Q2b</id><text>Postgres</text></option>
      </options>
    </question>
  </question>
  <deferred>
    <question>
      <id>Q3</id>
      <text>Multi-region?</text>
      <note>Legal is deciding</note>
      <hung-under><id>Q1b</id><text>a database</text></hung-under>
    </question>
  </deferred>
</tree>
```

`--query status` is the compact view. Each item has a `state`, and the state decides its body: `open` has `<options>`, `settled` has `<decided>`, and `deferred` has a `<note>` if one was given. Position shows what depends on what: an item inside a decided option goes away if that answer changes, and an item beside `<decided>` stays. Off-path and not-applicable items are left out.

```xml
<status>
  <question state="settled">
    <id>Q1</id>
    <text>Where do events live?</text>
    <decided>
      <option>
        <id>Q1b</id>
        <text>a database</text>
        <question state="open">
          <id>Q2</id>
          <text>Which database?</text>
          <options>
            <option><id>Q2a</id><text>SQLite</text></option>
          </options>
        </question>
      </option>
    </decided>
    <question state="deferred">
      <id>Q3</id>
      <text>Multi-region?</text>
      <note>Legal is deciding</note>
    </question>
  </question>
</status>
```

`supersede-question` prints the new question and the old subtree. In the old subtree every question lists all its options, with the selected ones marked, so rejected options can be reconsidered:

```xml
<supersede>
  <question>
    <id>Q4</id>
    <text>Where do events live, given several writers?</text>
    <options></options>
  </question>
  <superseded>
    <question>
      <id>Q1</id>
      <text>Where do events live?</text>
      <options>
        <option><id>Q1a</id><text>files</text></option>
        <option selected="true"><id>Q1b</id><text>a database</text></option>
      </options>
    </question>
  </superseded>
</supersede>
```

`--query items --tag auth --state open --state deferred` lists matching items flat, in walk order, each with its state. An item excluded directly has its `<note>`; an item hidden by another names it in `<hidden-by>`, which is the item to act on:

```xml
<items>
  <question state="open">
    <id>Q1</id>
    <text>Which provider?</text>
    <options>
      <option><id>Q1a</id><text>Okta</text></option>
      <option><id>Q1b</id><text>Entra</text></option>
    </options>
    <tags><tag>auth</tag></tags>
  </question>
  <question state="deferred">
    <id>Q2</id>
    <text>MFA for admins?</text>
    <options>
      <option><id>Q2a</id><text>yes</text></option>
    </options>
    <note>Legal is deciding</note>
    <tags><tag>auth</tag></tags>
  </question>
  <question state="deferred">
    <id>Q3</id>
    <text>MFA provider?</text>
    <options>
      <option><id>Q3a</id><text>Duo</text></option>
    </options>
    <hidden-by><id>Q2</id></hidden-by>
    <tags><tag>auth</tag></tags>
  </question>
</items>
```

To see how an item is reached, look it up with `--target ID --trail`: the trail lists each question and option above it, including the one named in `<hidden-by>`.

## Usage patterns

**The loop.** Run `--query next`, handle what it returns, record the result, and repeat until it prints `<next></next>`. Let `next` choose the order: it finishes the current branch, raises follow-ups on the way back up, and leaves other topics for later, so the decisions that depend on each other stay together. When resuming, or when handed a single item, use `--query next --trail` to see what led to it.

**Seed a tree.** Add one root question per independent topic. Add a follow-up for anything worth raising that has no options yet. Keep adding as you learn; new items take their place in the walk.

**Record a decision.** `select-option` the option, or several at once. If the decision isn't among the options, `add-option` it first, then select it.

**Record what a decision opened up.** Add the new questions or follow-ups under the option that caused them, so they disappear if the selection changes.

**Not ready to decide.** An open question stays at the front of `next`, so don't leave one open while waiting. If the answer has to be found out first, `exclude` it with `--reason deferred` and a `--note` saying what's blocking it; `next` moves on, what depends on it is held back with it, and `restore` brings it all back once the answer is known. If the work can go on without knowing, `add-option` "unknown", select it, and hang what follows under that option.

**Handle a follow-up.** To pursue it, `promote-follow-up`, then treat it as any question. Otherwise `exclude` it.

**Change a selection.** `select-option` again. The old option's subtree goes off the path and comes back if that option is selected again.

**The premise of a question changed.** Don't patch the answers: `supersede-question` it with the corrected wording, because everything under it was decided under the old premise. Pass any options that clearly still apply. Use the printed `<superseded>` subtree to rebuild what still holds under the new question with the normal ops. Whatever isn't rebuilt stays behind in the frozen record.

**Park or drop something.** `exclude` with `--reason deferred` to keep it listed for later, or `--reason not-applicable` to drop it. Add `--note` when the reason is worth remembering.

**Revisit something excluded.** `restore` the item that was excluded; everything under it comes back as it was.

**Work on one topic first.** `focus` it. Only the latest focus counts. `next` stays inside its subtree until nothing is open there, then returns to the normal walk.

**Find work by topic.** `tag` questions and follow-ups as they come up, list the open ones with `--query items --tag T`, and `focus` the one to work through first.

**See what depends on an answer.** Before changing a selection, run `--query status --target QID`. Whatever sits inside the decided option goes with it; whatever sits beside `<decided>` stays.

**Finish.** When `next` is empty, `--query status` is the record of what was decided and what was left for later.

## What the CLI refuses

A refusal means the tree is protecting a rule, so read the message and change the call rather than retrying it.

- **Excluded items** and anything under them can't be changed until they are restored. Restore the item the exclusion was recorded on: an item hidden only by an excluded ancestor can't be restored on its own.
- **Frozen items**, meaning a superseded question and everything under it, can never be changed. Work on the replacement instead.
- **Selections** must be live options of one question, each named once.
- **Off-path items** can't be selected or focused. Select the option named in the error first, or promote the follow-up.
- **A focus** needs something open: a question or follow-up whose subtree is fully settled is refused.
- **Flags** must be known to the op, a flag can only be repeated where the table shows `…`, and values can't be blank.

## The log

A log is a `.jsonl` file at a path you choose, and it holds one tree with any number of roots. Calling the CLI with the same path resumes it. Set `DECISION_TREE_LOG` to that path to leave out `--log` on every call. Writes take a short lock, `<log>.lock`, so several agents can share a log. Don't edit a log by hand: it is the source of truth, and the tree is rebuilt from it on every call.
