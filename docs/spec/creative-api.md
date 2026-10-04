<!-- SHARC-DOC-STATUS: NORMATIVE -->

# SHARC Creative API Specification

**SHARC Specification 1.0 (Draft)**

| Field | Value |
|---|---|
| Spec version | **1.0-draft** — one spec version shared by the three SHARC Specification documents. Independent of the npm package version; bumps **only on normative change**. Editorial and informative changes bump a document revision, not the spec version. |
| Document | L2 — Creative API (optional conformance class: Creative (wire)) |
| Status | **DRAFT** |
| Companion documents | L1 — [SHARC Container Runtime Specification](container-runtime.md) (mandatory conformance class); SHARC Compat Profile Specification (optional add-on profile) |

## Conventions

The keywords MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) **when, and only when, they appear in all capitals**. Lower-case "must" / "should" / "may" are non-normative prose.

<!-- trace: source=docs/proposals/creative-sources.md §Conventions (same block as the L1 front matter, per skeleton L2 §2.1 row) | gate=NO-GATE (definitional) -->

## Versioning policy

Stated once for all three documents in the L1 [Container Runtime Specification](container-runtime.md), Versioning policy.

## Extraction status (informative)

This document is being assembled by editorial extraction from the existing normative-of-record estate, per the ratified traceability skeleton (`docs/design/0.8.0-g1-spec-traceability-skeleton.md` §B). Filled sections carry a traceability footer (`<!-- trace: source=… | gate=… -->`) naming the estate source and the pinning test gate; sections marked RESERVED name their source and land in a later slice.

- §§2.2–2.7 and Appendix A were extracted from `docs/api-reference.md` in slice 1 and carried temporarily as Part 2 of the L1 document; slice 3 re-homes them here. The text is moved as-is except where an editorial note records a correction against the reference implementation.
- §2.8 is moved from `docs/design/state-delivery-contract.md` (now HISTORICAL). Reference-implementation file/line anchors are dropped: this document states the contract at the wire and creative-library level.
- The protocol-layer enforcement bounds that slice 1 parked in Part 2 §2.2 move to the L1 security model (L1 §1.11.9), per skeleton row 1.11 (source: api-reference.md §2 Security Guarantees).
- Requirements whose named gate has no test that actually pins them are not stated as pinned: they carry a `GATE-DESIRED` flag.
- Where the reference implementation disagrees with the estate, the standing rule is: descriptive prose is corrected to match the implementation, with an editorial note citing src; a source MUST that the implementation violates stays a MUST and carries `DIVERGENCE (implementation bug; GATE-DESIRED)`; a MUST the extraction would have invented or promoted reverts to the source wording. Places where the estate itself does not settle which side is intended carry `DIVERGENCE (ruling required)`. Nothing is silently resolved in either direction. A DIVERGENCE whose fix is tracked cites its issue number.
- Three spec rulings, ratified 2026-10-03, are folded in: Ruling 1 (the navigation handoff code is `2214`, and `2105` is reserved; §2.6, §2.13), Ruling 2 (`reportInteraction`: source MUST list restored, redirect cap and `statusCode` deleted, two required macros; §2.6), and Ruling 3 (two deliberate MUST promotions: the `2212` timeout, §2.4, and `requestNavigation` URL validation, §2.6). Each change carries an editorial note citing its ruling.
- Row 2.11 (lifecycle event payloads) is retired from L2 by ruling. Its source is container-side and re-homes to L1 in slice 3b; §2.11 keeps a one-line pointer.

---

## Creative API (L2)

### 2.1 Scope, audience, and the wire-format / SDK separation

This document specifies the **creative wire protocol**: the messages a SHARC container and a creative exchange over an established session, their payload shapes, their ordering, and the state-delivery invariants that govern them. It is written for anyone implementing the creative side of a SHARC session (a creative-side library, a compatibility bridge, or a creative that speaks the protocol directly) and for the container implementer, who must emit and accept these messages.

The normative content of this document is the **wire format**, stated so that a third party can implement a conforming creative-side library without reading the reference implementation's JavaScript. The reference creative SDK (`sharc-creative.js`) is one such library. Its JavaScript API (`SHARC.onReady`, `SHARC.on(...)`, `SHARC.requestFeature(...)`, and so on) is **not** normative; it is described only in the informative annex (§2.14). Where a requirement here is stated in terms of a creative-side library's observable behavior (replay-on-subscribe, §2.8.5; readiness replay, §2.9), it binds any conforming creative-side library, not the reference SDK's particular API names.

**Conformance class.** Creative (wire) is an OPTIONAL conformance class: a creative that does not speak the SHARC protocol (plain HTML) is still loadable by a conforming container under L1. "SHARC Core conforming" means satisfying L1 + L2. The conformance clause itself, including the profile-governance rule, is L1 §1.3. The reference SDK is not a conformance class.

**Supersession.** Together with L1, this document supersedes the SHARC-legacy WG Technical Spec's Messaging Protocol, Establishing a New Session, and Error Codes sections. The delta register is L1 §1.4. Deltas surfaced while harvesting are noted inline: serialization (§2.2), late-establishment recovery (§2.4), and creative error codes (§2.13).

<!-- trace: source=NEW-PROSE (framing; skeleton §E item 5) + skeleton decision 4 (wire-format/SDK separation) + skeleton §F (conformance classes) | gate=NO-GATE (definitional) -->

### 2.2 Protocol layers

