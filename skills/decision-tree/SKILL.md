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

Requires Node 20+. `DECISION_TREE_LOG` can stand in for `--log`, which wins if both are set.

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
| `frozen` | a superseded question and everything under it | never |

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
| `promote-follow-up --target FID [--text T] [--option A]…` | Creates a question under the follow-up, worded as `T` or as the follow-up. The follow-up stays as history under its own id. |
| `supersede-question --target QID --text T [--option A]…` | Puts a new question in the old one's place, with its tags and only the options given. The old question and everything under it are frozen, and nothing carries over. |
| `exclude --target ID --reason deferred\|not-applicable [--note N]` | Takes an item and everything under it out of the walk. Nothing under it can change until it is restored. Excluding every selected option reopens the question. |
| `restore --target ID` | Brings back the item the exclusion was made on, with everything under it. A selection returns unless a newer one replaced it. |
| `focus --target ID` | Puts an item with something open at the head of `next`. Only the latest focus counts. It ends when nothing is open inside it, or its item is excluded or goes off the path, and it never comes back. Superseding moves it to the replacement. |
| `tag` / `untag --target ID --tag T…` | Adds or removes tags on a question or follow-up. |

## Queries

| `--query` | Returns |
|---|---|
| `next [--trail]` | the first open item, with the path to it if `--trail` is given |
| `status [--target ID]` | open, settled and deferred items in one compact hierarchy |
| `tree [--state S]… [--target ID]` | the full structure, with every option |
| `items [--tag T] [--target ID [--trail]] [--state S]… [--limit N]` | a flat list in walk order |

`S` is `open` (the default), `settled`, `off-path`, `deferred`, `not-applicable`, `frozen` or `all`. It never filters options, and `tree` keeps the ancestors of a match. `--target` limits `status` and `tree` to that item and what's under it, and `status` prints nothing for an item it leaves out. In `items`, `--target` finds one item in any state unless `--state` is given. `--limit` doesn't say whether more exist. A focus affects only `next`.

## When things get in the way

| Situation | What works |
|---|---|
| Not ready to decide | `exclude --reason deferred` with the blocker as `--note` frees the walk, and `restore` brings it back once the blocker clears. Everything under it waits with it. |
| The premise of a question changed | Patching answers leaves decisions standing on the old premise, while `supersede-question` with corrected wording freezes them. Superseding can't be undone, and `--query tree --target QID --state all` shows exactly what it would freeze. The normal ops rebuild what still holds from `<superseded>`, including open items and viable options. |
| Reconsidering a selection | `--query status --target QID` shows what depends on the answer before it changes: what's inside the decided option goes with it, and what's beside `<decided>` stays. The old subtree returns if that option is selected again. |
| Stopping with items still open | A pause needs nothing. To close the tree, `exclude --reason deferred` each open item, top-level items first. |
| An option no longer applies | `exclude` on the option, with `--reason not-applicable`, removes just that answer. The other options keep their letters. |

## Output

Position in the XML carries meaning:

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
            <option><id>Q2b</id><text>Postgres</text></option>
          </options>
        </question>
      </option>
      <rationale>We already run Postgres</rationale>
    </decided>
    <question state="deferred">
      <id>Q3</id>
      <text>Retention?</text>
      <note>Legal is deciding</note>
    </question>
  </question>
</status>
```

- **`next`:** one `<question>` or `<follow-up>`, and a follow-up has no options. `--trail` puts the path to it in `<trail>`.
- **`status`:** an item inside a decided option goes if that answer changes, and one beside `<decided>` stays. Off-path and not-applicable items are left out, and a deferred item shows only its note.
- **`tree`:** the chosen option has `selected="true"` and holds its children, `<rationale>` follows `<options>`, and the question's own children come after that. A promoted follow-up appears as a step, and a superseded question follows its replacement.
- **`items`:** `<rationale>` says why the options were selected, `<note>` why the item was excluded, and `<hidden-by>` names what hides it.
- **`promote-follow-up`:** `<promote>` holds the new question and, in `<promoted>`, the follow-up it came from.
- **`supersede-question`:** `<supersede>` holds the new question and, in `<superseded>`, the old subtree in `tree` shape with every state.
