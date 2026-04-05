# MRAID to SHARC Migration Guide

**Version:** 1.0  
**Last Updated:** 2026-04-03  
**Audience:** Creative developers with existing MRAID experience

---

## Overview

If you've built MRAID ads, SHARC will feel familiar. The same problems are solved — resize, click-through, close, state changes — but with cleaner architecture. The biggest shifts:

1. **No more polling.** MRAID made you poll for state (`mraid.getState()`). SHARC pushes state to you via events and delivers everything at init.
2. **Async, not sync.** MRAID functions returned immediately (or fired a callback event). SHARC uses Promises — actions return results, and you know if they succeeded or failed.
3. **No global `mraid` object.** You get a `SHARC` SDK that handles the handshake for you.
4. **The container handles more.** Navigation, tracker firing, close control — these are the container's job in SHARC, with creatives making requests.

---

## Concept Mapping

| MRAID Concept | SHARC Equivalent | Notes |
|---------------|-----------------|-------|
| `mraid.js` injection | `sharc-creative-sdk.js` | Same idea: a single script to include |
| `mraid.getState()` | `SHARC.getContainerState()` | Async in SHARC; or use `stateChange` events |
| `mraid.isViewable()` | Container state `active` | `active` = visible + focused |
| `mraidenv` object | `EnvironmentData` from `onReady` | Richer in SHARC; delivered once at init |
| `mraid.addEventListener('ready', fn)` | `SHARC.onReady(fn)` | SHARC delivers EnvironmentData to the callback |
| `mraid.addEventListener('viewableChange', fn)` | `SHARC.on('stateChange', fn)` | SHARC uses richer states |
| `mraid.expand()` | `SHARC.requestPlacementChange(...)` | Returns Promise; container confirms actual dims |
| `mraid.resize()` | `SHARC.requestPlacementChange(...)` | Same message; use `containerDimensions` |
| `mraid.close()` | `SHARC.requestClose()` | Container may reject if minimum display time not met |
| `mraid.open(url)` | `SHARC.requestNavigation({url, target})` | Always call even on web; container handles or rejects |
| `mraid.getVersion()` | `env.version` from `onReady` | Available at init, not a function call |
| `mraid.supports(feature)` | `SHARC.hasFeature(name)` | SHARC uses namespaced feature names |
| `mraid.getPlacementType()` | `env.currentPlacement` + `env.data.placement` | More data available in SHARC |
| `mraid.getScreenSize()` | `env.currentPlacement.viewportSize` | In EnvironmentData |
| `mraid.getMaxSize()` | `env.currentPlacement.maxExpandSize` | In EnvironmentData |
| `mraid.getDefaultPosition()` | `env.currentPlacement.initialDefaultSize` | In EnvironmentData |
| `mraid.setResizeProperties(props)` | Parameters on `requestPlacementChange` | No separate setter needed |
| `mraid.setExpandProperties(props)` | Parameters on `requestPlacementChange` | Same |

---

## State Mapping

MRAID has 5 states. SHARC has 5 creative-visible states plus 2 internal bookends. The mapping:

| MRAID State | SHARC State(s) | Notes |
|-------------|---------------|-------|
| `loading` | `loading` (internal) | Neither model exposes this to the creative |
| `default` | `ready`, `active`, `passive` | SHARC distinguishes focus levels; `default` is all three |
| `expanded` | `active` (with changed placement) | SHARC doesn't track expanded as a state — it's a placement property |
| `resized` | `active` (with changed placement) | Same — placement is separate from state |
| `hidden` | `hidden`, `frozen` | SHARC splits hidden (JS runs) from frozen (JS suspended) |

### Key insight: SHARC decouples state from placement

In MRAID, `expanded` and `resized` were states — which caused constant confusion. ("Is my ad in `expanded` state while the screen rotates?") In SHARC, state only reflects platform visibility and focus. Whether the ad is expanded is a placement concern, not a state concern.

---

## Code Comparison: Initialization

### MRAID

