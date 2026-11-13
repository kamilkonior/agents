# brain-kit

Agent skills for working through design decisions.

```
npx skills add kamilkonior/brain-kit
```

| Skill | What it does |
|---|---|
| `co-design` | Designs something with you: an architecture, a feature, a process, a strategy, a document. Both of you contribute ideas, you decide what is yours to decide, and the result is a written design that can be built from without the agent. |
| `grill-me` | Interviews you about a design, one question at a time, until it's settled. You decide; the agent looks things up, recommends and keeps the order. |
| `decision-tree` | A CLI memory for decisions: questions, options, selections and follow-ups in an append-only log. It answers what to decide next and what's already settled. |

`grill-me` runs on `decision-tree`, so install those two together; that pair requires Node 20+. `co-design` works on its own.

## Usage

To make a design that doesn't exist yet, ask your agent:

> Let's design how we should store events.

`co-design` steers the session by twelve goals, such as Framing, Agency, Brainstorming and Convergence. Each is a dial that can fall short or overshoot, not a rule, and each has a list of traits in `skills/co-design/goals/` to check the session against.

To pressure-test a plan you already have, ask:

> Grill me on how we should store events.

Each design you are grilled on gets its own log at `.brain-kit/grill-me/<topic>.jsonl`. To continue one later, ask the agent to pick that session back up.

To use `decision-tree` on its own, ask the agent to keep track of a set of decisions.

## License

[AGPL-3.0](LICENSE)
