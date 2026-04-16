# PRD: Live Audio Volume Change Signal (MRAID 3.0 §4.6)

**Status**: Draft  
**Author**: Alex (Product Manager)  
**Last Updated**: 2026-04-09  
**Version**: 1.1  
**Stakeholders**: SHARC Protocol Lead, MRAID Bridge Maintainer, Test Harness Owner  

### Revision History

| Version | Date | Change Summary |
|---------|------|---------------|
| 1.0 | 2026-04-09 | Initial draft |
| 1.1 | 2026-04-09 | Web standards alignment: revised payload to `{ volumePercentage, volume, isMuted }`; introduced independent mute/volume tracking per `HTMLMediaElement` semantics; recommended Option B (combined `setAudioState`) API; updated ACs and test harness |

---

## 1. Problem Statement

SHARC sends `isMuted` and `volume` exactly once — at `Container:init` — inside `environmentData`. After initialization, there is no mechanism for the container to signal audio state changes to the creative during an active ad session.

**This creates three concrete compliance failures:**

1. **`mraid.isAudioMuted()` returns stale data.** It reads `_s._env.isMuted`, which is set at init and never updated. If the user mutes the device mid-ad, the creative cannot know.

2. **No `audioVolumeChange` event fires.** The MRAID bridge has no listener for any SHARC audio event, so `mraid.addEventListener('audioVolumeChange', fn)` is a dead registration — the callback never fires.

3. **Volume level is not tracked during playback.** The `volume` field in `environmentData` ages from the moment of init. A creative that adapts behavior to audio level (e.g., showing a "tap for sound" overlay when muted) cannot do so correctly.

**Who is affected:** Any MRAID 3.0 creative that registers `audioVolumeChange` listeners or calls `mraid.isAudioMuted()` after playback begins. Creatives that adapt layout, copy, or interaction affordances based on audio state receive incorrect signal and may display incorrect UI.

**Cost of not solving:** SHARC fails MRAID 3.0 §4.6 compliance. Creatives that test against MRAID spec will malfunction. Publisher integrations that certify against the MRAID compliance test suite will fail on the audio state tests.

---

## 2. MRAID 3.0 §4.6 Compliance Requirement

MRAID 3.0 §4.6 defines `audioVolumeChange` as a **live event** that the SDK must fire whenever device audio volume changes during ad playback:

```
mraid.addEventListener('audioVolumeChange', function(volumePercentage) { ... })
```

- **Payload**: `{ volumePercentage: Number }` where `0` = muted (or silent), `100` = full volume.
- **Trigger**: Fires whenever the device audio volume changes, including mute/unmute toggles.
- **Timing**: Must fire during active ad playback, not only at init.
- **`mraid.isAudioMuted()`**: Must return a live value consistent with the most recently received `audioVolumeChange` signal.

SHARC's current architecture routes all environment signals through `Container:init → environmentData`. There is no existing container-to-creative message for live audio state. A new protocol message is required.

---

## 3. Design Goal: HTMLMediaElement Alignment

> **This is a first-class design constraint, not a nice-to-have.**