```javascript
// mraid.js is injected by the SDK automatically.
// You poll or listen for 'ready' before doing anything.

function onMraidReady() {
  if (mraid.getState() === 'loading') {
    mraid.addEventListener('ready', handleMraidReady);
  } else {
    handleMraidReady();
  }
}

function handleMraidReady() {
  const size = mraid.getDefaultPosition();
  const maxSize = mraid.getMaxSize();
  const isMuted = /* not available in MRAID */;

  // Start the ad
  document.getElementById('ad').style.display = 'block';
}
```

### SHARC

```javascript
// sharc-creative-sdk.js handles the handshake automatically.

SHARC.onReady(async (env, features) => {
  // env contains everything MRAID made you poll for:
  const size = env.currentPlacement.initialDefaultSize;  // { width, height }
  const maxSize = env.currentPlacement.maxExpandSize;
  const isMuted = env.isMuted;  // NEW: not in MRAID
  const version = env.version;  // NEW: SHARC version

  // Load assets, configure audio, check features, etc.
  // Return a resolved promise when ready.
});

SHARC.onStart(async () => {
  // Make the ad visible HERE, not in onReady
  document.getElementById('ad').style.display = 'block';
});
```

The two-callback pattern (`onReady` → `onStart`) gives you a clean separation:
- `onReady`: prepare the ad. Assets loaded. Hidden from user.
- `onStart`: make it visible. User sees it.

MRAID conflated these — the `ready` event meant the ad could be shown immediately, which caused flash-of-unstyled-content issues.

---

## Code Comparison: Viewability

### MRAID

```javascript
// Poll or listen
mraid.addEventListener('viewableChange', function(viewable) {
  if (viewable) {
    resumeVideo();
  } else {
    pauseVideo();
  }
});

// Also check on start
if (mraid.isViewable()) {
  resumeVideo();
}
```

### SHARC

```javascript
SHARC.on('stateChange', (state) => {
  if (state === 'active') {
    resumeVideo();
  } else if (state === 'passive' || state === 'hidden' || state === 'frozen') {
    pauseVideo();
  }
});

// In onStart, the state is already 'active' — no need to check
SHARC.onStart(async () => {
  resumeVideo();  // Already in 'active' state when this fires
});
```

SHARC's states are more granular than MRAID's binary viewable/not-viewable. `passive` means visible but no focus (split-screen). `hidden` means background. `frozen` means JS may be suspended soon. You can choose how aggressively to pause based on the specific state.

---

## Code Comparison: Expand / Resize

### MRAID — Expand to Fullscreen

```javascript
// Set properties first
mraid.setExpandProperties({
  width: screen.width,
  height: screen.height,
  useCustomClose: false
});

// Then expand
mraid.expand();

// Listen for state change to confirm
mraid.addEventListener('stateChange', function(state) {
  if (state === 'expanded') {
    showExpandedContent();
  }
});
```

### SHARC — Expand

```javascript
// One call, returns a Promise with the actual resulting dimensions
try {
  const result = await SHARC.requestPlacementChange({
    containerDimensions: { width: 320, height: 568 },  // target size
    inline: false  // overlay content, don't push it
  });
  // result.containerDimensions = what the container actually did
  showExpandedContent();
} catch (err) {
  // Container rejected the resize — stay at default
  console.warn('Could not expand:', err.message);
}
```

No separate "setProperties then call function" pattern. No state change event needed to confirm. The Promise resolution IS the confirmation.

### MRAID — Resize (to non-fullscreen size)

```javascript
mraid.setResizeProperties({
  width: 320,
  height: 250,
  offsetX: 0,
  offsetY: 0,
  allowOffscreen: false
});
mraid.resize();

mraid.addEventListener('stateChange', function(state) {
  if (state === 'resized') {
    showResizedContent();
  }
});
```

### SHARC — Resize

```javascript
// Same call, just different dimensions
const result = await SHARC.requestPlacementChange({
  containerDimensions: { width: 320, height: 250 }
});
showResizedContent();
```

---

## Code Comparison: Click-Through

### MRAID

```javascript
document.getElementById('cta').addEventListener('click', function() {
  mraid.open('https://advertiser.example.com');
  // Done. MRAID opens the URL.
});
```

### SHARC

