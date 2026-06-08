# SHARC Container→Creative State-Delivery Contract

**Status:** Accepted — ratified by Jeffrey 2026-06-07. Decisions 1–3 and 5 ratified; decision #4 confirms the current `terminated → hidden` terminal mapping. Implemented in PR #342.
**Type:** Normative specification (test-enforced contract). NOT an ADR footnote — this document is the durable, long-lived contract for the container→creative lifecycle-state channel; the conformance test plan in §9 IS the executable spec.
**Date:** 2026-06-07
**Author:** Software Architect (Dev Team)
**RFC-2119:** MUST / MUST NOT / SHOULD / SHOULD NOT / MAY are used per RFC 2119.

**Implemented by:** R1 (ADR `0.7.10-unified-state-replay-r1.md`) delivers D1/D2/D3. **This contract AMENDS R1** with the option-B send-layer dedup (§3), which corrects R1's double-`active` asymmetry. R1 + the dedup land together (§10).
**Canonical state graph:** `0.7.10-lifecycle-state-mapping-audit.md` §2 (the legal transition graph and ordering) is the normative source for §5 here.

---

## 1. Purpose and scope

### 1.1 What this contract governs

The **container→creative lifecycle-state channel**: how a SHARC container delivers its current lifecycle state (`ready`/`active`/`passive`/`hidden`/`frozen`) to the creative running in its iframe, over the established `SHARCCreativeProtocol` MessagePort session, such that:

- every creative — including one that establishes its session AFTER the container has already reached a state — observes the **correct current state exactly once**, and
- every subsequent live transition flows without latching, and
- a `stateChange` listener registered late is brought up to date exactly once.

### 1.2 What this contract does NOT govern

- The router **phase** line (`init→…→omid-active→…→terminated`). Phases are monotonic and non-oscillating (audit §1.2); they are a separate state space and out of scope here.
- The creative→container direction (commands, queries, `getContainerState()` request/response).
- Bridge-internal mapping (MRAID `viewableChange`, SafeFrame `geom-update`, OMID session signals). Bridges are **consumers** of this channel; their correctness follows from this contract but their internal rules live in the audit (§3) and bridge specs.
- bfcache MessagePort liveness (audit R3) — characterized in §8, NOT closed here.
- Readiness-timing (`#335` — the handshake never completing in-window). This contract delivers state correctly **once a session is established**; it does not cause a session to establish.

### 1.3 Audience

The container implementation (`sharc-container.js`, `sharc-protocol.js`), the creative SDK (`sharc-creative.js`), every creative-side bridge, and the conformance test suite that enforces this document.

---

## 2. Definitions

| Term | Definition |
|---|---|
| **Session** | An established protocol session between one container and one creative iframe, identified by a non-empty `sessionId` (`sharc-protocol.js:919`). A creative with `sessionId === ''` has **no session**. |
| **Lifecycle state** | One of `loading`, `ready`, `active`, `passive`, `hidden`, `frozen`, `terminated` (`ContainerStates`, the container state machine). |
| **Creative-queryable state** | A lifecycle state the creative is permitted to observe: `{ ready, active, passive, hidden, frozen }` (`CREATIVE_QUERYABLE_STATES`, `sharc-protocol.js:136-142`). `loading` and `terminated` are **non-queryable** for the purposes of the query API, but see §6 for `terminated` **delivery**. |
| **`stateChange`** | The container→creative message (`ContainerMessages.STATE_CHANGE`) carrying `{ containerState }`, delivered to creative-side `SHARC.on('stateChange', …)` listeners. The **latching** current-state event. |
| **Delivery** | A `stateChange` value reaching the creative's event bus (`_emit`) and thus its listeners. A message dropped at the session gate (`sharc-protocol.js:494-501`) is **NOT delivered**. |
| **Sent** | A `stateChange` message passed to `_sendMessage` by `sendStateChange` (`sharc-protocol.js:834`). The send layer is where the option-B dedup lives. |
| **Replay** | Delivering the last-known state to a newly-registered listener once at registration time, without re-driving the live bus (§7). |
| **Establish push (D1)** | The container's unconditional `sendStateChange(currentState)` after session-establish in `_handleStartCreativeResolved` (`sharc-container.js:3776-3779`). |
| **Transition send** | The `sendStateChange(newState)` fired from the `setState` gate on a successful transition (`sharc-container.js:1759-1761`). |

---

## 3. The option-B send-layer dedup (THE exactly-once rule)

