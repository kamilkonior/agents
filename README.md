# brain-kit

Agent skills for working through design decisions.

```
npx skills add kamilkonior/brain-kit
```

| Skill | What it does |
|---|---|
| `grill-me` | Interviews you about a design, one question at a time, until it's settled. You decide; the agent looks things up, recommends and keeps the order. |
| `decision-tree` | A CLI memory for decisions: questions, options, selections and follow-ups in an append-only log. It answers what to decide next and what's already settled. |

`grill-me` runs on `decision-tree`, so install both. Requires Node 20+.

## Usage

Ask your agent:

> Grill me on how we should store events.

Each design gets its own log at `.brain-kit/grill-me/<topic>.jsonl`. To continue one later, ask the agent to pick that session back up.

To use `decision-tree` on its own, ask the agent to keep track of a set of decisions.

## License

[AGPL-3.0](LICENSE)
