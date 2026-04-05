# PM Review: Dual Session ID Model

**Reviewer:** Product Manager  
**Date:** 2026-04-03  
**Proposal:** [dual-session-id.md](./dual-session-id.md)  
**Author:** Jeffrey Carlson  
**Status:** Reviewed — Recommendation: Accept for v2, not v1

---

## Summary Verdict

The proposal is sound and the problem is real. But the timing is wrong for v1. Shipping `containerSessionId` in Phase 1 adds implementer surface without solving a problem that exists in Phase 1's actual scope. Defer to v2 with a clear commitment to include it.

The naming needs work. More on that below.

---

## Product Assessment

### Is the problem real?

Yes, but it's a Phase 2–3 problem.

Phase 1 scope is a single SHARC container, a single creative, a single ad slot — end-to-end. Multi-ad page management (leaderboard + interstitial + sticky footer simultaneously) is real inventory, but it's not what Phase 1 is proving. Adding infrastructure for multi-ad orchestration before we have one ad working cleanly is exactly the pattern that stalled this project before.

The collision risk is astronomically small with UUIDs and MessageChannel isolation. That's not the actual driver here. The actual driver is **container-side logging** — and that's legitimate. Container operators running analytics dashboards want an ID they generated, not one handed to them by the creative. That's a reasonable ask.

### Value split: publishers vs. creative developers

**Publishers and SSPs** (container implementers) get genuine value from this. They want to own their session namespace. They don't want to depend on creative-generated IDs for their logging infrastructure. `containerSessionId` gives them an anchor ID they control — issued before the creative loads, stable across the lifecycle.

**Creative developers** get essentially nothing from this proposal. From their perspective, the SDK silently echoes a field they never see. That's the right design — zero API surface change for creatives is a feature, not a limitation. But it means creative developers aren't a stakeholder to consult on this; they're just along for the ride.

**Ad networks and DSPs** are the subtle third stakeholder here. If `containerSessionId` shows up in logs and eventually in impression tracking, DSPs will need to know what it is. Don't let this become an undocumented field that shows up in data pipelines six months from now without being defined.

### Adoption impact

Negligible for v1. Positive for v2 if sequenced right.

The adoption case for SHARC right now is: **easy for creative developers, drop-in for publishers**. The Creative SDK hides all complexity. The container library is one file. Every field we add to the bootstrap message is another field a container implementer might think they need to understand before shipping.

`containerSessionId` is optional, so technically it doesn't block anyone. But optional fields in protocols are often either ignored (defeating the purpose) or cargo-culted (everyone copies the reference implementation and ships `containerSessionId` without understanding why). Neither outcome is great.

In v2, once there are real multi-ad deployments and real logging pipelines, this becomes an obvious yes. Publishers will ask for it themselves.

### SIMID relationship

This is the most interesting strategic angle in the proposal. SIMID has the same limitation and also "likely never considered for multi-ad scenarios." If SHARC ships `containerSessionId` and SIMID doesn't have it, that's a genuine differentiator that matters to publishers running video + display simultaneously.

But proposing to a standards working group while SHARC is still in Phase 1 is a bad look. You don't want the first thing the SIMID working group hears about SHARC to be "here's a feature we thought of while building ours." That reads as competitive positioning, not collaboration. Wait until SHARC is deployed and the case is empirical: "we shipped this, here's the log data that shows why it matters."

---

## Answers to the 5 Questions

### Q1: Should `containerSessionId` be required in bootstrap, or truly optional?

**Optional in v1 if we ship it at all. Required in v2.**

Making it required now adds a gate that old-style containers (and SIMID players) fail. That breaks backward compatibility, which the proposal correctly identifies as a non-goal. Optional is right for now.

But here's the stronger opinion: if we make it optional forever, it'll be implemented inconsistently. Containers that care about analytics will use it. Containers that don't won't. Logs will be half-populated. That's worse than not having the field at all.

The right posture: optional in v1 (if shipped), declared required in v2. Announce the promotion schedule at v1 ship so implementers know what's coming.

### Q2: If creative doesn't echo `containerSessionId` — what does the container do?

**Accept and proceed. Never reject.**

Rejecting on a missing echo breaks every SIMID-compatible creative and every creative that predates this feature. That's an unacceptable compatibility tax.

The right behavior: if the creative doesn't echo `containerSessionId`, the container logs that the echo was missing and falls back to `sessionId` alone. It's not an error — it's a capability signal. Old creative = no echo. New creative = echoes it.

Also: consider not requiring the creative to echo it at all. The container *already has* `containerSessionId` — it generated it. Why does it need the creative to parrot it back? The echo only makes sense if the container needs to correlate `createSession` messages from multiple creatives where the `containerSessionId` might differ. In practice, each creative gets one `containerSessionId`, so the correlation is trivial from the container side. This echoing behavior may be unnecessary complexity.

