# ARCH: Live `audioVolumeChange` Signal

**Status:** Proposed  
**ADR-ID:** ARCH-audio-volume-change  
**Author:** Software Architect  
**Date:** 2026-04-09  
**PRD Version:** 1.1

### Revision History

| Version | Date | Change Summary |
|---------|------|---------------|
| 1.0 | 2026-04-09 | Initial architecture — single-field payload, `setAudioVolume(pct)`, `isMuted` derived from `volumePercentage === 0` |
| 1.1 | 2026-04-09 | 3-field payload `{ volumePercentage, volume, isMuted }`; `setAudioState({ volumePercentage, isMuted })` atomic API; independent mute/volume tracking per `HTMLMediaElement` semantics; updated MRAID bridge, test harness, and risk assessment |

---

## Context

SHARC currently sends `isMuted` and `volume` once, inside `Container:init`'s `environmentData`. This is a point-in-time snapshot — it reflects the audio state at session startup but is never updated during playback.

**MRAID 3.0 §4.6** requires a live `audioVolumeChange` event that fires whenever the device or app audio state changes during creative playback. Creatives relying on MRAID's `isAudioMuted()` return a stale value after the first `init`, and those listening for `mraid.addEventListener('audioVolumeChange', ...)` never receive any events.

This document designs the full stack change needed to close that gap: from the SHARC wire protocol through the container layer, into the MRAID bridge, and into the test harness.

---

## Decision

Add a new fire-and-forget container-to-creative message, `SHARC:Container:audioVolumeChange`, carrying a **3-field payload** `{ volumePercentage, volume, isMuted }` that aligns with both MRAID 3.0 §4.6 and `HTMLMediaElement` semantics. The container exposes a single atomic `setAudioState({ volumePercentage, isMuted })` method. Mute state and volume level are tracked **independently** — muting preserves the stored `volumePercentage`, never zeroing it.

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

```js
{
  volumePercentage: number,    // integer 0–100 inclusive (MRAID 3.0 §4.6 format)
  volume:           number,    // float 0.0–1.0 (HTMLMediaElement format); always volumePercentage / 100
  isMuted:          boolean    // independent mute state (HTMLMediaElement format); NEVER derived from volumePercentage
}
```

**Field constraints:**

| Field | Type | Range | Semantics |
|-------|------|-------|-----------|
| `volumePercentage` | `number` | `[0, 100]` integer | MRAID 3.0 §4.6 compliance; clamped by sender |
| `volume` | `number` | `[0.0, 1.0]` float | `HTMLMediaElement.volume` equivalent; derived as `volumePercentage / 100` |
| `isMuted` | `boolean` | `true` / `false` | `HTMLMediaElement.muted` equivalent; **independent of `volumePercentage`** |

**Key invariants:**
- `volume` is always derived from `volumePercentage`: `volume = volumePercentage / 100`
- `isMuted` is **never** derived from `volumePercentage`. Setting `volumePercentage = 0` does **NOT** set `isMuted = true`
- When muted, `volumePercentage` and `volume` retain their pre-mute values (e.g., muting at 80% sends `volumePercentage: 80, volume: 0.80, isMuted: true`)
- `isMuted = true` with `volumePercentage > 0` is valid and expected behavior
- Values outside `[0, 100]` MUST be clamped by the sender before dispatch

**Why carry both `volumePercentage` and `volume`?**

MRAID 3.0 §4.6 specifies `volumePercentage` (0–100) as the event payload. `HTMLMediaElement` uses `volume` (0.0–1.0). Carrying both removes the impedance mismatch: MRAID creatives consume `volumePercentage` directly; web-native integrations that model `HTMLMediaElement` semantics consume `volume`. `volume` is always derived — it is never an independent value — so there is no synchronization risk.

### 3. New method on `SHARCContainerProtocol`