```javascript
document.getElementById('cta').addEventListener('click', async () => {
  try {
    await SHARC.requestNavigation({
      url: 'https://advertiser.example.com',
      target: 'clickthrough'
    });
    // Container opened the URL (mobile)
  } catch (err) {
    if (err.code === 2105) {
      // Web: container can't handle it, creative opens it
      window.open('https://advertiser.example.com', '_blank');
    }
  }
});
```

The key difference: SHARC always tells the container about navigation first, even on web where the browser handles it. This gives the container a complete log of all click events — useful for fraud detection, analytics, and measurement.

**Why the try/catch?** On web, containers reject `requestNavigation` with code `2105` as a signal meaning "you handle it, creative." This is intentional — it's not an error, it's a handoff.

---

## Code Comparison: Close

### MRAID

```javascript
// Creative requests close
document.getElementById('close-btn').addEventListener('click', function() {
  mraid.close();
});

// Listen for when the ad is actually closed
mraid.addEventListener('stateChange', function(state) {
  if (state === 'hidden') {
    // Ad was closed or hidden
  }
});
```

### SHARC

```javascript
// Creative requests close (container may reject)
document.getElementById('close-btn').addEventListener('click', async () => {
  await SHARC.requestClose();
  // If rejected, the ad stays open — handle gracefully
});

// Listen for the ACTUAL close (triggered by user, container, or creative)
SHARC.on('close', async () => {
  // Fire close trackers and run close animation
  // You have ~2 seconds before the container force-unloads you
  await SHARC.reportInteraction(['https://tracking.example.com/close']);
});
```

In SHARC, the close control is always provided by the container. The creative can request close but the container decides whether to honor it. The `close` event is what you handle for cleanup — regardless of whether close was triggered by the user or the creative.

---

## Code Comparison: Feature Detection

### MRAID

```javascript
if (mraid.supports('sms')) {
  // Show SMS button
}
if (mraid.supports('tel')) {
  // Show call button
}
if (mraid.supports('storePicture')) {
  // ... (deprecated)
}
```

### SHARC

```javascript
SHARC.onReady(async (env, features) => {
  // Features are available in the onReady callback
  if (SHARC.hasFeature('com.iabtechlab.sharc.sms')) {
    // Show SMS button
  }
  if (SHARC.hasFeature('com.iabtechlab.sharc.tel')) {
    // Show call button
  }
  // No storePicture — intentionally dropped in SHARC
});
```

SHARC uses namespaced feature names (`com.iabtechlab.sharc.*`) to avoid naming conflicts. Third-party features use their own namespaces (`com.example.*`).

---

## What's Removed (Intentionally)

Some MRAID features are gone in SHARC. This is by design — many MRAID features created platform fragmentation or had severe browser compatibility problems.

| MRAID Feature | Status in SHARC | Reason |
|---------------|----------------|--------|
| `mraid.storePicture()` | **Removed** | Deprecated by iOS/Android. Security concerns. Rarely worked. |
| `mraid.createCalendarEvent()` | **Removed** | Deprecated. OS-level permissions broke this consistently. |
| `mraid.playVideo()` | **Not in SHARC** | SHARC is for display ads. Video playback is the page/app's job. |
| `mraid.expand(url)` (two-part expand) | **Not supported** | Couldn't be bridged cleanly. Use a single creative URL instead. |
| `mraid.useCustomClose` | **N/A** | Container always provides close. Creative may supplement. |
| `mraid.setOrientationProperties()` | **Not in v1** | Extension candidate. Orientation is platform-level in v1. |

---

## What's New in SHARC

Things you couldn't do with MRAID:

| Feature | Description |
|---------|-------------|
| **`passive` state** | Know when the app is in split-screen or interrupted (phone call). MRAID didn't have this. |
| **`hidden` state** | Distinct from `frozen` — you know you're backgrounded but JS still runs. |
| **`frozen` state** | OS has suspended your JS. Prepare for this in `hidden`. |
| **`isMuted` at init** | Know the mute state before the user sees the ad. |
| **`volume` at init** | Know the volume level before showing the ad. |
| **Structured Environment Data** | AdCOM placement, context, and ad data all available at init. |
| **Extension framework** | Containers can advertise and deliver custom features under a versioned namespace. |
| **`reportInteraction` with results** | Know whether your tracking pixels actually fired. |
| **Cross-platform by design** | Same creative code runs in web iframe, iOS WKWebView, Android WebView. |

