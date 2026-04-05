# Architect Review: Dual Session ID Model

**Reviewer:** Software Architect  
**Date:** 2026-04-03  
**Proposal:** [dual-session-id.md](./dual-session-id.md)  
**Author:** Jeffrey Carlson  
**Status:** Review Complete — Recommended with Modifications

---

## Summary Judgment

The core problem is real and the solution direction is sound. A container-owned identifier is the right answer for multi-ad page management. However, the proposal conflates two distinct concepts — a *routing key* and a *slot identifier* — in a single field, and some of the implementation details need tightening before this goes into the spec. My recommendations below change the shape slightly but preserve all the stated benefits.

---

## Answers to the 5 Questions

### Q1: Should `containerSessionId` be required in the bootstrap, or truly optional?

**Required in the bootstrap. Optional in the `createSession` echo.**

Here's the distinction that matters: if a container sends `containerSessionId` in the bootstrap, that field is now part of *this container's* protocol dialect. Making it optional in the bootstrap creates an awkward two-class world where some containers use it and some don't, and the creative SDK has to handle both branches in its echo logic.

Stronger rule: **if the container supports dual-ID (i.e., it's running SHARC 0.2+ or whatever version ships this), it always sends `containerSessionId` in the bootstrap.** Old containers (v0.1) simply don't send it. The creative detects presence, not a flag. This is cleaner than "optional field that might or might not be there in any given container version."

In the implementation, `initChannel()` should accept a `containerSessionId` parameter that defaults to `null`. If non-null, it's included in the bootstrap `postMessage`. The creative SDK checks `event.data.containerSessionId` in `_onBootstrapMessage` and stores it if present.

---

### Q2: If the creative doesn't echo `containerSessionId` back in `createSession` — what does the container do?

**Accept and proceed. Log the absence. Do not reject.**

Rejection here would be wrong for two reasons:

1. **SIMID compatibility is a stated design goal.** SIMID creatives cannot echo a field they've never heard of. Rejecting them on this basis would silently break the entire SIMID backward compat story.

2. **The `containerSessionId` is not a trust or security primitive.** The architecture doc is explicit: the MessagePort *is* the trust boundary, not any session ID. Rejecting for a missing echo would assign security semantics to a field that doesn't have them.

The right behavior: the container stores `containerSessionId` from the bootstrap regardless. If the creative echoes it in `createSession`, validate that the echoed value matches what was sent (it should, if the SDK is functioning correctly — mismatch indicates a bug in the creative SDK). If the creative doesn't echo it, the container already has it from bootstrap and can proceed fine.

**One nuance:** If the echoed `containerSessionId` *doesn't match* what the container sent, that's worth a reject. It indicates either a creative SDK bug or an unexpected cross-contamination scenario. Add error code semantics for this — probably a new code or `INIT_SPEC_VIOLATION` (2210) is close enough.

---

### Q3: Should `containerSessionId` appear in ALL subsequent messages, or only in `createSession`?

**Only in bootstrap and `createSession`. Not in subsequent messages.**

The current message structure is:
```javascript
{ sessionId, messageId, timestamp, type, args }
```

The `sessionId` in every message serves as the per-session correlation key. Adding `containerSessionId` to every message would be redundant once the session is established — the container already knows the mapping of `sessionId ↔ containerSessionId` from the `createSession` handshake.

Including it in all messages has a real cost: it's another field the container must validate on every incoming message, which adds a check to `_onPortMessage` in the hot path. For a protocol that explicitly values simplicity, that's worth avoiding.

**The right model:** The container maintains an internal map of `sessionId → containerSessionId` after `createSession`. All lookups from there use the existing `sessionId`. The `containerSessionId` surfaces in logging, analytics, and any container-internal multi-session management — never as a per-message field after handshake.

---

### Q4: Is this worth proposing to the SIMID working group now, or after SHARC ships?

**After SHARC ships. Not now.**

Reason: the SIMID working group will have more leverage and interest if there's a working reference implementation demonstrating the pattern in production. Proposing it now means proposing a concept with no implementation evidence. You'll get procedural debate, not technical engagement.

There's also a sequencing argument in the other direction: SHARC's implementation of this feature will surface edge cases (what happens when you have a multi-ad page with a mix of SIMID and SHARC creatives sharing a container manager?) that are better resolved in the SHARC impl before they become SIMID spec text.

One exception to "wait": if someone on the SIMID working group is actively working on multi-ad scenarios right now, it's worth a casual mention to avoid parallel divergent designs. But don't submit a formal proposal yet.

---

### Q5: Any naming concerns — `containerSessionId` vs `slotId` vs `adUnitId`?

**Rename it. `containerSessionId` is the wrong abstraction.**

This is the most substantive naming issue in the proposal, and it's worth getting right before it lands in the spec.

`containerSessionId` conflates two different things:

1. **A slot/position identifier** — "leaderboard at top of page," "sticky footer" — which is *static*, exists before any creative loads, and persists across multiple ad loads in the same slot.

2. **A container session identifier** — scoped to a specific creative load in a specific slot — which is *dynamic*, created fresh for each ad, and destroyed when the creative terminates.

The proposal is actually describing concept #1 (a slot-level namespace the container assigns), but naming it like concept #2 (a session-scoped thing). This will cause confusion for implementers and make the spec harder to explain.

**Recommendation: `slotId`.**

- It's short and obvious
- It correctly signals that this is a container-assigned slot identifier, not a session artifact
- It's a concept that maps cleanly to ad server terminology (`slotId`, `adSlot`, `placement`)
- It doesn't suggest session lifecycle semantics that don't apply

If the working group wants to keep "session" in the name to emphasize that this is per-session and not persistent, `containerSlotSessionId` is worse, not better. Go with `slotId`.

---

## Implementation Challenges and Edge Cases

### 1. Bootstrap message structure change

`initChannel()` currently sends:
```javascript
creativeWindow.postMessage(
  { type: 'SHARC:port', version: '0.1.0' },
  targetOrigin,
  [this._channel.port2]
);
```

Adding `slotId` is straightforward:
```javascript
creativeWindow.postMessage(
  { type: 'SHARC:port', version: '0.2.0', slotId: this._slotId || null },
  targetOrigin,
  [this._channel.port2]
);
```

No structural issues here. **But:** `SHARCContainer` currently doesn't accept a `slotId` in its constructor options. That needs to be added to the constructor and threaded through to `initChannel()`. The constructor change is a one-liner; just make sure it's in the `options` destructuring and documented in JSDoc.

### 2. `acceptSession()` must store and validate the echo

Currently `acceptSession()` only validates and stores `sessionId`. It needs to:
1. Accept the incoming `createSession` args (currently just `msg.sessionId`, but `createSession` args are in `msg.args` — double-check the message structure)
2. Read `msg.args.slotId` (the echo) if present
3. Compare against `this._slotId`
4. Log a warning or reject if there's a mismatch

**Edge case:** The current `acceptSession()` reads `createSessionMsg.sessionId` directly from the top-level message. Looking at `_onPortMessage`, the `sessionId` field at the top level is the creative's session ID — that's correct. The slot ID echo would come from `msg.args`. Verify the `createSession` message schema allows `args` to carry the echo. Right now `createSession` is sent as:

```javascript
// Creative side:
return this._sendMessage(ProtocolMessages.CREATE_SESSION, {});
// args is always empty {}
```

The creative SDK needs to populate `args` with `{ slotId: this._slotId }` when it has a slot ID. That's a change to `SHARCCreativeProtocol.createSession()`.

### 3. The creative SDK API surface *does* change slightly

The proposal claims "zero API surface change for creative developers." That's mostly true but not entirely:

- The creative SDK internally stores and echoes the slot ID — that's transparent.
- But if a creative developer wants to *read* the slot ID (e.g., for their own logging), there's no way to access it in the current API. This may be fine for v1, but worth deciding explicitly: is `slotId` exposed via the creative SDK or is it purely internal?

If it's internal: document that explicitly so no one builds on it.
If it's exposed: add `SHARC.getSlotId()` or surface it in the `onReady` callback's first argument alongside `env`.

My recommendation: expose it as a read-only property on the creative SDK. Creative developers *will* want it for their own analytics, and giving them a reliable way to access it is better than them scraping it themselves from the bootstrap message.

### 4. Multi-ad page race condition

Consider this scenario: a page loads 3 ads simultaneously. The container manager assigns `slotId` values `slot-A`, `slot-B`, `slot-C`. All three creatives start their `createSession` flow roughly in parallel.

The current `_handleCreateSession` in `SHARCContainer` is not re-entrant — but each `SHARCContainer` instance manages exactly one ad, so this is fine. Each `SHARCContainer` has its own `SHARCContainerProtocol` instance with its own `_port`. No cross-session contamination is possible through the existing architecture.

**The actual risk is at the layer above** — whatever owns multiple `SHARCContainer` instances needs to key its session registry by `slotId`, not just by `sessionId`. If that registry is keyed only by creative-generated `sessionId`, you get the exact collision scenario the proposal describes (astronomically unlikely but real). The proposal is correct that `slotId` solves this, but the fix is in the container *manager* (the app-level code above `SHARCContainer`), not in `SHARCContainer` itself. Worth calling this out explicitly in the spec so implementers know where the mapping lives.

### 5. Fallback transport path

The fallback `postMessage` transport in `SHARCContainerProtocol._sendMessage()` bypasses `initChannel()` — it sets up a `_fallbackTarget` but doesn't send a bootstrap message with `slotId`. In practice, the fallback path also doesn't send a `SHARC:port` bootstrap at all, since there's no port to transfer.

This means the `slotId` delivery mechanism (bootstrap message) is silently absent in the fallback path. The creative would receive no `slotId` and echo nothing back. This is arguably fine — the fallback is a zero-real-world-cases path — but it should be documented explicitly so no one debugs a missing `slotId` in a fallback scenario for hours.

### 6. Version negotiation

The proposal is additive and non-breaking. But it doesn't address what a container should do if it sends `slotId` in the bootstrap and receives a `createSession` from a creative SDK that's too old to know about `slotId`. 

Answer: nothing special. The container already has `slotId` from bootstrap. The creative not echoing it is fine per Q2 above. No version negotiation needed — the container is always the source of truth for `slotId`.

But there *is* a version mismatch risk in the other direction: a new creative SDK that sends `slotId` in `createSession` talking to an old container that doesn't know about `slotId`. The old container's `acceptSession()` will ignore the `args` payload entirely (it only reads `createSessionMsg.sessionId`). The extra field in `args` is harmlessly ignored. No action needed, but worth noting in the spec change log.

---

## Risks

| Risk | Severity | Notes |
|---|---|---|
| Naming (`containerSessionId` vs correct name) | **High** | Fix this before the spec is published — naming is hard to change post-publication |
| Creative echoing wrong `slotId` (SDK bug) | Medium | Container should validate the echo; add mismatch handling to `acceptSession()` |
| Implementers putting `slotId` in all subsequent messages | Medium | Spec must be explicit: `slotId` is handshake-only, not a per-message field |
| `slotId` leaking creative-queryable status without explicit decision | Low | Decide whether creative SDK exposes `slotId` as a read-only property |
| Fallback transport missing `slotId` | Low | Documented gap; fallback is practically unused |

---

## What Needs to Change in the Implementation

In priority order:

1. **`SHARCContainer` constructor** — accept `slotId` in options, store as `this._slotId`
2. **`SHARCContainerProtocol.initChannel()`** — include `slotId` in bootstrap message (null if not provided)
3. **`SHARCCreativeProtocol._onBootstrapMessage()`** — read and store `event.data.slotId`
4. **`SHARCCreativeProtocol.createSession()`** — echo `slotId` in args if present
5. **`SHARCContainerProtocol.acceptSession()`** — validate echoed `slotId` matches; log or reject on mismatch
6. **Architecture doc** — add `slotId` to the message structure reference and bootstrap handshake diagram
7. **`ProtocolMessages` or new constant** — add `SLOT_ID_MISMATCH` as a named error case (probably reuse `INIT_SPEC_VIOLATION` 2210)

The creative SDK change to `createSession()` is the only one that touches a public method signature — but since it's purely additive (args goes from `{}` to `{ slotId: ... }` conditionally), it's non-breaking.

---

## Verdict

Ship it. The problem is real, the solution is correct, and the implementation delta is small. The naming should change to `slotId` before it reaches the spec. Answer Q2 as "accept and proceed" — don't block SIMID compat over an optional echo. Keep it out of subsequent messages — the container already has what it needs after the handshake.

The cleanest version of this feature is simpler than the proposal describes: the container assigns a slot ID, sends it in the bootstrap, the creative SDK echoes it once in `createSession`, the container validates the echo and maps `sessionId → slotId` internally, and that's it. Everything after that uses `sessionId` as the message-level key and `slotId` as the container-level key. No field duplication, no per-message overhead, no semantic confusion.