```js
/**
 * Sends Container:audioVolumeChange to the creative.
 * Fire-and-forget — no resolve/reject expected.
 * Derives `volume` internally; sends all 3 fields.
 *
 * @param {number}  volumePercentage - Integer 0–100 (clamped internally).
 * @param {boolean} isMuted          - Explicit mute state; NEVER derived from volumePercentage.
 */
sendAudioVolumeChange(volumePercentage, isMuted) {
  // Validation: reject non-numeric volumePercentage
  if (typeof volumePercentage !== 'number' || isNaN(volumePercentage)) {
    console.warn('[SHARC Container] sendAudioVolumeChange: non-numeric volumePercentage rejected:', volumePercentage);
    return;
  }
  // Validation: require explicit boolean isMuted
  if (typeof isMuted !== 'boolean') {
    console.warn('[SHARC Container] sendAudioVolumeChange: isMuted must be boolean, got:', isMuted);
    return;
  }
  // Clamp to [0, 100] and round to integer
  const clamped = Math.round(Math.max(0, Math.min(100, volumePercentage)));
  // Derive volume (0.0–1.0) from clamped volumePercentage
  const volume = clamped / 100;

  this._sendMessage(ContainerMessages.AUDIO_VOLUME_CHANGE, {
    volumePercentage: clamped,
    volume:           volume,
    isMuted:          isMuted,
  });
}
```

**Does it need a response?**

No. `AUDIO_VOLUME_CHANGE` must NOT be added to `MESSAGES_REQUIRING_RESPONSE`. This is a notification, not a request. Requiring acknowledgment would stall the container on every mute/unmute — the highest-frequency audio events on mobile happen at OS level (volume buttons, call interruption, Bluetooth disconnect) and must not be synchronous round-trips.

Consistent precedent: `sendStateChange` and `sendPlacementChange` are already fire-and-forget.

---

## Container Layer (`sharc-container.js`)

### Public method: `setAudioState({ volumePercentage, isMuted })`

Replaces the v1.0 `setAudioVolume(pct)` design. Single atomic call — both dimensions arrive together, matching how publishers receive audio state from the OS/browser (`volumechange` fires once per change, carrying both `volume` and `muted`).

```js
/**
 * Notifies the creative of an audio state change.
 * Clamps volumePercentage to [0, 100] before sending.
 * isMuted is independent of volumePercentage — muting does NOT zero the volume.
 * No-op if called before init resolves or after close.
 *
 * @param {Object}  audioState
 * @param {number}  audioState.volumePercentage - Current volume level (0–100)
 * @param {boolean} audioState.isMuted          - Whether audio is muted (independent of volume)
 * @returns {boolean} false if the call was rejected (wrong state or invalid input).
 */
setAudioState({ volumePercentage, isMuted }) {
  // Guard: only callable in ACTIVE or PASSIVE state
  const state = this._stateMachine.getState();
  if (state !== ContainerStates.ACTIVE && state !== ContainerStates.PASSIVE) {
    console.warn(
      `[SHARCContainer] setAudioState() called in state '${state}' — ` +
      `only allowed in ACTIVE or PASSIVE. Call ignored.`
    );
    return false;
  }

  // Validate inputs
  if (typeof volumePercentage !== 'number' || isNaN(volumePercentage)) {
    console.warn('[SHARCContainer] setAudioState(): non-numeric volumePercentage rejected:', volumePercentage);
    return false;
  }
  if (typeof isMuted !== 'boolean') {
    console.warn('[SHARCContainer] setAudioState(): isMuted must be boolean, got:', isMuted);
    return false;
  }

  const clamped = Math.round(Math.max(0, Math.min(100, volumePercentage)));

  // Update environmentData — track BOTH independently, updating only what changed.
  // volume reflects the stored level regardless of mute (HTMLMediaElement semantics).
  // isMuted is a separate toggle — zeroing volume does NOT set isMuted.
  this.environmentData.volumePercentage = clamped;
  this.environmentData.volume           = clamped / 100;
  this.environmentData.isMuted          = isMuted;   // stored exactly as provided

  // Send the live signal — protocol derives nothing; receives all values explicitly
  this._protocol.sendAudioVolumeChange(clamped, isMuted);
  return true;
}
```

**Why independent storage in `environmentData`?**

`environmentData.volume` stores the current volume level. `environmentData.isMuted` stores the mute toggle. They are updated separately:

- `setAudioState({ volumePercentage: 80, isMuted: true })` → `environmentData.volume = 0.80`, `environmentData.isMuted = true`
- `setAudioState({ volumePercentage: 80, isMuted: false })` (unmute) → `environmentData.volume = 0.80`, `environmentData.isMuted = false`

The stored `volume` is never zeroed by a mute — it retains the pre-mute level so that subsequent init handshakes (or future `getEnvironmentState` calls) reflect the real volume level even while muted.

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

**Publisher integration pattern:**

