# SHARC Reference Implementation: Architecture Design Document

**Version:** 0.7 (Final Design — 0.7.0 alignment)  
**Author:** Architecture Review, SHARC Working Group  
**Status:** Final — Decisions Incorporated  
**Reviewer:** Jeffrey Carlson, Project Co-Chair  
**Last Updated:** 2026-05-04

> **Historical design baseline (0.7.0).** This document is the design record that
> the 0.7.0 implementation was built against; it is preserved as a point-in-time
> architecture reference, not a live spec. The codebase has since shipped through
> 0.7.12 with substantial lifecycle rework (the container→creative state-delivery
> contract, bfcache restore, the single effective-visibility composer, native-host
> hooks, and OMID spec-true measurement). For the current, authoritative surface
> see [current-status.md](./current-status.md), [api-reference.md](./api-reference.md),
> the [CHANGELOG](../CHANGELOG.md), and the per-release design docs under
> [`docs/design/`](./design/). Where this document and those disagree, they win.

---

## Table of Contents

1. [Core Design Principles](#1-core-design-principles)
2. [Platform Scope](#2-platform-scope)
3. [Transport Layer: MessageChannel](#3-transport-layer-messagechannel)
4. [State Machine: Page Lifecycle Aligned](#4-state-machine-page-lifecycle-aligned)
5. [Origin Validation and Security](#5-origin-validation-and-security)
6. [Reference Implementation Architecture](#6-reference-implementation-architecture)
7. [Container Library Design](#7-container-library-design)
8. [Creative API Design](#8-creative-api-design)
9. [Extension Framework](#9-extension-framework)
10. [Open Measurement Integration](#10-open-measurement-integration)
11. [MRAID Compatibility Bridge Scope](#11-mraid-compatibility-bridge-scope)
12. [SafeFrame Compatibility Bridge Scope](#12-safeframe-compatibility-bridge-scope)
13. [Gaps, Risks, and Recommendations](#13-gaps-risks-and-recommendations)
14. [Renderer Protocol — Creative Markup Variant](#14-renderer-protocol--creative-markup-variant)

---

## Session ID Decision (Jeffrey Carlson, 2026-04-03)

**v1: Option A — Creative generates session ID (aligned with SIMID)**
- Keeps implementation simple and consistent with SIMID
- MessageChannel port IS the trust boundary — sessionId is a correlation key, not a security token
- Document explicitly: the private port, not the sessionId, is what establishes trust

**Future consideration: Option B — Container generates session ID**
- Stronger case when running multiple creatives simultaneously across different containers
- Container-owned namespace makes multi-session management clean and unambiguous
- Worth revisiting for v2 when multi-ad page scenarios are formally scoped

---

## 1. Core Design Principles

> **Lean into well-established web patterns in HTML, DOM, and JavaScript whenever possible.**
>
> Don't invent new patterns when the platform already has them. Use DOM lifecycle, Page Visibility API, Page Lifecycle API, standard event patterns, and established JS idioms. This lowers the learning curve for implementers and keeps SHARC feeling native to the web.
>
> — Jeffrey Carlson, Project Co-Chair

**Derived principles:**

1. **Simplicity first** — The smallest possible API surface that satisfies real use cases. No speculative features.
2. **Standards over invention** — Use MessageChannel, Structured Clone, Page Lifecycle API, standard Promises. Don't reinvent what browsers already provide.
3. **Extensibility at the edges** — The core protocol stays minimal. Platform-specific behavior and optional features live in the extension framework.
4. **Security by construction** — The transport and session design make cross-origin injection structurally difficult, not just policy-prohibited.

---

## 2. Platform Scope

### 2.1 In Scope (v1)

| Platform | Rendering Context | Transport |
|---|---|---|
| Web browser | Cross-origin iframe | MessageChannel |
| iOS | WKWebView | MessageChannel |
| Android | WebView | MessageChannel |

**CTV (tvOS, Android TV, Tizen, webOS):** Out of scope for v1. WebView support is inconsistent across CTV platforms. Will be added as a platform adapter in a future version.

**DOOH:** Out of scope for v1. Deployment environments are too varied (Chromium kiosk, Electron, native apps, proprietary players) to specify a single approach.

**Games/Intrinsic:** Out of scope for v1. Unity/Unreal/web-native game integrations require entirely different bridge patterns.

### 2.2 Why These Three

Web iframe, iOS WKWebView, and Android WebView share a critical property: they all run a full HTML/JS engine where `MessageChannel` is natively available and has been since 2010. The creative is always HTML running in an isolated rendering context. This means one protocol implementation covers all three environments without any platform adapter layer — the same JavaScript runs everywhere.

---

## 3. Transport Layer: MessageChannel

### 3.1 Decision: MessageChannel as Primary Transport

**Primary transport: `MessageChannel`** (not raw `postMessage`)

| Property | `window.postMessage` | `MessageChannel` |
|---|---|---|
| Browser compatibility | Universal | 97%+ (all modern, since 2010) |
| Message routing | Broadcast to target window | Private port-to-port |
| Cross-frame pollution | Risk from other iframes on page | Eliminated — private channel |
| Serialization | JSON.stringify required (pre-Structured Clone) | Structured Clone natively |
| Transferables | Supported | Supported |
| Security surface | Broadcast risk | Significantly reduced |

**Fallback: `window.postMessage`** — If `MessageChannel` is somehow unavailable (effectively zero real-world cases), fall back to raw `window.postMessage` with sessionId-based filtering.

### 3.2 Handshake Protocol

The container creates the `MessageChannel` and passes one port to the creative:

```
Container                                         Creative (iframe)
   |                                                      |
   |  [creates MessageChannel → port1, port2]             |
   |  [loads creative into iframe]                        |
   |                                                      |
   |── postMessage({type:'SHARC:Container:handshake', version}, '*', [port2]) ──▶ |
   |                                                      |  (one-time bootstrap message)
   |                                                      |  [receives port2]
   |                                                      |  [stores port2 for all SHARC comms]
   |                                                      |
   |◀── port1 (createSession) ─────────────────────────── |
   |── port1 (resolve createSession) ──────────────────▶  |
   |── port1 (Container:init) ──────────────────────────▶ |
   |◀── port1 (resolve Container:init) ─────────────────  |
   |── port1 (Container:startCreative) ─────────────────▶ |
   |◀── port1 (resolve Container:startCreative) ─────────  |
   | [all subsequent comms via dedicated ports only]       |
```

**Key properties:**
1. Container creates `new MessageChannel()` → receives `port1` (container side) and `port2` (creative side)
2. Container sends `port2` to the creative iframe via one initial `postMessage` with the port in the transfer array
3. All subsequent SHARC messages flow through the dedicated ports — no window-level broadcast
4. The one-time bootstrap `postMessage` uses `targetOrigin: '*'` — this is intentional and documented (see §5)

### 3.3 Structured Clone — No JSON.stringify

**Drop `JSON.stringify` / `JSON.parse` entirely.** MessageChannel natively uses the Structured Clone algorithm. This means:
- No serialization overhead
- Complex objects (Date, ArrayBuffer, nested structures) work without custom serialization
- TypedArrays can be transferred (zero-copy) for large payloads

The SHARC message object is passed as-is:
```javascript
// ✅ Correct — Structured Clone
port1.postMessage({
  sessionId: '...',
  messageId: 42,
  type: 'SHARC:Container:init',
  timestamp: Date.now(),
  args: { /* complex objects work natively */ }
});

// ❌ Old pattern — do not use
port1.postMessage(JSON.stringify({ ... }));
```

### 3.4 COOP/COEP Headers (Optional, Recommended)

Publishers who want maximal process isolation may set:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

This enables `SharedArrayBuffer` and fine-grained memory isolation. **These headers are optional and not required by the SHARC spec.** Containers must function correctly without them. The spec should recommend them as a defense-in-depth measure for publishers who support them.

---

## 4. State Machine: Page Lifecycle Aligned

### 4.1 Final State Machine (Jeffrey Carlson, 2026-04-03)

**The SHARC v1 state machine aligns perfectly with the Chrome/WebKit Page Lifecycle API:**

```
loading → ready → active ↔ passive ↔ hidden → frozen → terminated
                         └────────────→ hidden
```

| State | Creative-Queryable? | Visible? | JS Active? | Trigger |
|---|---|---|---|---|
| `loading` | **No** (container-internal) | No | Partial | Container creates WebView |
| `ready` | Yes | No | Yes | `Container:init` accepted |
| `active` | Yes | Yes | Yes | `Container:startCreative` + platform focus |
| `passive` | Yes | Yes | Yes | Platform loses focus (split-screen, call interruption) |
| `hidden` | Yes | No | Yes | App backgrounded, tab hidden, screen off |
| `frozen` | Yes (but JS is suspended — cannot respond) | No | **No** | OS suspends JS execution |
| `terminated` | **No** (container-internal) | No | No | Container terminates the creative |

**Creative-queryable states:** `ready`, `active`, `passive`, `hidden`, `frozen`

**Container-internal only (never sent to creative):** `loading`, `terminated`

### 4.2 State Definitions

**`loading`** _(container-internal)_
> The container has created the WebView and is loading creative markup. The SHARC handshake has not yet been established. Not sent to the creative — by definition, the channel does not exist yet.

**`ready`**
> `Container:init` has been sent and resolved. The creative is initialized and awaiting `Container:startCreative`. The creative is not yet displayed.

**`active`**
> The container is visible and the hosting application is in the foreground with user focus. The creative should be running normally.
>
> _Page Lifecycle mapping:_ `active` state. iOS: `applicationDidBecomeActive` + WKWebView visible. Android: `Activity.onResume()` + `WebView.onResume()`.

**`passive`**
> The container is visible but has lost input focus. Common in: split-screen multitasking (iOS/Android), phone call interruption (iOS), dialog overlays.
>
> _Page Lifecycle mapping:_ `passive` state. iOS: `UIApplicationState.inactive` (transitional). Android: `Activity.onPause()` in multi-window.

**`hidden`**
> The container is not visible. The app is in the background, the device screen is off, or the browser tab is hidden. JavaScript continues to run and should release non-essential resources.
>
> _Page Lifecycle mapping:_ `hidden` state. iOS: `applicationDidEnterBackground`. Android: `Activity.onStop()`.

**`frozen`**
> The browser or OS has suspended JavaScript execution. On iOS this corresponds to WKWebView process suspension. On Android this corresponds to `WebView.pauseTimers()`. The distinction between `frozen` (suspended) and `discarded` (killed) is invisible to the creative — both collapse to `frozen` in v1.
>
> _Page Lifecycle mapping:_ `frozen` (and implicitly `discarded`). `discarded` is collapsed into `frozen` in v1 and deferred to a v2 extension.

**`terminated`** _(container-internal)_
> The container has terminated and the WebView has been removed. No further communication is possible. Not sent to the creative — the channel no longer exists.

### 4.3 The `closing` State — Dropped from v1

`closing` is **not a state** in SHARC v1. The close sequence is handled entirely by the `Container:close` message flow:

1. Container sends `Container:close`
2. Creative responds with `resolve` (acknowledging close)
3. Container may allow up to 2 seconds for creative to run its close sequence
4. Container terminates the creative

A dedicated `closing` state would be redundant with this message flow and would create confusion about when `stateChange` fires vs. when `Container:close` fires. The message-based approach is cleaner and sufficient.

`closing` is identified as an **extension candidate** for v2 if explicit close-sequence state management proves necessary in practice.

### 4.4 State Transitions

| From | To | Trigger |
|---|---|---|
| `loading` | `ready` | `Container:init` accepted |
| `loading` | `terminated` | `createSession` timeout; fatal error |
| `ready` | `active` | `Container:startCreative` accepted |
| `ready` | `terminated` | `startCreative` rejected or timeout |
| `active` | `passive` | Platform loses focus |
| `active` | `hidden` | App backgrounded; tab hidden directly (no intermediate visible-unfocused phase exposed) |
| `active` | `terminated` | Close sequence completes |
| `passive` | `active` | Platform regains focus |
| `passive` | `hidden` | App backgrounded; tab hidden |
| `passive` | `terminated` | Close sequence completes |
| `hidden` | `passive` | App returns to foreground |
| `hidden` | `frozen` | OS suspends JS |
| `hidden` | `terminated` | Close initiated while hidden; OS kill |
| `frozen` | `active` | OS resumes → focus |
| `frozen` | `passive` | OS resumes → visible, no focus |
| `frozen` | `hidden` | OS resumes → still hidden |
| `frozen` | `terminated` | OS kills process while frozen |

### 4.5 Platform Event Mapping

#### Web (iframe in browser)

| SHARC State | DOM Events / APIs |
|---|---|
| `loading` | iframe created, script loading |
| `ready` | `Container:init` resolved |
| `active` | `document.visibilityState === 'visible'` + `document.hasFocus() === true` |
| `passive` | `document.visibilityState === 'visible'` + `document.hasFocus() === false` |
| `hidden` | `document.visibilityState === 'hidden'` |
| `frozen` | `document.freeze` event |
| `terminated` | iframe removed from DOM |

#### iOS WKWebView

| SHARC State | iOS APIs |
|---|---|
| `loading` | WKWebView init + `loadHTMLString` / `loadRequest` |
| `ready` | `Container:init` resolved |
| `active` | `applicationDidBecomeActive` + WKWebView visible |
| `passive` | `applicationWillResignActive` (phone call, split-screen) |
| `hidden` | `applicationDidEnterBackground` |
| `frozen` | WKWebView process suspension (inferred; no direct callback) |
| `terminated` | `applicationWillTerminate`; `webViewWebContentProcessDidTerminate` |

#### Android WebView

| SHARC State | Android APIs |
|---|---|
| `loading` | WebView created + `loadUrl` / `loadData` |
| `ready` | `Container:init` resolved |
| `active` | `Activity.onResume()` + `WebView.onResume()` |
| `passive` | `Activity.onPause()` in multi-window (partially visible) |
| `hidden` | `Activity.onStop()` |
| `frozen` | `WebView.pauseTimers()` (called in `Activity.onStop()`) |
| `terminated` | `Activity.onDestroy()` or app process killed |

---

## 5. Origin Validation and Security

### 5.1 sessionId-Based Session Filtering

SHARC uses the same sessionId-based filtering pattern as SIMID. The session ID is generated by the creative at `createSession` time and embedded in every message. The container validates:

1. The `sessionId` matches the active session
2. The `messageId` is monotonically increasing (per sender)

**The bootstrap `postMessage` uses `targetOrigin: '*'`** — this is **intentional** and documented explicitly in the spec. The reasoning:

- The bootstrap message carries only a `MessagePort` — no sensitive data
- All subsequent SHARC communication flows through the private `MessageChannel`, which has no broadcast risk
- The ad creative is served from an ad network domain, often unknown to the publisher at page-render time; restricting targetOrigin would prevent legitimate ad delivery
- This is identical to how SIMID handles the same bootstrapping problem

Publishers wanting maximum isolation may use COOP/COEP headers (see §3.4), which provide OS-level process separation independent of targetOrigin.

### 5.2 MessageChannel Security Properties

The `MessageChannel` transport provides meaningful security improvements over raw `postMessage`:
- Messages are private between the two endpoints — not broadcast to all frames
- The creative cannot receive messages intended for other ads on the page
- Third-party scripts in the publisher page cannot intercept SHARC messages
- The port is not accessible from any other JavaScript context

### 5.3 Container Security Model

- The container controls all privileged operations (navigation, resize, close, tracker firing)
- The creative can only **request** actions; the container decides whether to honor them
- The container validates all request parameters before acting
- The creative runs in a sandboxed iframe with a minimal `allow` attribute set

---

## 6. Reference Implementation Architecture

### 6.1 Design Goals

The reference implementation must:

1. Be the normative example of a spec-conformant SHARC container and creative API
2. Work as-is in web environments; be structurally adaptable to native environments
3. Be minimal — zero runtime dependencies for the core library
4. Ship with a test harness that exercises the full protocol lifecycle
5. Serve as the basis for the MRAID and SafeFrame compatibility bridges

### 6.2 Repository Structure

```
sharc-reference-implementation/
├── docs/
│   ├── architecture-design.md          ← this document
│   ├── state-machine-analysis.md       ← state machine research (incorporated)
│   └── product-scope.md
├── examples/
│   ├── sharc-protocol.js               ← core protocol (MessageChannel, message bus)
│   ├── sharc-container.js              ← container library
│   ├── sharc-creative.js               ← SHARC Creative API
│   ├── sharc-mraid-bridge.js           ← MRAID compatibility bridge
│   ├── sharc-safeframe-bridge.js       ← SafeFrame compatibility bridge
│   ├── sharc-omid-bridge.js            ← OMID compatibility bridge
│   └── test/
│       ├── index.html                  ← test harness / demo page
│       └── test-creative.html          ← test creative loaded in iframe
└── dist/                               ← built IIFE (.js) and ESM (.mjs) bundles
```

### 6.3 Module Dependency Graph

```
sharc-protocol.js (no dependencies)
       ↑                    ↑
sharc-container.js    sharc-creative.js
       ↑                    ↑
  (integrating app)   (ad creative)
```

### 6.4 Core Abstractions

**`SHARCProtocolBase`** — Base class providing the message bus: session management, message ID sequencing, resolve/reject correlation, event listener registration. No DOM dependencies.

**`SHARCContainerProtocol extends SHARCProtocolBase`** — Container-side protocol implementation. Owns the `MessageChannel` port1. Sends container messages. Handles session initiation.

**`SHARCCreativeProtocol extends SHARCProtocolBase`** — Creative-side protocol implementation. Receives and holds port2. Sends creative messages. Handles the bootstrap handshake.

---

## 7. Container Library Design

### 7.1 Responsibilities

The container library is responsible for:
- Creating and managing the secure rendering context (iframe)
- Running the container side of the SHARC protocol lifecycle
- Enforcing the state machine
- Owning close, navigation, and placement change operations
- Advertising supported extensions at init time
- Firing interaction trackers on behalf of the creative
- Managing the `MessageChannel` handshake

The container library does **not**:
- Perform ad selection or decisioning
- Handle measurement (delegated to OM extension)
- Parse VAST, VMAP, or ad markup

### 7.2 Container Initialization Sequence

```
Container                                         Creative
   |                                                  |
   |  [creates MessageChannel: port1, port2]           |
   |  [creates iframe with creative URL]               |
   |  [sends port2 via one-time postMessage]  ────▶    |
   |  [stores port1 for all future comms]              |  [receives port2, stores it]
   |                                                  |
   |◀── createSession {sessionId} ──────────────────── |
   |── resolve (createSession) ──────────────────────▶ |
   |── Container:init {environmentData, features} ───▶ |
   |◀── resolve (Container:init) ────────────────────  |
   |── Container:startCreative ──────────────────────▶ |
   |◀── resolve (Container:startCreative) ────────────  |
   |── [makes container visible] ─────────────────     |
   |── Container:stateChange {active} ──────────────▶  |
```

### 7.3 Timeout Policy

| Event | Default Timeout | On Expiry |
|---|---|---|
| `createSession` | 5 seconds | Terminate container, report error 2212 |
| `Container:init` resolve | 2 seconds | Terminate container, report error 2208 |
| `Container:startCreative` resolve | 2 seconds | Terminate container, report error 2213 |
| Close sequence | 2 seconds | Force terminate |

Applications serving live/SSAI content may set `createSession` timeout to 0.

### 7.4 Navigation Handling

`SHARC:Creative:requestNavigation` carries:

```javascript
{
  url: string,           // required — the clickthrough or deep link URL
  target: string,        // 'clickthrough' | 'deeplink' | 'store' | 'custom'
  customScheme: string,  // only when target === 'custom'
}
```

The container's response depends on `containerNavigation` as advertised in `Container:init`. If `navigationPossible` is false, the creative may attempt navigation itself but MUST still send the request first so the container can log it.

### 7.5 Placement Change Design

`requestPlacementChange` carries semantic intent:

```javascript
{
  intent: string,           // 'resize' | 'expand' | 'collapse' | 'fullscreen'
  targetDimensions: object, // required only when intent === 'resize'
  anchorPoint: string,      // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}
```

This preserves the MRAID distinction between "expand to max" and "resize to specific dimensions" without MRAID's confusing two-function model.

### 7.6 Tracker Firing (`reportInteraction`)

When receiving `Creative:reportInteraction`, the container MUST:
1. Fire all `trackingUris` in parallel (not serial)
2. Use HTTP GET (follow redirects, up to 5 hops)
3. Apply 5-second timeout per tracker
4. Not retry on failure
5. Resolve the message when all trackers have completed or timed out
6. Include per-tracker results in the resolve value

---

## 8. Creative API Design

### 8.1 Philosophy

The SHARC Creative API must have a negligible footprint — creatives are loaded from ad servers where every kilobyte costs money. It is a single small script with no framework dependencies.

The SHARC Creative API provides a clean Promise-based interface that hides the protocol details. Creative developers should not need to know about `sessionId` or `messageId`.

### 8.2 Creative API Surface

```javascript
// Initialization — called automatically when script loads
SHARC.onReady(callback: (env, features) => Promise<void>)
SHARC.onStart(callback: () => Promise<void>)

// State queries
SHARC.getContainerState() → Promise<string>
SHARC.getPlacementOptions() → Promise<Placement>

// Actions
SHARC.requestPlacementChange(args) → Promise<Placement>
SHARC.requestNavigation(args) → Promise<void>
SHARC.requestClose() → Promise<void>
SHARC.reportInteraction(trackingUris: string[]) → Promise<results[]>

// Extensions
SHARC.getFeatures() → Promise<Feature[]>
SHARC.hasFeature(name: string) → boolean   // synchronous, uses cached init data
SHARC.requestFeature(name: string, args: object) → Promise<object>

// Events from container
SHARC.on('stateChange', callback: (state) => void)
SHARC.on('placementChange', callback: (placement) => void)
SHARC.on('close', callback: () => void)
SHARC.on('log', callback: (message) => void)

// Error reporting
SHARC.fatalError(code: number, message?: string) → void

// Logging
SHARC.log(message: string) → void
```

### 8.3 Creative Initialization Flow

The library handles the protocol handshake automatically:

```javascript
// Minimal creative
SHARC.onReady(async (env, features) => {
  // Configure based on env.isMuted, env.volume, etc.
  // Check features via SHARC.hasFeature('com.iabtechlab.sharc.audio')
  // Load and prepare assets
  // Return resolved Promise when ready to display
});

SHARC.onStart(async () => {
  // Make the creative visible and begin the experience
});

SHARC.on('close', () => {
  // Optional: run close animation (SHARC API enforces 1.8s watchdog)
});
```

Library internal flow:
1. Listens on `window` for the bootstrap `postMessage` carrying `port2`
2. Stores `port2`, calls `createSession`
3. Waits for `Container:init`, calls `onReady` callback, resolves init when callback resolves
4. Waits for `Container:startCreative`, calls `onStart` callback, resolves startCreative
5. Handles `Container:close` with close handler + 1.8-second watchdog

### 8.4 Feature Detection

```javascript
SHARC.onReady(async (env, features) => {
  if (SHARC.hasFeature('com.iabtechlab.sharc.audio')) {
    // configure audio controls
  }
});
```

`hasFeature()` is synchronous because features are known at `onReady` time.

---

## 9. Extension Framework

### 9.1 Namespaces

- **SHARC-owned:** `com.iabtechlab.sharc.[featureName]`
- **Third-party:** `com.[domain].sharc.[featureName]`

### 9.2 Discovery

Extensions are advertised in `Container:init` via `supportedFeatures`. The creative can query them via `Creative:getFeatures` and check synchronously via `SHARC.hasFeature()`.

### 9.3 Extension Invocation

```javascript
// Creative side
const result = await SHARC.requestFeature('com.iabtechlab.sharc.location', {});

// Generates → SHARC:Creative:requestLocation (container handles, resolves/rejects)
```

Containers that don't support a requested feature respond with `reject` (error code 2203).

### 9.4 v1 Deferred as Extension Candidates

| Feature | Reason Deferred |
|---|---|
| `closing` state | Handled by `Container:close` message flow; explicit state not needed in v1 |
| `discarded` state | Indistinguishable from `frozen` from creative's perspective |
| Picture-in-Picture | VAST/SIMID concern; not a display ad use case in v1 |
| Viewability state | Delegated to Open Measurement SDK extension |
| Prerender | Not an ad use case in v1 |

---

## 10. Open Measurement Integration

SHARC supports Open Measurement via the extension framework. The container implementation supplies the functionality; the creative accesses it via `SHARC.requestFeature('com.iabtechlab.sharc.openMeasurement', ...)`.

Detailed OM integration guidance will be published separately in coordination with the OM working group.

---

## 11. MRAID Compatibility Bridge Scope

### 11.1 Purpose

Allow existing MRAID 2.x / 3.0 creatives to run in a SHARC container without modification. Migration shim only — not a permanent integration path.

### 11.2 MRAID → SHARC Translation

| MRAID Function | SHARC Equivalent |
|---|---|
| `mraid.getState()` | `Container:stateChange` events |
| `mraid.expand([url])` | `requestPlacementChange({intent:'expand'})` |
| `mraid.resize()` | `requestPlacementChange({intent:'resize',...})` |
| `mraid.close()` | `requestClose()` |
| `mraid.open(url)` | `requestNavigation({url, target:'clickthrough'})` |
| `mraid.isViewable()` | Derived from container state (`active` → true) |
| `mraid.addEventListener` | `SHARC.on(...)` (with event name mapping) |
| `mraid.supports(feature)` | `SHARC.hasFeature(...)` |

**Not supported:** `mraid.storePicture()`, `mraid.createCalendarEvent()` — these MRAID 2.x features are intentionally dropped.

### 11.3 MRAID State Mapping

| MRAID State | SHARC State |
|---|---|
| `loading` | `loading` |
| `default` | `ready`, `active`, `passive`, `hidden` |
| `expanded` | `active` + placement change resolved |
| `resized` | `active` + placement change resolved |
| `hidden` | `hidden`, `frozen` |

---

## 12. SafeFrame Compatibility Bridge Scope

### 12.1 Purpose

Allow SafeFrame creatives (those using `$sf.ext.*` APIs) to run in a SHARC container. Migration shim only.

### 12.2 Key Design Challenge

SafeFrame uses synchronous function calls on a shared global `$sf.ext` object injected by the host. Translating to SHARC's async message-passing model requires synthetic stub injection.

### 12.3 SafeFrame → SHARC Translation

| SafeFrame API | SHARC Equivalent |
|---|---|
| `$sf.ext.expand(dims, push)` | `requestPlacementChange({intent:'resize',...})` |
| `$sf.ext.collapse()` | `requestPlacementChange({intent:'collapse'})` |
| `$sf.ext.geom()` | `getPlacementOptions()` |
| `$sf.ext.meta(key)` | AdCOM data from init |
| `$sf.ext.register(...)` | `SHARC.onReady(...)` |
| `$sf.host.render(...)` | Container creates SHARC context |

---

## 13. Gaps, Risks, and Recommendations

### 13.1 Spec Gaps (Still Open)

These gaps from the original spec analysis remain open. The reference implementation will document them as spec issues for the working group:

| Gap | Description | Recommendation |
|---|---|---|
| `requestNavigation` args | Spec defines no `MessageArgs` for this message | Define `{url, target, customScheme}` dict — see §7.4 |
| `reportInteraction` macro expansion | Macro registry referenced but not defined | Publish macro registry in `conformance-requirements.md` |
| Non-SHARC creative detection | How to distinguish non-SHARC from broken SHARC? | Define `SHARC-Enabled` hint (meta tag or script attribute) |
| Extension versioning semantics | `Feature.version` exists but no mismatch semantics | Define semver negotiation in extension authoring guide |

### 13.2 Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `MessageChannel` unavailable | Low — effectively zero real cases | Fallback to `postMessage` + sessionId filtering implemented |
| `*` targetOrigin on bootstrap | Medium — documented intentional design | MessageChannel private port eliminates post-handshake risk; COOP/COEP for publishers who want more |
| Non-SHARC creatives failing silently | High for adoption | Prioritize non-SHARC detection in conformance suite |
| iOS WKWebView process kill mid-session | Medium | `webViewWebContentProcessDidTerminate` handler → graceful `terminated` |
| Creative JS error before `createSession` | Medium | `createSession` timeout (5s default) cleans up |

### 13.3 Conformance Testing

A conformance test suite is planned (not yet implemented) in `conformance/`. Tests will cover:

- **Container suite:** Tests a container implementation must pass
- **Creative suite:** Tests a creative implementation must pass  
- **Protocol tests:** Full message lifecycle, error paths, timeout behavior, state machine transitions
- **Transport tests:** MessageChannel handshake, fallback behavior

---

## 14. Renderer Protocol — Creative Markup Variant

**Added in 0.7.0.** The renderer protocol is the second creative-payload path SHARC supports alongside Creative URL. The two variants share everything from Section 4 onward (state machine, MessageChannel transport, security model, extension framework); they differ only in *how the creative document gets into the iframe*.

The full design rationale, threat model, decision log, and operator deployment guidance live in [`docs/proposals/creative-sources.md`](proposals/creative-sources.md). The wire-level reference (envelope shapes, validation rules, error codes) lives in [api-reference.md §10](./api-reference.md#10-renderer-protocol). This section is the architectural anchor — what changes structurally when a publisher operates in Markup mode, and why.

### 14.1 Creative URL vs. Creative Markup — operator chooses

A publisher selects the variant at construction by passing exactly one of two argument shapes to `new SHARCContainer({...})`:

| Variant | Constructor inputs | Iframe `src` | Payload route |
|---|---|---|---|
| **Creative URL** | `creativeUrl` | `src = creativeUrl` (creative server's origin) | Browser fetches the creative document directly |
| **Creative Markup** | `creativeHtml` + `creativeRendererUrl` | `src = creativeRendererUrl` (operator-hosted renderer page) | Container posts `creativeHtml` to the renderer over the renderer protocol; renderer writes it into its own document |

Validation rule 1 enforces XOR — passing both, or neither, throws synchronously at construction.

**Why Creative Markup exists.** When operators have markup in hand (RTB pipelines, header bidding wrappers, Prebid Universal Creative scenarios) and would otherwise fall back to a bare `srcdoc` iframe, they hit a silent break: `srcdoc` collapses the creative origin to `null`, breaking measurement SDKs (OMID, IAS, DV), `localStorage`, credentialed `fetch`, and CORS. The renderer protocol gives the creative a real cross-origin origin (the renderer's) without forcing operators to pre-host every markup blob as a URL.

The cost is one extra hop — the renderer protocol — between iframe load and the standard SHARC handshake. That hop is what the rest of this section documents.

### 14.2 Construction-time validation (rules 4–8)

Eight validation rules run synchronously in `SHARCContainer`'s constructor. Rules 1–3 cover argument shape (Creative URL vs. Markup XOR); rules 4–8 are Markup-specific value checks:

| Rule | What it enforces | Throw type |
|---|---|---|
| 4 | `creativeRendererUrl` parses via `new URL(...)` | `Error` |
| 5 | `creativeRendererUrl` uses exactly the `https:` scheme — no `http:`, `javascript:`, `data:`, `blob:`, `file:`, `about:`, etc. | `Error` |
| 6 | `creativeRendererUrl` contains no userinfo (`username` / `password`) | `Error` |
| 7 | `creativeRendererUrl` is cross-origin to `window.location` and (when accessible) `window.top.location` | `Error` |
| 8 | `creativeHtml` is ≤ 256 KiB measured in UTF-8 bytes (pre-injection) | `Error` |

Rules 4–7 together are what makes the renderer iframe's `allow-same-origin` sandbox token *safe* — they eliminate every URL shape that would cause the browser to collapse the renderer iframe's origin onto the publisher's. The full mechanism table (which schemes inherit which origins) is in the proposal § Iframe sandbox; the short version is that without rules 4–7, `allow-same-origin` would be a sandbox escape.

When validation rule 7's cross-origin check fails *because* `window.top.location` access threw (i.e. SHARC is loaded inside a header-bidding wrapper that's cross-origin to the publisher top), the wrapper context inherits the cross-origin guarantee and `window.location` comparison alone is sufficient to pass. The container additionally fires a `wrapper_top_frame_inaccessible` security event so operators can see the carve-out applied. Constructor option `wrapperPolicy: 'warn' | 'block'` (default `'warn'`) controls whether this carve-out emits a warning and proceeds, or throws synchronously at construction.

### 14.3 Renderer iframe — the actual loaded artifact

For Markup, the iframe `src` is `creativeRendererUrl` plus a CSPRNG fragment nonce: `<creativeRendererUrl>#sharcNonce=<crypto.randomUUID()>`. Fragments are not sent to servers and are opaque to other origins, so the nonce establishes a shared secret between the constructing container and the renderer page running in `creativeRendererUrl`'s origin.

Sandbox tokens on the renderer iframe (Markup variant defaults):

```
allow-scripts
allow-same-origin
allow-forms
allow-popups
allow-popups-to-escape-sandbox
allow-top-navigation-by-user-activation
allow-storage-access-by-user-activation
```

`allow-modals` and `allow-downloads` are configurable but **default off** — see proposal DD-23 and DD-25 for the asymmetric default rationale.

Five constructor options expose per-token control: `allowPopups`, `allowTopNavigationByUserActivation`, `allowStorageAccessByUserActivation`, `allowModals`, `allowDownloads`. Operators harden the sandbox by passing `false` to any of them. The unsafe `allow-top-navigation` token (no-gesture variant) is **never** present — only the user-activation variant is exposed.

Defense-in-depth attributes also set on the renderer iframe element:

- `csp` attribute: `object-src 'none'; base-uri 'none'` (Chromium-only — this is the local enforcement layer; the operator's HTTP-response CSP on the renderer page is the portable layer)
- `referrerpolicy = "no-referrer"` (the renderer URL is opaque to the creative; nothing useful to leak)
- A long Permissions-Policy denylist (camera, microphone, geolocation, etc. — see `RENDERER_PERMISSIONS_POLICY` in `src/sharc-container.js` for the full list)

For **Creative URL**, the iframe sandbox does NOT include `allow-same-origin` — the creative URL's own origin is the trust boundary, and the publisher page does not need to reach into the iframe's same-origin context.

### 14.4 Renderer protocol — handshake, render, reply

Three message types flow over `window.postMessage` between the renderer iframe and `window.parent`:

```
Container (publisher page)                        Renderer (operator-hosted iframe)
   |                                                       |
   |  [validates creativeRendererUrl — rules 4–8]          |
   |  [generates sharcNonce; assembles src + fragment]      |
   |  [creates iframe with sandbox + csp + referrerpolicy]  |
   |  [iframe.src = creativeRendererUrl + #sharcNonce=...]  |
   |                                                       |
   |  ───────── iframe load event ──────────────────────►  |
   |  (5s timeout — RENDERER_TIMEOUT 2114 if not fired)     |
   |                                                       |
   |  [runs extension injection on creativeHtml]            |
   |                                                       |
   |── postMessage(SHARC:Renderer:render, rendererOrigin) ─►|
   |     { creativeHtml, placementSessionId, sharcNonce,   |
   |       sharcVersion, rendererProtocolVersion,          |
   |       containerOrigin }                                |
   |                                                       |  [reads sharcNonce from location.hash]
   |                                                       |  [validates: event.source === window.parent]
   |                                                       |  [validates: event.origin === containerOrigin]
   |                                                       |  [validates: event.data.sharcNonce === fragment nonce]
   |                                                       |  [validates: rendererProtocolVersion is supported]
   |                                                       |  [clears location.hash via history.replaceState]
   |                                                       |  [strips meta http-equiv="refresh" from creativeHtml]
   |                                                       |  [installs sharc-navigation-bridge on window]
   |                                                       |  [document.open() / document.write(html) / document.close()]
   |                                                       |  [waits for DOMContentLoaded on inner document]
   |  ◄────── postMessage(SHARC:Renderer:rendered, ───────  |
   |          containerOrigin)                              |
   |          { placementSessionId, rendererOrigin }        |
   |  (2s timeout — RENDERER_TIMEOUT 2114 if not received)  |
   |                                                       |
   |  [envelope check: source === iframe.contentWindow]     |
   |  [envelope check: origin === expected rendererOrigin]  |
   |  [envelope check: placementSessionId matches]          |
   |  [payload check: rendererOrigin string non-empty]      |
   |  [origin echo: data.rendererOrigin === expected]       |
   |                                                       |
   |  [proceeds with standard SHARC bootstrap (Section 3.2)]|
   |  [creative SDK inside renderer doc receives port2]     |
```

**Failure modes** the container surfaces over `onSecurityEvent` and terminates on:

| Error code | Cause | `onSecurityEvent.type` |
|---|---|---|
| `2114` `RENDERER_TIMEOUT` | iframe `load` did not fire within 5s, or `:rendered`/`:failed` did not arrive within 2s | `renderer_protocol_error` (`details.subtype: 'timeout'`) |
| `2115` `RENDERER_FAILED` | Renderer sent `SHARC:Renderer:failed` with a `reason` | `renderer_failed` |
| `2116` `RENDERER_ORIGIN_MISMATCH` | `:rendered` payload's `rendererOrigin` does not equal the construction-time `creativeRendererUrl` origin (defeats 30x-redirect attack) | `renderer_origin_mismatch` |
| `2117` `RENDERER_PROTOCOL_ERROR` | Envelope-valid `:rendered` or `:failed` with malformed payload (missing `rendererOrigin` / `reason`, wrong type) | `renderer_protocol_error` (`details.subtype: 'malformed_payload'`) |
| `2118` `RENDERER_UNAUTHORIZED_NAVIGATION` | Iframe `load` fired beyond the expected sequence (see § 14.7) | `unauthorized_navigation` |
| `2119` `RENDERER_POST_FAILED` | Synchronous throw from `iframe.contentWindow.postMessage(...)` (`DataCloneError`, null `contentWindow`, etc.) | `renderer_protocol_error` (`details.subtype: 'post_failed'`) |

The wire-level message envelopes, validation rule order, and `details` payload schemas are in [api-reference.md §10](./api-reference.md#10-renderer-protocol).

### 14.5 Renderer responsibilities

The renderer page (operator-hosted; canonical fork starting point at `examples/renderer/index.html`) is responsible for the following protocol-level contract:

1. **Read the nonce from `location.hash`** at startup using `URLSearchParams(location.hash.slice(1)).get('sharcNonce')`.
2. **Listen for `SHARC:Renderer:render` on `window`** and validate the envelope: `event.source === window.parent`, `event.origin === event.data.containerOrigin`, `event.data.sharcNonce === <hash nonce>`, and `event.data.rendererProtocolVersion` is supported. Reply `:failed` with the appropriate `reason` on any validation miss.
3. **Detect Service Workers at startup** via `navigator.serviceWorker.controller` and `navigator.serviceWorker.getRegistrations()`. A Service Worker on the renderer origin can intercept iframe loads and substitute the renderer HTML transparently — defeating the fragment-nonce defense entirely. If one is detected, reply `:failed` with `reason: 'service_worker_detected'` and refuse to render. Operators MUST NOT register Service Workers on the renderer origin.
4. **Strip `<meta http-equiv="refresh">`** from `creativeHtml` before `document.write` (renderer-side; the SDK in Creative URL relies on the load-event backstop instead).
5. **Clear `location.hash`** via `history.replaceState(null, '', location.pathname + location.search)` after envelope validation passes and before `document.write` runs. The nonce is single-use per iframe load — defense-in-depth keeps the consumed nonce out of the creative HTML's reach.
6. **Install `sharc-navigation-bridge`** before `document.write(creativeHtml)` so its capture-phase interceptors apply to all creative code.
7. **Load compatibility bridge modules** from `event.data.bridges` (0.7.1+) before `document.write(creativeHtml)`. Filter against a renderer-controlled allowlist (`KNOWN_BRIDGES = ['mraid', 'safeframe']` in 0.7.1; unknown identifiers silently skipped via `customSecurityLog`), resolve each via `RENDERER_CONFIG.BRIDGE_URL_TEMPLATE` (default `'../../dist/sharc-{name}-bridge.mjs'`), assert the resolved URL is same-origin with the renderer (load-bearing security defense), set the bridge's `__sharc{Name}BridgeAutoInstall` flag, and dynamic-import the module. On any import rejection (404, MIME mismatch, network, evaluation throw, same-origin assertion fail), reply `:failed` with `reason: 'bridge_load_failed'` and a `bridge` field carrying the identifier. See § 14.11 for the full bridge-loading design.
8. **`document.open() / document.write(creativeHtml) / document.close()`** to install the creative HTML. Replaces the renderer document while keeping `iframe.contentWindow` intact, so the subsequent SHARC port handshake reaches the creative SDK running in the renderer's window. Fall back to `DOMParser` + `replaceChildren` (with script-recreation pass) when `document.write` fails or is restricted.
9. **Reply `SHARC:Renderer:rendered`** to `window.parent` after `DOMContentLoaded` fires on the inner document, including the renderer's actual `window.location.origin` as the `rendererOrigin` field for redirect detection.

The reference renderer also exposes:

- `RENDERER_CONFIG.TEST_ONLY` — operator-tunable flag. The hosted reference deployment ships with `TEST_ONLY: true`, which causes the renderer to display a dev banner when `window.parent === window` (loaded directly, not as an iframe). Operator forks set `TEST_ONLY: false` and remove the dev banner.
- `RENDERER_CONFIG.ALLOWED_PROTOCOL_VERSIONS` — a list (not a single value) so forks can widen the accept-list during a renderer-first deployment cutover (zero-downtime upgrade pattern).
- Four `window.__sharcRenderer` lifecycle hooks: `onBeforeRender`, `onAfterRender`, `customSecurityLog`, `beforeStorageClear`. Operators override to inject custom behavior. All hooks MUST be synchronous — async hooks would race the container's 2s `:rendered` reply timeout.

### 14.6 Container responsibilities

On the publisher side, `SHARCContainer` is responsible for:

- **Validation rules 1–8** at construction (§ 14.2)
- **`KNOWN_TEST_RENDERERS` production-block guard** — frozen list of canonical SHARC reference renderer URLs (currently the SDK-reference deployment at `https://jeffreycarlson.github.io/SHARC/renderer/`; future upstream URL added when SHARC is contributed to IABTechLab). The guard fires when `creativeRendererUrl` matches a known test renderer AND the page origin does NOT match a recognized dev origin. Recognized dev-origin patterns (anchored regexes; suffix-style spoofing such as `notlocalhost.example` does NOT match):
  - `^https?://localhost(:\d+)?$`
  - `^https?://127\.0\.0\.1(:\d+)?$`
  - `^https?://[a-z0-9-]+\.localhost(:\d+)?$`
  - `^https?://[a-z0-9-]+\.test(:\d+)?$`
  - `^https?://[a-z0-9-]+\.local(:\d+)?$`
  - `^https?://\[::1\](:\d+)?$`
  - `^https?://0\.0\.0\.0(:\d+)?$`
  When tripped, the constructor throws synchronously with a message naming the rejected URL and listing the dev-origin allowlist. Production deployments must fork the renderer to operator-controlled infrastructure.
- **Iframe creation** with the sandbox / `csp` / `referrerpolicy` / Permissions-Policy attributes from § 14.3
- **Renderer protocol exchange** from § 14.4 — `:render` post, envelope + payload validation on `:rendered` / `:failed`, origin-echo redirect detection
- **Bridge detection** (0.7.1+, § 14.11) — resolves `container.bridges` at construction via the three-layer pipeline (explicit `bridges` option → `creativeMeta.apis` AdCOM codes → adm content scan). Result is placed on the `bridges` field of the outgoing `:render` message.
- **Standard SHARC handshake** post-`:rendered` (Section 3) — same as Creative URL once the renderer protocol completes
- **Load-event navigation backstop** (§ 14.7)
- **`close()` mid-render cleanup** — cancel reply timeouts, detach renderer message listener, remove iframe, restore placement element to its pre-`load()` state. Late `:rendered` / `:failed` arriving after close are silently ignored.

### 14.7 Load-event navigation backstop (`RENDERER_UNAUTHORIZED_NAVIGATION` 2118)

A defense-in-depth backstop that catches creative-initiated navigation that bypassed the in-renderer navigation bridge (adversarial JS-level overrides, anchor target overrides, meta refresh re-injection after parse). Browser-observable, JS-bypass-resistant.

The container attaches a `load` listener at a variant-specific render anchor and terminates with `RENDERER_UNAUTHORIZED_NAVIGATION (2118)` on any subsequent `load` event:

- **Creative Markup** (`details.variant === 'markup'`): the render anchor is the renderer's envelope-validated `:rendered` accept. Two iframe `load` events are expected total — one for the renderer page, one for the creative document after `document.write`. Any `load` after the second fires 2118.
- **Creative URL** (`details.variant === 'url'`): the render anchor is the first iframe `load` event itself. The second `load` and any after fire 2118.

`details.msSinceRender` carries the wall-clock delay from the variant's render anchor to the firing `load`. Both variants share the structured event type, code, and message — operators monitor 2118 once and branch on `details.variant` only when they need variant-specific triage.

### 14.8 State machine impact — none

Creative Markup introduces no new states. The renderer protocol is a sub-phase of `loading`, before MessageChannel handshake. The `loading → ready` transition still corresponds to `Container:init` resolving over MessageChannel, exactly as in Creative URL. From the state machine's perspective (Section 4), Creative Markup looks identical to a slow-to-load Creative URL. The set of *terminate-from-loading* edges grows by one (codes 2114 / 2115 / 2116 / 2117 / 2118 / 2119); the state graph itself is unchanged.

### 14.9 Performance envelope

Total worst-case wall clock for Creative Markup load: 5s (iframe load) + 2s (`:rendered` reply) + 200ms (bootstrap delay) + 5s (`createSession`) + 2s (`init`) = **~14.2s upper bound**. Happy path on warm caches is sub-second. Operators should expect Creative Markup to add ~100–500ms over Creative URL on warm caches; the 0.7.0 release readiness bar is +500ms P95 regression vs. Creative URL on a representative-sized payload (50 KiB markup).

### 14.10 Where to read more

| Topic | Document |
|---|---|
| Wire-level reference (envelope shapes, all validation rules, `onSecurityEvent` payload schemas) | [api-reference.md §10](./api-reference.md#10-renderer-protocol) |
| Threat model, decision log, deployment guidance, FAQ | [`docs/proposals/creative-sources.md`](proposals/creative-sources.md) |
| Operator-side renderer setup recipe and Creative Markup hello-world | [creative-cookbook.md](./creative-cookbook.md) |
| 0.7.0 onboarding and constructor-options summary | [getting-started.md](./getting-started.md) |
| Bridge loading design (0.7.1) | [`docs/design/0.7.1-bridges-field.md`](./design/0.7.1-bridges-field.md) |
| Reference renderer source | `examples/renderer/index.html` |
| Local Creative Markup demo | `examples/demos/creative-markup/index.html` |

### 14.11 Bridge loading (0.7.1, issue #82)

Container-driven compatibility bridge loading on the Creative Markup variant. The container detects which bridges (MRAID, SafeFrame) the creative needs and tells the renderer to load them via a new `bridges: string[]` field on `SHARC:Renderer:render`. The renderer dynamic-imports the bridge modules BEFORE `document.write(creativeHtml)` so the creative's first synchronous script finds `window.mraid` / `window.$sf` in place.

**Container-side detection** is a three-layer pipeline, most-specific wins:

1. **Layer 1 — explicit constructor `bridges` option.** Operator override. Array of reserved identifiers (`'mraid'`, `'safeframe'` in 0.7.1). Pass `[]` to explicitly suppress all bridge loading; `null` / omit to use auto-detection.
2. **Layer 2 — `creativeMeta.apis` AdCOM `APIFramework` integer codes.** OpenRTB 2.6's `bid.apis` references AdCOM enums directly. 0.7.1 mapping: `3` / `5` / `6` (MRAID 1.0 / 2.0 / 3.0) → `'mraid'`. Code `7` (OMID 1.0) is **intentionally excluded from the renderer bridge picker** — 0.7.3 cemented OMID as extension-owned (container-side `OmidCompatBridge`), not a renderer-loaded compatibility bridge. See [`docs/design/0.7.3-omid-wiring.md`](./design/0.7.3-omid-wiring.md) § 5. Vendor-specific codes (500+) ignored. Empty mapping falls through to layer 3.
3. **Layer 3 — adm content scan.** Last-resort heuristic on `creativeHtml`. Tightened substrings: `indexOf('mraid.js')` for MRAID, `indexOf('$sf.ext')` for SafeFrame. False positives (extra bridge loads) are tolerable; false negatives break the creative and require the operator to pass an explicit `bridges`.

Result is sorted, deduplicated, frozen, and exposed as `container.bridges` (diagnostic surface) and on the `bridges` field of the outgoing `:render` message.

**Renderer-side loading** filters the inbound `bridges` array against its own `KNOWN_BRIDGES` allowlist (truth source — `['mraid', 'safeframe']` in 0.7.1; unknown identifiers silently skipped for forward-compat), then for each allowed identifier resolves a URL via `RENDERER_CONFIG.BRIDGE_URL_TEMPLATE` (default `'../../dist/sharc-{name}-bridge.mjs'`), asserts same-origin with the renderer, sets the bridge's auto-install flag, and dynamic-imports the module. Each bridge module's auto-install path polls for `window.SHARC` to become available (it appears after `document.write` runs the inner SDK script) and then wires the bridge — same pattern as the existing `__sharcNavBridgeAutoInstall`.

**Security guardrails** (five, baked into the renderer per Security Engineer review):

1. **Allowlist enforcement is the ONLY path to `import()`.** Unknown identifiers cannot bypass the filter.
2. **Same-origin URL assertion** post-substitution. Cross-origin bridge URLs are rejected; the container does not supply URLs (security boundary).
3. **`Object.freeze(RENDERER_CONFIG)`** post-construction. Closes the post-load-mutation surface.
4. **CSP `script-src 'self'`** is recommended operator-fork guidance — browser-level belt for the JS-level same-origin defense.
5. **`bridge_load_failed`** is a distinct `onSecurityEvent` variant (error code `2115`, same as `renderer_failed`, but a separate `event.type` discriminator). Operators see bridge import failures separately from creative-side render failures.

**Forward compatibility.** An old container omitting the `bridges` field is treated identically to `bridges: []` by a new renderer. An old renderer receiving `bridges` from a new container silently ignores the unknown field (legacy load path predates the field). A new renderer receiving an identifier it doesn't know silently skips it via `customSecurityLog`. The protocol degrades gracefully across the version skew without protocol-version bumps. Per design doc § 13 Q4 lock, `'omid'` is NOT in 0.7.1's vocabulary — and 0.7.3 cemented OMID as extension-owned rather than bringing it into the renderer bridge vocabulary at all. The renderer bridge picker stays `['mraid', 'safeframe']` going forward.

---

## Appendix A: Message Structure Reference

All SHARC messages (sent via `MessageChannel`) use this structure:

```javascript
{  sessionId: string,    // unique session identifier (UUID)
  messageId: number,    // monotonically increasing per sender
  timestamp: number,    // Date.now() at send time
  type: string,         // 'SHARC:Container:init' | 'SHARC:Creative:createSession' | 'resolve' | 'reject' | etc.
  args: object          // message-specific payload (Structured Clone — no JSON.stringify needed)
}

// Resolve message
{
  sessionId: string,
  messageId: number,
  timestamp: number,
  type: 'resolve',
  args: {
    messageId: number,  // messageId of the message being resolved
    value: object       // resolution payload
  }
}

// Reject message
{
  sessionId: string,
  messageId: number,
  timestamp: number,
  type: 'reject',
  args: {
    messageId: number,  // messageId of the message being rejected
    value: {
      errorCode: number,
      message: string
    }
  }
}
```

## Appendix B: Error Codes Reference

| Code | Error | Notes |
|---|---|---|
| 2100 | Unspecified creative error | Catchall |
| 2101 | Resources could not be loaded | |
| 2102 | Container dimensions not suited to creative | |
| 2103 | Wrong SHARC version (creative) | |
| 2104 | Creative could not be executed | |
| 2105 | Resize request not honored | |
| 2108 | Ad internal error | |
| 2109 | Device not supported | |
| 2110 | Container not sending messages as specified | |
| 2111 | Container not responding adequately | |
| 2200 | Unspecified container error | Catchall |
| 2201 | Wrong SHARC version (container) | |
| 2203 | Creative requesting unsupported functionality | |
| 2204 | Creative executing unsupported actions | |
| 2205 | Creative overloading message channel | |
| 2208 | Creative taking too long to resolve/reject | |
| 2209 | Creative not supported on this device | |
| 2210 | Creative not following spec on init | |
| 2211 | Creative not following spec on messages | |
| 2212 | Creative did not send createSession | |
| 2213 | Creative did not reply to start message | |
