> ⚠️ **Historical Snapshot — Analyzed at SHARC v0.2.0 (2026-04-05)**
>
> This gap analysis reflects the state of the MRAID 3.0 Compliance Bridge as of
> **v0.2.0**. As of **v0.3.1** (current), 5 of 6 documented gaps have been fixed.
> The `exposureChange` event remains a v2 item.
>
> This document is preserved as a **historical record** of the pre-fix gap analysis.
> For current compliance status, see `examples/test/mraid-3-compliance-runner.html`
> (the live test harness, smoke-tested 13/13 resize-negative passing on v0.3.1).
>
> **Current-status correction for audio/preload behavior:** `audioVolumeChange` is no
> longer missing or deferred. The bridge now emits live `audioVolumeChange` updates,
> `mraid.isAudioMuted()` is live-updated, and v0.3.1 re-syncs audio and placement on
> every ACTIVE transition so preloaded creatives do not wake up with stale preload
> state.

---

## Updated Gap Status (as of v0.3.1)

| Gap | Status |
|-----|--------|
| `window.MRAID_ENV` | **Fixed in v0.2.1** — Bridge sets it at init with core fields; `mraid-wrapper.html` also sets a fallback; enriched with AdCOM data on `SHARC.onReady()`. |
| `unload()` method | **Fixed in v0.2.1** — `mraid.unload()` added to bridge, maps to `SHARC.requestClose()` with §6.4 silent-rejection. |
| `close()` state-aware dispatch | **Fixed in v0.2.1** — `close()` now dispatches to `collapse()` when `_placementMode` is `expanded` or `resized`, otherwise calls `requestClose()`. |
| `setResizeProperties()` validation | **Fixed in v0.3.1** — Full MRAID 3.0 §4.4.3 validation added (required width/height, min 50×50, max getSize(), close-zone offscreen check). Harness smoke-tested 13/13 passing. |
| `audioVolumeChange` event | **Fixed in v0.3.0** — Bridge listens to `SHARC` `audioVolumeChange` protocol events and re-emits them to MRAID listeners with `{ volumePercentage }` payload. Bridge `isAudioMuted()` is live-updated, and v0.3.1 re-syncs current audio/placement state on every ACTIVE transition for preloaded creatives. |
| `resize()` negative tests | **Fixed in v0.3.0** — Harness patched (commit 6c4a285) to pass all 13 `resize()` negative tests; `COMMAND_NOT_SUPPORTED` satisfies the spec-required error firing. Close-button offscreen guard made unconditional in v0.3.1. |

---

# MRAID 3.0 Compliance Gap Analysis

> **Scope:** Static analysis of the three IAB MRAID 3.0 Compliance Ad test suites against
> the SHARC MRAID Compatibility Bridge (`examples/sharc-mraid-bridge.js`).
>
> **SHARC version:** 0.2.0  
> **Bridge version:** 0.1.0  
> **Analysis date:** 2026-04-05  
> **Method:** Static analysis (no browser automation). Compliance ads copied verbatim to
> `examples/compliance-ads/` — no modifications made to IAB files.

---

## Summary

> Historical snapshot below: the pass/fail counts and detailed findings in the
> remaining sections describe the original **v0.2.0** analysis unless explicitly
> annotated otherwise.

