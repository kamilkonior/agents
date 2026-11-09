---
name: decision-tree
description: Persistent memory for decisions. Records questions, options, selections and follow-ups as a tree in an append-only log, and answers what to decide next and what is already settled. Use it whenever decisions should outlive the conversation or be worked through in order, such as an interview, a design review, a planning session or a long list of open questions, even if the user only says "keep track of this" or "where were we?". Skills that run decision conversations call this CLI rather than tracking decisions in conversation text.
---

# Decision tree

Memory for decisions. The CLI stores the tree, validates every write and says what comes next. How the conversation goes is up to you or the skill calling this one.

## Calling it

```
node <this skill's directory>/scripts/decision-tree.js --log <path> --op <op> [flags]
node <this skill's directory>/scripts/decision-tree.js --log <path> --query <query>
```

`--op` writes and `--query` only reads. Requires Node 20+.

- **Log.** A `.jsonl` file at a path you choose, holding one tree with any number of roots. Calling with the same path resumes it. `DECISION_TREE_LOG` can stand in for `--log`, which wins when both are set. Several agents can share a log. The tree is rebuilt from it on every call, so change it only through the CLI.
- **Results** print as XML on stdout.
- **Failures** print one line on stderr, exit with code 1 and write nothing, so a corrected call is always safe. The item named in the message is the one to act on: `Q2 is off-path, hidden by Q1b` means select `Q1b` first.

## The model

- A **question** is something to decide. It has any number of **options** and is settled once one or more are **selected**.
- A **follow-up** is a topic worth raising that isn't ready to be a question. It stays one until it is promoted or excluded.
- **Ids** are `Q1` for questions, `F1` for follow-ups, and the question's id plus a letter for options (`Q1a`), up to 26 per question. Ids are never reused.
- `--target` names an existing item. `--origin` says where a new item hangs.
- **What to store:** what can't be looked up again, such as decisions, the reasons for them and facts only a person knows. Leave out facts that live in code or docs, because a saved copy goes stale.

### Where an item hangs

The CLI accepts any valid `--origin` and can't tell when it is the wrong one, so this is the choice that needs thought. It decides when the item comes up and what it disappears with.

| Hang it under | When it |
|---|---|
| an option | matters only if that option is selected |
| a question | matters whatever the selection is |
| a follow-up | matters only if that follow-up is pursued |
| nothing (a root) | depends on nothing else in the tree |

### States

| State | Meaning | Comes back by |
|---|---|---|
| `open` | waiting to be handled | |
| `settled` | question answered, or follow-up promoted | |
| `off-path` | under an option not selected, or a follow-up not promoted | selecting that option or promoting that follow-up |
| `deferred` | excluded to keep for later, or under something that was | `restore` on the excluded item |
| `not-applicable` | excluded as dropped, or under something that was | `restore` on the excluded item |
| `frozen` | a superseded question and everything under it | never; work on the replacement |

### What `next` does

`next` returns the first open item in walk order, so let it choose. Roots come up in the order they were added. Under a settled question the order is the answer's questions, the answer's follow-ups, the question's own questions, then its own follow-ups. Root follow-ups come last. Decisions that depend on each other stay together this way, and new work under an answer comes before roots still waiting.

### Rules the CLI won't warn about

- A new selection replaces the whole earlier one. To add to a multiple selection, pass every option again.
- Excluding every selected option reopens the question. Restoring the option brings the selection back unless a newer one replaced it. A question never falls back to an earlier selection.
- Only the latest focus counts. A focus ends when nothing is open inside it, or when its item is excluded or goes off the path, and an ended focus never comes back. Superseding the focused question moves the focus to the replacement.

## Situations

**The loop.** Run `--query next`, handle what it returns, record the result, and repeat until it prints `<next></next>`. When resuming, or when handed a single item, add `--trail` to see what led to it.

| Situation | Do |
|---|---|
| Starting a tree | Add one root question per independent topic and a follow-up for anything without options yet. Keep adding as you learn. |
| A decision was made | `select-option`, with `--rationale` if a reason was given, because why it was chosen can't be looked up later. If the decision isn't among the options, `add-option` it first. |
| The decision opened new topics | Add them under the option that caused them, so they leave if the selection changes. |
| Not ready to decide | `exclude --reason deferred` with the blocker as `--note`, then `restore` once it clears. An open question stays at the front of `next`, so leaving one open stalls the walk. Everything under it waits too. |
| Work can go on without the answer | `add-option` "unknown", select it, and hang what follows under it. |
| A follow-up comes up | To pursue it, `promote-follow-up` with its options, adding `--text` when the note's wording doesn't work as a question. A follow-up can't hold options, so drafts wait until then. `<promote>` gives the new id, and the old one stays as history. Otherwise `exclude` it. |
| Reconsidering a selection | Run `--query status --target QID` first: what sits inside the decided option goes with it, and what sits beside `<decided>` stays. Then `select-option` again. The old subtree goes off the path and returns if that option is selected again. |
| The premise of a question changed | Preview what would freeze with `--query tree --target QID --state all`, because superseding can't be undone. Then `supersede-question` with the corrected wording and any options that still apply, because everything under it was decided on the old premise. Rebuild what still holds from the printed `<superseded>` subtree with the normal ops, along with its open items and the options still viable. What isn't rebuilt stays frozen. |
| Something doesn't apply | `exclude --reason not-applicable`, with a `--note` if the reason is worth keeping. |
| An option no longer applies | `exclude` the option with `--reason not-applicable`. It leaves `next`, and the other options keep their letters. |
| One topic should go first | `focus` it. |
| Finding work by topic | `tag` items as they come up, list them with `--query items --tag T`, and `focus` the one to do first. |
| Stopping with items still open | List them with `--query items` and `exclude --reason deferred` each, top-level items first, because what's under an excluded item goes with it and refuses a second exclude. |
| `next` is empty | `--query status` is the record. Deferred items are still in it and nothing brings them back on its own, so `restore` any that can now be answered. |

