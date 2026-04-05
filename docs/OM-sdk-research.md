# OM SDK + SHARC Integration Research

**Author:** Ad Tech Team (tracking-measurement-specialist lead)
**Date:** 2026-04-05
**Status:** Research draft for SHARC Working Group consideration

---

## Executive Summary

The OM SDK (Open Measurement Software Development Kit) is the IAB Tech Lab's standard for third-party viewability and verification measurement. It currently ships in three platform variants:

1. **OM SDK for Apps** — iOS/Android native SDKs (the mature, established variant)
2. **OM SDK for CTV** — DACH integration pattern for CTV environments
3. **OM SDK for Web Video** — JavaScript variant for web video ads

SHARC, as the unified replacement for SafeFrame (web) and MRAID (in-app), represents a natural integration point for OM SDK. This document analyzes the OM SDK JS API surface, maps it to SHARC's architecture, identifies gaps, and proposes an integration pattern.

**Key finding:** SHARC's `supportedFeatures` extension mechanism is purpose-built for this. OM SDK should be exposed as `com.iabtechlab.sharc.omid` — a SHARC-supported feature that enables measurement creatives to subscribe to ad lifecycle events through the SHARC message bus without direct DOM access.

---

## 1. OM SDK JS API Surface (Web Video)

### 1.1 Architecture

The OM SDK Web Video has two components:

- **Service Script** (`omweb-v1.js`): Standalone JS binary loaded in its own `<script>` tag. Performs measurement and manages verification scripts. **Must not be concatenated or compiled into other scripts.**
- **JS Session Client** (`omid-session-client-v1.js`): JS library integrations use to interact with the Service Script. Can be compiled into the integration's scripts.

### 1.2 Core Session Lifecycle

```
1. Acquire SessionClient classes from global OmidSessionClient
2. Create Partner( PARTNER_NAME, PARTNER_VERSION)
3. Create Context(partner, verificationScriptResources, contentURL)
4. Create AdSession(context)
5. adSession.start()
6. Register session observer for sessionStart, sessionError, sessionFinish
7. Signal events (AdEvents, MediaEvents)
8. adSession.finish()
9. Cleanup (unload Service Script after 3s delay)
```

### 1.3 Session Client Classes (OM ID 1.6 JSDoc)

| Class | Purpose |
|-------|---------|
| `AdSession` | Core session lifecycle — start, finish, event binding |
| `Partner` | Integration identity — name and version assigned by IAB Tech Lab |
| `Context` | Ad session context — partner, verification scripts, content URL |
| `VerificationScriptResource` | Third-party verification vendor script + access mode |
| `AdEvents` | Ad lifecycle events (2 methods: impressionOccurred, loaded) |
| `MediaEvents` | Media playback events (quartiles, buffering, state, volume, interaction) |
| `VerificationClient` | For verification scripts to communicate with OM ID JS Service |
| `OmidVersion` | Version utilities |

**Correction from Web Video docs:** AdEvents on video creatives has more methods (skipped, paused, resumed, stateChange, volumeChange, adUserInteraction) when loaded with vastProperties. The base JSDoc shows only 2 methods (impressionOccurred, loaded) but the integration guide documents the full video event set.
| `Partner` | Integration identity — name and version assigned by IAB Tech Lab |
| `Context` | Ad session context — partner, verification scripts, content URL |
| `VerificationScriptResource` | Third-party verification vendor script + access mode |
| `AdEvents` | Ad lifecycle events — impression, loaded, skipped, paused, resumed, stateChange, volumeChange |
| `MediaEvents` | Media playback events — start, firstQuartile, midpoint, thirdQuartile, complete, bufferStart, bufferFinish, playerStateChange, adUserInteraction, volumeChange |

### 1.4 Key Events

**AdEvents** (per JSDoc):
- `loaded(VastProperties?)` — signals ad is loaded with skippable, skipOffset, autoPlay, position metadata. VastProperties is non-null for video/audio creatives, null for display creatives.
- `impressionOccurred()` — first frame played (once per session)

Note: The JSDoc shows `AdEvents` with only these 2 methods. Additional video-specific events (skipped, paused, resumed, stateChange, volumeChange, adUserInteraction) are documented in the OM SDK for Web Video integration guide and apply to video/audio creatives specifically.