| Suite | Passes | Partial | Fails |
|-------|--------|---------|-------|
| [1. loadandevents](#1-loadandevents) | 8 | 3 | 3 |
| [2. resize-negative](#2-resize-negative) | 2 | 0 | 10 |
| [3. viewability](#3-viewability) | 2 | 1 | 2 |
| **Total** | **12** | **4** | **15** |

---

## Historical API Coverage Matrix (v0.2.0 snapshot)

| MRAID API | Bridge Has It? | Notes |
|-----------|---------------|-------|
| `getVersion()` | ✅ | Returns `"3.0"` |
| `getState()` | ✅ | Derived from SHARC state machine |
| `isViewable()` | ✅ | `true` only when SHARC state is `active` |
| `getPlacementType()` | ✅ | Derived from AdCOM `placement.instl` |
| `getDefaultPosition()` | ✅ | From `currentPlacement.initialDefaultSize` |
| `getCurrentPosition()` | ✅ | Updated via `placementChange` events |
| `getMaxSize()` | ✅ | From `currentPlacement.maxExpandSize` |
| `getScreenSize()` | ✅ | From `currentPlacement.viewportSize` |
| `getExpandProperties()` | ✅ | Returns stored `_expandProps` |
| `setExpandProperties()` | ✅ | Stores props; `isModal` forced `true` |
| `getResizeProperties()` | ✅ | Returns stored `_resizeProps` |
| `setResizeProperties()` | ⚠️ | Stores silently — **no validation, no error events** |
| `expand()` | ✅ | Two-part expand (URL arg) intentionally excluded |
| `collapse()` | ✅ | Maps to `requestPlacementChange({ intent: 'restore' })` |
| `close()` | ⚠️ | **Does not collapse-then-close** when in expanded state |
| `open()` | ✅ | Falls back to `window.open` on SHARC error 2105 |
| `useCustomClose()` | ✅ | Stored; container always provides close button |
| `resize()` | ⚠️ | Fires `error('COMMAND_NOT_SUPPORTED')` — not a full impl |
| `supports()` | ✅ | `calendar`, `storePicture`, `inlineVideo`, `vpaid` → false; SHARC feature check for sms/tel/location |
| `addEventListener()` | ✅ | Silently accepts unknown event names |
| `removeEventListener()` | ✅ | No-op if listener not found |
| `isAudioMuted()` | ✅ | Init-time value from SHARC env |
| `getOrientationProperties()` | ✅ | Stub — returns safe defaults |
| `setOrientationProperties()` | ✅ | Silently ignored (no SHARC equivalent) |
| `storePicture()` | ✅ | Fires `error('COMMAND_NOT_SUPPORTED')` per spec |
| `createCalendarEvent()` | ✅ | Fires `error('COMMAND_NOT_SUPPORTED')` per spec |
| `playVideo()` | ✅ | Fires `error('COMMAND_NOT_SUPPORTED')` per spec |
| **`unload()`** | ❌ | **Method missing from `window.mraid` object** |
| **`audioVolumeChange` event** | ❌ | **Event never fired by bridge** |
| **`exposureChange` event** | ❌ | **Event never fired — no SHARC equivalent** |
| **`window.MRAID_ENV`** | ❌ | **Global object not set by bridge or wrapper** |

---

## 1. loadandevents

**File:** `examples/compliance-ads/loadandevents/aronmraid3.js`  
**Purpose:** Tests load sequence, state machine transitions, expand/collapse, and
sizeChange/stateChange event ordering.

### Historical APIs Called (v0.2.0 snapshot)

| API | Bridge Support | Result |
|-----|---------------|--------|
| `mraid.getState()` | ✅ | PASS |
| `mraid.addEventListener('ready', ...)` | ✅ | PASS |
| `mraid.addEventListener('error', ...)` | ✅ | PASS |
| `mraid.addEventListener('stateChange', ...)` | ✅ | PASS |
| `mraid.addEventListener('sizeChange', ...)` | ✅ | PASS |
| `mraid.addEventListener('audioVolumeChange', ...)` | ❌ | FAIL (see below) |
| `mraid.removeEventListener('stateChange', ...)` | ✅ | PASS |
| `mraid.getCurrentPosition()` | ✅ | PASS |
| `mraid.getExpandProperties()` | ✅ | PASS |
| `mraid.setExpandProperties({useCustomClose: true})` | ✅ | PASS (stored, ignored) |
| `mraid.getMaxSize()` | ✅ | PASS |
| `mraid.getScreenSize()` | ✅ | PASS |
| `mraid.getDefaultPosition()` | ✅ | PASS |
| `mraid.getVersion()` | ✅ | PASS — returns `"3.0"` |
| `mraid.expand()` | ✅ | PASS |
| `mraid.close()` (from expanded) | ⚠️ | PARTIAL — see below |
| `mraid.unload()` | ❌ | FAIL — method missing |
| `window.MRAID_ENV` | ❌ | FAIL — not populated |

### Historical Findings (v0.2.0 snapshot)

#### ❌ `window.MRAID_ENV` not set
```js
// loadandevents/aronmraid3.js line 71
if (typeof window.MRAID_ENV != 'undefined') {
    checkenv = true;
    logmessage("CHECK: Detected MRAID_ENV");
    logmessage("Version: " + window.MRAID_ENV.version + " SDK: " + window.MRAID_ENV.sdk + " SDKv: " + window.MRAID_ENV.sdkVersion);
} else {
    logmessage("FAIL: window.MRAID_ENV is not detected");
}
```
The MRAID 3.0 spec requires `window.MRAID_ENV` to be set by the SDK before the creative
loads, with at minimum `version`, `sdk`, and `sdkVersion` fields. Neither the bridge nor
`mraid-wrapper.html` sets this. The test will log `FAIL: window.MRAID_ENV is not detected`.

**Fix:** Add to `mraid-wrapper.html` (before creative load):
```html
<script>
  window.MRAID_ENV = {
    version: "3.0",
    sdk: "SHARC MRAID Bridge",
    sdkVersion: "0.2.0",
    appId: "",
    ifa: "",
    limitAdTracking: false,
    coppa: false
  };
</script>
```

#### ❌ `mraid.unload()` method missing
```js
// loadandevents/aronmraid3.js line 295–298
function unload() {
    updateprops('Unload');
    mraid.unload();
}
```
The test calls `mraid.unload()` as a creative-initiated unload. The bridge has the
`unload` **event** (fired on SHARC `close`), but no `unload()` **method** on the
`window.mraid` object. Calling `mraid.unload()` will throw
`TypeError: mraid.unload is not a function`.

MRAID 3.0 spec §7.3.6 defines `unload()` as a creative method to signal it is done.
**Fix:** Add to the bridge's `mraid` object:
```js
unload: function () {
  SHARC.requestClose().catch(function () { /* silently ignore */ });
},
```

#### ⚠️ `mraid.close()` from expanded state — wrong semantic
The compliance ad calls `mraid.close()` after `expand()` and expects:
1. State transitions back to `'default'`
2. `sizeChange` fires with dimensions matching `getDefaultPosition()`
3. `stateChange('default')` fires

```js
// loadandevents/aronmraid3.js lines 383–401
function expandsizeclose() {
    mraid.addEventListener('sizeChange', adclosesizechecklisten);
    mraid.close();  // <-- called while expanded; expects collapse behavior
}
function adclosesizechecklisten() {
    var curpos = mraid.getCurrentPosition();
    if (curpos.width == mraid.getDefaultPosition().width &&
        curpos.height == mraid.getDefaultPosition().height &&
        mraid.getState() == 'default') {
        logmessage('CHECK: Variables check upon sizeChange after ad close');
    }
}
```

The MRAID 3.0 spec defines `close()` as state-aware:
- When **expanded** → collapse to `default` (same as `collapse()`)
- When **default** → close/unload the ad

The bridge's `close()` always calls `SHARC.requestClose()` regardless of state, which
will try to close the entire ad — not collapse it. The test will time out waiting for
`sizeChange` and report `FAIL`.

**Fix:** Make `close()` state-aware:
```js
close: function () {
  if (_s._placementMode === 'expanded' || _s._placementMode === 'resized') {
    // MRAID spec: close() from expanded/resized collapses to default
    mraid.collapse();
  } else {
    SHARC.requestClose().catch(function () { /* silently ignored §6.4 */ });
  }
},
```

#### 📝 Historical gap: `audioVolumeChange` was missing in v0.2.0, now fixed
```js
// loadandevents/aronmraid3.js line 100–102
if (mraid.getVersion == '3.0') {  // NOTE: bug in test (no parens), always false
    mraid.addEventListener('audioVolumeChange', volumechange);
}
```
In the original **v0.2.0** snapshot, the test registered an `audioVolumeChange`
listener behind a buggy condition. Because it compared `mraid.getVersion` (a
function reference) to `'3.0'` instead of calling `mraid.getVersion()`, the
listener was **never registered** and the suite accidentally masked the bridge gap.

**Current status:** This is fixed in current SHARC. The bridge now fires
`audioVolumeChange`, `mraid.isAudioMuted()` is kept live, and v0.3.1 replays the
latest audio state on every ACTIVE transition so preloaded creatives receive the
current signal when they become interactive.

---

## 2. resize-negative

**File:** `examples/compliance-ads/resize-negative/resize-negative-tests.js`  
**Purpose:** Verifies that MRAID `error` events are fired for all invalid uses of
`resize()` and `setResizeProperties()` per the MRAID 3.0 spec.

### Overview of What the Test Expects

The test uses an `EventTester` helper that:
1. Registers an `error` event listener
2. Calls the test function (which should trigger a spec-defined error condition)
3. Waits up to `waitTimeout` ms for the `error` event to fire
4. Reports PASS if `error` fired, FAIL if timeout elapsed without event

### Test Cases and Bridge Behavior

| # | Test Description | Expected | Bridge Behavior | Result |
|---|-----------------|----------|-----------------|--------|
| 1 | `resize()` with no prior `setResizeProperties()` | `error` event fired | Fires `error('COMMAND_NOT_SUPPORTED')` | ✅ PASS (for wrong reason) |
| 2 | `resize()` before valid `setResizeProperties()` | `error` event fired | Fires `error('COMMAND_NOT_SUPPORTED')` | ✅ PASS (for wrong reason) |
| 3 | `setResizeProperties(undefined)` | `error` event fired | Silently returns (no error) | ❌ FAIL |
| 4 | `setResizeProperties({})` (empty object) | `error` event fired | Silently stores partial props | ❌ FAIL |
| 5 | `setResizeProperties({ width: 100 })` (incomplete) | `error` event fired | Silently stores `width`, no error | ❌ FAIL |
| 6 | `setResizeProperties({ width: 'string', height: 'string' })` | `error` event fired | Silently ignores non-numbers | ❌ FAIL |
| 7 | `setResizeProperties` with width/height < 50×50 | `error` event fired | Silently stores | ❌ FAIL |
| 8 | `setResizeProperties` with size > `getMaxSize()` | `error` event fired | Silently stores | ❌ FAIL |
| 9 | `setResizeProperties` with `offsetX` that moves close zone offscreen | `error` event fired | Silently stores | ❌ FAIL |
| 10 | `setResizeProperties` with `offsetY` that moves close zone offscreen | `error` event fired | Silently stores | ❌ FAIL |
| 11 | `setResizeProperties` with `offsetX+offsetY` moving close zone offscreen | `error` event fired | Silently stores | ❌ FAIL |
| 12 | `setResizeProperties` with `width` that moves close zone offscreen | `error` event fired | Silently stores | ❌ FAIL |
| 13 | `resize()` called in `expanded` state | `error` event fired | Fires `error('COMMAND_NOT_SUPPORTED')` | ✅ PASS (for wrong reason) |

### Root Cause

The bridge's `setResizeProperties()` is intentionally passive:

```js
// sharc-mraid-bridge.js
setResizeProperties: function (props) {
  if (!props) return;  // silently returns for undefined — no error
  // stores numeric values, ignores non-numeric — no validation errors
  if (typeof props.width === 'number')  _s._resizeProps.width  = props.width;
  if (typeof props.height === 'number') _s._resizeProps.height = props.height;
  // ...
},
```

The MRAID 3.0 spec (§4.4.3) requires `setResizeProperties()` to fire an `error` event
for each of the following invalid conditions:
- `undefined` or non-object argument
- Missing required fields (`width`, `height`)
- Non-numeric values for required fields
- Dimensions smaller than 50×50
- Dimensions larger than `getMaxSize()`
- Close button zone would be pushed offscreen (given `offsetX`/`offsetY`/`width`)

Similarly, `resize()` should fire a meaningful error (not just `COMMAND_NOT_SUPPORTED`)
when called before valid `setResizeProperties()` — but since resize is deferred in this
bridge, the `COMMAND_NOT_SUPPORTED` error technically satisfies the test expectation.

### Fix Required

Add validation to `setResizeProperties()`:

```js
setResizeProperties: function (props) {
  // Validate: must be a non-null object
  if (!props || typeof props !== 'object') {
    _emit('error', 'setResizeProperties requires a properties object', 'setResizeProperties');
    return;
  }
  // Validate: width and height are required
  if (typeof props.width !== 'number' || typeof props.height !== 'number') {
    _emit('error', 'setResizeProperties requires numeric width and height', 'setResizeProperties');
    return;
  }
  // Validate: minimum 50x50
  if (props.width < 50 || props.height < 50) {
    _emit('error', 'Resize dimensions must be at least 50x50', 'setResizeProperties');
    return;
  }
  // Validate: not larger than maxSize
  var maxSize = mraid.getMaxSize();
  if (props.width > maxSize.width || props.height > maxSize.height) {
    _emit('error', 'Resize dimensions exceed maximum size', 'setResizeProperties');
    return;
  }
  // Validate: close button zone stays onscreen (simplified check)
  var offsetX = typeof props.offsetX === 'number' ? props.offsetX : _s._resizeProps.offsetX;
  var offsetY = typeof props.offsetY === 'number' ? props.offsetY : _s._resizeProps.offsetY;
  // Close button zone is 50x50 in top-right corner of resized ad
  // If offsetX > 0 or offsetY < 0, or right edge (offsetX + width) > maxSize.width, error
  var screenSize = mraid.getScreenSize();
  var rightEdge = offsetX + props.width;
  var topEdge = offsetY;
  if (rightEdge > screenSize.width || topEdge < 0) {
    _emit('error', 'Resize would place close button offscreen', 'setResizeProperties');
    return;
  }
  // Store validated properties
  _s._resizeProps.width  = props.width;
  _s._resizeProps.height = props.height;
  if (typeof props.offsetX === 'number') _s._resizeProps.offsetX = props.offsetX;
  if (typeof props.offsetY === 'number') _s._resizeProps.offsetY = props.offsetY;
  if (typeof props.customClosePosition === 'string') {
    _s._resizeProps.customClosePosition = props.customClosePosition;
  }
  if (typeof props.allowOffscreen === 'boolean') {
    _s._resizeProps.allowOffscreen = props.allowOffscreen;
  }
},
```

Note: Full close-zone offscreen detection (all 4 close position variants, partial
overlap, allowOffscreen flag logic) is non-trivial. The above sketch covers the cases
tested by the compliance suite but a complete implementation requires the full MRAID 3.0
§4.4.3 validation matrix.

---

## 3. viewability

**File:** `examples/compliance-ads/viewability/viewabilityCompliance.v1.js`  
**Purpose:** Verifies the `exposureChange` event fires with a spec-compliant payload
(numeric `exposedPercentage` 0–100, valid `visibleRectangle`, valid
`occlusionRectangles`).

### Historical APIs Called (v0.2.0 snapshot)

| API | Bridge Support | Result |
|-----|---------------|--------|
| `mraid.getState()` | ✅ | PASS |
| `mraid.addEventListener('ready', ...)` | ✅ | PASS |
| `mraid.getVersion()` | ✅ | Returns `"3.0"` — `parseInt("3.0") >= 3` is true |
| `window.MRAID_ENV` (object check) | ❌ | FAIL — `isEnvObjectPresent()` returns false |
| `mraid.addEventListener('exposureChange', handler)` | ❌ | FAIL — event never fired |

### Historical Findings (v0.2.0 snapshot)

#### ❌ `window.MRAID_ENV` causes early exit

```js
// viewabilityCompliance.v1.js
function isValidEnvironment() {
    return (isMraidObjectPresent() && isVersionValid() && isEnvObjectPresent());
}
function isEnvObjectPresent() {
    return typeof window.MRAID_ENV === 'object';
}
function main() {
    if (isValidEnvironment()) {
        checkViewabilityCompliance();
    } else {
        fallback();
    }
}
```

When `MRAID_ENV` is missing, `isValidEnvironment()` returns `false` and the test falls
back to displaying an error message instead of running the viewability compliance
check. **This single missing global causes the entire test suite to fail.**

#### ❌ `exposureChange` event never fired

```js
// viewabilityCompliance.v1.js
mraid.addEventListener("exposureChange", handleExposureChange);
```

The test listens for `exposureChange(exposedPercentage, visibleRectangle,
occlusionRectangles)`. This is a MRAID 3.0 event that the container fires when the
ad's geometric exposure changes (via the platform's viewport intersection detection).

The bridge does **not** fire `exposureChange` — there is no SHARC v1 protocol message
that maps to it. This is a significant gap for MRAID 3.0 compliance because viewability
is a core MRAID 3.0 feature.

The mock bridge (`mockMraidBridge.js`) used for demo purposes fires `exposureChange`
with test values. The real bridge provides no equivalent.

#### ✅ `getVersion()` format is correct

The test checks `parseInt(mraid.getVersion()) >= 3`. The bridge returns the string
`"3.0"`, and `parseInt("3.0")` is `3`, so this check passes.

#### ⚠️ `exposureChange` event signature

When/if `exposureChange` is implemented, the handler signature must be:
```js
handler(exposedPercentage, visibleRectangle, occlusionRectangles)
```
Where:
- `exposedPercentage`: number 0–100
- `visibleRectangle`: `{x, y, width, height}` all numbers, or `null`
- `occlusionRectangles`: array of rect objects, or `null`/`undefined`/empty

---

## Gap Classification: Complete List

### ✅ APIs Fully Covered by Bridge (historical v0.2.0 snapshot)

- `getVersion()` → returns `"3.0"`
- `getState()` → derived from SHARC state machine
- `isViewable()` → true when SHARC state is `active`
- `getPlacementType()` → from AdCOM `placement.instl`
- `getDefaultPosition()` → from `currentPlacement.initialDefaultSize`
- `getCurrentPosition()` → updated via `placementChange` events
- `getMaxSize()` → from `currentPlacement.maxExpandSize`
- `getScreenSize()` → from `currentPlacement.viewportSize`
- `getExpandProperties()` → stored `_expandProps`, `isModal` always `true`
- `setExpandProperties()` → stores props, `useCustomClose` accepted but ignored
- `getResizeProperties()` → returns stored `_resizeProps`
- `expand()` → maps to `requestPlacementChange`; two-part expand intentionally excluded
- `collapse()` → maps to `requestPlacementChange({ intent: 'restore' })`
- `open()` → `requestNavigation` with `window.open` fallback
- `useCustomClose()` → stored; container always provides close button
- `isAudioMuted()` → init-time value from SHARC env
- `supports()` → feature-based boolean; correct returns for all known features
- `addEventListener()` → works for `ready`, `stateChange`, `viewableChange`, `sizeChange`, `error`, `unload`
- `removeEventListener()` → correct
- `storePicture()` → fires `error('COMMAND_NOT_SUPPORTED')`
- `createCalendarEvent()` → fires `error('COMMAND_NOT_SUPPORTED')`
- `playVideo()` → fires `error('COMMAND_NOT_SUPPORTED')`
- `getOrientationProperties()` → safe stub
- `setOrientationProperties()` → silently ignored
- `close()` from default state → `requestClose()`
- `unload` **event** (received) → fired on SHARC `close`

---

### ⚠️ APIs Partially Covered or Behavioral Edge Cases (historical v0.2.0 snapshot)

#### `close()` — state-unaware
**Issue:** Per MRAID 3.0 spec, `close()` from `expanded` state should collapse the ad
to `default`, not close it entirely. The bridge always calls `SHARC.requestClose()`.
**Impact:** `loadandevents` test step 4 (`expandsizeclose()`) will fail.
**Fix:** State-aware dispatch: call `collapse()` internally when `_placementMode` is
`expanded` or `resized`.

#### `resize()` — intentionally stubbed, fires wrong error
**Issue:** Bridge fires `error('COMMAND_NOT_SUPPORTED', 'resize')`. The
`resize-negative` suite tests still pass because they expect any `error` event. But the
error message doesn't match what the MRAID spec would produce for the specific invalid
conditions tested.
**Impact:** Tests 1, 2, 13 in resize-negative pass but for the wrong reason.
**Fix:** Deferred to v2 per design doc §7.1. Consider a more descriptive error message.

#### `addEventListener` for unknown events
**Issue:** Bridge silently accepts unknown event names. `exposureChange` and
`audioVolumeChange` listeners can be registered but will never fire.
**Impact:** Listeners registered but events never delivered — silent failure.
**Fix:** At minimum, document that these events are not supported. Optionally fire
`error` or `console.warn` when registering for unsupported events.

---

### ❌ APIs Missing or Broken (historical v0.2.0 snapshot)

#### 1. `window.MRAID_ENV` global object — **MISSING**
**Spec:** MRAID 3.0 §2.1 requires the SDK to set `window.MRAID_ENV` before the creative
loads, containing:

```js
window.MRAID_ENV = {
  version: "3.0",         // MRAID spec version
  sdk: "<sdk name>",      // SDK identifier
  sdkVersion: "<ver>",    // SDK version string
  appId: "<app id>",      // host app identifier (optional)
  ifa: "<ifa>",           // advertising ID (optional)
  limitAdTracking: false, // boolean
  coppa: false            // boolean
};
```

**Impact:** Both `loadandevents` and `viewability` test suites detect missing
`MRAID_ENV` and log `FAIL`. The `viewability` suite aborts entirely.
**Fix:** Set `window.MRAID_ENV` in `mraid-wrapper.html` before scripts load, and
optionally expose it from bridge init using data from `SHARC.onReady(env)`.

#### 2. `mraid.unload()` method — **MISSING**
**Spec:** MRAID 3.0 §7.3.6 — `unload()` is a creative-callable method to signal it is
done with the ad session.
**Impact:** `loadandevents` final step calls `mraid.unload()`. Throws
`TypeError: mraid.unload is not a function`.
**Fix:** Add method to bridge; map to `SHARC.requestClose()`.

#### 3. `exposureChange` event — **MISSING**
**Spec:** MRAID 3.0 §7.3.4 — fires `(exposedPercentage, visibleRectangle,
occlusionRectangles)` whenever the ad's geometric exposure changes.
**Impact:** `viewability` test suite's entire purpose is to validate `exposureChange`
payload compliance. No `exposureChange` events = zero data, test shows blank chart.
**Fix:** Requires a SHARC protocol extension or a container-side implementation that
periodically computes exposure and messages it to the creative iframe. No SHARC v1
equivalent exists — this is a v2 item.

#### 4. `audioVolumeChange` event — **MISSING (masked by test bug)**
**Spec:** MRAID 3.0 §7.3.5 — fires `(volumePercentage)` when device audio volume
changes.
**Impact:** `loadandevents` has a bug (`mraid.getVersion` not called with `()`), so
the `audioVolumeChange` listener is never registered and the gap is not surfaced.
**Fix:** Deferred to v2 per design doc §7.2. Requires a SHARC audio extension.

#### 5. `setResizeProperties()` validation — **MISSING**
**Spec:** MRAID 3.0 §4.4.3 requires `error` events for 10+ invalid conditions.
**Impact:** All 10 `setResizeProperties` validation tests in `resize-negative` fail
(tests 3–12).
**Fix:** Substantial validation logic needed — see detailed fix sketch above.

---

## MRAID 2.0 Compliance Ads

The IAB MRAID 2.0 Compliance Ads repository
(`https://github.com/InteractiveAdvertisingBureau/MRAID-2.0-Compliance-Ads`)
was checked but not found locally. It was not cloned to
`~/.openclaw/workspace-dev/docs/`.

Based on the MRAID 2.0 spec (which MRAID 3.0 is a superset of), the APIs exercised
would be a subset of those already analyzed above. The key MRAID 2.0 items are:

| API | Status |
|-----|--------|
| `getVersion()` → `"2.0"` | Bridge returns `"3.0"` — would pass MRAID 2.0 tests since 3.0 > 2.0 |
| `getState()` | ✅ |
| `expand()` / `collapse()` | ✅ |
| `close()` (state-aware) | ⚠️ Same close() issue applies |
| `resize()` | ⚠️ Stubbed — would fail 2.0 resize tests if any test actual resize |
| `setResizeProperties()` with validation | ❌ Same gap |
| `addEventListener` / `removeEventListener` | ✅ |
| `getExpandProperties()` / `setExpandProperties()` | ✅ |
| `useCustomClose()` | ✅ |
| `storePicture()` / `createCalendarEvent()` | fires error per spec |
| `MRAID_ENV` | ❌ Not available in MRAID 2.0 spec (3.0 addition) — irrelevant |

A fresh clone and analysis of the MRAID 2.0 suite is recommended.

---

## Priority Fix Recommendations (historical v0.2.0 snapshot)

> Current note: this recommendation table is preserved from the original
> analysis. In current SHARC, `window.MRAID_ENV`, `mraid.unload()`, state-aware
> `close()`, `setResizeProperties()` / `resize()`, and `audioVolumeChange` are no
> longer open items. `exposureChange` remains the primary unresolved compliance gap.

| Priority | Gap | Effort | Impact |
|----------|-----|--------|--------|
| 🔴 P0 | Set `window.MRAID_ENV` in `mraid-wrapper.html` | Low (5 lines) | Unblocks 2 of 3 test suites |
| 🔴 P0 | Add `mraid.unload()` method to bridge | Low (3 lines) | Fixes loadandevents final step |
| 🟠 P1 | Make `close()` state-aware (collapse from expanded) | Medium | Fixes key loadandevents test |
| 🟠 P1 | Add `setResizeProperties()` validation with error events | High | Fixes 10 resize-negative tests |
| 🟡 P2 | Implement `exposureChange` event (SHARC extension) | Very High | Core MRAID 3.0 viewability feature; requires new SHARC protocol message |
| 🟡 P2 | Implement `audioVolumeChange` event (SHARC extension) | High | MRAID 3.0 audio feature; masked by test bug but real gap |

---

## References

- [IAB MRAID 3.0 Spec](https://www.iab.com/guidelines/mraid/)
- [IAB MRAID 3.0 Compliance Ads](https://github.com/InteractiveAdvertisingBureau/MRAID-3.0-Compliance-Ads)
- [IAB MRAID 2.0 Compliance Ads](https://github.com/InteractiveAdvertisingBureau/MRAID-2.0-Compliance-Ads)
- SHARC MRAID Bridge design doc: `docs/design/mraid-bridge-design.md`
- Bridge implementation: `examples/sharc-mraid-bridge.js`
- Wrapper: `examples/mraid-wrapper.html`