### 3.1 Normative invariants

> **INV-1 (Exactly-once consecutive).** The container MUST NOT deliver two **identical consecutive** `stateChange` values on a single session. For any session, if the most recently *sent* state is `S`, a subsequent `sendStateChange(S)` MUST be suppressed (not sent).

> **INV-2 (Distinct values always flow).** The dedup MUST suppress ONLY a value identical to the immediately-preceding sent value on the same session. A `stateChange` whose value differs from the last sent value MUST be sent. Re-asserting a value after an intervening *different* value MUST be sent (the dedup is consecutive-only, NOT set-membership; the channel is non-latching — §5.4, §7.4).

> **INV-3 (Symmetric single `active`).** After §3.2 is implemented, BOTH the normal LOADING→ACTIVE transition path AND the already-ACTIVE/#336 path MUST deliver `active` to the creative **exactly once**. The pre-dedup R1 asymmetry (normal path delivers `active` twice: transition send + D1 establish push; already-ACTIVE path delivers once) is eliminated.

### 3.2 Where the dedup lives and how it works (normative implementation)

The dedup is a **send-layer** mechanism in `SHARCCreativeProtocol.sendStateChange` (`sharc-protocol.js:824-835`). It tracks the last-sent queryable state **per session** and short-circuits an identical consecutive send.

**Touch-points (for the implementation that follows ratification):**

1. **New instance field `_lastSentState`** on `SHARCCreativeProtocol`, initialized to `undefined`. It MUST be reset to `undefined` everywhere `this.sessionId` is set or cleared, so it is strictly **per-session**:
   - constructor init alongside `this.sessionId = ''` (`sharc-protocol.js:291`),
   - session establish (`sharp-protocol.js:919`, where `this.sessionId = providedId`),
   - session teardown / reset (`sharc-protocol.js:593`, where `this.sessionId = ''`).
   Resetting on establish guarantees the FIRST send on a new session is never deduped against a stale prior-session value (per-session isolation, §8).

2. **The dedup check in `sendStateChange`** (`sharc-protocol.js:824-835`), inserted **after** the queryable guard and the `sessionId === ''` no-op, **before** `_sendMessage`:

   ```
   sendStateChange(containerState):
     if containerState NOT IN CREATIVE_QUERYABLE_STATES: warn; return        // existing
     if this.sessionId === '': return                                        // existing (no-op, native/plain-HTML)
     if containerState === this._lastSentState: return                       // NEW — INV-1 dedup
     this._lastSentState = containerState                                    // NEW — record
     this._sendMessage(STATE_CHANGE, { containerState })                     // existing
   ```

   Ordering within the function is normative: the queryable guard and the session no-op MUST run **before** the dedup (a non-queryable value or a sessionless container must short-circuit without touching `_lastSentState`).

### 3.3 Why this site is correct (interaction proof)

Both state-emitting paths route through this single function — confirmed in code:

- **Transition send** — `setState` gate calls `this._protocol.sendStateChange(newState)` (`sharc-container.js:1759-1761`).
- **Establish push (D1)** — `_handleStartCreativeResolved` calls `this._protocol.sendStateChange(r1State)` (`sharc-container.js:3776-3779`).

Therefore a last-sent dedup inside `sendStateChange` is the single chokepoint that sees every send. Path analysis:

| Path | Sends through `sendStateChange` | Net delivered `active` |
|---|---|---|
| **Normal LOADING→ACTIVE** | transition send `active` (sets `_lastSentState='active'`) → then D1 push `active` (**deduped** by INV-1) | **1** |
| **Already-ACTIVE / #336** (adapter promoted to ACTIVE before handshake; `_transitionToActive` skips `setState`, so NO transition send) | D1 push `active` (only send; `_lastSentState` was `undefined`/`ready`) | **1** |

Both paths now deliver `active` exactly once → INV-3 (symmetry) holds. The dedup does **not** weaken D1's completeness guarantee (§4): on the already-ACTIVE path the establish push is the only `active` send and is NOT deduped (the prior sent value is not `active`).

### 3.4 What the dedup MUST NOT do

- It MUST NOT be a set-membership filter (would break INV-2 / non-latching oscillation — §5.4). It is strictly **last-sent only**.
- It MUST NOT live on the container state machine or in `setState` (that would not catch the D1 push, which originates outside `setState`). It MUST live at the send layer.
- It MUST NOT persist across sessions (per-session reset, §3.2.1).
- It MUST NOT be implemented as "make D1 conditional on whether a transition occurred" — that approach (the reviewer-rejected option) reverts #336's already-ACTIVE-skip handling. **Option B (this dedup) is chosen precisely because it preserves D1's unconditional push.**

