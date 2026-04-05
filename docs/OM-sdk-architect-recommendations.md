# OM SDK Integration — Architectural Recommendations

**Author:** Software Architect (Dev Team)
**Date:** 2026-04-05
**Input:** [OM SDK Research](./OM-sdk-research.md) + review of `examples/` reference implementation
**Status:** Draft for Working Group discussion

---

## Executive Summary

After reviewing the OM SDK research document and all five reference implementation files, I recommend integrating OM SDK as a **first-class SHARC extension** using the existing `supportedFeatures` mechanism — specifically as a **container-resident measurement adapter** rather than a creative-side library or a middleware layer. The creative signals high-level semantic events through the SHARC message bus; the container translates those signals into OM SDK API calls, owns the Service Script lifecycle, and manages verification script loading.

This approach is:
- **Additive**: zero changes to existing creative API surface
- **Consistent**: follows the MRAID and SafeFrame bridge pattern already established
- **Secure**: keeps verification vendors out of the creative iframe's execution context
- **Cross-platform ready**: the extension model isolates platform-specific OM SDK variants behind the container boundary

---

## 1. Integration Pattern Recommendation

### Chosen Pattern: Container-Resident OM Adapter via `supportedFeatures`

The research document correctly identifies three candidate patterns. My recommendation and reasoning:

| Pattern | Verdict | Reason |
|---------|---------|--------|
| Creative-side OM SDK (direct) | ❌ Reject | Violates SHARC's trust boundary; gives vendors unmediated DOM access; no isolation |
| Middleware/proxy layer | ⚠️ Avoid | Adds a third process boundary with no clear ownership; over-engineered for v1 |
| Container-resident adapter via `supportedFeatures` | ✅ Recommended | Follows established SHARC extension pattern; container owns vendor trust; minimal creative API changes |

**Why the container should own OM SDK:**

1. **Trust boundary alignment.** The container already owns navigation, tracker firing (`_fireTrackers`), and placement enforcement. Measurement is the same class of concern — a publisher/platform responsibility, not a creative responsibility. The same reasoning that led to `SHARC:Creative:reportInteraction` (container fires trackers on behalf of creative) applies to impression measurement.

2. **OM SDK's own requirements enforce this.** The OM SDK Service Script (`omweb-v1.js`) must not be concatenated or compiled into other scripts, and must run in its own `<script>` execution context. This means it cannot live inside the sandboxed creative iframe. The container's host page is the correct execution environment.

3. **Verification script isolation.** Verification scripts (IAS, DV, Moat, etc.) must be isolated from creative code per the OM SDK access mode model. The container is the natural enforcement point.

4. **Parallel with SIMID.** The research document notes that SIMID already integrates OM SDK at the player (container) layer. SHARC should follow the same proven pattern.

### Extension Registration

The container advertises OM SDK support in `Container:init` via `supportedFeatures`:

```json
{
  "name": "com.iabtechlab.sharc.omid",
  "version": "1.0",
  "config": {
    "partnerName": "sharc-container",
    "partnerVersion": "0.1.0",
    "impressionType": "BEGIN_TO_RENDER",
    "supportsMediaEvents": true
  }
}
```