The web platform standard for audio state is [`HTMLMediaElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement), which exposes:

| Property | Type | Semantics |
|----------|------|-----------|
| `volume` | `float` 0.0–1.0 | Current volume level; **not affected by mute** |
| `muted` | `boolean` | Whether audio is muted; **independent of `volume`** |

**The critical web-standard behavior:** muting does NOT change the `volume` value. A user can mute at `volume = 0.8`, and unmuting restores to `volume = 0.8` — not to 0.0. The `muted` flag is a separate toggle that suppresses audio output without altering the stored volume level.

**Our prior design violated this.** The v1.0 PRD defined `isMuted = (volumePercentage === 0)`, conflating the two concepts. This means:
- `setAudioVolume(0)` would incorrectly signal `isMuted = true`
- Unmuting would have no way to restore the pre-mute volume (it was overwritten to 0)
- Publishers using `HTMLMediaElement` events natively would need to re-map the semantics before calling our API

Aligning with `HTMLMediaElement` semantics removes an impedance mismatch for publishers, enables correct round-trip mute/unmute behavior, and positions SHARC as web-native rather than an ad-tech island.

---

## 4. Protocol Design: `SHARC:Container:audioVolumeChange`

### 4.1 New Message Type

Add to `ContainerMessages` in `sharc-protocol.js`:

```javascript
const ContainerMessages = Object.freeze({
  // ...existing entries...
  AUDIO_VOLUME_CHANGE: 'SHARC:Container:audioVolumeChange',
});
```

### 4.2 Message Payload Shape (Revised v1.1)

```javascript
{
  sessionId:  "<uuid>",
  messageId:  <number>,
  timestamp:  <epoch-ms>,
  type:       "SHARC:Container:audioVolumeChange",
  args: {
    volumePercentage: <number>,   // 0–100 (MRAID 3.0 §4.6 format)
    volume:           <number>,   // 0.0–1.0 (HTMLMediaElement format)
    isMuted:          <boolean>   // independent mute state (HTMLMediaElement format)
  }
}
```

**Field constraints:**

| Field | Type | Range | Semantics |
|-------|------|-------|-----------|
| `volumePercentage` | `number` | `[0, 100]` integers | MRAID 3.0 §4.6 compliance; clamped by sender |
| `volume` | `number` | `[0.0, 1.0]` float | `HTMLMediaElement.volume` equivalent; derived as `volumePercentage / 100` |
| `isMuted` | `boolean` | `true` / `false` | `HTMLMediaElement.muted` equivalent; **independent of `volume`** |

**Key invariants:**
- `volume` is always derived from `volumePercentage`: `volume = volumePercentage / 100`
- `isMuted` is **never** derived from `volumePercentage`. Setting `volumePercentage = 0` does **NOT** set `isMuted = true`.
- When muted, `volumePercentage` and `volume` retain their pre-mute values (e.g., muting at 80% keeps `volumePercentage = 80`, `volume = 0.80`, `isMuted = true`)
- `isMuted = true` with `volumePercentage > 0` is valid and expected behavior
- Values outside `[0, 100]` MUST be clamped by the sender before dispatch

**Rate limiting:** Subject to the existing 50-msg/sec rate limiter in `SHARCProtocolBase`. Publishers firing volume events at high frequency (e.g., from a continuous `volumechange` DOM event) SHOULD debounce before calling the container API. Recommended debounce: 100ms.

**Fire-and-forget:** This message does NOT require a resolve/reject response. Do NOT add it to `MESSAGES_REQUIRING_RESPONSE`.

### 4.3 When to Send

The container sends `SHARC:Container:audioVolumeChange` whenever:
- The device audio volume level changes (any `volumePercentage` change)
- The mute state changes (any `isMuted` toggle), even when `volumePercentage` is unchanged

The container MUST NOT send this message before `Container:init` resolves or after `Container:close` is sent.

---

## 5. Container API: Recommendation — Option B (`setAudioState`)

### 5.1 API Decision: Option B (Combined Method)

**We recommend Option B: a single `setAudioState({ volumePercentage, isMuted })` method.**

**Options considered:**

| Option | Signature | Pros | Cons |
|--------|-----------|------|------|
| **A** | `setAudioVolume(n)` + `setMuted(bool)` | Mirrors `HTMLMediaElement` property setters; familiar to web devs | Two separate calls required when both change simultaneously (common on mobile); atomicity risk — brief intermediate state if fired separately; more surface area to test |
| **B** ✅ | `setAudioState({ volumePercentage, isMuted })` | Single atomic state update; matches how publishers receive state from OS/browser (both values arrive together on `volumechange`); payload directly maps to protocol message args; fewer calls, cleaner publisher integration | Slightly less familiar to devs who think in individual setters |

**Justification for Option B:**

In practice, publishers receive audio state as a bundle. The Web Audio API `volumechange` event fires once per change — and that change may be volume, mute, or both simultaneously (e.g., native iOS hardware mute sets `muted = true` without changing `volume`). A single atomic `setAudioState()` call maps cleanly to this event model, avoids the ordering ambiguity of two separate calls, and directly mirrors the protocol message payload. Option A's two-setter model creates a seam where intermediate inconsistent state could be dispatched to the creative if the publisher calls them sequentially.

### 5.2 Method Signature

```javascript
/**
 * Notifies the creative of an audio state change.
 * Clamped volumePercentage to [0, 100] before sending.
 * isMuted is independent of volumePercentage — muting does NOT zero the volume.
 * No-op if called before init resolves or after close.
 *
 * @param {Object} audioState
 * @param {number}  audioState.volumePercentage - Current volume level (0–100)
 * @param {boolean} audioState.isMuted          - Whether audio is muted (independent of volume)
 */
SHARCContainer.prototype.setAudioState = function({ volumePercentage, isMuted }) { ... }
```

### 5.3 Implementation Contract

1. **Validate inputs**: Reject non-numeric `volumePercentage` or non-boolean `isMuted` with a console warning; return without sending.
2. **Clamp volume**: `Math.max(0, Math.min(100, Math.round(volumePercentage)))`.
3. **State guard**: No-op if `_terminated` is `true` or container state is not in `{active, passive, hidden}`.
4. **Do NOT derive `isMuted` from `volumePercentage`**: Accept `isMuted` exactly as provided. `setAudioState({ volumePercentage: 0, isMuted: false })` is valid — volume at zero, not muted.
5. **Cache the state**: Update `this.environmentData` to keep state consistent for any future init handshake:
   - `this.environmentData.volumePercentage = clamped`
   - `this.environmentData.volume = clamped / 100`
   - `this.environmentData.isMuted = isMuted`
6. **Send via protocol**: Build and dispatch the full payload:
   ```javascript
   this._protocol._sendMessage(ContainerMessages.AUDIO_VOLUME_CHANGE, {
     volumePercentage: clamped,
     volume: clamped / 100,
     isMuted: isMuted
   });
   ```
7. **Returns**: `void` (fire-and-forget; no Promise).

### 5.4 Publisher Integration Pattern

```javascript
const container = new SHARCContainer({ ... });
container.load();

// Web: listen to HTMLMediaElement volume changes
// volumechange fires for both volume AND muted changes — handle both atomically
videoElement.addEventListener('volumechange', () => {
  container.setAudioState({
    volumePercentage: Math.round(videoElement.volume * 100),
    isMuted: videoElement.muted
    // Note: volumePercentage reflects actual volume level even when muted
    // (HTMLMediaElement.volume is not zeroed when muted — neither are we)
  });
});

// Native iOS/Android: call from your volume observer into the SHARC web layer
// window.sharcContainerRef.setAudioState({ volumePercentage: 80, isMuted: true });
```

---

## 6. MRAID Bridge: `audioVolumeChange` Event Mapping

### 6.1 New SHARC Event Handler in `sharc-mraid-bridge.js`

Add a listener inside `installMRAIDBridge()`:

```javascript
SHARC.on('audioVolumeChange', function(args) {
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
    _s._env.isMuted          = isMuted;
    _s._env.volume           = volume;        // 0.0–1.0
    _s._env.volumePercentage = volumePercentage;
  }

  // 2. Fire MRAID audioVolumeChange event per §4.6
  _emit('audioVolumeChange', { volumePercentage: volumePercentage });
});
```

### 6.2 Updated `isAudioMuted()`

The existing implementation reads `_s._env.isMuted` at call time:

```javascript
isAudioMuted: function () {
  if (!_s._env) return false;
  return _s._env.isMuted === true;
}
```

**No code change required.** Once the `audioVolumeChange` handler updates `_s._env.isMuted` live (using the explicit `isMuted` boolean from the payload — not derived from `volumePercentage`), `isAudioMuted()` automatically returns current state. This is correct: `isAudioMuted()` is a synchronous accessor over cached state, not a SHARC query.

### 6.3 `addEventListener` / `removeEventListener` — No Change Needed

`audioVolumeChange` follows the same path as `stateChange` and `viewableChange` through `_emit()` and `_s._listeners`. No changes required.

### 6.4 `sharc-creative.js` Prerequisite

`SHARC.on('audioVolumeChange', fn)` requires the creative SDK to forward `SHARC:Container:audioVolumeChange` protocol messages to registered listeners. The creative SDK must:

1. Add a listener for `ContainerMessages.AUDIO_VOLUME_CHANGE` in its protocol message routing.
2. Extract `args` (all three fields) and dispatch to any `SHARC.on('audioVolumeChange', fn)` subscribers.

This is a **companion implementation task** in scope for the same v1 ticket.

---

## 7. SafeFrame Bridge: Recommendation

### 7.1 Decision: Do Not Implement in v1

**Recommendation: Skip the SafeFrame bridge for `audioVolumeChange` in v1.**

**Rationale:**

1. **No SafeFrame spec equivalent.** IAB SafeFrame 1.1 defines no audio API. There is no spec-defined callback to fire or property to update.
2. **No creative demand signal.** SafeFrame creatives do not register audio listeners.
3. **MRAID is the right boundary.** MRAID 3.0 §4.6 is an explicit compliance requirement. SafeFrame has no such requirement.
4. **Extension path exists if needed.** The existing `SHARC.requestFeature()` / `SHARC.on()` mechanism provides a clean v2 path.

### 7.2 Revisit Condition

Re-evaluate if: (a) a publisher reports SafeFrame creatives adapting to audio state, OR (b) IAB SafeFrame spec adds audio APIs, OR (c) a major DSP requests it for a SafeFrame creative with audio-adaptive behavior.

---

## 8. Test Harness: Independent Mute and Volume Controls

The existing SHARC test harness mute button currently reinitializes the container to change `isMuted`. After this implementation:
- The mute button MUST send a live `setAudioState()` call without reinit
- The volume slider MUST send a live `setAudioState()` call without reinit
- **The mute button and volume slider MUST operate independently** — adjusting one MUST NOT affect the other's state

### 8.1 Expected Mute Button Behavior (Post-Implementation)

```
1. Ad is playing. volumePercentage = 80, isMuted = false.
2. User clicks mute button in test harness.
3. Container calls: sharcContainer.setAudioState({ volumePercentage: 80, isMuted: true })
   ↑ volumePercentage is UNCHANGED — still 80, not zeroed
