# ARCH: Live `audioVolumeChange` Signal

**Status:** Proposed  
**ADR-ID:** ARCH-audio-volume-change  
**Author:** Software Architect  
**Date:** 2026-04-09

---

## Context

SHARC currently sends `isMuted` and `volume` once, inside `Container:init`'s `environmentData`. This is a point-in-time snapshot — it reflects the audio state at session startup but is never updated during playback.

**MRAID 3.0 §4.6** requires a live `audioVolumeChange` event that fires whenever the device or app audio state changes during creative playback. Creatives relying on MRAID's `isAudioMuted()` return a stale value after the first `init`, and those listening for `mraid.addEventListener('audioVolumeChange', ...)` never receive any events.

This document designs the full stack change needed to close that gap: from the SHARC wire protocol through the container layer, into the MRAID bridge, and into the test harness.

---

## Decision

Add a new fire-and-forget container-to-creative message, `SHARC:Container:audioVolumeChange`, with a `volumePercentage` payload (0–100). The container calls `setAudioVolume(pct)` when the platform reports an audio change. The MRAID bridge listens for the SHARC event and forwards it to MRAID listeners.

---

## Protocol Layer (`sharc-protocol.js`)

### 1. New `ContainerMessages` constant

```js
const ContainerMessages = Object.freeze({
  // ... existing entries ...
  AUDIO_VOLUME_CHANGE: 'SHARC:Container:audioVolumeChange',
});
```

**Rationale for the name:** Follows the existing `SHARC:Container:<camelCase>` naming convention (`stateChange`, `placementChange`). The field name `audioVolumeChange` mirrors the MRAID 3.0 §4.6 event name, making the mapping obvious.

### 2. Payload schema

```
{
  volumePercentage: number   // integer 0–100 inclusive
}
```

`volumePercentage` is the single source of truth. Both `isMuted` (`=== 0`) and `volume` (divided by 100) are derived from it — no redundant fields to keep in sync.

**Why 0–100 (integer percent) and not 0.0–1.0 (float)?**

MRAID 3.0 §4.6 specifies `volumePercentage` as an integer 0–100. Using the same range on the SHARC wire avoids any lossy conversion (e.g., floating-point rounding on the bridge side). The existing `volume` field in `environmentData` uses a 0–1 float, but that is init-only and will be deprecated in a future cleanup.

### 3. New method on `SHARCContainerProtocol`

```js
/**
 * Sends Container:audioVolumeChange to the creative.
 * Fire-and-forget — no resolve/reject expected.
 *
 * @param {number} volumePercentage - Integer 0–100 (clamped internally).
 */
sendAudioVolumeChange(volumePercentage) {
  // Validation: reject non-numeric
  if (typeof volumePercentage !== 'number' || isNaN(volumePercentage)) {
    console.warn('[SHARC Container] sendAudioVolumeChange: non-numeric value rejected:', volumePercentage);
    return;
  }
  // Clamp to [0, 100] and round to integer
  const clamped = Math.round(Math.max(0, Math.min(100, volumePercentage)));
  this._sendMessage(ContainerMessages.AUDIO_VOLUME_CHANGE, { volumePercentage: clamped });
}
```

**Does it need a response?**

No. `AUDIO_VOLUME_CHANGE` must NOT be added to `MESSAGES_REQUIRING_RESPONSE`. This is a notification, not a request. The creative has no meaningful data to return, and requiring acknowledgment would stall the container on every mute/unmute during active media playback — the highest-frequency audio events on mobile happen at OS level (volume buttons, call interruption, Bluetooth disconnect) and must not be synchronous round-trips.

Consistent precedent: `sendStateChange` and `sendPlacementChange` are already fire-and-forget.

---

## Container Layer (`sharc-container.js`)

### New public method: `setAudioVolume(volumePercentage)`