**MediaEvents** (full JSDoc):
- `start(duration, mediaPlayerVolume)` — media playback begins (duration in seconds, volume 0-1)
- `firstQuartile()` / `midpoint()` / `thirdQuartile()` / `complete()` — quartile tracking
- `bufferStart()` / `bufferFinish()` — buffering events
- `pause()` / `resume()` — user-initiated pause/resume
- `playerStateChange(playerState)` — NORMAL, FULLSCREEN, MINIMIZED, EXPANDED and other states
- `adUserInteraction(interactionType)` — CLICK, other interaction types
- `volumeChange(mediaPlayerVolume)` — volume changes (0-1)
- `skipped()` — user skip (media should not resume after skip)

### 1.5 VastProperties

Passed with `AdEvents.loaded()`:
- `isSkippable` (boolean)
- `skipOffset` (number, optional)
- `isAutoPlay` (boolean)
- `position` ("preroll" | "midroll" | "postroll" | "standalone")
- `creativeType` — "video" or "audio"

### 1.6 Session Observer

```js
adSession.registerSessionObserver((event) => {
  if (event.type === "sessionStart") { /* dispatch first events */ }
  else if (event.type === "sessionError") { /* handle error */ }
  else if (event.type === "sessionFinish") { /* cleanup */ }
});
```

### 1.7 Access Modes (Web-specific, not in Apps SDK)

- `limited` — verification script loaded in same-origin iframe, restricted access
- `full` — verification script has full access to DOM
- This is a key differentiator from the Apps variant which doesn't need explicit access modes

### 1.8 Validation

- OM SDK provides a validation verification script (`omid-validation-verification-script-v1.js`)
- Console logs and errors for debugging
- Reference app available: https://github.com/InteractiveAdvertisingBureau/Open-Measurement-JSClients/tree/master/reference-app-web

---

## 2. SHARC Architecture Relevant to OM SDK

### 2.1 SHARC Features and Extensions

SHARC's initialization provides `supportedFeatures` in `SHARC:Container:init`:

```
dictionary MessageArgs {
  required EnvironmentData environmentData;
  Features supportedFeatures;
};
```

Features use namespacing convention: `com.iabtechlab.sharc.[featureName]`
Third-party features use their own namespace.

### 2.2 SHARC Container → Creative Messages

| Message | Relevance to OM SDK |
|---------|-------------------|
| `SHARC:Container:init` | Carries `supportedFeatures` — where OM SDK feature would be declared |
| `SHARC:Container:stateChange` | Maps to MediaEvents.playerStateChange, AdEvents.stateChange |
| `SHARC:Container:placementChange` | Placement changes could trigger impression events |
| `SHARC:Container:close` / `adClosed` | Maps to sessionFinish |
| `SHARC:Container:log` | Debug logging |
| `SHARC:Container:fatalError` | Maps to sessionError |

### 2.3 SHARC Creative → Container Messages

| Message | Relevance to OM SDK |
|---------|-------------------|
| `SHARC:Creative:requestPlacementChange` | Placement changes relevant to measurement |
| `SHARC:Creative:reportInteraction` | Can carry interaction metrics that map to OM SDK events |
| `SHARC:Creative:getFeatures` | Creative queries for OM SDK support |
| `SHARC:Creative:request[FeatureName]` | Creative requests OM SDK-specific operations |

### 2.4 SHARC EnvironmentData Available to OM SDK

| SHARC Field | OM SDK Mapping |
|-------------|---------------|
| `currentPlacement` (dimensions, location, inline/over) | Placement context for VastProperties |
| `dataspec` (AdCOM model/ver) | Partner/creative context |
| `currentState` (ready, active, passive, hidden...) | Session state |
| `version` | SHARC implementation version |
| `isMuted` / `volume` | volumeChange events |

---

## 3. Integration Architecture: OM SDK as a SHARC Feature

### 3.1 Proposed Pattern

```
┌─────────────────────────────────────────────────────┐
│ SHARC Container (iframe / webview)                  │
│                                                     │
│  ┌──────────────────────┐    ┌──────────────────┐   │
│  │ Creative HTML/JS     │    │ OM SDK Service   │   │
│  │                      │    │ (omweb-v1.js)    │   │
│  │ - Uses SHARC API     │    │                  │   │
│  │ - Requests omid      │    │ - Measurement    │   │
│  │   extension          │    │ - Verification   │   │
│  │ - Signals events via │◄──►│ - Ad Sessions    │   │
│  │   SHARC message bus  │    │                  │   │
│  └──────────────────────┘    └──────────────────┘   │
│                              │                       │
│              ┌───────────────▼───────┐               │
│              │ Verification Scripts   │              │
│              │ (IAS, DV, Moat, etc.)  │              │
│              └───────────────────────┘               │
└─────────────────────────────────────────────────────┘
```

### 3.2 Feature Declaration

At `SHARC:Container:init` time, the container would declare OM SDK support:

```json
{
  "supportedFeatures": [
    {
      "name": "com.iabtechlab.sharc.omid",
      "version": "1.0",
      "functions": [
        "startSession",
        "signalAdEvent",
        "signalMediaEvent",
        "finishSession"
      ]
    }
  ]
}
```

### 3.3 Creative → Container: Requesting OM SDK Operations

When a creative wants to signal an OM SDK event:

```json
// SHARC:Creative:requestOmid
{
  "messageId": 42,
  "type": "SHARC:Creative:requestOmid",
  "args": {
    "action": "signalMediaEvent",
    "event": "firstQuartile"
  }
}
```

The container responds with resolve/reject and internally translates this to the appropriate OM SDK JS Session Client call.

### 3.4 Container → Creative: OM SDK Status Updates

```json
// SHARC:Container:omidStatus
{
  "messageId": 43,
  "type": "SHARC:Container:omidStatus",
  "args": {
    "sessionId": "abc123",
    "status": "sessionStart",
    "verificationScripts": ["ias-vendor", "dv-vendor"]
  }
}
```

### 3.5 Data Flow

```
1. Container loads → declares com.iabtechlab.sharc.omid in supportedFeatures
2. Creative queries features via SHARC:Creative:getFeatures → confirms OM SDK support
3. Container loads OM SDK Service Script in its own execution context
4. Container creates OM JS Session Client and starts AdSession
5. Container fires SHARC:Container:stateChange(active) → maps to AdEvents.loaded()
6. Creative signals impression → container calls adEvents.impressionOccurred()
7. Creative signals media events → container maps to MediaEvents API 8. 
User clicks → container handles navigation, signals adUserInteraction
9. Ad completes → container calls adSession.finish()
```

---

## 4. Comparison: SIMID + OM SDK Pattern

SIMID (video interactivity standard) already integrates with OM SDK for video ads. The pattern is similar:

| Aspect | SIMID | SHARC (proposed) |
|--------|-------|-----------------|
| Container role | Video player | SHARC container (iframe/webview) |
| OM SDK loading | Player loads Service Script | Container loads Service Script |
| Event signaling | SIMID protocol → OM SDK API | SHARC protocol → OM SDK API |
| Verification scripts | Via VAST AdVerifications | Via AdCOM verification data |
| Creative awareness | SIMID handles events | SHARC events mapped to OM SDK |

**Key insight:** SIMID handles video-specific OM SDK events (quartiles, buffering, media events) at the player layer. SHARC would do the same at the container layer. Both share the same messaging protocol structure, making the OM SDK bridge pattern directly portable.

---

## 5. Gap Analysis

### 5.1 Gaps

| Gap | Impact | Mitigation |
|-----|--------|------------|
| SHARC spec explicitly marks measurement as "out of scope" | No normative OM SDK references | OM SDK integration lives only as an extension, not core spec |
| Current SHARC reference impl has no OM SDK code | No working example | Reference impl should add OM SDK extension |
| Verification script loading in iframes | Access mode management is Web-only | SHARC:Container must manage iframe access modes for verification scripts |
| OM SDK partner name registration | Integrators need IAB-assigned names | Container could proxy partner registration, or creative provides partner name |
| CTV OM SDK (DACH) vs Web Video SDK | Different SDKs for different environments | SHARC extension should handle environment detection and select appropriate OM SDK variant |

### 5.2 Alignment Opportunities

| Feature | SHARC Native | OM SDK Need | Alignment |
|---------|-------------|-------------|-----------|
| Container state | ✅ stateChange | ❌ Session state via observer | Direct mapping |
| Placement | ✅ Placement object | ❌ Context placement info | SHARC provides more detail |
| Volume | ✅ isMuted/volume in EnvironmentData | ❌ volumeChange events | SHARC provides volume, OM SDK needs event |
| Media events | ❌ Not natively tracked | ✅ MediaEvents API | Container must track |
| Impressions | ❌ Not natively tracked | ✅ impressionOccurred | Container must fire on container visibility |
| Creativetype | ❌ Not in protocol | ✅ video/audio | SHARC:Container should surface during init |
| Close/unload | ✅ Container:close | ✅ adSession.finish() | Direct mapping |
| AdVerifications | ✅ Via AdCOM dataspec | ✅ VerificationScriptResource | Direct mapping |

---

## 6. Recommendations for SHARC WG

### 6.1 Short-term (SHARC v1)

1. **Define `com.iabtechlab.sharc.omid` as a SHARC extension** — not in core spec, but documented in the extension guide alongside other supported features.

