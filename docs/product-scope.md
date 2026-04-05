# SHARC Reference Implementation — Product Scope & MVP Definition

**Document Status:** Active — Reflects Decisions from 2026-04-03  
**Version:** 0.3  
**Authors:** Product Management  
**Last Updated:** 2026-04-03  

---

## Decision Log

### 2026-04-03 — Jeffrey Carlson Approved (Building Tonight)

| Decision | Resolution |
|----------|------------|
| **Transport** | MessageChannel (primary) + postMessage fallback. Drop manual JSON.stringify — use Structured Clone. |
| **State machine** | Page Lifecycle API aligned: `ready`, `active`, `passive`, `hidden`, `frozen`. `loading`/`terminated` are container-internal bookends, never sent to creative. |
| **Platform scope** | Web (iframe) + iOS WKWebView + Android WebView only. CTV / DOOH / Games out of scope for v1. |
| **Design philosophy** | Web standards first, simplicity, extensibility via extensions. |

### 2026-04-02 — Jeffrey Carlson (Scope Clarification)

| Decision | Resolution |
|----------|------------|
| Platform scope | Web + Mobile in-app. CTV: out of scope for v1 (inconsistent WebView across platforms). |
| Transport | postMessage is valid for all in-scope platforms. |
| Design principle | Lean into well-established web patterns in HTML, DOM, and JavaScript whenever possible. |

---

## Decision Log Update (Jeffrey Carlson, 2026-04-03)
- **MRAID Bridge:** Part of the spec and MVP — but sequenced AFTER all core SHARC issues are resolved first.
- Phase 1 order: Core protocol → Security hardening → Resolve open items → MRAID bridge

---

## Executive Summary

SHARC (Secure HTML Ad Rich-media Container) is the IAB Tech Lab standard that replaces both MRAID and SafeFrame with a single cross-platform API. The reference implementation exists to **prove the spec is real**, lower the barrier to adoption, and give the industry something to fork from.

The goal is simple: **build one ad; serve it everywhere.** For v1, "everywhere" means web iframes, iOS WKWebView, and Android WebView — the three environments where publishers and developers need this most today.

**The project stalled before because it tried to solve everything at once.** The fix is disciplined MVP scope: ship the core messaging loop working end-to-end before touching extensibility, compatibility bridges, or supply chain integration.

---

## Why SHARC Exists (and Why It Has to Ship)