```js
/**
 * Updates the live audio volume and notifies the creative.
 * Call this whenever the platform reports a volume/mute change.
 *
 * @param {number} volumePercentage - New volume as integer 0–100.
 *   0 means muted. 100 means full volume.
 * @returns {boolean} false if the call was rejected (wrong state or invalid input).
 */
setAudioVolume(volumePercentage) {
  // Guard: only callable in ACTIVE or PASSIVE state
  const state = this._stateMachine.getState();
  if (state !== ContainerStates.ACTIVE && state !== ContainerStates.PASSIVE) {
    console.warn(
      `[SHARCContainer] setAudioVolume() called in state '${state}' — ` +
      `only allowed in ACTIVE or PASSIVE. Call ignored.`
    );
    return false;
  }

  // Delegate validation and clamping to the protocol layer
  if (typeof volumePercentage !== 'number' || isNaN(volumePercentage)) {
    console.warn('[SHARCContainer] setAudioVolume(): non-numeric value rejected:', volumePercentage);
    return false;
  }

  const clamped = Math.round(Math.max(0, Math.min(100, volumePercentage)));

  // Update local environmentData so subsequent getters are consistent
  this.environmentData.volume  = clamped / 100;   // preserve existing 0–1 float convention
  this.environmentData.isMuted = (clamped === 0);

  // Send the live signal over the protocol
  this._protocol.sendAudioVolumeChange(clamped);
  return true;
}
```

**State guard — why ACTIVE and PASSIVE only?**

| State | Allowed? | Rationale |
|---|---|---|
| `LOADING` | ❌ | Protocol not established — no port yet |
| `READY` | ❌ | `startCreative` not sent; creative is not rendering |
| `ACTIVE` | ✅ | Normal playback; live update required |
| `PASSIVE` | ✅ | Ad visible but unfocused (split-screen, call overlay); audio state can still change |
| `HIDDEN` | ❌ | Creative is not visible; OS typically mutes at this point anyway; no meaningful dispatch |
| `FROZEN` | ❌ | JS suspended in creative; message cannot be processed |
| `TERMINATED` | ❌ | Protocol is gone |

**Should `AUDIO_VOLUME_CHANGE` be in `AllowedMessages`?**

`AllowedMessages` is not a concept in the current SHARC protocol (`sharc-protocol.js` does not define such a set for container-initiated messages). The protocol only has `MESSAGES_REQUIRING_RESPONSE` — a set that controls whether `_sendMessage` wraps the call in a Promise. Since `audioVolumeChange` is fire-and-forget, it simply does NOT enter `MESSAGES_REQUIRING_RESPONSE`. No `AllowedMessages` set needs to be created or extended.

**`environmentData` update: why keep it in sync?**

`this.environmentData` is the source of truth used if the creative calls `GET_PLACEMENT_OPTIONS` or a future `getEnvironmentState()`. Keeping `volume` and `isMuted` in sync ensures these query responses are accurate even if the creative polls rather than listens.

---

## MRAID Bridge (`sharc-mraid-bridge.js`)

### New `SHARC.on('audioVolumeChange', ...)` handler

Add inside `installMRAIDBridge`, alongside the existing `stateChange` and `placementChange` handlers:

```js
/**
 * SHARC audioVolumeChange — maps to MRAID 3.0 §4.6 audioVolumeChange event.
 *
 * Ordering contract:
 *   1. Update internal env state FIRST (_env.isMuted, _env.volume)
 *   2. Fire all registered mraid.addEventListener('audioVolumeChange', ...) listeners
 *
 * Payload translation: SHARC { volumePercentage } → MRAID { volumePercentage }
 * (same shape per MRAID 3.0 §4.6 — no translation needed)
 */
SHARC.on('audioVolumeChange', function (payload) {
  var pct = payload && payload.volumePercentage;
  if (typeof pct !== 'number') return; // guard: malformed message

  // 1. Update internal state FIRST — isAudioMuted() must be consistent in listeners
  if (_s._env) {
    _s._env.isMuted = (pct === 0);
    _s._env.volume  = pct / 100;   // keep legacy field in sync
  }

  // 2. Fire all registered MRAID audioVolumeChange listeners
  _emit('audioVolumeChange', { volumePercentage: pct });
});
```

**Update `mraid.isAudioMuted()`:**

The existing implementation reads `_s._env.isMuted`. Since we update `_s._env.isMuted` in the handler above (before firing events), `isAudioMuted()` will return the correct value when called from within an `audioVolumeChange` listener. **No code change needed** to `isAudioMuted()` itself — the live state flows through the same `_env` reference.

**`addEventListener` coverage:**