The creative uses the existing `SHARC.hasFeature('com.iabtechlab.sharc.omid')` call (already implemented in `sharc-creative.js`) — no new feature detection API is needed.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PUBLISHER PAGE (container host document)                               │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  SHARCContainer (sharc-container.js)                             │  │
│  │                                                                  │  │
│  │  ┌─────────────────────────┐   ┌────────────────────────────┐   │  │
│  │  │  SHARCContainerProtocol │   │  OMIDMeasurementAdapter     │   │  │
│  │  │  (MessageChannel port1) │   │  (new: sharc-omid-adapter)  │   │  │
│  │  │                         │   │                            │   │  │
│  │  │  stateChange ──────────►│──►│ → adEvents.loaded()        │   │  │
│  │  │  placementChange ──────►│──►│ → session context update   │   │  │
│  │  │  reportInteraction ────►│──►│ → adUserInteraction()      │   │  │
│  │  │  requestOmid ──────────►│──►│ → MediaEvents.firstQ()     │   │  │
│  │  │  close ────────────────►│──►│ → adSession.finish()       │   │  │
│  │  └─────────────────────────┘   └────────────────────────────┘   │  │
│  │                                         │                        │  │
│  └─────────────────────────────────────────│────────────────────────┘  │
│                                            │                           │
│  ┌─────────────────────────────────────────▼────────────────────────┐  │
│  │  OM SDK Service Layer (same page, separate <script> tags)        │  │
│  │                                                                  │  │
│  │  ┌────────────────────┐   ┌─────────────────────────────────┐   │  │
│  │  │  omweb-v1.js        │   │  omid-session-client-v1.js      │   │  │
│  │  │  (Service Script)   │   │  (JS Session Client)            │   │  │
│  │  │                    │◄──►│  AdSession, Partner, Context    │   │  │
│  │  │  Verification mgmt │   │  AdEvents, MediaEvents          │   │  │
│  │  └────────────────────┘   └─────────────────────────────────┘   │  │
│  │            │                                                     │  │
│  │            ▼                                                     │  │
│  │  ┌──────────────────────────────────────────────────────────┐   │  │
│  │  │  Verification Script Iframes                             │   │  │
│  │  │  (IAS, DoubleVerify, Moat, etc.)                         │   │  │
│  │  │  Access mode: "limited" (same-origin) or "full"          │   │  │
│  │  └──────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ MessageChannel (port2)
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│  CREATIVE IFRAME (sandboxed)                                            │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  sharc-protocol.js + sharc-creative.js                           │  │
│  │                                                                  │  │
│  │  SHARC.hasFeature('com.iabtechlab.sharc.omid')  → true           │  │
│  │                                                                  │  │
│  │  SHARC.requestFeature('com.iabtechlab.sharc.omid', {             │  │
│  │    action: 'signalMediaEvent', event: 'firstQuartile'            │  │
│  │  })                                                              │  │
│  │                                                                  │  │
│  │  // OR: fire via existing SHARC message primitives               │  │
│  │  // (see §4 API Surface below)                                   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key architectural property:** The OM SDK Service Script and verification scripts **never cross the iframe sandbox boundary**. They live on the container/publisher page. The creative iframe sends semantic events (not raw OM SDK calls) over the existing SHARC MessageChannel.

---

## 3. Data Flow: SHARC Events → OM SDK Session Lifecycle

### 3.1 Session Lifecycle Mapping

```
SHARC Lifecycle                          OM SDK Session Lifecycle
─────────────────                        ────────────────────────

Container.load()
  │
  ├─ [container page] omweb-v1.js ────► OmidSessionClient initialized
  ├─ [container page] Session Client ──► Partner + Context created
  │
  ▼
createSession (creative→container)
  │
  ▼
Container:init (container→creative)    ──► adSession.start()
  supportsFeatures: [omid]                adSession.registerSessionObserver()
  │                                       (sessionStart event fired)
  ▼
Container:startCreative
  │                                   ──► adEvents.loaded(VastProperties)
  ▼                                       [creativeType, impressionType set]
state: ACTIVE + visible                ──► adEvents.impressionOccurred()
  │
  ▼
[creative signals media events]
  │
  ├─ SHARC:Creative:requestOmid        ──► mediaEvents.start(duration, volume)
  ├─ SHARC:Creative:requestOmid        ──► mediaEvents.firstQuartile()
  ├─ SHARC:Creative:requestOmid        ──► mediaEvents.midpoint()
  ├─ SHARC:Creative:requestOmid        ──► mediaEvents.thirdQuartile()
  ├─ SHARC:Creative:requestOmid        ──► mediaEvents.complete()
  │
  ├─ SHARC:Container:stateChange       ──► adEvents.stateChange()
  │   (hidden/frozen)                      mediaEvents.playerStateChange(MINIMIZED)
  │
  ├─ SHARC:Creative:reportInteraction  ──► mediaEvents.adUserInteraction(CLICK)
  │   (click event)
  │
  ▼
Container:close / Creative:requestClose
  │                                    ──► adSession.finish()
  ▼                                        [3s delay, then unload omweb-v1.js]
container._destroy()
```

