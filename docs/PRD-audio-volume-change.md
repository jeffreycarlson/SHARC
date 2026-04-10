# PRD: Live Audio Volume Change Signal (MRAID 3.0 §4.6)

**Status**: Draft  
**Author**: Alex (Product Manager)  
**Last Updated**: 2026-04-09  
**Version**: 1.0  
**Stakeholders**: SHARC Protocol Lead, MRAID Bridge Maintainer, Test Harness Owner  

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
- **`mraid.isAudioMuted()`**: Must return a live value consistent with the most recently received `audioVolumeChange` signal (i.e., `volumePercentage === 0`).

SHARC's current architecture routes all environment signals through `Container:init → environmentData`. There is no existing container-to-creative message for live audio state. A new protocol message is required.

---

## 3. Protocol Design: `SHARC:Container:audioVolumeChange`

### 3.1 New Message Type

Add to `ContainerMessages` in `sharc-protocol.js`:

```javascript
const ContainerMessages = Object.freeze({
  // ...existing entries...
  AUDIO_VOLUME_CHANGE: 'SHARC:Container:audioVolumeChange',
});
```

### 3.2 Message Payload Shape

```javascript
{
  sessionId:  "<uuid>",
  messageId:  <number>,
  timestamp:  <epoch-ms>,
  type:       "SHARC:Container:audioVolumeChange",
  args: {
    volumePercentage: <number>  // 0–100; 0 means muted or silent
  }
}
```

**Field constraints:**
- `volumePercentage` MUST be a number in the range `[0, 100]` (inclusive).
- Values outside this range MUST be clamped by the sender before dispatch.
- `0` represents muted or zero volume; `100` represents full device volume.
- The message is **fire-and-forget** — it does NOT require a resolve/reject response. Do NOT add it to `MESSAGES_REQUIRING_RESPONSE`.

**Rate limiting:** This message is subject to the existing 50-msg/sec rate limiter in `SHARCProtocolBase`. Publishers firing volume events at high frequency (e.g., from a continuous `volumechange` DOM event) SHOULD debounce before calling `setAudioVolume()`. Recommended debounce: 100ms.

### 3.3 When to Send

The container sends `SHARC:Container:audioVolumeChange` whenever the device audio volume changes during an active session. The container MUST NOT send this message before `Container:init` resolves or after `Container:close` is sent.

---

## 4. Container API: `sharcContainer.setAudioVolume(volumePercentage)`

### 4.1 Method Signature

```javascript
/**
 * Notifies the creative of an audio volume change.
 * Clamps volumePercentage to [0, 100] before sending.
 * No-op if called before init resolves or after close.
 *
 * @param {number} volumePercentage - Current volume level (0 = muted, 100 = full)
 */
SHARCContainer.prototype.setAudioVolume = function(volumePercentage) { ... }
```

### 4.2 Implementation Contract

