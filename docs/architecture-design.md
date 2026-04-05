# SHARC Reference Implementation: Architecture Design Document

**Version:** 0.2 (Final Design)  
**Author:** Architecture Review, SHARC Working Group  
**Status:** Final — Decisions Incorporated  
**Reviewer:** Jeffrey Carlson, Project Co-Chair  
**Last Updated:** 2026-04-03

---

## Table of Contents

1. [Core Design Principles](#1-core-design-principles)
2. [Platform Scope](#2-platform-scope)
3. [Transport Layer: MessageChannel](#3-transport-layer-messagechannel)
4. [State Machine: Page Lifecycle Aligned](#4-state-machine-page-lifecycle-aligned)
5. [Origin Validation and Security](#5-origin-validation-and-security)
6. [Reference Implementation Architecture](#6-reference-implementation-architecture)
7. [Container Library Design](#7-container-library-design)
8. [Creative SDK Design](#8-creative-sdk-design)
9. [Extension Framework](#9-extension-framework)
10. [Open Measurement Integration](#10-open-measurement-integration)
11. [MRAID Compatibility Bridge Scope](#11-mraid-compatibility-bridge-scope)
12. [SafeFrame Compatibility Bridge Scope](#12-safeframe-compatibility-bridge-scope)
13. [Gaps, Risks, and Recommendations](#13-gaps-risks-and-recommendations)

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
   |── postMessage({type:'SHARC:port', port: port2}, '*', [port2]) ──▶ |
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
```

| State | Creative-Queryable? | Visible? | JS Active? | Trigger |
|---|---|---|---|---|
| `loading` | **No** (container-internal) | No | Partial | Container creates WebView |
| `ready` | Yes | No | Yes | `Container:init` accepted |
| `active` | Yes | Yes | Yes | `Container:startCreative` + platform focus |
| `passive` | Yes | Yes | Yes | Platform loses focus (split-screen, call interruption) |
| `hidden` | Yes | No | Yes | App backgrounded, tab hidden, screen off |
| `frozen` | Yes (but JS is suspended — cannot respond) | No | **No** | OS suspends JS execution |
| `terminated` | **No** (container-internal) | No | No | Container unloads |

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
> The container has been destroyed and the WebView removed. No further communication is possible. Not sent to the creative — the channel no longer exists.

### 4.3 The `closing` State — Dropped from v1

`closing` is **not a state** in SHARC v1. The close sequence is handled entirely by the `Container:close` message flow:

1. Container sends `Container:close`
2. Creative responds with `resolve` (acknowledging close)
3. Container may allow up to 2 seconds for creative to run its close sequence
4. Container unloads

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

1. Be the normative example of a spec-conformant SHARC container and creative SDK
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
├── src/
│   ├── sharc-protocol.js               ← core protocol (MessageChannel, message bus)
│   ├── sharc-container.js              ← container library
│   ├── sharc-creative.js               ← creative SDK
│   └── test/
│       ├── index.html                  ← test harness / demo page
│       └── test-creative.html          ← test creative loaded in iframe
└── examples/
    ├── web-banner/
    └── web-interstitial/
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
| `createSession` | 5 seconds | Destroy container, report error 2212 |
| `Container:init` resolve | 2 seconds | Destroy container, report error 2208 |
| `Container:startCreative` resolve | 2 seconds | Destroy container, report error 2213 |
| Close sequence | 2 seconds | Force destroy |

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
  intent: string,           // 'resize' | 'maximize' | 'minimize' | 'restore' | 'fullscreen'
  targetDimensions: object, // required only when intent === 'resize'
  anchorPoint: string,      // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}
```

This preserves the MRAID distinction between "expand to fill" and "resize to specific dimensions" without MRAID's confusing two-function model.

### 7.6 Tracker Firing (`reportInteraction`)

When receiving `Creative:reportInteraction`, the container MUST:
1. Fire all `trackingUris` in parallel (not serial)
2. Use HTTP GET (follow redirects, up to 5 hops)
3. Apply 5-second timeout per tracker
4. Not retry on failure
5. Resolve the message when all trackers have completed or timed out
6. Include per-tracker results in the resolve value

---

## 8. Creative SDK Design

### 8.1 Philosophy

The creative SDK must have a negligible footprint — creatives are loaded from ad servers where every kilobyte costs money. The SDK is a single small script with no framework dependencies.

The SDK provides a clean Promise-based API that hides the protocol details. Creative developers should not need to know about `sessionId` or `messageId`.

### 8.2 Creative SDK API Surface

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

The SDK handles the protocol handshake automatically:

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
  // Optional: run close animation (SDK enforces 1.8s watchdog)
});
```

SDK internal flow:
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
| `mraid.expand([url])` | `requestPlacementChange({intent:'maximize'})` |
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
| `$sf.ext.collapse()` | `requestPlacementChange({intent:'restore'})` |
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