| Problem | MRAID | SafeFrame | SHARC |
|---------|-------|-----------|-------|
| Cross-platform (web + in-app) | ❌ | ❌ | ✅ |
| Secure container (ad can't touch publisher content) | ❌ | ✅ | ✅ |
| Single creative runs everywhere | ❌ | ❌ | ✅ |
| Extensible without version lock | ❌ | ❌ | ✅ |
| Aligned with web standards (Page Lifecycle, MessageChannel) | ❌ | ❌ | ✅ |

---

## Stakeholder Map

### Primary Stakeholders (must win first)

| Stakeholder | Role in SHARC | What they need from this project |
|-------------|---------------|----------------------------------|
| **Publishers / SSPs** | Implement the **container** | A working container library for web and mobile webview they can drop in |
| **Creative Developers** | Build SHARC-enabled ads | A creative-side SDK + working sample ads they can copy |
| **Ad Networks / DSPs** | Serve SHARC creatives | Confidence the standard is stable; sample creatives that validate against their ad servers |

### Secondary Stakeholders (Phase 2+)

| Stakeholder | Role | What they need |
|-------------|------|----------------|
| **Open Measurement / IAS / DV** | Measurement | OM extension + event bus documentation |
| **Header Bidding (Prebid)** | Ad request/delivery pipeline | OpenRTB/AdCOM SHARC signal in bid request |
| **IAB Tech Lab Members** | Standards governance | A working impl that validates the spec is implementable |

### Governance Stakeholders

| Stakeholder | Role |
|-------------|------|
| **Jeffrey Carlson (Chartboost)** | Co-chair, primary approver |
| **Aron Schatz (DoubleVerify)** | Co-chair, measurement perspective |
| **IAB Tech Lab Safe Ad Container WG** | Spec governance |

---

## Phase 1 — MVP

> **The MVP is the smallest possible thing that proves SHARC works end-to-end.**

### What "Done" Looks Like

A **creative developer** can:
1. Write an HTML ad using the SHARC Creative SDK
2. Serve it into a SHARC container running in a browser or mobile webview
3. See the ad render, respond to resize, navigate on click, and close cleanly
4. Watch the full message log to verify protocol compliance

A **publisher developer** can:
1. Drop in the SHARC container library
2. Load any SHARC-enabled creative
3. Know the ad cannot touch their page DOM

### Transport Architecture

**Primary: MessageChannel**  
The container creates `new MessageChannel()`, gets `port1` (container-side) and `port2` (creative-side). The container passes `port2` to the creative via an initial `postMessage` handshake:

```javascript
iframe.contentWindow.postMessage(
  { type: 'SHARC:connect', port: port2 },
  creativeOrigin,
  [port2]   // transfer ownership
);
```

All subsequent SHARC messages flow through the dedicated port pair. No broadcast to `window`. No message collision risk from other iframes.

**Fallback: window.postMessage**  
Used only when MessageChannel is unavailable (effectively zero real-world cases for in-scope platforms). Requires `sessionId` filtering to disambiguate messages.

**Serialization: Structured Clone (automatic)**  
MessageChannel and postMessage both use the browser's Structured Clone algorithm natively. No manual `JSON.stringify` / `JSON.parse` needed. The message object is transferred as-is.

### State Machine

States align precisely with the **Chrome/WebKit Page Lifecycle API**:

| State | Creative-Queryable | Description |
|-------|-------------------|-------------|
| `loading` | ❌ (internal) | Container created; creative not yet connected |
| `ready` | ✅ | Init complete; `startCreative` pending |
| `active` | ✅ | Visible + focused + interactive |
| `passive` | ✅ | Visible; no input focus (split-screen, call interruption) |
| `hidden` | ✅ | Not visible (app backgrounded, tab hidden, screen off) |
| `frozen` | ✅ | JS suspended by OS (battery/memory management) |
| `terminated` | ❌ (internal) | Container destroyed; no further communication |

**Valid transitions:**

```
loading → ready → active ↔ passive ↔ hidden → frozen
              ↓       ↓        ↓        ↓        ↓
          terminated (on any close or fatal error)
```

Close is handled by the `Container:close` message + creative `resolve` pattern — no separate `closing` state needed.

### MVP Deliverables

#### 1. Container Library (`sharc-container`)

The single most critical deliverable. Everything else depends on it.

**Messages to implement:**
- `SHARC:Container:init` — with full `EnvironmentData`, `supportedFeatures`, `Placement`
- `SHARC:Container:startCreative`
- `SHARC:Container:stateChange` — all 5 queryable states
- `SHARC:Container:placementChange`
- `SHARC:Container:log`
- `SHARC:Container:fatalError`
- `SHARC:Container:close`

**Protocol requirements:**
- MessageChannel handshake with postMessage fallback
- Origin validation — container MUST record iframe origin at creation; all incoming messages validated against it
- Full `createSession` + timeout handling
- `resolve` / `reject` message routing

**Close control:** Container MUST always render a close button. Top-right, 50×50 DIPs by default. No exceptions.

#### 2. Creative SDK (`sharc-creative-sdk`)

The second most critical deliverable. Creative developers won't read the spec — they'll copy the SDK.

**Messages to implement:**
- `SHARC:Creative:createSession`
- `SHARC:Creative:fatalError`
- `SHARC:Creative:getContainerState`
- `SHARC:Creative:getPlacementOptions`
- `SHARC:Creative:log`
- `SHARC:Creative:reportInteraction`
- `SHARC:Creative:requestNavigation`
- `SHARC:Creative:requestPlacementChange`
- `SHARC:Creative:requestClose`
- `SHARC:Creative:getFeatures`

**SDK design principles:**
- Single JS file. No build tools required to use it.
- Promise-based API. Creative developers never touch `sessionId` or `messageId`.
- Automatic handshake — SDK handles `createSession` and protocol setup internally.
- Target size: < 10KB minified.

#### 3. Messaging Protocol

- MessageChannel handshake (with postMessage fallback)
- Structured Clone for message serialization (no manual JSON)
- Session ID generation (UUID)
- `messageId` sequencing (0-indexed, per-party, independent)
- `resolve` / `reject` semantics with `messageId` back-reference
- Timeout enforcement:

| Event | Default Timeout | On Expiry |
|-------|-----------------|-----------|
| `createSession` | 5 seconds | Destroy; error 2212 |
| `Container:init` resolve | 2 seconds | Destroy; error 2208 |
| `Container:startCreative` resolve | 2 seconds | Destroy; error 2213 |
| Close sequence | 2 seconds | Force unload |

#### 4. Sample Creatives

Color blocks with SHARC wrappers — the spec's own recommendation for sample creatives.

| Sample | Tests |
|--------|-------|
| `basic` | Renders, resolves init, responds to close. Smoke test. |
| `resize` | Calls `requestPlacementChange` to expand/collapse on user click. |
| `clickthrough` | Calls `requestNavigation`, handles resolve/reject. |

These are the onboarding ramp for creative developers. Each must be readable in under 5 minutes.

#### 5. Test Harness

A single HTML page (no server required) that:
- Loads the container library
- Loads any SHARC creative via URL parameter
- Displays the full message log in a dev console panel
- Shows current container state
- Lets the developer manually trigger: state changes, fatal error, close

This is also the first version of the **creative validation tool**. Point it at a creative; see if the protocol is correct.

### Phase 1 Success Metrics

| Metric | Target |
|--------|--------|
| Full init cycle works end-to-end | ✅ (binary) |
| All 5 queryable container states reachable | ✅ (binary) |
| 3 sample creatives pass test harness | ✅ (binary) |
| Container library < 20KB minified | ≤ 20KB |
| Creative SDK < 10KB minified | ≤ 10KB |
| Time from clone to working ad | ≤ 30 minutes |
| External dev can implement container from spec + reference code | 1 confirmed |

**Phase 1 gate:** Jeffrey Carlson reviews and signs off on the working demo before any Phase 2 work begins.

---

## Phase 2 — Platform Expansion + Compatibility

*Begins only after Phase 1 is confirmed working.*

### Goals
- Run the same container on **iOS WKWebView** and **Android WebView** (not just browser iframe)
- **MRAID compatibility bridge** — MRAID 3.0 creative runs in SHARC container without modification
- **SafeFrame compatibility bridge** — SafeFrame resize/collapse in SHARC container
- **Open Measurement extension guidance**

### Mobile Container

A native SDK wrapper that:
- Creates a WKWebView (iOS) or WebView (Android)
- Injects the SHARC container JS into the webview
- Bridges native platform lifecycle events to SHARC state changes:
  - iOS: `applicationWillResignActive` → `passive`, `applicationDidEnterBackground` → `hidden`, WebContent process suspend → `frozen`
  - Android: `Activity.onPause()` → `passive`, `Activity.onStop()` → `hidden`, `WebView.pauseTimers()` → `frozen`
- Reports `navigationPossible: true` and handles deep links to app store, OS browser, etc.

**Implementation note:** The JS container code is the same file used in Phase 1. The native layer is a thin bridge only.

### MRAID Compatibility Bridge

A JavaScript shim that:
- Exposes the MRAID 3.0 API surface (`mraid.getState()`, `mraid.expand()`, `mraid.resize()`, `mraid.close()`, `mraid.open()`, etc.)
- Translates MRAID calls into SHARC messages
- Translates SHARC container messages back into MRAID events

**MRAID state → SHARC state mapping:**
| MRAID State | SHARC State |
|-------------|-------------|
| `loading` | `loading` (internal) |
| `default` | `ready`, `active`, `passive` |
| `expanded` / `resized` | `active` + placement change resolved |
| `hidden` | `hidden` |

**Scope boundary:** MRAID 3.0 only. MRAID 1.x/2.x edge cases (storePicture, createCalendarEvent, two-part expand with separate URL) are documented as unsupported.

### SafeFrame Compatibility Bridge

A JavaScript shim that:
- Exposes `$sf.ext.expand()`, `$sf.ext.collapse()`, `$sf.ext.geom()`
- Maps to SHARC `requestPlacementChange`

**Scope boundary:** SafeFrame metadata/data communication (`$sf.ext.meta`) is out of scope. Resize/collapse only.

### Phase 2 Success Metrics

| Metric | Target |
|--------|--------|
| Same creative runs in web iframe AND mobile webview | ✅ (binary) |
| MRAID 3.0 creative renders and resizes in SHARC container | ✅ (binary) |
| MRAID creative clickthrough works | ✅ (binary) |
| At least 1 mobile app ships SHARC container | 1 confirmed |
| OM SDK team confirms integration path | ✅ (binary) |

---

## Phase 3 — Ecosystem & Scale

*Begins after Phase 2 is validated in production.*

### Goals
- OpenRTB/AdCOM signal for SHARC support in bid requests
- Automated creative validation tool (CLI)
- CTV container guidance (NOT a code deliverable — guidance doc only)
- Supply chain integration: Prebid adapter documentation, DSP guidance

### OpenRTB/AdCOM Updates

Per "Support Beyond the Container":
- `Placement > Display Placement > API`: add SHARC item (width/height, html, api)
- `List: Creative Subtypes - Display`: add value 5 for "Structured SHARC"
- `Object: Display (under media)`: add SHARC object to Banner containing supported version + components

This is a standards body process, not a code change. Requires IAB Tech Lab OpenRTB/AdCOM working group coordination.

### Creative Validation Tool (CLI)

- `sharc-validate <creative.html>` — headless browser runs creative in SHARC container
- Checks: createSession fires, init resolves within 2s, startCreative resolves, close sequence completes
- Outputs pass/fail with error codes

### Phase 3 Success Metrics

| Metric | Target |
|--------|--------|
| OpenRTB/AdCOM PR submitted to IAB Tech Lab | ✅ (binary) |
| Automated creative validation tool published | ✅ (binary) |
| 5 ad networks confirm SHARC creative delivery capability | 5 confirmed |
| Prebid community engaged and scoping adapter | ✅ (binary) |

---

## What NOT to Build

| Out of Scope | Reason |
|-------------|---------|
| Ad request / delivery | Explicitly out of SHARC scope. |
| Measurement (viewability, attention) | Out of spec scope. Extension guidance only. |
| Video playback controls | SIMID's job. Do not conflate. |
| VAST integration | Not display. Out of scope. |
| CTV reference code | Guidance document only (Phase 3). |
| DOOH | Out of scope for v1. Future extension. |
| Games / intrinsic environments | Out of scope for v1. |
| MRAID 1.x / 2.x edge cases | MRAID 3.0 bridge only. |
| SafeFrame metadata API (`$sf.ext.meta`) | Too bespoke. Resize/collapse only. |
| Prebid adapter | Community-owned. We provide docs + test harness. |
| Native app ad rendering (outside webview) | SHARC is HTML in a webview. |
| Custom extension SDK (third-party namespace) | Third parties own their extensions. |

---

## Open Questions — Status

These were open in v0.1. Resolved items are marked with their decision.

| # | Question | Status |
|---|----------|--------|
| Q1 | `EnvironmentData.data` structure | **Resolved:** Use Aron's proposal: `data.ad`, `data.placement`, `data.context` (directly from AdCOM nodes) |
| Q2 | Does `getFeatures` duplicate `supportedFeatures` from init? | **Resolved:** `getFeatures` returns the same list as init; it exists for convenience / late-binding queries. Features cannot change after init in v1. |
| Q3 | Timeout for `createSession` | **Resolved:** 5 seconds default |
| Q4 | Partial `requestPlacementChange` parameters | **Resolved:** Treat partial as "change only specified fields" |
| Q5 | Navigation handling on web | **Resolved:** Container rejects `requestNavigation` with a specific reject code meaning "creative handles it." `requestNavigation` carries `{url, target}`. Creative must always call it first for logging. |
| Q6 | Minimum `EnvironmentData` without AdCOM | **Resolved:** Required fields: `currentPlacement`, `currentState`, `version`. All AdCOM data fields are optional. |
| Q7 | `muted`/`volume` placement in `EnvironmentData` | **Resolved:** Keep top-level in `EnvironmentData` for v1. Move to `currentState` in v2 if needed. |
| Q8 | `ContainerPlacement` rename | **Resolved:** Adopt rename per "Support Beyond the Container" doc. Use `ContainerPlacement` in reference implementation to avoid confusion with AdCOM `Placement`. |
| Q9 | MRAID vs SafeFrame bridge priority | **Resolved:** MRAID first — more active inventory, more creative developers need migration path. |
| Q10 | Is reference implementation normative? | **Resolved:** Reference implementation is normative for behaviors not specified in the spec. Spec governs structure and message names. |
| **New** | Transport layer | **Resolved (2026-04-03):** MessageChannel primary, postMessage fallback. No JSON.stringify. |
| **New** | State machine | **Resolved (2026-04-03):** Page Lifecycle aligned: `ready`, `active`, `passive`, `hidden`, `frozen`. Drop `closing` state, `terminated` internal only. |

---

## Key Risks to Adoption

| Risk | Severity | Mitigation |
|------|----------|------------|
| "Another standard nobody implements" | HIGH | Creative SDK must be drop-in for MRAID. Container must be single JS file. Ship Phase 1 before announcing. |
| Spec ambiguity blocks implementation | HIGH | Reference implementation IS the authoritative interpretation for unspecified behaviors. |
| Mobile platform restrictions | MEDIUM | Test on real devices early. Document platform-specific behavior. |
| "We need OM first" blocks adoption | MEDIUM | Align OM working group during Phase 1. The message bus architecture makes OM integration straightforward. |
| Supply chain can't signal SHARC support | MEDIUM | Draft OpenRTB/AdCOM changes in Phase 1 so DSPs can plan. Use existing `api` field as interim convention. |
| Project stalls again | HIGH | Phase 1 ships. Jeffrey reviews working demo before Phase 2 begins. Weekly demo cadence during Phase 1. |

---

## Phase 1 API Checklist

### Container Messages
- [ ] `SHARC:Container:init`
- [ ] `SHARC:Container:startCreative`
- [ ] `SHARC:Container:stateChange`
- [ ] `SHARC:Container:placementChange`
- [ ] `SHARC:Container:log`
- [ ] `SHARC:Container:fatalError`
- [ ] `SHARC:Container:close`

### Creative Messages
- [ ] `SHARC:Creative:createSession`
- [ ] `SHARC:Creative:fatalError`
- [ ] `SHARC:Creative:getContainerState`
- [ ] `SHARC:Creative:getPlacementOptions`
- [ ] `SHARC:Creative:log`
- [ ] `SHARC:Creative:reportInteraction`
- [ ] `SHARC:Creative:requestNavigation`
- [ ] `SHARC:Creative:requestPlacementChange`
- [ ] `SHARC:Creative:requestClose`
- [ ] `SHARC:Creative:getFeatures`

### Protocol
- [ ] MessageChannel handshake + postMessage fallback
- [ ] Origin validation
- [ ] Message data structure (sessionId, messageId, timestamp, type, args)
- [ ] `resolve` message handling
- [ ] `reject` message handling
- [ ] Session establishment + timeout
- [ ] Structured Clone serialization (no manual JSON)

### State Machine
- [ ] `loading` (internal)
- [ ] `ready`
- [ ] `active`
- [ ] `passive`
- [ ] `hidden`
- [ ] `frozen`
- [ ] `terminated` (internal)
- [ ] All valid transitions enforced

### Error Codes (Phase 1 must handle)
- [ ] 2100 — Unspecified creative error
- [ ] 2101 — Resources could not be loaded
- [ ] 2103 — Wrong SHARC version
- [ ] 2104 — Creative could not be executed
- [ ] 2200 — Unspecified container error
- [ ] 2201 — Wrong SHARC version (container)
- [ ] 2212 — Creative did not reply to init
- [ ] 2213 — Creative did not reply to start

---

*This document reflects all approved decisions as of 2026-04-03. Phase 1 development is in progress.*