4. Protocol sends: SHARC:Container:audioVolumeChange
     { volumePercentage: 80, volume: 0.80, isMuted: true }
5. Creative receives message → SHARC SDK dispatches 'audioVolumeChange' event
6. MRAID bridge handler fires:
     - Updates _s._env.isMuted = true
     - Updates _s._env.volume = 0.80 (unchanged)
     - Updates _s._env.volumePercentage = 80 (unchanged)
     - Emits 'audioVolumeChange' { volumePercentage: 80 }
7. mraid.isAudioMuted() now returns: true
8. NO Container:init is sent. NO session is restarted.

Unmute:
9.  User clicks unmute button.
10. Container calls: sharcContainer.setAudioState({ volumePercentage: 80, isMuted: false })
    ↑ volumePercentage restored to pre-mute level (80), NOT zeroed
11. Protocol sends: { volumePercentage: 80, volume: 0.80, isMuted: false }
12. mraid.isAudioMuted() now returns: false
```

### 8.2 Volume Slider Behavior (Independent of Mute)

The volume slider adjusts `volumePercentage` only. It MUST NOT change `isMuted`.

```
Current state: volumePercentage = 80, isMuted = false

User drags slider to 50:
  → setAudioState({ volumePercentage: 50, isMuted: false })  // isMuted unchanged
  → Protocol sends: { volumePercentage: 50, volume: 0.50, isMuted: false }

