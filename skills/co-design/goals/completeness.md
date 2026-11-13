# Completeness

The design covers everything the request needs and can be used as it stands, with anything left out named.

*Falls short:* gaps left for the user to find. *Overshoots:* work and detail nobody needs.

## Desirable

- **Full coverage:** every part of the request is addressed, including the easily overlooked.
- **Requirement tracking:** stated requirements are carried through to the end.
- **Implied needs:** requirements the task implies are handled along with the explicit ones.
- **Edge cases:** exceptions, failures and boundary conditions that could realistically occur are considered.
- **Finished state:** no placeholders, stubs or "to be filled in" sections.
- **Self-sufficiency:** the result contains what is needed to use it.
- **Consistent depth:** each part gets the attention it warrants; none is thin because effort ran out.
- **Dependencies covered:** prerequisites, follow-on steps and knock-on effects are accounted for.
- **Declared omissions:** anything left out on purpose is named, with the reason.
- **Final check:** the result is compared with the original request before it is called done.

## Undesirable

- **Partial answers:** only the easy or first part of a multi-part request is handled.
- **Silent omission:** something is skipped without mention.
- **Premature "done":** work is declared finished while pieces are missing or untested.
- **Placeholders:** stubs, TODOs or "etc." stand in for content.
- **Happy-path only:** the result works for the typical case and breaks on anything else.
- **Trailing off:** early sections are thorough, later ones rushed or truncated.
- **Requirement drift:** constraints set at the start are forgotten by the end.
- **Dangling threads:** questions raised along the way are never resolved.
- **Padding:** material is added to look thorough.
- **Scope creep:** the work expands into things nobody asked for.
- **Exhaustiveness for its own sake:** every conceivable case is covered, burying the ones that matter.
- **Gold-plating:** polishing continues past fit for use.