```js
const container = new SHARCContainer({ ... });
container.load();

// Web: listen to HTMLMediaElement volume changes
// volumechange fires for both volume AND muted changes — handle both atomically
videoElement.addEventListener('volumechange', () => {
  container.setAudioState({
    volumePercentage: Math.round(videoElement.volume * 100),
    isMuted: videoElement.muted,
    // Note: volumePercentage reflects actual volume level even when muted
    // (HTMLMediaElement.volume is not zeroed on mute — neither are we)
  });
});

// Native iOS/Android: call from your volume observer into the SHARC web layer
// window.sharcContainerRef.setAudioState({ volumePercentage: 80, isMuted: true });
```

---

## MRAID Bridge (`sharc-mraid-bridge.js`)

### New `SHARC.on('audioVolumeChange', ...)` handler

Add inside `installMRAIDBridge`, alongside the existing `stateChange` and `placementChange` handlers:

```js
/**
 * SHARC audioVolumeChange — maps to MRAID 3.0 §4.6 audioVolumeChange event.
 *
 * Receives all 3 fields: { volumePercentage, volume, isMuted }.
 * Updates _s._env.isMuted and _s._env.volume INDEPENDENTLY.
 * isMuted is sourced directly from the payload — NOT derived from volumePercentage.
 *
 * Ordering contract:
 *   1. Update internal env state FIRST (_env.isMuted, _env.volume, _env.volumePercentage)
 *   2. Fire all registered mraid.addEventListener('audioVolumeChange', ...) listeners
 *
 * Payload to MRAID: { volumePercentage } per MRAID 3.0 §4.6
 */
SHARC.on('audioVolumeChange', function (args) {
  var volumePercentage = (args && typeof args.volumePercentage === 'number')
    ? args.volumePercentage
    : 0;
  var isMuted = (args && typeof args.isMuted === 'boolean')
    ? args.isMuted
    : false;
  var volume = (args && typeof args.volume === 'number')
    ? args.volume
    : volumePercentage / 100;

  // 1. Update cached state — isMuted is sourced directly from the message,
  //    NOT derived from volumePercentage (web-standard independent mute semantics)
  if (_s._env) {
    _s._env.isMuted          = isMuted;          // independent boolean; never computed from volume
    _s._env.volume           = volume;            // 0.0–1.0
    _s._env.volumePercentage = volumePercentage;  // 0–100
  }

  // 2. Fire MRAID audioVolumeChange event per §4.6
  //    Payload: { volumePercentage } only — MRAID spec does not include isMuted in event payload
  _emit('audioVolumeChange', { volumePercentage: volumePercentage });
});
```

### `mraid.isAudioMuted()` — No Change Needed

The existing implementation reads `_s._env.isMuted` at call time:

```js
isAudioMuted: function () {
  if (!_s._env) return false;
  return _s._env.isMuted === true;
}
```

**No code change required.** The `audioVolumeChange` handler updates `_s._env.isMuted` live from the explicit `isMuted` boolean in the payload (not derived from `volumePercentage`). `isAudioMuted()` is a synchronous accessor over cached state — it automatically returns current state after each handler fires. This is correct by definition.

### `mraid.getVolume()` — reads `_s._env.volume`

```js
/**
 * Returns the current volume as a percentage (0–100).
 * Reads _s._env.volume which is kept live by the audioVolumeChange handler.
 * MRAID 3.0 §4.6.
 * @returns {number} 0–100
 */
getVolume: function () {
  if (!_s._env) return 0;
  if (typeof _s._env.volume === 'number') return Math.round(_s._env.volume * 100);
  return 0;
},
```

Note: `getVolume()` returns the stored volume level — **not zeroed when muted**. A muted creative at 80% volume returns `80` from `getVolume()` and `true` from `isAudioMuted()`.

### `addEventListener` / `removeEventListener` — No Change Needed

`audioVolumeChange` follows the same path as `stateChange` and `viewableChange` through `_emit()` and `_s._listeners`. No changes required.

### `sharc-creative.js` prerequisite

`SHARC.on('audioVolumeChange', fn)` requires the creative SDK to forward `SHARC:Container:audioVolumeChange` protocol messages. The creative SDK must:

1. Add a listener for `ContainerMessages.AUDIO_VOLUME_CHANGE` in its protocol message routing.
2. Extract `args` (all three fields) and dispatch to any `SHARC.on('audioVolumeChange', fn)` subscribers.

