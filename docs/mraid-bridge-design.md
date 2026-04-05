# SHARC MRAID Compatibility Bridge — Architecture Design

**Document:** `mraid-bridge-design.md`  
**Status:** Ready for Review  
**Author:** Architecture, SHARC Working Group  
**Reviewer:** Jeffrey Carlson, VP Product, IAB Tech Lab  
**Last Updated:** 2026-04-03  
**Target file:** `src/sharc-mraid-bridge.js`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [State Mapping](#2-state-mapping)
3. [API Mapping](#3-api-mapping)
4. [Bootstrap Sequence](#4-bootstrap-sequence)
5. [mraid Object Structure](#5-mraid-object-structure)
6. [Key Design Decisions](#6-key-design-decisions)
7. [Deferred to v2](#7-deferred-to-v2)
8. [Implementation Notes for the Developer](#8-implementation-notes-for-the-developer)

---

## 1. Architecture Overview

### What the Bridge Does

The MRAID bridge is a one-way compatibility shim. It makes old MRAID 2.0/3.0 creatives run unmodified inside a SHARC container. The creative never knows it is not talking to a native MRAID SDK.

The direction of translation is exclusively:

```
MRAID creative → SHARC container
```

There is no SHARC-to-MRAID direction. This is a migration tool, not a bidirectional adapter.

### Where the Bridge Lives

The bridge is a **container-side extension** — a JavaScript module loaded by the SHARC container environment, not by the creative. The creative loads its normal `mraid.js` URL. The bridge *is* `mraid.js` from the creative's perspective.

```
┌─────────────────────────────────────────────────────────────────────┐
│  SHARC Container (publisher environment)                            │
│                                                                     │
│  ┌──────────────────────────────────────────┐                      │
│  │  sharc-container.js  +  SHARCContainerProtocol                  │
│  └────────────────┬─────────────────────────┘                      │
│                   │  SHARC MessageChannel                           │
│  ┌────────────────▼─────────────────────────┐                      │
│  │  iframe (sandboxed)                      │                      │
│  │                                          │                      │
│  │  <script> sharc-protocol.js </script>    │                      │
│  │  <script> sharc-creative.js </script>    │                      │
│  │  <script> sharc-mraid-bridge.js </script>│                      │
│  │  ← injected BEFORE creative code runs   │                      │
│  │                                          │                      │
│  │  ┌──────────────────────────────────┐    │                      │
│  │  │  sharc-mraid-bridge.js           │    │                      │
│  │  │  (the shim that IS mraid.js)     │    │                      │
│  │  │                                  │    │                      │
│  │  │  • Exposes window.mraid          │    │                      │
│  │  │  • Backs it with SHARC SDK       │    │                      │
│  │  │  • Translates calls & events     │    │                      │
│  │  └────────────────┬─────────────────┘    │                      │
│  │                   │  SHARC.on/request/…  │                      │
│  │  ┌────────────────▼─────────────────┐    │                      │
│  │  │  sharc-creative.js (SHARC SDK)   │    │                      │
│  │  └──────────────────────────────────┘    │                      │
│  │                                          │                      │
│  │  Ad creative code (unchanged)            │                      │
│  │  mraid.getState() / mraid.expand() / …   │                      │
│  └──────────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
```

### File Roles

| File | Owner | Role |
|------|-------|------|
| `sharc-creative.js` | Creative iframe | Handles SHARC protocol; provides `window.SHARC` |
| `sharc-mraid-bridge.js` | Creative iframe | Loaded after `sharc-creative.js`; hooks into `window.SHARC`; populates `window.mraid` |
| `sharc-container.js` | Publisher page | Injects both scripts into iframe before creative code runs |
| `MRAIDCompatBridge` class | Container plugin | Extension object that signals the container to inject bridge scripts |

### Injection Mechanism

The container uses the `MRAIDCompatBridge` extension class:

```javascript
import { SHARCContainer } from './sharc-container.js';
import { MRAIDCompatBridge } from './sharc-mraid-bridge.js';

const container = new SHARCContainer({
  element: document.getElementById('ad-slot'),
  creativeUrl: 'https://mraid-ad.example.com/ad.html',
  placement: { width: 320, height: 50, inline: true },
  extensions: [new MRAIDCompatBridge()]
});
```

Internally, `MRAIDCompatBridge` registers with the container as an extension that:

1. Prepends `sharc-protocol.js`, `sharc-creative.js`, and `sharc-mraid-bridge.js` into the iframe document before the creative URL loads
2. Advertises the `com.iabtechlab.sharc.mraid` extension feature in `Container:init`

**Injection implementation:** The container serves a same-origin wrapper page that loads the three scripts in order, then loads the creative URL inside. This is the correct approach for the reference implementation — it avoids the complexity of iframe `srcdoc` manipulation and keeps script loading synchronous and predictable. The wrapper page URL pattern is:

```
/sharc/mraid-wrapper.html?creative=https%3A%2F%2Fmraid-ad.example.com%2Fad.html
```

The wrapper HTML:
```html
<!doctype html>
<html>
<head>
  <script src="/sharc/sharc-protocol.js"></script>
  <script src="/sharc/sharc-creative.js"></script>
  <script src="/sharc/sharc-mraid-bridge.js"></script>
</head>
<body>
  <script>
    // Load the MRAID creative into this document
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

For inline MRAID creative markup (not a URL), the container can use `srcdoc` with the three scripts prepended directly.

### Single Responsibility

`sharc-mraid-bridge.js` has exactly one job: **expose a spec-compliant `window.mraid` object backed by the SHARC SDK.** It does not talk to the container directly over `MessageChannel`. All protocol communication goes through `window.SHARC` (the `sharc-creative.js` SDK). The bridge is a pure adapter layer above the SDK.

This means the bridge has no knowledge of `sessionId`, `messageId`, or the MessageChannel transport. It is portable to any SHARC SDK implementation.

---

## 2. State Mapping

### Decision: MRAID Has 5 States; SHARC Has More Granularity

MRAID 3.0 states: `loading`, `default`, `expanded`, `resized`, `hidden`

SHARC creative-visible states: `ready`, `active`, `passive`, `hidden`, `frozen`

The key architectural difference: **SHARC decouples state from placement.** In MRAID, `expanded` and `resized` are states. In SHARC, they are placement properties — the state machine only tracks visibility and focus. The bridge must therefore maintain its own placement tracking to reconstruct MRAID's `expanded`/`resized` states.

### State Mapping Table

| MRAID State | SHARC State(s) | Bridge Behavior | Notes |
|-------------|----------------|-----------------|-------|
| `loading` | *(pre-init)* | Bridge holds `getState() === 'loading'` until SHARC init completes | Initial state on bridge load |
| `default` | `ready` | Fire `stateChange('default')` after `ready` event fires | Creative is initialized but not yet visible |
| `default` | `active` | State remains `default` if no expand has occurred; `viewableChange(true)` fires | Normal visible+focused state |
| `default` | `passive` | State remains `default`; fire `viewableChange(false)` | MRAID has no passive concept; bridge maps to not-viewable |
| `expanded` | `active` | After `requestPlacementChange` resolves with a non-inline change | Bridge sets `_placementMode = 'expanded'`; `getState()` returns `'expanded'` |
| `resized` | `active` | After `requestPlacementChange` resolves with specific dimensions | Bridge sets `_placementMode = 'resized'`; deferred to v2 |
| `hidden` | `hidden` | Fire `stateChange('hidden')` and `viewableChange(false)` | JS still runs |
| `hidden` | `frozen` | Remain in `hidden` from MRAID's perspective | MRAID has no `frozen` concept; bridge takes no additional action |

### The `expanded` / `resized` State Problem

**Decision:** Bridge tracks placement state internally via a `_placementMode` flag, never derived from SHARC state alone.

MRAID `expanded` is only active after `mraid.expand()` has been called and before `mraid.collapse()` is called. It's independent of focus state. SHARC never sends a state called `expanded` — it sends a `placementChange` event. The bridge must:

1. Set `_placementMode = 'expanded'` when `requestPlacementChange({ intent: 'maximize' })` resolves successfully
2. Set `_placementMode = 'resized'` when `requestPlacementChange({ intent: 'resize', ... })` resolves successfully (v2)
3. Set `_placementMode = 'default'` when `requestPlacementChange({ intent: 'restore' })` resolves

```
getState() logic:
  if _sharcState is 'hidden' or 'frozen' → return 'hidden'
  if _mraidReady is false                → return 'loading'
  if _placementMode is 'expanded'        → return 'expanded'
  if _placementMode is 'resized'         → return 'resized'
  else                                    → return 'default'
```

The SHARC state (`active`, `passive`, `hidden`, `frozen`, `ready`) feeds `isViewable()` and `viewableChange` events but does NOT feed `getState()` for the expanded/resized cases. This is intentional — MRAID expanded state is durable across focus changes.

### Viewability Mapping

`mraid.isViewable()` is a binary signal. SHARC has three relevant non-hidden states:

| SHARC State | `isViewable()` | `viewableChange` fires? | Reasoning |
|-------------|----------------|------------------------|-----------|
| `active`    | `true`         | Yes (if was false)     | Visible and focused |
| `passive`   | `false`        | Yes (if was true)      | MRAID has no partial-viewability; conservative mapping |
| `hidden`    | `false`        | Yes (if was true)      | Not visible |
| `frozen`    | `false`        | No (already false from hidden) | JS suspended; no point firing |
| `ready`     | `false`        | No                     | Not yet started |

**Decision: Map `passive` to `isViewable() = false`.** This is conservative and correct for MRAID semantics. MRAID's `viewableChange` fires on the transition between viewable and not-viewable. The bridge fires `viewableChange` only when the viewability state *flips* — not on every SHARC `stateChange`. Duplicate `viewableChange(false)` events are not sent if viewability was already false.

---

## 3. API Mapping

### Method Mapping Table

| MRAID Method | Status | SHARC Translation | Notes |
|---|---|---|---|
| `mraid.getVersion()` | ✅ Supported | Returns `"3.0"` (static string) | Bridge always presents as MRAID 3.0 |
| `mraid.getState()` | ✅ Supported | Derived from `_sharcState` + `_placementMode` | See §2 |
| `mraid.isViewable()` | ✅ Supported | `_sharcState === 'active'` | See §2 |
| `mraid.getPlacementType()` | ✅ Supported | Derived from SHARC env at init | See §6.1 |
| `mraid.expand([url])` | ✅ Supported (no-URL form only) | `SHARC.requestPlacementChange({ intent: 'maximize' })` | URL form not supported; see §6.2 |
| `mraid.collapse()` | ✅ Supported | `SHARC.requestPlacementChange({ intent: 'restore' })` | Fires `stateChange('default')` on resolve |
| `mraid.close()` | ✅ Supported | `SHARC.requestClose()` | Container may reject; bridge fires no error on rejection; see §6.4 |
| `mraid.open(url)` | ✅ Supported | `SHARC.requestNavigation({ url, target: 'clickthrough' })` | On SHARC reject 2105, bridge calls `window.open(url, '_blank')` |
| `mraid.useCustomClose(bool)` | ✅ Supported (no-op) | No SHARC equivalent; accepted silently | See §6.3 |
| `mraid.addEventListener(event, fn)` | ✅ Supported | Mapped to SHARC events internally | See Event Mapping Table below |
| `mraid.removeEventListener(event, fn)` | ✅ Supported | Removes from internal listener maps | |
| `mraid.supports(feature)` | ✅ Supported | Maps to `SHARC.hasFeature(...)` with name translation | See Feature Support Mapping below |
| `mraid.getDefaultPosition()` | ✅ Supported | `env.currentPlacement.initialDefaultSize` | Returns `{x:0, y:0, width, height}` |
| `mraid.getMaxSize()` | ✅ Supported | `env.currentPlacement.maxExpandSize` | Returns `{width, height}` |
| `mraid.getScreenSize()` | ✅ Supported | `env.currentPlacement.viewportSize` | Returns `{width, height}` |
| `mraid.getCurrentPosition()` | ✅ Supported | Updated from `placementChange` events | Returns `{x, y, width, height}` |
| `mraid.isAudioMuted()` | ✅ Supported (MRAID 3.0) | `env.isMuted` from SHARC init | Cached at init; no live update in SHARC v1 |
| `mraid.setExpandProperties(props)` | ✅ Supported | Stored locally; applied on `expand()` | Only `width`/`height` honored; `useCustomClose` is no-op |
| `mraid.getExpandProperties()` | ✅ Supported | Returns stored expand properties object | |
| `mraid.setResizeProperties(props)` | ⏳ Deferred | Stored locally; `resize()` is deferred | See §7 |
| `mraid.getResizeProperties()` | ⏳ Deferred | Returns stored resize properties (stub) | |
| `mraid.resize()` | ⏳ Deferred | Fires `error` event `COMMAND_NOT_SUPPORTED` | See §7 |
| `mraid.setOrientationProperties()` | ❌ Excluded | No-op; accepted silently | OS-level concern; no SHARC equivalent |
| `mraid.getOrientationProperties()` | ❌ Excluded | Returns safe stub `{allowOrientationChange:true, forceOrientation:'none'}` | Does not throw |
| `mraid.storePicture(url)` | ❌ Excluded | Fires `error` event `COMMAND_NOT_SUPPORTED` | Privacy removal; intentional |
| `mraid.createCalendarEvent(params)` | ❌ Excluded | Fires `error` event `COMMAND_NOT_SUPPORTED` | Privacy removal; intentional |
| `mraid.playVideo(url)` | ❌ Excluded | Fires `error` event `COMMAND_NOT_SUPPORTED` | Not a SHARC display ad concern |

### Event Mapping Table

| MRAID Event | Status | SHARC Source | Fire Condition |
|---|---|---|---|
| `ready` | ✅ Supported | SHARC `Container:init` (inside `SHARC.onReady`) | Fires once after SHARC init resolves |
| `stateChange(state)` | ✅ Supported | `SHARC.on('stateChange', ...)` + placement resolve | Fires on any MRAID state change; see §2 |
| `viewableChange(bool)` | ✅ Supported | Derived from `stateChange` | Fires only when viewability flips; no duplicates |
| `sizeChange(width, height)` | ✅ Supported | `SHARC.on('placementChange', ...)` | Fires with new container `width` and `height` |
| `error(message, action)` | ✅ Supported | Generated internally | On unsupported API calls, SHARC action rejections |
| `unload` | ✅ Supported (MRAID 3.0) | `SHARC.on('close', ...)` | Bridge fires `unload` first, then resolves SHARC close |
| `audioVolumeChange(percent)` | ❌ Excluded | No SHARC equivalent in v1 | MRAID 3.0 addition; SHARC v1 has init-time audio state only |

### Feature Support Mapping (`mraid.supports()`)

| MRAID Feature String | `supports()` Return | How Determined |
|---|---|---|
| `"sms"` | Container-dependent | `SHARC.hasFeature('com.iabtechlab.sharc.sms')` |
| `"tel"` | Container-dependent | `SHARC.hasFeature('com.iabtechlab.sharc.tel')` |
| `"calendar"` | Always `false` | Intentionally removed; hardcoded |
| `"storePicture"` | Always `false` | Intentionally removed; hardcoded |
| `"inlineVideo"` | Always `false` | Not a SHARC v1 feature |
| `"vpaid"` | Always `false` | Not applicable to display ads |
| `"location"` | Container-dependent | `SHARC.hasFeature('com.iabtechlab.sharc.location')` |

**Decision:** Features that map to SHARC extension features use a live `hasFeature()` call (synchronous, uses cached init data). Features that are intentionally removed always return `false` without any error or warning. `supports()` never throws — it always returns a boolean.

---

## 4. Bootstrap Sequence

### The Core Challenge

MRAID's bootstrap contract is: **`mraid.js` is available synchronously by the time the creative's first `<script>` runs.** The SHARC SDK, however, boots asynchronously — it sends `createSession`, then waits for `Container:init` before the environment data is known.

The bridge must reconcile these: `window.mraid` must exist synchronously, but the `ready` event can only fire after SHARC's async init completes.

### Injection Order

The container ensures the following script execution order before any creative code runs:

```html
<!-- Injected by MRAIDCompatBridge, before creative markup -->
<script src="/sharc/sharc-protocol.js"></script>
<script src="/sharc/sharc-creative.js"></script>
<script src="/sharc/sharc-mraid-bridge.js"></script>
<!-- Creative code starts loading here -->
```

This matches the classic `mraid.js` contract: the script is available before the creative.

### What Happens on Script Load

`sharc-mraid-bridge.js` runs synchronously when loaded. It:

1. **Creates `window.mraid`** — a complete synchronous object with all MRAID API methods
2. **Sets initial state** to `'loading'`
3. **Registers with `SHARC.onReady()`** — fires when `Container:init` arrives
4. **Registers with `SHARC.onStart()`** — fires when `Container:startCreative` arrives
5. **Subscribes to SHARC events** — `stateChange`, `placementChange`, `close`

```
sharc-mraid-bridge.js loads (synchronous):
   window.mraid = { ... }        ← available immediately, getState() = 'loading'
   SHARC.onReady(bridgeReadyFn)  ← hooks into SHARC lifecycle
   SHARC.onStart(bridgeStartFn)  ← hooks into SHARC lifecycle
   SHARC.on('stateChange', ...)  ← subscribes to container state changes
   SHARC.on('placementChange',.) ← subscribes to placement changes
   SHARC.on('close', ...)        ← maps to mraid 'unload' event

SHARC async handshake (background, started by sharc-creative.js):
   createSession ──────────────────────────►
   ◄───────────── resolve
   Container:init ─────────────────────────►
   ◄───────────── bridgeReadyFn runs:
        → cache _env, compute placement type
        → _sharcState = 'ready'
        → _mraidReady = true
        → fire mraid 'ready' event
        → fire mraid 'stateChange(default)'

   Container:startCreative ────────────────►
   ◄───────────── bridgeStartFn runs:
        → no MRAID equivalent; resolve immediately

   Container:stateChange(active) ──────────►
        → _sharcState = 'active'
        → _isViewable flips to true
        → fire mraid 'viewableChange(true)'
        (state remains 'default' — not 'active'; MRAID has no 'active')
```

### The `ready` Event Race Condition

MRAID specifies that a creative should check `mraid.getState()` on load to guard against missing the `ready` event:

```javascript
// Standard MRAID creative defensive pattern
if (mraid.getState() === 'loading') {
  mraid.addEventListener('ready', onMraidReady);
} else {
  onMraidReady();
}
```

The bridge handles both paths correctly:

- **Normal path:** `Container:init` has not yet arrived when the creative checks. `getState()` returns `'loading'`. Creative registers for `ready`. Bridge fires it later.
- **Race path:** `Container:init` has already been processed before the creative checks (extremely unlikely, but theoretically possible). `getState()` returns `'default'`. Creative calls `onMraidReady()` directly. No event needed. This still works.

The bridge **never fires `ready` synchronously.** It is always deferred to the SHARC `onReady` callback. This matches MRAID 3.0 behavior where `ready` fires asynchronously after `mraid.js` loads.

### Full Sequence Diagram

```
Container                    Creative iframe                 Ad creative code
    │                              │                               │
    │  inject scripts ────────────►│                               │
    │                              │  sharc-protocol.js loads      │
    │                              │  sharc-creative.js loads      │
    │                              │    window.SHARC created       │
    │                              │  sharc-mraid-bridge.js loads  │
    │                              │    window.mraid created       │
    │                              │    getState() = 'loading'     │
    │                              │                               │
    │                              │◄────── ad.js loads ──────────│
    │                              │◄── registers 'ready' cb ─────│
    │                              │    (state='loading', ok)      │
    │                              │                               │
    │◄── createSession ────────────│                               │
    │─── resolve ─────────────────►│                               │
    │─── Container:init ──────────►│                               │
    │                              │  SHARC.onReady callback:      │
    │                              │    cache env                  │
    │                              │    _mraidReady = true         │
    │                              │    fire 'ready' ─────────────►│
    │                              │    fire 'stateChange'         │
    │                              │      ('default') ────────────►│
    │◄── resolve (init) ───────────│                               │
    │                              │                               │
    │─── Container:startCreative ─►│                               │
    │◄── resolve ──────────────────│                               │
    │─── Container:stateChange ───►│                               │
    │       (active)               │  _isViewable = true           │
    │                              │    fire 'viewableChange'      │
    │                              │      (true) ─────────────────►│
```

---

## 5. mraid Object Structure

This is the complete public API surface exposed as `window.mraid`. The implementation exposes exactly these methods — no more, no less.

```javascript
window.mraid = {

  // ─── Version ───────────────────────────────────────────────────────

  /**
   * Returns the MRAID version the bridge presents itself as.
   * Always returns "3.0" — the bridge targets MRAID 3.0 (a superset of 2.0).
   * @returns {string} "3.0"
   */
  getVersion() {},


  // ─── State ─────────────────────────────────────────────────────────

  /**
   * Returns the current MRAID state.
   * Derived from internal _sharcState + _placementMode.
   * Logic: hidden/frozen → 'hidden'; !ready → 'loading'; expanded → 'expanded';
   *        resized → 'resized'; else → 'default'
   * @returns {"loading"|"default"|"expanded"|"resized"|"hidden"}
   */
  getState() {},

  /**
   * Returns whether the ad is currently viewable.
   * True only when _sharcState === 'active'.
   * @returns {boolean}
   */
  isViewable() {},


  // ─── Placement ─────────────────────────────────────────────────────

  /**
   * Returns the placement type of this ad.
   * Source: derived from SHARC EnvironmentData at init time.
   * Mapping: env.data.placement.instl === 1 → 'interstitial'; else → 'inline'
   * Falls back to 'inline' if placement data is absent.
   * @returns {"inline"|"interstitial"}
   */
  getPlacementType() {},

  /**
   * Returns the default position and size of the container.
   * Source: env.currentPlacement.initialDefaultSize
   * x and y are always 0 in the reference implementation (iframe-relative).
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getDefaultPosition() {},

  /**
   * Returns the current position and size of the container.
   * Updated when Container:placementChange is received.
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getCurrentPosition() {},

  /**
   * Returns the maximum size available for expansion.
   * Source: env.currentPlacement.maxExpandSize
   * @returns {{width: number, height: number}}
   */
  getMaxSize() {},

  /**
   * Returns the viewport/screen size.
   * Source: env.currentPlacement.viewportSize
   * @returns {{width: number, height: number}}
   */
  getScreenSize() {},


  // ─── Expand Properties ─────────────────────────────────────────────

  /**
   * Returns the currently stored expand properties.
   * @returns {{width: number, height: number, useCustomClose: boolean, isModal: boolean}}
   */
  getExpandProperties() {},

  /**
   * Stores expand properties for use when expand() is called.
   * Only width and height are acted upon.
   * useCustomClose is stored but ignored (container always provides close; see §6.3).
   * isModal is always true and cannot be set to false.
   * @param {{width?: number, height?: number, useCustomClose?: boolean}} props
   */
  setExpandProperties(props) {},


  // ─── Resize Properties (stored; v2) ────────────────────────────────

  /**
   * Returns the stored resize properties.
   * resize() itself is deferred to v2 — these are stored but not acted upon.
   * @returns {{width: number, height: number, offsetX: number, offsetY: number,
   *            customClosePosition: string, allowOffscreen: boolean}}
   */
  getResizeProperties() {},

  /**
   * Stores resize properties. resize() is deferred to v2.
   * Accepts and stores silently; does not throw.
   * @param {{width: number, height: number, offsetX?: number, offsetY?: number,
   *          customClosePosition?: string, allowOffscreen?: boolean}} props
   */
  setResizeProperties(props) {},


  // ─── Actions ───────────────────────────────────────────────────────

  /**
   * Expands the ad to maximize available space (or to expandProperties dimensions if set).
   *
   * If expandProperties.width and .height are set (> 0):
   *   → SHARC.requestPlacementChange({ intent: 'resize', targetDimensions: {w, h} })
   * Else:
   *   → SHARC.requestPlacementChange({ intent: 'maximize' })
   *
   * On SHARC resolve: _placementMode = 'expanded'; fire stateChange('expanded')
   * On SHARC reject: fire mraid 'error' event
   *
   * The url parameter is NOT supported. If provided, fires error('COMMAND_NOT_SUPPORTED',
   * 'expand') and returns without expanding. This is a MRAID 2.x two-part-expand pattern
   * that cannot be cleanly supported in SHARC — see §6.2.
   *
   * @param {string} [url] — NOT supported; fires error if provided
   */
  expand(url) {},

  /**
   * Collapses the ad back to default placement.
   * Maps to: SHARC.requestPlacementChange({ intent: 'restore' })
   * On resolve: _placementMode = 'default'; fire stateChange('default')
   */
  collapse() {},

  /**
   * Requests the container to close the ad.
   * Maps to: SHARC.requestClose()
   * Container may reject (e.g., minimum display time not yet elapsed).
   * On rejection: bridge does nothing — no error event, no stateChange.
   * The creative's close request was simply declined.
   */
  close() {},

  /**
   * Opens a URL in the device browser or app store.
   * Maps to: SHARC.requestNavigation({ url, target: 'clickthrough' })
   * On SHARC resolve: container handled navigation.
   * On SHARC reject 2105: container cannot handle it; bridge calls window.open(url, '_blank').
   * On SHARC reject other: bridge fires mraid 'error' event.
   * @param {string} url
   */
  open(url) {},

  /**
   * Signals whether the creative uses a custom close button.
   * MRAID 2.0 feature. Accepted silently — no SHARC equivalent.
   * The container always provides its own close control regardless.
   * See Section 6.3 for rationale.
   * @param {boolean} bool - stored but ignored
   */
  useCustomClose(bool) {},

  /**
   * Requests non-fullscreen resize. DEFERRED to v2.
   * Always fires mraid 'error' event with action='resize', message='COMMAND_NOT_SUPPORTED'.
   * setResizeProperties() may be called without error, but resize() itself fails in v1.
   */
  resize() {},


  // --- Audio (MRAID 3.0) ---

  /**
   * Returns whether device audio is muted.
   * Source: env.isMuted from SHARC Container:init.
   * Init-time value only — SHARC v1 has no live audio update.
   * Returns false if env.isMuted was undefined.
   * @returns {boolean}
   */
  isAudioMuted() {},


  // --- Feature Detection ---

  /**
   * Returns whether a named MRAID feature is supported.
   * See Section 3 Feature Support Mapping for full translation table.
   * Never throws. Always returns boolean.
   * @param {string} feature
   * @returns {boolean}
   */
  supports(feature) {},


  // --- Events ---

  /**
   * Registers a listener for a named MRAID event.
   * Supported: 'ready', 'stateChange', 'viewableChange', 'sizeChange', 'error', 'unload'
   * Registering for any other event name is accepted silently (no error, no effect).
   * Multiple listeners per event are supported.
   * @param {string} event
   * @param {Function} listener
   */
  addEventListener(event, listener) {},

  /**
   * Removes a previously registered listener.
   * If listener is not found, does nothing (no error).
   * @param {string} event
   * @param {Function} listener
   */
  removeEventListener(event, listener) {},


  // --- Excluded / Stubbed Methods ---

  /**
   * EXCLUDED. Always fires mraid 'error' event.
   * message: 'COMMAND_NOT_SUPPORTED', action: 'storePicture'
   */
  storePicture(url) {},

  /**
   * EXCLUDED. Always fires mraid 'error' event.
   * message: 'COMMAND_NOT_SUPPORTED', action: 'createCalendarEvent'
   */
  createCalendarEvent(params) {},

  /**
   * EXCLUDED. Returns a safe stub. Does NOT fire an error.
   * Returns: { allowOrientationChange: true, forceOrientation: 'none' }
   * Rationale: some creatives read this without acting on it; throwing would break them.
   */
  getOrientationProperties() {},

  /**
   * EXCLUDED. Accepted silently. No-op. Does NOT fire an error.
   * Rationale: many creatives call setOrientationProperties defensively;
   * silently ignoring it is the safest approach for compatibility.
   * @param {Object} props
   */
  setOrientationProperties(props) {},

};
```

### Internal Bridge State

The bridge maintains the following private state (not exposed on `window.mraid`):

```javascript
// Private to sharc-mraid-bridge.js module scope
const _state = {
  _sharcState:      'loading',   // Last SHARC state: 'ready'|'active'|'passive'|'hidden'|'frozen'
  _placementMode:   'default',   // 'default' | 'expanded' | 'resized'
  _mraidReady:      false,       // true after SHARC Container:init has been processed
  _isViewable:      false,       // Cached; changes trigger viewableChange event
  _env:             null,        // SHARC EnvironmentData from Container:init
  _placementType:   'inline',    // 'inline' | 'interstitial' — derived at init
  _listeners:       {},          // Map of eventName -> [Function, ...]
  _expandProps: {
    width:           -1,
    height:          -1,
    useCustomClose:  false,
    isModal:         true,
  },
  _resizeProps: {
    width:                0,
    height:               0,
    offsetX:              0,
    offsetY:              0,
    customClosePosition:  'top-right',
    allowOffscreen:       true,
  },
  _currentPosition: { x: 0, y: 0, width: 0, height: 0 },
};
```

---

## 6. Key Design Decisions

### 6.1 Placement Type Derivation

**Decision: Derive `getPlacementType()` from AdCOM `placement.instl`.**

SHARC carries AdCOM placement data in `env.data.placement`. AdCOM's `instl` field indicates interstitial:

```javascript
function derivePlacementType(env) {
  const placement = env && env.data && env.data.placement;
  if (!placement) return 'inline';
  return placement.instl === 1 ? 'interstitial' : 'inline';
}
```

Default to `'inline'` when AdCOM data is absent. Inline is the right default — guessing interstitial when it's actually inline would be more dangerous than the reverse.

**Alternative considered:** Inferring interstitial from `env.currentPlacement` dimensions relative to viewport size. Rejected — this is fragile heuristics. The AdCOM field is definitive.

### 6.2 The `expand(url)` Problem

MRAID 2.x supported a two-part expand model: `mraid.expand(url)` would load a *different* creative HTML document into the expanded panel. This was always awkward and never widely adopted.

**Decision: `expand(url)` with a URL argument is not supported. Bridge fires an error.**

If the creative calls `mraid.expand()` without a URL (the common case), the bridge expands normally. If a URL string is passed, the bridge fires an error event and returns without expanding.

```javascript
_emit('error', 'Two-part expand (expand URL) is not supported by this bridge', 'expand');
```

**Rationale:** Supporting two-part expand would require the container to load a second creative document and manage two SHARC sessions simultaneously. This is architecturally incompatible with SHARC v1's single-session model. This is permanently excluded, not deferred.

### 6.3 `useCustomClose()` — Accept, Ignore

MRAID 2.0 allowed creatives to signal that they would supply their own close button, replacing the container's. This was consistently problematic — creatives could hide the system close button, leaving users with no way out.

SHARC makes a deliberate architectural decision: **the container always provides the close control.** The creative may supplement with its own close UI, but cannot replace the container's.

**Decision: `mraid.useCustomClose(bool)` is a no-op. Store the value for `getExpandProperties()` consistency, but ignore it.**

This means some MRAID creatives that relied on `useCustomClose(true)` to suppress the container's default close will show two close buttons. This is acceptable. Hiding the container's close control is not.

### 6.4 `mraid.close()` Rejection Handling

MRAID 2.0 specified that `mraid.close()` always works. SHARC's `requestClose()` can be rejected by the container (e.g., minimum display duration has not elapsed).

**Decision: When SHARC `requestClose()` is rejected, the bridge fires no error event and takes no further action.**

The creative called `close()` and the container said no. From the creative's perspective, the close simply didn't happen. Firing an MRAID error event would be semantically incorrect (it's not a programming error) and would confuse creatives that don't expect `close()` to fail. The container is in control of close timing. This is correct SHARC behavior.

### 6.5 Event Ordering: `stateChange` Before `viewableChange`

The MRAID `ready` event fires once. After that, `stateChange` and `viewableChange` are the two events creatives monitor. They overlap: every `viewableChange` is also a `stateChange`, but not every `stateChange` is a `viewableChange`.

**Decision:** The bridge fires `stateChange` first, then evaluates whether viewability changed, and fires `viewableChange` if it did. Never the other way around.

Ordering matters because some MRAID creatives call `isViewable()` inside the `stateChange` handler. By updating `_isViewable` before firing either event, both methods return consistent state regardless of call order.

### 6.6 MRAID Version — Always "3.0"

The bridge always returns `"3.0"` from `getVersion()`.

**Rationale:** MRAID 3.0 is a strict superset of 2.0. All 2.0 creatives work correctly with a `"3.0"` version string. Returning `"2.0"` would suppress any creative code that checks for 3.0 features like `isAudioMuted()`. `"3.0"` is accurate — the bridge provides the full 3.0 API surface.

### 6.7 Error Event Format

MRAID `error` events carry `(message, action)`. The bridge fires this consistently using MRAID-conventional uppercase constants where applicable:

- `'COMMAND_NOT_SUPPORTED'` — for `storePicture`, `createCalendarEvent`, `playVideo`, `resize()`, `expand(url)`
- Descriptive string — for SHARC rejection errors (e.g., `'Expand rejected by container'`)

---

## 7. Deferred to v2

### 7.1 `mraid.resize()` — Deferred

**What it is:** MRAID `resize()` (with `setResizeProperties()`) resizes to an arbitrary non-fullscreen size with offsets, anchor points, and optional off-screen positioning.

**Why deferred:** SHARC `requestPlacementChange` supports the equivalent (`intent: 'resize'` with `targetDimensions`), but the MRAID resize model includes properties with no direct SHARC mapping:

- `offsetX` / `offsetY` — position relative to default position (SHARC uses absolute coordinates)
- `allowOffscreen` — MRAID allowed partial off-screen positioning; SHARC containers constrain to viewport
- `customClosePosition` — 6 named positions for a custom close button; no SHARC equivalent

Partial support with silent property truncation creates subtle behavior differences that are worse than a clean unsupported error. v1 ships with `resize()` explicitly unsupported.

**v1 behavior:** `resize()` fires `error('COMMAND_NOT_SUPPORTED', 'resize')`. `setResizeProperties()` and `getResizeProperties()` work correctly (store/retrieve) so creative code that calls them without calling `resize()` does not break.

**v2 plan:** Implement using `requestPlacementChange({ intent: 'resize', targetDimensions })`. Map offsets to container-relative positioning as a SHARC extension. Deprecate `allowOffscreen` (containers clip to viewport). Treat `customClosePosition` as a SHARC close-button-positioning extension.

### 7.2 `audioVolumeChange` Event — Deferred

**What it is:** MRAID 3.0 `audioVolumeChange(percent)` fires when device volume changes during ad display.

**Why deferred:** SHARC v1 provides audio state (`isMuted`, `volume`) only at init time. There is no runtime audio state update mechanism. The bridge would need to poll the Web Audio API or use the proprietary `volumechange` DOM event — neither works reliably in a sandboxed cross-origin iframe.

**v2 plan:** Design a `com.iabtechlab.sharc.audio` SHARC extension that provides live audio state updates, then map that to `audioVolumeChange` in the bridge.

### 7.3 `mraid.expand(url)` Two-Part Expand — Permanently Excluded

Not deferred — permanently out of scope. The two-part expand pattern requires loading a separate creative document into the expanded container, which is architecturally incompatible with SHARC's single-session model. Creatives using this feature must be rewritten.

### 7.4 Orientation Properties — Permanently Excluded

Orientation management is an OS-level concern. SHARC explicitly deferred this in v1. The bridge stubs `getOrientationProperties()` with a safe return value and silently accepts `setOrientationProperties()`. Not planned for the bridge unless SHARC adds a first-class orientation extension.

---

## 8. Implementation Notes for the Developer

### 8.1 File Structure

The deliverable is two exports from one file:

```javascript
// sharc-mraid-bridge.js

export class MRAIDCompatBridge { ... }
// Container-side extension plugin. Tells the container to inject bridge scripts
// and advertises the com.iabtechlab.sharc.mraid feature in Container:init.

export function installMRAIDBridge(sharcSDK) { ... }
// Called automatically on script load in the browser.
// Takes a SHARC SDK reference (window.SHARC) and installs window.mraid.
// Also available for explicit installation in test environments.
```

CommonJS compatibility:
```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MRAIDCompatBridge, installMRAIDBridge };
}
```

### 8.2 Don't Reinvent Event Management

The SHARC SDK (`window.SHARC`) already has its own event system (`SHARC.on`). The bridge's internal `_listeners` map is for MRAID events only — separate from SHARC events. Do not route MRAID events through `SHARC.on`. They are independent systems.

```javascript
// Internal helper: emit an MRAID event to all registered listeners
function _emit(event, ...args) {
  const listeners = _state._listeners[event] || [];
  listeners.forEach(fn => {
    try { fn(...args); } catch(e) { /* swallow — don't break other listeners */ }
  });
}
```

Swallow listener exceptions. An error in one MRAID creative listener must not prevent others from receiving the event.

### 8.3 `SHARC.onReady` Must Resolve Quickly

The bridge's `SHARC.onReady` callback participates in the SHARC init sequence. The container waits for this Promise to resolve before sending `Container:startCreative`. Resolve it immediately after caching env data and firing MRAID events. Do not await creative MRAID handlers — they are synchronous callbacks.

```javascript
SHARC.onReady(async (env, features) => {
  _state._env = env;
  _state._placementType = derivePlacementType(env);
  _state._currentPosition = {
    x: 0, y: 0,
    width: env.currentPlacement.initialDefaultSize.width,
    height: env.currentPlacement.initialDefaultSize.height,
  };
  _state._mraidReady = true;
  _state._sharcState = 'ready';

  // Fire MRAID events synchronously
  _emit('ready');
  _emit('stateChange', 'default');

  // Resolve immediately — SHARC container is waiting on this Promise
});
```

### 8.4 The `stateChange` / `viewableChange` Ordering Contract

Always update internal state BEFORE firing events. Creatives may call `mraid.getState()` or `mraid.isViewable()` synchronously inside an event handler — state must be consistent at that moment.

```javascript
SHARC.on('stateChange', (sharcState) => {
  const prevViewable = _state._isViewable;

  // 1. Update internal state FIRST
  _state._sharcState = sharcState;
  _state._isViewable = (sharcState === 'active');

  // 2. Derive MRAID state from updated internals
  const mraidState = getMraidState();  // uses _sharcState + _placementMode

  // 3. Fire stateChange first
  _emit('stateChange', mraidState);

  // 4. Fire viewableChange ONLY if viewability actually flipped
  if (_state._isViewable !== prevViewable) {
    _emit('viewableChange', _state._isViewable);
  }
});
```

Do not fire `viewableChange` for `frozen` transitions. JS is suspended at that point — the creative cannot process the event anyway.

### 8.5 Handling `collapse()` When Not Expanded

MRAID spec says `collapse()` in `default` state is a no-op. Guard against it:

```javascript
mraid.collapse = function() {
  if (_state._placementMode === 'default') return;
  SHARC.requestPlacementChange({ intent: 'restore' }).then(() => {
    _state._placementMode = 'default';
    _emit('stateChange', 'default');
  }).catch(err => {
    _emit('error', 'Collapse rejected by container: ' + err.message, 'collapse');
  });
};
```

Similarly, `expand()` when `_placementMode === 'expanded'` should be a no-op — don't fire events or make SHARC calls.

### 8.6 `open(url)` — Navigation Handoff

The SHARC reject code 2105 means "creative, you handle it" — not an error:

```javascript
mraid.open = function(url) {
  SHARC.requestNavigation({ url, target: 'clickthrough' })
    .catch(err => {
      if (err && err.errorCode === 2105) {
        window.open(url, '_blank');  // Web: browser handles it
      } else {
        _emit('error', 'Navigation failed: ' + (err && err.message), 'open');
      }
    });
};
```

On native iOS/Android, SHARC resolves and the container handles the URL. On web, SHARC rejects with 2105, and the bridge opens the URL itself. This matches the behavior documented in `mraid-migration.md`.

### 8.7 Pre-Ready Return Values

Some methods depend on data available only after `Container:init`. Return safe zeroed-out objects (not `null`, not throws) if called before `ready`:

| Method | Pre-ready return value |
|--------|----------------------|
| `getDefaultPosition()`, `getCurrentPosition()` | `{x:0, y:0, width:0, height:0}` |
| `getMaxSize()`, `getScreenSize()` | `{width:0, height:0}` |
| `isAudioMuted()` | `false` |
| `getPlacementType()` | `'inline'` |

This matches MRAID 2.0 behavior where these values were undefined before `ready`. Returning zeroed-out objects is safer than returning `null`.

### 8.8 The `unload` Event and Close Handling

The MRAID 3.0 `unload` event maps to SHARC's `Container:close`. Wire it via `SHARC.on('close')`:

```javascript
SHARC.on('close', () => {
  _emit('unload');
  // sharc-creative.js handles the 1.8s watchdog and resolves Container:close.
  // The bridge only fires the MRAID unload event here and returns.
  // No close timing management needed in the bridge.
});
```

The SHARC SDK's `_handleClose()` manages all watchdog mechanics. The bridge simply fires `unload` and returns.

### 8.9 Singleton Guard

If `sharc-mraid-bridge.js` loads twice (defensive only — injection mechanism should prevent this), the second load must detect the existing installation:

```javascript
if (window.mraid && window.mraid._sharcBridgeInstalled) {
  // Already installed; bail out silently
} else {
  installMRAIDBridge(window.SHARC);
  window.mraid._sharcBridgeInstalled = true;
}
```

### 8.10 Key Test Cases

The bridge has clean seams for unit testing via a mock SHARC SDK passed to `installMRAIDBridge(mockSHARC)`.

| Test | Expected Behavior |
|------|-------------------|
| `ready` event timing | Fires exactly once, after SHARC init, never synchronously on load |
| `getState()` before ready | Returns `'loading'` |
| `getState()` after ready, no expand | Returns `'default'` |
| SHARC `active` state | `getState()` = `'default'`; `isViewable()` = `true` |
| SHARC `passive` state | `getState()` = `'default'`; `isViewable()` = `false`; `viewableChange(false)` fires |
| SHARC `hidden` state | `getState()` = `'hidden'`; `viewableChange(false)` fires if was viewable |
| SHARC `frozen` state | `getState()` = `'hidden'`; no `viewableChange` fired (already false) |
| Expand resolves | `getState()` = `'expanded'`; `stateChange('expanded')` fired |
| Collapse resolves | `getState()` = `'default'`; `stateChange('default')` fired |
| `expand()` called twice | Second call is no-op; no duplicate events, no SHARC call |
| `collapse()` when default | No-op; no events fired, no SHARC call |
| `expand(url)` with URL arg | Error event fires; no expand occurs |
| `close()` rejected by SHARC | No error event; no stateChange |
| `open(url)` on web (SHARC 2105) | `window.open(url, '_blank')` called |
| `storePicture()` | Error: `'COMMAND_NOT_SUPPORTED'`, action `'storePicture'` |
| `resize()` | Error: `'COMMAND_NOT_SUPPORTED'`, action `'resize'` |
| `supports('calendar')` | Returns `false` always |
| `supports('sms')` | Returns result of `SHARC.hasFeature('com.iabtechlab.sharc.sms')` |
| `viewableChange` dedup | Does not fire if viewability was already false |
| `mraid` singleton guard | Second script load does not reinstall or double-fire events |

### 8.11 What NOT to Do

- **Do not** call `SHARC._sdk` or any private SHARC SDK internals. Use only the public `SHARC.*` API.
- **Do not** intercept or proxy `MessageChannel` messages. All SHARC protocol is handled by `sharc-creative.js`.
- **Do not** add `window.mraid.STATES` or `window.mraid.EVENTS` constants. Creatives hardcode the strings; adding them is future scope if needed.
- **Do not** implement `mraidenv`. This MRAID 3.0 environment object overlaps with SHARC's `EnvironmentData` delivery model and is not needed for creative compatibility.
- **Do not** fire `stateChange` for SHARC-internal states `loading` or `terminated`. These are container-internal and are never sent to the creative.
- **Do not** fire duplicate `ready` events. Track `_mraidReady` and guard the emission.
- **Do not** swallow all exceptions silently in bridge internals — only in MRAID listener invocations. Bridge logic errors should surface to the console.

---

*End of document. Ready for Jeffrey's review.*
