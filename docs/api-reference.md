# SHARC API Reference

**Version:** 1.1 (Reference Implementation)  
**Status:** Authoritative for v1 implementation  
**Last Updated:** 2026-04-13  

This document is the definitive developer-facing reference for the SHARC protocol. It reflects all decisions approved by Jeffrey Carlson, including the MessageChannel transport, Page Lifecycle state machine, Structured Clone serialization, and the Enhanced Placement Change System (v0.4.0).

---

## Table of Contents

1. [Protocol Overview](#1-protocol-overview)
2. [Transport Layer — MessageChannel Handshake](#2-transport-layer--messagechannel-handshake)
3. [Message Data Structure](#3-message-data-structure)
4. [Container State Machine](#4-container-state-machine)
5. [EnvironmentData Structure](#5-environmentdata-structure)
6. [Container Messages](#6-container-messages)
7. [Creative Messages](#7-creative-messages)
8. [Extension Framework](#8-extension-framework)
9. [Error Codes](#9-error-codes)

---

## 1. Protocol Overview

SHARC is a bidirectional, session-scoped message protocol between a **container** (the publisher's secure rendering environment — an iframe or WebView) and a **creative** (the ad markup running inside that container).

The container controls the environment. The creative requests actions. The container decides whether to honor them.

**Platform scope (v1):** Web iframes, iOS WKWebView, Android WebView.

### Security Guarantees

The reference implementation enforces the following at the protocol layer:

- **Rate limiting:** Incoming messages are limited to **50 per second** per session. Excess messages are dropped with a warning. (`2205` is the error code for overload.)
- **Pending response cap:** No more than **100 in-flight requests** are allowed simultaneously. New requests beyond that cap are rejected immediately.
- **Session ID validation:** `createSession` must supply a valid UUID v4. Malformed session IDs are rejected.
- **URL validation:** `requestNavigation` and `reportInteraction` tracker URIs accept only `https:` and `http:`. All other schemes are rejected or dropped.
- **Feature name validation:** `request[FeatureName]` validates the feature name format before constructing a message type string, preventing message-type injection.
- **Sandboxed iframe:** The container creates the iframe with `allow-scripts` only. `allow-same-origin` is intentionally absent — adding it alongside `allow-scripts` would allow the creative to remove its own sandbox entirely.

### Message Flow Summary

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

---

## 2. Transport Layer — MessageChannel Handshake

SHARC uses `MessageChannel` as its primary transport. This creates a private, dedicated port pair between the container and the creative — no broadcasting to `window`, no collision risk from other iframes.

### Handshake Sequence

**Step 1: Container creates the channel and loads the creative**

```javascript
// Container side
const channel = new MessageChannel();
const containerPort = channel.port1;  // container keeps this
const creativePort = channel.port2;   // creative gets this

// Load creative in iframe
// IMPORTANT: do NOT include allow-same-origin — see Security section
const iframe = document.createElement('iframe');
iframe.src = creativeUrl;
iframe.sandbox = 'allow-scripts';  // allow-same-origin intentionally omitted
document.body.appendChild(iframe);

// Wait for iframe to load, then send the port
// The bootstrap postMessage uses targetOrigin: '*' — this is intentional.
// See §5 of architecture-design.md for rationale.
iframe.addEventListener('load', () => {
  iframe.contentWindow.postMessage(
    { type: 'SHARC:connect', version: '1.0' },
    '*',              // intentional — port carries no sensitive data
    [creativePort]   // transfer ownership — port2 is now in the creative
  );
});

// Container listens on port1
containerPort.onmessage = (event) => {
  handleMessage(event.data);
};
containerPort.start();
```

**Step 2: Creative receives the port and begins the session**

```javascript
// Creative side
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'SHARC:connect') return;
  
  const port = event.ports[0];
  if (!port) return;  // no port = ignore
  
  port.onmessage = (e) => handleContainerMessage(e.data);
  port.start();
  
  // Store port, then send createSession
  sharcPort = port;
  sendCreateSession();
}, { once: true });
```

All subsequent SHARC messages flow through the dedicated port. The initial `postMessage` is the only broadcast — it carries no sensitive data (only the `MessagePort`), and all subsequent SHARC communication flows through the private channel.

### Fallback: window.postMessage

If `MessageChannel` is unavailable (effectively zero real-world cases on supported platforms), fall back to raw `postMessage`. The container must then filter incoming messages by `sessionId` to handle multiple concurrent sessions.

```javascript
// Fallback: container listens on window
window.addEventListener('message', (event) => {
  if (event.origin !== trustedCreativeOrigin) return;
  if (event.data?.sessionId !== activeSessionId) return;
  handleMessage(event.data);
});
```

### Serialization

Both `MessageChannel` and `postMessage` use the browser's **Structured Clone** algorithm automatically. Do **not** call `JSON.stringify` or `JSON.parse`. Pass the message object directly.

```javascript
// Correct
port.postMessage({ type: 'SHARC:Container:init', args: environmentData });

// Wrong — do not do this
port.postMessage(JSON.stringify({ type: '...' }));
```

---

## 3. Message Data Structure

All SHARC messages — primary and response — share a common structure.

### Primary Message

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
- `messageId` — each party maintains its own independent counter. Container and creative `messageId` values will diverge. First message is `0`.
- `timestamp` — milliseconds since epoch. Should be set as close to the triggering event as possible; do not assume it is exact.

**Example:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 3,
  "timestamp": 1748930400000,
  "type": "SHARC:Creative:requestPlacementChange",
  "args": {
    "changePlacement": {
      "containerDimensions": { "width": 320, "height": 480 },
      "inline": false
    }
  }
}
```

### resolve Message

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

**Example:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 5,
  "timestamp": 1748930400050,
  "type": "resolve",
  "args": {
    "messageId": 3,
    "value": {
      "containerDimensions": { "x": 0, "y": 0, "width": 320, "height": 480 },
      "inline": false
    }
  }
}
```

### reject Message

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
      errorCode: number;    // See Error Codes
      message?: string;     // Optional explanation
    };
  };
}
```

**Example:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 5,
  "timestamp": 1748930400050,
  "type": "reject",
  "args": {
    "messageId": 3,
    "value": {
      "errorCode": 2203,
      "message": "Fullscreen not supported in this placement."
    }
  }
}
```

---

## 4. Container State Machine

### States

SHARC states are aligned with the **Chrome/WebKit Page Lifecycle API**. Creative developers already understand this model from web development.

| State | Creative-Queryable | Visible | JS Active | Focus/Input |
|-------|-------------------|---------|-----------|-------------|
| `loading` | ❌ Internal | ❌ | Partial | ❌ |
| `ready` | ✅ | ❌ | ✅ | ❌ |
| `active` | ✅ | ✅ | ✅ | ✅ |
| `passive` | ✅ | ✅ | ✅ | ❌ |
| `hidden` | ✅ | ❌ | ✅ | ❌ |
| `frozen` | ✅ | ❌ | ❌ | ❌ |
| `terminated` | ❌ Internal | ❌ | ❌ | ❌ |

`loading` and `terminated` are container-internal bookends. The creative never receives a `stateChange` message with these values — by definition, the creative cannot receive messages before init or after termination.

### State Descriptions

**`loading`** (internal)
> The container has created the WebView and is loading the creative. The SHARC handshake has not started. The creative may post `createSession` during this phase, which transitions the container to the init sequence.

**`ready`**
> `Container:init` has been resolved by the creative. The container is about to send `Container:startCreative`. The creative is initialized but not yet visible.

**`active`**
> The container is visible and the app/tab is in the foreground with user focus. The creative should be running normally. Maps to: Page Lifecycle `active`, iOS `UIApplicationState.active`, Android `Activity.onResume()`.

**`passive`**
> The container is visible but the app has lost input focus. Common causes: split-screen multitasking, phone call interruption (iOS), a dialog overlay. The creative is still rendering but user interaction may be limited. Maps to: Page Lifecycle `passive`, iOS `applicationWillResignActive`, Android `Activity.onPause()` in multi-window.

**`hidden`**
> The container is not visible. The app is in the background, the tab is hidden, or the screen is off. JavaScript continues to run but creatives should release non-essential resources and pause animations. Maps to: Page Lifecycle `hidden`, iOS `applicationDidEnterBackground`, Android `Activity.onStop()`.

**`frozen`**
> The OS has suspended JavaScript execution. This happens when the OS needs to reclaim CPU or memory. The creative should have saved state when entering `hidden`. From the creative's perspective, `frozen` and OS process termination look identical (JS stops). Maps to: Page Lifecycle `frozen`, iOS WebContent process suspended, Android `WebView.pauseTimers()`.

**`terminated`** (internal)
> The container has terminated and the WebView has been removed. No further communication is possible.

### State Transition Diagram

```
                ┌──────────┐
                │ LOADING  │  (internal — creative never sees this)
                └────┬─────┘
                     │  createSession received → init → startCreative resolved
                     ▼
                ┌──────────┐
                │  READY   │  ◄── Creative initialized, not yet visible
                └────┬─────┘
                     │  startCreative resolved
                     ▼
    ┌────────────► ACTIVE ◄─────────────────┐
    │            └────┬────┘                │
    │                 │  blur / split-screen │ focus regained
    │                 ▼                      │
    │           ┌──────────┐                │
    │           │ PASSIVE  │────────────────┘
    │           └────┬─────┘
    │                │  app backgrounded / tab hidden
    │                ▼
    │           ┌──────────┐
    │           │  HIDDEN  │
    │           └────┬─────┘
    │                │  OS suspends JS
    │                ▼
    │           ┌──────────┐
    │           │  FROZEN  │
    │           └──────────┘
    │
    │  ── Any state can transition to TERMINATED via: ──────────────────
    │     close (user/container/creative), fatal error, or OS kill
    │
    └─────────────────────────────────────────────────────────────────►
                         TERMINATED (internal)
```

### Valid Transitions

| From | To | Trigger |
|------|----|---------|
| `loading` | `ready` | `createSession` received → init resolved |
| `loading` | `terminated` | createSession timeout (5s); fatal error |
| `ready` | `active` | `startCreative` resolved |
| `ready` | `terminated` | startCreative rejected; timeout (2s) |
| `active` | `passive` | App/tab loses focus |
| `active` | `hidden` | App backgrounded / tab hidden directly (no prior blur on some platforms) |
| `active` | `terminated` | Close or fatal error |
| `passive` | `active` | App/tab regains focus |
| `passive` | `hidden` | App goes to background |
| `passive` | `terminated` | Close or fatal error |
| `hidden` | `passive` | App returns to foreground (no focus yet) |
| `hidden` | `frozen` | OS suspends JS |
| `hidden` | `terminated` | Close or OS kills process |
| `frozen` | `active` | OS resumes → focus |
| `frozen` | `passive` | OS resumes → visible, no focus |
| `frozen` | `hidden` | OS resumes → still hidden |
| `frozen` | `terminated` | OS kills process (no event to creative) |

---

## 5. EnvironmentData Structure

`EnvironmentData` is sent in `Container:init` and describes the publisher's environment.

```typescript
interface EnvironmentData {
  currentPlacement: ContainerPlacement;  // Current container dimensions
  dataspec: Dataspec;                     // AdCOM or other dataspec identifier
  data: Data;                            // Dataspec data (placement, ad, context)
  containerNavigation?: Navigation;       // Navigation capabilities
  currentState: ContainerState;          // State at init time (always "ready")
  version: string;                       // SHARC version, e.g., "1.0.0"
  isMuted?: boolean;                     // True if device is muted (if known)
  volume?: number;                       // 0.0–1.0 volume, or -1 if unknown
}
```

### ContainerPlacement

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

### Dataspec

```typescript
interface Dataspec {
  model: string;  // Default: "AdCOM"
  ver: string;    // Default: "1.0"
}
```

### Data (AdCOM default)

```typescript
interface Data {
  ad: AdcomAd;               // AdCOM Ad object
  placement: AdcomPlacement; // AdCOM Placement object
  context: AdcomContext;     // AdCOM Context (site/app, user, device, regs)
}
```

All `data` fields are optional — a container without AdCOM data omits them. The only truly required `EnvironmentData` fields are `currentPlacement`, `currentState`, and `version`.

### Navigation

```typescript
interface Navigation {
  navigationPossible: boolean;  // Platform supports container-handled navigation
  navigationAllowed: boolean;   // Container will handle navigation (requires navigationPossible=true)
}
```

On web, the browser handles navigation — `navigationPossible` is typically `false`. The creative must always call `requestNavigation` regardless; the container will reject, which signals the creative to open the URL itself. This ensures the container always has a log of navigation events.

On iOS/Android webview, `navigationPossible` is typically `true`. The container handles deep links and store URLs.

---

## 6. Container Messages

Messages sent **from the container to the creative**. These use the `SHARC:Container:*` namespace.

---

### SHARC:Container:init

Sent after `createSession` is resolved. Provides the creative with all environment data needed to initialize.

**Direction:** Container → Creative  
**Requires response:** Yes — `resolve` or `reject`

**Args:**

```typescript
interface ContainerInitArgs {
  environmentData: EnvironmentData;
  supportedFeatures?: Feature[];  // Extensions this container supports
}
```

**resolve** — Creative acknowledges the initialization data. The container then sends `startCreative`.

**reject** — Creative cannot initialize (wrong version, incompatible dimensions, etc.).

```typescript
interface InitRejectArgs {
  errorCode: number;   // See Error Codes
  reason?: string;     // Human-readable explanation
}
```

If the creative does not respond within **2 seconds**, the container treats it as a fatal error (code 2208) and terminates.

---

### SHARC:Container:startCreative

Sent after `init` is resolved. Signals the creative to make itself visible and begin the ad experience.

**Direction:** Container → Creative  
**Requires response:** Yes — `resolve` or `reject`

The creative should respond immediately. The container makes the iframe/WebView visible upon receiving `resolve`.

**resolve** — Creative is ready to display. No additional args required.

**reject** — Creative cannot start.

```typescript
interface StartCreativeRejectArgs {
  errorCode: number;
  reason?: string;
}
```

If the creative does not respond within **2 seconds**, the container terminates with error 2213.

---

### SHARC:Container:stateChange

Sent whenever the container state changes. The creative receives this message to update its behavior accordingly.

**Direction:** Container → Creative  
**Requires response:** No

**Args:**

```typescript
interface ContainerStateChangeArgs {
  containerState: "ready" | "active" | "passive" | "hidden" | "frozen";
}
```

The container does **not** send `stateChange` for `loading` or `terminated` states — the creative cannot receive messages in those states.

---

### SHARC:Container:placementChange

Sent when the container's placement properties change (usually in response to a `requestPlacementChange` from the creative).

**Direction:** Container → Creative  
**Requires response:** No

**Args:**

```typescript
interface ContainerPlacementChangeArgs {
  placementUpdate: CurrentPlacement;
  transition?: TransitionHint;       // Animation timing applied (if any)
  closeButtonPosition?: {            // Position of the container's close button
    position: string;                // e.g. "top-right"
    rect: { x: number; y: number; width: number; height: number };
  };
}

interface CurrentPlacement {
  containerDimensions: PlacementDimensions;
  inline: boolean;  // true = anchored in content; false = overlays content
  standardSize?: "default" | "max" | "min";
}

interface PlacementDimensions {
  x: number;       // DIPs
  y: number;       // DIPs
  width: number;   // DIPs
  height: number;  // DIPs
  anchor?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}
```

The `closeButtonPosition` field enables OMID `addFriendlyObstruction` registration — the creative (or OMID bridge) can report the close button's exact position to the verification vendor.

---

### SHARC:Container:log

Informational message from the container. Primarily for debugging.

**Direction:** Container → Creative  
**Requires response:** No

**Args:**

```typescript
interface ContainerLogArgs {
  message: string;
}
```

Messages prefixed with `"WARNING:"` indicate that the container has detected a spec deviation or performance issue in the creative's behavior. Example:

```
"WARNING: requestPlacementChange sent without required containerDimensions"
```

---

### SHARC:Container:placementConstraintsChange

Sent when placement constraints change mid-session (device rotation, browser resize, publisher policy update). Allows the creative to update its understanding of what the container allows.

**Direction:** Container → Creative  
**Requires response:** No

**Args:**

```typescript
interface PlacementConstraintsChangeArgs {
  constraints: {
    maxWidth: number | null;
    maxHeight: number | null;
    allowedIntents: string[];
    requireCloseRegion: boolean;
    allowOffscreen: boolean;
  };
  reason: "rotation" | "viewportResize" | "policyUpdate";
}
```

The container debounces resize/orientation events (200ms) to avoid flooding the creative during drag-resize.

| `reason` | Trigger | Creative should... |
|----------|---------|-------------------|
| `rotation` | Device orientation change | Re-check if current placement still fits |
| `viewportResize` | Browser/app window resize | Re-check if current placement still fits |
| `policyUpdate` | Publisher changed policy mid-session | Re-query constraints, may need to restore |

The creative SDK caches the constraints from this event in `getCachedConstraints()`.

---

### SHARC:Container:placementTransitionEnd

Sent when a container-side placement animation completes (or immediately if animation is skipped). Every placement change request that includes a `transition` field produces exactly one `placementTransitionEnd` event — no hanging states.

**Direction:** Container → Creative  
**Requires response:** No

**Args:**

```typescript
interface PlacementTransitionEndArgs {
  finalDimensions: {
    width: number;   // DIPs
    height: number;  // DIPs
  };
}
```

There is no `placementTransitionStart` event — the creative already knows when a transition begins (it is the moment `requestPlacementChange()` resolves). A separate start event would be fragile: if the app backgrounds mid-animation, the creative would receive a start with no corresponding end, creating a hanging state.

---

### SHARC:Container:fatalError

Sent when the container encounters an unrecoverable error. The container waits for `resolve` before terminating the creative.

**Direction:** Container → Creative  
**Requires response:** `resolve` only (creative acknowledges, then the container terminates the creative)

**Args:**

```typescript
interface ContainerFatalErrorArgs {
  errorCode: number;
  errorMessage?: string;
}
```

The container terminates the creative after receiving `resolve`, or after a short timeout if `resolve` does not arrive.

---

### SHARC:Container:close

Sent when the close sequence begins. Triggered by: user activating the close control, `Creative:requestClose`, or a platform-level close demand.

**Direction:** Container → Creative  
**Requires response:** `resolve`

**Args:** None

**resolve** — Creative acknowledges close. The container may allow up to **2 seconds** for the creative to run a close sequence (fire trackers, play animation). The container will terminate the creative regardless after 2 seconds.

The close control (typically a 50×50 DIP button in the top-right corner) is **always** provided by the container. The creative may provide its own supplementary close UI, but the container's close control is mandatory.

---

## 7. Creative Messages

Messages sent **from the creative to the container**. These use the `SHARC:Creative:*` namespace.

---

### SHARC:Creative:createSession

Sent when the creative is ready to begin SHARC communication. This is the first message in every session.

**Direction:** Creative → Container  
**Requires response:** `resolve`

**Args:**

```typescript
// No args required. The sessionId in the message envelope IS the session identifier.
args: {}
```

The creative generates a unique `sessionId` (UUID) and includes it in this message. All subsequent messages in the session use this same `sessionId`.

**resolve** — Container acknowledges and will proceed to send `Container:init`.

If `createSession` is not received within **5 seconds**, the container terminates with error 2212.

**Example createSession message:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 0,
  "timestamp": 1748930400000,
  "type": "SHARC:Creative:createSession",
  "args": {}
}
```

---

### SHARC:Creative:fatalError

Sent when the creative encounters an unrecoverable error. The container terminates the creative immediately.

**Direction:** Creative → Container  
**Requires response:** No (container terminates the creative on receipt)

**Args:**

```typescript
interface CreativeFatalErrorArgs {
  errorCode: number;
  errorMessage?: string;
}
```

---

### SHARC:Creative:getContainerState

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

---

### SHARC:Creative:getPlacementOptions

Requests current container placement information.

**Direction:** Creative → Container  
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetPlacementOptionsResolveValue {
  currentPlacementOptions: {
    containerDimensions: PlacementDimensions;
    inline: boolean;
  };
}
```

The container always resolves, even if it cannot provide all values.

---

### SHARC:Creative:log

Sends arbitrary log information to the container.

**Direction:** Creative → Container  
**Requires response:** No

**Args:**

```typescript
interface CreativeLogArgs {
  message: string;
}
```

Messages prefixed with `"WARNING:"` signal that the creative has detected non-standard container behavior. Example:

```
"WARNING: Container sent stateChange without prior startCreative"
```

---

### SHARC:Creative:reportInteraction

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
- Follow redirects (up to 5 hops)
- Apply a 5-second timeout per URI
- Not retry on failure
- Resolve when all URIs have been fired or timed out

**resolve value:**

```typescript
interface ReportInteractionResolveValue {
  results: Array<{
    uri: string;
    success: boolean;
    statusCode?: number;
  }>;
}
```

Standard macros in URIs are replaced by the container. Unknown macros are left intact.

---

### SHARC:Creative:requestNavigation

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

**Security:** The container validates `url` before acting on it. Only `https:` and `http:` schemes are permitted. Requests with any other scheme (`javascript:`, `data:`, `file:`, etc.) are rejected with error code `2211` (`MESSAGE_SPEC_VIOLATION`) and the URL is not opened.

**resolve** — Container handled the navigation (e.g., opened the OS browser on mobile). No further creative action needed.

**reject** — Either the container cannot handle navigation (e.g., web environment where the browser handles it), or the URL failed validation. The creative should inspect the error code:
- `2105` — Container can't handle navigation; creative should open the URL itself (e.g., `window.open(url, '_blank')`). This is a handoff, not an error.
- `2211` — URL failed validation; do not attempt to open it.

The reject does NOT always mean navigation was blocked — `2105` specifically means "creative, you handle it."

---

### SHARC:Creative:requestPlacementChange

Requests that the container change its size or position. Uses an intent-based model where the creative declares what kind of change it wants.

**Direction:** Creative → Container  
**Requires response:** `resolve` or `reject`

**Args:**

```typescript
interface RequestPlacementChangeArgs {
  intent: "resize" | "maximize" | "fullscreen" | "minimize" | "restore";
  targetDimensions?: {       // Required when intent === 'resize'
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
| `maximize` | Expand to maximum available placement size. |
| `fullscreen` | Expand to fill the viewport. |
| `minimize` / `restore` | Return to the original pre-change placement. |

**Close region:** The `closeRegion` field is a **positioning hint**, not a rendering directive. The container always owns and renders the close button (a DOM element outside the sandbox). If the hinted position would place the close button offscreen, the container silently overrides to `top-right` — it does NOT reject the placement change.

**resolve value:**

```typescript
interface RequestPlacementChangeResolveValue {
  placementUpdate: CurrentPlacement;
  transition?: TransitionHint;       // Actual animation applied (if any)
  closeButtonPosition?: {            // Position of the container's close button
    position: string;                // e.g. "top-right"
    rect: { x: number; y: number; width: number; height: number };
  };
}
```

**reject** — The container may reject with:
- `2203` (`FEATURE_NOT_SUPPORTED`) — intent not allowed, dimensions exceed policy limits, or offscreen violation.
- `2211` (`MESSAGE_SPEC_VIOLATION`) — malformed request (e.g., missing required `closeRegion` when policy demands it, unknown intent value, non-string intent).

**Backward compatibility:** When no `placementPolicy` is configured on the container, the validation pipeline is skipped entirely — the container behaves identically to pre-0.4.0 behavior. Rejection only occurs when a publisher configures policy constraints. Creatives that do not handle rejection will see an unhandled Promise rejection.

**Placement policy (container-local, never on wire):**

Publishers configure placement constraints via the `placementPolicy` constructor option on `SHARCContainer`. This controls what the container allows:

```typescript
interface PlacementPolicy {
  maxWidth?: number;                     // DIPs, default: Infinity
  maxHeight?: number;                    // DIPs, default: Infinity
  allowedIntents?: string[];             // Default: all intents
  requireCloseRegion?: boolean;          // Default: false
  allowOffscreen?: boolean;              // Default: true
  customValidator?: (args) => {          // Sync function, default: null
    allowed: boolean;
    reason?: string;
  };
}
```

**Container-owned close button:** On `resize`, `maximize`, and `fullscreen` intents, the container renders a 50 DIP close button as a DOM sibling to the iframe (outside the sandbox, z-index: 2147483647). On `restore`/`minimize`, the close button is removed. For resize state, the close button triggers restore; for maximize/fullscreen, it triggers close. The close button is keyboard-focusable with Enter/Space handlers and has `role="button"` and `aria-label="Close advertisement"`.

**Animation:** When a `transition` hint is provided and the container supports animation (`com.iabtechlab.sharc.placement.animate` feature), the container animates using `transform: scale()` for GPU compositing, then snaps to final `width`/`height` on `transitionend`. The container fires `SHARC:Container:placementTransitionEnd` when animation completes (or immediately if animation is skipped). Duration is capped at 500ms; easing is restricted to five CSS keywords.

---

### SHARC:Creative:requestClose

Requests that the container close the ad. The container is not required to honor this.

**Direction:** Creative → Container  
**Requires response:** `resolve` or `reject`

**Args:** None

**resolve** — Container will close. The container will send `Container:close`.

**reject** — Container cannot close at this time (e.g., a required display duration has not elapsed). The creative may choose to cease activity and emit a `Creative:log` message, but the container remains open.

---

### SHARC:Creative:getPlacementConstraints

Queries the container's placement constraints before requesting a change. Follows the Permissions API query-before-request pattern.

**Direction:** Creative → Container  
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetPlacementConstraintsResolveValue {
  maxWidth: number | null;       // null = no limit
  maxHeight: number | null;      // null = no limit
  allowedIntents: string[];      // e.g. ["resize", "maximize", "restore"]
  requireCloseRegion: boolean;   // Whether closeRegion is required on resize
  allowOffscreen: boolean;       // Whether content may extend beyond viewport
}
```

The `customValidator` is intentionally omitted — it is opaque container-side logic that creatives should not inspect.

The creative SDK caches the response in `getCachedConstraints()` (synchronous accessor) and updates the cache on `constraintsChange` events. Before any query or event, `getCachedConstraints()` returns unconstrained defaults (never null).

**Feature detection:** Use `SHARC.hasFeature('com.iabtechlab.sharc.placement.constraints')` before calling.

---

### SHARC:Creative:getFeatures

Requests the list of extensions/features the container supports. This returns the same data as `supportedFeatures` in `Container:init` — useful for late-binding queries.

**Direction:** Creative → Container  
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetFeaturesResolveValue {
  features: Feature[];
}
```

Features do not change after `init` in v1.

---

### SHARC:Creative:request[FeatureName]

Invokes a named extension feature. The message type is `SHARC:Creative:request` + the feature name (capitalized). Example: `SHARC:Creative:requestAudio`.

**Direction:** Creative → Container  
**Requires response:** `resolve` or `reject`

**Args:** Defined by the feature specification.

**Security:** Feature names are validated against the required namespace format before the message type is constructed. Valid names must match the pattern `com.[domain].[...].featureName` using only alphanumerics, dots, and hyphens (e.g., `com.iabtechlab.sharc.audio`). Invalid names are rejected client-side before any message is sent, preventing message-type injection attacks.

**resolve** — Feature executed. Response value defined by the feature.

**reject** — Feature is not supported or could not be executed. Error codes:
- `2203` — Feature unsupported by this container
- `2204` — Feature known but execution failed

---

## 8. Extension Framework

### Feature Object

```typescript
interface Feature {
  name: string;      // Namespaced feature name
  version: string;   // Feature version
  functions: object; // Available function descriptors
}
```

### Namespacing

| Namespace | Owner |
|-----------|-------|
| `com.iabtechlab.sharc.*` | IAB Tech Lab official features |
| `com.*` | Third-party features using reverse-domain notation |

Examples:
- `com.iabtechlab.sharc.audio` — IAB-defined audio control extension
- `com.iabtechlab.sharc.placement.resize` — Container supports validated resize with close region enforcement
- `com.iabtechlab.sharc.placement.constraints` — Creative can query placement constraints via `getPlacementConstraints()`
- `com.iabtechlab.sharc.placement.animate` — Container supports animated placement transitions
- `com.iabtechlab.sharc.location` — IAB-defined location extension
- `com.example.customtracking` — Third-party tracking extension

### Using Extensions

**Step 1: Check feature availability (sync, uses init data)**

```javascript
// In SHARC SDK
if (SHARC.hasFeature('com.iabtechlab.sharc.audio')) {
  // safe to call audio feature
}
```

**Step 2: Call the feature**

```javascript
const result = await SHARC.requestFeature('com.iabtechlab.sharc.audio', {
  action: 'setVolume',
  level: 0.5
});
```

### Advertising Features from a Container

```javascript
// In Container:init, include supportedFeatures:
environmentData.supportedFeatures = [
  {
    name: 'com.iabtechlab.sharc.audio',
    version: '1.0',
    functions: {
      setVolume: { args: ['level: number 0-1'] },
      mute: {},
      unmute: {}
    }
  }
];
```

---

## 9. Error Codes

### Creative Errors (21xx)

| Code | Name | Description |
|------|------|-------------|
| 2100 | Unspecified creative error | Catchall. Use more specific codes when possible. |
| 2101 | Resources could not be loaded | Creative tried to load assets but failed. |
| 2102 | Container dimensions not suited | Container dimensions don't match creative's requirements. |
| 2103 | Wrong SHARC version (creative) | Creative cannot support this container's SHARC version. |
| 2104 | Creative could not be executed | Unspecified technical execution failure. |
| 2105 | Creative handles navigation | Reject code: container cannot handle navigation; creative should open URL itself. |
| 2108 | Ad internal error | Creative error unrelated to external dependencies. |
| 2109 | Device not supported | Creative cannot render or execute on this device. |
| 2110 | Container sending messages incorrectly | Container messages are malformed, mislabeled, or out-of-spec. |
| 2111 | Container not responding adequately | Container responses are delayed or missing expected data. |

### Container Errors (22xx)

| Code | Name | Description |
|------|------|-------------|
| 2200 | Unspecified container error | Catchall. Use more specific codes when possible. |
| 2201 | Wrong SHARC version (container) | Container cannot support this creative's SHARC version. |
| 2203 | Feature not supported | Creative requested a feature the container doesn't support. |
| 2204 | Feature execution failed | Feature known but execution failed. |
| 2205 | Message channel overloaded | Creative is sending too many messages. |
| 2208 | Creative did not reply in time | Creative took too long to resolve or reject. |
| 2209 | Creative not supported on device | Creative cannot be rendered on this device. |
| 2210 | Creative not following init spec | Creative is not following the spec during initialization. |
| 2211 | Creative sending malformed messages | Creative messages are out of spec. |
| 2212 | Creative did not reply to init | Creative did not send `createSession` within timeout. |
| 2213 | Creative did not reply to start | Creative did not resolve `startCreative` within timeout. |

---

## Appendix: Timeout Summary

| Event | Default Timeout | On Expiry | Error Code |
|-------|-----------------|-----------|------------|
| `createSession` | 5 seconds | Terminate | 2212 |
| `Container:init` resolve | 2 seconds | Terminate | 2208 |
| `Container:startCreative` resolve | 2 seconds | Terminate | 2213 |
| Close sequence (after `Container:close`) | 2 seconds | Force terminate | — |
| Tracker firing (`reportInteraction`) | 5 seconds per URI | Mark failed, continue | — |

All timeouts have configurable defaults. SSAI/live environments may set `createSession` timeout to 0.

---

## Appendix: Message Type Reference

### Container → Creative

| Message | Response Required | When Sent |
|---------|------------------|-----------|
| `SHARC:Container:init` | resolve or reject | After createSession resolved |
| `SHARC:Container:startCreative` | resolve or reject | After init resolved |
| `SHARC:Container:stateChange` | None | On any state transition |
| `SHARC:Container:placementChange` | None | After placement changes |
| `SHARC:Container:placementConstraintsChange` | None | When placement constraints change (rotation, resize, policy update) |
| `SHARC:Container:placementTransitionEnd` | None | When placement animation completes or is skipped |
| `SHARC:Container:audioVolumeChange` | None | When audio state changes |
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
| `SHARC:Creative:requestPlacementChange` | resolve or reject | On resize/expand/restore |
| `SHARC:Creative:requestClose` | resolve or reject | When creative wants to close |
| `SHARC:Creative:getFeatures` | resolve | Any time after init |
| `SHARC:Creative:request[FeatureName]` | resolve or reject | When using an extension |