This is a **companion implementation task** in scope for the same v1 ticket.

---

## SafeFrame Bridge (`sharc-safeframe-bridge.js`)

### Assessment: does `$sf.ext` define any audio API?

**No.** The IAB SafeFrame 1.1 specification defines no audio-related methods or events in `$sf.ext`. There is no `$sf.ext.audioVolumeChange`, `$sf.ext.isAudioMuted()`, or equivalent.

### Recommendation: Do Not Implement in v1

**Recommendation: Skip the SafeFrame bridge for `audioVolumeChange` in v1.** (Aligned with PRD §7.)

**Rationale:**
1. No SafeFrame spec equivalent — IAB SafeFrame 1.1 defines no audio API
2. No creative demand signal — SafeFrame creatives do not register audio listeners
3. MRAID is the right boundary — MRAID 3.0 §4.6 is an explicit compliance requirement
4. Extension path exists if needed — the existing `SHARC.requestFeature()` / `SHARC.on()` mechanism provides a clean v2 path

**Revisit condition:** Re-evaluate if a publisher reports SafeFrame creatives adapting to audio state, IAB SafeFrame spec adds audio APIs, or a major DSP requests it.

---

## Test Harness (`examples/test/mraid-test.html`)

The test harness must maintain **two independent state variables**: `currentVolumePct` (0–100) and `isMuted` (boolean). When building a `setAudioState()` call, only the dimension the user just changed is updated — the other is read from current state.

### State variables

```js
var currentVolumePct = 100;   // independent: 0–100
var isMuted          = false; // independent: boolean
```

### Mute button

Toggles `isMuted` without touching `currentVolumePct`:

```js
function toggleMute() {
  if (!sharcContainer) return;
  isMuted = !isMuted;
  // volumePercentage is UNCHANGED — pass current stored level
  logMsg('cntr', 'Container:audioVolumeChange (sent)', { volumePercentage: currentVolumePct, isMuted: isMuted });
  var btn = document.getElementById('btn-mute');
  if (btn) btn.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
  updateMuteVisual();
  if (typeof sharcContainer.setAudioState === 'function') {
    sharcContainer.setAudioState({ volumePercentage: currentVolumePct, isMuted: isMuted });
  } else {
    logErr('sharcContainer.setAudioState() not available — update sharc-container.js');
  }
}
```

### Volume slider

Adjusts `currentVolumePct` without touching `isMuted`:

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
  currentVolumePct = parseInt(val, 10);
  // isMuted is UNCHANGED — pass current stored flag
  logMsg('cntr', 'Container:audioVolumeChange (sent)', { volumePercentage: currentVolumePct, isMuted: isMuted });
  updateMuteVisual();
  if (!sharcContainer) return;
  if (typeof sharcContainer.setAudioState === 'function') {
    sharcContainer.setAudioState({ volumePercentage: currentVolumePct, isMuted: isMuted });
  }
}
```

### Visual distinction: "volume at 0, not muted" vs "muted at any volume"

The slider position alone is insufficient to distinguish the two states. A separate visual indicator is required:

```js
function updateMuteVisual() {
  var indicator = document.getElementById('mute-indicator');
  if (!indicator) return;
  if (isMuted) {
    indicator.textContent = '🔇 MUTED (vol preserved at ' + currentVolumePct + '%)';
    indicator.style.color = '#dc2626'; // red
  } else if (currentVolumePct === 0) {
    indicator.textContent = '🔈 Volume at 0 (not muted)';
    indicator.style.color = '#d97706'; // amber — distinct from muted
  } else {
    indicator.textContent = '🔊 ' + currentVolumePct + '%';
    indicator.style.color = '#16a34a'; // green
  }
}
```

Add `vol-slider` to the `setLoaded` enable/disable list:

```js
['sim-active','sim-passive','sim-hidden','sim-frozen','sim-active2','sim-hidden2',
 'btn-placement','btn-log','btn-mute','vol-slider'].forEach(function (id) { ... });
