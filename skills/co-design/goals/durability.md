# Durability

The design keeps its value after the session: it is saved, someone who was not there can understand it, and the reasons for its choices are in it.

*Falls short:* a result that lives only in the conversation. *Overshoots:* a design built for a future that won't arrive.

## Desirable

- **Root-cause solutions:** the underlying problem is fixed, not only its symptom.
- **Robustness:** the result holds under varied inputs, heavier use and conditions beyond the original case.
- **Persistence:** decisions, context and outputs are saved where they outlast the session.
- **Standalone clarity:** someone who wasn't there can understand the result.
- **Recorded rationale:** the reasons behind choices are captured, so they aren't reopened without new information.
- **Maintainability:** someone else can update or extend the work without starting over.
- **Adaptability:** likely changes can be absorbed without the whole breaking.
- **Stable foundations:** the work builds on things unlikely to shift, and isolates what is volatile.
- **Explicit assumptions:** the conditions the result depends on are stated, so it is clear when it stops applying.
- **Graceful aging:** parts that will go stale are marked, with a way to refresh them.
- **Proportion:** effort on longevity matches the stated lifespan, which is asked for when not given.

## Undesirable

- **Quick fixes:** patches hide the problem until it returns.
- **Fragility:** the result works once, in one situation.
- **Ephemeral results:** conclusions exist only in the conversation.
- **Context dependence:** the output makes sense only to those who were present.
- **Lost rationale:** the decision survives without its reasons, and is re-argued or reversed by accident.
- **Hard-coded specifics:** details that will change are baked in where they can't be adjusted.
- **Hidden assumptions:** the result fails without warning when an unstated condition stops holding.
- **Single point of knowledge:** only one person can maintain or explain the work.
- **Silent decay:** information goes stale with nothing to signal it.
- **Over-engineering:** the work is built for futures unlikely to arrive.
- **Premature permanence:** something still exploratory is locked in as settled.
- **Rigidity:** the result is too fixed to change when it should.