`mraid.addEventListener('audioVolumeChange', fn)` is already handled by the existing generic `addEventListener` implementation — it pushes into `_s._listeners['audioVolumeChange']`. The new `_emit('audioVolumeChange', ...)` call dispatches to that list. No changes to `addEventListener` or `removeEventListener` are needed.

**Add `volume` getter (MRAID 3.0 §4.6 completeness):**

MRAID 3.0 §4.6 also defines `mraid.getVolume()`. Add to the `mraid` public API object:

```js
/**
 * Returns the current volume as a percentage (0–100).
 * Live after first audioVolumeChange; init-time value before that.
 * MRAID 3.0 §4.6.
 * @returns {number} 0–100
 */
getVolume: function () {
  if (!_s._env) return 0;
  // Prefer live volumePercentage-derived value; fall back to init-time volume * 100
  if (typeof _s._env.volume === 'number') return Math.round(_s._env.volume * 100);
  return 0;
},
```

---

## SafeFrame Bridge (`sharc-safeframe-bridge.js`)

### Assessment: does `$sf.ext` define any audio API?

**No.** The IAB SafeFrame 1.1 specification (`SafeFrames_v1.1_final.pdf`) defines no audio-related methods or events in `$sf.ext`. There is no `$sf.ext.audioVolumeChange`, `$sf.ext.isAudioMuted()`, or equivalent. SafeFrame's design scope is geometry, viewability, and metadata — not device hardware state.

### Recommendation: expose as SHARC extension; do not skip

Expose the signal as `$sf.ext.sharc.audioVolumeChange` — a SHARC-specific extension namespace on the SafeFrame bridge. This follows the existing SHARC extension pattern (`$sf.ext.sharc` would be the SHARC-specific augmentation namespace).

**Why not skip entirely?**

SafeFrame creatives increasingly run inside MRAID-aware players (especially on programmatic video/CTV). A SafeFrame creative that runs video will need the same live audio signal. Skipping it creates a silent regression: the creative's audio state diverges from reality on mute/unmute, and there is no recovery path.

**Why not fire it as a SafeFrame `geom-update`?**

Audio is not geometric. Injecting it into `geom-update` would corrupt the SafeFrame geometry contract and confuse any creative that parses the geom payload structurally. Creatives that don't care about audio would receive spurious `geom-update` callbacks.

**Proposed implementation — add inside `installSafeFrameBridge`:**

```js
// Augment $sf.ext with a SHARC-specific audio namespace
$sf.ext.sharc = $sf.ext.sharc || {};

/**
 * Registers a listener for SHARC audio volume changes.
 * Not part of the SafeFrame 1.1 spec — SHARC extension only.
 *
 * @param {Function} fn - Called with { volumePercentage: number (0-100) }
 */
$sf.ext.sharc.onAudioVolumeChange = function (fn) {
  if (typeof fn === 'function') {
    _audioVolumeListeners.push(fn);
  }
};

// Private listener array (add to _s or as a module-level var)
var _audioVolumeListeners = [];

// Wire the SHARC event
SHARC.on('audioVolumeChange', function (payload) {
  var pct = payload && payload.volumePercentage;
  if (typeof pct !== 'number') return;
  _audioVolumeListeners.slice().forEach(function (fn) {
    try { fn({ volumePercentage: pct }); } catch (e) { /* swallow */ }
  });
});
```

**SafeFrame creatives that don't use audio:** They simply never call `$sf.ext.sharc.onAudioVolumeChange()`. The event fires into an empty listener list — zero cost.

---

## Test Harness (`examples/test/mraid-test.html`)

### Replace the dead `toggleMute` button with `setAudioVolume`

**Current behavior:** The `🔊 Mute` button exists in the HTML but `toggleMute()` is not defined — clicking it is a no-op (JS error silently dropped).

**New behavior:** `toggleMute()` calls `sharcContainer.setAudioVolume(isMuted ? 0 : 100)` — a binary toggle. No reinit. No teardown. Live signal goes through the protocol.