```

**Critical constraint:** The mute button MUST NOT reset `volumePercentage` to 0 or 100. The slider MUST NOT change `isMuted`. Each control owns exactly one dimension of state.

**Why `oninput` vs `onchange`?** `oninput` fires on every drag tick (good for label); `onchange` fires only on commit (good for the protocol call). This avoids sending 60+ messages per second while the user drags — respecting the 50 msg/s rate limiter.

---

## Risk Assessment

### 1. Payload field synchronization (`volume` derived from `volumePercentage`)

**Risk:** `volume` is always `volumePercentage / 100`. If a future caller attempts to pass `volume` independently (e.g., thinking they can set a float directly), the value will be ignored — `sendAudioVolumeChange` derives it internally.

**Mitigation:** `volume` is a derived field, not an input. The public API (`setAudioState`) accepts only `volumePercentage` and `isMuted`. `volume` never enters the call chain as a parameter. Document this clearly: `volume` is a read-only convenience field in the payload, computed at dispatch time. No caller should ever attempt to set it independently.

**Residual risk:** Low. The API surface exposes no `volume` input. Risk limited to future maintainers who misread the payload schema.

### 2. Stale `isMuted` if mute and volume change simultaneously before `setAudioState` fires

**Risk:** A publisher listening to `volumechange` on `HTMLMediaElement` calls `setAudioState()` atomically — both `volume` and `muted` arrive in one call. This is the correct behavior. However, if a publisher mistakenly calls `setAudioState` twice in rapid succession (once for volume, once for mute), the second call's `isMuted` overwrites the first's `volumePercentage`.

**Mitigation:** The API is explicitly atomic: pass both dimensions every time. The state guard and independent `environmentData` storage ensure the last write wins, which is the correct behavior for audio state. The test harness demonstrates the correct pattern (always pass both current values).

### 3. Ordering / race conditions

**Risk:** `SHARC.on('audioVolumeChange', handler)` is wired inside `installMRAIDBridge`. If `SHARC` emits `audioVolumeChange` before the bridge is installed, the event is dropped.

**Mitigation:** `setAudioState()` is guarded to ACTIVE/PASSIVE states. The creative must have completed `Container:init` and `Container:startCreative` before reaching those states — meaning the MRAID bridge has already installed. **No race is possible under the current call graph.**

**Edge case:** If a publisher calls `setAudioState()` from an OS-level audio callback that fires very early (before `startCreative` resolves), the state guard silently drops the call. The next audio event after the creative reaches ACTIVE will carry the correct current volume. If this proves too aggressive, the guard can be relaxed to include READY. Revisit in v2.

### 4. `setAudioState()` called before `Container:init` completes

**Scenario:** Publisher mounts the container and immediately calls `setAudioState()` in a `mediaSession.onvolumechange` handler, before `createSession` is sent.

**Current protection:** State machine starts in `LOADING`. `setAudioState()` checks ACTIVE or PASSIVE — `LOADING` is neither. Call is dropped with `console.warn`. No "No MessagePort available" error fires in `_sendMessage`.

**Implementation option:** Split into two phases:
1. Always update `environmentData.volumePercentage`, `environmentData.volume`, `environmentData.isMuted` (no state check).
2. Only call `_protocol.sendAudioVolumeChange(...)` when state is ACTIVE or PASSIVE.

This gives correct init-time volume + correct live events, with no extra complexity. The correct pre-mute volume will flow into `Container:init` if the state is established later.

### 5. Backward compatibility

**Impact:** Zero for creatives not listening for `audioVolumeChange`. Fire-and-forget. Empty listener arrays are a no-op in `_emit`. Existing `mraid.isAudioMuted()` polling continues to work — it reads `_s._env.isMuted`, which is now kept live.

### 6. `isMuted` flag must never be derived from `volumePercentage`

**Risk:** Future maintainer introduces a shortcut: `isMuted = (volumePercentage === 0)`. This would silently break mute/unmute round-trips (cannot unmute at `volume > 0` after dragging slider to 0).

**Mitigation:** Document in JSDoc on `sendAudioVolumeChange`, `setAudioState`, and the MRAID bridge handler. Add AC-9 and AC-10 tests that explicitly assert `setAudioState({ volumePercentage: 0, isMuted: false })` does not produce `isMuted: true`. The explicit boolean in the protocol payload makes the source of truth unambiguous — no derivation is needed or acceptable.

---

## Data Flow Summary

```
Publisher OS event (volume button, call, BT disconnect)
  │
  ▼