### 3.2 State → OM SDK Player State Mapping

| SHARC State | OM SDK PlayerState | Notes |
|-------------|-------------------|-------|
| `active` | `NORMAL` | Visible, in-focus |
| `passive` | `NORMAL` | Visible, split-screen; OM SDK has no PASSIVE equivalent |
| `hidden` | `MINIMIZED` | Backgrounded / tab hidden |
| `frozen` | `MINIMIZED` | OS suspended; OM SDK pause is appropriate |
| `ready` | _(pre-session)_ | OM SDK session not yet started |
| `terminated` | _(post-finish)_ | adSession.finish() already called |

**Design decision:** `passive` maps to `NORMAL` rather than `MINIMIZED` because the creative is still visible (split-screen, call overlay). The OM SDK distinction that matters for measurement is viewable vs. not viewable, which maps cleanly to `active/passive` (viewable) vs. `hidden/frozen` (not viewable).

### 3.3 Impression Timing

The OM SDK requires `impressionOccurred()` to fire on "first frame played." In SHARC's model:

- **Display ads**: `impressionOccurred()` fires when state transitions to `ACTIVE` and the iframe becomes visible (both conditions must be true simultaneously).
- **Video ads**: `impressionOccurred()` fires when `mediaEvents.start()` is called (i.e., when the creative signals `SHARC:Creative:requestOmid` with `action: 'signalMediaEvent', event: 'start'`). This matches OM SDK's `BEGIN_TO_RENDER` impression type.

The container must gate `impressionOccurred()` on state being `ACTIVE`, not merely on receiving the event signal, to prevent impression fraud from off-screen ads.

---

## 4. API Surface Analysis

### 4.1 What Existing Messages Can Handle (No Changes Needed)

| OM SDK Need | Existing SHARC Message | Adapter Action |
|-------------|----------------------|----------------|
| Session start signal | `Container:init` resolve | `adSession.start()` |
| Creative loaded | `Container:startCreative` resolve | `adEvents.loaded(VastProperties)` |
| Impression (display) | `Container:stateChange(active)` | `adEvents.impressionOccurred()` |
| Player state changes | `Container:stateChange` | `mediaEvents.playerStateChange()` |
| User click/interaction | `Creative:reportInteraction` | `mediaEvents.adUserInteraction(CLICK)` |
| Session finish | `Container:close` | `adSession.finish()` |
| Error | `Container:fatalError` | OM SDK `sessionError` observer |

### 4.2 New Message Required: `SHARC:Creative:requestOmid`

For media-specific events (quartiles, buffering, volume) that have no existing SHARC equivalent, one new message type is needed:

**Message type:** `SHARC:Creative:requestOmid`

**Structure:**
```json
{
  "sessionId": "...",
  "messageId": 42,
  "timestamp": 1712345678000,
  "type": "SHARC:Creative:requestOmid",
  "args": {
    "action": "signalMediaEvent",
    "event": "firstQuartile",
    "params": {}
  }
}
```

**Supported `action` values:**