2. **SHARC container should load OM SDK Service Script** during initialization, alongside the creative. This follows the SIMID pattern where the container (player in SIMID, ad container in SHARC owns the OM integration.

3. **Map SHARC state changes to OM SDK session lifecycle** — `stateChange(active)` → `AdEvents.loaded()` and `stateChange(active)` + visibility → `AdEvents.impressionOccurred()`.

### 6.2 Medium-term (SHARC v2)

4. **Add optional media event tracking to core container** — If SHARC ever adds native video support, MediaEvents becomes a first-class citizen alongside the OM SDK bridge.

5. **Define OM SDK access modes for SHARC iframes** — SHARC iframes can be same-origin or cross-origin. The verification script loading needs clear access mode rules:
   - `limited` — verification script in same-origin iframe, restricted access
   - `full` — verification script has full access to DOM
   - SHARC container decides based on creative's VAST `adVerifications` data

6. **Support VAST AdVerifications in AdCOM** — SHARC uses AdCOM as its dataspec. The `adVerifications` array from VAST 4.1 needs to be expressible in AdCOM so the container can populate `VerificationScriptResource` objects.

### 6.3 Long-term

7. **Contribution to OM Working Group** — SHARC's OM integration patterns should be fed back to the OM Working Group (led by Jill Wittkopp) so IAB can standardize the relationship between ad containers (SafeFrame, MRAID → SHARC) and OM SDK measurement.

8. **SHARC + OM SDK reference implementation** — The SHARC reference implementation at `github.com/jeffreycarlson/SHARC/` should include a working OM SDK integration example showing:
   - Container loading OM SDK Service Script
   - Session lifecycle mapped to SHARC states
   - Media event signaling from creative through SHARC message bus
   - Verification script integration

---

## 7. OM SDK JS API Quick Reference

### Classes
- `OmidSessionClient.AdSession`
- `OmidSessionClient.Partner`
- `OmidSessionClient.Context`
- `OmidSessionClient.VerificationScriptResource`
- `OmidSessionClient.AdEvents`
- `OmidSessionClient.MediaEvents`

### AdSession Methods (OM ID 1.6 JSDoc)
- `AdSession(context [, communication] [, sessionInterface])` — constructor
- `start()` — begin session, starts ad view tracking
- `finish()` — end session, stops tracking
- `isSupported()` → boolean — check if OM ID is available
- `setCreativeType(creativeType)` — "video" | "audio" | "definedByJavascript"
- `setImpressionType(impressionType)` — impression type (must be set before impression occurs)
- `registerAdEvents()` — registers AdEvents instance existence
- `registerMediaEvents()` — registers MediaEvents instance existence
- `registerSessionObserver(functionToExecute)` — session lifecycle events
- `getAdSessionId()` → string — get session ID
- `setElementBounds(elementBounds)` — DOM element geometry relative to slot element
- `sendMessage(method, responseCallback?, ...args)` — internal: send to SessionService
- `sendOneWayMessage(method, ...args)` — internal: send to VerificationService

**Session Observer events:**
```js
{ adSessionId: string, timestamp: number, type: string, data: object }
```

Types: `"sessionStart"`, `"sessionError"`, `"sessionFinish"`

**Critical constraints:**
- Only ONE AdEvents instance per session (error on duplicate)
- Only ONE MediaEvents instance per session (error on duplicate)
- `creativeLoaded()` and `impressionOccurred()` cannot be called before `setCreativeType` and `setImpressionType` are set
- `creativeType` cannot be `DEFINED_BY_JAVASCRIPT` if passed as argument
- `finish()` has no effect on mobile app environment

### AdEvents Methods
- `loaded(VastProperties)`
- `impressionOccurred()`
- `skipped()`
- `paused()` / `resumed()`
- `stateChange(AdState)`
- `volumeChange(volume)`
- `adUserInteraction(InteractionType)`

### MediaEvents Methods
- `start(duration, volume)`
- `firstQuartile()` / `midpoint()` / `thirdQuartile()` / `complete()`
- `bufferStart()` / `bufferFinish()`
- `playerStateChange(PlayerState)`
- `adUserInteraction(InteractionType)`
- `volumeChange(volume)`

### Session Observer Events
- `{ type: "sessionStart" }`
- `{ type: "sessionError" }`
- `{ type: "sessionFinish" }`

---

## 8. Cross-Platform OM SDK API Summary

### 8.1 Platform Variants

| Platform | SDK | Session Class | Key Differences |
|----------|-----|---------------|-----------------|
| iOS | `OMSDK.framework` | `OMIDAdSession` | Objective-C/Swift, Xcode project, view hierarchy tracking |
| Android | `.aar` library | `AdSession` | Java/Kotlin, WebView + native tracking |
| Web Video | `omid-session-client-v1.js` | `AdSession` (JS) | UMD module, runs in iframe, DOM-restricted |
| CTV (tvOS) | `OMSDK.framework` | `OMIDAdSession` | Same as iOS but with `deviceCategory`, `lastActivity`, display connection |
| CTV (AndroidTV) | `.aar` library | `AdSession` | Same as Android but CTV platform signals |
| CTV (Samsung/LG) | Web Video SDK | JS Session Client | HTML5 player with TV-specific extensions |

### 8.2 iOS/Android Native API Comparison

| Operation | iOS (OMID) | Android (OM SDK) |
|-----------|------------|-------------------|
| Initialize | `[[OMIDSDK sharedInstance] activate]` | `Omid.activate(context)` |
| Create Partner | `[[OMIDPartner alloc] initWithName:version:]` | `Partner.create(name, version)` |
| Create Context | `[[OMIDAdSessionContext alloc] initWithPartner:webView:... ]` | `AdSessionContext.createHtmlAdSessionContext(partner, webView, ...)` |
| Event Layer Config | `OMIDAdSessionConfiguration` with `creativeType`, `impressionType`, `impressionOwner`, `mediaEventsOwner`, `isolateVerificationScripts` | `AdSessionConfiguration.createAdSessionConfiguration(creativeType, impressionType, impressionOwner, mediaEventsOwner, isolateVerificationScripts)` |
| Create Session | `[[OMIDAdSession alloc] initWithConfiguration:config adSessionContext:context error:]` | `AdSession.createAdSession(config, context)` |
| Set View | `session.mainAdView = webView` | `session.registerAdView(webView)` |
| Friendly Obstructions | `[session addFriendlyObstruction:view purpose:detailedReason:error:]` | `session.addFriendlyObstruction(view)` |
| Start | `[session start]` | `session.start()` |
| Finish | `[session finish]` | `session.finish()` |
| Error Logging | `[session logErrorWithType:message:]` | N/A (handled internally) |
| Update Last Activity (CTV) | `[[OMIDSDK sharedInstance] updateLastActivity]` | `Omid.updateLastActivity()` |

### 8.3 Creative Types (Cross-Platform)

| Creative Type | iOS | Android | JS |
|--------------|-----|---------|----|
| HTML Display | `OMIDCreativeTypeHtmlDisplay` | `CreativeType.HTML_DISPLAY` | N/A (implied) |
| HTML Video | `OMIDCreativeTypeHtmlVideo` | `CreativeType.HTML_VIDEO` | Set via `setCreativeType("video")` |
| Native Display | `OMIDCreativeTypeNativeDisplay` | `CreativeType.NATIVE_DISPLAY` | N/A |
| Native Video | `OMIDCreativeTypeNativeVideo` | `CreativeType.NATIVE_VIDEO` | N/A |

### 8.4 Impression Types

| Type | Description |
|------|-------------|
| `BEGIN_TO_RENDER` | Fires when creative begins to render |
| `ONE_PIXEL` | Fires when first pixel enters view |
| `VISIBLE_MEDIA_FILES` | Fires when media file visible |

### 8.5 Event Owners (Native SDKs)

| Owner | Description |
|-------|-------------|
| `NativeOwner` | Native layer signals events |
| `JsOwner` | JavaScript layer signals events |
| `NoneOwner` | No events signaled (for display ads) |

### 8.6 CTV-Specific Additions (v1.4+)

| Feature | Description |
|---------|-------------|
| `deviceCategory` | "ctv" — supplements user agent parsing |
| `lastActivity` | Timestamp of last user interaction (remote, mouse, touch) |
| `displayConnectionStatus` | Reasons: `noOutputDevice`, `backgrounded` — TV display off detection |
| `percentageInView` | Viewability percentage |
| Video pod measurement | Gapless playback measurement for "javascript" and "html" session types |

### 8.7 UniversalAdId (v1.5.5+)

Passed through AdSession during initialization:
- `idValue` — The creative ID (e.g., "CNPA0484000H")
- `idRegistry` — The registry (e.g., "ad-id.org")
- Format: `"idValue; idRegistry"`
- Available in `sessionStart` event to verification scripts

### 8.8 Device Attestation (v1.5)

- Privacy Pass protocol adapted for digital advertising
- Enables apps/players to prove impressions on authentic devices
- Addresses device spoofing in CTV
- Samsung and LG TVs included in 1.5 release

---

*End of research document. This document is intended for SHARC Working Group discussion and should be reviewed by the Ad Tech Team before WG presentation.*