sharcContainer.setAudioState({ volumePercentage, isMuted })   [sharc-container.js]
  ├── validates & clamps volumePercentage, requires boolean isMuted
  ├── updates environmentData.volumePercentage, .volume, .isMuted independently
  └── this._protocol.sendAudioVolumeChange(clamped, isMuted)
        │  derives volume = clamped / 100 internally
        ▼
  ContainerMessages.AUDIO_VOLUME_CHANGE                        [sharc-protocol.js]
  { volumePercentage: 0–100, volume: 0.0–1.0, isMuted: boolean }
        │  (fire-and-forget, NOT in MESSAGES_REQUIRING_RESPONSE)
        ▼
  Creative iframe receives message
        │
        ▼
  SHARC.on('audioVolumeChange', handler)                       [sharc-creative.js SDK]
        │  dispatches all 3 args fields to subscribers
        ▼
  MRAID bridge handler                                         [sharc-mraid-bridge.js]
    ├── _s._env.isMuted          = args.isMuted      (explicit boolean, NOT derived)
    ├── _s._env.volume           = args.volume        (0.0–1.0)
    ├── _s._env.volumePercentage = args.volumePercentage
    └── _emit('audioVolumeChange', { volumePercentage })
          └──▶ mraid.addEventListener('audioVolumeChange', fn)
                 receives { volumePercentage } per MRAID 3.0 §4.6

  mraid.isAudioMuted() → reads _s._env.isMuted        → correct by definition
  mraid.getVolume()    → reads _s._env.volume * 100   → volume level, not zeroed on mute
```

---

## Consequences

**What becomes easier:**
- MRAID 3.0 §4.6 compliance for `audioVolumeChange` event
- `mraid.isAudioMuted()` returns live state, sourced from the explicit `isMuted` boolean — not a fragile `=== 0` derivation
- `mraid.getVolume()` returns the live stored volume level, independent of mute state
- Mute/unmute round-trip is lossless: volume level is preserved through mute cycles
- Publisher integration maps cleanly to `HTMLMediaElement.volumechange` event semantics — no adapter logic needed
- Test harness can drive mute/unmute and volume independently without tearing down the container

**What becomes harder / requires attention:**
- Publishers must call `setAudioState()` at the OS/platform level. Both `volumePercentage` and `isMuted` must be passed on every call, even when only one dimension changes — the harness demonstrates the correct pattern.
- The legacy `volume` and `isMuted` fields in `environmentData` now have two update paths (init-time snapshot + live override). A future cleanup should consolidate to `volumePercentage` + `isMuted` as the canonical fields.
- Developers accustomed to `isMuted = (volume === 0)` must unlearn that pattern. The JSDoc and test cases make the independent semantics explicit.

---

## Implementation Checklist

- [ ] `sharc-protocol.js` — Add `AUDIO_VOLUME_CHANGE` to `ContainerMessages`
- [ ] `sharc-protocol.js` — Add `sendAudioVolumeChange(volumePercentage, isMuted)` to `SHARCContainerProtocol`; derive `volume` internally; send all 3 fields
- [ ] `sharc-container.js` — Add `setAudioState({ volumePercentage, isMuted })` public method; remove/replace any prior `setAudioVolume` placeholder
- [ ] `sharc-container.js` — Store `environmentData.volumePercentage`, `environmentData.volume`, `environmentData.isMuted` independently; never derive `isMuted` from `volumePercentage`
- [ ] `sharc-mraid-bridge.js` — Add `SHARC.on('audioVolumeChange', ...)` handler; update `_s._env.isMuted` from `args.isMuted` (explicit boolean, not derived)
- [ ] `sharc-mraid-bridge.js` — Add `mraid.getVolume()` method (reads `_s._env.volume`)
- [ ] `sharc-creative.js` — Route `AUDIO_VOLUME_CHANGE` message → `SHARC.on('audioVolumeChange', ...)` dispatcher; forward all three args fields
- [ ] `sharc-safeframe-bridge.js` — No changes required (v1 out of scope)
- [ ] `examples/test/mraid-test.html` — Two independent state vars: `currentVolumePct` and `isMuted`
- [ ] `examples/test/mraid-test.html` — Mute button calls `setAudioState({ volumePercentage: currentVolumePct, isMuted: !isMuted })`
- [ ] `examples/test/mraid-test.html` — Volume slider calls `setAudioState({ volumePercentage: sliderValue, isMuted: isMuted })`
- [ ] `examples/test/mraid-test.html` — Visual distinction: muted vs. volume-at-zero (separate indicator, not just slider position)
- [ ] `examples/test/mraid-test.html` — Add `vol-slider` to enabled/disabled element list