| Action | Required `params` | Maps To |
|--------|------------------|---------|
| `signalAdEvent` | `event`: `"impressionOccurred"` | `adEvents.impressionOccurred()` |
| `signalAdEvent` | `event`: `"loaded"`, `vastProperties: {...}` | `adEvents.loaded(VastProperties)` |
| `signalMediaEvent` | `event`: `"start"`, `duration`, `volume` | `mediaEvents.start(d, v)` |
| `signalMediaEvent` | `event`: `"firstQuartile"` | `mediaEvents.firstQuartile()` |
| `signalMediaEvent` | `event`: `"midpoint"` | `mediaEvents.midpoint()` |
| `signalMediaEvent` | `event`: `"thirdQuartile"` | `mediaEvents.thirdQuartile()` |
| `signalMediaEvent` | `event`: `"complete"` | `mediaEvents.complete()` |
| `signalMediaEvent` | `event`: `"bufferStart"` | `mediaEvents.bufferStart()` |
| `signalMediaEvent` | `event`: `"bufferFinish"` | `mediaEvents.bufferFinish()` |
| `signalMediaEvent` | `event`: `"pause"` | `mediaEvents.pause()` |
| `signalMediaEvent` | `event`: `"resume"` | `mediaEvents.resume()` |
| `signalMediaEvent` | `event`: `"skipped"` | `mediaEvents.skipped()` |
| `signalMediaEvent` | `event`: `"volumeChange"`, `volume`: 0–1 | `mediaEvents.volumeChange(v)` |

**Why a new message instead of reusing `requestFeature`?**

`SHARC.requestFeature('com.iabtechlab.sharc.omid', {...})` would work but generates a synthetic message type `SHARC:Creative:requestOmid` via the `_capitalize` mechanism in `sharc-creative.js`. A dedicated message type is cleaner, auditable in protocol logs, and can be added to `MESSAGES_REQUIRING_RESPONSE` explicitly. Both approaches work; the explicit message type is architecturally cleaner.

**Container-side response:**
```json
{
  "type": "resolve",
  "args": {
    "messageId": 42,
    "value": { "sessionId": "om-session-abc123", "status": "ok" }
  }
}
```

### 4.3 New Container-to-Creative Push: `SHARC:Container:omidStatus` (optional)

For creatives that want to know when OM verification scripts are loaded/ready, an optional one-way notification:

```json
{
  "type": "SHARC:Container:omidStatus",
  "args": {
    "status": "sessionStart",
    "omSessionId": "om-session-abc123",
    "verificationScriptCount": 2
  }
}
```

This is **fire-and-forget** (no resolve/reject required). Creatives can listen with `SHARC.on('omidStatus', cb)` if they need this signal. It is not required for the core measurement flow.

### 4.4 Creative SDK Ergonomics

For video creatives, the typical call sequence would be:

```javascript
// In creative HTML — no OM SDK knowledge required
SHARC.onReady(async (env, features) => {
  if (SHARC.hasFeature('com.iabtechlab.sharc.omid')) {
    // Container will handle OM SDK session; signal when ready with VastProperties
    await SHARC.requestFeature('com.iabtechlab.sharc.omid', {
      action: 'signalAdEvent',
      event: 'loaded',
      vastProperties: {
        isSkippable: false,
        isAutoPlay: true,
        position: 'preroll',
        creativeType: 'video'
      }
    });
  }
});

// Later, as video plays:
videoElement.addEventListener('timeupdate', () => {
  const pct = videoElement.currentTime / videoElement.duration;
  if (pct >= 0.25 && !quartile1Fired) {
    quartile1Fired = true;
    SHARC.requestFeature('com.iabtechlab.sharc.omid', {
      action: 'signalMediaEvent',
      event: 'firstQuartile'
    });
  }
});
```

This is deliberately similar to the existing `SHARC.requestFeature()` call pattern, requiring no OM SDK knowledge in the creative.

---

## 5. Reference Implementation Impact

### 5.1 Impact Assessment

| File | Change Type | Nature of Change |
|------|------------|-----------------|
| `sharc-protocol.js` | **Additive** | Add `SHARC:Creative:requestOmid` to `CreativeMessages` enum and to `MESSAGES_REQUIRING_RESPONSE` set |
| `sharc-container.js` | **Additive** | Add listener for `requestOmid`; delegate to new adapter class |
| `sharc-creative.js` | **None** | Zero changes required — `requestFeature()` already handles this |
| `sharc-mraid-bridge.js` | **None** | Not affected |
| `sharc-safeframe-bridge.js` | **None** | Not affected |