```js
/* ── Audio Volume ─────────────────────────────────────────────── */
function toggleMute() {
  if (!sharcContainer) return;
  isMuted = !isMuted;
  var pct = isMuted ? 0 : 100;
  logMsg('cntr', 'Container:audioVolumeChange (sent)', { volumePercentage: pct });
  var btn = document.getElementById('btn-mute');
  if (btn) btn.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
  if (typeof sharcContainer.setAudioVolume === 'function') {
    sharcContainer.setAudioVolume(pct);
  } else {
    logErr('sharcContainer.setAudioVolume() not available — update sharc-container.js');
  }
}
```

### Add a volume slider (0–100)

Add alongside the Mute button in the "Container → Creative" section:

```html
<!-- Volume slider -->
<div style="margin-top:8px;">
  <div style="font-size:10px;color:#666;margin-bottom:4px;">
    Volume: <span id="vol-pct-label">100</span>%
  </div>
  <input
    type="range" id="vol-slider" min="0" max="100" value="100"
    style="width:100%; accent-color:#7c3aed;"
    oninput="onVolumeSlider(this.value)"
    onchange="onVolumeSliderCommit(this.value)"
    disabled
  >
</div>
```

```js
function onVolumeSlider(val) {
  // Live label update only — no protocol message on every pixel of drag
  document.getElementById('vol-pct-label').textContent = val;
}

function onVolumeSliderCommit(val) {
  // Send protocol message on mouseup / touchend
  var pct = parseInt(val, 10);
  isMuted = (pct === 0);
  var btn = document.getElementById('btn-mute');
  if (btn) btn.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
  if (!sharcContainer) return;
  logMsg('cntr', 'Container:audioVolumeChange (sent)', { volumePercentage: pct });
  if (typeof sharcContainer.setAudioVolume === 'function') {
    sharcContainer.setAudioVolume(pct);
  }
}
```

Add `vol-slider` to the `setLoaded` enable/disable list:

```js
['sim-active','sim-passive','sim-hidden','sim-frozen','sim-active2','sim-hidden2',
 'btn-placement','btn-log','btn-mute','vol-slider'].forEach(function (id) { ... });
```

**Why `oninput` vs `onchange`?** `oninput` fires on every drag tick (good for label); `onchange` fires only on commit (good for the protocol call). This avoids sending 60+ messages per second while the user drags — respecting the 50 msg/s rate limiter (`_rateLimitAllow()`).

---

## Risk Assessment

### 1. Ordering / race conditions

**Risk:** `SHARC.on('audioVolumeChange', handler)` is wired inside `installMRAIDBridge`, which runs at script load time. If `SHARC` emits `audioVolumeChange` before the MRAID bridge is fully installed, the event is dropped.

**Mitigation:** `audioVolumeChange` is only ever sent by `setAudioVolume()`, which is guarded to ACTIVE/PASSIVE states. The creative must have already completed `Container:init` and `Container:startCreative` before reaching those states — meaning the MRAID bridge (`SHARC.onReady(...)`) has already run. The bridge is installed before the creative's own JS runs. **No race is possible under the current call graph.**

**Edge case to document:** If a publisher calls `sharcContainer.setAudioVolume()` from an OS-level audio callback that fires very early (e.g., before `startCreative` resolves), the state guard (`ACTIVE or PASSIVE` only) will silently drop the call. This is safe — the next audio event after the creative reaches ACTIVE will carry the correct current volume. If this turns out to be too aggressive, the guard can be relaxed to include READY. Revisit in v2.

### 2. `setAudioVolume` called before `Container:init` completes

**Exact scenario:** Publisher mounts the container and immediately calls `setAudioVolume()` in a `mediaSession.onvolumechange` handler, before the creative has sent `createSession`.

**Current protection:** The state machine starts in `LOADING`. `setAudioVolume()` checks `ACTIVE or PASSIVE` — `LOADING` is neither, so the call is dropped with a `console.warn`. No protocol message is sent, so no "No MessagePort available" error in `_sendMessage` is triggered.

**Data freshness:** The `environmentData.volume` and `environmentData.isMuted` fields are still updated even if the protocol message is not sent (depending on implementation preference — see option below). If we update `environmentData` regardless of state guard, the correct volume flows naturally into `Container:init` when the session completes.

> **Implementation option:** Split the method into two phases:
> 1. Always update `environmentData.volume` / `environmentData.isMuted` (no state check).
> 2. Only call `_protocol.sendAudioVolumeChange(...)` when state is ACTIVE or PASSIVE.
>
> This gives correct init-time volume + correct live events, with no extra complexity.