---

## 4. Completeness — late-establishing creative MUST get current state (#334/#336)

> **INV-4 (Establish completeness).** A creative that establishes its session AFTER the container has already reached a creative-queryable state MUST receive that current state. The container MUST issue the establish push (D1) unconditionally on session-establish — i.e. regardless of whether a state transition occurred at establish time.

> **INV-5 (Establish→push ordering vs the session gate).** The establish push MUST be issued at a point where the creative's session is fully established — i.e. its `sessionId` is set from `Container:init` — so the push passes the creative-side session-validation gate (`sharc-protocol.js:494-501`). The normative site is `_handleStartCreativeResolved` (`sharc-container.js:3776-3779`), which runs after `startCreative` resolves and therefore after the creative has set its `sessionId`.

**Rationale (the decisive port-gate fact, from the R1 ADR):** a `stateChange` sent *before* the creative has set its `sessionId` (e.g. a mid-handshake `setState(ACTIVE)` emitted in the same tick as init) is **dropped at the gate** (`sharc-protocol.js:498`: `sessionId !== this.sessionId`) and is therefore never delivered. No creative-side replay can recover a message dropped at the gate. The establish push at `_handleStartCreativeResolved` is the earliest container-side site guaranteed to be past that gate.

**Interaction with D2 (`Container:init.currentState`):** D2 (§4.1) covers the complementary case where the container is already past `ready` *at init-send time*; D1 covers the corpus case where the adapter promotes to ACTIVE *after* init is sent. Together they cover both orderings.

### 4.1 Real `currentState` in `Container:init` (D2)

> **INV-6 (Honest init seed).** The `currentState` field in the `Container:init` envelope MUST carry the container's REAL current queryable state at init-send time, NOT a hard-coded value. If the current state is non-queryable, the field MUST carry `ready` (the queryable floor). Implementation: `sharc-container.js:3632` (already present in R1).

This is a **value** change, not a wire change (§9 / STOP-AND-ASK). It lets a bridge subscribing in `onReady` seed its cache synchronously from `env.currentState`.

---

## 5. Ordering invariants (from the canonical graph)

The legal graph (audit §2): `loading → ready → active ⇄ passive ⇄ hidden → frozen → {active|passive|hidden} → … → terminated`. The following are the **creative-facing delivery** ordering rules.

> **INV-7 (`ready` precedes `active`).** The creative MUST NOT be delivered `active` before it has been delivered (or seeded with) `ready`. `ready` is the queryable floor; the establish push and init seed never deliver a queryable state below `ready`.

> **INV-8 (No premature viewability).** A bridge MUST NOT signal viewability/active-equivalent (MRAID `isViewable===true` / `viewableChange(true)`; SafeFrame first `geom-update`) before the container has delivered `active`. Because viewability is driven off delivered `active` (audit §3), satisfying INV-3/INV-4 satisfies this; the test asserts the bridge-facing ordering.

> **INV-9 (Queryable floor before `ready`).** The creative MUST NOT observe a queryable state that implies viewable/default (i.e. anything at/above `ready`) before `ready` is established. `loading` is non-queryable and is never delivered (§6); the first delivered/queryable value is `ready`.

> **INV-10 (Oscillation is non-latching and repeatable).** The oscillating edges — `active⇄passive`, `active⇄hidden`, `hidden⇄frozen` (audit §2.1) — MUST continue to flow on every traversal. Each *distinct* state on an oscillation MUST be delivered. The dedup (§3) MUST NOT suppress a distinct value; it suppresses only an identical *consecutive* repeat (INV-2). Re-entering `active` after `passive`/`hidden`/`frozen` MUST deliver `active` again (the intervening different value resets the consecutive comparison).

> **INV-11 (`terminated` is terminal).** Only `→ terminated` is terminal. After `terminated` is delivered (§6), no further `stateChange` MUST be delivered on that session.

---

## 6. Queryable-state gate