### 5.2 The Only Material Changes to Existing Files

**`sharc-protocol.js`** — two additions, both backward compatible:

```javascript
// In CreativeMessages:
REQUEST_OMID: 'SHARC:Creative:requestOmid',

// In MESSAGES_REQUIRING_RESPONSE:
CreativeMessages.REQUEST_OMID,
```

**`sharc-container.js`** — one new listener registration in `_registerProtocolListeners()`:

```javascript
// Creative:requestOmid — OM SDK measurement event signals
proto.addListener(CreativeMessages.REQUEST_OMID, (msg) => {
  this._onMessage && this._onMessage('received', msg);
  this._handleRequestOmid(msg);  // delegates to omid adapter
});
```

And an optional feature injection in the constructor's `supportedFeatures` if OM SDK is configured:

```javascript
// Container advertises OM SDK support when omidAdapter is configured
if (options.omidAdapter) {
  this.supportedFeatures.push(options.omidAdapter.getFeatureDescriptor());
}
```

### 5.3 New Files Needed

Following the established bridge pattern (`sharc-mraid-bridge.js` + `mraid-wrapper.html`), two new files:

```
examples/
  sharc-omid-bridge.js    ← NEW: container-side bridge logic
  omid-wrapper.html       ← NEW: nested iframe with OM SDK loaded
```

This mirrors the exact pattern used for MRAID and SafeFrame bridges:
- The **bridge JS** runs in the main container, handles `requestOmid` message mapping
- The **HTML wrapper** is loaded as a nested iframe inside the container, providing an isolated execution context for the OM SDK Service Script (`omweb-v1.js`) and Session Client (`omid-session-client-v1.js`)

The HTML wrapper pattern is specifically the correct solution for the `allow-same-origin` sandbox constraint — the wrapper runs in its own iframe, outside the creative's sandbox, with full access to load OM SDK `<script>` tags. The bridge JS mediates between the creative's SHARC message bus and the wrapper's OM SDK session.

This file would:
1. Load `omweb-v1.js` (Service Script) dynamically into the publisher page
2. Create `Partner`, `Context`, and `AdSession` via the Session Client
3. Expose `handleOmidRequest(msg)` for the container to delegate to
4. Translate SHARC state changes to OM SDK lifecycle events
5. Manage session cleanup on container destroy

The file should follow the same UMD wrapper pattern as the other examples. It is **entirely isolated** — none of the existing files need to know about OM SDK internals.

### 5.4 Verdict: Additive, Not Invasive

The integration is cleanly additive. The OM SDK adapter is an optional plugin — a container without it simply omits `com.iabtechlab.sharc.omid` from `supportedFeatures`, and creatives that check `hasFeature()` gracefully degrade. This is the correct pattern.

---

## 6. Security & Privacy Implications

### 6.1 Trust Model Analysis

The SHARC security model has three principals:
- **Container** (publisher-controlled, trusted)
- **Creative** (advertiser-controlled, semi-trusted)
- **Verification vendors** (third-party, untrusted)

The OM SDK integration introduces the third party. This is where security risk is concentrated.

### 6.2 Threat Matrix

| Threat | Vector | Mitigation |
|--------|--------|------------|
| Verification script escaping sandbox | Loaded by OM Service Script on publisher page | OM SDK's own access mode system (`limited` vs `full`); container should default to `limited` |
| Creative spoofing measurement events | Creative sends false quartile signals | Container validates signals against state machine (e.g., reject `firstQuartile` if `start` not received); rate-limiting via `_rateLimitAllow()` already in place |
| Impression inflation (off-screen ads) | Creative sends `impressionOccurred` when hidden | Container gates `impressionOccurred()` on `ACTIVE` state — the container, not the creative, owns this decision |
| Vendor data exfiltration via SHARC state | Verification scripts reading SHARC session data | Verification scripts run on publisher page, not in SHARC message bus — they see only what OM SDK exposes to them (viewability geometry, not ad content) |
| Partner name spoofing | Creative provides false partner name | Partner name is set by container config, not by creative; creative cannot influence it |
| Session hijacking | Creative substitutes own session ID | Container owns OM SDK session lifecycle; creative can only send semantic events, not control session state |
| `requestOmid` rate flooding | Creative sends excessive measurement events | Existing `_rateLimitAllow()` (50 msg/sec) applies; container can additionally debounce OM SDK event calls |

