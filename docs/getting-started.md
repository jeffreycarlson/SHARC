# SHARC Getting Started Guide

**Version:** 1.0  
**Last Updated:** 2026-04-03  

This guide covers two audiences:
1. **[Container Implementers](#part-1-container-implementers)** — publishers and SSPs embedding ads
2. **[Creative Developers](#part-2-creative-developers)** — ad developers building SHARC-enabled creatives

Each part is self-contained. Read only what applies to you.

---

## Part 1: Container Implementers

You are a publisher or SSP. You want to render SHARC-enabled ads in your web page or mobile app. Your job is to create the container — the secure environment that runs the ad.

### What the Container Does

- Creates a sandboxed iframe (web) or WebView (mobile)
- Runs the SHARC handshake with the creative
- Controls what the ad can and cannot do
- Provides the close button
- Handles navigation, placement changes, and state events

### Step 1: Include the Container Library

```html
<script src="sharc-container.js"></script>
```

Or as an ES module:

```javascript
import { SHARCContainer } from './sharc-container.js';
```

### Step 2: Create the Container

```javascript
const container = new SHARCContainer({
  // Where to render the ad
  element: document.getElementById('ad-slot'),

  // The creative URL to load
  creativeUrl: 'https://ad.example.com/creative.html',

  // Placement information
  placement: {
    width: 320,
    height: 50,
    inline: true  // anchored in content (vs. overlay)
  },

  // Optional: AdCOM data from your ad server
  adcom: {
    ad: adcomAdObject,
    placement: adcomPlacementObject,
    context: adcomContextObject
  },

  // Optional: SHARC version this container implements
  version: '1.0.0'
});
```

### Step 3: Start the Ad

```javascript
// start() returns a Promise that resolves when the ad is visible
container.start()
  .then(() => {
    console.log('Ad is running');
  })
  .catch((error) => {
    console.error('Ad failed to start:', error.code, error.message);
    // Load a fallback ad, fill with house ad, etc.
  });
```

### Step 4: Handle Events

```javascript
// State changes (active, passive, hidden, frozen)
container.on('stateChange', (newState) => {
  console.log('Container state:', newState);
  // e.g., pause your video content when state is 'hidden'
});

// Ad closed (user clicked close, or creative requested close)
container.on('close', () => {
  console.log('Ad closed');
  // Remove the ad slot, load next ad, etc.
  container.destroy();
});

// Fatal error
container.on('error', (error) => {
  console.error('Ad error:', error.code, error.message);
  container.destroy();
  // Load fallback
});

// Creative navigation request (useful for click tracking)
container.on('navigation', (navEvent) => {
  console.log('Creative navigating to:', navEvent.url, 'type:', navEvent.target);
  // Container handles the actual navigation; this is the event callback
});
```

### Step 5: Handle Platform Lifecycle (Web)

The container automatically monitors `document.visibilityState` and `window.focus` / `window.blur` events. You don't need to do anything for web. The container transitions state automatically:

- Tab hidden → sends `stateChange: hidden`
- Tab back in foreground → sends `stateChange: active`
- Page freeze event → sends `stateChange: frozen`

### Step 6: Handle Platform Lifecycle (Mobile — iOS WKWebView)

Pass app lifecycle events through to the container:

```swift
// AppDelegate.swift

func applicationWillResignActive(_ application: UIApplication) {
    sharcContainer.notifyLifecycle(.passive)
}

func applicationDidEnterBackground(_ application: UIApplication) {
    sharcContainer.notifyLifecycle(.hidden)
}

func applicationWillEnterForeground(_ application: UIApplication) {
    sharcContainer.notifyLifecycle(.passive)  // visible, not yet focused
}

func applicationDidBecomeActive(_ application: UIApplication) {
    sharcContainer.notifyLifecycle(.active)
}
```

### Step 7: Handle Platform Lifecycle (Mobile — Android WebView)

```kotlin
// In your Activity:

override fun onResume() {
    super.onResume()
    webView.onResume()
    sharcContainer.notifyLifecycle(ContainerState.ACTIVE)
}

override fun onPause() {
    super.onPause()
    webView.onPause()
    sharcContainer.notifyLifecycle(ContainerState.PASSIVE)
}

override fun onStop() {
    super.onStop()
    webView.pauseTimers()
    sharcContainer.notifyLifecycle(ContainerState.HIDDEN)
}

override fun onStart() {
    super.onStart()
    webView.resumeTimers()
}
```

### Complete Web Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>SHARC Ad Slot</title>
  <script src="sharc-container.js"></script>
</head>
<body>

  <div id="content">
    <p>Publisher content here.</p>
    
    <!-- Ad slot -->
    <div id="ad-slot-300x250" style="width:300px; height:250px;"></div>
    
    <p>More content here.</p>
  </div>

  <script>
    const container = new SHARCContainer({
      element: document.getElementById('ad-slot-300x250'),
      creativeUrl: 'https://cdn.ad.example.com/ad-123.html',
      placement: {
        width: 300,
        height: 250,
        inline: true
      },
      version: '1.0.0'
    });

    container.on('close', () => {
      document.getElementById('ad-slot-300x250').remove();
      container.destroy();
    });

    container.on('error', (err) => {
      console.warn('Ad failed:', err.code);
      // Optionally request a replacement ad here
      container.destroy();
    });

    container.start().catch(err => {
      console.warn('Ad did not start:', err.code);
    });
  </script>

</body>
</html>
```

### Container Security Requirements

The container library enforces these security properties by default. You should not disable them.

**Sandboxed iframe:**

```html
<!-- The container creates this iframe internally -->
<iframe
  src="https://creative-origin.example.com/ad.html"
  sandbox="allow-scripts"
  style="border:0"
></iframe>
```

> **Important:** `allow-same-origin` is intentionally **not** included in the sandbox attribute. Combining `allow-scripts` and `allow-same-origin` on a same-origin iframe allows the embedded document to remove its own `sandbox` attribute entirely — a complete sandbox escape. `MessageChannel` does **not** require `allow-same-origin`; the transferred port works correctly across origins without it.
>
> Do not add `allow-same-origin` or `allow-popups-to-escape-sandbox` to this sandbox. If you need popups from creative navigation, handle them through `requestNavigation` instead.

**Session ID validation:** The container validates the `sessionId` on `createSession` against UUID v4 format. Malformed IDs are rejected.

**URL validation:** `requestNavigation` and `reportInteraction` tracker URIs are validated to allow only `https:` and `http:` schemes. All other schemes are rejected or dropped before any network request is made.

**Rate limiting:** The container drops incoming messages that exceed 50 per second. Persistent violators receive error `2205`.

**Pending response cap:** No more than 100 in-flight requests are tracked simultaneously. This prevents memory exhaustion from a misbehaving creative.

**Origin validation:** The initial bootstrap `postMessage` uses `targetOrigin: '*'` by design — this message carries only the `MessagePort` and no sensitive data. All subsequent SHARC communication flows through the private `MessageChannel` port, which has no broadcast risk. Third-party scripts on the publisher page cannot intercept these messages.

**No shared globals:** The creative runs in its own sandboxed browsing context. It cannot access `window.parent`, your cookies, localStorage, or any other data on your page.

### Advertising Extensions

If your container supports extensions (optional features), advertise them in the `features` config:

```javascript
const container = new SHARCContainer({
  // ...
  features: [
    {
      name: 'com.iabtechlab.sharc.audio',
      version: '1.0',
      handler: async (args) => {
        // Handle audio requests from the creative
        if (args.action === 'setVolume') {
          myVideoPlayer.setVolume(args.level);
        }
        return { success: true };
      }
    }
  ]
});
```

---

## Part 2: Creative Developers

You are building an ad. You want to use the SHARC API to resize, track interactions, handle clicks, and close cleanly.

### The Two-Minute Version

```html
<!DOCTYPE html>
<html>
<head>
  <script src="sharc-creative-sdk.js"></script>
</head>
<body>
  <div id="ad">
    <!-- Your ad content here -->
    <img src="banner.jpg" id="banner" />
  </div>

  <script>
    // 1. onReady fires after Container:init
    // env = EnvironmentData (size, version, features, etc.)
    SHARC.onReady(async (env, features) => {
      // Prepare your ad. Load assets if needed.
      // Set muted state if env.isMuted is true.
      console.log('Container size:', env.currentPlacement.initialDefaultSize);
      console.log('SHARC version:', env.version);
    });

    // 2. onStart fires after Container:startCreative
    // Make your ad visible here.
    SHARC.onStart(async () => {
      document.getElementById('ad').style.display = 'block';
    });

    // 3. Handle click
    document.getElementById('banner').addEventListener('click', async () => {
      try {
        await SHARC.requestNavigation({
          url: 'https://advertiser.example.com/landing',
          target: 'clickthrough'
        });
        // Container handled navigation (mobile). Nothing else to do.
      } catch (err) {
        if (err.code === 2105) {
          // Container can't handle it (web). Open it ourselves.
          window.open('https://advertiser.example.com/landing', '_blank');
        }
      }
    });
  </script>
</body>
</html>
```

That's it. The SDK handles `createSession`, the protocol handshake, message sequencing, and timeouts automatically.

### Understanding the Creative Lifecycle

```
[Script loads]
      │
      ▼
SDK sends createSession ──► Container resolves
      │
      ▼
Container sends init
      │
SHARC.onReady(env, features) is called
      │
Your callback runs (load assets, check features, check muted state)
      │
Your callback returns / resolves promise
      │
Container sends startCreative
      │
SHARC.onStart() is called
      │
Your callback makes the ad visible
      │
      ▼
[Ad is running]
      │
      ▼
Container sends close
      │
Your close handler runs (fire trackers, animate close)
      │
      ▼
[Ad unloads]
```

### Checking Features

Use `SHARC.hasFeature()` (synchronous) to check what the container supports. Feature data is available as soon as `onReady` fires.

```javascript
SHARC.onReady(async (env, features) => {
  // Check for audio controls
  if (SHARC.hasFeature('com.iabtechlab.sharc.audio')) {
    // Show audio toggle button
    document.getElementById('audio-btn').style.display = 'block';
  }

  // Check for location (rare — requires user permission)
  if (SHARC.hasFeature('com.iabtechlab.sharc.location')) {
    const location = await SHARC.requestFeature('com.iabtechlab.sharc.location', {});
    showNearbyOffers(location);
  }
});
```

### Handling Mute State

Many mobile ad environments start muted. Check `env.isMuted` and configure your audio accordingly.

```javascript
SHARC.onReady(async (env, features) => {
  const videoEl = document.getElementById('my-video');

  if (env.isMuted) {
    videoEl.muted = true;
  } else if (env.volume !== undefined && env.volume >= 0) {
    videoEl.volume = env.volume;
  }
});
```

### Resize (Expand/Collapse)

```javascript
// Expand the ad
document.getElementById('expand-btn').addEventListener('click', async () => {
  try {
    const result = await SHARC.requestPlacementChange({
      containerDimensions: { width: 320, height: 480 },
      inline: false  // expand over content
    });
    console.log('Expanded to:', result.containerDimensions);
    showExpandedContent();
  } catch (err) {
    console.warn('Expand failed:', err.message);
    // Container rejected it. Stay at default size.
  }
});

// Collapse back to default
document.getElementById('collapse-btn').addEventListener('click', async () => {
  const options = await SHARC.getPlacementOptions();
  await SHARC.requestPlacementChange({
    containerDimensions: {
      width: options.currentPlacementOptions.containerDimensions.width,
      height: 50   // back to banner height
    },
    inline: true
  });
  showCollapsedContent();
});
```

### Handling State Changes

The container sends state updates when the user switches apps, locks the screen, etc. Use these to pause/resume your creative.

```javascript
SHARC.on('stateChange', (state) => {
  switch (state) {
    case 'active':
      resumeAnimations();
      resumeVideo();
      break;
    case 'passive':
    case 'hidden':
      pauseAnimations();
      pauseVideo();
      break;
    case 'frozen':
      // JS may stop running at any moment after this
      // Nothing to do — you should have paused in 'hidden'
      break;
  }
});
```

### Reporting Interactions

Delegate tracker firing to the container. This is more reliable than firing from the creative (the container can retry, handle redirects, and maintain the log).

```javascript
// On ad view (for custom viewability or engagement tracking)
SHARC.reportInteraction([
  'https://tracking.example.com/view?id=abc123',
  'https://another-tracker.com/pixel?ev=view'
])
.then((results) => {
  console.log('Trackers fired:', results);
});
```

### Requesting Close

The container always shows a close button. If you want to close programmatically (e.g., after a countdown timer or at the end of the ad experience):

```javascript
// After ad completes:
const closed = await SHARC.requestClose();
// If the container rejects, the ad stays open but you can still wind down internally
```

### Running a Close Sequence

When the user hits close (from the container's close button), you get a brief window to run a closing animation or fire final trackers.

```javascript
SHARC.on('close', async () => {
  // You have ~2 seconds. Be fast.
  await fireClosingTrackers();
  await playCloseAnimation();
  // SDK will force-unload you after 2 seconds regardless
});
```

### Signaling a Fatal Error

If your creative cannot run (failed to load assets, wrong ad size, incompatible browser), tell the container so it can replace you with a fallback:

```javascript
SHARC.onReady(async (env, features) => {
  const { width, height } = env.currentPlacement.initialDefaultSize;

  if (width < 300 || height < 250) {
    // Container is too small for this creative
    SHARC.fatalError(2102, 'Need at least 300x250, got ' + width + 'x' + height);
    return;
  }

  // ... normal init
});
```

### Logging

Use `SHARC.log()` to send debug messages to the container's console. This appears in test harnesses and dev tools.

```javascript
SHARC.log('Creative loaded. Targeting: ' + targetingLabel);
SHARC.log('WARNING: Expected 300x250 but got smaller — resizing gracefully');
```

Messages prefixed with `"WARNING:"` signal spec deviations to container developers.

### Full Example: Expandable Banner

```html
<!DOCTYPE html>
<html>
<head>
  <title>SHARC Expandable Banner</title>
  <script src="sharc-creative-sdk.js"></script>
  <style>
    body { margin: 0; padding: 0; overflow: hidden; }
    #collapsed { width: 320px; height: 50px; background: #0066cc; color: white;
                 display: flex; align-items: center; justify-content: space-between;
                 padding: 0 10px; box-sizing: border-box; cursor: pointer; }
    #expanded  { width: 320px; height: 480px; background: #fff; display: none; }
    #expand-btn { font-size: 12px; }
    #close-btn  { font-size: 12px; cursor: pointer; }
  </style>
</head>
<body>

<div id="collapsed">
  <span>Tap to Expand</span>
  <button id="expand-btn">▲ Expand</button>
</div>

<div id="expanded">
  <img src="full-ad.jpg" id="ad-image" style="width:320px; height:420px;" />
  <div style="display:flex; gap:10px; padding:10px;">
    <button id="cta-btn" style="flex:1;">Shop Now</button>
    <button id="collapse-btn">▼ Collapse</button>
  </div>
</div>

<script>
  let isExpanded = false;

  SHARC.onReady(async (env, features) => {
    SHARC.log('Expandable banner ready. Size: ' +
      env.currentPlacement.initialDefaultSize.width + 'x' +
      env.currentPlacement.initialDefaultSize.height);
  });

  SHARC.onStart(async () => {
    document.getElementById('collapsed').style.display = 'flex';
  });

  SHARC.on('stateChange', (state) => {
    if ((state === 'hidden' || state === 'frozen') && isExpanded) {
      collapse(); // Auto-collapse when app goes to background
    }
  });

  SHARC.on('close', async () => {
    // Fire close tracker before unloading
    await SHARC.reportInteraction(['https://tracking.example.com/close']);
  });

  document.getElementById('expand-btn').addEventListener('click', expand);
  document.getElementById('collapse-btn').addEventListener('click', collapse);

  document.getElementById('cta-btn').addEventListener('click', async () => {
    try {
      await SHARC.requestNavigation({
        url: 'https://advertiser.example.com/sale',
        target: 'clickthrough'
      });
    } catch (err) {
      if (err.code === 2105) {
        window.open('https://advertiser.example.com/sale', '_blank');
      }
    }

    await SHARC.reportInteraction([
      'https://tracking.example.com/click?ev=cta'
    ]);
  });

  async function expand() {
    if (isExpanded) return;
    await SHARC.requestPlacementChange({
      containerDimensions: { width: 320, height: 480 },
      inline: false
    });
    document.getElementById('collapsed').style.display = 'none';
    document.getElementById('expanded').style.display = 'block';
    isExpanded = true;

    await SHARC.reportInteraction(['https://tracking.example.com/expand']);
  }

  async function collapse() {
    if (!isExpanded) return;
    await SHARC.requestPlacementChange({
      containerDimensions: { width: 320, height: 50 },
      inline: true
    });
    document.getElementById('expanded').style.display = 'none';
    document.getElementById('collapsed').style.display = 'flex';
    isExpanded = false;
  }
</script>

</body>
</html>
```

### Checklist: Before You Serve

- [ ] Creative calls `SHARC.onReady()` and returns a resolved Promise when ready
- [ ] Creative calls `SHARC.onStart()` and makes itself visible inside the callback
- [ ] All navigation calls go through `SHARC.requestNavigation()` before opening a URL
- [ ] Creative handles `stateChange` events (at minimum: pause on `hidden`, resume on `active`)
- [ ] Creative handles `close` event (even if just firing trackers)
- [ ] Creative calls `SHARC.fatalError()` for unrecoverable errors instead of silently breaking
- [ ] Creative does NOT try to access `window.parent`, `document.cookie`, or page globals

---

## Next Steps

- **Test your integration:** Use the SHARC test harness (`src/test/index.html`) to verify the full message protocol.
- **Check API details:** See [api-reference.md](./api-reference.md) for complete message specs.
- **Coming from MRAID?** See [mraid-migration.md](./mraid-migration.md) for a direct mapping.