> **INV-12 (Queryable-only on the wire).** `sendStateChange` MUST refuse to send any state not in `CREATIVE_QUERYABLE_STATES` (`sharc-protocol.js:825-828`). `loading` MUST NOT be delivered (it is the pre-`ready` bootstrap state the creative cannot act on; the creative's effective first state is `ready`).

> **INV-13 (`terminated` delivery exception).** `terminated` is **non-queryable** for the `getContainerState()` query API, but the creative MUST be notified exactly once that the session is ending. The container MUST deliver the terminal notification through the lifecycle channel (current behavior maps `terminated` to a `hidden` `stateChange` with a warn at the container, audit §3 / state table row TERMINATED). **Normative requirement:** the creative MUST receive **exactly one** terminal lifecycle signal and MUST NOT receive any `stateChange` after it (INV-11). **Implementation note / STOP-AND-ASK candidate:** the current `terminated→hidden` mapping is preserved by this contract as-is; if a future change introduces a first-class `terminated` `stateChange` value, that would be a delivery-semantics change to re-ratify here (it is NOT required by this contract).

**What the creative sees, by state:**

| Container state | Queryable? | Delivered to creative? | Creative observes |
|---|---|---|---|
| `loading` | No | No | nothing (pre-`ready`) |
| `ready` | Yes | Yes | `ready` (the floor) |
| `active` | Yes | Yes (exactly once per entry) | `active` |
| `passive` | Yes | Yes | `passive` |
| `hidden` | Yes | Yes | `hidden` |
| `frozen` | Yes | Yes | `frozen` (then quiet — bridges suppress further while frozen) |
| `terminated` | No (query) | Yes, **as one terminal signal** (current: `hidden`) | one terminal `stateChange`, then nothing (INV-11/13) |

---

## 7. Replay-on-subscribe (D3)

> **INV-14 (Replay exactly once).** A `stateChange` listener registered AFTER a state exists for the session MUST receive the current (last-known) state exactly once, synchronously, at registration (`sharc-creative.js:524-525`).

> **INV-15 (Replay scope = lifecycle `stateChange` only).** Replay MUST be scoped to the latching `stateChange` event. One-shot events — `containerError`, `log`, `close`, `placementTransitionEnd` — MUST NOT be replayed. (Replaying a stale error/log/close to a late listener is semantically wrong.)

> **INV-16 (Replay does not re-drive the live bus).** Replay MUST deliver to the **registering listener only**. It MUST NOT re-`_emit` to existing listeners and MUST NOT re-enter the live subscription path. The channel is non-latching: replay reflects the last value but does not cause the live bus to re-fire.

> **INV-17 (Replay reflects the LAST value).** The replayed value MUST be the most-recent delivered state (`_lastContainerState`), not the first. After `active → hidden`, a late subscriber MUST be replayed `hidden`.

> **INV-18 (Replay never precedes `ready`).** A creative MUST NOT receive a replayed `stateChange` before its cache is seeded — the cache is seeded in `_handleInit` (`sharc-creative.js:320`) from a real queryable `env.currentState`, or on the first inbound `Container:stateChange` (`:238`). Replay therefore fires at/after `ready`.

> **INV-19 (No double-fire under interleaving).** For any interleaving of {init-seed, inbound `stateChange`, late `on('stateChange')` registration}, a listener MUST receive the current state exactly once (no duplicate from seed-then-replay or event-then-replay). Bridges remain idempotent (MRAID flips `viewableChange` only on `_isViewable` change), so even a defensive double would be a no-op — but the contract requires exactly-once at the bus.

**Cache lifecycle (creative side):** `_lastContainerState` initialized `undefined` (`sharc-creative.js:158`), seeded in `_handleInit` (`:320`) and on every inbound `stateChange` (`:238`), replayed in `on()` (`:524-525`). It is per-creative-session; it MUST be reset if the session is torn down.

---

## 8. Per-session isolation

> **INV-20 (Strict per-session state).** Lifecycle state delivery MUST be strictly scoped to the owning session. No container MUST deliver one session's state to another session/placement. The session gate (`sharc-protocol.js:494-501`) — which drops any inbound message whose `sessionId` ≠ the creative's own — is the boundary and MUST remain unchanged.

> **INV-21 (Per-session dedup + cache state).** The send-layer `_lastSentState` (§3) and the creative-side `_lastContainerState` (§7) MUST be per-session and MUST be reset on session establish/teardown, so no value leaks across a session boundary (a re-established session starts with a clean dedup/cache).

> **INV-22 (No cross-placement observability).** Each container owns one `SHARCCreativeProtocol`, one `sessionId`, one MessagePort. `sendStateChange` posts only on that container's own port. There MUST be no path by which one placement observes another's lifecycle state. (This contract changes *when/how reliably* a creative receives **its own** state, never *what* is observable.)

---

## 9. No wire / schema change (confirmation + STOP-AND-ASK)

> **INV-23 (No wire change).** This contract MUST be satisfiable with the existing `Container:init` envelope and existing message types. CONFIRMED:
> - The `currentState` field **already exists** in the `Container:init` envelope (`sharc-container.js:3632`); D2 changes its **value** (real state vs hard-coded `ready`), not its name/type/position. **NOT a wire change.**
> - The dedup (§3) adds an internal instance field (`_lastSentState`) and a guard inside `sendStateChange`. **No message format change.**
> - Replay (§7) reuses the existing `stateChange` message and the existing `on()` API. **No new message type, no new field.**

**STOP-AND-ASK items for Jeffrey (ratification gate):**

1. **[CONFIRM — no wire change] ✅ Recommended: approve as no-wire-change.** The contract is satisfiable with the existing envelope and message types (INV-23). Nothing here requires a schema/wire change. *Flagging explicitly per the "no wire change without asking" rule — but the answer is: none required.*
2. **[RATIFY — option-B dedup amends R1].** Approve the send-layer last-sent dedup (§3) as the chosen fix for R1's double-`active` asymmetry, over the reviewer-rejected "make D1 conditional" (which would revert #336). This is the one behavioral amendment to R1.
3. **[RATIFY — D1 unconditional push] (carried from R1 STOP-AND-ASK 1).** The container emits `stateChange(currentState)` on every session-establish even absent a transition. Idempotent for bridges; the dedup (§3) ensures it does not double on the normal path. Recommend approve (it is the #336 source-fix).
4. **[CONFIRM — `terminated` delivery semantics].** This contract preserves the current `terminated → hidden` mapping for the terminal signal (INV-13). Confirm that is the intended terminal semantics, or flag if a first-class `terminated` `stateChange` value is wanted (that WOULD be a delivery-semantics re-ratification, and arguably a wire-value change).
5. **[CONFIRM — replay scope].** Lifecycle `stateChange` only; one-shot events excluded (INV-15). Confirm.

---

## 10. Edge-case → expected-delivered-sequence matrix

Each row maps to one conformance test (§11). "Delivered" = what reaches creative `on('stateChange')` listeners (post-dedup, post-gate). Subscriptions assumed at/after `onReady` unless the row says "late".

| # | Scenario | Expected delivered `stateChange` sequence | Invariants | Test |
|---|---|---|---|---|
| E1 | **already-ACTIVE before handshake** (adapter promotes LOADING→ACTIVE pre-handshake; `_transitionToActive` skips `setState`) | `active` (×1, via D1 only) | INV-3, INV-4, INV-5 | C1, C2, T1, V1 |
| E2 | **normal LOADING→ACTIVE transition** (transition send + D1 push) | `active` (×1, post-dedup — D1's identical-consecutive push suppressed) | INV-1, INV-3 | C5, T10 |
| E3 | **rapid toggles** `active→passive→active→hidden→active` | `active, passive, active, hidden, active` (each distinct delivered; none wrongly deduped) | INV-2, INV-10 | C6, T6, N5, V4 |
| E4 | **re-assert same state** (consecutive identical, e.g. `active` then `active` with no intervening value) | `active` (×1; the second suppressed) | INV-1 | C7 |
| E5 | **late subscribe after active** (listener registered after `active` delivered) | replay `active` (×1) to the new listener | INV-14, INV-17 | N1, T4 |
| E6 | **re-subscribe N times** (N listeners register late) | each of the N listeners replayed the current state once; bounded (one per registration) | INV-14, INV-19 | N6, T7 |
| E7 | **init `currentState` seeding** (`env.currentState==='active'` at init) | cache seeded `active`; a post-init `stateChange` listener replayed `active`; non-queryable seed (`loading`) NOT seeded → no replay | INV-6, INV-9, INV-14, INV-18 | C4, N2 |
| E8 | **terminated** | one terminal signal (current: `hidden`) ×1; no `stateChange` after | INV-11, INV-13 | C8 |
| E9 | **freeze→restore** (`active→hidden→frozen→…→active`) | `active, hidden, frozen` on entry; `active` on restore (distinct from `frozen`, delivered) | INV-10, INV-2 | C9, T5 |
| E10 | **native-SHARC / plain-HTML sessionless** (`sessionId===''`) | **nothing** — no establish push, `sendStateChange` no-ops (no throw); local state still transitions for operator `onStateChange` | INV-12 (no-op), §3.2 | C3 |

**Notes on the matrix:**
- E2 is the option-B payoff: pre-dedup R1 delivered `active` ×2 here; post-dedup ×1, matching E1 (symmetry, INV-3).
- E3/E9 prove the dedup is consecutive-only: `active` reappears after a *different* value and MUST be delivered (INV-2).
- E9's freeze entry currently walks `active→hidden→frozen` (audit §2.2 G-A: no direct `ACTIVE→FROZEN` edge); the `hidden` is a real delivered transient. That edge-graph question is audit Rec R2, **out of scope** for this contract — this contract specifies delivery semantics over whatever transitions the graph emits.

---

## 11. Conformance test plan (the executable spec)

Legend: **RED→GREEN** = fails pre-implementation, passes after. **GREEN-guard** = passes today, pinned against regression. **node** = jsdom-expressible. **validator** = real renderer + real cross-origin (puppeteer-tier). One test per invariant + one per edge case; many invariants share a test where the assertion is the same observable.

### 11.1 Node — send-layer dedup (NEW `test/node/test-state-dedup.js`)

| ID | Tier | Type | Asserts | Invariant / edge |
|---|---|---|---|---|
| **D-1** | node | RED→GREEN | `sendStateChange('active')` twice consecutively on one session ⇒ `_sendMessage` called once | INV-1, E4 |
| **D-2** | node | RED→GREEN | `active`→`passive`→`active` ⇒ three sends (consecutive-only, distinct flow) | INV-2, INV-10, E3 |
| **D-3** | node | RED→GREEN | normal path: transition send `active` then D1 push `active` ⇒ one send; already-ACTIVE path: D1 push `active` only ⇒ one send (**symmetry assertion**) | INV-3, E1, E2 |
| **D-4** | node | GREEN-guard | non-queryable (`loading`/`terminated`) ⇒ refused before touching `_lastSentState` | INV-12 |
| **D-5** | node | GREEN-guard | `sessionId===''` ⇒ no-op, `_lastSentState` untouched, no throw | INV-12, E10 |
| **D-6** | node | RED→GREEN | `_lastSentState` reset on session establish AND teardown ⇒ first send on a new session never deduped against a prior session's value | INV-21, INV-20 |

### 11.2 Node — container source / establish push (NEW `test/node/test-container-state-establish-push.js`)

| ID | Tier | Type | Asserts | Invariant / edge |
|---|---|---|---|---|
| **C1** | node | RED→GREEN | `_handleStartCreativeResolved` with state already ACTIVE (skip path) ⇒ exactly one `Container:stateChange('active')` sent | INV-4, E1 |
| **C2** | node | RED→GREEN | `active` delivered only post-`acceptSession` (sessionId set); a state sent pre-sessionId is dropped at the gate | INV-5, E1 |
| **C3** | node | GREEN-guard | native/plain-HTML (`sessionId===''`) ⇒ `sendStateChange` no-ops; local transition still fires `onStateChange` to operator | INV-12, E10 |
| **C4** | node | RED→GREEN | set ACTIVE pre-init ⇒ `Container:init.currentState==='active'` (not hard-coded `ready`); non-queryable current ⇒ field is `ready` | INV-6, INV-9, E7 |
| **C5** | node | RED→GREEN | normal LOADING→ACTIVE end-to-end through container ⇒ creative receives `active` exactly once (transition + D1, deduped) | INV-1, INV-3, E2 |
| **C6** | node | RED→GREEN | drive `active→passive→active→hidden→active` ⇒ creative receives all five distinct in order | INV-2, INV-10, E3 |
| **C7** | node | RED→GREEN | re-assert `active` twice with no intervening value ⇒ creative receives one | INV-1, E4 |
| **C8** | node | GREEN-guard→RED→GREEN | drive to terminate ⇒ creative receives exactly one terminal signal (current: `hidden`), and NO `stateChange` after | INV-11, INV-13, E8 |
| **C9** | node | RED→GREEN | `active→hidden→frozen→active` ⇒ `active, hidden, frozen, active` delivered (restore `active` not deduped against `frozen`) | INV-2, INV-10, E9 |

### 11.3 Node — creative bus replay (NEW `test/node/test-creative-state-replay.js`)

| ID | Tier | Type | Asserts | Invariant / edge |
|---|---|---|---|---|
| **N1** | node | RED→GREEN | `on('stateChange', fn)` after inbound `active` ⇒ `fn` replayed `active` once | INV-14, E5 |
| **N2** | node | RED→GREEN | `_handleInit` with `env.currentState==='active'` seeds cache ⇒ post-init listener replayed `active`; `env.currentState==='loading'` ⇒ NOT seeded, no replay | INV-6, INV-18, E7 |
| **N3** | node | GREEN-guard | one-shot events (`containerError`, `log`, `close`, `placementTransitionEnd`) NOT replayed to late listeners | INV-15 |
| **N4** | node | RED→GREEN | replay reflects LAST state: `active`→`hidden` ⇒ late listener replayed `hidden` | INV-17, E9 |
| **N5** | node | GREEN-guard | live subscription still toggles after a replay (offscreen→onscreen→offscreen) — replay does not latch/unsubscribe live path | INV-16, INV-10, E3 |
| **N6** | node | RED→GREEN | N late listeners each replayed current state once (bounded: one replay per registration; no cross-fire) | INV-14, INV-19, E6 |

### 11.4 Node — MRAID bridge contract (TRANSFER T1–T10 from `2045117`, re-targeted to R1+dedup)

These pin the **bridge-observable** contract (unchanged assertions; delivery path now channel-based, dedup-respecting).

| ID | Tier | Type | Asserts | Invariant / edge |
|---|---|---|---|---|
| **T1** | node | RED→GREEN | seed-from-active ⇒ `isViewable()===true` + exactly one `viewableChange(true)` | INV-3, INV-8, E1 |
| **T2** | node | GREEN-guard | seed-from-non-active ⇒ `isViewable()===false`, no `viewableChange` | INV-8 |
| **T3** | node | GREEN-guard | `default ≠ false` invariant (`default`+viewable `true` coexist) | INV-8 |
| **T4** | node | RED→GREEN | late `on('stateChange')` replay drives `viewableChange(true)` | INV-14, E5 |
| **T5** | node | RED→GREEN | replay respects last value (active→offscreen ⇒ replay `false`/`hidden`) | INV-17, E9 |
| **T6** | node | GREEN-guard | non-latching toggle offscreen→onscreen→offscreen→onscreen toggles each time (**binding non-latch proof**) | INV-10, INV-16, E3 |
| **T7** | node | GREEN-guard | no double-fire across interleavings (seed-then-event, event-then-seed) | INV-19, E6 |
| **T8** | node | GREEN-guard | ordering: `ready`/`default` precede `viewableChange` | INV-7, INV-8 |
| **T9** | node | GREEN-guard | defensive fallback (no/rejecting delivery API ⇒ no throw, live-only) | INV-16 |
| **T10** | node | GREEN-guard | regression: single forward `active` flips once (and dedup does not suppress a genuine first `active`) | INV-1, INV-3, E2 |

### 11.5 Validator / puppeteer (real adapter promotion — cannot be jsdom)

| ID | Tier | Type | Asserts | Invariant / edge |
|---|---|---|---|---|
| **V1** | validator | RED→GREEN | **DV-sample false→true** with the late probe (t=1500ms): MRAID `isViewable` moves `default+false → default+true` for every case reaching `active` (PROVEN 5/5 in R1). Late probe committed to harness. | INV-3, INV-4, INV-8, E1 |
| **V2** | validator | RED→GREEN | synthetic interstitial fixture (gates start on `isViewable()===true`) hangs baseline, proceeds under R1 (TRANSFER from `2045117`) | INV-4, INV-8, E1 |
| **V3** | validator | RED→GREEN | **SafeFrame parity** (#339): synthetic SafeFrame creative behind adapter-promotes-before-handshake gets its first `geom-update` (baseline: never) | INV-4, INV-8, E1 |
| **V4** | validator | validator-if-feasible | dynamic toggle under real intersection: `isViewable` `true→false→true` e2e (belt-and-suspenders on non-latching; node T6/C9 are the binding proofs) | INV-10, E3 |

### 11.6 Coverage map (every invariant has ≥1 binding test)

| Invariant | Binding test(s) |
|---|---|
| INV-1 (exactly-once consecutive) | D-1, C5, C7, T10 |
| INV-2 (distinct always flows) | D-2, C6, C9 |
| INV-3 (symmetric single active) | D-3, C1, C5, T1, V1 |
| INV-4 (establish completeness) | C1, C2, T1, V1, V2, V3 |
| INV-5 (establish→push ordering vs gate) | C2 |
| INV-6 (honest init seed) | C4, N2 |
| INV-7 (ready precedes active) | T8 |
| INV-8 (no premature viewability) | T1, T2, T3, T8, V1, V2, V3 |
| INV-9 (queryable floor before ready) | C4, N2 |
| INV-10 (non-latching oscillation) | D-2, C6, C9, T6, N5, V4 |
| INV-11 (terminated terminal) | C8 |
| INV-12 (queryable-only gate) | D-4, D-5, C3 |
| INV-13 (terminated delivery exception) | C8 |
| INV-14 (replay exactly once) | N1, N6, T4 |
| INV-15 (replay scope) | N3 |
| INV-16 (no re-drive live bus) | N5, T6, T9 |
| INV-17 (replay last value) | N4, T5 |
| INV-18 (replay never precedes ready) | N2 |
| INV-19 (no double-fire) | N6, T7 |
| INV-20 (per-session isolation / gate unchanged) | D-6, C2 |
| INV-21 (per-session dedup+cache reset) | D-6 |
| INV-22 (no cross-placement) | covered by INV-20 gate tests + container single-protocol architecture (no new test surface needed) |
| INV-23 (no wire change) | structural — asserted by C4 (value not schema) + absence of any new message type in the suite |

**Split:** node D-1..D-6 + C1..C9 + N1..N6 + T1..T10; validator V1–V3 (V4 if feasible).

---

## 12. Channel Coverage (generalized invariant)

**Generalized invariant:** the contract's "no redundant consecutive identical notification" applies not only to the container→creative `stateChange` channel but to **each adapter's value-typed lifecycle output**. Every channel that emits a value-typed lifecycle signal SHOULD suppress a redundant consecutive identical emission; the container→creative `stateChange` channel is the first to be formally deduped here, and the adapter-level channels are tracked for the same treatment.

**Per-channel status table:**

| Channel | Status |
|---|---|
| container→creative `stateChange` | **Deduped (this contract)** ✓ |
| MRAID `viewableChange` | edge-guarded ✓ |
| MRAID `stateChange` | **NOT deduped** — fires unconditionally; SHARC `active`+`passive` both map to MRAID `'default'` → spec-incorrect double → tracked **#343** |
| MRAID `audioVolumeChange`, `sizeChange` | no same-value guard → **#343** |
| SafeFrame `focus-change` | transition-only ✓ |
| SafeFrame `geom-update` | assess (may be intentional geometry sample) → **#343** |
| OMID `geometryChange` | rate-limited ✓ |
| OMID `sessionStart`/`loaded`/`impression`/`sessionFinish` | one-shot flags ✓ |
| container `onStateChange` (operator) | transition-based ✓ |

**Note:** adapter-level dedup is tracked HIGH in **#343**; the CI-flaky nav fixture is **#344**.

---

## 13. Migration note

- **R1 + the dedup land together.** The send-layer dedup (§3) is an amendment to R1, not a separate release. Shipping R1's double-`active` (E2 = 2×) and then fixing it would expose the asymmetry to integrators between releases. Land D1+D2+D3 (R1) and the `_lastSentState` dedup as one change, with §11's tests green.
- **The per-bridge #334 `getContainerState()` seed stays retired** (R1 ADR §"Retiring the #334 seed"). The channel now delivers state directly; the bridge no longer polls. This also keeps audit F9 (poll hangs during freeze) closed. T1–T10 remain (re-targeted), proving the bridge-observable contract is unchanged.
- **Pre-1.0:** no alias/deprecation. The dedup is internal; no public API changes.
- **Out of scope (stay open):** #335 (readiness-timing), #337/audit F4 (terminate-order), #338/audit R3 (bfcache dead-port relinking), audit R2 (direct `ACTIVE→FROZEN` edge), audit R4 (single restore authority). This contract specifies *delivery semantics over the channel*; it does not change the transition graph or channel liveness.

---

## 14. Cross-links

- **Implements:** R1 ADR `0.7.10-unified-state-replay-r1.md` (D1/D2/D3). **This contract amends R1** with §3 (option-B dedup).
- **Canonical graph + ordering:** `0.7.10-lifecycle-state-mapping-audit.md` (§1 ordering, §2 graph, §3 per-surface map, Rec R1).
- **Tests:** `test/node/test-state-dedup.js`, `test/node/test-container-state-establish-push.js`, `test/node/test-creative-state-replay.js`, `test/node/test-mraid-visibility-seed.js` (re-targeted T1–T10), validator V1–V3.