### 6.3 Access Mode Recommendation

For the `VerificationScriptResource` access mode:
- **Default to `limited`** for all verification vendors unless explicitly configured otherwise
- `full` mode should require explicit publisher opt-in in container configuration
- Document this clearly in the extension spec — access mode is a **publisher decision**, not a creative decision

### 6.4 UniversalAdId / Advertiser Data Exposure

The OM SDK `UniversalAdId` (v1.5.5+) passes the creative ID and registry to verification scripts. This should come from the AdCOM `dataspec` passed in `environmentData`, not from creative-supplied data. The container extracts it; the creative cannot forge it.

### 6.5 Privacy Considerations

- Verification scripts loaded by OM SDK have access to publisher page geometry (viewport size, element position). This is inherent to viewability measurement and not a SHARC-specific concern.
- SHARC's sandboxed iframe model (`allow-scripts` without `allow-same-origin`) prevents verification scripts from accessing creative content, which is a privacy improvement over legacy SafeFrame implementations.
- The `sfMeta` and `dataspec` patterns show how SHARC already passes advertiser data to the creative. The container should apply the same scrutiny to what it exposes via `Context` to the OM SDK session.

---

## 7. Cross-Platform Considerations

### 7.1 Platform Matrix

| Platform | SHARC Transport | OM SDK Variant | Integration Notes |
|----------|----------------|----------------|-------------------|
| **Web (desktop/mobile browser)** | iframe + MessageChannel | `omid-session-client-v1.js` (Web Video) | Primary target; full support |
| **Mobile (iOS WebView)** | WKWebView + MessageChannel | `OMSDK.framework` (iOS native) | Container is native app; creative is WebView; see §7.2 |
| **Mobile (Android WebView)** | WebView + MessageChannel | `.aar` library (Android) | Container is native app; creative is WebView; see §7.2 |
| **CTV (Smart TV browsers)** | iframe + MessageChannel | Web Video SDK with CTV extensions | Out of scope v1; see §7.3 |
| **CTV (tvOS/AndroidTV)** | WebView + MessageChannel | Native SDKs with CTV additions | Out of scope v1; see §7.3 |

### 7.2 Mobile WebView: Critical Architectural Difference

On iOS and Android, the SHARC container is a **native app**, not a web page. This changes the OM SDK integration substantially:

- The native app initializes the OM SDK via `OMIDSDK.activate()` (iOS) or `Omid.activate(context)` (Android)
- The `AdSessionContext` is created with a `webView` parameter pointing to the SHARC iframe's WKWebView/WebView
- The native layer owns impression detection and viewability calculation (not JavaScript)
- The SHARC message bus still carries semantic events from creative → container, but the container's OM SDK adapter is now **native code**, not JavaScript

**Implication for the adapter design:** The `sharc-omid-adapter.js` file (web) and the native OM SDK integration (mobile) share the same **message protocol** (same `SHARC:Creative:requestOmid` message format), but have completely different implementations. The container abstraction successfully isolates this platform difference from the creative.

The creative code is **identical** across web and mobile WebView — it sends the same `requestOmid` messages. Only the container-side adapter implementation differs.

### 7.3 CTV: Deferred but Designed For

CTV is explicitly out of scope for v1 per the research document. However, the architecture should not make CTV harder to add later:

