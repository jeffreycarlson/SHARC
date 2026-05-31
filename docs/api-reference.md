# SHARC API Reference

**Document revision:** 1.2 (Reference Implementation, current through package v0.7.3)
**Status:** Authoritative for v1 implementation
**Last Updated:** 2026-05-21

This document is the definitive developer-facing reference for the SHARC protocol. It reflects all decisions approved by Jeffrey Carlson, including the MessageChannel transport, Page Lifecycle state machine, Structured Clone serialization, and the Enhanced Placement Change System (v0.4.0).

---

## Table of Contents

1. [SHARCContainer JavaScript API](#1-sharccontainer-javascript-api)
2. [Protocol Overview](#2-protocol-overview)
3. [Transport Layer — MessageChannel Handshake](#3-transport-layer--messagechannel-handshake)
4. [Message Data Structure](#4-message-data-structure)
5. [Container State Machine](#5-container-state-machine)
6. [EnvironmentData Structure](#6-environmentdata-structure)
7. [Container Messages](#7-container-messages)
8. [Creative Messages](#8-creative-messages)
9. [Extension Framework](#9-extension-framework)
10. [Renderer Protocol](#10-renderer-protocol) (Creative Markup variant — 0.7.0)
11. [Error Codes](#11-error-codes)

---

## 1. SHARCContainer JavaScript API

This section documents the JavaScript constructor API for `SHARCContainer` — the container-side class that manages the full ad instance lifecycle on the publisher page. The wire protocol (messages, transport, state machine) is covered in sections 2–11.

### Constructor Options

```javascript
new SHARCContainer(options)
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `creativeUrl` | `string` | No (one of `creativeUrl` OR `creativeHtml + creativeRendererUrl`) | URL of the SHARC-enabled creative HTML (Creative URL variant). Mutually exclusive with `creativeHtml`. Empty string normalizes to "not provided." |
| `creativeHtml` | `string` | No (required when using Creative Markup variant — added in 0.7.0) | Raw HTML markup for the creative. Mutually exclusive with `creativeUrl`. Requires `creativeRendererUrl`. Posted to the operator-hosted renderer page via the renderer protocol. Capped at 256 KiB at construction. See [Renderer Protocol](#10-renderer-protocol). |
| `creativeRendererUrl` | `string \| URL` | No (required when `creativeHtml` is provided) | HTTPS URL of an operator-hosted renderer page. Forbidden alongside `creativeUrl`. Must parse via `new URL(...)`, use the `https:` scheme, contain no userinfo, and be cross-origin to both `window.location` and (when accessible) `window.top.location`. Added in 0.7.0. |
| `creativeRendererIntegrity` | `string` | No | Creative Markup variant only. Optional SRI-style SHA-384 digest (`sha384-<base64>`) for `creativeRendererUrl`. When set, the container preflight-fetches the renderer document, verifies the bytes with Web Crypto, and refuses to assign `iframe.src` or send `SHARC:Renderer:render` on mismatch or unverifiable bytes (`RENDERER_INTEGRITY_FAIL`, 2120). Best-effort defense-in-depth: browsers do not support native `integrity=` on iframes, so operators should still use immutable renderer URLs, CDN controls, and CORS headers that allow publisher-side fetch verification. |
| `placementElement` | `HTMLElement` | Yes | The DOM element to insert the iframe into. |
| `environmentData` | `Object` | No | Environment data sent in `Container:init`. Default: `{}`. See [EnvironmentData](#6-environmentdata-structure). |
| `placementId` | `string\|null` | No | Publisher-supplied placement identifier. Omitting the option or passing `''` both produce `null`. |
| `placementName` | `string\|null` | No | Human-readable placement name. Same null normalization as `placementId`. |
| `extensions` | `Object[]` | No | Extension plugin instances such as [`OmidCompatBridge`](#omidcompatbridge). Default: `[]`. |
| `supportedFeatures` | `Array<string\|{name,version?}>` | No | Explicit feature descriptors. Extensions contribute their feature names automatically. Default: `[]`. |
| `omidAutoInstall` | `Object` | No | Operator-owned OMID auto-install defaults. When `creativeMeta.apis` contains AdCOM `7` (OMID 1.0) and `creativeMeta.measurement.omid.verificationScripts` is present, the container appends an `OmidCompatBridge` extension built from this object plus the bid-declared OMID sidecar. This object supplies trusted OM SDK URLs (`omSdkServiceScriptUrl`, `omSdkSessionClientUrl`) and partner defaults; bid metadata supplies verification resources and optional OMID session descriptors. Missing or invalid sidecar data warns and continues without installing OMID. Added in 0.7.6. |
| `placementPolicy` | `Object` | No | Constrains creative-driven placement requests. When omitted, placement requests bypass policy validation. See [requestPlacementChange](#sharccreativerequestplacementchange). |
| `requireSharcInit` | `boolean` | No | When `false`, skips the `createSession` fatal-timeout so non-SHARC creatives load to a stable container instance. Useful for mixed inventory, validator tooling, and generic HTML banners. Default: `true`. Added in 0.7.2. |
| `timeouts` | `Object` | No | Override default timeout values. Markup variant adds `rendererLoad` (default 5000ms) and `rendererReply` (default 2000ms). |
| `onStateChange` | `Function` | No | Called with `(newState, previousState)` on every state transition. |
| `onClose` | `Function` | No | Called when the container has fully closed. |
| `onError` | `Function` | No | Called with `(errorCode, errorMessage)` on fatal errors. |
| `onNavigation` | `Function` | No | Called with `(navigationArgs)` when the creative requests navigation. Observation-only in 0.7.x — return value is ignored and cannot block, allow, or rewrite the navigation. |
| `onInteraction` | `Function` | No | Called with `(trackingUris)` when the creative reports an interaction. |
| `onMessage` | `Function` | No | Called with every received message (for debugging and logging). |
| `onSecurityEvent` | `(event: SHARCSecurityEvent) => void` | No | Production observability hook fired with a discriminated-union payload for security-relevant events (wrapper carve-out, origin mismatch, renderer protocol failure, unauthorized navigation). Synchronous; throws are caught and logged. Console output continues regardless. Added in 0.7.0. See [`onSecurityEvent` surface](#onsecurityevent-surface). |
| `wrapperPolicy` | `'warn' \| 'block'` | No | Validation-rule-7 wrapper-cross-origin carve-out policy. `'warn'` (default) emits `console.warn` + `onSecurityEvent` and proceeds; `'block'` emits `console.error` + `onSecurityEvent` and throws synchronously. Added in 0.7.0. |
| `allowPopups` | `boolean` | No | When `true` (default), the Markup renderer iframe sandbox includes `allow-popups` and `allow-popups-to-escape-sandbox`. When `false`, both tokens are omitted. Added in 0.7.0. |
| `allowTopNavigationByUserActivation` | `boolean` | No | When `true` (default), the Markup renderer iframe sandbox includes `allow-top-navigation-by-user-activation`. The unsafe `allow-top-navigation` token (no-gesture) is never exposed. Added in 0.7.0. |
| `allowStorageAccessByUserActivation` | `boolean` | No | When `true` (default), the Markup renderer iframe sandbox includes `allow-storage-access-by-user-activation`. Added in 0.7.0. |
| `allowModals` | `boolean` | No | When `true`, the Markup renderer iframe sandbox includes `allow-modals`. Default `false`. Added in 0.7.0. |
| `allowDownloads` | `boolean` | No | When `true`, the Markup renderer iframe sandbox includes `allow-downloads`. Default `false`. Added in 0.7.0. |
| `bridges` | `string[] \| null` | No | Creative Markup variant only. Explicit list of compatibility-bridge identifiers the renderer should load alongside the creative HTML. Reserved identifiers in 0.7.1: `'mraid'`, `'safeframe'`. Pass `[]` to suppress all bridge loading (static-image creative). Pass `null` (or omit) for auto-detection via `creativeMeta.apis` → adm content scan. Unknown identifiers throw at construction (stricter than renderer-side handling). Resolved value is reflected on `container.bridges` and on the `bridges` field of the `SHARC:Renderer:render` message. Added in 0.7.1. See [Bridges field](#bridges-and-creativemeta-0-7-1). |
| `creativeMeta` | `{ apis?: number[], measurement?: { omid?: Object } }` | No | Bid-side metadata bag. On Creative Markup, `creativeMeta.apis` drives bridge selection plus `container.apiFramework`: `3` / `5` / `6` (MRAID 1.0 / 2.0 / 3.0) → `'mraid'`; `SAFEFRAME_API_CODE` → `'safeframe'`; `SHARC_API_CODE` resolves `container.apiFramework` but does not load a bridge. Code `7` (OMID 1.0) is measurement-only and never produces a renderer bridge; when paired with `omidAutoInstall` and `creativeMeta.measurement.omid.verificationScripts`, it auto-installs `OmidCompatBridge`. On Creative URL, `creativeMeta` is accepted only as forward-compatible metadata/measurement sidecar input; it does not load bridges and `container.apiFramework` remains `null`. Added in 0.7.1; OMID sidecar auto-install added in 0.7.6. See [Bridges field](#bridges-and-creativemeta-0-7-1). |
| `creativeSdkUrl` | `string` | No | URL of the operator-hosted `sharc-creative.js` bundle. Auto-injects a `<script src>` tag into creative HTML at load time. Supported on both Creative variants in 0.7.4 (URL-variant parity, #106): Markup variant injects unconditionally; URL variant requires `useMarkupInjection: true` (explicit opt-in — without it, the URL variant continues to load via `iframe.src` and `creativeSdkUrl` is a no-op). Fetch failures on URL variant emit a `console.warn` and fall through to the un-injected `iframe.src` load; no SHARCSecurityEvent fires. Default: `undefined`. Added in 0.7.2; URL variant added in 0.7.4. |
| `creativeSdkSkipIfPresent` | `boolean` | No | Idempotency guard for `creativeSdkUrl`. When `true`, markup already containing a real `<script src="...sharc-creative.js">` tag is left alone. Default: `true`. Added in 0.7.2. |
| `creativeSdkScriptAttrs` | `Object` | No | Additional `<script>` attributes for the auto-injected tag (e.g. `{ integrity: "sha384-..." }`, `{ nonce: "abc" }`). Default `{}` emits a bare parser-blocking synchronous tag. Added in 0.7.2. |
| `autoStart` | `boolean` | No | If `true`, calls `startCreative` automatically after `init` resolves. Default: `true`. |
| `visible` | `boolean` | No | Initial iframe visibility. Set to `false` to preload silently. Default: `false`. |
| `useMarkupInjection` | `boolean` | No | Opt-in (Creative URL only): fetch the creative HTML, pipe it through built-in SDK injection (when `creativeSdkUrl` is set, 0.7.4+) and extension injectors, and load via `srcdoc`. Default: `false`. Markup variant ALWAYS runs registered injectors (independent of this flag). |
| `closeButtonStyles` | `Object` | No | CSS overrides for the auto-rendered close button (e.g. `{ top: '10px', right: '10px' }`). |

### Instance Properties

After construction, the following properties are readable on any `SHARCContainer` instance:

| Property | Type | Description |
|----------|------|-------------|
| `placementSessionId` | `string` | UUID v4 generated at construction time. Unique per `SHARCContainer` instance. Used for DOM stamping and diagnostics. Never `null`. |
| `sessionId` | `string\|null` | The creative's session ID. Set during the `createSession` handshake. `null` before the handshake completes. |
| `hasSharcSession` | `boolean` | `true` once the SHARC `createSession` handshake has been accepted; `false` until then. Added in 0.7.2. |
| `placementId` | `string\|null` | As passed to the constructor, normalized: `''` is stored as `null`. |
| `placementName` | `string\|null` | As passed to the constructor, normalized: `''` is stored as `null`. |
| `creativeUrl` | `string\|null` | The creative URL as provided at construction. `null` when constructed via the Creative Markup variant. |
| `creativeRendererUrl` | `string\|null` | The renderer URL as provided at construction (Markup variant). `null` for Creative URL. Added in 0.7.0. |
| `creativeSource` | `'url' \| 'html'` | Discriminator for which variant constructed this container. Added in 0.7.0. |
| `creativeRendered` | `boolean` | `true` once the renderer's envelope-validated `:rendered` arrives (Markup variant). `false` for Creative URL (no renderer protocol step). Added in 0.7.0. |
| `creativeInjected` | `boolean` | `true` once any registered extension's `injectIntoMarkup(html)` ran AND modified the markup. Independent of variant. |
| `bridges` | `ReadonlyArray<string>` | Frozen array of compatibility-bridge identifiers the renderer will load. Resolved at construction via the three-layer detection pipeline (explicit `bridges` option → `creativeMeta.apis` AdCOM codes → adm content scan). Always `[]` in Creative URL variant. Added in 0.7.1. |
| `apiFramework` | `number\|null` | AdCOM `APIFramework` integer code for the declared container runtime, resolved at construction via the three-layer picker. `null` means no recognized runtime. Added in 0.7.2. |
| `placementElement` | `HTMLElement` | The DOM element passed at construction. |

### DOM Stamping

On `load()`, `SHARCContainer` stamps `data-sharc-*` attributes onto the placement element and the creative iframe. All stamped attributes are removed on `close()`, restoring the element to its pre-`load()` state byte-for-byte (including the original `class` attribute).

**Placement element** (`placementElement`):

| Attribute | Always present | Description |
|-----------|---------------|-------------|
| `class="sharc-placement"` (added to existing class) | Yes | Ownership marker. |
| `data-sharc-placement-session-id` | Yes | Value is `placementSessionId`. Unique per instance. |
| `data-sharc-placement-id` | Only when `placementId` is non-null | Publisher-supplied placement identifier. |
| `data-sharc-placement-name` | Only when `placementName` is non-null | Human-readable placement name. |
| `data-sharc-version` | Yes | SHARC version string (e.g. `"0.7.3"`). |
| `data-sharc-state` | Yes | Live-reflected container state (e.g. `"active"`). Updates on every state transition. |
| `data-sharc-intent` | Only when an intent is active | Live-reflected active intent: `"resize"`, `"expand"`, or `"fullscreen"`. Absent after `collapse` or when no intent is active. |

**Creative iframe**:

| Attribute | Always present | Description |
|-----------|---------------|-------------|
| `class="sharc-creative"` | Yes | Type marker. |
| `data-sharc-placement-session-id` | Yes | Back-pointer to the owning placement. Same value as the placement element's `data-sharc-placement-session-id`. |
| `data-sharc-creative-source` | Yes (added 0.7.0) | Variant discriminator: `"url"` (Creative URL) or `"html"` (Creative Markup). |
| `data-sharc-creative-rendered` | Yes (added 0.7.0) | `"true"` once the renderer's envelope-validated `:rendered` arrives (Markup); `"false"` for Creative URL or before `:rendered`. |
| `data-sharc-creative-injected` | Yes | `"true"` once a registered extension's `injectIntoMarkup(html)` ran AND modified the markup; otherwise `"false"`. |

These attributes are intended for publisher CSS selectors, observability tooling, and debugging. Do not rely on them for business logic inside the creative — the creative has no direct DOM access to the placement element.

### Isolation Guard

`SHARCContainer` throws **synchronously at construction** if `placementElement` already carries `class="sharc-placement"` — meaning it is already owned by another `SHARCContainer` instance. The error message includes the existing `data-sharc-placement-session-id` for diagnostics.

```javascript
// Throws immediately if the element is already owned:
// "[SHARCContainer] This placement element is already owned by another SHARC instance
//  (data-sharc-placement-session-id="a1b2c3..."). Call close() on the existing instance first."
const container = new SHARCContainer({ placementElement: alreadyOwnedEl, ... });
```

To reuse an element, call `close()` on the existing instance first. `close()` removes `class="sharc-placement"` and all `data-sharc-*` attributes, releasing the element for reuse.

---

## 2. Protocol Overview

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

## 3. Transport Layer — MessageChannel Handshake

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
    { type: 'SHARC:Container:handshake', version: '1.0' },
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
  if (event.data?.type !== 'SHARC:Container:handshake') return;
  
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

## 4. Message Data Structure

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

## 5. Container State Machine

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

## 6. EnvironmentData Structure

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

## 7. Container Messages

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
| `policyUpdate` | Publisher changed policy mid-session | Re-query constraints, may need to `collapse` |

The SHARC Creative API caches the constraints from this event in `getCachedConstraints()`.

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

## 8. Creative Messages

Messages sent **from the creative to the container**. These use the `SHARC:Creative:*` namespace.

---

### SHARC:Creative:createSession

Sent when the creative is ready to begin SHARC communication. This is the first message in every session.

**Direction:** Creative → Container  
**Requires response:** `resolve`

**Args:**

```typescript
interface CreateSessionArgs {
  placementType?: "inline" | "interstitial";  // Default: "inline"
  version: string;                             // SHARC version of the creative SDK
}
```

- `placementType` — the creative's self-declared placement type. `"inline"` (default) means the ad is anchored in page content. `"interstitial"` means the ad overlays content. Omitting the field is equivalent to `"inline"`.
- `version` — the SHARC spec version the creative SDK conforms to (e.g. `"0.7.3"`). Used by the container for version compatibility checks.

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
  "args": {
    "placementType": "inline"
  }
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

**Operator callback semantics:** `onNavigation` is an observation hook in 0.7.x. The callback receives the validated navigation args for telemetry and audit, but its return value is ignored. Returning `{ allowed: false }`, a rewritten URL, a Promise, or any other value does not block, allow, delay, or rewrite the protocol response. Runtime allow/deny/rewrite policy remains future 0.8+ design work; click-time URL policy should be enforced upstream at creative review / serving time.

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
  intent: "resize" | "expand" | "fullscreen" | "collapse";
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
| `expand` | Expand to maximum available placement size (`maxExpandSize`). |
| `fullscreen` | Expand to fill the viewport (`position: fixed`). |
| `collapse` | Return placement to its default/original state (`initialDefaultSize`). Used after any non-default placement (resize, expand, or fullscreen). |

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

**Container-owned close button:** On `resize`, `expand`, and `fullscreen` intents, the container renders a 50 DIP close button as a DOM sibling to the iframe (outside the sandbox, z-index: 2147483647). On `collapse`, the close button is removed. For resize state, the close button triggers collapse; for expand/fullscreen, it triggers close. The close button is keyboard-focusable with Enter/Space handlers and has `role="button"` and `aria-label="Close ad"`.

**Animation:** When a `transition` hint is provided and the container supports animation (`com.iabtechlab.sharc.placement.animate` feature), the container animates directly via CSS `width`/`height` transitions to the target dimensions. The container fires `SHARC:Container:placementTransitionEnd` when animation completes (or immediately if animation is skipped). Duration is capped at 500ms; easing is restricted to five CSS keywords.

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
  allowedIntents: string[];      // e.g. ["resize", "expand", "collapse"]
  requireCloseRegion: boolean;   // Whether closeRegion is required on resize
  allowOffscreen: boolean;       // Whether content may extend beyond viewport
}
```

The `customValidator` is intentionally omitted — it is opaque container-side logic that creatives should not inspect.

The SHARC Creative API caches the response in `getCachedConstraints()` (synchronous accessor) and updates the cache on `constraintsChange` events. Before any query or event, `getCachedConstraints()` returns unconstrained defaults (never null).

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

## 9. Extension Framework

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
// In SHARC Creative API
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

### Lifecycle event payloads

Extensions opt in to container lifecycle by implementing `onContainerLifecycleEvent(event)`. Every dispatched event carries a stable base shape; per-type fields are layered on top.

**Base event shape (every type):**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | One of `'load'`, `'stateChange'`, `'placementChange'`, `'close'`, `'destroy'`, `'error'`. |
| `container` | `SHARCContainer` | The originating container instance. |
| `timestamp` | `number` | `Date.now()` at dispatch. |
| `state` | `string \| null` | Container state at dispatch (from the state machine: `'loading'`, `'ready'`, `'active'`, `'passive'`, `'hidden'`, `'frozen'`, `'terminated'`). `null` only if the state machine hasn't been instantiated yet. |

**Per-type detail fields:**

| `type` | Additional fields | Notes |
|--------|-------------------|-------|
| `'load'` | — | Fired once when the container reaches `ready`. |
| `'stateChange'` | `newState: string`, `previousState: string` | Mirrors the container state machine (§5). |
| `'placementChange'` | `placementUpdate: object` (the new placement payload), `extra: object \| null` (caller-supplied options, e.g. `transition`, `closeButtonPosition`), `intent: 'expand' \| 'resize' \| 'collapse' \| 'fullscreen'` | The field name is **`intent`**, not `mode`. See §7 `placementChange`. |
| `'close'` | — | Fired when the creative or container initiates close. |
| `'destroy'` | — | Fired during `_terminate()` cleanup. |
| `'error'` | `errorCode: number`, `errorMessage: string`, `source: 'creative' \| 'container'` | Canonical fatal-error payload (see below). |

#### Error event payload contract

Both fatal-error paths in `SHARCContainer` dispatch the same canonical shape to extensions:

| Field | Type | Source path | Description |
|-------|------|-------------|-------------|
| `errorCode` | `number` | both | Numeric error code (see `ErrorCodes` in `sharc-protocol.js`). |
| `errorMessage` | `string` | both | Human-readable message. **Field name is `errorMessage`** — matches the public `onError(errorCode, errorMessage)` callback signature. There is no `message` alias. |
| `source` | `'creative' \| 'container'` | discriminator | `'creative'` when the error arrived via `SHARC:Creative:fatalError` (`_handleCreativeFatalError`); `'container'` when raised locally by the container (`_handleFatalError`). |

Pinned by `test/node/test-omid-container-lifecycle.js` §H6. The `errorMessage` field name is locked — pre-1.0 may rename it, but `message` is explicitly NOT a synonym.

### OmidCompatBridge

Container-side extension that wires SHARC container lifecycle to the IAB Open Measurement SDK (OM SDK) `AdSession`. The publisher page loads OM SDK; the container drives session lifecycle from its own state transitions. Added in 0.7.3. See [`docs/design/0.7.3-omid-wiring.md`](design/0.7.3-omid-wiring.md) for the architecture.

```javascript
import { OmidCompatBridge } from '@iabtechlab/sharc/sharc-omid-bridge';
new OmidCompatBridge(options);
```

#### Constructor options

| Option | Type | Validation | Description |
|--------|------|------------|-------------|
| `omSdkServiceScriptUrl` | `string` | HTTPS required, no userinfo; throws `TypeError` on invalid. **Missing** (vs invalid) does NOT throw — the bridge silently goes inert (see [Feature gating](#feature-gating)). | URL of the OM SDK Service Script (`omweb-v1.js`). Injected into `document.head` (or `document.documentElement` if no head) on the publisher page. Required (with `omSdkSessionClientUrl`) for feature advertisement. |
| `omSdkSessionClientUrl` | `string` | Same as above | URL of the OM SDK Session Client (`omid-session-client-v1.js`). |
| `partnerName` | `string` | None | OM SDK partner name reported in `Partner`. Default: `'SHARCOmidBridge'`. |
| `partnerVersion` | `string` | None | OM SDK partner version. Default: mirrors `SHARC_VERSION`. |
| `verificationScripts` | `Array<VerificationScript>` | Per-entry HTTPS + no-userinfo; deduplicated by URL; throws `TypeError` on invalid entries | OM SDK `VerificationScriptResource` descriptors. See VerificationScript shape below. Default: `[]`. |
| `creativeType` | `'video' \| 'audio' \| 'display'` | None | OM SDK creative type. Default: `'video'`. |
| `impressionType` | `'definedByJavaScript' \| 'beginToRender' \| 'onePixel'` | None | OM SDK impression type. Default: `'definedByJavaScript'`. |
| `mediaType` | `'video' \| 'audio' \| 'display'` | None | OM SDK media type. Default: inherits from `creativeType`, then `'video'`. MediaEvents are constructed only when this resolves to a non-`'display'` value — so `creativeType: 'display'` with `mediaType` unset also disables MediaEvents. |
| `contentUrl` | `string` | None | OM SDK content URL. Default: `window.location.href`. |
| `vastProperties` | `{ isSkippable?, skipOffset?, isAutoPlay?, position? }` | None | Optional VAST overrides for `AdEvents.loaded()` on video/audio sessions. |

##### VerificationScript shape

```typescript
interface VerificationScript {
  resourceUrl: string;              // HTTPS, no userinfo (alias accepted: `url`)
  vendorKey?: string;               // (alias accepted: `vendor`)
  verificationParameters?: string;  // opaque vendor-supplied string
  accessMode?: 'limited' | 'full';  // default: 'limited'
}
```

Both the canonical OM SDK names (`resourceUrl` / `vendorKey` / `verificationParameters`) and the legacy SHARC aliases (`url` / `vendor`) are accepted at the input boundary. Canonical names are preferred and used in error messages. `verificationParameters` has no legacy alias and must be passed under the canonical name.

#### Lifecycle hook contract

The container invokes `extension.onContainerLifecycleEvent({ type, container, ...detail })` for each lifecycle phase. `OmidCompatBridge` dispatches internally:

| `event.type` | OM SDK action |
|--------------|---------------|
| `'load'` | `_ensureSdkLoaded()` injects both OM SDK scripts into `document.head` (no-op if `_isOmSdkLoaded()` detects pre-existing globals). |
| `'stateChange'` | Forwards to `onContainerStateChange(newState, previousState, container)` — see state mapping below. |
| `'placementChange'` | `MediaEvents.playerStateChange(mode)` for video/audio sessions (`'expand' → 'expanded'`, `'resize' → 'normal'`); also re-evaluates visibility. |
| `'close'`, `'destroy'`, `'error'` | `AdSession.finish()` (idempotent via `_sessionFinished` flag). |

State mapping (dispatched from `onContainerStateChange`):

| Container state | OM SDK action |
|-----------------|---------------|
| `'ready'` | `_createSession()` → `AdSession.start()` (awaits the SDK load promise from `'load'` if not yet resolved) |
| `'active'` (first entry) | `AdEvents.loaded(VastProperties?)` then `AdEvents.impressionOccurred()` then `AdEvents.stateChange('VISIBLE')`. `loaded()` and `impressionOccurred()` are single-fire-guarded via `loadedFired` / `impressionFired`; the visibility signal is a strict subset of the re-entry behavior. `VastProperties` is constructed only for video/audio sessions; display sessions receive `loaded()` with no argument. |
| `'active'` (re-entry) | `AdEvents.stateChange('VISIBLE')` |
| `'passive'`, `'hidden'`, `'frozen'` | `AdEvents.stateChange('NON_VISIBLE')` |
| `'terminated'` | `AdSession.finish()` (idempotent) |

#### Public methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `getFeatureName()` | `() => string \| null` | Returns `'com.iabtechlab.sharc.omid'` when both OM SDK URLs are configured; `null` otherwise. The container reads this to merge into `supportedFeatures`. |
| `getFeatureDescriptor()` | `() => Feature \| null` | Returns `{ name, version, capabilities }` (capabilities include `sdkInjected`, `mediaEvents`, `adEvents`, `creativeType`, `impressionType`); `null` when bridge is inert. Provided for operator inspection and test harnesses — the container itself only reads `getFeatureName()` when assembling `supportedFeatures`. |
| `getFeatureVersion()` | `() => string` | Returns bridge version (mirrors `SHARC_VERSION`). |
| `getFeatureFunctions()` | `() => string[]` | Returns descriptive capability labels (`['startSession', 'signalAdEvent', 'signalMediaEvent', 'finishSession']`). Compatibility/inspection aid only — not creative-callable, not consumed by the container. |
| `registerFriendlyObstruction(element, purpose?, reason?)` | `(HTMLElement, string?, string?) => void` | Registers `element` as a friendly obstruction on the active `AdSession`. Defaults: `purpose='closeAd'`, `reason='Container close button'`. Stores the element synchronously; defers OM SDK registration until `AdSession.start()` runs if the session isn't ready yet. Duplicate registrations of the same element are suppressed. |
| `unregisterFriendlyObstruction()` | `() => void` | Removes the currently tracked friendly obstruction. Idempotent. |
| `destroy()` | `() => void` | Idempotent cleanup. Unregisters friendly obstructions, calls `AdSession.finish()` if active, removes injected OM SDK `<script>` tags from `document.head`, and clears session state. The container invokes this from `_terminate()` (reached via `close()`, fatal error, or explicit destroy). The `close`/`destroy`/`error` lifecycle events themselves only trigger `_finishSession()`; the full `destroy()` runs as part of the subsequent termination path. |
| `injectIntoMarkup(html)` | `(string) => string` | Returns markup unchanged. OMID is container-owned in 0.7.3 — no creative-side scripts are injected. Exists for bridge-interface parity with `MRAIDCompatBridge` and `SafeFrameCompatBridge`. |
| `injectScripts(html)` | `(string) => string` | No-op; same rationale as `injectIntoMarkup`. |
| `getScriptUrls()` | `() => string[]` | Returns the ordered OMID/SHARC script URL list historically used by creative-markup injection. Available for inspection; not used by the 0.7.3 container-owned lifecycle. |

#### Feature gating

`getFeatureName()` and `getFeatureDescriptor()` both return `null` unless `omSdkServiceScriptUrl` AND `omSdkSessionClientUrl` are both configured. A bridge constructed with only one URL succeeds but contributes nothing to `supportedFeatures` and never loads OM SDK. Silently advertising a non-functional feature is worse than not advertising one; the bridge fails-quiet at construction and fails-loud only on missing-required-URL access paths.

Whether the OM SDK actually loaded at runtime is **not** reflected in feature advertising — even when the Service Script or Session Client 404s, the feature stays in `supportedFeatures`. Load-failure signaling is instead routed through the structured `feature_load_failed` `onSecurityEvent` variant (0.7.4+, issue [#125](https://github.com/jeffreycarlson/SHARC/issues/125)): when `_ensureSdkLoaded()` rejects, the bridge calls `container._emitFeatureLoadFailed(featureName, reason, scriptUrl)` and the failed extension goes inert without terminating the container. Operators monitoring `onSecurityEvent` get a non-terminating signal with the classified `details.reason` (the OmidCompatBridge script-tag loader emits `'timeout'`, `'network'`, or `'evaluation_throw'` — it cannot distinguish a 404 from other transport failures, so both classify as `'network'`) and the 500-char-bounded `details.scriptUrl`. See [`onSecurityEvent` surface](#onsecurityevent-surface) for the full variant shape.

#### Architectural constraints

OMID is **not** a renderer-loaded compatibility bridge:

- `bridges: ['omid']` throws synchronously at `SHARCContainer` construction. `KNOWN_BRIDGE_IDENTIFIERS` is `['mraid', 'safeframe']` only.
- AdCOM `APIFramework` code `7` (OMID 1.0) is intentionally excluded from `ADCOM_API_TO_BRIDGE`. Passing `creativeMeta: { apis: [7] }` never adds a renderer bridge. Starting in 0.7.6, operators may opt into bid-signaled measurement installation with `omidAutoInstall` plus `creativeMeta.measurement.omid.verificationScripts`; otherwise install `OmidCompatBridge` explicitly via `extensions: [new OmidCompatBridge(...)]`.

#### Tracked follow-ups

Open extension-contract and bridge-hardening follow-ups that affect or interact with `OmidCompatBridge`:

- [#123](https://github.com/jeffreycarlson/SHARC/issues/123) — extension contract documentation + creative `errorMessage` forwarding through extensions
- [#124](https://github.com/jeffreycarlson/SHARC/issues/124) — warn when multiple input signals collapse to the same renderer bridge
- [#126](https://github.com/jeffreycarlson/SHARC/issues/126) — termination-mid-load coverage for session-creation-promise edge case

Resolved in 0.7.4:

- [#125](https://github.com/jeffreycarlson/SHARC/issues/125) — clearer signaling when OMID is advertised but the OM SDK fails to load (now emits `feature_load_failed` on `onSecurityEvent`)

---

## 10. Renderer Protocol

**Variant:** Creative Markup (`creativeHtml` + `creativeRendererUrl`) — added in 0.7.0.
**Audience:** Operators implementing or auditing the renderer-side protocol.

The Renderer Protocol is a postMessage exchange between `SHARCContainer` (publisher page) and an operator-hosted renderer iframe, used to deliver `creativeHtml` to a cross-origin renderer that writes the markup into its own document via `document.open() / document.write() / document.close()`. Once the renderer reports `:rendered`, the standard SHARC `MessageChannel` handshake (section 3) takes over inside the renderer's `contentWindow`.

For the full architectural rationale (why Creative Markup needs a renderer, what threats the protocol defends against, how it composes with Privacy Sandbox / fenced frames), see [`docs/proposals/creative-sources.md`](proposals/creative-sources.md).

### Message envelope

Three protocol message types flow over `window.postMessage` between the renderer iframe and `window.parent`:

| Message | Direction | When |
|---|---|---|
| `SHARC:Renderer:render` | Container → Renderer | Once, after iframe `load` event |
| `SHARC:Renderer:rendered` | Renderer → Container | Once, after `DOMContentLoaded` on the inner document |
| `SHARC:Renderer:failed` | Renderer → Container | On any renderer-side validation or render failure |

#### `SHARC:Renderer:render` (container → renderer)

```typescript
{
  type: 'SHARC:Renderer:render',
  bridges: string[],              // 0.7.1+ — compat bridges renderer should load
  creativeHtml: string,           // Markup to write into the renderer document
  placementSessionId: string,     // Container's placementSessionId (UUID)
  sharcNonce: string,             // CSPRNG UUID — must match URL fragment
  sharcVersion: string,           // SHARC SDK version
  rendererProtocolVersion: '1',   // Bumps when the protocol breaks
  containerOrigin: string,        // Publisher-page origin (window.location.origin)
}
```

Posted with `targetOrigin = <construction-time creativeRendererUrl origin>` — never `'*'`.

<a id="bridges-and-creativemeta-0-7-1"></a>**`bridges` field (0.7.1+).** Array of compatibility-bridge identifiers the renderer should dynamically `import()` before `document.write(creativeHtml)`. Sorted, deduplicated. Empty array = "load no bridges." Reserved identifiers in 0.7.1: `'mraid'`, `'safeframe'`. Resolved at container construction via three-layer detection — explicit `bridges` constructor option → `creativeMeta.apis` AdCOM codes → adm content scan. The renderer filters the inbound list against its own `KNOWN_BRIDGES` allowlist; unknown identifiers (e.g. a future container shipping `'omid'` to a 0.7.1 renderer) are silently skipped via `customSecurityLog`, NOT loaded. Old containers omitting the field are treated identically to `bridges: []` (forward/backward compatible). See [`docs/design/0.7.1-bridges-field.md`](design/0.7.1-bridges-field.md) for the full design.

#### `SHARC:Renderer:rendered` (renderer → container)

```typescript
{
  type: 'SHARC:Renderer:rendered',
  placementSessionId: string,    // Echo of the container's placementSessionId
  rendererOrigin: string,        // window.location.origin AT THE TIME
                                 // OF REPLY — post-redirect canonical
}
```

The renderer-supplied `rendererOrigin` is the trust anchor for redirect detection. If it differs from the container's construction-time `_rendererOrigin`, the container terminates with `RENDERER_ORIGIN_MISMATCH (2116)`.

#### `SHARC:Renderer:failed` (renderer → container)

```typescript
{
  type: 'SHARC:Renderer:failed',
  placementSessionId: string,
  reason: string,                 // Human-readable failure reason
}
```

Reserved `reason` strings the reference renderer emits:

| `reason` | When |
|---|---|
| `service_worker_detected` | A Service Worker is registered or controlling the renderer origin |
| `container_origin_mismatch` | `event.origin` doesn't equal `event.data.containerOrigin` |
| `nonce_mismatch` | `event.data.sharcNonce` doesn't equal the URL-fragment nonce |
| `unsupported_renderer_protocol_version` | Container's `rendererProtocolVersion` is not supported by this renderer |
| `missing_placement_session_id` | `event.data.placementSessionId` is missing or non-string |
| `missing_creative_html` | `event.data.creativeHtml` is missing or non-string |
| `invalid_bridges_field` (0.7.1+) | `event.data.bridges` is present but not an array of strings |
| `bridge_load_failed` (0.7.1+) | Dynamic `import()` of a compatibility bridge module rejected (404, MIME mismatch, network failure, same-origin assertion failure, evaluation throw). Payload includes a `bridge` field with the failed identifier; container routes to the `bridge_load_failed` `onSecurityEvent` variant. |
| `document_write_failed: <message>` | `document.write` threw |

Operator forks may extend the vocabulary; the container surfaces the renderer-supplied `reason` raw on the structured event channel and sanitized in dev-channel logs.

### Container-side validation rules

Two distinct validation passes — envelope and payload-shape — with different failure semantics.

#### Envelope checks (silent ignore on mismatch)

The container ignores `:rendered` and `:failed` messages that fail any of these checks. Any frame on the page can `postMessage`; mismatches are noise, not protocol errors.

- `event.source === iframe.contentWindow`
- `event.origin === <construction-time rendererOrigin>`
- `event.data` is a non-null object
- `event.data.type` is a string
- `event.data.placementSessionId === this.placementSessionId`

#### Payload-shape checks (terminate with `RENDERER_PROTOCOL_ERROR` 2117)

Once envelope checks pass, the container validates payload shape. Failure terminates the container.

For `:rendered`:
- `data.rendererOrigin` is a non-empty string

For `:failed`:
- `data.reason` is a non-empty string

#### Origin echo (terminate with `RENDERER_ORIGIN_MISMATCH` 2116)

After payload shape passes, the container compares `data.rendererOrigin` against its construction-time `_rendererOrigin` (parsed from `creativeRendererUrl`). On mismatch:

- Container terminates with `RENDERER_ORIGIN_MISMATCH (2116)`
- Multi-line `console.error` names both expected and actual origins
- `onSecurityEvent` fires with `type: 'renderer_origin_mismatch'` and `details: { expectedOrigin, actualOrigin }` (RAW)

The order is shape → echo. A malformed payload that ALSO fails the echo comparison surfaces as `RENDERER_PROTOCOL_ERROR (2117)`, not `2116` — protocol-shape is the more accurate diagnosis for the operator.

### `close()` mid-render contract

If `container.close()` is called between iframe `load` and receipt of `:rendered`/`:failed`:

- The rendered/failed reply timeout is cancelled
- The renderer message listener is detached
- The iframe is removed from the DOM (terminating renderer script execution)
- The placement element is restored to its pre-`load()` state
- Late `:rendered` / `:failed` messages arriving after close are silently ignored (listener has been removed)

### Load-event navigation backstop (`RENDERER_UNAUTHORIZED_NAVIGATION` 2118)

The container attaches a `load` listener to the creative iframe at a variant-specific render anchor and terminates with `RENDERER_UNAUTHORIZED_NAVIGATION (2118)` on any subsequent `load` event — that means the iframe document navigated to a new URL outside the SHARC protocol path.

- **Creative Markup** (`details.variant === 'markup'`): the render anchor is the renderer's envelope-validated `:rendered` accept. Any iframe `load` after that point fires 2118.
- **Creative URL** (`details.variant === 'url'`): the render anchor is the first iframe `load` event itself (the URL flow has no `:rendered` accept). The second `load` and any after fire 2118.

`details.msSinceRender` carries the wall-clock delay from the variant's render anchor to the firing `load` — operators distinguish fast-fire (meta refresh / first-script-tag `window.location` redirects) from slow-fire (DOM-injected redirects, setTimeout-based redirects).

This is browser-observable and cannot be bypassed by JS-level overrides — the load event fires regardless of what the creative HTML did. It does NOT *prevent* the navigation (the browser already started it), but it ensures:

1. The operator's monitoring sees the unauthorized navigation immediately
2. The SHARC session terminates cleanly rather than continuing in a broken state
3. The user gesture that triggered the navigation is recorded as a SHARC event for fraud / abuse detection

The backstop fires through the same chokepoint (`onSecurityEvent` → console.error → `onError` → terminate) as the other renderer-protocol terminating events.

### `onSecurityEvent` surface

All renderer-protocol terminating events fire `onSecurityEvent` BEFORE `onError`. The callback receives a `SHARCSecurityEvent` with the following fixed fields across every variant, plus a per-variant `details` payload:

```typescript
type SHARCSecurityEvent = {
  type: 'wrapper_top_frame_inaccessible' | 'renderer_origin_mismatch'
      | 'renderer_protocol_error' | 'renderer_failed'
      | 'bridge_load_failed' | 'unauthorized_navigation'
      | 'feature_load_failed' | 'unauthorized_protocol';
  severity: 'warning' | 'error';
  errorCode?: number;          // present on terminating variants only
  timestamp: number;           // Date.now() at emit
  placementSessionId: string;  // owning container's UUID
  message: string;             // human-readable, also written to console
  details: object;             // discriminated by `type` — see table below
};
```

`severity` is the discriminator between non-terminating warnings (`'warning'` — currently only the wrapper-cross-origin carve-out) and terminating errors (`'error'` — every other variant). Operator dashboards typically alert on `severity === 'error'` and log-only on `'warning'`. Note that `feature_load_failed` and `unauthorized_protocol` carry `severity: 'error'` despite being non-terminating — see each variant's row below for the distinction.

The eight reserved `type` values and their `details` schemas:

| `type` | `severity` | `errorCode` | `details` |
|---|---|---|---|
| `wrapper_top_frame_inaccessible` | `'warning'` (or `'error'` when `wrapperPolicy: 'block'`) | — | `{ wrapperOrigin, creativeRendererUrl }` |
| `renderer_origin_mismatch` | `'error'` | `2116` | `{ expectedOrigin, actualOrigin }` |
| `renderer_protocol_error` | `'error'` | `2114` \| `2117` \| `2119` \| `2120` | `{ subtype: 'timeout' \| 'malformed_payload' \| 'post_failed' \| 'integrity_failed', reason }` |
| `renderer_failed` | `'error'` | `2115` | `{ reason }` |
| `bridge_load_failed` (0.7.1+) | `'error'` | `2115` | `{ reason, bridge, url }` — `bridge` is the failed identifier (`'mraid'`, `'safeframe'`, …), bounded to 200 chars; `url` is the resolved bridge-module URL (or substituted-but-unparseable template string on the unparseable-URL path), bounded to 500 chars, `''` when unavailable; `reason` is the literal `'bridge_load_failed'` for parity with `renderer_failed`. |
| `unauthorized_navigation` | `'error'` | `2118` | `{ variant: 'markup' \| 'url', msSinceRender: number }` |
| `feature_load_failed` (0.7.4+) | `'error'` | — (non-terminating; no code) | `{ featureName, reason, scriptUrl }` — `featureName` is the canonical `supportedFeatures` entry whose load failed (e.g. `'com.iabtechlab.sharc.omid'`); `reason` is a classified token — current in-tree bridges emit `'timeout'`, `'network'`, or `'evaluation_throw'` (script-tag loaders cannot distinguish a 404 from other transport failures; future fetch-based loaders may emit additional tokens like `'http_404'`); `scriptUrl` is the URL that failed to load, bounded to 500 chars (parity with `bridge_load_failed.details.url`). |
| `unauthorized_protocol` (0.7.7+) | `'error'` | — (non-terminating; no code) | `{ type, phase, reason }` — payload is **deliberately minimized** to three enumerated, attacker-uncontrolled fields. `type` is a registered prefix (e.g. `'SHARC:Renderer:'`) or the literal `'unknown-prefix'` for prefix-unregistered envelopes. `phase` is one of the six router-tracked lifecycle phases: `'init' \| 'attaching-renderer' \| 'rendered' \| 'omid-active' \| 'creative-active' \| 'terminated'`. `reason` discriminates which router gate-step failed: `'out-of-phase' \| 'nonce-mismatch' \| 'prefix-unregistered'`. No attacker-controlled string (envelope payload, raw `event.data.type`, etc.) is included. Fires when an inbound envelope passes every trust-anchor check (source, origin, registered prefix, placementSessionId, protocol nonce, declared type) but arrives in a lifecycle phase outside the type's declared `phases` set. Defends against cross-protocol envelope-type impersonation by iframe-side extensions. Per [`docs/design/0.7.7-cross-frame-protocol-router.md`](design/0.7.7-cross-frame-protocol-router.md) § 8. |

Note: timeout (`2114`), post-failed (`2119`), and integrity-failed (`2120`) all surface as `renderer_protocol_error` on the structured channel — the spec vocabulary does not include them as distinct event types. The `details.subtype` discriminates inside the variant.

`bridge_load_failed` shares error code `2115` with `renderer_failed` but gets its own structured-event variant so operators on `onSecurityEvent` see bridge import failures (404, MIME mismatch, network failure, same-origin assertion failure, evaluation throw) distinct from creative-side render failures. Routed from the renderer's `:failed` reply when `reason === 'bridge_load_failed'`. Added 0.7.1 (issue #82) per [`docs/design/0.7.1-bridges-field.md`](design/0.7.1-bridges-field.md) § 4 Security Engineer guardrail #5.

`feature_load_failed` is the sibling of `bridge_load_failed` for the publisher-page extension-load path. Where `bridge_load_failed` covers the renderer's dynamic `import()` of a compatibility bridge module *inside the iframe*, `feature_load_failed` covers an extension (e.g. `OmidCompatBridge`) whose load-time asset failed to load *on the publisher page*. **Non-terminating** — the container keeps running and the failed extension goes inert, leaving the operator to observe the signal on `onSecurityEvent`. No `errorCode` field — extensions are not in the 21xx renderer-error-code namespace, and there is no fatal-error tail. The variant is generalizable beyond OMID; `OmidCompatBridge` is the first in-tree consumer (routes from `_ensureSdkLoaded` rejection). Added 0.7.4 (issue #125) per [`docs/design/0.7.4-omid-hardening.md`](design/0.7.4-omid-hardening.md) § 2.2.

#### `renderer_protocol_error` `details.reason` vocabulary

The `details.reason` field on `renderer_protocol_error` events is a fixed vocabulary, except that `post_failed` carries the raw exception message. Operators building monitoring dashboards can pre-allocate buckets against this table:

| `details.subtype` | `details.reason` | `errorCode` | When |
|---|---|---|---|
| `timeout` | `iframe_load` | `2114` | Renderer iframe `load` event did not fire within `timeouts.rendererLoad` (default 5s) |
| `timeout` | `rendered_reply` | `2114` | Renderer `:rendered` / `:failed` reply did not arrive within `timeouts.rendererReply` (default 2s) |
| `malformed_payload` | `rendered_missing_renderer_origin` | `2117` | `:rendered` envelope-valid but `data.rendererOrigin` missing, non-string, or empty |
| `malformed_payload` | `failed_missing_reason` | `2117` | `:failed` envelope-valid but `data.reason` missing, non-string, or empty |
| `post_failed` | (raw `postErr.message`) | `2119` | `iframe.contentWindow.postMessage` threw synchronously (e.g. `DataCloneError`, null `contentWindow`); carries the underlying error message verbatim |
| `integrity_failed` | verification failure reason | `2120` | `creativeRendererIntegrity` preflight failed before assigning `iframe.src`; no `SHARC:Renderer:render` message was sent |

The `post_failed` row's `reason` is arbitrary — it carries whatever string the underlying postMessage exception produced. Operators monitoring this bucket should match on `subtype === 'post_failed'` rather than the `reason` value.

`details` payloads are RAW — operators consuming the structured channel get fidelity. Console output is sanitized via `_sanitizeForLog` (C0/DEL strip + 200-codeunit truncate). See `docs/proposals/creative-sources.md` § Security Model for the full threat model.

#### Renderer post-validation behavior (security-relevant)

After the reference renderer (`examples/renderer/index.html`) accepts a `:render` envelope (parent-source, container-origin echo, fragment-nonce, version all pass), it clears `location.hash` via `history.replaceState(null, '', location.pathname + location.search)` BEFORE `document.write(creativeHtml)`.

This is intentional defense-in-depth — the fragment nonce was the trust anchor for envelope validation, and the creative HTML is about to execute in this same window. Without the hash clear, the creative could read `window.location.hash` and exfiltrate the consumed nonce. The nonce is single-use per iframe load (no replay value), but minimizing exposure is cheap.

Operators forking the reference renderer SHOULD preserve the `history.replaceState` call. Removing it (e.g. mistaking it for a debug artifact) silently weakens the trust boundary between renderer and creative.

#### Navigation Bridge Error Contract

The navigation bridge (`src/sharc-navigation-bridge.js`) intercepts `<a>` clicks, form submits, `window.open`, and `location.* / location.href = …` and routes them through `SHARC.requestNavigation()`. When the SHARC SDK is not loaded on the page (renderer misconfigured, SDK script tag missing or broken), the bridge fails loud to the creative by throwing `SHARCNavigationError`:

```typescript
class SHARCNavigationError extends Error {
  name: 'SHARCNavigationError';
  // currently `'SDK_UNAVAILABLE'`; new codes added in minor versions and
  // listed in CHANGELOG. Operators should `instanceof SHARCNavigationError`-
  // check rather than match on `code` for forward compatibility.
  code: string;
  message: string;
}
```

Exported from `dist/sharc-navigation-bridge.mjs` (canonical source). Also re-exported from `dist/sharc-creative.mjs` for ESM consumers loading only the SDK — `instanceof SHARCNavigationError` checks work across both import paths because module caching guarantees the same class identity. Also exposed on `window.SHARCNavigationError` for non-module creatives.

Throw matrix:

| Interception point | SDK present | SDK absent |
|---|---|---|
| `<a>` click | `event.preventDefault()`, request routed | `event.preventDefault()`, then **throw** `SHARCNavigationError({ code: 'SDK_UNAVAILABLE' })` |
| `<form>` submit | `event.preventDefault()`, request routed | `event.preventDefault()`, then **throw** |
| `location.assign(url)` | request routed | **throw** (matches browser-native CSP-block `SecurityError` semantics) |
| `location.replace(url)` | request routed | **throw** |
| `location.href = url` | request routed | **throw** from setter |
| `window.open(url)` | request routed; returns `null` | **returns `null` + `console.error`** (NOT throw — IAB popup-blocker pattern; defensive creatives use `var w = window.open(); if (w) { ... }` to detect popup blockers, and a synchronous throw would break that idiom) |

Container-side URL-safety rejection (SEC-003 — invalid scheme, malformed URL) still resolves through the SDK's `requestNavigation` Promise reject path; the throw is reserved for the SDK-missing operator-misconfiguration case. `onNavigation` itself is observation-only in 0.7.x and does not gate navigation today.

The bridge calls `event.preventDefault()` to block the native navigation but does NOT call `event.stopPropagation()`. Creative-installed click / submit handlers (analytics, validation, custom UI) still run normally through the bubble phase.

Defensive creatives that want to catch the throw must wrap the navigation-attempting code (the listener body) — wrapping `addEventListener` itself catches nothing because the throw fires when the click event is dispatched, not when the listener is registered. The recommended pattern is `window.addEventListener('error', ...)`:

```javascript
// Renderer-side operator monitoring (NOT publisher-side; see callout below).
// Captures uncaught SHARCNavigationError from anchor / form / location.*
// listeners — these throws don't propagate out of `a.click()` or
// `form.dispatchEvent(submit)`, but the WHATWG DOM "report the exception"
// algorithm fires the `error` event synchronously during dispatch.
window.addEventListener('error', (e) => {
  if (e.error instanceof SHARCNavigationError
      && e.error.code === 'SDK_UNAVAILABLE') {
    // surface a "try again" UI / fall back to own analytics / alert ops
    e.preventDefault(); // optional — suppresses the default error log
  }
});
```

##### Operator monitoring (renderer-side, not publisher-side)

The `SHARCNavigationError` throws fire INSIDE the renderer iframe (operator's fork origin), NOT the publisher window. Cross-origin error scrubbing means:

- The publisher's `window.onerror` / `window.addEventListener('error', ...)` will see `"Script error."` with no diagnostic detail (filename, line number, stack are all redacted).
- The container's `onSecurityEvent` channel does NOT carry SDK-missing throws — that channel is container-emitted; the bridge is renderer-side and the container is unaware of bridge-internal failures.

**Operators who want SDK-missing alerts MUST install `window.addEventListener('error', ...)` on the renderer page itself** (in their fork of `examples/renderer/index.html` or equivalent) and ship those events to their own logging / observability stack. Publisher-side monitoring will not see them.

### Reference renderer

The canonical operator-fork starting point is `examples/renderer/index.html`. The SHARC project hosts a reference deployment at:

- `https://jeffreycarlson.github.io/SHARC/renderer/` — test/dev only

Operators evaluating the SDK can point `creativeRendererUrl` at this hosted URL from a local dev environment without standing up a renderer host. **The hosted URL must NOT be used in production.** The container's `KNOWN_TEST_RENDERERS` guard (added in 0.7.0 / Phase F, issue #55) refuses to load the URL from non-dev origins and throws synchronously at construction with a diagnostic naming the URL and listing the recognized dev-origin patterns. Production deployments must use an operator-controlled renderer URL.

Recognized dev origins (anchored regex patterns, no suffix-spoofing):

- `http://localhost` (any port)
- `https://localhost` (any port)
- `http://127.0.0.1` (any port)
- `https://127.0.0.1` (any port)
- `http(s)://<subdomain>.localhost` (any port)
- `http(s)://<subdomain>.test` (any port)
- `http(s)://<subdomain>.local` (any port)
- `http(s)://[::1]` (IPv6 loopback, any port)
- `http(s)://0.0.0.0` (any port)

Operators MUST also configure their hosting infrastructure to:

- Serve the page with `Content-Security-Policy: object-src 'none'; base-uri 'none'` (HTTP-response CSP — the iframe `csp` attribute is Chromium-only)
- Serve with `Cross-Origin-Resource-Policy: same-origin`
- NOT register a Service Worker on the renderer origin (the reference renderer's runtime check posts `:failed` with `service_worker_detected` if one is found, but operators should not rely on the runtime check alone)
- Choose a storage-isolation strategy (Strategy A: `Clear-Site-Data` header / Strategy B: JS-side clearing / Strategy C: per-tenant origins) — see `docs/proposals/creative-sources.md` § Renderer implementation contract
- Serve `.mjs` files with `Content-Type: application/javascript` (or `text/javascript`). Browsers reject ES modules served as `application/octet-stream`, which is the default MIME for unknown extensions on most CDN / static-host configurations. The reference dev server (`server.cjs`) handles this; operators using nginx, CloudFront, Cloudflare, or any other static origin must configure the `.mjs → application/javascript` MIME mapping explicitly. Without this, the renderer's navigation-bridge module import fails silently and the bridge does not install (the container-side load-event backstop still fires, but creative-side click auditing is lost).

The navigation bridge (`src/sharc-navigation-bridge.js`) is a separate import the renderer page MAY install BEFORE `document.write(creativeHtml)` to route creative-initiated navigation (`window.open`, anchor clicks, form submits, location setters) through `SHARC.requestNavigation()` so the publisher's `onNavigation` observation hook sees every click. The bridge is best-effort; the load-event backstop is the defense-in-depth catch.

For the **Creative URL** variant, the SHARC Creative SDK (`dist/sharc-creative.mjs`) auto-installs the bridge at SDK init when `window.__sharcRenderer` is absent — no operator action required. Variant detection: the reference renderer sets `window.__sharcRenderer` BEFORE `document.write` runs, so the SDK skips its own auto-install in Markup flow (the renderer already installed). In URL flow the marker is absent, so the SDK installs the bridge unconditionally. See [Navigation Bridge Error Contract](#navigation-bridge-error-contract) for the export semantics across both import paths.

### Error codes

See section 11 below — codes `2114`–`2119` cover the renderer protocol surface.

---

## 11. Error Codes

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
| 2114 | Renderer timeout | Renderer iframe `load` event did not fire within `timeouts.rendererLoad` (default 5s), OR renderer `:rendered`/`:failed` reply did not arrive within `timeouts.rendererReply` (default 2s). Markup variant only. See [Renderer Protocol](#10-renderer-protocol). |
| 2115 | Renderer failed | Renderer reported failure via `SHARC:Renderer:failed` with a non-empty `reason` string. The `reason` is included in the `onError` message (sanitized + truncated to 200 UTF-16 code units). Markup variant only. See [Renderer Protocol](#10-renderer-protocol). **Code 2115 (`RENDERER_FAILED`) is shared between two `onSecurityEvent.type` variants:** `renderer_failed` (generic renderer-side failure with operator-supplied reason) and `bridge_load_failed` (specifically a bridge-module load failure — 0.7.1+, issue #82). The `onError` callback receives the same code for both; the structured event distinguishes them via the `type` field. **Triage by inspecting `event.type`** on `onSecurityEvent`; see [`onSecurityEvent` surface](#onsecurityevent-surface) for the discriminated-union shape. |
| 2116 | Renderer origin mismatch | The renderer's reported `rendererOrigin` did not match the construction-time-derived `_rendererOrigin` (parsed from `creativeRendererUrl`). Indicates a redirect collapsed the cross-origin sandbox guarantee. Configure `creativeRendererUrl` to the post-redirect canonical URL. Markup variant only. See [Renderer Protocol](#10-renderer-protocol). |
| 2117 | Renderer protocol error | Renderer message had an envelope-valid type (`SHARC:Renderer:rendered` or `SHARC:Renderer:failed`) but malformed payload — `rendererOrigin` (rendered) or `reason` (failed) is missing, not a string, or empty. Markup variant only. See [Renderer Protocol](#10-renderer-protocol). |
| 2118 | Renderer unauthorized navigation | The container attaches a `load` listener after the variant-specific render anchor (Markup: envelope-validated `:rendered`; URL: initial iframe `load`); a subsequent `load` event means the iframe document navigated outside the SHARC protocol path. Defense-in-depth backstop for click-throughs that bypass the navigation bridge. Both variants. `details.variant` discriminates `'markup' \| 'url'`. See [Renderer Protocol](#10-renderer-protocol). |
| 2119 | Renderer post failed | `iframe.contentWindow.postMessage(SHARC:Renderer:render, ...)` threw synchronously (e.g. `DataCloneError`, null `contentWindow`). Distinct from 2114 (timeout) — a transport-layer send failure is not a latency failure. Markup variant only. See [Renderer Protocol](#10-renderer-protocol). |
| 2120 | Renderer integrity failed | Optional `creativeRendererIntegrity` preflight failed before the renderer iframe was loaded. The container did not assign `iframe.src` and did not send `SHARC:Renderer:render`. Markup variant only. |

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
| `SHARC:Creative:requestPlacementChange` | resolve or reject | On resize/expand/collapse |
| `SHARC:Creative:requestClose` | resolve or reject | When creative wants to close |
| `SHARC:Creative:getFeatures` | resolve | Any time after init |
| `SHARC:Creative:request[FeatureName]` | resolve or reject | When using an extension |