### 3. Backward compatibility with creatives not listening for `audioVolumeChange`

**Impact:** Zero. The message is fire-and-forget. If no listener is registered in the creative for `'audioVolumeChange'`, `_dispatchToListeners` calls `listeners.forEach(...)` on an empty or absent array — it's a no-op. The creative continues to function exactly as it did before.

**MRAID creatives using the bridge:** `_emit('audioVolumeChange', payload)` dispatches to `_s._listeners['audioVolumeChange']`. If the creative never called `mraid.addEventListener('audioVolumeChange', fn)`, the listener array is absent (`undefined`). The `_emit` guard `if (!listeners || listeners.length === 0) return;` short-circuits. No error.

**Existing `isMuted` polling:** Creatives that call `mraid.isAudioMuted()` in a polling loop (instead of listening for events) will automatically pick up the updated `_s._env.isMuted` value because we update it synchronously in the SHARC event handler before firing MRAID events. No code change required on the creative side.

---

## Data Flow Summary

```
Publisher OS event (volume button, call, BT disconnect)
  │
  ▼
sharcContainer.setAudioVolume(pct)          [sharc-container.js]
  ├── updates environmentData.volume + isMuted
  └── this._protocol.sendAudioVolumeChange(pct)
        │
        ▼
  ContainerMessages.AUDIO_VOLUME_CHANGE     [sharc-protocol.js]
  { volumePercentage: 0–100 }
        │  (fire-and-forget, no MESSAGES_REQUIRING_RESPONSE)
        ▼
  Creative iframe receives message
        │
        ▼
  SHARC.on('audioVolumeChange', handler)    [sharc-creative.js SDK]
        │
        ├──▶ MRAID bridge handler           [sharc-mraid-bridge.js]
        │       ├── _s._env.isMuted = (pct === 0)
        │       ├── _s._env.volume  = pct / 100
        │       └── _emit('audioVolumeChange', { volumePercentage: pct })
        │             └──▶ mraid.addEventListener('audioVolumeChange', ...)
        │
        └──▶ SafeFrame extension handler    [sharc-safeframe-bridge.js]
                └──▶ $sf.ext.sharc.onAudioVolumeChange(...)
```

---

## Consequences

**What becomes easier:**
- MRAID 3.0 §4.6 compliance for `audioVolumeChange` event
- `mraid.isAudioMuted()` returns live state, not stale init-time snapshot
- Test harness can drive mute/unmute without tearing down and reinitializing the container
- SafeFrame creatives get a clean extension path for audio if they need it

**What becomes harder / requires attention:**
- Publishers must call `setAudioVolume()` at the OS/platform level (e.g., `MediaSession`, `AudioManager`, `AVAudioSession` callback). This is a publisher integration concern, not a SHARC protocol concern.
- The legacy `volume` and `isMuted` fields in `environmentData` now have two update paths (init-time snapshot + live override). A future cleanup should consolidate to `volumePercentage` as the canonical field.
- SafeFrame extension is non-standard. Document clearly in the SafeFrame bridge JSDoc that `$sf.ext.sharc.onAudioVolumeChange` is a SHARC extension, not part of SafeFrame 1.1 spec.

---

## Implementation Checklist

- [ ] `sharc-protocol.js` — Add `AUDIO_VOLUME_CHANGE` to `ContainerMessages`
- [ ] `sharc-protocol.js` — Add `sendAudioVolumeChange(volumePercentage)` to `SHARCContainerProtocol`
- [ ] `sharc-container.js` — Add `setAudioVolume(volumePercentage)` public method
- [ ] `sharc-mraid-bridge.js` — Add `SHARC.on('audioVolumeChange', ...)` handler
- [ ] `sharc-mraid-bridge.js` — Add `mraid.getVolume()` method
- [ ] `sharc-safeframe-bridge.js` — Add `$sf.ext.sharc.onAudioVolumeChange` extension
- [ ] `examples/test/mraid-test.html` — Implement `toggleMute()` function (was dead)
- [ ] `examples/test/mraid-test.html` — Add volume slider UI (0–100)
- [ ] `examples/test/mraid-test.html` — Add `vol-slider` to enabled/disabled button list