SHARC is a bidirectional, session-scoped message protocol between a **container** (the publisher's secure rendering environment — an iframe or WebView) and a **creative** (the ad markup running inside that container).

The container controls the environment. The creative requests actions. The container decides whether to honor them.

**Platform scope (v1):** Web iframes, iOS WKWebView, Android WebView.

#### Protocol layers

The protocol has three layers:

- **Data layer**: the message dictionary shared by primary and response messages (§2.3).
- **Transport layer**: a dedicated `MessageChannel` port pair, with structured-clone serialization (§2.4).
- **Session layer**: a creative-owned session identifier. The creative mints the `sessionId` in `createSession` (§2.4), and every message in the session carries it.

> Reference implementation (informative): when the host page exposes a container-minted placement session ID (`window.__sharcPlacementSessionId__`, a UUID v4), the reference SDK adopts it as the `sessionId` instead of minting a fresh one, so that every SDK realm in a renderer-provisioned iframe converges on one session. Source: `src/sharc-protocol.js` `createSession` (~:1385–1396).

Each container instance owns exactly one session: one port, one `sessionId`. Concurrent ads on a page are concurrent container instances, and no session observes another's traffic (§2.8.7).

> Editorial note (supersession delta, Legacy §Messaging Protocol): the legacy draft carried messages as JSON strings over `window.postMessage`, and described one media container multiplexing several concurrent sessions. Both are superseded. Transport is a `MessageChannel` with structured clone, and concurrency is one session per container instance.

#### Protocol enforcement bounds

The container's protocol-layer enforcement bounds on this channel (inbound rate limit, pending-response cap, `createSession` session-ID format, URL-scheme validation for `requestNavigation` and `reportInteraction`, and feature-name format) are specified in **L1 §1.11.9**, as part of the container trust model. A creative-side library observes them as dropped messages, failed sends, and rejects. The rejects are listed per message in §2.6.

#### Message flow summary

```
Container                                           Creative
    │                                                   │
    │  [creates iframe/WebView, loads creative]          │
    │                                                   │
    │◄──────────── SHARC:Creative:createSession ─────────│
    │───────────── resolve (createSession) ─────────────►│
    │                                                   │
    │───────────── SHARC:Container:init ────────────────►│
    │◄──────────── resolve (init) ───────────────────────│
    │                                                   │
    │───────────── SHARC:Container:startCreative ───────►│
    │◄──────────── resolve (startCreative) ──────────────│
    │                                                   │
    │  [makes container visible] ─────────────────────── │
    │───────────── SHARC:Container:stateChange {active} ►│
    │                                                   │
    │◄──────────── [creative runs, sends requests] ──────│
    │                                                   │
    │───────────── SHARC:Container:close ───────────────►│
    │◄──────────── resolve (close) ──────────────────────│
    │  [container terminates the creative] ─────────── │
```

<!-- trace: source=api-reference.md §2 (Protocol Overview; its Security Guarantees bullets now live in L1 §1.11.9) + Legacy §Messaging Protocol (Data/Transport/Session layers harvested; JSON-over-postMessage and multi-session-per-container superseded) | gate=test:container-state-establish-push C2 (real MessageChannel port pair; a stateChange sent while the creative's sessionId is still '' is dropped, and is delivered once it is set — partial: no test sends a non-empty mismatched sessionId, GATE-DESIRED); test:protocol-attachport-idempotent (port transport); test:non-sharc-loading §7d (no session → no init flow, fail-closed only) — test:protocol-router (cross-frame window.postMessage router, L1 §1.7/§1.11) and test:smoke (artifact importability) annotated out: neither pins the session wire -->

### 2.3 Message data structure

All SHARC messages — primary and response — share a common structure.

#### Primary message

```typescript
interface Message {
  sessionId: string;         // UUID identifying this session
  messageId: number;         // Sender's sequence counter, starting at 0
  timestamp: number;         // Date.now() at send time
  type: string;              // Message type (e.g., "SHARC:Container:init")
  args?: any;                // Message-specific arguments
}
```

- `sessionId` — set by the creative when it generates the session ID in `createSession`. All messages in the session carry the same `sessionId`.
- `messageId` — each party maintains its own independent counter. Container and creative `messageId` values will diverge. First message is `0`; the sender increments the counter by 1 for each message it sends, primary and response alike.

> Editorial note (added from src): the source stated only that each party keeps an independent counter starting at `0`. The increment rule (one per message sent, primary and `resolve`/`reject` alike) is added from the reference implementation: `src/sharc-protocol.js` `_sendMessage` (`this._nextMessageId++`, ~:455) and `_resolve` / `_reject` (~:498, ~:519).
>
> Reference implementation (informative): `_sendMessage` increments the counter (~:455) before the pending-response cap check (~:466). A send that fails locally at the cap (L1 §1.11.9) therefore still consumes a `messageId`, and the peer observes a gap in the sender's sequence. A receiver cannot assume the sequence is gap-free.
>
> Editorial note (stale claim corrected): the source example carried `args.changePlacement = { containerDimensions, inline }`, a pre-intent shape. `requestPlacementChange` args are intent-based (§2.6); the example now uses them. Source: `src/sharc-container.js` `_handleRequestPlacementChange` (destructures `intent`, `targetDimensions`, …).
- `timestamp` — milliseconds since epoch. Should be set as close to the triggering event as possible; do not assume it is exact.

**Example:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 3,
  "timestamp": 1748930400000,
  "type": "SHARC:Creative:requestPlacementChange",
  "args": {
    "intent": "resize",
    "targetDimensions": { "width": 320, "height": 480 }
  }
}
```

#### resolve message

Sent by the receiver to acknowledge successful processing of a primary message.

```typescript
interface ResolveMessage {
  sessionId: string;
  messageId: number;
  timestamp: number;
  type: "resolve";
  args: {
    messageId: number;  // messageId of the message being resolved
    value?: any;        // Optional response data
  };
}
```

#### reject message

Sent by the receiver when it cannot or will not process the message.

```typescript
interface RejectMessage {
  sessionId: string;
  messageId: number;
  timestamp: number;
  type: "reject";
  args: {
    messageId: number;  // messageId of the message being rejected
    value: {
      errorCode: number;    // See L1 §1.18
      message?: string;     // Optional explanation
    };
  };
}
```

> GATE-DESIRED: no test asserts the envelope fields, the per-sender `messageId` counter, or the `resolve` / `reject` correlation shape. Every protocol suite drives messages through this envelope, but none asserts it field by field.

<!-- trace: source=api-reference.md §4 (Message Data Structure) | gate=NO-GATE (GATE-DESIRED: envelope, messageId counter, resolve/reject shape) — test:smoke and test:protocol-router annotated out (neither tests the envelope) -->

### 2.4 Transport and session establishment

#### MessageChannel transport

SHARC uses `MessageChannel` as its primary transport. This creates a private, dedicated port pair between the container and the creative — no broadcasting to `window`, no collision risk from other iframes.

The handshake, stated at the wire level:

1. The container loads the creative in its sandboxed iframe (token composition is variant-specific — see L1 §1.11.9; the security-critical invariant is that the Creative URL path omits `allow-same-origin`).
2. On the creative-rendered signal, the container creates a `MessageChannel`, keeps `port1`, and posts a bootstrap message to the creative window: `{ type: 'SHARC:Container:handshake', version, placementSessionId? }`, with `port2` in the transfer list. The creative-rendered signal is the iframe `load` event on the Creative URL variant, and the renderer's `:rendered` report on the Creative Markup variant (L1 §1.7). The target origin is variant-specific. On the Creative URL variant it is `'*'`: the bootstrap carries no sensitive data, only the `MessagePort`. On the Creative Markup variant it is the construction-validated renderer origin, because `'*'` would leak the port and the `placementSessionId` to whatever document occupies the iframe.
3. The creative listens for a `message` event whose `data.type` is `'SHARC:Container:handshake'`. It rejects the bootstrap unless `event.source` is its parent window, and, when it is configured with a trusted origin, unless `event.origin` matches it. It then adopts `event.ports[0]`, starts it, and sends `createSession` over the port. A handshake message without a port is ignored.
4. All subsequent SHARC messages flow through the dedicated port. The bootstrap `postMessage` is the only message sent outside the port; it is re-posted, with the same session identity, only to relink the port after a back/forward-cache restore.

> Editorial note (stale claims corrected): the source gave the bootstrap as `{ type, version: '1.0' }` posted with `targetOrigin: '*'` after the creative document's `load`, and called it the only broadcast. Against the reference implementation: (1) `version` carries `SHARC_VERSION`, the container implementation's version, which is what the L1 Versioning policy defines the field to carry (ruled 2026-10-04), and the bootstrap also carries `placementSessionId` when the container has one (`src/sharc-protocol.js` `SHARC_VERSION` :30, `initChannel` ~:780–800). (2) The `MessageChannel` is created inside `initChannel`, at the creative-rendered signal, not before load (`initChannel`). (3) The Markup variant posts to the renderer origin, not `'*'`, and is triggered by `:rendered`; only the URL variant posts `'*'` on iframe load (`src/sharc-container.js` ~:3795–3812 and ~:2577). (4) The bfcache relink re-posts the bootstrap (`src/sharc-container.js` ~:6365–6390). (5) The creative-side `event.source` check and the optional `SHARC_CONFIG.trustedOrigin` pin are added from `src/sharc-protocol.js` ~:1188–1205.

#### Fallback: window.postMessage

If `MessageChannel` is unavailable (effectively zero real-world cases on supported platforms), the parties fall back to raw `postMessage` on `window`. The container must then filter incoming messages by origin (against the trusted creative origin) and by `sessionId` to handle multiple concurrent sessions.

#### Serialization

Both `MessageChannel` and `postMessage` use the browser's **Structured Clone** algorithm automatically. Do **not** call `JSON.stringify` or `JSON.parse`. Pass the message object directly.

#### SHARC:Creative:createSession

Sent when the creative is ready to begin SHARC communication. This is the first message in every session.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:**

```typescript
interface CreateSessionArgs {
  placementType?: "inline" | "interstitial";  // Default: "inline"
  version: string;                             // Implementation version of the creative-side library
}
```

- `placementType` — the creative's self-declared placement type. `"inline"` (default) means the ad is anchored in page content. `"interstitial"` means the ad overlays content. Omitting the field is equivalent to `"inline"`.
- `version` — the version of the creative-side library implementation that sends the message. It is not the spec version (L1 Versioning policy, ruled 2026-10-04). A container can use it for diagnostics or implementation-specific compatibility handling.

> Reference implementation (informative): the reference SDK sends its package version (for example `0.7.13`) here, and the reference container records it for diagnostics only. This is the implementation version the field is defined to carry.

The creative generates a unique `sessionId` (UUID) and includes it in this message. All subsequent messages in the session use this same `sessionId`.

**resolve** — Container acknowledges and will proceed to send `Container:init`.

When the `createSession` timeout is armed (`requireSharcInit: true`, the default), a container that receives no `createSession` within `timeouts.createSession` (default **5 seconds**, see L1 §1.19) MUST fatal-error with `2212` and terminate.

> Editorial note: MUST promotion ratified 2026-10-03 (Ruling 3). The source (api-reference.md §8) stated this descriptively ("the container terminates with error 2212"), and slice 1 had promoted it without a record. The requirement is scoped to the armed timeout, so a container constructed with `requireSharcInit: false` (permissive mode, below) is conformant without it. The reference container conforms: the timeout calls `_handleFatalError(NO_CREATE_SESSION)`, which sends `SHARC:Container:fatalError` and then terminates, with a 1 s force-terminate (`src/sharc-container.js` `_startSessionTimeout` ~:6514–6519, `_handleFatalError` ~:5399–5411).

**Example createSession message:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 0,
  "timestamp": 1748930400000,
  "type": "SHARC:Creative:createSession",
  "args": {
    "placementType": "inline"
  }
}
```

#### Session-establishment delays, late establishment, and duplicates

- **Strict mode (default).** A container in its default configuration terminates with `2212` when `createSession` does not arrive within the window (see above). A creative that establishes late does not recover the session.
- **Permissive mode** (`requireSharcInit: false`; operator-selected, L1). The `createSession` fatal timeout is not armed, and a creative that sends `createSession` late is accepted. The session establishes and the init sequence proceeds even if the container has already advanced its state without a handshake (the non-handshake `loading` → `active` route, L1 §1.8.2). The late creative still receives its current state, by the establish push of the state-delivery contract (§2.8.3).
- **Duplicate `createSession`.** In both modes, a second `createSession` that arrives after a session was accepted is a protocol violation. It is ignored with a developer-channel warning: no `reject` is sent on the wire. The original session and its `sessionId` remain in force.

> GATE-DESIRED: the strict-mode **termination** leg of the `2212` MUST is unpinned. `test:non-sharc-loading` §1 (`test/node/test-non-sharc-loading.js` ~:153) asserts that the `onError(2212)` callback fires, not that the container sends `fatalError` and terminates. The permissive-mode late-accept legs (§4–§7) assert only a developer-console warning, which is skipped in production builds.
>
> GATE-DESIRED: the duplicate-`createSession` "no `reject` is sent on the wire" clause is unpinned. `test:non-sharc-loading` §7b/§7c assert the warning and the preserved `sessionId`; neither observes the port. Source: `src/sharc-container.js` `_handleCreateSession` (the unconditional guard warns and returns without a reply, ~:4020–4029).

> Editorial note (supersession delta, Legacy §Establishing a New Session): the legacy draft let a creative that missed the window recover mid-playback by default, with the container retaining the creative and its handler. That posture is superseded by the strict default above. Recovery survives only as the operator-selected permissive mode. The legacy VAST-error-tracker and SSAI/live zero-timeout prose is dropped, since video is out of L2 scope.

<!-- trace: source=api-reference.md §3 (Transport Layer) + §8 (createSession) + Legacy §Establishing a New Session (recovery posture harvested and superseded; VAST/SSAI prose dropped per skeleton row 2.4) + src/sharc-container.js _handleCreateSession (permissive late accept; unconditional duplicate guard) + src/sharc-protocol.js initChannel / bootstrap listener (handshake corrections) | gate=test:non-sharc-loading (§1 onError(2212) only — the Ruling 3 MUST's fatalError + termination leg GATE-DESIRED; §2 permissive no-fatal; §4–§7 permissive late handshake: dev-console warning only, skipped in prod; §7b/§7c duplicate createSession ignored with a warning in both modes, sessionId preserved — "no reject on the wire" GATE-DESIRED); test:creative-sdk-singleton (b) (creative adopts event.ports[0] from a SHARC:Container:handshake, incl. relink); test:creative-protocol-placement-type §1 (createSession placementType defaults to inline); test:creative-validator-url-lifecycle-gates (classifier bucket `declared-sharc-no-handshake`, not 2212-specific); test:container-state-establish-push C1 (partial: a sendStateChange call spy with no session — the establish push is issued even when the container is already active; not a wire witness) — test:smoke annotated out per #440 review (does not pin the 2212 window) -->

### 2.5 Container → creative messages

Messages sent from the container to the creative use the `SHARC:Container:*` namespace.

#### SHARC:Container:init

Sent after `createSession` is resolved. Provides the creative with all environment data needed to initialize.

**Direction:** Container → Creative
**Requires response:** Yes — `resolve` or `reject`

**Args:**

```typescript
interface ContainerInitArgs {
  environmentData: EnvironmentData;  // See §2.7
  supportedFeatures?: Array<string | Feature>;  // Extensions this container supports — names or descriptors (§2.10)
}
```

**resolve** — Creative acknowledges the initialization data. The container then sends `startCreative`.

**reject** — Creative cannot initialize (wrong version, incompatible dimensions, etc.). The reject carries the standard reject value (§2.3): `{ errorCode, message? }` (see L1 §1.18 for codes).

> Editorial note (stale claim corrected): the source gave the init reject payload as `{ errorCode, reason? }`. On the wire, every reject — including an init reject — carries `args.value = { errorCode, message? }` (§2.3); the reference SDK rejects init with `message` (`src/sharc-protocol.js` `_reject`). The same applies to the `startCreative` reject below.

If the creative does not respond within the timeout window (default **2 seconds**), the container treats it as a fatal error (code `2208`) and terminates. A creative `reject` of `init` is also fatal: the container raises a fatal error with the reject's `errorCode` (falling back to `2104`) and terminates.

> Editorial note (added from src): the init-reject → fatal path is stated in the source only as "Creative cannot initialize". The container behavior is `src/sharc-container.js` ~:4194–4201 (`_handleFatalError(rejectValue.errorCode || CANNOT_EXECUTE_CREATIVE)`).

#### SHARC:Container:startCreative

Sent after `init` is resolved. Signals the creative to make itself visible and begin the ad experience.

**Direction:** Container → Creative
**Requires response:** Yes — `resolve` or `reject`

The creative should respond immediately. The container makes the iframe/WebView visible upon receiving `resolve`.

**resolve** — Creative is ready to display. No additional args required.

**reject** — Creative cannot start (standard reject value `{ errorCode, message? }`, §2.3).

If the creative does not respond within the timeout window (default **2 seconds**), the container terminates with error `2213`.

#### SHARC:Container:stateChange

Sent whenever the container state changes (L1 §1.8), subject to the state-delivery contract (§2.8). The creative receives this message to update its behavior accordingly.

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface ContainerStateChangeArgs {
  containerState: "ready" | "active" | "passive" | "hidden" | "frozen";
}
```

The container MUST NOT send `stateChange` carrying `loading` or `terminated` — the creative cannot receive messages in those states.

#### SHARC:Container:placementChange

Sent when the container's placement properties change (usually in response to a `requestPlacementChange` from the creative).

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface ContainerPlacementChangeArgs {
  placementUpdate: PlacementUpdate;
  transition?: TransitionHint;               // Animation timing applied (if any)
  closeButtonPosition?: CloseButtonPosition; // Position of the container's close button, when one is rendered
}

interface PlacementUpdate {
  width?: number;    // DIPs — current container width
  height?: number;   // DIPs — current container height
  position?: { x: number; y: number; width: number; height: number }; // The iframe's current on-screen rect (DIPs)
  intent: "resize" | "expand" | "fullscreen" | null;                  // The container's current placement intent
  [field: string]: any; // Other fields of the container's current placement record, passed through flat
}

interface CloseButtonPosition {
  position: string;  // Resolved position, e.g. "top-right"
  x: number;         // DIPs — the close button's on-screen origin
  y: number;         // DIPs
  width: number;     // DIPs (50)
  height: number;    // DIPs (50)
}
```

`placementUpdate` is flat. `width` / `height` are the current container size. `position` is the iframe's current on-screen rect, offset by any host screen offset (L1 §1.16). `intent` is the container's current placement intent, or `null` in the default placement. A compatibility bridge uses `intent` to derive its placement state for operator-initiated changes (for example, the container's own close button collapsing an expand).

The `closeButtonPosition` field enables OMID `addFriendlyObstruction` registration — the creative (or OMID bridge) can report the close button's exact position to the verification vendor.

> Editorial note (stale claims corrected): the source typed `placementUpdate` as `CurrentPlacement = { containerDimensions: { x, y, width, height, anchor? }, inline, standardSize? }`, and `closeButtonPosition` as `{ position, rect: { x, y, width, height } }`. Neither shape is sent. The reference container sends `placementUpdate` as a flat copy of its current placement record, with the requested `width` / `height` merged in, `position` enriched from the iframe rect, and `intent` stamped (#391/#404). Compatibility bridges read `placementUpdate.width` / `.height` / `.position` / `.intent`. `closeButtonPosition` is flat: `{ position, x, y, width: 50, height: 50 }`. Sources: `src/sharc-container.js` `_buildPlacementChangePayload` (~:2201–2230), `notifyPlacementChange` (~:2239), and the `closeButtonPosition` construction in `_handleRequestPlacementChange` (~:5024–5031).
>
> Pinned (partial): the flat `placementUpdate.position` and its host-offset fold are pinned by `test:host-placement-integration` §5 (`_buildPlacementChangePayload` returns the iframe rect, and the rect plus the host screen offset once one is set) and §11 (the ACTIVE re-sync hook, `_syncPlacementState`, sends the buffered placement once with the folded `position` in the sent args, and an unchanged re-sync is deduped). Neither observes the wire: §5 calls the payload builder directly, and §11 uses a stubbed protocol sender.

#### SHARC:Container:log

Informational message from the container. Primarily for debugging.

**Direction:** Container → Creative
**Requires response:** No

**Args:** `{ message: string }`

Messages prefixed with `"WARNING:"` indicate that the container has detected a spec deviation or performance issue in the creative's behavior.

#### SHARC:Container:placementConstraintsChange

Sent when placement constraints change mid-session (device rotation, browser resize, publisher policy update). Allows the creative to update its understanding of what the container allows.

**Direction:** Container → Creative
**Requires response:** `resolve` (no value)

**Args:**

```typescript
interface PlacementConstraintsChangeArgs {
  maxWidth: number | null;
  maxHeight: number | null;
  allowedIntents: string[];
  requireCloseRegion: boolean;
  allowOffscreen: boolean;
  reason: "rotation" | "viewportResize" | "policyUpdate";
}
```

The container debounces resize/orientation events (200ms) to avoid flooding the creative during drag-resize. A `policyUpdate` is sent immediately, without the debounce.

> Editorial note (stale claims corrected): the source nested the constraint fields under a `constraints` object and marked the message "Requires response: No". On the wire the fields are **flat** in `args` (the same shape as the `getPlacementConstraints` resolve value, §2.6, plus `reason`), and the message is in the reference protocol's response-required set, which the reference SDK honors by resolving with `{}`. Sources: `src/sharc-container.js` `_sendConstraintsChange` / `updatePlacementPolicy`; `src/sharc-protocol.js` `MESSAGES_REQUIRING_RESPONSE`; `src/sharc-creative.js` placementConstraintsChange listener.

| `reason` | Trigger | Creative should... |
|----------|---------|-------------------|
| `rotation` | Device orientation change | Re-check if current placement still fits |
| `viewportResize` | Browser/app window resize | Re-check if current placement still fits |
| `policyUpdate` | Publisher changed policy mid-session | Re-query constraints, may need to `collapse` |

#### SHARC:Container:placementTransitionEnd

Sent when a container-side placement animation completes (or immediately if animation is skipped). Every placement change request that includes a `transition` field produces exactly one `placementTransitionEnd` event — no hanging states.

**Direction:** Container → Creative
**Requires response:** `resolve` (no value)

**Args:**

```typescript
interface PlacementTransitionEndArgs {
  finalDimensions: {
    width: number;   // DIPs
    height: number;  // DIPs
  };
}
```

> DIVERGENCE (implementation bug, #456; GATE-DESIRED): the sentence above is lower-case prose, not an RFC-2119 requirement. The spec's intent is that every placement change request carrying a `transition` produces exactly one `placementTransitionEnd`. The reference container sends `placementTransitionEnd` only from the `resize` and the non-fullscreen `expand` branches, so a `fullscreen` or `collapse` request that carries a `transition` never produces one (#456). No test pins the statement. Source: `src/sharc-container.js` `_handleRequestPlacementChange` (`skippedTransitionEndDimensions` is never set in the `fullscreen` or `collapse` branches).

There is no `placementTransitionStart` event — the creative already knows when a transition begins (it is the moment `requestPlacementChange()` resolves). A separate start event would be fragile: if the app backgrounds mid-animation, the creative would receive a start with no corresponding end, creating a hanging state.

> Editorial note (stale claim corrected): the source marked this message "Requires response: No". It is in the reference protocol's response-required set (`src/sharc-protocol.js` `MESSAGES_REQUIRING_RESPONSE`), and the reference SDK resolves it with `{}`.

#### SHARC:Container:effectiveVisibilityChange

The core effective-visibility channel. Sent when the container's single effective-visibility composer recomputes — the container-side surface every visibility consumer (MRAID, SafeFrame, OMID) reads instead of computing its own. The composer folds the raw visibility axes (in-page IntersectionObserver ratio, parent-page visibility, and the in-app host-exposure input) into one integer percent.

**Direction:** Container → Creative
**Requires response:** No (fire-and-forget; a rejected send is swallowed)

**Args:**

```typescript
interface EffectiveVisibilityChangeArgs {
  effectivePercent: number;              // Composed effective visibility, integer [0, 100]
  reason: string | null;                 // Raw SHARC EV reason token, or null when fully visible
  visibleRectangle: object | null;       // Visible rect of the creative, or null when not applicable
}
```

`reason` is the raw SHARC effective-visibility token — one of `'offscreen'` / `'backgrounded'` / `'frozen'` / `'notAttached'` — that explains a `0%` (or otherwise non-obvious) `effectivePercent`. It is `null` only when the creative is fully visible (the rounded effective percent is 100). A partial view carries `'offscreen'`. Creative-side listeners receive this token unchanged (wire-honesty); mapping to the OM SDK `adView.reasons` vocabulary (`offscreen` → `clipped`, `notAttached` → `notFound`, `frozen`/`backgrounded` → `backgrounded`) happens only where the value crosses into OMID. Deduped on `(effectivePercent, reason)`; the last value is cached and replayed to late subscribers, and a preloaded creative receives the current value on activation. Not sent before a session exists (no creative listener).

> Editorial note (stale claims corrected): (1) The source said `reason` is `null` "when visible". In the reference container it is `null` only at a rounded 100%; any partial view is `'offscreen'` (`src/sharc-container.js` ~:4613–4621). (2) `visibleRectangle` is always present and always `null` in the reference container; populating it is deferred to G6 (`src/sharc-container.js` ~:4641). (3) The source's lower-case "listeners receive this token unchanged" is restored. The extraction draft had promoted it to a MUST.
>
> Pinned: the `reason` rules corrected in (1) are pinned at the container-side handoff by `test:effective-visibility-composer`. `reason === null` only at a rounded 100 is block 11b (`0.999` rounds to 100 with `reason === null`). A partial view carrying `'offscreen'` is blocks 2, 3, 8 and 11. The presence of `visibleRectangle` is pinned (block 8); its `null` value is never asserted (GATE-DESIRED).
>
> GATE-DESIRED: the creative-receive leg of wire-honesty has no pin. The container-send leg is pinned only at the container-side handoff: `test:effective-visibility-composer` asserts the raw `reason` on the payload handed to a stubbed protocol sender (`mockProtocol`), not on the wire. `test:omid-reasons-vocab` drives a fake bus, and `test:effective-visibility-wire-hop` asserts only `effectivePercent`.

#### SHARC:Container:audioVolumeChange

Notifies the creative of a host-reported audio-state change while the creative is running.

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface AudioVolumeChangeArgs {
  volumePercentage: number;  // Integer, clamped to [0, 100]
  volume: number;            // volumePercentage / 100, in [0, 1]
  isMuted: boolean;          // Tracked independently — muting does NOT zero the volume
}
```

Sent live only in the `active`/`passive` states. In `loading`, `ready`, and `hidden` the values are buffered into `EnvironmentData` (`volumePercentage`, `volume`, `isMuted`). Values buffered in `loading` also ride the `Container:init` `environmentData`. Buffered values are delivered on the next activation. In `frozen`/`terminated` the input is dropped (JS is suspended or the protocol is gone).

> Editorial note (stale claim corrected): the source grouped `hidden` with the "pre-interactive" states. `hidden` is not pre-interactive (a creative can be `hidden` after it has run), so the states are now named. The source's "delivered on the next activation" is kept as the intent; see the DIVERGENCE below. Source: `src/sharc-container.js` `setAudioState` (`READY`/`HIDDEN` buffer branch).
>
> DIVERGENCE (implementation bug; GATE-DESIRED; #468): the reference container delivers buffered values only on some activations. The intended behavior is already settled by the Native Host Interface contract, C7 (replay-on-activation; ratified ADR "L1 Native Host Integration Surface", 2026-07-03, §3 "The contract"; L1 §1.16): every host INPUT re-delivers its current value on **each** ACTIVE transition, with `_syncAudioState` named as the reference pattern. "Next activation" therefore means every return to `active`, and the gaps below are implementation bugs. The re-send is `_syncAudioState`, which sends the current values as an `audioVolumeChange` whenever audio state has been set. It runs only from `_transitionToActive`, and that runs on exactly three paths: (1) when the creative resolves `Container:startCreative`, every time, even if the container is already `active`; (2) on page focus while `passive` (`_onPageFocus`); (3) on a freeze-resume to a visible, focused page, and only when no lifecycle adapter is attached. On the common web path, the HTML lifecycle adapter re-promotes the container through `_promoteContainerState` → `container.setState(ACTIVE)` (`src/lifecycle-adapters/html-adapter.js` ~:376–377, ~:488–489), and `setState` performs no audio sync (`src/sharc-container.js` ~:2114–2125). Values buffered while `hidden` are therefore **not** flushed on the common `hidden` → `passive` → `active` return; they reach the creative only with the next live `setAudioState` call or the next `_transitionToActive`. Values buffered in `loading` or `ready` are delivered, by path (1). (Resolved by the ratified NHI C7 rule; no new ruling was needed.) Sources: `src/sharc-container.js` `_syncAudioState` (~:4447), `_transitionToActive` (~:4389–4400), call sites ~:4342, ~:6190, ~:6292 (adapter guard ~:6285).
>
> GATE-DESIRED: the container-side audio delivery rules (live in `active`/`passive`, buffering, delivery on activation, drop in `frozen`/`terminated`, `[0, 100]` clamp) have no test. `test:mraid-bridge-correctness-e2` pins only bridge consumption of the wire shape, over a fake bus.

#### SHARC:Container:omidShimInit

Port-only delivery of the OMID protocol nonce to a creative-self-included OMID shim on the Creative URL variant. Specified in §2.12.

#### SHARC:Container:fatalError

Sent when the container encounters an unrecoverable error. The container waits for `resolve` before terminating the creative.

**Direction:** Container → Creative
**Requires response:** `resolve` only (creative acknowledges, then the container terminates the creative)

**Args:** `{ errorCode: number, errorMessage?: string }`

The container terminates the creative after receiving `resolve`, or after a short timeout if `resolve` does not arrive. In the reference container the timeout is **1 second**, and it runs regardless of `resolve`.

> Editorial note (added from src): the 1-second force-terminate is `src/sharc-container.js` `_handleFatalError` (~:5399–5411).

#### SHARC:Container:close

Sent when the close sequence begins. Triggered by: `Creative:requestClose`, or a platform-level close demand (the operator or native host closing the ad).

**Direction:** Container → Creative
**Requires response:** `resolve`

**Args:** None

**resolve** — Creative acknowledges close. The container terminates the creative shortly after the `resolve` arrives (100 ms in the reference container). A creative should therefore finish its close sequence (fire trackers, play an animation) **before** it resolves `close`. If no `resolve` arrives, the container terminates the creative after **2 seconds**, regardless.

> Editorial note (stale claim corrected): the source said the container "may allow up to 2 seconds for the creative to run a close sequence" after `resolve`. In the reference container, 2 s is only the no-`resolve` backstop; on `resolve` it terminates after 100 ms. Source: `src/sharc-container.js` `_initiateClose` (~:5275–5292).

The container-owned close button (§2.6 `requestPlacementChange`, "Container-owned close button") is rendered only in a `resize`, `expand` or `fullscreen` placement, and activating it collapses the placement to its default. It does not start the close sequence. A creative that wants the ad closed sends `Creative:requestClose`, and may provide its own close UI for that purpose.

> Editorial note (stale claims corrected): the source listed "user activating the close control" as a trigger of `Container:close`, and said the close control (a 50×50 DIP button, top-right) is "always" provided by the container and "mandatory". This contradicted the corrected close-button text in §2.6. In the reference container the close sequence (`_initiateClose`) is reached only from the public `close()` method and from the `Creative:requestClose` handler, and the container-rendered button always synthesizes a `collapse` intent. Sources: `src/sharc-container.js` `close()` (~:2056–2060), `_handleRequestClose` (~:5260–5263), `_createDismissButton` (~:6581).

> GATE-DESIRED: the following §2.5 behaviors have no test: the `init` timeout (`2208`) and the `startCreative` timeout (`2213`); the init-reject → fatal path; the `fatalError` resolve-then-terminate; the `Container:close` 100 ms post-resolve terminate; and the container-side audio rules (above). The two force-terminate backstops are witnessed only loosely, without exact timing: the 1 s `fatalError` force-terminate by `test:renderer-postrender-load-policy` (`test/node/test-renderer-postrender-load-policy.js` ~:250–258, which waits past it over a stubbed protocol channel and asserts termination), and the 2 s close backstop by `test:creative-sources-load` §18c (~:3006–3016, which waits up to 4 s for termination after an unacknowledged `close()`). Both are partial pins.

<!-- trace: source=api-reference.md §7 (all subsections) + §Appendix: Message Type Reference (`audioVolumeChange` registry row; wire shape from src/sharc-protocol.js sendAudioVolumeChange — no §7 subsection existed in the source) + src/sharc-container.js (placementChange payload, EV reason/visibleRectangle, audio buffering, close/fatal timing corrections) | gate=stateChange queryable-only: test:state-dedup D-4; test:container-state-establish-push C3/C8; test:lifecycle-ordering-conformance; stateChange delivery: test:container-state-establish-push; test:creative-state-replay; placementChange: test:placement (container-side suppression of an unchanged placementChange payload); test:host-placement-integration §5 (flat position + host-offset fold) / §11 (folded position re-sent on the ACTIVE re-sync, deduped when unchanged) — partial, no wire; effectiveVisibilityChange (container-side handoff to a stubbed sender, mockProtocol — not the wire): test:effective-visibility-composer blocks 2 / 3 / 8 / 11 (partial view → 'offscreen') / block 6 / block 8 (payload shape incl. visibleRectangle presence, dedup, raw reason) / block 9 (C7 replay-on-ACTIVE) / block 11b (reason null only at rounded 100) / blocks 11c–11d (sessionless: nothing sent) / block 13 (creative-side replay-of-last to a late listener, dispatched past the session gate) / block 17 (raw 'frozen'); visibleRectangle === null GATE-DESIRED; test:effective-visibility-wire-hop (effectivePercent over the real wire); creative-receive wire-honesty GATE-DESIRED (test:omid-reasons-vocab and test:mraid-visibility-channel drive a fake bus: bridge witnesses, not wire pins); audio: container side GATE-DESIRED (test:mraid-bridge-correctness-e2 = bridge consumption only) + delivery-on-activation DIVERGENCE #468 (NHI C7); placementTransitionEnd DIVERGENCE #456 (fullscreen/collapse); 2208/2213/close/fatal timing GATE-DESIRED, except the force-terminate backstops, loosely witnessed (test:renderer-postrender-load-policy ~:250–258, fatal 1 s; test:creative-sources-load §18c, close 2 s) -->

### 2.6 Creative → container messages

Messages sent from the creative to the container use the `SHARC:Creative:*` namespace. `createSession` is specified in §2.4 (session establishment).

#### SHARC:Creative:fatalError

Sent when the creative encounters an unrecoverable error. The container terminates the creative immediately.

**Direction:** Creative → Container
**Requires response:** No (container terminates the creative on receipt)

**Args:** `{ errorCode: number, errorMessage?: string }`

#### SHARC:Creative:getContainerState

Requests the current container state. The creative can call this at any time.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetContainerStateResolveValue {
  currentState: "ready" | "active" | "passive" | "hidden" | "frozen";
}
```

When the container's internal state is not creative-queryable (`loading` / `terminated`), the container resolves `ready`, the queryable floor (the same rule as INV-6, §2.8.3).

#### SHARC:Creative:getPlacementOptions

Requests current container placement information.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetPlacementOptionsResolveValue {
  currentPlacementOptions: ContainerPlacement | {};  // The container's current placement (§2.7); {} when none is configured
}
```

The container always resolves, even if it cannot provide all values.

> Editorial note (stale claim corrected): the source gave `currentPlacementOptions` as `{ containerDimensions, inline }`. The reference container resolves it with its `EnvironmentData.currentPlacement`, a `ContainerPlacement` (`initialDefaultSize`, `minDefaultSize`, `maxDefaultSize`, `maxExpandSize`, `viewportSize`, §2.7), or `{}` when none is configured. That shape holds only until the first placement change: `requestPlacementChange` overwrites `currentPlacement` with the updated placement record (for example `{ width, height }` after `expand` or `fullscreen`). Source: `src/sharc-container.js` getPlacementOptions listener (~:3920) and `_handleRequestPlacementChange` (`this.environmentData.currentPlacement = updatedPlacement`).

#### SHARC:Creative:log

Sends arbitrary log information to the container.

**Direction:** Creative → Container
**Requires response:** No

**Args:** `{ message: string }`

Messages prefixed with `"WARNING:"` signal that the creative has detected non-standard container behavior.

#### SHARC:Creative:reportInteraction

Delegates interaction tracking to the container. The container fires the provided URIs.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:**

```typescript
interface ReportInteractionArgs {
  trackingUris: string[];  // Array of https/http URIs to fire (max 20)
}
```

**Security:** The container validates all URIs before firing them. Only `https:` and `http:` schemes are permitted. URIs using any other scheme (`javascript:`, `data:`, `file:`, custom OS schemes, etc.) are silently dropped. The array is capped at **20 entries** — excess entries are ignored.

The container MUST:
- Fire all valid URIs in **parallel** (not serial)
- Use HTTP GET
- Apply a 5-second timeout per URI
- Not retry on failure
- Resolve when all URIs have been fired or timed out

Redirects are followed per the platform fetch.

> Editorial note (source MUST restored; ratified 2026-10-03, Ruling 2): the source (api-reference.md §8) states this list as a container MUST list. The slice-3a draft had weakened it to descriptive text; the source wording is restored. The reference container conforms on every retained clause: `_fireTrackers` fires each URI with `fetch` (`method: 'GET'`) under one `Promise.all`, aborts each at 5 s, never retries, and `_handleReportInteraction` resolves once all have settled. Source: `src/sharc-container.js` `_fireTrackers` (~:6531–6565) and `_handleReportInteraction`.
>
> Editorial note (redirect cap deleted; ratified 2026-10-03, Ruling 2): the source's "Follow redirects (up to 5 hops)" is deleted. The cap cannot be enforced. Trackers are fired with `mode: 'no-cors'`, and under WHATWG Fetch (main fetch) a `no-cors` request whose redirect mode is not `follow` returns a network error, so a container cannot count or stop hops itself. The platform caps redirects at 20 (WHATWG Fetch, HTTP-redirect fetch). The reference container's `_MAX_REDIRECTS = 5` is declared and never used.
>
> GATE-DESIRED: no test drives `reportInteraction` end-to-end. The MUST list above, the 20-entry cap, the scheme filter, the macro substitution below, and the resolve shape are all corpus-unpinned.

**resolve value:**

```typescript
interface ReportInteractionResolveValue {
  results: Array<{
    uri: string;
    success: boolean;  // Dispatched without a network error or timeout (NOT "the tracker accepted it")
    reason?: string;   // Present when success is false, e.g. "timeout"
  }>;
}
```

`success` means the tracker request was dispatched without a network error or timeout. It does **not** mean that the tracker accepted the request: the response to a `no-cors` request is opaque (status `0`), so the container cannot observe the tracker's HTTP status.

> Editorial note (`statusCode` deleted; ratified 2026-10-03, Ruling 2): the source's `statusCode?: number` result field is deleted. A `no-cors` response is an opaque filtered response, with status `0` and an empty header list (WHATWG Fetch), so the field can never be populated honestly. `reason` is added from the reference implementation (`_fireTrackers`: `'timeout'`, or the fetch error message).

**Macros.** With the IAB VAST 4 macro registry as the dataspec, the container MUST substitute `[CACHEBUSTING]` (a random 8-digit integer) and `[TIMESTAMP]` (the current time in ISO 8601, with milliseconds and a time-zone offset, percent-encoded) in each tracking URI, using one value of each per `reportInteraction` call, and MUST leave every other macro byte-identical. Substitution happens before the operator's `onInteraction` hook runs, so the hook sees the URLs actually fired.

> Editorial note (ratified 2026-10-03, Ruling 2): the source said "Standard macros in URIs are replaced by the container. Unknown macros are left intact." The ruling fixes "standard macros" to the two macros that the VAST 4 registry marks Required for all tracking pixels. The other Required macros are error-tracker or privacy-signal contexts that a container cannot fill honestly. One value per call lets the trackers of one interaction correlate.
>
> DIVERGENCE (implementation bug, #465; GATE-DESIRED): the reference container performs no macro substitution. `_handleReportInteraction` passes the scheme-filtered URIs unchanged to the `onInteraction` hook and to `_fireTrackers`. No test pins substitution. Source: `src/sharc-container.js` `_handleReportInteraction`.

#### SHARC:Creative:requestNavigation

Signals that the creative wants to navigate the user to a URL. **The creative must always call this, even on web where the browser handles navigation.** This ensures the container always has a log of navigation events.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:**

```typescript
interface RequestNavigationArgs {
  url: string;                                              // Target URL or deep link
  target: "clickthrough" | "deeplink" | "store" | "custom"; // Navigation type
  customScheme?: string;                                     // Only when target === "custom"
}
```

**Security:** The container MUST validate `url` before acting on it. Only `https:` and `http:` schemes are permitted. Requests with any other scheme (`javascript:`, `data:`, `file:`, etc.) MUST be rejected with error code `2211` (`MESSAGE_SPEC_VIOLATION`), and the URL MUST NOT be opened.

> Editorial note: MUST promotion ratified 2026-10-03 (Ruling 3). The source (api-reference.md §8) stated these three rules descriptively ("validates", "are rejected", "is not opened"), and slice 1 had promoted them without a record. The reference container conforms for a non-empty `url`: an unsafe scheme is rejected with `2211` before either the hook path or the default path, whether or not an `onNavigation` hook is wired, and the URL is not opened (`src/sharc-container.js` `_handleRequestNavigation` ~:4812–4816, `_isNavigationUrlSafe`). The empty or missing `url` is the exception (DIVERGENCE below).
>
> GATE-DESIRED: none of the three MUSTs above is pinned. No test reaches the container's `requestNavigation` handler; the container-level tests are added with #455 and #464. `test:mraid-open-tel-sms-policy` pins a different actor: the MRAID bridge declining `tel:` / `sms:` before any `requestNavigation` is sent.
>
> DIVERGENCE (implementation bug, #455; GATE-DESIRED): the reference container validates `url` only when it is non-empty (`if (url && !safe)`). An empty or missing `url` skips validation and is never rejected with `2211`. With an `onNavigation` hook wired, the empty `url` reaches the hook unvalidated and the request is resolved. Without a hook, it is rejected with the handoff reject (currently `2200`; see below). This contradicts "MUST validate `url` before acting on it". Source: `src/sharc-container.js` `_handleRequestNavigation`.

**resolve** — Container handled the navigation (e.g., opened the OS browser on mobile). No further creative action needed.

**reject** — Either the container cannot handle navigation (e.g., web environment where the browser handles it), or the URL failed validation. The creative should inspect the error code:
- `2214` (`NAVIGATION_NOT_HANDLED`) — Container declines the navigation; creative should open the URL itself. This is a handoff, not an error.
- `2211` — URL failed validation; do not attempt to open it.

The reject does NOT always mean navigation was blocked — `2214` specifically means "creative, you handle it."

In the reference container, the handoff reject applies only when no `onNavigation` hook is wired and either the `target` is neither `clickthrough` nor missing, or the `url` is empty or missing (DIVERGENCE #455). A missing `target` is treated as `clickthrough`: the container opens a non-empty `url` itself (`window.open`, `noopener,noreferrer`) and resolves. With a hook wired, the container calls the hook and resolves, whatever the `target`. Source: `src/sharc-container.js` `_handleRequestNavigation` (~:4818–4831).

> Editorial note (ratified 2026-10-03, Ruling 1): the handoff code is `2214` `NAVIGATION_NOT_HANDLED`, in the container-raised 22xx family (§2.13; L1 §1.18). It replaces the source's `2105`. That meaning of `2105` was never ratified, and the code already carries the legacy meaning "Resize request not honored". `2105` is reserved and is never reused. `2214` follows the SIMID numbering lineage (SHARC 22xx = SIMID 12xx + 1000), and SIMID `1214` is the same handoff. `2200` was rejected as the handoff code because the protocol also uses it to reject every pending request on reset and terminate, so a creative fallback keyed on `2200` would open windows for ads that were torn down.
>
> DIVERGENCE (implementation bug, #464; GATE-DESIRED): the reference container still sends the handoff reject as `2200` (`UNSPECIFIED_CONTAINER`). The reference `ErrorCodes` registry defines no `2214`, the reference SDK's comment describes the reject as "2105 (UNSPECIFIED_CONTAINER)", and the reference MRAID bridge's `open()` fallback keys on `2105`. No test pins any of these codes. Sources: `src/sharc-container.js` `_handleRequestNavigation` (~:4830); `src/sharc-protocol.js` `ErrorCodes`; `src/sharc-creative.js` `requestNavigation`; `src/sharc-mraid-bridge.js` `open()`.

Container-side navigation-policy hooks are observation-only in 0.7.x; runtime allow/deny/rewrite policy is future design work (L1 §1.10).

#### SHARC:Creative:setOrientationProperties

Forwards the creative's desired orientation properties to the container, which relays them to the native host. Fire-and-forget: the host decides whether and how to honor them, for example by locking device orientation (L1 §1.16, Native Host Interface).

**Direction:** Creative → Container
**Requires response:** No

**Args:**

```typescript
interface SetOrientationPropertiesArgs {
  allowOrientationChange?: boolean;
  forceOrientation?: "portrait" | "landscape" | "none";
}
```

The container treats these args as untrusted. It validates them field by field before anything crosses to the host: invalid fields are omitted, unknown fields never cross, and a message with no valid field produces no host call. With no host hook wired, the message is a no-op.

> Editorial note (registry omission corrected): `SHARC:Creative:setOrientationProperties` is a shipped wire message (`CreativeMessages.SET_ORIENTATION_PROPERTIES`, `src/sharc-protocol.js`) that the source §8 and message-type reference omitted. It is now listed here and in Appendix A. The container-side validation is the Native Host Interface trust-boundary contract (C5), which is L1 §1.16 material (RESERVED).

#### SHARC:Creative:requestPlacementChange

Requests that the container change its size or position. Uses an intent-based model where the creative declares what kind of change it wants.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:**

```typescript
interface RequestPlacementChangeArgs {
  intent: "resize" | "expand" | "fullscreen" | "collapse";
  targetDimensions?: {       // Required when intent === 'resize' (see the DIVERGENCE below)
    width: number;           // DIPs
    height: number;          // DIPs
  };
  targetPosition?: {         // Optional offset for resize
    x: number;               // DIPs
    y: number;               // DIPs
  };
  closeRegion?: CloseRegion; // Positioning hint for the container's close button
  allowOffscreen?: boolean;  // Whether ad content may extend beyond viewport
  transition?: TransitionHint; // Animation preference (container may ignore)
}

interface CloseRegion {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right"
           | "top-center" | "center-left" | "center-right" | "bottom-center";
  size: number;              // DIPs, minimum 50
}

interface TransitionHint {
  duration: number;          // Milliseconds, capped at 500ms by container
  easing: string;            // CSS keyword: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"
}
```

**Intent descriptions:**

| Intent | Behavior |
|--------|----------|
| `resize` | Change to specific dimensions. Requires `targetDimensions`. |
| `expand` | Expand to maximum available placement size (`maxExpandSize`). |
| `fullscreen` | Expand to fill the viewport. |
| `collapse` | Return placement to its default/original state (`initialDefaultSize`). Used after any non-default placement (resize, expand, or fullscreen). |

> DIVERGENCE (implementation bug, #457; GATE-DESIRED): "Requires `targetDimensions`" is lower-case prose, not an RFC-2119 requirement. The spec's intent is that a `resize` carries `targetDimensions`. The reference container does not reject a `resize` without them: it enters the resized placement, renders the close button, and resolves, with the dimensions unchanged (#457). Source: `src/sharc-container.js` `_handleRequestPlacementChange` (the `resize` branch applies dimensions only `if (targetDimensions)`).

**Close region:** The `closeRegion` field is a **positioning hint**, not a rendering directive. The container always owns and renders the close button (a DOM element outside the sandbox). If the hinted position would place the close button offscreen, the container silently overrides to `top-right` — it does NOT reject the placement change. The override is skipped when the native host owns clamping (`hostOwnsClamping`, L1 §1.16): the host then owns on-screen positioning, and the creative's hint is honored.

**resolve value:**

```typescript
interface RequestPlacementChangeResolveValue {
  placementUpdate: object;                   // The container's updated placement record, flat (width/height for the new size)
  transition?: TransitionHint;               // Actual animation applied (if any), after the duration cap and easing sanitization
  closeButtonPosition?: CloseButtonPosition; // §2.5 placementChange; present when a close button is rendered
}
```

The resolve's `placementUpdate` is the raw updated placement record. The `position` enrichment and the `intent` stamp appear only on the `SHARC:Container:placementChange` notification that follows (§2.5).

> Editorial note (stale claim corrected): the source typed the resolve as `CurrentPlacement` plus `closeButtonPosition: { position, rect }`. Neither shape is sent: see the §2.5 `placementChange` note. Source: `src/sharc-container.js` `_handleRequestPlacementChange` (`resolvePayload`, ~:5018–5033).

**reject** — The container may reject with:
- `2203` (`UNSUPPORTED_FEATURE`) — intent not allowed, dimensions exceed policy limits, offscreen violation, or a change of intent from a non-default placement without collapsing first (for example, `expand` while resized).
- `2211` (`MESSAGE_SPEC_VIOLATION`) — malformed request (e.g., missing required `closeRegion` when policy demands it, unknown intent value, non-string intent, `targetDimensions` whose `width` / `height` are not finite positive numbers).

> Editorial note (stale claims corrected): the source named `2203` `FEATURE_NOT_SUPPORTED`. The registry name is `UNSUPPORTED_FEATURE` (`src/sharc-protocol.js` `ErrorCodes`, ~:249). Two reject cases are added from src: the collapse-first rule (`2203`) and invalid `targetDimensions` (`2211`). Source: `src/sharc-container.js` `_handleRequestPlacementChange` (type guards; sub-state guard).

**Placement policy is container-local — never on the wire.** Publishers configure placement constraints on the container; the creative observes policy only through `getPlacementConstraints` (below), `placementConstraintsChange` events, and rejects. When no placement policy is configured, the policy validation pipeline is skipped and placement requests are not policy-rejected. The type guards, the collapse-first rule, and an offscreen check for a `resize` that sets `allowOffscreen: false` still apply. Creatives that do not handle rejection will see an unhandled promise rejection.

**Container-owned close button:** On `resize`, `expand`, and `fullscreen` intents, the container renders a 50 DIP close button as a DOM sibling to the iframe (outside the sandbox). On `collapse`, the close button is removed. Activating the close button always **collapses** the placement to its default, whatever the current intent. It does not close the ad: closing is a separate action (§2.5 `SHARC:Container:close`). The close button is a native `<button type="button">` (so its button role is implicit), is keyboard-operable with Enter/Space, and carries `aria-label="Close ad"`.

> Editorial note (stale claims corrected): the source said the close button triggers collapse in the resized state and **close** for expand/fullscreen, and gave it `role="button"`. In the reference container the button always synthesizes a `collapse` intent ("Dismiss button always collapses to default size … Close (ad termination) is a separate action, not triggered by this button"), and it is a native `<button type="button">` with an implicit role. Source: `src/sharc-container.js` `_createDismissButton` (~:6581–6700).
>
> GATE-DESIRED: no test activates the close button or asserts its collapse behavior, its keyboard handling, or its accessible name. `test:omid-container-lifecycle` creates the button only to check its OMID friendly-obstruction registration.

**Animation:** When a `transition` hint is provided and the container supports animation (`com.iabtechlab.sharc.placement.animate` feature), the container animates to the target dimensions and fires `SHARC:Container:placementTransitionEnd` when the animation completes (or immediately if animation is skipped). Duration is capped at 500ms. Easing is restricted to the five CSS keywords above: any other value is replaced with `ease-out`, not rejected.

> Editorial note (added from src): the `ease-out` substitution is `src/sharc-container.js` `_sanitizeEasing` / `_clampTransition` (~:6916–6932).
>
> Pinned (partial): `test:g5-url-contracts` F1 (`test/g5-contracts/test-g5-f1-conformance-browser.js` ~:171–172) round-trips one `requestPlacementChange({ intent: 'expand' })` over the real wire in real Chrome on the Creative URL variant (the creative observes the resolve), and asserts that the later `close()` tears down cleanly. It asserts only that the request resolved, not the resolve value. The policy-offscreen decision (`test:host-placement-integration` §3) and the close-position override (§2, §4) are also pinned.
>
> GATE-DESIRED: the intent dispatch beyond that one `expand` resolve (`resize` / `fullscreen` / `collapse`, and the resolve payload), the `2203` / `2211` reject legs and their codes, the collapse-first rule, the transition cap, and easing sanitization have no test.

#### SHARC:Creative:requestClose

Requests that the container close the ad. The container is not required to honor this.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:** None

**resolve** — Container will close. The container will send `Container:close`.

**reject** — Container cannot close at this time (e.g., a required display duration has not elapsed). The creative may choose to cease activity and emit a `Creative:log` message, but the container remains open.

#### SHARC:Creative:getPlacementConstraints

Queries the container's placement constraints before requesting a change. Follows the Permissions API query-before-request pattern.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetPlacementConstraintsResolveValue {
  maxWidth: number | null;       // null = no limit
  maxHeight: number | null;      // null = no limit
  allowedIntents: string[];      // e.g. ["resize", "expand", "collapse"]
  requireCloseRegion: boolean;   // Whether closeRegion is required on resize
  allowOffscreen: boolean;       // Whether content may extend beyond viewport
}
```

Container-side custom validators are intentionally not exposed in the resolve value — they are opaque container-side logic that creatives should not inspect.

**Feature detection:** the message requires the `com.iabtechlab.sharc.placement.constraints` feature; check `supportedFeatures` from `init` (or `getFeatures`) before calling.

#### SHARC:Creative:getFeatures

Requests the list of extensions/features the container supports. This returns the same data as `supportedFeatures` in `Container:init` — useful for late-binding queries.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:** `{ features: Array<string | Feature> }` (§2.10)

Features do not change after `init` in v1.

#### SHARC:Creative:request[FeatureName]

Invokes a named extension feature. The message type is `SHARC:Creative:request` + the **last dot-separated segment** of the feature name, capitalized. Example: `com.iabtechlab.sharc.audio` → `SHARC:Creative:requestAudio`.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:** `{ featureName: string, args: object }`. `featureName` is the full namespaced name; `args` is defined by the feature specification.

**Security:** Feature names are validated against the required namespace format before the message type is constructed. Valid names must match the pattern `com.[domain].[...].featureName` using only alphanumerics, dots, and hyphens (e.g., `com.iabtechlab.sharc.audio`). The terminal segment, which becomes the message-type suffix, must be alphanumeric and start with a letter. Invalid names are rejected sender-side before any message is sent, preventing message-type injection attacks.

> Editorial note (stale claims corrected): the source said the type suffix is "the feature name (capitalized)" and that args are "defined by the feature specification". The reference SDK uses the last segment only, and wraps the feature's args as `{ featureName, args }`. Source: `src/sharc-creative.js` `requestFeature` (`FEATURE_NAME_RE`).
>
> DIVERGENCE (ruling required): `request[FeatureName]` types are not in the reference protocol's response-required set, which is static. The reference SDK therefore sends them fire-and-forget and resolves the caller immediately, so no container `resolve`/`reject` is ever correlated. The reference container implements only one such type, `SHARC:Creative:requestMessage` (SafeFrame `$sf.ext.message` relay), which it resolves. No test pins the 2203/2204 reject legs, and the reference `ErrorCodes` registry defines no `2204`. Sources: `src/sharc-protocol.js` `MESSAGES_REQUIRING_RESPONSE` / `_sendMessage`; `src/sharc-container.js` requestMessage listener.

**resolve** — Feature executed. Response value defined by the feature.

**reject** — Feature is not supported or could not be executed. Error codes:
- `2203` — Feature unsupported by this container
- `2204` — Feature known but execution failed

> GATE-DESIRED: `requestClose` (resolve/reject), `Creative:fatalError` (terminate on receipt), `getContainerState` (including the `ready` floor), `getPlacementOptions`, `getPlacementConstraints` (and its feature requirement), and `getFeatures` have no test that drives the container handler over the wire.

<!-- trace: source=api-reference.md §8 (all subsections except createSession, carried in §2.4) + setOrientationProperties from src (CreativeMessages; container handler _handleSetOrientationProperties) + src/sharc-container.js (requestPlacementChange / requestNavigation / close-button corrections) | gate=test:host-placement-integration §2 (offscreen closeRegion hint → top-right; skipped under hostOwnsClamping) / §3 (policy offscreen reject decision; skipped under hostOwnsClamping) / §4 (onPlacementChange alone does not skip the override); test:mraid-orientation-properties O8–O10 (setOrientationProperties field-wise validation / host relay); test:g5-url-contracts F1 (partial: one requestPlacementChange expand round-trip over the real wire, real Chrome; close() tears down cleanly); requestNavigation MUSTs (Ruling 3) GATE-DESIRED + DIVERGENCE #455 (empty url) + DIVERGENCE #464 (handoff 2214, implementation sends 2200); reportInteraction MUST list + macros (Ruling 2) GATE-DESIRED, macros DIVERGENCE #465; request[FeatureName] legs GATE-DESIRED / DIVERGENCE as flagged; resize-without-dimensions DIVERGENCE #457; remaining requestPlacementChange dispatch/rejects, close button, requestClose, query messages GATE-DESIRED — annotated out: test:placement (placementChange notification dedup, now credited in §2.5), test:creative-protocol-placement-type (createSession, now credited in §2.4), test:navigation-bridge (creative-side interceptor routing into SHARC.requestNavigation: an SDK behavior, §2.14), "close-sequence assertions in lifecycle suites" (no such assertions exist) -->

### 2.7 EnvironmentData and dataspec

`EnvironmentData` is sent in `Container:init` and describes the publisher's environment.

```typescript
interface EnvironmentData {
  currentPlacement: ContainerPlacement;  // Current container dimensions
  dataspec: Dataspec;                     // AdCOM or other dataspec identifier
  data: Data;                            // Dataspec data (placement, ad, context)
  containerNavigation?: Navigation;       // Navigation capabilities
  currentState: ContainerState;          // Real creative-queryable container state at init time; falls back to "ready" only when the internal state is not creative-queryable (loading/terminated). See §2.8 state-delivery contract (INV-6).
  version: string;                       // Container implementation version, e.g. "0.7.13" (not the spec version)
  isMuted?: boolean;                     // True if device is muted (if known)
  volume?: number;                       // 0.0–1.0 volume, or -1 if unknown
  initialPosition?: {                    // The container's on-screen rect at init (DIPs), when measurable
    x: number; y: number; width: number; height: number;
  };
  publisherContext?: {                   // Publisher environment context ("" when unknown)
    pageUrl?: string; domain?: string; bundleId?: string;
    platform?: string;                   // "web" | "ios" | "android" | "ctv"; auto-derived as "web"
  };
}
```

The interface above predates the audio surface; the buffered `volumePercentage` field written by `setAudioState` in the `loading`, `ready` and `hidden` states (§2.5, `audioVolumeChange`) joins it alongside `volume`/`isMuted`.

> Editorial note (stale claims corrected): the source interface omitted two fields the reference container sends. `initialPosition` is the iframe rect at init, falling back to the placement element when the iframe is not yet laid out, and offset by any host screen offset (L1 §1.16). Compatibility bridges consume it, for example for MRAID default position. `publisherContext` is auto-derived from browser APIs when the operator does not supply it; the derived `platform` is `'web'`, and the other fields are `""` when unknown. The reference container also passes through any other operator-supplied `environmentData` fields unchanged. `version` carries the reference package version (for example `0.7.13`). The L1 Versioning policy defines the field as the implementation version, not the spec version (ruled 2026-10-04), so the reference conforms; the source's example `"1.0.0"` read like a spec version and is replaced. Source: `src/sharc-container.js` `Container:init` payload construction and constructor (`_derivePublisherContext`).

#### ContainerPlacement

```typescript
interface ContainerPlacement {
  initialDefaultSize: Dimensions;  // Container size when startCreative is called
  minDefaultSize: Dimensions;      // Minimum size in default placement
  maxDefaultSize: Dimensions;      // Maximum size in default placement
  maxExpandSize: Dimensions;       // Maximum size when expanded
  viewportSize: Dimensions;        // Viewport/screen dimensions
}

interface Dimensions {
  width: number;   // Density-independent pixels (DIPs)
  height: number;  // Density-independent pixels (DIPs)
}
```

If `minDefaultSize` equals `initialDefaultSize`, the placement cannot be made smaller. If `maxDefaultSize` equals `initialDefaultSize`, it cannot be made larger.

#### Dataspec

```typescript
interface Dataspec {
  model: string;  // Default: "AdCOM"
  ver: string;    // Default: "1.0"
}
```

#### Data (AdCOM default)

```typescript
interface Data {
  ad: AdcomAd;               // AdCOM Ad object
  placement: AdcomPlacement; // AdCOM Placement object
  context: AdcomContext;     // AdCOM Context (site/app, user, device, regs)
}
```

All `data` fields are optional — a container without AdCOM data omits them. The only truly required `EnvironmentData` fields are `currentPlacement`, `currentState`, and `version`.

#### Navigation

```typescript
interface Navigation {
  navigationPossible: boolean;  // Platform supports container-handled navigation
  navigationAllowed: boolean;   // Container will handle navigation (requires navigationPossible=true)
}
```

On web, the browser handles navigation — `navigationPossible` is typically `false`. The creative must always call `requestNavigation` regardless; the container will reject, which signals the creative to open the URL itself. This ensures the container always has a log of navigation events.

> Editorial note (stale claim qualified): the reference container does not populate `containerNavigation`. It passes it through only when the operator supplies it. Its web default for a `clickthrough` is to open the URL itself (`window.open`, `noopener,noreferrer`) and **resolve**, or to resolve after calling the operator's `onNavigation` observation hook. It sends the handoff reject only when no hook is wired and either the `target` is neither `clickthrough` nor missing (a missing `target` is treated as `clickthrough`) or the `url` is empty or missing (DIVERGENCE #455); the reject code is `2214`, and the reference container still sends `2200` (§2.6, DIVERGENCE #464). A non-empty `url` with an unsafe scheme is rejected with `2211` before either path, whether or not a hook is wired. An empty `url` skips that validation (§2.6, DIVERGENCE #455). Source: `src/sharc-container.js` `_handleRequestNavigation`.

On iOS/Android WebView, `navigationPossible` is typically `true`. The container handles deep links and store URLs.

> GATE-DESIRED: the container-side construction of `initialPosition` (iframe rect, placement-element fallback, host screen offset) and the derivation of `publisherContext` have no test. Only `currentState` (INV-6) is pinned on the container's init payload.

<!-- trace: source=api-reference.md §6 (EnvironmentData Structure); initialPosition/publisherContext from src/sharc-container.js (init payload) | gate=test:container-state-establish-push C4 (init environmentData.currentState carries the real state; READY at READY); test:mraid-bridge-correctness-e2 B1 (bridge-side witness: initialPosition consumed as MRAID default position, fake env); initialPosition construction + publisherContext derivation GATE-DESIRED — annotated out: test:creative-protocol-placement-type (createSession, §2.4), test:host-placement-integration (pins the placementChange position / host-offset fold, now credited in §2.5; it does not cover EnvironmentData or initialPosition) -->

### 2.8 State-delivery contract

This section governs the **container → creative lifecycle-state channel**: how a container delivers its current lifecycle state (`ready` / `active` / `passive` / `hidden` / `frozen`) to the creative over the established session (the `SHARC:Container:stateChange` message, §2.5). It guarantees three things. Every creative, including one that establishes its session after the container has already reached a state, observes the correct current state exactly once. Every later live transition flows without latching. A `stateChange` listener registered late is brought up to date exactly once.

Out of scope here: the container-internal router phase line; the creative → container direction (including the `getContainerState` request/response, §2.6); bridge-internal mappings (bridges are consumers of this channel; their rules are Compat Profile material); and readiness timing, meaning when a session establishes. Readiness is §2.9.

The invariant identifiers `INV-1` … `INV-22` are carried unchanged from the source contract so that existing test annotations keep resolving. `INV-23` (no wire change) is retired from the spec: it was a ratification-time change-control confirmation that the contract needed no new message or field, and it stays in the HISTORICAL source record. Test annotations that cite `INV-23` (for example `test:container-state-establish-push` C4) resolve there.

#### 2.8.1 Definitions

| Term | Definition |
|---|---|
| **Session** | An established protocol session between one container and one creative, identified by a non-empty `sessionId` (§2.4). A creative that has not established a session has **no session**. |
| **Lifecycle state** | One of `loading`, `ready`, `active`, `passive`, `hidden`, `frozen`, `terminated` (L1 §1.8). |
| **Creative-queryable state** | A lifecycle state the creative is permitted to observe: `ready`, `active`, `passive`, `hidden`, `frozen`. `loading` and `terminated` are **non-queryable**. See §2.8.4 for how `terminated` is signalled. |
| **`stateChange`** | The container → creative message carrying `{ containerState }` (§2.5), delivered to the creative-side library's `stateChange` listeners. It is the **latching** current-state event. |
| **Delivery** | A `stateChange` value reaching the creative-side library's event bus, and thus its listeners. A message dropped at the creative's session gate (a `sessionId` that does not match its own) is **not delivered**. |
| **Sent** | A `stateChange` message posted by the container on the session port. The exactly-once dedup (§2.8.2) operates on sends. |
| **Transition send** | The `stateChange` send the container issues on a successful lifecycle-state transition. |
| **Replay** | Delivering the last-known state once, at registration time, to a newly registered listener only, without re-driving the live bus (§2.8.5). |
| **Establish push** | The container's unconditional send of its current queryable state once the session is established (§2.8.3). |

#### 2.8.2 Exactly-once consecutive delivery (send-layer dedup)

> **INV-1 (Exactly-once consecutive).** The container MUST NOT deliver two **identical consecutive** `stateChange` values on a single session. If the most recently sent state on a session is `S`, a subsequent send of `S` MUST be suppressed.

> **INV-2 (Distinct values always flow).** The dedup MUST suppress ONLY a value identical to the immediately preceding sent value on the same session. A `stateChange` whose value differs from the last sent value MUST be sent. Re-asserting a value after an intervening *different* value MUST be sent. The dedup is consecutive-only, NOT set-membership, and the channel is non-latching (INV-10, §2.8.5).

> **INV-3 (Symmetric single `active`).** Both the normal `loading` → `active` path (transition send followed by the establish push) and the already-`active`-at-establish path MUST deliver `active` to the creative **exactly once**.

Placement of the dedup is normative in effect. It MUST observe **every** `stateChange` send on the session, including the establish push (§2.8.3), which does not originate from a state transition. It MUST NOT persist across sessions (INV-21). The non-queryable-state refusal and the no-session no-op (§2.8.4) MUST run *before* the dedup comparison, so a refused or sessionless send never updates the last-sent value. The dedup MUST NOT be implemented as "make the establish push conditional on whether a transition occurred": that breaks INV-4 on the already-`active` path.

> Editorial note (source RFC strength restored): the extraction draft had lower-cased the source's "MUST NOT be implemented as 'make D1 conditional …'" (state-delivery-contract.md §3.4). The MUST NOT is restored, with "D1" spelled out as the establish push.

> Reference implementation (informative): the dedup is a per-session `_lastSentState` field checked inside `SHARCContainerProtocol.sendStateChange`, the single chokepoint for both the transition send and the establish push. It is reset to `undefined` on session establish and teardown.

#### 2.8.3 Completeness for late-establishing creatives

> **INV-4 (Establish completeness).** A creative that establishes its session AFTER the container has already reached a creative-queryable state MUST receive that current state. The container MUST issue the establish push unconditionally on session establishment, whether or not a state transition occurred at establish time.

> **INV-5 (Establish push ordering vs the session gate).** The establish push MUST be issued only once the creative's session is fully established, meaning its `sessionId` is set, so that the push passes the creative-side session gate. A `stateChange` sent before the creative has set its `sessionId` is dropped at the gate and is unrecoverable by any creative-side replay. The earliest conforming site is after `Container:startCreative` resolves.

> **INV-6 (Honest init seed).** The `currentState` field of the `Container:init` `EnvironmentData` (§2.7) MUST carry the container's REAL current queryable state at init-send time, not a hard-coded value. If the current state is non-queryable, the field MUST carry `ready` (the queryable floor).

> GATE-DESIRED: the non-queryable → `ready` fallback leg of INV-6 is unpinned. `test:container-state-establish-push` C4 asserts the real state (`active`) and, in its second leg, a container already at `ready` (a queryable state). The source test plan's claim that C4 covers "non-queryable current ⇒ `ready`" does not hold. The fallback is in `src/sharc-container.js` (`r1CurrentState`, ~:4169).

The establish push (INV-4) and the honest init seed (INV-6) are complementary. INV-6 covers a container already past `ready` *when init is sent*. INV-4 covers a container that advances after init is sent (for example, an adapter promoting to `active` mid-handshake). Neither changes the wire. `currentState` already exists in the init envelope, and the push reuses `stateChange`.

#### 2.8.4 Ordering and the queryable-state gate

The legal transition graph is L1 §1.8.2. The rules below are the **creative-facing delivery** ordering over whatever transitions that graph emits.

> **INV-7 (`ready` precedes `active`).** The creative MUST NOT be delivered `active` before it has been delivered, or seeded with, `ready`. `ready` is the queryable floor. The establish push and the init seed never deliver a queryable state below `ready`.

> **INV-8 (No premature viewability).** A bridge MUST NOT signal viewability / active-equivalent (MRAID `isViewable() === true` / `viewableChange(true)`) before the container has delivered `active`.

> Editorial note (source wording restored; derivation stale): the extraction draft had re-anchored INV-8 to "ahead of its own readiness signals" and dropped `isViewable()`. The source wording is restored. The source's justification ("viewability is driven off delivered `active`, so satisfying INV-3/INV-4 satisfies this") is stale. Since the Slice D re-point, bridge viewability is driven by the effective-visibility channel (`SHARC:Container:effectiveVisibilityChange`, §2.5), and a state-only drive produces no `viewableChange` (`test/node/test-mraid-visibility-channel.js`, Slice D re-target header). The source's SafeFrame clause ("first `geom-update`") moves with the bridge rules to the Compat Profile (slice 3b). Captured for 3b: the SafeFrame bridge fires a `geom-update` on a late `register()`, which is a candidate DIVERGENCE against that clause.
>
> GATE-DESIRED (partial): the channel-side ordering is pinned (`test:lifecycle-ordering-conformance` L2: nothing implying viewability precedes the first `active` on the wire), and so is the MRAID burst ordering (`test:mraid-visibility-channel` T8: `ready` and `stateChange('default')` precede the first `viewableChange`). No test pins that an effective-visibility value arriving **before** `active` is delivered cannot make the MRAID bridge signal viewability.
>
> Suspected DIVERGENCE, red test pending (#467): the MRAID bridge's effective-visibility gate is its own `_readyFired` flag, not a delivered `active`. An effective-visibility value of 100 that arrives after the bridge's `ready` but before `active` is delivered may therefore produce `viewableChange(true)` ahead of `active`, which INV-8 forbids. This is not yet confirmed by a test.

> **INV-9 (Queryable floor before `ready`).** The creative MUST NOT observe a queryable state that implies viewable/default (anything at or above `ready`) before `ready` is established. `loading` is non-queryable and is never delivered. The first delivered or queryable value is `ready`.

> Note (INV-7 / INV-9 vs INV-6): "seeded with `ready`" and "the first value is `ready`" describe the floor, not a mandatory first value. When the container is already past `ready` at init-send time, INV-6 seeds the creative with the real state (for example `active`), and that seed is the creative's first observed value. The floor still holds: nothing below `ready` is ever delivered or seeded.

> **INV-10 (Oscillation is non-latching and repeatable).** The oscillating edges (`active`⇄`passive`, `passive`⇄`hidden`, `active`→`hidden`, `hidden`⇄`frozen`, and `frozen`→`active`/`passive`) MUST continue to flow on every traversal. Each *distinct* state on an oscillation MUST be delivered. The dedup (§2.8.2) MUST NOT suppress a distinct value; it suppresses only an identical *consecutive* repeat (INV-2). Re-entering `active` after `passive` / `frozen`, or after `hidden` by way of `passive`, MUST deliver `active` again, because the intervening different value resets the consecutive comparison (INV-2).

> Editorial note (stale claim corrected): the source listed `active`⇄`hidden` as an oscillating edge and re-entry into `active` directly from `hidden`. `hidden` → `active` is not a legal transition (L1 §1.8.2; `STATE_TRANSITIONS` in `src/sharc-protocol.js`). A creative leaves `hidden` through `passive` or `frozen`. The edge list and E3 are corrected to legal paths; `test:container-state-establish-push` C6 already drives `hidden` → `passive` → `active`. The source's "The dedup MUST NOT suppress a distinct value" clause, which the extraction draft had dropped, is restored.

> **INV-11 (`terminated` is terminal).** After the terminal signal (INV-13) is delivered, a further `stateChange` MUST NOT be delivered on that session.

> **INV-12 (Queryable-only on the wire).** The container MUST NOT send a `stateChange` carrying a state outside the creative-queryable set. `loading` MUST NOT be delivered: it is the pre-`ready` bootstrap state, and the creative's effective first state is `ready`. A container with no established session sends nothing. Its local state still transitions, and operator-facing callbacks still fire.

> **INV-13 (`terminated` delivery exception).** `terminated` is non-queryable, but the creative MUST be notified exactly once that the session is ending, through the lifecycle channel. The terminal signal is a `stateChange` carrying `hidden`. The creative MUST receive **exactly one** terminal lifecycle signal and MUST NOT receive any `stateChange` after it (INV-11). Introducing a first-class `terminated` `stateChange` value would be a delivery-semantics change requiring re-ratification. It is not part of this contract.

> Note: when the container is already `hidden` at termination, the terminal `hidden` is an identical consecutive value and the dedup (INV-1) suppresses it. The creative's last delivered `hidden` then stands as its terminal signal, and nothing is sent at termination (`test:container-state-establish-push` C8, second leg).

**What the creative sees, by state:**

| Container state | Queryable? | Delivered to creative? | Creative observes |
|---|---|---|---|
| `loading` | No | No | nothing (pre-`ready`) |
| `ready` | Yes | Yes | `ready` (the floor) |
| `active` | Yes | Yes (exactly once per entry) | `active` |
| `passive` | Yes | Yes | `passive` |
| `hidden` | Yes | Yes | `hidden` |
| `frozen` | Yes | Yes | `frozen` (then quiet: bridges suppress further output while frozen) |
| `terminated` | No | Yes, **as one terminal signal** (`hidden`) | one terminal `stateChange`, then nothing |

#### 2.8.5 Replay-on-subscribe (creative-side library)

These invariants bind a conforming creative-side library's listener API for the lifecycle `stateChange` event.

> **INV-14 (Replay exactly once).** A `stateChange` listener registered AFTER a state exists for the session MUST receive the current (last-known) state exactly once, synchronously, at registration.

> **INV-15 (Replay scope = lifecycle `stateChange` only).** Replay MUST be scoped to the latching `stateChange` event. One-shot events (container error, log, close, placement-transition-end) MUST NOT be replayed.

> GATE-DESIRED (partial): `test:creative-state-replay` N3 pins the container-error and log legs: it drives a `fatalError` and a `log` before registering, then asserts neither is replayed. Its "close NOT replayed" check is vacuous, because N3 never drives a `close` before registering. The placement-transition-end leg is not tested.

> **INV-16 (Replay does not re-drive the live bus).** Replay MUST deliver to the **registering listener only**. It MUST NOT re-emit to existing listeners and MUST NOT re-enter the live subscription path.

> **INV-17 (Replay reflects the LAST value).** The replayed value MUST be the most recently delivered state, not the first. After `active` → `hidden`, a late subscriber MUST be replayed `hidden`.

> **INV-18 (Replay never precedes `ready`).** A creative MUST NOT receive a replayed `stateChange` before its cache is seeded. The cache is seeded at `Container:init` from a creative-queryable `currentState` (INV-6), or by the first inbound `stateChange`. A non-queryable or missing seed leaves the cache empty.

> Editorial note (added from src): the last sentence of INV-18 is added from the reference SDK, which caches the init seed only when it is creative-queryable (`src/sharc-creative.js` `_handleInit`, `CREATIVE_QUERYABLE_STATES.has(initState)`, ~:392–395). The source said only that the cache is seeded "from a real queryable `env.currentState`".
>
> GATE-DESIRED (partial): `test:creative-state-replay` N2c pins the **missing**-seed leg (an init with no `currentState` caches nothing and replays nothing). The **non-queryable**-seed leg (for example a `loading` seed) is unpinned.

> **INV-19 (No double-fire under interleaving).** For any interleaving of {init seed, inbound `stateChange`, late listener registration}, a listener MUST receive the current state exactly once: no duplicate from seed-then-replay or event-then-replay.

The replay cache is per session. It MUST be reset when the session is torn down (INV-21).

> Reference implementation (informative): the same replay-once discipline is applied to the latching `effectiveVisibilityChange` payload (§2.5) and to the `omidShimInit` delivery (§2.12). This section's invariants are stated for `stateChange` only. The reference SDK does not reset these caches per session (see the INV-21 DIVERGENCE).

#### 2.8.6 Expected delivered sequences

Each row maps to a conformance scenario. "Delivered" means what reaches creative-side `stateChange` listeners after the dedup and the session gate. Listeners are assumed to subscribe at or after readiness (§2.9) unless the row says "late".

| # | Scenario | Expected delivered `stateChange` sequence | Invariants |
|---|---|---|---|
| E1 | already-`active` before handshake (the adapter promoted pre-handshake; no transition send at establish) | `active` ×1, via the establish push only | INV-3, INV-4, INV-5 |
| E2 | normal `loading` → `active` (transition send + establish push) | `active` ×1 (the identical consecutive establish push is suppressed) | INV-1, INV-3 |
| E3 | rapid toggles `active`→`passive`→`active`→`hidden`→`passive`→`active` | `active, passive, active, hidden, passive, active`: each distinct value delivered | INV-2, INV-10 |
| E4 | re-assert the same state consecutively | `active` ×1 (the second is suppressed) | INV-1 |
| E5 | late subscribe after `active` was delivered | replay `active` ×1 to the new listener | INV-14, INV-17 |
| E6 | N listeners register late | each replayed the current state once | INV-14, INV-19 |
| E7 | init seed `currentState === 'active'` | cache seeded `active`; a post-init listener is replayed `active`. A non-queryable seed is not cached, so there is no replay | INV-6, INV-9, INV-14, INV-18 |
| E8 | termination | one terminal signal (`hidden`) ×1; no `stateChange` after | INV-11, INV-13 |
| E9 | freeze → restore via `hidden` (`active`→`hidden`→`frozen`→`active`) | `active, hidden, frozen`, then `active` on restore (distinct from `frozen`, so delivered) | INV-2, INV-10 |
| E10 | sessionless embed (no `createSession`; plain-HTML route) | nothing: no establish push, the send is a no-op; local state still transitions | INV-12 |

> Editorial note (stale claim corrected): the source contract annotated E9 with "no direct `ACTIVE→FROZEN` edge (audit Rec R2)". That edge now exists. Direct visible-freeze edges `active`/`passive` → `frozen` were added in #340 (L1 §1.8.2; `STATE_TRANSITIONS` in `src/sharc-protocol.js`), so a freeze of a visible creative now delivers `frozen` with no phantom `hidden`. E9 still describes the genuine offscreen-then-freeze path. The direct edge is pinned by `test:active-frozen-edge`.

#### 2.8.7 Per-session isolation

> **INV-20 (Strict per-session state).** Lifecycle state delivery MUST be strictly scoped to the owning session. A container MUST NOT deliver one session's state to another session or placement. The creative-side session gate is the boundary: a conforming creative-side library MUST drop any inbound message whose `sessionId` differs from its own.

> Editorial note (lost requirement restored): the extraction draft stated the session gate descriptively. The source's normative force is restored: the source (§8) required the gate to "remain unchanged", and §2.8.1 defines a gate-dropped message as not delivered.
>
> GATE-DESIRED (partial): `test:container-state-establish-push` C2 pins the gate only for a creative whose own `sessionId` is still `''`: a `stateChange` sent then is dropped, and the same state is delivered once the `sessionId` is set (`test/node/test-container-state-establish-push.js` ~:122–166). No test sends a message carrying a non-empty `sessionId` that differs from the creative's, so the mismatch leg is unpinned.

> **INV-21 (Per-session dedup and cache state).** The container's last-sent dedup value (§2.8.2) and the creative-side replay cache (§2.8.5) MUST be per session, and MUST be reset on session establish and teardown, so that no value leaks across a session boundary.

> DIVERGENCE (implementation bug, #454; GATE-DESIRED): the reference SDK does not reset its creative-side caches on session reset. Its reset hook clears only the readiness caches (OR-3). The `stateChange` replay cache (`_lastContainerState`), the effective-visibility cache (`_lastEffectiveVisibility`) and the `omidShimInit` cache (`_lastOmidShimInit`) survive a protocol reset, and values leak across sessions. The container half is reset and pinned (`test:state-dedup` D-6). No test pins the creative half. Source: `src/sharc-creative.js` constructor (`_proto._onResetHook`, ~:121–128).

> **INV-22 (No cross-placement observability).** Each container owns one session, one `sessionId`, and one port, and sends lifecycle state only on its own port. There MUST be no path by which one placement observes another's lifecycle state.

> GATE-DESIRED: INV-22 is structural, a consequence of one-session-per-container, and has no dedicated test. The source contract's coverage map recorded it as "covered by INV-20 gate tests + container single-protocol architecture (no new test surface needed)", and `test/node/test-state-dedup.js` annotates it as structural. The source MUST is kept; it is not demoted to descriptive.

#### 2.8.8 Channel coverage (generalized invariant)

The "no redundant consecutive identical notification" rule applies beyond the container → creative `stateChange` channel: every channel that emits a value-typed lifecycle signal SHOULD suppress a redundant consecutive identical emission.

Per-channel status (informative; reference implementation as of this extraction):

| Channel | Status |
|---|---|
| container → creative `stateChange` | Deduped (§2.8.2) |
| MRAID `viewableChange` | Edge-guarded |
| MRAID `stateChange` | Deduped, consecutive-identical (#343, fixed in #348) |
| MRAID `audioVolumeChange` | Same-value guarded (#343, fixed in #348) |
| MRAID `sizeChange` | Same-value guarded, except that a placeholder → real-geometry repeat is allowed (#393 two-phase geometry; `test:mraid-adapter-dedup` D4) |
| container → creative `audioVolumeChange` (wire) | Not deduped: each re-sync path listed in §2.5 re-sends the current values, changed or not |
| SafeFrame `focus-change` | Transition-only |
| SafeFrame `geom-update` | Not deduped. Whether it is an intentional geometry sample was left open: #343 closed with the MRAID-only fix. Partially stale: the effective-visibility path is value-guarded since Slice D; the bridge-side row is re-audited with the Compat Profile (slice 3b) |
| OMID `geometryChange` | Rate-limited |
| OMID `sessionStart` / `loaded` / `impression` / `sessionFinish` | One-shot flags |
| container `onStateChange` (operator callback) | Transition-based |

> Editorial note (stale claim corrected): the source table listed MRAID `stateChange`, `audioVolumeChange`, and `sizeChange` as "NOT deduped → tracked #343". #343 closed 2026-06-08, fixed by #348. Pinned by `test:mraid-adapter-dedup` (D1 stateChange, D3 audioVolumeChange, D4 sizeChange). The MRAID `viewableChange` edge guard is pinned by `test:mraid-visibility-channel` T7a/T7b, which deliver a redundant identical effective-visibility value and assert a single `viewableChange(true)`. `test:mraid-adapter-dedup` D5 is only a regression check that the `stateChange` dedup leaves `viewableChange` independent: it never sends a redundant value, so it does not pin the edge guard.

> Note: the source's migration rule that bridges never poll `getContainerState` for their seed (they read the channel; `test:mraid-visibility-channel` T1) is bridge material and moves to the Compat Profile (slice 3b).

<!-- trace: source=docs/design/state-delivery-contract.md §§1–8, §10, §12 (§9 no-wire-change confirmation incl. INV-23, §11 test plan, §13 migration, and §14 cross-links stay in the HISTORICAL record; their content is reflected in this footer's gate list) | gate=test:state-dedup (D-1…D-6: INV-1, INV-2, INV-3, INV-12, INV-21 container half; D-6 witnesses INV-20 only in that the dedup value does not leak across a session boundary); test:container-state-establish-push (C1…C9: INV-1…INV-5, INV-6 real-state leg, INV-9…INV-13, INV-20 partial via C2 (creative sessionId '' leg only; mismatched non-empty sessionId GATE-DESIRED); C5 also witnesses INV-7 on the wire (`ready` then `active`)); test:lifecycle-ordering-conformance (L1: INV-7, INV-9; L2: INV-8 channel side; L3: INV-10; L4: INV-11, INV-13); test:html-lifecycle-adapter (INV-12 sessionless: local transitions + operator onStateChange with no session); test:creative-state-replay (N1…N6: INV-10, INV-14, INV-16, INV-17, INV-19, INV-6 creative seed; INV-15 partial — N3 pins the error/log legs, its close check is vacuous and placement-transition-end is untested; INV-18 partial — N2c pins the missing-seed leg, the non-queryable-seed leg is GATE-DESIRED); test:mraid-visibility-channel (T1…T10: bridge-observable witnesses; T8 pins the MRAID clause of INV-8, not INV-7; T7a/T7b pin the §2.8.8 MRAID viewableChange edge guard); test:mraid-adapter-dedup (§2.8.8 channel table: D1/D3/D4; D5 is a channel-independence regression, not an edge-guard pin); test:active-frozen-edge (E9 correction); GATE-DESIRED: INV-6 non-queryable fallback, INV-8 EV-before-active leg (suspected DIVERGENCE, #467), INV-15 close / placement-transition-end legs, INV-18 non-queryable-seed leg, INV-20 mismatch leg, INV-21 creative half (DIVERGENCE #454), INV-22 -->

### 2.9 Readiness semantics

Readiness is the moment a creative-side library hands the creative its environment, the `Container:init` `EnvironmentData` and `supportedFeatures` (§2.5, §2.7). In the reference SDK this is `SHARC.onReady(callback)`. The rules below bind any conforming creative-side library's readiness surface, whatever it is called. They extend the replay model of §2.8.5 to readiness.

> **OR-1 (Multi-listener).** The readiness surface MUST support N listeners. Registration MUST append, never overwrite. This closes the wrapper-clobber failure, in which a creative registering its own readiness handler silently replaces a compatibility bridge's.

> **OR-2 (Replay-last-once).** A listener registered AFTER readiness has fired MUST be invoked exactly once, synchronously at registration, with the cached `(environmentData, supportedFeatures)`. A listener registered before MUST be invoked exactly once when `Container:init` is handled. No listener is invoked twice.

> **OR-3 (Per-session).** The readiness fired-flag and the cached `(environmentData, supportedFeatures)` MUST be per session and MUST be reset on session teardown. A re-established session fires readiness again.

> **OR-4 (Never precedes creative-rendered / load).** Readiness MUST NOT fire before the creative-rendered anchor (HB-3). Combined with the load anchor, readiness never fires before the creative document has fully loaded.

> Note (OR-4 at the wire): a creative-side library observes the creative-rendered anchor only through its consequence, `Container:init`. On the container side, the handshake that leads to `Container:init` is anchored to the creative-rendered signal, with no fixed wall-clock delay: the container composes "environment ready ∧ creative rendered", and the creative-rendered signal is anchored to the creative document's `window` `load`. Restated at the wire, readiness does not fire before `Container:init` is received.

> **OR-5 (Environment honesty preserved).** A replayed readiness invocation MUST carry the same honest `currentState` (INV-6) as the live invocation.

> **OR-6 (Ordering vs start).** Readiness (`Container:init`) precedes start (`Container:startCreative`). The start signal is a one-shot. It is not folded into the readiness replay model: the reference SDK does not replay it to a late registrant (`test:onready-replay` OR-6b).

**Readiness participates in the init handshake.** A creative-side library resolves `Container:init` only after every readiness listener registered before init has completed: each listener's returned promise has resolved, or the listener returned synchronously. Such a listener that throws, or whose promise rejects, causes `Container:init` to be **rejected**, and the container treats that as fatal (§2.5; `src/sharc-container.js` ~:4194–4201). In the reference SDK a throwing listener rejects `init` with `2108` (`AD_INTERNAL_ERROR`), and a rejecting promise with the rejection's `errorCode` or else `2108` (`src/sharc-creative.js` `_handleInit` ~:424, ~:437–442), so the container's fatal error carries that code. `2104` is only the container's fallback for a reject that carries no code. A late (replayed) listener runs after init is settled; its throw is swallowed and affects nothing. The container sends `Container:startCreative` only after init resolves, and the init window is short (2 s by default, L1 §1.19). Readiness handlers therefore should resolve promptly, after caching environment data, and should not await creative-side work that is not needed before start. (This is lower-case guidance carried from a bridge design note, not an RFC-2119 requirement.)

**Before readiness.** A creative-side library may accept listener registrations (readiness, `stateChange`, and so on) before a session exists. Those registrations are buffered and served by the replay rules above. No container message is delivered before the session is established (INV-5).

> DIVERGENCE (implementation bug, #458; GATE-DESIRED): in the reference SDK, a pre-init readiness listener that throws aborts the dispatch loop. `_handleInit` rejects `init` and returns, so listeners after it in registration order are never invoked. That breaks OR-2's "MUST be invoked exactly once" for those listeners. Source: `src/sharc-creative.js` `_handleInit` (~:409–425). Late-replayed listeners' throws are swallowed (`onReady`, ~:636–640).
>
> Editorial note (OR-2, OR-4, OR-6 vs the ADR): (1) OR-2: the ADR says a pre-registered listener is invoked "when init resolves". In the reference SDK listeners are invoked while `Container:init` is handled, and `init` resolves only after they complete (`src/sharc-creative.js` ~:400–425). The draft wording "when `Container:init` is handled" is kept as the accurate one. (2) OR-4: the ADR's MUST, "MUST NOT fire before the creative-rendered anchor (HB-3)", is restored as the MUST (unified lifecycle-ordering ADR, 2026-06-13, §4.2). The extraction draft had re-anchored it to "not before `Container:init` is received", because `Container:init` is all a creative-side library observes. That wire restatement is now carried as the note under OR-4, matching the INV-8 revert (§2.8.4). The ADR marks the load anchor TARGET; the TARGET has shipped (Slice A). (3) OR-6: the ADR leaves start replay out of scope; it does not prohibit it. The extraction draft had invented a MUST NOT. It is restated descriptively, with the reference behavior and its pin.
>
> Editorial note (source): OR-1…OR-6 are transcribed from the unified lifecycle-ordering ADR (2026-06-13, Obsidian, §4.2, "onReady as a first-class replaying event"), with the readiness load anchor from its HB-3 / §5 cascade. This is NEW-PROSE-from-ADR: the repo estate carries these rules only in test comments and source comments. The skeleton row cites the 2026-06-12 MRAID lifecycle-binding ADR; that ADR predates OR-1…OR-6, which the 2026-06-13 ADR (§4) defines. The "resolve promptly" paragraph is the L2-general part of `docs/design/mraid-bridge-design.md` §8.3, which binds the MRAID bridge. Here it is generalized to any readiness listener. The §8.3 code sample is stale against the shipped SDK and is intentionally not carried.

> GATE-DESIRED: the "a throwing or rejecting readiness listener rejects `Container:init`" behavior, and the container's init-reject → fatal path, are observed in the reference implementation (`src/sharc-creative.js` `_handleInit`; `src/sharc-container.js` ~:4194–4201) but not pinned by any test.

<!-- trace: source=unified lifecycle-ordering ADR (2026-06-13, Obsidian) §4.2 OR-1…OR-6 + HB-3/§5 (NEW-PROSE-from-ADR) + docs/design/mraid-bridge-design.md §8.3 (L2-general part) + skeleton-cited MRAID lifecycle-binding ADR (2026-06-12) | gate=test:onready-replay (OR-1…OR-6 incl. OR-6b start not replayed + wrapper-clobber closure); test:lifecycle-conjunction-gate (handshake fires off the render signal on both variants, no fixed-delay timer — HB-3); test:lifecycle-load-anchor (Markup tier — T1/T2: createSession anchored to inner window load; T3: MRAID ready at/after load); test:creative-validator-url-lifecycle-gates (URL tier: ready.firstAt ≥ documentLoadAt); init-reject-on-throw (2108) + container init-reject → fatal + throw-abort DIVERGENCE #458 GATE-DESIRED; OR-4 MUST restored to the ADR's creative-rendered anchor (wire restatement as a note) — annotated out: test:mraid-ready-document-load-gate (fake host; pins the MRAID bridge's own gate, not OR-4) -->

### 2.10 Extension framework

#### Feature descriptors

Features are advertised in `Container:init` `supportedFeatures` (§2.5) and returned by `getFeatures` (§2.6). Each entry is either:

- a **feature-name string**, for example `'com.iabtechlab.sharc.placement.resize'`; or
- a **feature descriptor object**:

```typescript
interface Feature {
  name: string;      // Namespaced feature name
  version?: string;  // Feature version
  [key: string]: any; // Feature-defined metadata (e.g. functions, capabilities)
}
```

A creative-side library determines a feature's presence by its name: the string itself, or the descriptor's `name`.

> Editorial note (stale claim corrected): the source (api-reference.md §9 "Feature Object") gave `Feature` as `{ name: string; version: string; functions: object }` and implied every entry is such an object. In the reference implementation, `supportedFeatures` is `Array<string | {name, version?, …}>`. Container extensions contribute **names only**, through `getFeatureName()`. Built-in features are names. Descriptor objects appear only when the operator passes them explicitly through the `supportedFeatures` constructor option. Source: `src/sharc-container.js` (`Container:init` feature merge, ~:4081–4125), `src/sharc-protocol.js` `sendInit` JSDoc, and `src/sharc-creative.js` `_handleInit`, which keys presence on `f.name || f`. The container never reads an extension's `getFeatureDescriptor()` (`src/sharc-omid-bridge.js` ~:628 defines one; no container call site exists), which is why extension contributions are names only. The index signature `[key: string]: any` goes beyond the `sendInit` JSDoc (`{ name, version? }`); it is kept to describe operator-supplied descriptor metadata, which the container passes through unchanged.

#### Namespacing

| Namespace | Owner |
|-----------|-------|
| `com.iabtechlab.sharc.*` | IAB Tech Lab official features |
| `com.*` | Third-party features using reverse-domain notation |

Examples:
- `com.iabtechlab.sharc.audio`: IAB-defined audio control extension
- `com.iabtechlab.sharc.placement.resize`: container supports validated resize with close region enforcement
- `com.iabtechlab.sharc.placement.constraints`: creative can query placement constraints via `getPlacementConstraints`
- `com.iabtechlab.sharc.placement.animate`: container supports animated placement transitions
- `com.iabtechlab.sharc.location`: IAB-defined location extension
- `com.example.customtracking`: third-party tracking extension

> Reference implementation (informative): the reference container builds `supportedFeatures` in this order:
>
> 1. the operator's explicit `supportedFeatures` option (names or descriptors);
> 2. the name each installed container extension returns from `getFeatureName()`: `com.iabtechlab.sharc.mraid` for the MRAID compatibility bridge, `com.iabtechlab.sharc.safeframe` for the SafeFrame compatibility bridge, `com.iabtechlab.sharc.omid` for the OMID bridge (only when it is configured to measure, L1 §1.14), and any operator extension's name;
> 3. `com.iabtechlab.sharc.creative-injector`, only when the container has actually injected the creative SDK into the markup;
> 4. the three `com.iabtechlab.sharc.placement.*` names above, unconditionally.
>
> The MRAID and SafeFrame names are advertised only when the operator passes the bridge as a container extension. The container does not instantiate them on its own. Sources: `src/sharc-container.js` ~:4081–4125; `src/sharc-mraid-bridge.js` `MRAIDCompatBridge` (~:1609, `getFeatureName` ~:1634); `src/sharc-safeframe-bridge.js` `SafeFrameCompatBridge` (~:703, ~:728); `src/sharc-omid-bridge.js` `getFeatureName` (`_advertisesFeature()`, ~:618 / ~:671–676).
>
> Editorial note (stale claim corrected): the extraction draft listed only the placement, creative-injector, and OMID names, and omitted the compatibility-bridge contributions.

#### Advertising features from a container

A container advertises features in the `supportedFeatures` argument of `Container:init`. That argument is a sibling of `environmentData` in the init args, not a field inside `EnvironmentData`:

```json
{
  "type": "SHARC:Container:init",
  "args": {
    "environmentData": { "…": "…" },
    "supportedFeatures": [
      "com.iabtechlab.sharc.placement.resize",
      { "name": "com.iabtechlab.sharc.audio", "version": "1.0" }
    ]
  }
}
```

> Editorial note (stale claim corrected): the source example assigned `environmentData.supportedFeatures = [...]`. The wire places `supportedFeatures` beside `environmentData` in `Container:init` args (§2.5 `ContainerInitArgs`; `src/sharc-protocol.js` `sendInit(environmentData, supportedFeatures)`).

#### Invoking a feature

A creative invokes a feature with `SHARC:Creative:request[FeatureName]` (§2.6). Check the feature's presence in `supportedFeatures` first.

> GATE-DESIRED: no test pins the merge order, the MRAID/SafeFrame bridge contributions, the descriptor pass-through, or `getFeatures` returning the same list as `init`. The OMID contribution is pinned only extension-side: `test:omid-container-lifecycle` (name when configured, `null` when inert) and, for native service mode, `test:g6-red` R-C (`test/g6-red/test-g6-omid-bridge-service-mode.js` ~:91–105; not yet in `npm test`). Both are partial pins.

<!-- trace: source=api-reference.md §9 (Feature Object, Namespacing, Advertising Features from a Container; "Using Extensions" is SDK usage → §2.14 annex) + src/sharc-container.js feature merge | gate=partial pins: test:creative-sdk-injection (5d / 8b: creative-injector advertised only when actually injected); test:omid-container-lifecycle (OMID getFeatureName() → name when configured, null when inert); test:g6-red test/g6-red/test-g6-omid-bridge-service-mode.js R-C (~:91–105: in native service mode the OMID bridge's getFeatureName() returns com.iabtechlab.sharc.omid on omSdkSessionClientUrl alone — partial, extension-side only; test:g6-red is not in npm test, pending gate promotion); rest GATE-DESIRED (skeleton row 2.10: no dedicated negotiation suite) — annotated out: test:bridges-detection (stubs hasFeature; pins nothing here) -->

### 2.11 Lifecycle event payloads (creative-side view)

> MOVED to L1 (row retired from L2 by ruling; the L1 home lands in slice 3b). The source, the `onContainerLifecycleEvent` extension-hook payloads in `api-reference.md §9`, is container-side L1 behavior. The creative-side view of lifecycle events is the wire: §2.5, §2.8, and §2.9.

### 2.12 OMID from inside the creative

Container-owned OMID measurement is L1 material (L1 §1.14 and §1.15, both RESERVED). This section covers only what a creative may do from inside its own document on the **Creative URL** variant, where the container never injects anything.

OMID reaches Creative URL creatives in three tiers:

- **T1: bid sidecar.** The publisher-page OM SDK service provides measurement with full authority and requires no cooperation from the creative (L1 §1.15).
- **T2: creative self-includes the shim.** The creative includes the SHARC OMID shim (`sharc-omid-shim.js`) itself. The container delivers the OMID protocol nonce over the **already-established session port**, never through injection, URL, or DOM.
- **T3: self-carried session client.** Documented only. It is not built in the reference implementation.

#### `SHARC:Container:omidShimInit`

Sent by the container to deliver the OMID protocol nonce to a creative-self-included shim on the Creative URL variant.

**Direction:** Container → Creative
**Requires response:** No (fire-and-forget)

**Args:**

```typescript
interface OmidShimInitArgs {
  protocolNonce: string;       // The per-protocol nonce derived for the SHARC:Omid: prefix (L1 §1.11.3)
  placementSessionId: string;  // The container's placementSessionId
}
```

The container sends `omidShimInit` only on the Creative URL variant, only after the creative has resolved `Container:init`, and only when an installed container extension supplies a non-empty OMID protocol nonce for the placement. The ordering is anchored at the `init` resolve so that the message cannot race the creative-side listener registration.

> Editorial note (stale claim corrected): the extraction draft said the message is sent "only when container-owned OMID is armed (an OMID extension is configured to measure, and the operator has not opted out with `exposeOmid3p: false`)". The real condition is narrower in one way and broader in another. The reference container sends the message when an extension's `getRendererOmidInjection()` returns a non-empty `protocolNonce`. For the OMID bridge that requires three things: `exposeOmid3p` is not `false`, the bridge has registered its `SHARC:Omid:` router protocol, and the router has derived the per-protocol nonce. The bridge registers that router protocol unconditionally on the container's `load` lifecycle event. Whether the bridge is configured to measure, that is, whether it advertises the OMID feature (§2.10, `_advertisesFeature()`), is not consulted. Sources: `src/sharc-container.js` `_maybeSendOmidShimInit` (~:4270–4290); `src/sharc-omid-bridge.js` `getRendererOmidInjection` (~:1882–1889), the `load` handler (~:798–803) and `_registerOmidProtocol` (~:1820–1827). The Creative Markup variant never uses this message: its nonce is baked into the renderer's shim prelude before `document.write` (L1 §1.7). A creative-side library that does not recognize the message ignores it.

On receipt, a conforming creative-side library hands the shim `{protocolNonce, placementSessionId}` together with a way to post the shim's `SHARC:Omid:Register` envelope **over the session port**, never via `window.parent.postMessage`. It also replays the init once to a shim that registers after the message arrived, as in §2.8.5. (The reference SDK does not reset this cache per session: see the INV-21 DIVERGENCE.) The nonce is observable to code inside the creative iframe. This is accepted by design: the trust basis is per-protocol nonce isolation, not port secrecy (L1 §1.11.3).

> Reference implementation (informative): the SDK installs a self-included shim automatically when `window.SHARC.installOmidShim` is present, and exposes `SHARC.onOmidShimInit(listener)` for a shim that loads later.

> Named residual (G5 close record): the publisher → shim OMID *event* relay fails closed against the opaque-origin URL iframe. On the URL path, T2 currently means "the shim subscribes and registers". Event delivery over the port is future work outside the ratified seam.

> Editorial note (registry omission corrected): `SHARC:Container:omidShimInit` is a shipped wire message (`ContainerMessages.OMID_SHIM_INIT`, `src/sharc-protocol.js`) that the source message-type reference omitted. It is now listed in Appendix A.

> Pinned (partial): the R3 contract (`test:g5-url-contracts`, `test/g5-contracts/test-g5-omid-shim-nonce-over-port-contract.js` ~:68–114) calls the SDK's `_handleOmidShimInit` directly with a fixture payload. It pins that a registered shim listener receives `protocolNonce` and `placementSessionId` verbatim, exactly once, together with a `postRegister` function, and that this init installs the existing shim unchanged. It drives no port and checks no negative path (DOM, URL, `window.parent`).
>
> GATE-DESIRED: the container-side gating (URL variant only, nonce present, after `init` resolves), delivery over the real port, `postRegister` over the port, the late-shim replay, and the SDK's automatic shim installation have no gated test. `test/browser/g5-f3-omid-shim-spike.js` witnesses the end-to-end path in real Chrome (delivery over the established port, auto-install with the delivered nonce, a wrong-nonce negative control, `Register` arriving over the port), but it is not in any npm script: an un-gated witness.

<!-- trace: source=tools/creative-validator/analysis/g5-url-mode-conformance-close.md §The ratified contract (T1/T2/T3) + claim 8 + §Named residuals; README §Open Measurement "Spec-compliant iframe shim (0.7.8)" (creative-facing paragraph); wire shape from src/sharc-container.js _maybeSendOmidShimInit + src/sharc-creative.js _handleOmidShimInit | gate=test:g5-url-contracts (R3, partial: test/g5-contracts/test-g5-omid-shim-nonce-over-port-contract.js drives _handleOmidShimInit directly — listener receives nonce + placementSessionId + postRegister once; no port, no negative paths); container gating / real-port delivery / postRegister / late replay / auto-install GATE-DESIRED (un-gated witness: test/browser/g5-f3-omid-shim-spike.js, in no npm script) — annotated out: test:omid-shim, test:omid-shim-transport (neither touches omidShimInit) -->

### 2.13 Creative errors (21xx)

Codes in the 21xx range are raised by, or attributed to, the creative and its load path, including the Creative Markup renderer path (2114–2120). The cross-namespace semantics (which wire position a code travels in, and the rule that position rather than code determines severity) are stated once in L1 §1.18. A creative-side library uses 21xx codes in:

- the `errorCode` of a `SHARC:Creative:fatalError` (§2.6);
- the `errorCode` of a `reject` the creative sends, for example rejecting `Container:init` (`2103` wrong SHARC version, `2102` container dimensions not suited) or `Container:startCreative`.

The citable code ↔ name tables, with the supersession diff against Legacy §Error Codes, are [registries.md](registries.md) R1 (21xx) and R2 (22xx). api-reference.md §11 remains an informative companion listing.

`2105` is **reserved**. It keeps its legacy meaning, "Resize request not honored", and is never reused. The navigation handoff a creative receives in a `requestNavigation` reject is the container-raised code `2214` (`NAVIGATION_NOT_HANDLED`), in the 22xx namespace (L1 §1.18; §2.6).

> Editorial note (ratified 2026-10-03, Ruling 1; supersession delta, Legacy §Error Codes): the legacy draft defined `2105` as "Resize request not honored". The estate (api-reference.md §11) had re-used `2105` for the navigation handoff, and this section previously said the creative receives that one 21xx code. That reuse was never ratified. By ruling, the handoff is `2214` in the 22xx list, `2105` is reserved with its legacy meaning, and the sentence about a received 21xx code is dropped. The reference implementation still sends `2200` for the handoff (§2.6, DIVERGENCE #464).
>
> Reference implementation (informative): the reference `ErrorCodes` registry (`src/sharc-protocol.js`) defines 2100, 2101, 2103, 2104, 2108–2111, and 2114–2122. It does not define `2102` or `2105`. 2112 and 2113 are intentionally unassigned. `2121` and `2122` are `onSecurityEvent` diagnostics (L1 §1.11.8) that never appear on the creative wire.

<!-- trace: source=api-reference.md §11 (Creative Errors 21xx) + Legacy §Error Codes (supersession: 2101–2111; full diff in registries.md R1 and L1 §1.4) | gate=registry ↔ src ErrorCodes cross-check GATE-DESIRED (test:spec-structure phase b indexes RFC-2119 lines only; corrected in slice 4); 2105 reserved / 2214 handoff per Ruling 1 (ratified 2026-10-03), implementation DIVERGENCE #464 -->

### 2.14 Annex (INFORMATIVE): reference SDK and cookbook pointers

This annex is informative. Nothing in it is a requirement.

- **Reference creative SDK:** `sharc-creative.js`, published as the `@iabtechlab/sharc/sharc-creative` subpath export and as the browser global `window.SHARC`. Its JSDoc is the API reference for `SHARC.onReady`, `SHARC.onStart`, `SHARC.on(event, fn)`, `SHARC.hasFeature`, `SHARC.requestFeature`, `SHARC.requestNavigation`, `SHARC.requestPlacementChange`, `SHARC.requestOrientationProperties`, `SHARC.onOmidShimInit`, and related methods. See README §Quick Start for entry points.
- **Using extensions with the reference SDK:** `SHARC.hasFeature(name)` is a synchronous presence check over the init `supportedFeatures`. `SHARC.requestFeature(name, args)` sends `SHARC:Creative:request[FeatureName]`. See api-reference.md §9 "Using Extensions".
- **Authoring patterns:** `docs/creative-cookbook.md` (INFORMATIVE) covers creative-side authoring recipes. `docs/operator-cookbook.md` covers the operator side.

<!-- trace: source=README §Quick Start + api-reference.md §9 "Using Extensions" + docs/creative-cookbook.md (pointers only) | gate=NO-GATE (informative annex) -->

---

## Appendix A — Message type reference

### Container → Creative

| Message | Response Required | When Sent |
|---------|------------------|-----------|
| `SHARC:Container:init` | resolve or reject | After createSession resolved |
| `SHARC:Container:startCreative` | resolve or reject | After init resolved |
| `SHARC:Container:stateChange` | None | On any state transition |
| `SHARC:Container:placementChange` | None | After placement changes |
| `SHARC:Container:placementConstraintsChange` | resolve | When placement constraints change (rotation, resize, policy update) |
| `SHARC:Container:placementTransitionEnd` | resolve | When placement animation completes or is skipped |
| `SHARC:Container:audioVolumeChange` | None | When audio state changes |
| `SHARC:Container:omidShimInit` | None | Creative URL variant, OMID nonce available: after the creative resolves `init` (§2.12) |
| `SHARC:Container:effectiveVisibilityChange` | None | When the effective-visibility composer recomputes |
| `SHARC:Container:log` | None | Debug/warning messages |
| `SHARC:Container:fatalError` | resolve | On unrecoverable container error |
| `SHARC:Container:close` | resolve | When close sequence begins |

### Creative → Container

| Message | Response Required | When Sent |
|---------|------------------|-----------|
| `SHARC:Creative:createSession` | resolve | As soon as creative is ready |
| `SHARC:Creative:fatalError` | None | On unrecoverable creative error |
| `SHARC:Creative:getContainerState` | resolve | Any time |
| `SHARC:Creative:getPlacementOptions` | resolve | Any time |
| `SHARC:Creative:getPlacementConstraints` | resolve | Any time after init (requires `com.iabtechlab.sharc.placement.constraints` feature) |
| `SHARC:Creative:log` | None | Debug/warning messages |
| `SHARC:Creative:reportInteraction` | resolve | On user interaction |
| `SHARC:Creative:requestNavigation` | resolve or reject | On clickthrough |
| `SHARC:Creative:requestPlacementChange` | resolve or reject | On resize/expand/collapse |
| `SHARC:Creative:requestClose` | resolve or reject | When creative wants to close |
| `SHARC:Creative:setOrientationProperties` | None | When the creative sets orientation properties (§2.6) |
| `SHARC:Creative:getFeatures` | resolve | Any time after init |
| `SHARC:Creative:request[FeatureName]` | resolve or reject (see the §2.6 DIVERGENCE) | When using an extension |
| `SHARC:Omid:Register` | None | Creative URL variant, tier T2: a self-included OMID shim registers over the session port after `omidShimInit` (§2.12) |

This appendix is the registry of record for session-port message types. Per skeleton §D, [registries.md](registries.md) R3 cites it rather than copying it, and adds the message types that travel outside the session port. The response column matches the reference protocol's `MESSAGES_REQUIRING_RESPONSE` set (`src/sharc-protocol.js`), except where a DIVERGENCE is flagged. `SHARC:Omid:Register` is in the `SHARC:Omid:` namespace, not `SHARC:Creative:`. It is listed here because, on the Creative URL T2 path, it travels creative → container over the session port (`src/sharc-creative.js` `_handleOmidShimInit`, pinned `postRegister` type, ~:509–520); its envelope is L1 OMID material (L1 §1.14, RESERVED).

<!-- trace: source=api-reference.md §Appendix: Message Type Reference (+ omidShimInit and setOrientationProperties rows, and the placementConstraintsChange/placementTransitionEnd response column, corrected against src/sharc-protocol.js ContainerMessages / CreativeMessages / MESSAGES_REQUIRING_RESPONSE) | gate=registry ↔ src cross-check GATE-DESIRED (test:spec-structure phase b indexes RFC-2119 lines only; corrected in slice 4); per-message pins at each message's section -->