User then clicks mute:
  → setAudioState({ volumePercentage: 50, isMuted: true })   // volumePercentage unchanged at 50
  → Protocol sends: { volumePercentage: 50, volume: 0.50, isMuted: true }

User then unmutes:
  → setAudioState({ volumePercentage: 50, isMuted: false })  // restores to 50, not 0 or 100
```

**Critical test harness constraint:** The harness must maintain independent state for volume and mute. When building the `setAudioState()` call, it must read current values for both dimensions and only update the one the user just changed. The mute button must NOT reset `volumePercentage` to 0 or 100.

### 8.3 Edge Case: Volume Slider at Zero (Not Muted)

```
User drags slider to 0:
  → setAudioState({ volumePercentage: 0, isMuted: false })
  → Protocol sends: { volumePercentage: 0, volume: 0.0, isMuted: false }
  → mraid.isAudioMuted() returns: false   ← volume = 0 ≠ muted
```

The test harness should visually distinguish "volume at zero" from "muted" (e.g., a separate mute indicator, not just the slider position).

---

## 9. Acceptance Criteria

The following criteria are testable and must all pass before this initiative is considered shipped:

| # | Criterion | How to Test |
|---|-----------|-------------|
| AC-1 | `SHARC:Container:audioVolumeChange` message is sent with correct `{ volumePercentage, volume, isMuted }` when `sharcContainer.setAudioState(n)` is called | Intercept protocol messages; verify all three fields in `args` |
| AC-2 | `sharcContainer.setAudioState()` clamps `volumePercentage`: `{ volumePercentage: -10 }` sends `0`, `{ volumePercentage: 150 }` sends `100` | Assert protocol message args for out-of-range inputs |
| AC-3 | `mraid.isAudioMuted()` returns `true` after `setAudioState({ volumePercentage: 80, isMuted: true })` | Call `isAudioMuted()` synchronously in `audioVolumeChange` listener; assert `true` |
| AC-4 | `mraid.isAudioMuted()` returns `false` after `setAudioState({ volumePercentage: 50, isMuted: false })` | Same; assert `false` |
| AC-5 | `mraid.addEventListener('audioVolumeChange', fn)` receives `{ volumePercentage: N }` matching the value sent | Register listener before calling `setAudioState`; assert payload equality |
| AC-6 | No `Container:init` is sent when `setAudioState()` is called on an active session | Assert `Container:init` message count does not increase |
| AC-7 | `setAudioState()` is a no-op (no message sent) after `container.close()` or when destroyed | Call `setAudioState()` after `close()`; assert no `audioVolumeChange` message dispatched |
| **AC-8** | **Muting at 80% then unmuting restores `volumePercentage` to 80, not 0** | `setAudioState({ volumePercentage: 80, isMuted: true })` then `setAudioState({ volumePercentage: 80, isMuted: false })`; assert second message has `volumePercentage: 80` and `isMuted: false` |
| **AC-9** | **`setAudioState({ volumePercentage: 0, isMuted: false })` does NOT set `isMuted = true`** | Call with `volumePercentage: 0, isMuted: false`; assert protocol message has `isMuted: false`; assert `mraid.isAudioMuted()` returns `false` |
| **AC-10** | **`isMuted` in protocol payload is sourced from the explicit input, never derived from `volumePercentage`** | Verify in unit tests that `setAudioState({ volumePercentage: 0, isMuted: false })` and `setAudioState({ volumePercentage: 80, isMuted: true })` both pass `isMuted` through exactly as provided |
| **AC-11** | **Protocol payload includes all three fields: `volumePercentage`, `volume`, `isMuted`** | Assert `args.volume === args.volumePercentage / 100` and all three fields present on every dispatched message |
| **AC-12** | **Test harness mute button and volume slider operate independently** | Set volume slider to 60, mute, then unmute — assert `volumePercentage` remains 60 throughout; drag slider to 40 while muted — assert `isMuted` remains `true` |

---

## 10. Out of Scope for v1

The following are explicitly deferred:

| Item | Reason | Revisit Condition |
|------|--------|-------------------|
| SafeFrame bridge audio support | No spec equivalent in SafeFrame 1.1; no creative demand signal | IAB SafeFrame spec update or publisher request |
| SHARC extension for audio in SafeFrame via `requestFeature` | Speculative; no defined behavior | Creative vendor request with use case |
| Per-channel volume (music vs. ringer vs. media) | Platform-specific; MRAID 3.0 doesn't differentiate | MRAID 3.1 spec or platform-specific extension request |
| Creative-initiated audio queries (`SHARC:Creative:getAudioVolume`) | Not in MRAID 3.0 §4.6; `isAudioMuted()` covers the pull-model use case | Spec update or explicit DSP request |
| Automatic volume detection in the container (no publisher wiring needed) | Container cannot access device audio state directly in sandboxed iframe; publisher must wire OS/media events | Platform SDK integration story |
| Debounce built into `setAudioState()` | Publisher is closer to the event source and better positioned to debounce | Performance issue reported in production |
| Option A dual-method API (`setAudioVolume` + `setMuted`) | Atomicity risk; two-call model creates intermediate state exposure; Option B preferred | Explicit publisher request or demonstrated integration difficulty with Option B |

---

## 11. Appendix

### 11.1 Current State (Gap Summary)

| Capability | Current Behavior | Target Behavior |
|------------|-----------------|-----------------|
| `mraid.isAudioMuted()` | Returns init-time `isMuted`; never updates | Returns live value; updated by `audioVolumeChange` signal |
| `audioVolumeChange` event | Never fires | Fires on every `setAudioState()` call with current `volumePercentage` |
| Volume tracking during playback | Stale after init | Live; updated via `SHARC:Container:audioVolumeChange` |
| Container public API | No audio method | `sharcContainer.setAudioState({ volumePercentage, isMuted })` |
| Mute/volume independence | Conflated (`isMuted = volumePercentage === 0`) | Independent: `isMuted` is a separate boolean, not derived from volume |
| Payload alignment | N/A (no live message) | Carries all three: `volumePercentage` (MRAID), `volume` (HTMLMediaElement), `isMuted` (HTMLMediaElement) |
| SafeFrame bridge | No audio support | No audio support (by design; out of scope) |

### 11.2 HTMLMediaElement vs. MRAID 3.0 vs. SHARC (Alignment Table)

| Concept | HTMLMediaElement | MRAID 3.0 §4.6 | SHARC (v1.1) |
|---------|-----------------|----------------|--------------|
| Volume level | `volume` (0.0–1.0) | `volumePercentage` (0–100) | Both: `volume` + `volumePercentage` |
| Mute state | `muted` (boolean) | Implied: `volumePercentage === 0` | `isMuted` (boolean, independent) |
| Mute changes volume? | **No** | N/A | **No** |
| Volume at zero = muted? | **No** | **Yes** (conflated) | **No** (follows HTMLMediaElement) |

SHARC v1.1 resolves the MRAID/HTMLMediaElement conflict by carrying all three fields and following `HTMLMediaElement` semantics for mute independence. The MRAID bridge derives `isAudioMuted()` from `isMuted` (not `volumePercentage`), which is a strict improvement over the MRAID spec's conflation.

### 11.3 Files to Modify

| File | Change |
|------|--------|
| `examples/sharc-protocol.js` | Add `AUDIO_VOLUME_CHANGE: 'SHARC:Container:audioVolumeChange'` to `ContainerMessages` |
| `examples/sharc-container.js` | Add `setAudioState({ volumePercentage, isMuted })` public method; remove/replace any prior `setAudioVolume` placeholder |
| `examples/sharc-creative.js` | Route `AUDIO_VOLUME_CHANGE` message → `SHARC.on('audioVolumeChange', ...)` dispatcher; forward all three args fields |
| `examples/sharc-mraid-bridge.js` | Add `SHARC.on('audioVolumeChange', fn)` handler; update `_s._env.isMuted` from `args.isMuted` (not derived from `volumePercentage`) |
| `examples/sharc-safeframe-bridge.js` | No changes required |
| `examples/` (test harness) | Update mute button to call `setAudioState`; add independent volume slider; track mute and volume state separately |

### 11.4 Protocol Message Taxonomy

This message follows the same fire-and-forget pattern as `SHARC:Container:stateChange` and `SHARC:Container:placementChange`. It is **not** added to `MESSAGES_REQUIRING_RESPONSE`. Audio state is ambient environment signal, not a transactional request. Mis-sequenced or dropped messages degrade gracefully — the creative's last-known audio state may be stale for one event cycle, which is acceptable.