## Commands

`…` marks a flag that can be repeated. All other flags can be given once.

| `--op` | Effect | Prints |
|---|---|---|
| `add-question --text T [--option A]… [--origin ID]` | adds a question | `<question>` |
| `add-option --origin QID --text T` | adds an option to a question | `<option>` |
| `add-follow-up --text T [--origin ID]` | records a follow-up | `<follow-up>` |
| `select-option --target OID… [--rationale R]` | selects options of one question; `R` records why they were chosen | `<selection>` |
| `promote-follow-up --target FID [--text T] [--option A]…` | turns a follow-up into a question under it, worded as `T` if given | `<promote>`: the new question and the follow-up it came from |
| `supersede-question --target QID --text T [--option A]…` | puts a reworded question in the old one's place, keeping its tags, and freezes the old one | `<supersede>` |
| `exclude --target ID --reason R [--note N]` | takes a question, option or follow-up out with everything under it; `R` is `deferred` or `not-applicable` | the item |
| `restore --target ID` | brings an excluded item back with everything under it | the item |
| `focus --target ID` | puts a question or follow-up with something open at the head of `next`; other queries ignore it | the item |
| `tag --target ID --tag T…` | adds tags to a question or follow-up | the item |
| `untag --target ID --tag T…` | removes tags the item has | the item |

| `--query` | Use it for |
|---|---|
| `next [--trail]` | the one item to handle now |
| `status [--target ID]` | where decisions stand: open, settled and deferred items in one compact hierarchy |
| `tree [--state S]… [--target ID]` | the full structure, with every option of each question |
| `items [--tag T] [--target ID [--trail]] [--state S]… [--limit N]` | a flat list in walk order, each item with its state |

- `--state S` is `open` (the default), `settled`, `off-path`, `deferred`, `not-applicable`, `frozen` or `all`. It filters questions and follow-ups, never options. `tree` keeps the ancestors of a match.
- `--target ID` limits `status` and `tree` to that item and what's under it, and `status` prints nothing for an item it leaves out. In `items` it finds one item, in any state unless `--state` is given.
- `--trail` adds the path from the root down to the item. In `items` it needs `--target` and works off the path too.
- `--limit N` keeps the first N matches and doesn't say whether more exist.

## Output

`--query next --trail`. Without `--trail` the `<trail>` is absent. A `<follow-up>` can stand where the `<question>` is, and `<next></next>` means nothing is open.

```xml
<next>
  <trail>
    <question><id>Q1</id><text>Where do events live?</text></question>
    <option><id>Q1b</id><text>a database</text></option>
  </trail>
  <question>
    <id>Q2</id>
    <text>Which database?</text>
    <options>
      <option><id>Q2a</id><text>SQLite</text></option>
    </options>
  </question>
</next>
```

`--query status`. The state decides the body: `open` has `<options>`, `settled` has `<decided>`, with a `<rationale>` after its options if the selection had one, and `deferred` has a `<note>` if one was given. Inside a decided option means the item goes if that answer changes, and beside `<decided>` means it stays. Off-path and not-applicable items are left out.

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
      <text>Retention?</text>
      <note>Legal is deciding</note>
    </question>
  </question>
</status>
```

`--query items --target Q4 --trail`, for an item hidden by the exclusion of Q3. `<hidden-by>` names the item to act on. An item excluded directly has its `<note>` instead, if one was given. A `<rationale>` follows `<options>` if the selection had one. Excluded options are listed after the live ones with their state and note, here and in `tree`.

```xml
<items>
  <question state="deferred">
    <id>Q4</id>
    <text>Retention tier?</text>
    <options>
      <option><id>Q4a</id><text>cold</text></option>
    </options>
    <hidden-by><id>Q3</id></hidden-by>
    <tags></tags>
    <trail>
      <question><id>Q1</id><text>Where do events live?</text></question>
      <question><id>Q3</id><text>Retention?</text></question>
    </trail>
  </question>
</items>
```

`supersede-question` on Q1, in a tree holding only Q1 and Q2. `<superseded>` has the same shape as `--query tree` with every state included: the chosen option is marked `selected="true"` and holds its children, a `<rationale>` follows `<options>` if the selection had one, and a question's own children come after that. Branches not taken are included, so rejected options can be reconsidered along with what depended on them. In `tree`, a promoted follow-up appears as a step and a superseded question follows its replacement.

```xml
<supersede>
  <question>
    <id>Q3</id>
    <text>Where do events live, given several writers?</text>
    <options>
      <option><id>Q3a</id><text>a database</text></option>
    </options>
  </question>
  <superseded>
    <question state="settled">
      <id>Q1</id>
      <text>Where do events live?</text>
      <options>
        <option><id>Q1a</id><text>files</text></option>
        <option selected="true">
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
      </options>
    </question>
  </superseded>
</supersede>
```
