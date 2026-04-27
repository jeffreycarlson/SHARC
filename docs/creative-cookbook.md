# SHARC Creative Cookbook

**Audience:** Creative developers building SHARC-enabled ads.

This guide covers practical implementation patterns: from the minimal banner to state-aware video, expandables, clickthroughs, interaction tracking, and error handling. These are working patterns, not pseudocode — each example is wired to the actual SHARC Creative API.

The complete API surface is documented in [api-reference.md](./api-reference.md). The state machine these examples depend on is in [architecture-design.md §4](./architecture-design.md#4-state-machine-page-lifecycle-aligned).

---

## Table of Contents

1. [Basic Inline Banner](#1-basic-inline-banner)
2. [Expandable Banner](#2-expandable-banner)
3. [State-Aware Creative](#3-state-aware-creative)
4. [Clickthrough](#4-clickthrough)
5. [Interaction Tracking](#5-interaction-tracking)
6. [Error Handling](#6-error-handling)
7. [Pre-flight Checklist](#7-pre-flight-checklist)

---

## 1. Basic Inline Banner

The minimal SHARC creative. Use `onReady` to load assets and configure from environment data. Use `onStart` to make the ad visible. Do not show anything before `onStart` — the container sends `startCreative` only when the placement is ready to display.

```html
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; overflow: hidden; }
    #ad { width: 320px; height: 50px; display: none; background: #f0f0f0; }
  </style>
</head>
<body>
  <div id="ad">
    <a id="cta">Learn More</a>
  </div>

  <!-- In production, replace ./dist/ paths with your CDN URL or use the ESM import above -->
  <script src="./dist/sharc-protocol.js"></script>
  <script src="./dist/sharc-creative.js"></script>
  <script>
    const ad = document.getElementById('ad');

    SHARC.onReady(async (env, features) => {
      // env.currentPlacement has the container dimensions
      // env.isMuted and env.volume describe device audio state
      // Configure your creative to fit env.currentPlacement.initialDefaultSize
      console.log('Placement:', env.currentPlacement.initialDefaultSize);
    });

    SHARC.onStart(() => {
      // Container is visible and ready — show the ad
      ad.style.display = 'block';
    });

    SHARC.on('close', () => {
      // Optional: run a close animation here.
      // The container enforces a 2-second watchdog — complete within that window.
      ad.style.opacity = '0';
    });
  </script>
</body>
</html>
```

Key rules:
- `onReady` is your initialization window. Resolve the callback when your assets are ready. The container waits for your resolve before sending `startCreative`.
- `onStart` is your display trigger. The container makes the iframe/WebView visible immediately after you resolve `startCreative`.
- The `close` event fires when the container initiates close. Your handler has up to 2 seconds before the container force-terminates.

---

## 2. Expandable Banner

Start at 320×50, expand on user tap, collapse via a creative-rendered collapse button. The close button is always rendered by the container — never by the creative.

```javascript
// Assumes SHARC is loaded and onReady/onStart are already wired (see §1)

const collapseBtn = document.getElementById('collapse-btn');
const expandBtn = document.getElementById('expand-btn');

let isExpanded = false;

// User taps the expand trigger in the creative
expandBtn.addEventListener('click', async () => {
  if (isExpanded) return;

  try {
    const result = await SHARC.requestPlacementChange({ intent: 'expand' });
    // result.placementUpdate has the actual new dimensions (width, height, etc.)
    isExpanded = true;
    showExpandedView(result.placementUpdate);
  } catch (err) {
    // Container rejected the expand — degrade gracefully
    console.warn('[ad] Expand rejected:', err);
  }
});

// Creative-rendered collapse button (not the container's close button)
// This button returns the ad to its inline state without closing the unit
collapseBtn.addEventListener('click', async () => {
  if (!isExpanded) return;

  try {
    await SHARC.requestPlacementChange({ intent: 'collapse' });
    isExpanded = false;
    showInlineView();
  } catch (err) {
    console.warn('[ad] Collapse rejected:', err);
  }
});

// Container's close event — fires when the container's own close button is tapped
// or when the publisher/platform initiates close
SHARC.on('close', () => {
  // Fire any remaining close trackers before the container terminates
  // SHARC.reportInteraction(['https://track.example.com/close']);
});

function showInlineView() {
  document.getElementById('inline-panel').style.display = 'block';
  document.getElementById('expanded-panel').style.display = 'none';
  collapseBtn.style.display = 'none';
}

function showExpandedView(placement) {
  // placement.width / placement.height reflect the granted dimensions
  document.getElementById('inline-panel').style.display = 'none';
  document.getElementById('expanded-panel').style.display = 'block';
  // Show collapse button — distinct from the container's close button
  collapseBtn.style.display = 'block';
}
```

The distinction between `collapse` and `close`:
- `collapse` returns the placement to its `initialDefaultSize`. The ad unit remains open. Use this for the creative's own expand/collapse toggle.
- `close` ends the session. The container removes the iframe. Use `SHARC.requestClose()` if the creative needs to initiate close, or handle `SHARC.on('close', ...)` when the container initiates it.

For resize-to-specific-dimensions (rather than expand-to-max), use:

```javascript
await SHARC.requestPlacementChange({
  intent: 'resize',
  targetDimensions: { width: 320, height: 250 }
});
```

`resize` requires `targetDimensions`. `expand` expands to `maxExpandSize` from the environment data. `fullscreen` takes over the viewport — use sparingly and only for interstitial-style units.

---

## 3. State-Aware Creative

Respond to container state changes to pause and resume resource-intensive activity. This matters on mobile: an ad playing video while the device is backgrounded wastes battery and will get your creative blocklisted.

```javascript
let videoEl = null;

SHARC.onStart(() => {
  videoEl = document.getElementById('video');
  videoEl.play();
});

SHARC.on('stateChange', (state) => {
  switch (state) {
    case 'active':
      // App is in foreground with focus — resume normal operation
      if (videoEl && videoEl.paused) videoEl.play();
      document.querySelectorAll('.animated').forEach(el => el.style.animationPlayState = 'running');
      break;

    case 'passive':
      // App visible but lost focus (incoming call, split-screen)
      // Pause non-critical activity; keep the frame rendered
      if (videoEl) videoEl.pause();
      break;

    case 'hidden':
      // App backgrounded or tab hidden — release non-essential resources
      if (videoEl) videoEl.pause();
      document.querySelectorAll('.animated').forEach(el => el.style.animationPlayState = 'paused');
      // Cancel any pending network requests for non-critical assets
      break;

    case 'frozen':
      // OS has suspended JavaScript execution — you can't do much here.
      // The creative should have already checkpointed state when entering 'hidden'.
      // Any code below this line may not execute before suspension.
      break;
  }
});
```

The `frozen` state transition is best-effort. On iOS, WebContent process suspension happens at the OS level below the JavaScript runtime — the creative may not have time to run code when the `frozen` message arrives. Checkpoint your important state when entering `hidden`.

The `stateChange` event fires for `ready`, `active`, `passive`, `hidden`, and `frozen`. It does not fire for `loading` or `terminated` — the creative cannot receive messages in those states.

---

## 4. Clickthrough

Always route navigation through `SHARC.requestNavigation`. Never use `window.open`, `window.location.href`, or anchor tag default behavior for clickthroughs. On iOS and Android WebViews, the container intercepts navigation and opens the URL in the device's browser or routes deep links through the OS — direct navigation from within the sandboxed frame does not work.

```javascript
document.getElementById('cta-btn').addEventListener('click', async () => {
  try {
    await SHARC.requestNavigation({
      url: 'https://brand.example.com/landing',
      target: 'clickthrough'
    });
    // Container handled it — URL opened in browser/app
  } catch (err) {
    // URL validation failed (err.errorCode === 2211) or container rejected the navigation type.
    // Do not attempt to open the URL without container involvement.
    console.error('[ad] Navigation rejected:', err);
  }
});
```

`target` values:
- `'clickthrough'` — standard brand URL, opens in default browser
- `'deeplink'` — app deep link or universal link, container routes through OS
- `'store'` — app store URL, container opens the appropriate store
- `'custom'` — custom scheme; pair with `customScheme: 'yourscheme'`

For `clickthrough` target, the reference container opens the URL in a new tab and resolves — the creative does not need to implement its own fallback. For other target types (`deeplink`, `store`, `custom`) on platforms where the container has no native handler, the container rejects with an error and the creative should degrade gracefully.

---

## 5. Interaction Tracking

Use `SHARC.reportInteraction` to fire tracking pixels and measurement URIs. The container fires all URIs in parallel via HTTP GET, follows redirects up to 5 hops, and resolves when all requests complete or time out. This sidesteps third-party cookie restrictions and iframe same-origin limitations — the container fires from the host application context, not from inside the sandboxed frame.

```javascript
// Fire on user click
document.getElementById('cta-btn').addEventListener('click', async () => {
  // Fire trackers first, then navigate
  await SHARC.reportInteraction([
    'https://track.example.com/click?imp=${AUCTION_PRICE}',
    'https://measure.partner.com/event?type=click&id=abc123'
  ]).catch(err => {
    // Tracking failure is non-fatal — continue to navigation
    console.warn('[ad] Interaction tracking error:', err);
  });

  await SHARC.requestNavigation({ url: clickthroughUrl, target: 'clickthrough' });
});

// Fire on video start (25%, 50%, 75%, complete)
function onVideoMilestone(percent) {
  SHARC.reportInteraction([
    `https://track.example.com/video?q=${percent}&id=abc123`
  ]).catch(() => {}); // fire-and-forget for video quartiles
}
```

The resolve value from `reportInteraction` includes per-URI results:

```javascript
const results = await SHARC.reportInteraction(['https://track.example.com/click']);
results.forEach(({ uri, success, statusCode }) => {
  console.log(uri, success, statusCode);
});
```

The container accepts a maximum of 20 URIs per call. Only `https:` and `http:` schemes are accepted — other schemes are silently dropped by the container before firing.

---

## 6. Error Handling

Call `SHARC.fatalError` when the creative cannot recover — for example, a critical asset fails to load and rendering is impossible. The container terminates the creative cleanly and triggers its `onError` callback, which lets the publisher fall back gracefully.

```javascript
SHARC.onReady(async (env, features) => {
  try {
    await loadCriticalAssets();
  } catch (err) {
    // Critical asset load failed — cannot render the ad
    SHARC.fatalError(2101, 'Failed to load creative bundle: ' + err.message);
    // fatalError is fire-and-forget — do not await it
    return;
  }
});

async function loadCriticalAssets() {
  const response = await fetch('https://cdn.example.com/ad-bundle.json');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
```

**When to call `fatalError` vs. degrade gracefully:**

| Situation | Approach |
|-----------|----------|
| Critical asset (video, 3D model) fails to load and the unit cannot render | `fatalError(2101)` |
| Secondary asset (background image, font) fails to load | Degrade: render a simplified fallback |
| Container dimensions are smaller than the minimum the creative supports | `fatalError(2102)` |
| Non-critical feature (audio) is unavailable | Check `SHARC.hasFeature(...)`, proceed without it |
| JavaScript error in an optional enhancement | Catch locally, log via `SHARC.log()`, continue |

Error codes from the creative's perspective use the `21xx` range. Use the most specific code available — `2100` (unspecified) is the catchall. See [api-reference.md §10](./api-reference.md#10-error-codes) for the full table.

```javascript
// Log a non-fatal warning to the container (visible in container debug output)
SHARC.log('WARNING: Background image failed to load, falling back to solid color');
```

---

## 7. Pre-flight Checklist

Before submitting a SHARC creative to a publisher or trafficking system:

- [ ] **`onReady` before everything** — never access `env` or call SHARC APIs outside the `onReady` callback. `env` and `features` are not populated until `onReady` fires.
- [ ] **Do not render before `onStart`** — keep the ad invisible until `onStart`. The container has not made the placement visible yet; showing content creates a flash-of-unstyled-content.
- [ ] **Always route navigation through SHARC** — do not use `window.open`, `window.location`, or anchor clicks directly. Native WebViews cannot open URLs from within the sandboxed frame without the container's cooperation.
- [ ] **Never access `window.parent`** — the creative runs in a sandboxed iframe without `allow-same-origin`. `window.parent` is inaccessible. Any data the creative needs from the publisher environment must come through `env` in `onReady`.
- [ ] **Handle the `close` event** — if your creative fires close trackers, do it in the `close` handler. The container gives you up to 2 seconds before force-terminating.
- [ ] **Pause on `hidden`, checkpoint on `hidden` (not `frozen`)** — `frozen` may arrive too late to execute meaningful code. React to `hidden` for resource release and state checkpointing.
- [ ] **Handle `requestPlacementChange` rejections** — containers may reject expand or fullscreen requests due to publisher policy. Catch rejections and degrade to the inline view without throwing.
- [ ] **Use `SHARC.reportInteraction` for all tracking** — do not fire tracking pixels directly from the creative with `fetch` or `XMLHttpRequest`. The container fires from the host app context, avoiding third-party cookie restrictions and iframe-origin issues.