- The `com.iabtechlab.sharc.omid` feature name is platform-agnostic
- The `config` object in the feature descriptor should include a `deviceCategory` field (populated by the container at runtime) for CTV environments
- CTV-specific additions (`lastActivity`, `displayConnectionStatus`, `percentageInView`) are additive to the response object from `requestOmid` actions
- Video pod measurement (CTV gapless playback) would require a new `signalPodEvent` action type in the `requestOmid` message, not a new message type

### 7.4 Environment Detection Pattern

The container should detect environment and select the appropriate OM SDK integration at initialization:

```
Container init
  ├─ environment.platform === 'web' → OMIDWebAdapter (JS Session Client)
  ├─ environment.platform === 'ios' → [native bridge to iOS OMID SDK]
  ├─ environment.platform === 'android' → [native bridge to Android OM SDK]
  └─ environment.platform === 'ctv' → [deferred; log warning]
```

The creative sees none of this — it always uses the same `requestOmid` message pattern.

---

## 8. Recommended Approach

### 8.1 My Preferred Architecture (with Reasoning)

**"Container-Resident OM Adapter as a SHARC Feature Plugin"**

The existing bridge pattern in `sharc-mraid-bridge.js` and `sharc-safeframe-bridge.js` demonstrates exactly the right architecture: a bridge class with a `getFeatureName()` / `getScriptUrls()` interface that the container uses to configure itself. The OM SDK adapter should follow the same pattern on the **container side**.

```
Container instantiation:
  new SHARCContainer({
    creativeUrl: '...',
    extensions: [new OMIDMeasurementAdapter({
      partnerName: 'my-ad-server',
      partnerVersion: '2.1.0',
      impressionType: 'BEGIN_TO_RENDER',
      verificationResources: vastAdVerifications  // from VAST/AdCOM parsing
    })]
  })
```

The `OMIDMeasurementAdapter` (container-side) would:
1. Register itself as `com.iabtechlab.sharc.omid` in `supportedFeatures`
2. Load `omweb-v1.js` into the publisher page (if not already loaded)
3. Initialize a JS Session Client with the AdVerifications from AdCOM
4. Intercept `stateChange`, `close`, `requestOmid` events from the protocol
5. Translate each to the appropriate OM SDK API call
6. Clean up the OM SDK session on container destroy (with the required 3-second delay before unloading the Service Script)

### 8.2 Implementation Phasing

**Phase 1 (SHARC v1 — ship with reference impl):**
- Add `SHARC:Creative:requestOmid` to the protocol message enum
- Implement `sharc-omid-adapter.js` for Web Video environment only
- Automatic impression detection (container-gated on `ACTIVE` state)
- Map all media event types listed in §4.2
- Document in the extension guide with a working example

**Phase 2 (SHARC v1.1):**
- Native mobile adapter bridge (iOS/Android)
- `com.iabtechlab.sharc.omid` in the official IAB extension registry
- Integration testing with IAS/DV/Moat validation scripts
- `SHARC:Container:omidStatus` notification for advanced creative use cases

**Phase 3 (SHARC v2 / CTV):**
- CTV-specific adapter with `deviceCategory`, `lastActivity`, `displayConnectionStatus`
- Video pod measurement for gapless playback
- Device attestation (v1.5 Privacy Pass protocol)
- Feed back patterns to IAB OM Working Group

### 8.3 What I Would Not Do

1. **Do not embed OM SDK knowledge in `sharc-creative.js`**: The creative SDK should remain measurement-agnostic. OM SDK awareness lives only in the adapter.

2. **Do not create a generic "measurement middleware" layer**: The research document's middleware option is appealing but adds a third process boundary and an additional message hop for every event. The container-adapter pattern is simpler and sufficient.

3. **Do not allow creatives to supply `VerificationScriptResource` URLs directly**: Verification vendor scripts should come from the AdCOM `dataspec` (VAST AdVerifications parsed by the container), not from creative-supplied data. Allowing creative-supplied verification URLs would create a script injection vector.

4. **Do not signal `impressionOccurred()` from the creative side**: The container must own this call, gated on