---

## Migration Strategy

### Option A: Full rewrite (recommended for new campaigns)

The cleanest path. Replace MRAID calls with SHARC equivalents using the table above. A typical banner ad migration takes 30–60 minutes.

Rough steps:
1. Replace `mraid.js` include with `sharc-creative-sdk.js`
2. Replace `mraid.addEventListener('ready', fn)` with `SHARC.onReady(fn)`
3. Move ad-show logic from `ready` callback to `SHARC.onStart(fn)`
4. Replace `mraid.expand()` / `mraid.resize()` with `SHARC.requestPlacementChange()`
5. Replace `mraid.open(url)` with `SHARC.requestNavigation()`
6. Replace `mraid.close()` with `SHARC.requestClose()`
7. Replace `mraid.addEventListener('viewableChange', fn)` with `SHARC.on('stateChange', fn)`
8. Remove feature-detection calls for deprecated features (`storePicture`, etc.)

### Option B: MRAID Compatibility Bridge (for existing creative libraries)

If you have a large library of MRAID creatives and can't rewrite them all, the SHARC MRAID bridge lets MRAID 3.0 creatives run in SHARC containers without modification.

The bridge is a JavaScript shim that:
- Injects the `mraid` global object
- Translates MRAID API calls to SHARC messages
- Translates SHARC events back to MRAID events

**How to use the bridge (publisher/SSP side):**

```javascript
import { SHARCContainer } from './sharc-container.js';
import { MRAIDCompatBridge } from './sharc-mraid-bridge.js';

const container = new SHARCContainer({
  element: document.getElementById('ad-slot'),
  creativeUrl: 'https://mraid-ad.example.com/ad.html',
  placement: { width: 320, height: 50, inline: true },
  extensions: [new MRAIDCompatBridge()]  // Enable MRAID compat
});
```

The creative doesn't change. It uses `mraid.*` as before.

**Bridge limitations (know these before relying on it):**
- MRAID 1.x edge cases may not work — MRAID 3.0 focus only
- `mraid.expand(url)` with a different expand URL is not supported
- `storePicture` and `createCalendarEvent` return errors
- The bridge requires the container to have same-origin iframe access

The bridge is a migration tool. Plan to rewrite creatives to SHARC natively over time.

---

## Quick Reference Card

```
MRAID                             →  SHARC
─────────────────────────────────────────────────────────────────────
mraid.addEventListener('ready', fn)  →  SHARC.onReady(fn)
[no equivalent]                      →  SHARC.onStart(fn)  ← make ad visible here
mraid.getState()                     →  SHARC.getContainerState()
mraid.isViewable()                   →  state === 'active'
mraid.getVersion()                   →  env.version  (in onReady)
mraid.getDefaultPosition()           →  env.currentPlacement.initialDefaultSize
mraid.getMaxSize()                   →  env.currentPlacement.maxExpandSize
mraid.getScreenSize()                →  env.currentPlacement.viewportSize
mraid.supports(feature)             →  SHARC.hasFeature('com.iabtechlab.sharc.' + feature)
mraid.expand()                       →  SHARC.requestPlacementChange({ inline: false })
mraid.resize()                       →  SHARC.requestPlacementChange({ containerDimensions })
mraid.close()                        →  SHARC.requestClose()
mraid.open(url)                      →  SHARC.requestNavigation({ url, target: 'clickthrough' })
mraid.addEventListener('stateChange')→  SHARC.on('stateChange', fn)
mraid.addEventListener('sizeChange') →  SHARC.on('placementChange', fn)
mraid.addEventListener('error')      →  catch on SHARC promises; SHARC.on('error')
[no equivalent]                      →  SHARC.reportInteraction([...trackerUris])
```

---

## Questions?

See [api-reference.md](./api-reference.md) for the full SHARC API spec.  
See [getting-started.md](./getting-started.md) for complete creative and container examples.