### Q3: Should `containerSessionId` appear in ALL subsequent messages, or only `createSession`?

**Only in `createSession`. Do not propagate to all messages.**

If `containerSessionId` shows up in every message, it becomes ambient noise — implementers will include it without thinking about why. Worse, it doubles the logging key on every message when the correlation has already been established at session open.

The right model: `containerSessionId` is established once at bootstrap, echoed once in `createSession`, and then used by the container as its primary logging key without being re-included in every message. The container's own message routing already knows which session each message belongs to — it doesn't need the ID repeated.

Exception: if we ever add an extension or multi-session orchestration layer that needs explicit cross-session correlation, revisit then.

### Q4: Propose to SIMID working group now, or after SHARC ships?

**After SHARC ships. Minimum: after Phase 1 is in production.**

This is not the right time. The reasons:

1. **Credibility:** "We have this idea" is weaker than "we shipped this and here's why it matters." The SIMID working group will take this more seriously when it's backed by implementation evidence.

2. **Political optics:** Proposing to SIMID while SHARC is pre-production positions SHARC as theoretically better than SIMID. That's not the relationship we want. We want SIMID implementers to eventually see SHARC as a peer, maybe even a contributor.

3. **Scope risk:** Engaging SIMID now creates a work stream that competes with Phase 1 attention. Keep the team focused.

The right time to propose: when we have one real SHARC deployment with multi-ad logging data that makes the case empirically. Target: Q3 2026 at earliest.

### Q5: Naming — `containerSessionId` vs `slotId` vs `adUnitId`?

**`containerSessionId` is wrong. Use `slotSessionId`.**

Here's the problem with `containerSessionId`: it sounds like the container's session (the whole container, across all ads). But what we're actually scoping is the session *for one ad slot instance*. One container might manage three slots; each slot gets its own ID.

- `containerSessionId` → implies one per container. Misleading.
- `adUnitId` → this is an existing term in ad tech (GAM, DFP) that refers to the ad unit configuration, not a session instance. Reusing it will cause confusion with publishers.
- `slotId` → sounds like a static placement identifier, not a session-scoped ID.
- **`slotSessionId`** → correctly conveys "this session, in this slot." Clear, novel, doesn't collide with existing ad tech terminology.

Alternative worth considering: **`containerSlotId`** — communicates "container-generated" + "slot-scoped." Less elegant than `slotSessionId` but maps to how publishers think about ad slots.

Whatever name we choose, the spec should explicitly state: *"A new `slotSessionId` is generated for each ad slot instance. If the same creative is served twice in two slots, each gets a different `slotSessionId`."* Disambiguation matters here.

---

## Recommended Path Forward

### v1 (Phase 1 — now)

Do not ship `containerSessionId`. It solves a multi-ad problem that Phase 1 doesn't have. Every field added to the bootstrap message is a field a publisher might copy from the reference implementation without understanding it. Keep Phase 1 lean.

**Exception:** Add a comment in the reference implementation's bootstrap handler that explicitly reserves the `slotSessionId` field name and points to the v2 tracking issue. This prevents other implementers from squatting on the namespace with incompatible semantics.

### v2 (Phase 2 — after Phase 1 ships)

Formally introduce `slotSessionId` as an optional field in bootstrap with the following defined behavior:
- Container generates it before creative loads
- Creative SDK echoes it transparently in `createSession` (zero API surface for creative developers)
- Container uses it as primary logging key
- Old creatives that don't echo it: container falls back gracefully
- Declare it required in v3

Simultaneously: draft the SIMID proposal doc internally so it's ready to submit once Phase 1 is in production.

### What needs to be answered before v2 design is final

1. **Is the echo actually necessary?** Challenge the assumption that the creative needs to echo it back. If the container already has it, the echo only adds value in edge cases involving multi-session correlation. Define those cases explicitly before requiring the echo.

2. **Does `slotSessionId` appear in measurement / impression data?** If so, align with OpenRTB/AdCOM working group — this field may need to be formally defined in the bid response so it can be correlated end-to-end. Don't let this become a proprietary field baked into logging that never gets standardized.

3. **What's the privacy posture?** Container-generated IDs flowing through creatives create a potential fingerprinting vector. The ID should be session-scoped (not persistent across sessions) and not expose container infrastructure details. The proposal implies this is already the design, but make it explicit.

---

## Bottom Line

Good proposal. Real problem. Wrong timing. Rename it and ship it in v2.

Jeffrey, if you want a compromise: ship the bootstrap field as optional in Phase 1 but don't add the echo requirement to `createSession` yet. That way containers can start generating and logging the ID internally without requiring creative cooperation. Establish the convention; mandate the echo later.

But honestly? Don't ship it in Phase 1. Every day Phase 1 doesn't exist is a day the adoption argument is theoretical. Keep Phase 1 minimal, ship it, get a production deployment, then iterate. That's the lesson from everything that stalled before.
