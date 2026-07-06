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
8. [Creative Markup Variant (0.7.0)](#8-creative-markup-variant-070)
9. [Operator-Side Renderer Setup](#9-operator-side-renderer-setup)
10. [Click-through with Creative Markup + Navigation Bridge](#10-click-through-with-creative-markup--navigation-bridge)

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
- `onReady` is your initialization window. Resolve the callback when your assets are ready. The container waits for your resolve before sending `startCreative`. `ready` is anchored to document load (`document.readyState === 'complete'`), and `onReady` replays for listeners registered after `ready` has already fired — so a late `onReady` still runs.
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

Error codes from the creative's perspective use the `21xx` range. Use the most specific code available — `2100` (unspecified) is the catchall. See [api-reference.md §11](./api-reference.md#11-error-codes) for the full table.

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

---

## 8. Creative Markup Variant (0.7.0)

**Audience:** operators integrating SHARC into ad servers, header bidding wrappers, or publisher O&O ad ops where the markup is in hand and you do not want to host every creative as a URL.

The Creative Markup variant (`creativeHtml` + `creativeRendererUrl`) is an alternative to Creative URL (`creativeUrl`) introduced in 0.7.0. Instead of pointing the iframe at a creative URL the browser fetches directly, the container posts the markup to an **operator-hosted renderer page** that writes it into its own document via `document.open() / document.write() / document.close()`.

The architectural rationale lives in [architecture-design.md §14](./architecture-design.md#14-renderer-protocol--creative-markup-variant); this recipe is the practical setup. Read § 9 next for the hosting side.

### 8.1 Creative Markup hello-world

```html
<!DOCTYPE html>
<html>
<head>
  <title>SHARC Creative Markup hello-world</title>
</head>
<body>
  <div id="ad-slot"></div>

  <script type="module">
    import '/dist/sharc-protocol.mjs';
    import { SHARCContainer } from '/dist/sharc-container.mjs';

    // Minimal HTML banner payload as a complete HTML document. The renderer
    // document.writes this verbatim into its own document, so the markup
    // must stand on its own — not a fragment.
    const CREATIVE_HTML = [
      '<!DOCTYPE html>',
      '<html><head><meta charset="utf-8">',
      '<style>',
      '  html,body{margin:0;padding:0;height:100%;background:#0a4d92;color:#fff;',
      '  font:14px/1.4 system-ui,sans-serif;}',
      '  .ad{display:flex;align-items:center;justify-content:center;height:100%;',
      '  cursor:pointer;}',
      '</style></head><body>',
      '<div class="ad" id="root">Click me</div>',
      '<script>',
      '  document.getElementById("root").addEventListener("click", () => {',
      '    // Intercepted by sharc-navigation-bridge — see § 10',
      '    window.open("https://brand.example.com/landing", "_blank");',
      '  });',
      '<\/script>',
      '</body></html>',
    ].join('\n');

    const container = new SHARCContainer({
      // Creative Markup variant — TWO inputs in place of `creativeUrl`
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: 'https://renderer.your-operator.com/0.7.3/',

      placementElement: document.getElementById('ad-slot'),
      placementId: 'inline-300x250',

      onSecurityEvent: (event) => {
        // Fires for the reserved SHARCSecurityEvent variants; see the
        // authoritative list in api-reference.md (onSecurityEvent surface).
        console.warn('[security]', event.type, event);
      },
      onError: (code, message) => {
        console.error('[onError]', code, message);
      },
      onNavigation: (req) => {
        // Operator observation hook. req.url, req.target, optional req.customScheme.
        // Fires for every creative-requested navigation, regardless of variant
        // (Creative URL or Creative Markup) and regardless of click source
        // (window.open intercepted by the bridge, anchor click, or explicit
        // SHARC.requestNavigation() call). Use for telemetry, audit, post-click
        // analytics. The return value is ignored in 0.7.x — this hook cannot
        // block, allow, delay, or rewrite navigation. URL policy today happens
        // upstream at creative-server review time; runtime control-flow remains
        // future 0.8+ design work.
        console.log('[navigation]', req.url, req.target);
      },
    });

    container.load();
  </script>
</body>
</html>
```

What happens at construction:

1. **Validation rules 1–8** run synchronously. Empty / both / wrong-shape / non-HTTPS / userinfo / same-origin / over-256 KiB markup → throw immediately.
2. The container assembles `iframe.src = creativeRendererUrl + '#sharcNonce=<crypto.randomUUID()>'` and inserts the renderer iframe into the placement element.
3. After iframe `load`, the container posts `SHARC:Renderer:render` carrying the markup, the nonce, version metadata, and the publisher's `containerOrigin`.
4. The renderer validates the envelope, clears the hash, strips meta refresh, installs the navigation bridge, and `document.write`s the creative HTML.
5. The renderer replies `SHARC:Renderer:rendered` with its actual `window.location.origin` (post-redirect canonical) for redirect detection.
6. Container envelope-and-payload-checks the reply, runs origin echo, and proceeds with the standard SHARC bootstrap (`createSession` → `Container:init` → `Container:startCreative`) inside the renderer's `contentWindow`.

The wire-level reference for every step is in [api-reference.md §10](./api-reference.md#10-renderer-protocol).

### 8.2 What's different vs. Creative URL

From the publisher's perspective, the only differences are at construction:

| Aspect | Creative URL | Creative Markup |
|---|---|---|
| Constructor inputs | `creativeUrl` | `creativeHtml` + `creativeRendererUrl` |
| Origin of the running creative | Creative server's origin | Renderer's origin |
| Iframe sandbox `allow-same-origin` | Absent | Present (safe — renderer is cross-origin) |
| `creativeSource` instance property | `'url'` | `'html'` |
| `creativeRendered` instance property | `false` always | `true` after `:rendered` |
| Renderer protocol step | None | One round-trip postMessage |
| Total worst-case load wall clock | ~7.2s | ~14.2s |

Once the creative is rendered, the SHARC API surface inside the iframe is identical — provided the Markup creative includes `sharc-creative.js` in its `creativeHtml` payload. The renderer auto-installs the navigation bridge (so `window.open` interception works regardless), but the rest of the `SHARC.*` API requires the SDK to be loaded inside `creativeHtml`. Recipes 1–7 above apply once the SDK is loaded — see § 8.3 below for the SDK-loading pattern.

### 8.3 SDK-loading pattern for Markup creatives

The reference renderer auto-installs the navigation bridge but does NOT pre-load the full SHARC Creative SDK. A Markup creative that wants the `SHARC.*` API surface (`SHARC.onReady`, `SHARC.requestNavigation`, lifecycle hooks, etc.) includes the SDK script tag inside its `creativeHtml` payload:

```html
<!-- Inside creativeHtml passed to the container -->
<script type="module">
  import 'https://cdn.your-operator.com/sharc-creative.mjs';

  SHARC.onReady(() => {
    // Now SHARC.requestNavigation, lifecycle hooks, etc. are available
    SHARC.requestNavigation({ url: 'https://advertiser.example.com/landing' });
  });
</script>
<div class="creative-banner">
  <!-- creative content -->
</div>
```

Operators self-host the SDK at their own CDN/origin (consistent with the [Renderer Ownership Model](#9-operator-side-renderer-setup)). The hosted reference renderer's bundled SDK is at `https://jeffreycarlson.github.io/SHARC/dist/sharc-creative.mjs` — **for SDK-evaluation only**. Production deployments self-host both the renderer and the SDK on operator-controlled origins.

Why it works this way: the renderer keeps its surface minimal (navigation bridge only) so creatives that don't need the full SHARC API don't pay for it. Markup creatives opt into the SDK by including it; this matches the Creative URL pattern (URL-loaded creatives are responsible for their own SDK loading too).

If the SDK fails to load — broken script tag, CSP block, network failure — the navigation bridge throws `SHARCNavigationError({ code: 'SDK_UNAVAILABLE' })` from inside the renderer iframe. Publisher-side `window.onerror` listeners will not see these throws (cross-origin error scrubbing); operators who want SDK-missing alerts must monitor on the renderer origin itself. See [§ 10.3 SDK-missing failure mode](#103-sdk-missing-failure-mode) for the full diagnostic pattern.

### 8.4 Trying it locally

The repo ships a working demo at `examples/demos/creative-markup/index.html`. Serve it via `node server.cjs` and open `http://localhost:8765/examples/demos/creative-markup/index.html`. The demo points at the SHARC reference renderer hosted at `https://jeffreycarlson.github.io/SHARC/renderer/` — same-origin policy keeps the demo and the hosted renderer cross-origin (`localhost:8765` ≠ `jeffreycarlson.github.io`) so validation rule 7 passes.

### 8.5 MRAID and SafeFrame creatives (0.7.1+)

Most operators do NOT configure `bridges` explicitly — auto-detection covers MRAID and SafeFrame creatives in 0.7.1. The container detects which compatibility bridges the creative needs via a three-layer pipeline (`bridges` explicit override → `creativeMeta.apis` AdCOM codes → adm content scan) and tells the renderer which bridge modules to dynamically `import()` before `document.write(creativeHtml)`. The renderer hosts the bridge modules on its own origin under `dist/sharc-{name}-bridge.mjs`; the canonical reference deployment serves them at `https://jeffreycarlson.github.io/SHARC/dist/sharc-{mraid,safeframe}-bridge.mjs` (your operator fork serves the same shape).

**OpenRTB 2.6 bid pipeline (recommended pattern).** Pass `creativeMeta.apis` from the bid response. OpenRTB 2.6's `bid.apis` references AdCOM `APIFramework` integer codes directly — no translation needed:

```javascript
const container = new SHARCContainer({
  creativeHtml: bid.adm,
  creativeRendererUrl: 'https://renderer.your-operator.com/',
  placementElement: slot,
  creativeMeta: { apis: bid.apis }, // e.g. [5] for MRAID 2.0, [6] for MRAID 3.0
});
container.load();
```

**OpenRTB 2.5 / pre-2.6 bid pipeline.** The deprecated singular `bid.api` (single integer) needs normalization at the call site:

```javascript
const apis = bid.apis ?? (typeof bid.api === 'number' ? [bid.api] : bid.api ?? []);
const container = new SHARCContainer({
  creativeHtml: bid.adm,
  creativeRendererUrl: 'https://renderer.your-operator.com/',
  placementElement: slot,
  creativeMeta: { apis },
});
```

**Explicit override.** Operators with out-of-band information about the creative (e.g. classified as static-image upstream) override auto-detection:

```javascript
new SHARCContainer({ /* ... */, bridges: [] });            // suppress all bridge loading
new SHARCContainer({ /* ... */, bridges: ['mraid'] });     // force MRAID
new SHARCContainer({ /* ... */, bridges: ['mraid', 'safeframe'] }); // force both
```

The resolved bridge list is exposed as `container.bridges` (frozen array) for operator dashboards correlating "this `placementSessionId` had MRAID bridge loaded" — useful when investigating creative-rendering bugs.

What's NOT in 0.7.1's bridge vocabulary: `'omid'` (OMID viewability). 0.7.3 decided OMID stays **extension-owned**, not in the renderer bridge vocabulary — see [`docs/design/0.7.3-omid-wiring.md`](./design/0.7.3-omid-wiring.md) § 5 (Bridge vs. Extension Architecture). The `bridges` array stays `['mraid', 'safeframe']`; OMID measurement is wired via the container-owned `OmidCompatBridge` extension. A container passing `bridges: ['omid']` throws synchronously at construction.

The hosted reference renderer is **SDK evaluation only**. The container's `KNOWN_TEST_RENDERERS` guard refuses to load it from non-dev origins and throws synchronously at construction. See § 9 for the production setup.

---

## 9. Operator-Side Renderer Setup

**Audience:** the team standing up the renderer hosting that `creativeRendererUrl` points at — typically the same team that owns the SHARC SDK rollout (ad ops, ad server engineering, header-bidding wrapper team).

The reference renderer in `examples/renderer/index.html` is the canonical fork starting point. The protocol contract is invariant across operators; the implementation is operator-tweakable.

### 9.1 What the SHARC project hosts

The SHARC project deploys the reference renderer at:

- `https://jeffreycarlson.github.io/SHARC/renderer/` (current SDK evaluation; future upstream URL added when SHARC is contributed to IABTechLab)

This is **for SDK evaluation and integration testing only**. The container's `KNOWN_TEST_RENDERERS` guard refuses to load this URL from non-dev origins (anchored regex match against `localhost`, `127.0.0.1`, `*.localhost`, `*.test`, `*.local`, `[::1]`, `0.0.0.0`). Production deployments throw synchronously at construction with a diagnostic naming the URL and listing the dev-origin allowlist.

Do not point production traffic at `jeffreycarlson.github.io` or any future SHARC-hosted variant. Fork.

### 9.2 Production setup steps

1. **Fork `examples/renderer/index.html` into your repo.** Pick the operator-hosting path that matches your CDN posture (object storage + edge worker, dedicated origin, container behind your own load balancer).

2. **Set `RENDERER_CONFIG.TEST_ONLY = false`** at the top of the inline script. This suppresses the dev banner that the reference renderer shows when `window.parent === window` (loaded directly, not as an iframe). The banner exists to flag when an operator accidentally points production at the SDK-reference URL — keep it on in test forks; turn it off in production.

3. **Configure HTTP-response CSP** on the renderer page:
   ```
   Content-Security-Policy: object-src 'none'; base-uri 'none'
   ```
   The iframe `csp` attribute the container also sets is Chromium-only (Firefox and Safari do not honor it). HTTP-response CSP is the portable enforcement layer. Without it, Firefox and Safari sessions are unprotected from `<base href>` injection and plugin-content vectors.

4. **Configure `Cross-Origin-Resource-Policy: same-origin`** on the renderer HTTP response. CORP doesn't block iframe embedding — that's `frame-ancestors` / `X-Frame-Options`'s job, which you must NOT set restrictively. CORP blocks adversaries from loading the renderer page as an `<img>` / `<script>` / other subresource type.

5. **DO NOT register a Service Worker on the renderer origin.** A Service Worker on the renderer origin sees every iframe load including the URL fragment (via `FetchEvent.request.url`) and can substitute the renderer HTML transparently — defeating the fragment-nonce defense. The reference renderer has a runtime check that posts `SHARC:Renderer:failed { reason: 'service_worker_detected' }` if one is found, but the runtime check is a safety net, not a substitute for not registering one.

6. **Choose a storage-isolation strategy.** The renderer must clear origin storage between impressions to prevent cross-impression amplification:
   - **Strategy A** — `Clear-Site-Data: "storage"` HTTP header (recommended baseline). Spec-blessed; clears localStorage / sessionStorage / IndexedDB / Cache API / cookie store from the server side.
   - **Strategy B** — JS-side clearing (fallback for older Safari versions where Strategy A coverage is incomplete). `localStorage.clear()`, `sessionStorage.clear()`, `indexedDB.databases()` enumeration + delete, `caches.keys()` + `caches.delete()`, `document.cookie` best-effort.
   - **Strategy C** — ephemeral or per-tenant renderer origins (strongest isolation; structural rather than behavioral). Higher operational cost; required for cross-advertiser isolation in regulated verticals or Safari-heavy traffic.

   The reference renderer ships with Strategy A configured plus Strategy B as a JS-side fallback. Operators serving significant Safari traffic, or with strict cross-advertiser isolation requirements, should adopt Strategy C.

7. **Serve `.mjs` files with `Content-Type: application/javascript`** (or `text/javascript`). Browsers reject ES modules served as `application/octet-stream`, which is the default MIME for unknown extensions on most CDNs. The reference dev server (`server.cjs`) handles this; nginx, CloudFront, Cloudflare, and similar static origins need explicit MIME mapping.

8. **Pick a versioned URL path.** Convention: `https://renderer.operator.com/0.7.0/`, `https://renderer.operator.com/0.8.0/`, etc. The version segment names the SHARC SDK release the renderer was forked from. Patch releases reuse the URL — the protocol-version handshake enforces actual compatibility, not the URL path. The path convention is a naming guide, not a security boundary.

9. **Coordinate with measurement vendors.** IAS, DV, OMID — most maintain per-origin allowlists for fraud detection and viewability scoring. New renderer origins need onboarding the same way any new ad-serving subdomain would.

### 9.3 What stays in your operator fork

Operator-specific code stays in your fork; non-operator-specific improvements go upstream. Forks that drift accumulate maintenance burden and weaken the reference implementation's security posture (which depends on being the most-reviewed implementation in the wild).

| Belongs upstream (file an issue/PR) | Belongs in your fork |
|---|---|
| Bug fixes in renderer protocol logic | Operator branding (logo, page title) |
| Security hardening (CSP refinements) | Internal audit logging endpoints |
| Browser compatibility patches | Operator-specific monitoring integration |
| Performance improvements | Customer support hooks |
| Observability improvements | Operator-internal feature flags |
| Documentation improvements | Deployment scripting |

The reference renderer exposes four operator extension points so most fork-specific behavior lands without touching canonical code:

- **`window.__sharcRenderer.onBeforeRender(meta)`** — synchronous hook fires after envelope validation passes, before `document.write`
- **`window.__sharcRenderer.onAfterRender(meta)`** — synchronous hook fires after the inner document's `DOMContentLoaded`, before `:rendered` posts
- **`window.__sharcRenderer.customSecurityLog(level, message, details)`** — receives every renderer-internal log event (default thin pass-through to `console.warn` / `console.error`)
- **`window.__sharcRenderer.beforeStorageClear()`** — synchronous hook fires before Strategy B JS-side clearing runs

All hooks MUST be synchronous — async hooks would race the container's 2s `:rendered` reply timeout.

### 9.4 Container and renderer must upgrade together

When `rendererProtocolVersion` changes (typically minor SHARC releases), operators MUST upgrade the renderer in coordination with the SDK upgrade, or impressions fail with `SHARC:Renderer:failed { reason: 'unsupported_renderer_protocol_version' }`. Mismatches are loud (immediate failures via `onSecurityEvent`), not silent — operators see them immediately in monitoring.

Zero-downtime deployment pattern (standard server-deploys-before-clients):

1. **Stage** — test SDK + renderer upgrade together
2. **Renderer first** — deploy new renderer with `RENDERER_CONFIG.ALLOWED_PROTOCOL_VERSIONS` accepting old AND new protocol versions during transition
3. **Container second** — roll out SDK upgrade; old containers keep working via the renderer's backward-compat path
4. **Drop old support last** — once monitoring confirms migration, drop old protocol from the renderer's accept-list

Patch releases (e.g. `0.7.0` → `0.7.1`) do NOT bump the protocol; reuse the renderer URL.

---

## 10. Click-through with Creative Markup + Navigation Bridge

**Audience:** creative authors writing markup that ships through Creative Markup, and operators auditing the click-through path.

`SHARC.requestNavigation()` (recipe § 4) is the primary click-through API for SHARC-aware creatives. For markup that uses standard web patterns instead — `window.open`, anchor clicks, form submits, `location.href` setters, meta refresh — the `sharc-navigation-bridge` intercepts those patterns and routes them through `SHARC.requestNavigation()` automatically.

In Creative Markup flow, the **renderer page** auto-installs the bridge before `document.write(creativeHtml)`. Capture-phase listeners persist across `document.open() / write()` because the document object identity is preserved, so the bridge's interceptors apply to all creative code regardless of when it loads.

In Creative URL flow, the **SHARC Creative SDK** auto-installs the bridge at SDK init when running outside the reference renderer (variant detected via `window.__sharcRenderer` presence — set by the renderer). The variant difference is *who controls the bridge load point*, not whether comprehensive coverage is achievable.

### 10.1 What the bridge intercepts

| Pattern | Routed through `requestNavigation` | Notes |
|---|---|---|
| `window.open(url, target)` | Yes | Adds `noopener,noreferrer` features unconditionally; suppressed entirely when `allowPopups: false` removes `allow-popups` from the sandbox |
| `<a>` clicks (no target, `target="_blank"`, `target="_top"`) | Yes | Single document-level capture-phase listener; defensively adds `rel="noopener noreferrer"`; crosses open shadow boundaries via `composedPath` |
| `<form>` submits | Yes | Capture-phase listener; routes the form action URL |
| `location.href = url`, `location.assign(url)`, `location.replace(url)` | Yes | Setter / method interception |
| `<meta http-equiv="refresh">` | Stripped from `creativeHtml` (Markup only) | DOMParser-based strip pre-`document.write`; renderer-side only — Creative URL relies on the load-event backstop instead |

The bridge is **best-effort**. Adversarial creative HTML can re-override `window.open`, redefine `location` getters, or use other patterns to bypass it. The container-side load-event backstop (`RENDERER_UNAUTHORIZED_NAVIGATION` 2118) is the defense-in-depth catch — it fires on any iframe `load` event beyond the expected sequence and terminates the session.

### 10.2 Operator-side click-through observation

```javascript
const container = new SHARCContainer({
  creativeHtml: CREATIVE_HTML,
  creativeRendererUrl: 'https://renderer.your-operator.com/0.7.3/',
  placementElement: document.getElementById('ad-slot'),

  onNavigation: (req) => {
    // req.url, req.target, optional req.customScheme
    // Operator observation hook for click telemetry. The same hook fires
    // whether the click came from `window.open` (intercepted by the bridge),
    // an anchor click, or an explicit SHARC.requestNavigation() call.
    // Operators get a single click-event hook regardless of variant.
    //
    // The return value is ignored in 0.7.x. Runtime URL gating is not
    // provided at the click layer today — operators see the URL via
    // `onNavigation` for telemetry, but blocking / rewriting / allowlisting
    // happens upstream at creative-server review time. Runtime control-flow
    // remains future 0.8+ design work.
    telemetry.record('navigation', { url: req.url, target: req.target });
  },
});
```

Both Creative URL and Creative Markup creatives surface clicks through `onNavigation` — the variant-difference is invisible at the observation layer. The trust model around bridge bypass (legitimate creatives use the bridge; adversarial creatives are caught by the load-event backstop) applies to both flows.

### 10.3 SDK-missing failure mode

If the renderer page fails to load the SHARC SDK (broken script tag, CSP block on the SDK URL, network failure), the navigation bridge fails loud — anchor / form / `location.*` interceptions throw `SHARCNavigationError` with `code: 'SDK_UNAVAILABLE'`. The throws fire **inside the renderer iframe**, NOT the publisher window, so cross-origin error scrubbing renders publisher-side `window.onerror` listeners blind.

Operators who want SDK-missing alerts MUST install `window.addEventListener('error', ...)` on the renderer page itself in their fork, and ship those events to their own observability stack. Publisher-side monitoring will not see them. See [api-reference.md § Navigation Bridge Error Contract](./api-reference.md#navigation-bridge-error-contract) for the full throw matrix.
