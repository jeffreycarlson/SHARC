# Naming Feedback: `containerId` vs Alternatives

**Proposal:** Jeffrey Carlson's suggestion to use `containerId` instead of `containerSessionId`  
**Date:** 2026-04-03

---

**Architect:**

`containerId` is a step in the wrong direction. The core problem: a container is a *class* — the player or ad unit host. A container ID implies you're identifying the container itself, not a specific session instance within it. In ad tech, "container" already carries meaning (e.g., IAS/MOAT container tags, GPT slot containers). Reusing it as a session-scoped identifier invites confusion.

The original `containerSessionId` was verbose but precise. If brevity matters, `slotId` is better — it's industry-standard, implies per-placement identity, and is already understood by both buy-side and sell-side implementers. My preference remains `slotId` or, at minimum, `containerSessionId`.

---

**PM:**

`containerId` sounds permanent, not ephemeral — like a slot configuration identifier, not a runtime session token. When a creative developer sees it echoed back in `createSession`, they'll wonder: "Is this the same across page loads? Is this a placement ID I should know?" That ambiguity slows adoption.

`slotSessionId` threads the needle: "slot" grounds it in the right concept, "Session" signals it's runtime-scoped. If Jeffrey wants SHARC-flavored naming, `containerSessionId` (the original) is still the clearest. `containerId` alone doesn't make the cut.
