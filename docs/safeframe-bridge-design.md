# SHARC SafeFrame 1.1 Compatibility Bridge — Architecture Design

**Document:** `safeframe-bridge-design.md`  
**Status:** Ready for Review  
**Author:** Architecture, SHARC Working Group  
**Reviewer:** Jeffrey Carlson, VP Product, IAB Tech Lab  
**Last Updated:** 2026-04-04  
**Target file:** `src/sharc-safeframe-bridge.js`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [State Mapping](#2-state-mapping)
3. [API Mapping](#3-api-mapping)
4. [Bootstrap Sequence](#4-bootstrap-sequence)
5. [$sf Namespace Structure](#5-sf-namespace-structure)
6. [Key Design Decisions](#6-key-design-decisions)
7. [Deferred to v2](#7-deferred-to-v2)
8. [Implementation Notes for the Developer](#8-implementation-notes-for-the-developer)

---

## 1. Architecture Overview

### What the Bridge Does

The SafeFrame bridge is a one-way compatibility shim. It makes old SafeFrame 1.1 creatives run unmodified inside a SHARC container. The creative never knows it is not talking to a native SafeFrame host.

The direction of translation is exclusively:

```
SafeFrame creative ($sf.ext) → SHARC container
```

There is no SHARC-to-SafeFrame direction. This is a migration tool, not a bidirectional adapter. The `$sf.host` namespace — the publisher-side SafeFrame API — is completely replaced by the real SHARC container. Only the creative-side `$sf.ext` namespace is bridged.

### Where the Bridge Lives

The bridge is a **container-side extension** — a JavaScript module loaded by the SHARC container environment, not by the creative. From the creative's perspective, `$sf.ext` is simply available as a global, exactly as SafeFrame specifies.

```
┌─────────────────────────────────────────────────────────────────────┐
│  SHARC Container (publisher environment)                            │
│                                                                     │
│  ┌──────────────────────────────────────────┐                      │
│  │  sharc-container.js  +  SHARCContainer                         │
│  └────────────────┬─────────────────────────┘                      │
│                   │  SHARC MessageChannel                           │
│  ┌────────────────▼─────────────────────────┐                      │
│  │  iframe (sandboxed)                      │                      │
│  │                                          │                      │
│  │  <script> sharc-protocol.js </script>    │                      │
│  │  <script> sharc-creative.js </script>    │                      │
│  │  <script> sharc-safeframe-bridge.js </script>                   │
│  │  ← injected BEFORE creative code runs   │                      │
│  │                                          │                      │
│  │  ┌──────────────────────────────────┐    │                      │
│  │  │  sharc-safeframe-bridge.js       │    │                      │
│  │  │  (the shim that IS $sf.ext)      │    │                      │
│  │  │                                  │    │                      │
│  │  │  • Exposes window.$sf.ext        │    │                      │
│  │  │  • Backs it with SHARC SDK       │    │                      │
│  │  │  • Translates calls & events     │    │                      │
│  │  └────────────────┬─────────────────┘    │                      │
│  │                   │  SHARC.on/request/…  │                      │
│  │  ┌────────────────▼─────────────────┐    │                      │
│  │  │  sharc-creative.js (SHARC SDK)   │    │                      │
│  │  └──────────────────────────────────┘    │                      │
│  │                                          │                      │
│  │  Ad creative code (unchanged)            │                      │
│  │  $sf.ext.register() / $sf.ext.expand()   │                      │
│  └──────────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
```

### File Roles

| File | Owner | Role |
|------|-------|------|
| `sharc-creative.js` | Creative iframe | Handles SHARC protocol; provides `window.SHARC` |
| `sharc-safeframe-bridge.js` | Creative iframe | Loaded after `sharc-creative.js`; hooks into `window.SHARC`; populates `window.$sf.ext` |
| `sharc-container.js` | Publisher page | Injects both scripts into iframe before creative code runs |
| `SafeFrameCompatBridge` class | Container plugin | Extension object that signals the container to inject bridge scripts |

### Injection Mechanism

The container uses the `SafeFrameCompatBridge` extension class:

```javascript
import { SHARCContainer } from './sharc-container.js';
import { SafeFrameCompatBridge } from './sharc-safeframe-bridge.js';

const container = new SHARCContainer({
  containerEl: document.getElementById('ad-slot'),
  creativeUrl: 'https://safeframe-ad.example.com/ad.html',
  environmentData: { ... },
  extensions: [new SafeFrameCompatBridge()]
});
```

Internally, `SafeFrameCompatBridge` registers with the container as an extension that:

1. Prepends `sharc-protocol.js`, `sharc-creative.js`, and `sharc-safeframe-bridge.js` into the iframe document before the creative URL loads
2. Passes SafeFrame metadata (from the container's `environmentData`) into the init payload for use by `$sf.ext.meta()`
3. Advertises the `com.iabtechlab.sharc.safeframe` extension feature in `Container:init`

**Injection implementation:** The container serves a same-origin wrapper page that loads the three scripts in order, then loads the creative URL. This matches the MRAID bridge pattern and avoids the complexity of `srcdoc` manipulation.

```
/sharc/safeframe-wrapper.html?creative=https%3A%2F%2Fad.example.com%2Fad.html
```

The wrapper HTML:
```html
<!doctype html>
<html>
<head>
  <script src="/sharc/sharc-protocol.js"></script>
  <script src="/sharc/sharc-creative.js"></script>
  <script src="/sharc/sharc-safeframe-bridge.js"></script>
</head>
<body>
  <script>
    const params = new URLSearchParams(location.search);
    const creativeUrl = params.get('creative');
    if (creativeUrl) {
      const script = document.createElement('script');
      script.src = creativeUrl;
      document.body.appendChild(script);
    }
  </script>
</body>
</html>
```

For inline SafeFrame creative markup (not a URL), the container can use `srcdoc` with the three scripts prepended directly.

### Single Responsibility

`sharc-safeframe-bridge.js` has exactly one job: **expose a spec-compliant `window.$sf.ext` object backed by the SHARC SDK.** It does not talk to the container directly over `MessageChannel`. All protocol communication goes through `window.SHARC` (the `sharc-creative.js` SDK). The bridge is a pure adapter layer above the SDK.

This means the bridge has no knowledge of `sessionId`, `messageId`, or the MessageChannel transport. It is portable to any SHARC SDK implementation.

---

## 2. State Mapping

### Decision: SafeFrame Has 4 Status Strings; SHARC Has Richer Granularity

SafeFrame 1.1 status strings: `expanded`, `expanding`, `collapsed`, `collapsing`

SHARC creative-visible states: `ready`, `active`, `passive`, `hidden`, `frozen`

The key architectural difference: **SHARC decouples lifecycle from placement.** In SafeFrame, `expanded` and `collapsed` describe the visual size of the container. In SHARC, the state machine only tracks visibility and focus — placement is tracked separately via `requestPlacementChange`. The bridge must maintain its own placement tracking to reconstruct SafeFrame's status strings.

SafeFrame's `$sf.ext.status()` is a placement state, not a lifecycle state. It does not map to SHARC's state machine one-to-one. The bridge tracks `_placementMode` internally.

### SafeFrame Status String Mapping

| SafeFrame `$sf.ext.status()` | Bridge Condition | Notes |
|---|---|---|
| `collapsed` | Initial state; after `collapse()` resolves; after `register()` before any expand | The resting/default placement mode |
| `expanding` | Immediately after `expand()` is called, before SHARC resolves | Transient; bridge sets this while SHARC `requestPlacementChange` is in flight |
| `expanded` | After SHARC `requestPlacementChange({ intent: 'maximize' or 'resize' })` resolves | Bridge sets `_placementMode = 'expanded'` |
| `collapsing` | Immediately after `collapse()` is called, before SHARC resolves | Transient; bridge sets this while SHARC `requestPlacementChange({ intent: 'restore' })` is in flight |

### SHARC State → SafeFrame Callback Event Mapping

SafeFrame creatives receive events via the callback registered in `$sf.ext.register()`. The bridge maps incoming SHARC events to SafeFrame event strings:

| SHARC Event | SHARC State/Condition | SafeFrame Callback `status` param | Notes |
|---|---|---|---|
| `stateChange` | `active` | `'geom-update'` | Visibility/focus changed; geometry data updated |
| `stateChange` | `passive` | `'geom-update'` | Focus lost; geometry still valid |
| `stateChange` | `hidden` | `'geom-update'` | Creative hidden; inViewPercentage becomes 0 |
| `stateChange` | `frozen` | *(no callback)* | JS suspended; callback cannot fire |
| `placementChange` (resolve of expand) | — | `'expanded'` | Bridge fires after SHARC resolves expand |
| `placementChange` (resolve of collapse) | — | `'collapsed'` | Bridge fires after SHARC resolves collapse |
| SHARC reject of placement change | — | `'failed'` | Container refused expand or collapse |
| `stateChange` → `active` (first time) | — | `'geom-update'` | Creative became viewable; triggers initial geom delivery |
| SHARC focus event | `active` | `'focus-change'` | Window gained focus |
| SHARC blur event | `passive` | `'focus-change'` | Window lost focus |

### `$sf.ext.status()` Logic

```
getStatus() logic:
  if _placementMode is 'expanding'   → return 'expanding'
  if _placementMode is 'expanded'    → return 'expanded'
  if _placementMode is 'collapsing'  → return 'collapsing'
  else                                → return 'collapsed'
```

Unlike MRAID, SafeFrame has no concept of `loading` or `hidden` as status strings. `$sf.ext.status()` always returns one of the four placement-mode strings. Lifecycle state (visible/hidden) is expressed indirectly through the callback's geometry data.

### Viewability Mapping

`$sf.ext.inViewPercentage()` returns 0–100. The bridge derives this from SHARC geometry and state:

| SHARC State | `inViewPercentage()` | Reasoning |
|---|---|---|
| `active` | Derived from `SHARC.getGeometry()` intersection ratio × 100 | Visible and focused |
| `passive` | Derived from geometry (intersection may be partial) | Visible but unfocused; use geometry |
| `hidden` | `0` | Not visible |
| `frozen` | `0` (cached from last known state) | JS was suspended; last value is stale |
| `ready` | `0` | Not yet started |

When geometry data is unavailable (pre-init), `inViewPercentage()` returns `0`.

---

## 3. API Mapping

### Method Mapping Table

| `$sf.ext` Method | Status | SHARC Translation | Notes |
|---|---|---|---|
| `$sf.ext.register(w, h, cb)` | ✅ Supported | `SHARC.onReady()` + store width/height + register callback | See §6.1 |
| `$sf.ext.supports()` | ✅ Supported | Returns feature flags object derived from `SHARC.hasFeature()` | See §6.5 |
| `$sf.ext.geom()` | ✅ Supported | Derived from cached geometry + SHARC env | See §6.3 |
| `$sf.ext.expand(obj)` | ✅ Supported | `SHARC.requestPlacementChange(...)` with intent derived from `push` flag | See §6.2 |
| `$sf.ext.collapse()` | ✅ Supported | `SHARC.requestPlacementChange({ intent: 'restore' })` | Fires `'collapsed'` callback on resolve |
| `$sf.ext.status()` | ✅ Supported | Derived from `_placementMode` | See §2 |
| `$sf.ext.meta(propName, ownerKey)` | ✅ Supported | Reads from `_sfMeta` cached at init from SHARC `environmentData` | See §6.4 |
| `$sf.ext.cookie(name, data)` | ❌ Excluded | Fires `'failed'` callback; no SHARC equivalent | See §6.6 |
| `$sf.ext.inViewPercentage()` | ✅ Supported | Derived from SHARC geometry + state | See §2 Viewability Mapping |
| `$sf.ext.winHasFocus()` | ✅ Supported | Derived from `_sharcState === 'active'` | See §6.7 |

### Callback Event Mapping Table

SafeFrame creatives register a single callback via `$sf.ext.register(w, h, cb)`. The callback signature is:

```javascript
cb(status, data)
// status: string — 'expanded'|'collapsed'|'failed'|'geom-update'|'focus-change'
// data:   object — depends on status; often null/undefined
```

| SafeFrame Callback `status` | Bridge Trigger | `data` payload |
|---|---|---|
| `'expanded'` | SHARC `requestPlacementChange` resolves with expand | `{ info: { w, h, push } }` |
| `'collapsed'` | SHARC `requestPlacementChange({ intent: 'restore' })` resolves | `null` |
| `'failed'` | SHARC rejects a placement change or `$sf.ext.cookie()` is called | `{ reason: 'expand-rejected' \| 'collapse-rejected' \| 'cookie-not-supported' }` |
| `'geom-update'` | SHARC `stateChange` fires (any state transition affecting geometry) | Geometry object — see §5 |
| `'focus-change'` | SHARC `stateChange` flips between `active` and `passive` | `{ focus: true \| false }` |

### Feature Flag Mapping (`$sf.ext.supports()`)

`$sf.ext.supports()` returns an object (not a function call with a string argument — SafeFrame's API differs from MRAID here). The returned object has boolean properties for each feature flag:

| SafeFrame Feature Flag | `supports()` value | How Determined |
|---|---|---|
| `'exp-ovr'` | `true` | Overlay expand always supported via `SHARC.requestPlacementChange({ intent: 'maximize' })` |
| `'exp-push'` | `false` | Push expand deferred to v2 — see §7.1 |
| `'read-cookie'` | `false` | No SHARC equivalent; hardcoded false |
| `'write-cookie'` | `false` | No SHARC equivalent; hardcoded false |

**Decision:** `exp-ovr` is always `true` because overlay expand maps cleanly to `maximize`. `exp-push` requires the host to reflow page content — there is no SHARC mechanism for this in v1. Cookie access has no SHARC equivalent and is intentionally excluded. `supports()` never throws — it always returns the complete object.

---

## 4. Bootstrap Sequence

### The Core Challenge

SafeFrame's bootstrap contract is: **`$sf.ext` must be available synchronously by the time the creative's first `<script>` runs.** The creative calls `$sf.ext.register()` synchronously on load. The SHARC SDK, however, boots asynchronously — it sends `createSession`, then waits for `Container:init` before environment data is known.

The bridge must reconcile these: `window.$sf.ext` must exist synchronously, but the creative's registered callback can only fire after SHARC's async init completes.

Unlike MRAID's `ready` event, SafeFrame has no explicit "ready" event. The creative's callback is registered via `$sf.ext.register()` and the first callback delivery (a `'geom-update'` event) is the signal that the host is ready.

### Injection Order

The container ensures the following script execution order before any creative code runs:

```html
<!-- Injected by SafeFrameCompatBridge, before creative markup -->
<script src="/sharc/sharc-protocol.js"></script>
<script src="/sharc/sharc-creative.js"></script>
<script src="/sharc/sharc-safeframe-bridge.js"></script>
<!-- Creative code starts loading here -->
```

### What Happens on Script Load

`sharc-safeframe-bridge.js` runs synchronously when loaded. It:

1. **Creates `window.$sf`** — the top-level SafeFrame namespace with `$sf.ext` populated
2. **Creates `window.$sf.ext`** — a complete synchronous object with all `$sf.ext` API methods
3. **Sets `_placementMode`** to `'collapsed'` (SafeFrame default)
4. **Registers with `SHARC.onReady()`** — fires when `Container:init` arrives
5. **Registers with `SHARC.onStart()`** — fires when `Container:startCreative` arrives
6. **Subscribes to SHARC events** — `stateChange`, `placementChange`, `close`

```
sharc-safeframe-bridge.js loads (synchronous):
   window.$sf = {}
   window.$sf.ext = { ... }    ← available immediately
   _placementMode = 'collapsed'
   SHARC.onReady(bridgeReadyFn) ← hooks into SHARC lifecycle
   SHARC.onStart(bridgeStartFn) ← hooks into SHARC lifecycle
   SHARC.on('stateChange', ...) ← subscribes to container state changes
   SHARC.on('close', ...)       ← for cleanup

creative code runs:
   $sf.ext.register(300, 250, myCallback)  ← stores w, h, cb; does NOT fire cb yet

SHARC async handshake (background, started by sharc-creative.js):
   createSession ──────────────────────────►
   ◄───────────── resolve
   Container:init ─────────────────────────►
   ◄───────────── bridgeReadyFn runs:
        → cache _env, _sfMeta from environmentData
        → _sharcState = 'ready'
        → _sfReady = true
        (no immediate callback — wait for startCreative)

   Container:startCreative ────────────────►
   ◄───────────── bridgeStartFn runs:
        → resolve immediately

   Container:stateChange(active) ──────────►
        → _sharcState = 'active'
        → _inViewPct = compute from geometry
        → fire callback('geom-update', geomObj)
                              ←─────────────── ad creative receives first event
```

### The `register()` Call Before `onReady`

SafeFrame creatives call `$sf.ext.register(w, h, cb)` synchronously on script load — before SHARC init has completed. The bridge stores `w`, `h`, and `cb` immediately. The callback is NOT fired during `register()`. This is correct SafeFrame behavior: `register()` is a declaration, not an event.

The first callback delivery happens when the container becomes `active` (first `stateChange` to `active`), delivering a `'geom-update'` event. This mirrors native SafeFrame host behavior where the first notification arrives after the host completes initialization.

### Full Sequence Diagram

```
Container                    Creative iframe                 Ad creative code
    │                              │                               │
    │  inject scripts ────────────►│                               │
    │                              │  sharc-protocol.js loads      │
    │                              │  sharc-creative.js loads      │
    │                              │    window.SHARC created       │
    │                              │  sharc-safeframe-bridge.js    │
    │                              │    window.$sf.ext created     │
    │                              │    _placementMode='collapsed' │
    │                              │                               │
    │                              │◄──── creative ad.js loads ───│
    │                              │◄── $sf.ext.register(w,h,cb) ─│
    │                              │    (stores w, h, cb; no fire) │
    │                              │                               │
    │◄── createSession ────────────│                               │
    │─── resolve ─────────────────►│                               │
    │─── Container:init ──────────►│                               │
    │                              │  SHARC.onReady callback:      │
    │                              │    cache _env, _sfMeta        │
    │                              │    _sfReady = true            │
    │◄── resolve (init) ───────────│                               │
    │                              │                               │
    │─── Container:startCreative ─►│                               │
    │◄── resolve ──────────────────│                               │
    │─── Container:stateChange ───►│                               │
    │       (active)               │  _sharcState = 'active'       │
    │                              │  compute inViewPct            │
    │                              │  fire cb('geom-update', geom)►│
    │                              │                               │
    │                              │◄── $sf.ext.expand({t:50}) ───│
    │                              │  _placementMode='expanding'   │
    │◄── requestPlacementChange ───│                               │
    │─── resolve ─────────────────►│                               │
    │                              │  _placementMode='expanded'    │
    │                              │  fire cb('expanded', info) ──►│
```

---

## 5. $sf Namespace Structure

This is the complete public API surface exposed as `window.$sf`. The implementation exposes exactly these — no more, no less. `$sf.host` is intentionally absent — the SHARC container replaces it entirely.

```javascript
window.$sf = {

  // ─── Version ───────────────────────────────────────────────────────

  /**
   * SafeFrame specification version this bridge presents itself as.
   * Always "1-1-0" (SafeFrame 1.1 — hyphenated per IAB spec format).
   * @type {string}
   */
  specVersion: "1-1-0",


  // ─── External Party (Creative) API ─────────────────────────────────

  ext: {

    /**
     * Registers the creative with the SafeFrame host.
     * Declares initial width/height and sets the event callback.
     *
     * Maps to: SHARC.onReady() (lifecycle hookup — registration is stored synchronously)
     * The callback is NOT fired during register(). It fires on the first 'geom-update'
     * event when the container becomes active.
     *
     * @param {number} w - Initial width in pixels
     * @param {number} h - Initial height in pixels
     * @param {Function} cb - Event callback: cb(status, data)
     *   status: 'expanded'|'collapsed'|'failed'|'geom-update'|'focus-change'
     */
    register(w, h, cb) {},


    /**
     * Returns the feature support object.
     *
     * Returns an object with boolean properties for each SafeFrame feature flag.
     * Never throws. Safe to call before register().
     *
     * @returns {{ 'exp-ovr': boolean, 'exp-push': boolean,
     *             'read-cookie': boolean, 'write-cookie': boolean }}
     */
    supports() {},


    /**
     * Returns geometric information about the container's position on screen.
     *
     * Maps to: cached geometry from SHARC environmentData + stateChange events.
     *
     * Shape:
     * {
     *   win:  { t, l, r, b, w, h }   // Viewport rectangle (CSS pixels)
     *   self: { t, l, r, b, w, h, xiv, yiv, iv, ovx, ovy, ov, ex }
     *                                  // Self (container) rectangle + intersection info
     *   exp:  { t, l, r, b, push }    // Maximum expansion rectangle + push mode
     * }
     *
     * Returns a zeroed-out geometry object if called before init.
     * See §8.7 for field definitions.
     *
     * @returns {Object}
     */
    geom() {},


    /**
     * Requests expansion of the container.
     *
     * obj properties:
     *   t: number  — top offset (pixels)
     *   l: number  — left offset (pixels)
     *   r: number  — right offset (pixels)
     *   b: number  — bottom offset (pixels)
     *   push: boolean — if true, requests push mode (reflow); if false, overlay mode
     *
     * Overlay mode (push: false, default):
     *   Maps to: SHARC.requestPlacementChange({ intent: 'maximize' })
     *
     * Push mode (push: true):
     *   Maps to: SHARC.requestPlacementChange({ intent: 'resize', targetDimensions: {...} })
     *   Push mode is declared unsupported in $sf.ext.supports() (exp-push: false).
     *   If push: true is passed, bridge fires callback('failed', { reason: 'push-not-supported' }).
     *
     * On SHARC resolve: _placementMode = 'expanded'; fires callback('expanded', info)
     * On SHARC reject: _placementMode = 'collapsed'; fires callback('failed', { reason: 'expand-rejected' })
     *
     * @param {{ t?: number, l?: number, r?: number, b?: number, push?: boolean }} obj
     */
    expand(obj) {},


    /**
     * Collapses the container to its registered (initial) size.
     *
     * Maps to: SHARC.requestPlacementChange({ intent: 'restore' })
     * On resolve: _placementMode = 'collapsed'; fires callback('collapsed', null)
     * On reject: fires callback('failed', { reason: 'collapse-rejected' })
     *
     * Calling collapse() when already collapsed is a no-op (no SHARC call, no callback).
     */
    collapse() {},


    /**
     * Returns the current placement status string.
     *
     * Derived from internal _placementMode.
     * Logic: see §2 — one of 'expanded'|'expanding'|'collapsed'|'collapsing'
     *
     * @returns {'expanded'|'expanding'|'collapsed'|'collapsing'}
     */
    status() {},


    /**
     * Reads metadata provided by the host.
     *
     * Maps to: reads from _sfMeta, which is populated from SHARC environmentData
     * at init time. The container places SafeFrame metadata in:
     *   environmentData.sfMeta.shared[propName]     (no ownerKey)
     *   environmentData.sfMeta.owned[ownerKey][propName]  (with ownerKey)
     *
     * Returns undefined if the property does not exist.
     * Never throws.
     *
     * @param {string} propName  - The metadata property name
     * @param {string} [ownerKey] - Owner namespace key (optional)
     * @returns {*} The metadata value, or undefined
     */
    meta(propName, ownerKey) {},


    /**
     * EXCLUDED — no SHARC equivalent for host-domain cookie access.
     *
     * SafeFrame 1.1 allowed creatives to read/write cookies in the host (page) domain
     * via the SafeFrame postMessage relay. SHARC has no equivalent mechanism and this
     * pattern is incompatible with third-party cookie deprecation.
     *
     * Behavior: immediately fires callback('failed', { reason: 'cookie-not-supported' })
     * Does NOT throw. Does NOT return a value.
     *
     * @param {string} cookieName
     * @param {*} [cookieData] - If provided, this was a write attempt
     */
    cookie(cookieName, cookieData) {},


    /**
     * Returns the estimated in-view percentage of the creative (0–100).
     *
     * Derived from SHARC geometry (intersection ratio) + current state.
     * Returns 0 when state is hidden, frozen, or pre-init.
     * Returns cached geometry-based value when state is active or passive.
     *
     * @returns {number} 0–100 integer
     */
    inViewPercentage() {},


    /**
     * Returns whether the top-level browser window has focus.
     *
     * Maps to: _sharcState === 'active'
     * true when SHARC state is 'active' (visible + focused)
     * false when SHARC state is 'passive', 'hidden', 'frozen', or pre-init
     *
     * @returns {boolean}
     */
    winHasFocus() {},

  }, // end $sf.ext

}; // end $sf
```

### Internal Bridge State

The bridge maintains the following private state (not exposed on `window.$sf`):

```javascript
// Private to sharc-safeframe-bridge.js module scope
const _state = {
  _sharcState:     'loading',   // Last SHARC state: 'ready'|'active'|'passive'|'hidden'|'frozen'
  _placementMode:  'collapsed', // 'collapsed'|'collapsing'|'expanded'|'expanding'
  _sfReady:        false,       // true after SHARC Container:init has been processed
  _env:            null,        // SHARC EnvironmentData from Container:init
  _sfMeta:         null,        // { shared: {}, owned: { [ownerKey]: {} } }
  _registeredW:    0,           // Width declared in $sf.ext.register()
  _registeredH:    0,           // Height declared in $sf.ext.register()
  _callback:       null,        // The cb registered via $sf.ext.register()
  _inViewPct:      0,           // Cached 0-100 viewability percentage
  _winHasFocus:    false,       // Cached focus state
  _geomCache:      null,        // Cached geom() object; updated on stateChange + placementChange
};
```

---

## 6. Key Design Decisions

### 6.1 `$sf.ext.register()` — Registration Without Immediate Callback

**Decision: `$sf.ext.register()` stores the callback synchronously and does NOT fire it.**

SafeFrame 1.1 specifies that `register()` declares the creative's initial size and provides the event callback. It does not specify when the first callback fires, but native SafeFrame implementations always fire the first `'geom-update'` after the host finishes initialization.

The bridge stores `(w, h, cb)` immediately on `register()`. The SHARC `onReady` callback caches env and metadata. The first callback delivery (`'geom-update'`) fires when the container first becomes `active` via a `stateChange` event.

If `register()` is called multiple times (which the spec discourages but doesn't explicitly forbid), the bridge replaces the stored `(w, h, cb)` with the latest values. Only the most recently registered callback is active.

**Alternative considered:** Fire a `'geom-update'` immediately inside `SHARC.onReady`. Rejected — the `onReady` callback must resolve quickly (the container waits on it), and the creative's geometry is not meaningful until `startCreative` has resolved and the container transitions to `active`.

### 6.2 `$sf.ext.expand()` — Overlay vs Push Mode

**Decision: Overlay mode maps to SHARC `maximize`; push mode is declared unsupported.**

SafeFrame's `expand({ push: false })` (or omitting `push`) is an overlay expand — the container floats above page content. This maps cleanly to `SHARC.requestPlacementChange({ intent: 'maximize' })`. The expand offsets (`t`, `l`, `r`, `b`) describe how much the container grows in each direction. SHARC's `maximize` expands to fill the full available space — the bridge passes the offset hints as advisory metadata, but SHARC containers are not required to honor exact offset values.

SafeFrame's `expand({ push: true })` is a push expand — the host reflows surrounding page content to accommodate the expanded ad. SHARC has no equivalent mechanism. The container cannot push/reflow publisher content from inside a sandboxed iframe over a MessageChannel. `exp-push` is declared `false` in `$sf.ext.supports()` and push expand fires `callback('failed', { reason: 'push-not-supported' })` immediately.

**Why not `SHARC.requestPlacementChange({ intent: 'resize', targetDimensions: ... })` for overlay?**
SafeFrame overlay expand dimensions are relative offsets from the current position, not absolute target sizes. Computing absolute dimensions from `(t, l, r, b)` offsets requires knowing the current container position in absolute page coordinates — which is only available from the geometry cache and may be stale. `maximize` is the correct semantic intent for overlay expand.

**For creatives that pass specific `(t, l, r, b)` values:** The bridge ignores them for the `maximize` SHARC call. If v2 needs to support size-constrained overlay expand, `SHARC.requestPlacementChange({ intent: 'resize', targetDimensions })` can be used with computed dimensions.

### 6.3 `$sf.ext.geom()` — Geometry Object Construction

**Decision: Construct the geom object from SHARC `environmentData` and cached state; update on every `stateChange`.**

SafeFrame's `geom()` returns three sub-objects: `win` (viewport), `self` (container), and `exp` (expansion zone). SHARC's geometry is delivered via `environmentData.currentPlacement` at init and via `placementChange` events afterward.

Mapping:

| SafeFrame `geom()` field | SHARC source | Notes |
|---|---|---|
| `win.w`, `win.h` | `env.currentPlacement.viewportSize.width/height` | Viewport dimensions |
| `win.t`, `win.l` | Always `0`, `0` | Viewport origin is always top-left |
| `win.r`, `win.b` | `win.w`, `win.h` | Right/bottom edges |
| `self.w`, `self.h` | `env.currentPlacement.initialDefaultSize.width/height` | Updated on `placementChange` |
| `self.t`, `self.l` | `0`, `0` in reference impl | Iframe-relative; absolute position not available in sandboxed iframe |
| `self.r`, `self.b` | `self.l + self.w`, `self.t + self.h` | Derived |
| `self.xiv` | `1.0` if active else `0.0` | X-axis intersection ratio (simplified) |
| `self.yiv` | `1.0` if active else `0.0` | Y-axis intersection ratio (simplified) |
| `self.iv` | `_inViewPct / 100` | Overall intersection ratio |
| `self.ovx`, `self.ovy`, `self.ov` | `0` | Overflow — not applicable |
| `self.ex` | `_placementMode === 'expanded'` ? `true` : `false` | Whether expanded |
| `exp.t`, `exp.l`, `exp.r`, `exp.b` | `env.currentPlacement.maxExpandSize` | Max expansion zone |
| `exp.push` | `false` | Push expand not supported |

**Absolute position caveat:** SafeFrame's `self.t` and `self.l` are supposed to be the container's position relative to the viewport. In a sandboxed cross-origin iframe, `window.frameElement` is null — absolute container position is not available. The bridge returns `0, 0` for `self.t` and `self.l`. Creatives that depend on absolute position for ad serving decisions (e.g., viewability vendors) should use the `self.iv` intersection ratio instead, which is geometry-derived and accurate.

### 6.4 `$sf.ext.meta()` — Metadata Delivery via Bootstrap Payload

**Decision: Host metadata is delivered in `environmentData.sfMeta` at init time; the bridge reads it synchronously from cache.**

SafeFrame 1.1's `$sf.ext.meta(propName, ownerKey)` allowed creatives to read metadata provided by the host (e.g., deal IDs, targeting data, advertiser info). The native SafeFrame implementation delivered this via the iframe bootstrap message.

In the SHARC bridge, the container places metadata in `environmentData.sfMeta` before sending `Container:init`:

```javascript
// Container-side (publisher configures this)
environmentData.sfMeta = {
  shared: {
    // Properties accessible without an ownerKey
    'deal-id': 'PMP-12345',
    'pos': 'atf',
  },
  owned: {
    // Properties accessible only with the correct ownerKey
    'advertiser.com': {
      'campaign': 'spring-2026',
    }
  }
};
```

The bridge caches this at `SHARC.onReady()` time as `_state._sfMeta`. `$sf.ext.meta(propName, ownerKey)` reads from the appropriate sub-object:

```javascript
// ownerKey present → owned namespace
meta('campaign', 'advertiser.com') // → 'spring-2026'
// ownerKey absent → shared namespace
meta('deal-id')                    // → 'PMP-12345'
// Not found → undefined
meta('nonexistent')                // → undefined
```

`meta()` never throws. It returns `undefined` for any missing property or when called before init.

**Alternative considered:** Deliver metadata via a separate SHARC extension message after init. Rejected — this would require an async API for what SafeFrame specifies as synchronous. Embedding in `environmentData` keeps it synchronous at the cost of a slightly larger init payload.

### 6.5 `$sf.ext.supports()` — Feature Flag Object

**Decision: `supports()` returns a plain object with four boolean properties, not a function taking a feature string (SafeFrame's API differs from MRAID).**

SafeFrame 1.1 defines `$sf.ext.supports()` as returning an object: `{ 'exp-ovr': bool, 'exp-push': bool, 'read-cookie': bool, 'write-cookie': bool }`. The bridge always returns:

```javascript
{
  'exp-ovr':      true,   // Overlay expand — supported via SHARC maximize
  'exp-push':     false,  // Push expand — not supported in v1
  'read-cookie':  false,  // Host domain cookies — no SHARC equivalent
  'write-cookie': false,  // Host domain cookies — no SHARC equivalent
}
```

This is a static object for v1. Future SHARC extensions could make `exp-push` dynamic based on a container feature flag.

`supports()` must never throw and must be callable before `register()`.

### 6.6 `$sf.ext.cookie()` — Intentional Exclusion

**Decision: `$sf.ext.cookie()` fires `callback('failed', { reason: 'cookie-not-supported' })` and returns immediately.**

SafeFrame's cookie relay allowed creatives to read and write cookies in the publisher's first-party domain, bypassing third-party cookie restrictions. This was:

1. A privacy violation by modern standards (ITP, third-party cookie deprecation)
2. Architecturally incompatible — requires the publisher page to relay cookie operations, which SHARC's MessageChannel model does not include
3. Not implementable in a sandboxed iframe without `allow-same-origin` (which is intentionally absent)

This exclusion is **permanent**, not deferred. Creatives that depend on `$sf.ext.cookie()` must be rewritten to use their own first-party cookie mechanism or server-side storage.

The bridge fires the creative's registered callback with `'failed'` instead of throwing, because creatives may check the return value or listen for failure — silently returning `undefined` without a callback fire would leave the creative waiting for a response that never comes.

> **⚠️ Privacy Design TODO (parked for future WG discussion)**
> SHARC needs a broader privacy design pass aligned with current web standards and industry thinking:
> - Third-party cookie deprecation (Chrome, Safari ITP)
> - Privacy Sandbox APIs (Topics API, Protected Audience, Storage Access API)
> - First-party data patterns for ad containers
> - What, if anything, SHARC should offer as a privacy-preserving data channel between container and creative
> - Whether SHARC's MessageChannel model could be extended with a structured, consent-gated metadata mechanism
>
> This is not just about `cookie()` — it's about SHARC's role in a post-cookie web. Recommend a dedicated privacy design document as a v2 workstream before SHARC reaches wide adoption.

### 6.7 `$sf.ext.winHasFocus()` — Focus State from SHARC State

**Decision: Map SHARC `active` → `winHasFocus() = true`; all other states → `false`.**

SafeFrame's `winHasFocus()` returns whether the top-level window has focus. SHARC distinguishes:
- `active` — visible AND focused
- `passive` — visible but NOT focused (e.g., split-screen, call interruption)
- `hidden` — not visible

`winHasFocus()` returns `true` only when `_sharcState === 'active'`. This is a clean mapping — SHARC's `active` state is defined as the container having user focus.

The `focus-change` callback event fires whenever the focus state flips between `active` and `passive` (either direction). The bridge detects this transition in the `stateChange` handler:

```javascript
// If transitioning between active and passive (either direction),
// fire 'focus-change' in addition to 'geom-update'
if ((prev === 'active' && newState === 'passive') ||
    (prev === 'passive' && newState === 'active')) {
  _fireCallback('focus-change', { focus: newState === 'active' });
}
```

`focus-change` fires AFTER `geom-update` for the same state transition (geometry update is more fundamental).

### 6.8 Callback Ordering: State First, Then Callback

**Decision: Update all internal state before firing any callback.**

The creative's registered callback may call `$sf.ext.geom()`, `$sf.ext.status()`, `$sf.ext.inViewPercentage()`, or `$sf.ext.winHasFocus()` synchronously inside the callback. All internal state must be updated before any callback fires.

Ordering for SHARC `stateChange`:
1. Update `_sharcState`
2. Update `_inViewPct`
3. Update `_winHasFocus`
4. Rebuild `_geomCache`
5. Fire `callback('geom-update', geomObj)` — geometry is now accurate
6. If focus changed: fire `callback('focus-change', { focus: ... })`

Ordering for placement change resolution:
1. Update `_placementMode` (e.g., `'expanded'`)
2. Update `_geomCache` (container may have resized)
3. Fire `callback('expanded', ...)` or `callback('collapsed', null)`

Never fire the callback reentrantly. If a callback fires `$sf.ext.expand()`, the resulting async SHARC call completes in a future microtask — there is no immediate reentrant callback.

### 6.9 $sf Namespace Bootstrap — Guarding Against Double-Load

**Decision: Bridge detects existing installation via a sentinel property and bails out silently on second load.**

```javascript
if (window.$sf && window.$sf._sharcBridgeInstalled) {
  // Already installed; bail out silently
} else {
  installSafeFrameBridge(window.SHARC);
  window.$sf._sharcBridgeInstalled = true;
}
```

The `window.$sf` namespace is created by the bridge itself (SafeFrame's `$sf.host` is absent — only the bridge's `$sf.ext` is present). There is no risk of colliding with a real SafeFrame host library since the wrapper page is entirely controlled by the container.

---

## 7. Deferred to v2

### 7.1 Push Expand (`exp-push`) — Deferred

**What it is:** SafeFrame's push expand (`expand({ push: true })`) causes the host to reflow surrounding page content — the ad grows and adjacent content shifts down. This produces a richer expandable ad experience than overlay.

**Why deferred:** Push expand requires the publisher container (host page) to participate in a reflow triggered by the creative inside the iframe. The SHARC container has no mechanism for this in v1. The `requestPlacementChange({ intent: 'resize' })` message can resize the iframe, but causing surrounding DOM content to reflow is outside the container's control without a separate publisher-side API.

**v1 behavior:** `$sf.ext.supports()` returns `'exp-push': false`. If `expand({ push: true })` is called anyway, the bridge fires `callback('failed', { reason: 'push-not-supported' })` immediately without making a SHARC call.

**v2 plan:** Design a `com.iabtechlab.sharc.layout` extension that allows the container to signal reflowable expand to the publisher page. Map `SHARC.requestFeature('com.iabtechlab.sharc.layout', { intent: 'push', deltaH: n })` to a publisher-side layout engine. Update `exp-push` flag dynamically based on `SHARC.hasFeature('com.iabtechlab.sharc.layout')`.

### 7.2 Precise Expand Offsets (t, l, r, b) — Deferred

**What it is:** SafeFrame's `expand()` accepts `t`, `l`, `r`, `b` offset values that specify exactly how many pixels the container should grow in each direction. Native SafeFrame hosts honored these to produce directionally asymmetric expansions.

**Why deferred:** SHARC's `maximize` intent does not accept directional offsets. Supporting precise offsets requires computing absolute target dimensions from relative offsets, which in turn requires knowing the container's absolute position in the viewport — not available from a sandboxed iframe.

**v1 behavior:** Offset values in `expand(obj)` are accepted and stored (for potential future use) but silently ignored in the SHARC `maximize` call. The container always expands to maximum available space.

**v2 plan:** Use `SHARC.requestPlacementChange({ intent: 'resize', targetDimensions: { width, height } })` with dimensions computed from offsets + cached container size. Requires the container to report its absolute position in `environmentData`.

### 7.3 Live Geometry Updates — Deferred

**What it is:** Native SafeFrame hosts could fire `'geom-update'` callbacks proactively as the user scrolled — updating the `iv` (intersection ratio) in real time. This is how viewability vendors using SafeFrame tracked scroll-based viewability.

**Why deferred:** SHARC v1 delivers geometry only at init time and on `placementChange`. There is no scroll-event equivalent in SHARC v1. The bridge delivers `'geom-update'` only on `stateChange`, which is too coarse for continuous viewability tracking.

**v1 behavior:** `inViewPercentage()` returns the last computed value from the most recent `stateChange`. It does not update on scroll.

**v2 plan:** Design a `com.iabtechlab.sharc.geometry` extension that sends live intersection ratio updates from the container to the creative. Map these to periodic `'geom-update'` callback fires in the bridge.

### 7.4 `$sf.ext.cookie()` — Permanently Excluded

Not deferred — permanently out of scope. Host-domain cookie relay is a privacy violation and incompatible with third-party cookie deprecation. Creatives depending on `$sf.ext.cookie()` must be rewritten.

---

## 8. Implementation Notes for the Developer

### 8.1 File Structure

The deliverable is two exports from one file:

```javascript
// sharc-safeframe-bridge.js

export class SafeFrameCompatBridge { ... }
// Container-side extension plugin. Tells the container to inject bridge scripts
// and advertises the com.iabtechlab.sharc.safeframe feature in Container:init.
// Also responsible for placing sfMeta into environmentData before Container:init is sent.

export function installSafeFrameBridge(sharcSDK) { ... }
// Called automatically on script load in the browser.
// Takes a SHARC SDK reference (window.SHARC) and installs window.$sf.ext.
// Also available for explicit installation in test environments.
```

CommonJS compatibility:
```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SafeFrameCompatBridge, installSafeFrameBridge };
}
```

### 8.2 Don't Reinvent Event Management

The SHARC SDK (`window.SHARC`) already has its own event system (`SHARC.on`). The bridge's internal `_callback` is for SafeFrame events only — separate from SHARC events. Do not route SafeFrame callbacks through `SHARC.on`. They are independent systems.

SafeFrame has a single registered callback (not a multi-listener map like MRAID). If `register()` is called multiple times, replace `_callback` with the latest. Internal helper:

```javascript
function _fireCallback(status, data) {
  if (!_state._callback) return;
  try {
    _state._callback(status, data);
  } catch (e) {
    // Swallow — don't let creative errors break SHARC protocol
    console.warn('[SafeFrame Bridge] Callback threw for status:', status, e);
  }
}
```

### 8.3 `SHARC.onReady` Must Resolve Quickly

The bridge's `SHARC.onReady` callback participates in the SHARC init sequence. The container waits for this Promise to resolve before sending `Container:startCreative`. Resolve it immediately after caching env and metadata. Do not await creative SafeFrame handlers.

```javascript
SHARC.onReady(async (env, features) => {
  _state._env = env;
  _state._sfMeta = (env && env.sfMeta) || { shared: {}, owned: {} };
  _state._sfReady = true;
  _state._sharcState = 'ready';

  // Rebuild initial geom cache from env data
  _rebuildGeomCache();

  // Resolve immediately — SHARC container is waiting on this Promise
  // Do NOT fire the creative callback here — geometry is not meaningful yet
});
```

### 8.4 The `stateChange` Handler — Ordering and `focus-change`

Always update internal state BEFORE firing callbacks. Creatives may call `$sf.ext.geom()`, `$sf.ext.status()`, `$sf.ext.inViewPercentage()`, or `$sf.ext.winHasFocus()` synchronously inside the callback.

```javascript
SHARC.on('stateChange', (newState) => {
  const prevState = _state._sharcState;

  // 1. Update internal state FIRST
  _state._sharcState = newState;
  _state._winHasFocus = (newState === 'active');
  _state._inViewPct = _computeInViewPct(newState);

  // 2. Rebuild geom cache with updated state
  _rebuildGeomCache();

  // 3. Fire geom-update (but not for frozen — JS is suspended at that point)
  if (newState !== 'frozen') {
    _fireCallback('geom-update', _state._geomCache);
  }

  // 4. Fire focus-change if focus state flipped (active ↔ passive only)
  const focusFlipped =
    (prevState === 'active' && newState === 'passive') ||
    (prevState === 'passive' && newState === 'active');
  if (focusFlipped) {
    _fireCallback('focus-change', { focus: newState === 'active' });
  }
});
```

### 8.5 `expand()` — Transient State and SHARC Promise Handling

```javascript
$sf.ext.expand = function(obj) {
  if (_state._placementMode === 'expanded') return; // no-op if already expanded
  if (_state._placementMode === 'expanding') return; // no-op if in flight

  const push = obj && obj.push === true;
  if (push) {
    // Push mode not supported
    _fireCallback('failed', { reason: 'push-not-supported' });
    return;
  }

  // Set transient state BEFORE async call
  _state._placementMode = 'expanding';

  SHARC.requestPlacementChange({ intent: 'maximize' })
    .then((placement) => {
      _state._placementMode = 'expanded';
      _rebuildGeomCache();
      _fireCallback('expanded', { info: {
        w: placement && placement.width || 0,
        h: placement && placement.height || 0,
        push: false,
      }});
    })
    .catch((err) => {
      _state._placementMode = 'collapsed';
      _fireCallback('failed', { reason: 'expand-rejected' });
    });
};
```

### 8.6 `collapse()` — Guard Against No-Op

```javascript
$sf.ext.collapse = function() {
  if (_state._placementMode === 'collapsed') return; // no-op
  if (_state._placementMode === 'collapsing') return; // already in flight

  // Set transient state BEFORE async call
  _state._placementMode = 'collapsing';

  SHARC.requestPlacementChange({ intent: 'restore' })
    .then(() => {
      _state._placementMode = 'collapsed';
      _rebuildGeomCache();
      _fireCallback('collapsed', null);
    })
    .catch((err) => {
      _state._placementMode = 'expanded'; // restore prior state on reject
      _fireCallback('failed', { reason: 'collapse-rejected' });
    });
};
```

### 8.7 Geom Object Field Reference

The `_rebuildGeomCache()` function constructs the full geom object:

```javascript
function _rebuildGeomCache() {
  const env = _state._env;
  const placement = (env && env.currentPlacement) || {};
  const vpSize = placement.viewportSize || { width: 0, height: 0 };
  const selfSize = placement.initialDefaultSize || { width: _state._registeredW, height: _state._registeredH };
  const maxExpand = placement.maxExpandSize || { width: vpSize.width, height: vpSize.height };

  const iv = _state._inViewPct / 100;
  const isExpanded = _state._placementMode === 'expanded';

  _state._geomCache = {
    win: {
      t: 0,
      l: 0,
      r: vpSize.width,
      b: vpSize.height,
      w: vpSize.width,
      h: vpSize.height,
    },
    self: {
      t: 0,           // Absolute position unavailable in sandboxed iframe; always 0
      l: 0,           // Absolute position unavailable in sandboxed iframe; always 0
      r: selfSize.width,
      b: selfSize.height,
      w: selfSize.width,
      h: selfSize.height,
      xiv: iv > 0 ? 1.0 : 0.0,   // Simplified: fully in or fully out on X axis
      yiv: iv > 0 ? 1.0 : 0.0,   // Simplified: fully in or fully out on Y axis
      iv:  iv,                     // Overall intersection ratio (0.0–1.0)
      ovx: 0,
      ovy: 0,
      ov:  0,
      ex:  isExpanded,             // true when expanded
    },
    exp: {
      t: maxExpand.height - selfSize.height,
      l: maxExpand.width  - selfSize.width,
      r: maxExpand.width  - selfSize.width,
      b: maxExpand.height - selfSize.height,
      push: false,
    },
  };
}
```

**Field definitions:**

| Field | Type | Description |
|---|---|---|
| `win.t/l/r/b` | number | Viewport edges (pixels) relative to viewport origin |
| `win.w/h` | number | Viewport width/height |
| `self.t/l` | number | Container top/left offset — always `0` in bridge (see §6.3) |
| `self.r/b` | number | Container right/bottom edge = `l+w` / `t+h` |
| `self.w/h` | number | Container width/height |
| `self.xiv` | float 0–1 | Fraction of container width visible on X axis |
| `self.yiv` | float 0–1 | Fraction of container height visible on Y axis |
| `self.iv` | float 0–1 | Overall intersection ratio (`inViewPercentage / 100`) |
| `self.ovx/ovy/ov` | number | Overflow amounts — always 0 in bridge |
| `self.ex` | boolean | Whether the container is currently expanded |
| `exp.t/l/r/b` | number | Available expansion space in each direction |
| `exp.push` | boolean | Always `false` — push not supported |

### 8.8 Pre-Init Return Values

Some methods depend on data available only after `Container:init`. Return safe zeroed-out objects (not `null`, not throws) if called before `register()` or before init:

| Method | Pre-init return value |
|---|---|
| `$sf.ext.status()` | `'collapsed'` |
| `$sf.ext.geom()` | Zeroed-out geom object (all `0`, `ex: false`) |
| `$sf.ext.inViewPercentage()` | `0` |
| `$sf.ext.winHasFocus()` | `false` |
| `$sf.ext.supports()` | Full object (static — does not depend on init) |
| `$sf.ext.meta(...)` | `undefined` |

### 8.9 `$sf.host` — Intentionally Absent

The bridge does NOT implement `$sf.host`. This is intentional and complete:

- `$sf.host.Config`, `$sf.host.PosConfig`, `$sf.host.Position`, `$sf.host.PosMeta` — host configuration objects; replaced by SHARC container configuration
- `$sf.host.boot()`, `$sf.host.render()`, `$sf.host.nuke()` — host rendering methods; the SHARC container handles rendering
- `$sf.host.status()`, `$sf.host.get()` — host query methods; not needed inside the creative iframe

If a creative's code ever references `$sf.host` (which would be unusual — host API is for publisher pages, not creatives), those calls will throw a TypeError. This is correct behavior: a SafeFrame creative should never call `$sf.host` from inside the creative iframe. Any creative that does so is misusing the SafeFrame API.

### 8.10 Singleton Guard

If `sharc-safeframe-bridge.js` loads twice (defensive only — injection mechanism should prevent this):

```javascript
if (window.$sf && window.$sf._sharcBridgeInstalled) {
  // Already installed; bail out silently
} else {
  installSafeFrameBridge(window.SHARC);
  window.$sf._sharcBridgeInstalled = true;
}
```

### 8.11 Key Test Cases

The bridge has clean seams for unit testing via a mock SHARC SDK passed to `installSafeFrameBridge(mockSHARC)`.

| Test | Expected Behavior |
|---|---|
| `$sf.ext.register()` before SHARC init | Stores w, h, cb; does NOT fire cb |
| First `stateChange(active)` | Fires `cb('geom-update', geomObj)` |
| `$sf.ext.status()` before expand | Returns `'collapsed'` |
| `$sf.ext.expand({})` called | Status becomes `'expanding'` immediately; `'expanded'` after resolve |
| `$sf.ext.status()` during expand in-flight | Returns `'expanding'` |
| SHARC rejects expand | Status returns to `'collapsed'`; `cb('failed', { reason: 'expand-rejected' })` |
| `$sf.ext.collapse()` when already collapsed | No-op; no SHARC call; no callback |
| `$sf.ext.collapse()` when expanded | Status `'collapsing'` → `'collapsed'`; `cb('collapsed', null)` |
| `$sf.ext.expand({ push: true })` | Fires `cb('failed', { reason: 'push-not-supported' })`; no SHARC call |
| `$sf.ext.cookie('foo')` | Fires `cb('failed', { reason: 'cookie-not-supported' })`; no throw |
| `$sf.ext.meta('deal-id')` before init | Returns `undefined` |
| `$sf.ext.meta('deal-id')` after init | Returns value from `env.sfMeta.shared['deal-id']` |
| `$sf.ext.meta('x', 'owner.com')` | Returns value from `env.sfMeta.owned['owner.com']['x']` |
| `$sf.ext.geom()` before init | Zeroed-out object; no throw |
| `$sf.ext.inViewPercentage()` hidden state | Returns `0` |
| `$sf.ext.winHasFocus()` passive state | Returns `false` |
| `$sf.ext.winHasFocus()` active state | Returns `true` |
| `stateChange(active → passive)` | Fires `cb('geom-update', ...)` then `cb('focus-change', { focus: false })` |
| `stateChange(passive → active)` | Fires `cb('geom-update', ...)` then `cb('focus-change', { focus: true })` |
| `stateChange(active → hidden)` | Fires `cb('geom-update', geomObj)` with `iv: 0`; no `focus-change` |
| `stateChange(hidden → frozen)` | No callback fired (JS suspended) |
| `$sf.ext.supports()` return value | `{ 'exp-ovr': true, 'exp-push': false, 'read-cookie': false, 'write-cookie': false }` |
| `$sf` singleton guard | Second script load does not reinstall or double-fire callbacks |
| `expand()` called twice without collapse | Second call is no-op; no duplicate SHARC calls |
| Callback throws inside `geom-update` | Bridge swallows exception; SHARC protocol unaffected |

### 8.12 What NOT to Do

- **Do not** implement `window.$sf.host` — the SHARC container replaces it entirely.
- **Do not** call `SHARC._sdk` or any private SHARC SDK internals. Use only the public `SHARC.*` API.
- **Do not** intercept or proxy `MessageChannel` messages. All SHARC protocol is handled by `sharc-creative.js`.
- **Do not** fire the SafeFrame callback synchronously inside `$sf.ext.register()` — the creative has not finished loading yet.
- **Do not** fire the SafeFrame callback during `SHARC.onReady()` — geometry is not meaningful until `stateChange(active)` fires.
- **Do not** emit `'geom-update'` for the `frozen` state — JS execution is suspended and the creative cannot process it.
- **Do not** emit `'focus-change'` when transitioning to/from `hidden` — focus-change semantics apply only to `active ↔ passive` transitions.
- **Do not** throw from any `$sf.ext.*` method. All errors are expressed via the callback's `'failed'` status.
- **Do not** add `window.$sf.host` as a stub or empty object — its presence would mislead creatives that defensively check `typeof $sf.host !== 'undefined'` before calling its methods.
- **Do not** attempt to relay cookie operations via any other channel. Cookie support is permanently excluded.

---

*End of document. Ready for Jeffrey's review.*
