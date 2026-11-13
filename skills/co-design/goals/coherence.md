# Coherence

The decisions make one design: a few principles run through it, and no two parts contradict each other.

*Falls short:* a patchwork. *Overshoots:* one pattern forced on every part.

## Desirable

- **Stated principles:** a few design principles are named, and decisions are checked against them.
- **Consistency across parts:** similar problems are solved in similar ways.
- **Contradiction checks:** each new decision is checked against earlier ones, and conflicts are raised.
- **Resolved conflicts:** conflicting requirements are settled explicitly.
- **Whole-design review:** the assembled design is reviewed end to end, not only part by part.
- **Ripple tracking:** when a decision changes, the parts that depend on it are updated.
- **Fitting interfaces:** where parts meet is defined and agrees on both sides.
- **Summarizable whole:** a few sentences describe the design, and every part is consistent with them.
- **Justified exceptions:** departures from the principles are deliberate and explained.
- **Integrated additions:** new parts are worked into the existing structure.

## Undesirable

- **Contradictions:** two parts require incompatible things.
- **Patchwork:** parts designed separately follow different styles, assumptions or rules.
- **Local optimization:** each part is strong alone while the whole works poorly.
- **Stale dependents:** a decision changes and the parts built on it don't.
- **Bolt-ons:** additions sit on top of the design, not integrated.
- **Unexplained exceptions:** special cases accumulate with no reason given.
- **Mismatched interfaces:** parts assume different things about how they connect.
- **Unresolved tension:** conflicting requirements are both kept, for whoever builds the design to sort out.
- **Forced uniformity:** one pattern is applied to a part whose requirements differ.
- **Principle worship:** a principle is kept where it works against the success criteria.
