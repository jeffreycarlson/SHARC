# SHARC Platform Integration Guide

**Audience:** Container implementers wiring SHARC into an iOS or Android host application.

This guide covers the practical setup for both platforms: minimum WebView configuration, lifecycle wiring to SHARC state transitions, navigation delegation, and security posture. Read [architecture-design.md](./architecture-design.md) for the protocol rationale behind these decisions.

---

## Table of Contents

1. [iOS WKWebView](#1-ios-wkwebview)
2. [Android WebView](#2-android-webview)
3. [Shared Guidance](#3-shared-guidance)
4. [Pre-flight Checklist](#4-pre-flight-checklist)

---

## 1. iOS WKWebView

### Minimum Setup

SHARC requires iOS 14+ for native `MessageChannel` support in WKWebView. Configure the web view with `allowsInlineMediaPlayback` to prevent ads from forcing fullscreen video playback, and load the creative URL via `loadRequest` or `loadHTMLString:baseURL:`.

```swift
import WebKit

class SHARCAdViewController: UIViewController {

    var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.navigationDelegate = self
        view.addSubview(webView)

        // Option A: load by URL
        let creativeURL = URL(string: "https://ads.example.com/creative.html")!
        webView.load(URLRequest(url: creativeURL))

        // Option B: load markup directly (for server-injected creatives)
        // webView.loadHTMLString(creativeMarkup, baseURL: nil)

        // Wire lifecycle observers
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(appDidBecomeActive),
                       name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(appWillResignActive),
                       name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(appDidEnterBackground),
                       name: UIApplication.didEnterBackgroundNotification, object: nil)
    }
}
```

### Lifecycle Wiring

Map each iOS application lifecycle callback to the correct SHARC state transition. Call `sendStateChange` via `evaluateJavaScript` after the WebView is ready (see [§3.1](#31-initchannel-timing)).

```swift
// active: app is in foreground with focus and the WebView is visible
@objc func appDidBecomeActive() {
    guard webViewIsVisible else { return }
    webView.evaluateJavaScript("SHARC.__internal__.sendStateChange('active')")
    { _, error in
        if let error { print("[SHARC] sendStateChange active error: \(error)") }
    }
}

// passive: app lost input focus but is still visible
// Common triggers: incoming call, split-screen activation, Notification Center pull-down
@objc func appWillResignActive() {
    webView.evaluateJavaScript("SHARC.__internal__.sendStateChange('passive')")
    { _, _ in }
}

// hidden: app moved to background; device screen is off; ad is not visible
@objc func appDidEnterBackground() {
    webView.evaluateJavaScript("SHARC.__internal__.sendStateChange('hidden')")
    { _, _ in }
}
```

The `frozen` state is not directly observable — WKWebView process suspension happens below the application layer with no explicit callback. In practice the OS kills the process and the creative never receives a `frozen` message; your `webViewWebContentProcessDidTerminate` handler covers the recovery path.

```swift
// terminated: WebContent process was killed by the OS (OOM or freeze-then-kill)
// Handle gracefully — tear down your container state and optionally reload
extension SHARCAdViewController: WKNavigationDelegate {
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The SHARC channel is gone. Clean up container state.
        sharcContainer.handleTermination()
        // Optionally reload if the placement is still on screen
        // webView.reload()
    }
}
```

### Navigation Delegation

Intercept `webView(_:decidePolicyFor:decisionHandler:)` to route clickthroughs through your `onNavigation` callback. The creative sends `requestNavigation` over the SHARC channel; your container implementation calls this delegate when it decides to open the URL.

```swift
extension SHARCAdViewController: WKNavigationDelegate {

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Allow initial creative load and same-document navigation
        if navigationAction.navigationType == .other
            || navigationAction.navigationType == .reload {
            decisionHandler(.allow)
            return
        }

        // Route clickthroughs through the SHARC onNavigation callback
        // SHARC containers handle navigation via requestNavigation messages,
        // so direct link taps inside the sandboxed WebView should be cancelled
        // here and handled through the SHARC protocol instead.
        if let url = navigationAction.request.url {
            sharcContainer.onNavigation?(["url": url.absoluteString, "target": "clickthrough"])
        }
        decisionHandler(.cancel)
    }
}
```

### MessageChannel on iOS

`MessageChannel` has been natively available in WKWebView since **iOS 14**. No bridging, no JavaScript injection, and no `WKScriptMessageHandler` workaround is needed. The SHARC container SDK creates the channel entirely in JavaScript, transfers port2 to the creative iframe via the bootstrap `postMessage`, and all subsequent communication flows through the private port pair.

**Minimum iOS version:** 14.0 for `MessageChannel`. If your deployment target is iOS 13, the SHARC SDK's built-in `postMessage` fallback activates automatically with sessionId-based filtering — set `sharcContainer.allowMessageChannelFallback = true` if you need to support it.

---

## 2. Android WebView

### Minimum Setup

SHARC requires Android API 21 (Lollipop) with Chromium 74+. Enable JavaScript and attach a `WebViewClient` before loading. The creative URL is loaded via `webView.loadUrl()`.

```kotlin
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class SHARCAdActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)

        // Required: JavaScript must be enabled
        webView.settings.javaScriptEnabled = true

        // Recommended for media-bearing ads
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.allowFileAccess = false

        webView.webViewClient = SHARCWebViewClient()

        setContentView(webView)

        webView.loadUrl("https://ads.example.com/creative.html")
    }
}
```

### Lifecycle Wiring

Map each Android Activity lifecycle callback to the correct SHARC state transition. `WebView.onResume()` and `WebView.onPause()` must be called alongside their Activity counterparts to resume and pause WebView-internal rendering and JavaScript timers.

```kotlin
// active: Activity is in foreground, WebView is rendering, user can interact
override fun onResume() {
    super.onResume()
    webView.onResume()
    webView.evaluateJavascript("SHARC.__internal__.sendStateChange('active')") { result ->
        // result is the JS return value — null on success when the function returns undefined
    }
}

// passive: Activity is partially visible (multi-window, split-screen)
// onPause is called when the activity loses focus but remains visible in multi-window
override fun onPause() {
    super.onPause()
    webView.onPause()
    // Only send 'passive' in multi-window; send 'hidden' in onStop for full background
    if (isInMultiWindowMode) {
        webView.evaluateJavascript("SHARC.__internal__.sendStateChange('passive')") { _ -> }
    }
}

// hidden: Activity is fully backgrounded and not visible
override fun onStop() {
    super.onStop()
    // pauseTimers() suspends JavaScript timer callbacks system-wide for this WebView process
    webView.pauseTimers()
    webView.evaluateJavascript("SHARC.__internal__.sendStateChange('hidden')") { _ -> }
}

// frozen: JS timers are suspended via pauseTimers() — paired with hidden above
// The creative cannot receive the 'frozen' message while frozen, but the container
// should send it just before calling pauseTimers() so the creative can checkpoint state
override fun onStop() {
    super.onStop()
    webView.evaluateJavascript("SHARC.__internal__.sendStateChange('frozen')") { _ ->
        webView.pauseTimers()
    }
}
```

Handle WebView renderer termination for OOM and crash scenarios:

```kotlin
inner class SHARCWebViewClient : WebViewClient() {

    override fun onRenderProcessGone(
        view: WebView,
        detail: RenderProcessGoneDetail
    ): Boolean {
        // Renderer was killed — tear down SHARC state
        sharcContainer.handleTermination()
        // Return true to indicate we handled it (prevents app crash)
        // Re-create the WebView and reload if the placement is still needed
        return true
    }
}
```

### Navigation Delegation

Override `shouldOverrideUrlLoading` in your `WebViewClient` to intercept navigation requests and route them through the SHARC `onNavigation` callback. This is essential for deep links and store URLs on Android — the WebView cannot open them directly.

```kotlin
inner class SHARCWebViewClient : WebViewClient() {

    @Suppress("DEPRECATION") // API 24+ uses the non-deprecated overload
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
        return handleUrl(url)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        return handleUrl(request.url.toString())
    }

    private fun handleUrl(url: String): Boolean {
        // Allow the initial creative load
        if (url == webView.url) return false

        // Route clickthroughs through SHARC onNavigation
        sharcContainer.onNavigation?.invoke(
            mapOf("url" to url, "target" to "clickthrough")
        )
        return true // cancel WebView navigation; SHARC handles it
    }
}
```

### MessageChannel on Android

`MessageChannel` is natively available in Android's WebView (based on Chromium 74+, available since API 21 / Android 5.0 Lollipop). No `JavascriptInterface` bridge or custom IPC is needed.

**Minimum API level:** 21 for `MessageChannel`. This is the same floor as SHARC's baseline Android support. If you need to support API 19–20, the SHARC SDK's `postMessage` fallback with sessionId filtering is available — set `sharcContainer.allowMessageChannelFallback = true`.

---

## 3. Shared Guidance

### 3.1 `initChannel()` Timing

`initChannel()` must be called after the WebView's page-load-complete event, not immediately after `loadUrl` / `loadRequest`. The creative must have its bootstrap `window.addEventListener('message', ...)` listener registered before the container transfers port2 — if the container sends the handshake before the creative's JavaScript has executed, the `message` event is missed and the session never starts.

**iOS — call after `webView(_:didFinish:)`:**

```swift
extension SHARCAdViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Creative HTML has fully loaded and its JS is running
        sharcContainer.initChannel()
    }
}
```

**Android — call after `onPageFinished`:**

```kotlin
inner class SHARCWebViewClient : WebViewClient() {
    override fun onPageFinished(view: WebView, url: String) {
        // Page load complete — creative JS is running
        sharcContainer.initChannel()
    }
}
```

The SHARC SDK imposes a `createSession` timeout (default 5 seconds) starting from when the channel is initialized. If the creative does not send `createSession` within that window, the container terminates the session with error 2212 and calls `onError`. You can tune this timeout via `sharcContainer.timeouts.createSession`.

### 3.2 Security Model for Native WebViews

The web reference implementation uses `sandbox="allow-scripts"` on the creative iframe, explicitly omitting `allow-same-origin`. The same isolation goal applies on native platforms through a different mechanism.

On iOS and Android, the creative runs at a `null` or `file://` origin by default (when loaded via `loadHTMLString:baseURL:nil` or `loadData` without a base URL). This achieves equivalent cross-origin isolation without a sandbox attribute:

- The creative cannot reach `window.parent` or `window.top` — there is no parent frame.
- JavaScript from the creative cannot read cookies, localStorage, or IndexedDB belonging to the publisher's domain.
- All SHARC communication flows through the private `MessageChannel` port transferred at handshake time.

**Do not grant the creative WebView access to the publisher domain's cookies, local storage, or any shared data storage.** Use a separate `WKWebsiteDataStore` on iOS, or disable `allowFileAccessFromFileURLs` and keep `javaScriptEnabled` as the only enabled setting on Android.

The bootstrap `postMessage` uses `targetOrigin: '*'` — this is intentional. The bootstrap carries only the `MessagePort`, not sensitive data. All subsequent SHARC communication flows through the private port and is never broadcast. See [architecture-design.md §5](./architecture-design.md#5-origin-validation-and-security) for the full rationale.

---

## 4. Pre-flight Checklist

Before shipping a native SHARC integration, verify each item:

- [ ] **JavaScript enabled** — `webView.settings.javaScriptEnabled = true` (Android) or default WKWebView config (iOS). Without this, SHARC cannot run.
- [ ] **`initChannel()` called after page-load-complete** — wired to `webView(_:didFinish:)` on iOS or `onPageFinished` on Android. Calling it before the creative's JS has executed causes the session to time out.
- [ ] **`applicationDidBecomeActive` / `onResume` wired** — if this is missing, creatives never receive `active` and may remain in `ready` state indefinitely.
- [ ] **`applicationDidEnterBackground` / `onStop` wired** — creatives must receive `hidden` to pause activity and release resources.
- [ ] **`webViewWebContentProcessDidTerminate` / `onRenderProcessGone` handled** — without this, iOS/Android process kills leave your container in a corrupt state.
- [ ] **Navigation delegate set** — `WKNavigationDelegate` (iOS) or `WebViewClient.shouldOverrideUrlLoading` (Android) must be in place before the creative loads. Clickthroughs and deep links fail silently without it.
- [ ] **`allowsInlineMediaPlayback = true`** (iOS) — without this, video ads force fullscreen, breaking the container layout.
- [ ] **Separate data store for creative WebView** — creative WebView must not share cookies or localStorage with the publisher-side WebView (`WKWebsiteDataStore.nonPersistent()` on iOS; keep `allowFileAccessFromFileURLs = false` on Android).