1. **Clamp input**: `Math.max(0, Math.min(100, Math.round(volumePercentage)))`. Reject non-numeric values silently (log a warning, return).
2. **State guard**: No-op if `_destroyed` is `true` or container state is not in `{active, passive, hidden}`. (Don't send during init handshake or after close.)
3. **Cache the value**: Update `this.environmentData.isMuted` and `this.environmentData.volume` on the container side to keep state consistent. This ensures if a new init handshake ever occurs, the current audio state is reflected.
4. **Send via protocol**: `this._protocol._sendMessage(ContainerMessages.AUDIO_VOLUME_CHANGE, { volumePercentage: clamped })`.
5. **Returns**: `void` (fire-and-forget; no Promise).

### 4.3 Publisher Integration Pattern

```javascript
// Publisher wires up OS/browser audio events and calls setAudioVolume:
const container = new SHARCContainer({ ... });
container.load();

// Web: listen to HTML media element volume changes
videoElement.addEventListener('volumechange', () => {
  const pct = videoElement.muted ? 0 : Math.round(videoElement.volume * 100);
  container.setAudioVolume(pct);
});

// Native iOS/Android: call from your volume observer into the SHARC web layer
// window.sharcContainerRef.setAudioVolume(newVolumePercent);
```

---

## 5. MRAID Bridge: `audioVolumeChange` Event Mapping

### 5.1 New SHARC Event Handler in `sharc-mraid-bridge.js`

Add a listener inside `installMRAIDBridge()` alongside the existing `SHARC.on('stateChange', ...)` and `SHARC.on('placementChange', ...)` handlers:

```javascript
SHARC.on('audioVolumeChange', function(args) {
  var volumePercentage = (args && typeof args.volumePercentage === 'number')
    ? args.volumePercentage
    : 0;

  // 1. Update cached muted state so isAudioMuted() stays live
  if (_s._env) {
    _s._env.isMuted  = (volumePercentage === 0);
    _s._env.volume   = volumePercentage / 100;  // normalize to 0–1 for internal consistency
  }

  // 2. Fire MRAID audioVolumeChange event per §4.6
  _emit('audioVolumeChange', { volumePercentage: volumePercentage });
});
```

### 5.2 Updated `isAudioMuted()`

The existing implementation reads `_s._env.isMuted` at call time:

```javascript
isAudioMuted: function () {
  if (!_s._env) return false;
  return _s._env.isMuted === true;
}
```

This requires **no code change** — once the `audioVolumeChange` handler updates `_s._env.isMuted` live, `isAudioMuted()` will automatically return current state. This is the correct approach; `isAudioMuted()` is a synchronous accessor over cached state, not a SHARC query.

### 5.3 `addEventListener` / `removeEventListener` — No Change Needed

`audioVolumeChange` follows the same path as `stateChange` and `viewableChange` through `_emit()` and `_s._listeners`. The existing event system handles it. No changes to `addEventListener` or `removeEventListener` are required.

### 5.4 `sharc-creative.js` Prerequisite

`SHARC.on('audioVolumeChange', fn)` depends on the creative SDK (`sharc-creative.js`) forwarding the `SHARC:Container:audioVolumeChange` protocol message to registered `SHARC.on()` listeners. The creative SDK must:

1. Add a listener for `ContainerMessages.AUDIO_VOLUME_CHANGE` in its protocol message routing.
2. Extract `args.volumePercentage` and dispatch to any `SHARC.on('audioVolumeChange', fn)` subscribers.

This is a **companion implementation task** but is in scope for the same v1 ticket.

---

## 6. SafeFrame Bridge: Recommendation

### 6.1 Decision: Do Not Implement in v1

**Recommendation: Skip the SafeFrame bridge for `audioVolumeChange` in v1.**

**Rationale:**

1. **No SafeFrame spec equivalent.** The IAB SafeFrame 1.1 specification (`$sf.ext`) defines no audio API — not `audioVolumeChange`, not `isMuted`, not any volume property. There is no spec-defined callback to fire or property to update.

2. **No creative demand signal.** SafeFrame creatives do not register audio listeners because the spec doesn't define them. Implementing a SHARC-proprietary audio extension on the SafeFrame bridge would be non-standard and provide zero interoperability value.

3. **MRAID is the right boundary.** MRAID 3.0 §4.6 is an explicit compliance requirement with a defined contract. SafeFrame has no such requirement. Implementing parity would be speculative engineering against undefined creative behavior.

4. **Extension path exists if needed.** If a publisher or creative vendor demonstrates a legitimate need for audio signals in a SafeFrame context, the existing SHARC extension mechanism (`SHARC.requestFeature()` / `SHARC.on()`) provides a clean path to add it without modifying the SafeFrame spec layer. That is a v2 decision.

### 6.2 Revisit Condition

Re-evaluate if: (a) a publisher reports SafeFrame creatives adapting to audio state, OR (b) IAB SafeFrame spec adds audio APIs, OR (c) a major DSP requests it for a SafeFrame creative with audio-adaptive behavior.

---

## 7. Test Harness: Mute Button Behavior After Implementation

The existing SHARC test harness (`examples/` or equivalent demo page) has a mute button that currently reinitializes the container to change `isMuted`. After this implementation, the mute button MUST send a live signal without reinit.

### 7.1 Expected Mute Button Behavior (Post-Implementation)

```
1. Ad is playing. isMuted = false. volume = 100.
2. User clicks mute button in test harness.
3. Container calls: sharcContainer.setAudioVolume(0)
4. Protocol sends: SHARC:Container:audioVolumeChange { volumePercentage: 0 }
5. Creative receives message → SHARC SDK dispatches 'audioVolumeChange' event
6. MRAID bridge handler fires:
     - Updates _s._env.isMuted = true
     - Emits 'audioVolumeChange' to all registered creative listeners
7. Creative's listener receives: { volumePercentage: 0 }
8. mraid.isAudioMuted() now returns: true
9. NO Container:init is sent. NO session is restarted.

Unmute:
10. User clicks unmute button.
11. Container calls: sharcContainer.setAudioVolume(100)
12. Repeat steps 4–8 with volumePercentage = 100, isMuted = false.
```

### 7.2 Volume Slider Behavior

If the test harness includes a volume slider:

- Dragging to 0 → `setAudioVolume(0)` → `isAudioMuted()` returns `true`
- Dragging to 50 → `setAudioVolume(50)` → `isAudioMuted()` returns `false`
- Dragging to 100 → `setAudioVolume(100)` → `isAudioMuted()` returns `false`

---

## 8. Acceptance Criteria

The following criteria are testable and must all pass before this initiative is considered shipped:

| # | Criterion | How to Test |
|---|-----------|-------------|
| AC-1 | `SHARC:Container:audioVolumeChange` message is sent with correct `volumePercentage` when `sharcContainer.setAudioVolume(n)` is called | Intercept protocol messages in test harness; verify type and args |
| AC-2 | `sharcContainer.setAudioVolume()` clamps values: `setAudioVolume(-10)` sends `0`, `setAudioVolume(150)` sends `100` | Assert protocol message args for out-of-range inputs |
| AC-3 | `mraid.isAudioMuted()` returns `true` after `setAudioVolume(0)` fires, without container reinit | Call `isAudioMuted()` synchronously in `audioVolumeChange` listener; assert true |
| AC-4 | `mraid.isAudioMuted()` returns `false` after `setAudioVolume(50)` fires | Same as above; assert false |
| AC-5 | `mraid.addEventListener('audioVolumeChange', fn)` receives `{ volumePercentage: N }` matching the value sent by `setAudioVolume(N)` | Register listener before calling `setAudioVolume`; assert payload equality |
| AC-6 | No `Container:init` is sent when `setAudioVolume()` is called on an active session | Assert `Container:init` message count does not increase |
| AC-7 | `setAudioVolume()` is a no-op (no message sent) when called after `container.close()` or when container is destroyed | Call `setAudioVolume(50)` after `close()`; assert no `audioVolumeChange` message is dispatched |

---

## 9. Out of Scope for v1

The following are explicitly deferred:

| Item | Reason | Revisit Condition |
|------|--------|-------------------|
| SafeFrame bridge audio support | No spec equivalent in SafeFrame 1.1; no creative demand signal | IAB SafeFrame spec update or publisher request |
| SHARC extension for audio in SafeFrame via `requestFeature` | Speculative; no defined behavior | Creative vendor request with use case |
| Per-channel volume (music vs. ringer vs. media) | Platform-specific; MRAID 3.0 doesn't differentiate | MRAID 3.1 spec or platform-specific extension request |
| Creative-initiated audio queries (`SHARC:Creative:getAudioVolume`) | Not in MRAID 3.0 §4.6; `isAudioMuted()` covers the pull-model use case | Spec update or explicit DSP request |
| Automatic volume detection in the container (no publisher wiring needed) | Container cannot access device audio state directly in sandboxed iframe; publisher must wire OS/media events | Platform SDK integration story |
| Debounce built into `setAudioVolume()` | Publisher is closer to the event source and better positioned to debounce | Performance issue reported in production |

---

## 10. Appendix

### 10.1 Current State (Gap Summary)

| Capability | Current Behavior | Target Behavior |
|------------|-----------------|-----------------|
| `mraid.isAudioMuted()` | Returns init-time `isMuted`; never updates | Returns live value; updated by `audioVolumeChange` signal |
| `audioVolumeChange` event | Never fires | Fires on every `setAudioVolume()` call with current `volumePercentage` |
| Volume tracking during playback | Stale after init | Live; updated via `SHARC:Container:audioVolumeChange` |
| Container public API | No audio method | `sharcContainer.setAudioVolume(n)` |
| SafeFrame bridge | No audio support | No audio support (by design; out of scope) |

### 10.2 Files to Modify

| File | Change |
|------|--------|
| `examples/sharc-protocol.js` | Add `AUDIO_VOLUME_CHANGE: 'SHARC:Container:audioVolumeChange'` to `ContainerMessages` |
| `examples/sharc-container.js` | Add `setAudioVolume(volumePercentage)` public method |
| `examples/sharc-creative.js` | Route `AUDIO_VOLUME_CHANGE` message → `SHARC.on('audioVolumeChange', ...)` dispatcher |
| `examples/sharc-mraid-bridge.js` | Add `SHARC.on('audioVolumeChange', fn)` handler; update `_s._env.isMuted` and emit MRAID event |
| `examples/sharc-safeframe-bridge.js` | No changes required |

### 10.3 Protocol Message Taxonomy

This message follows the same fire-and-forget pattern as `SHARC:Container:stateChange` and `SHARC:Container:placementChange`. It is **not** added to `MESSAGES_REQUIRING_RESPONSE`. Rationale: audio state is ambient environment signal, not a transactional request. The creative does not need to acknowledge receipt; the container does not need confirmation the creative processed it. Mis-sequenced or dropped messages degrade gracefully — the creative's last-known audio state may be stale for one event cycle, which is acceptable.
