# SHARC Test Creative Authoring Guide

> ⚠️ **WARNING**: The patterns documented here are SHARC **test harness conventions only**.
> Do NOT copy them into production MRAID or SafeFrame creatives.

---

## 1. Why HTML Creatives Are Split into `.html` + `.js`

SHARC test creatives use a two-file convention:

| File | Purpose |
|------|---------|
| `test-mraid-creative.html` | DOM structure and styles only (no `<script>` tags) |
| `test-mraid-creative.js` | All JavaScript logic |
| `test-safeframe-creative.html` | DOM structure and styles only (no `<script>` tags) |
| `test-safeframe-creative.js` | All JavaScript logic |

**Why the split?** SHARC's wrapper pages (`mraid-wrapper.html`, `safeframe-wrapper.html`) run
inside sandboxed iframes with `allow-scripts` only (no `allow-same-origin`). This gives them
`origin: null`, which means:

- `fetch()` is **blocked** — XHR sync works instead.
- `window.parent.*` access throws `SecurityError`.
- A nested iframe would inherit the sandbox and **lose** `allow-scripts`.

To load an HTML creative, the wrapper:
1. Uses synchronous XHR to fetch the `.html` file.
2. Injects the parsed `<body>` DOM directly into its own document.
3. Loads the companion `.js` file via `<script src>` (works from null-origin).
4. After the script loads, calls `window.__SHARC_TEST_*Init()` to initialise the creative.

Keeping scripts out of the `.html` file avoids the complexity of re-executing inline
`<script>` tags after `innerHTML` injection (browsers do not re-execute them).

---

## 2. The `__SHARC_TEST_*Init` Callback Contract

Each creative `.js` file exposes a single init function on `window`:

```javascript
// test-mraid-creative.js
window.__SHARC_TEST_mraidCreativeInit = function init() {
  // DOM is ready; window.mraid is already available.
  // Set up event listeners, render state, etc.
};

// test-safeframe-creative.js
window.__SHARC_TEST_sfCreativeInit = function init() {
  // DOM is ready; window.$sf is already available.
  // Call $sf.ext.register(...) and bind UI handlers.
};
```

### Contract guarantees (provided by the wrapper before calling init)

| Guarantee | MRAID | SafeFrame |
|-----------|-------|-----------|
| All injected DOM elements exist | ✓ | ✓ |
| Bridge object is on `window` | `window.mraid` | `window.$sf.ext` |
| Companion `.js` file has finished parsing | ✓ | ✓ |
| `window.parent` is NOT accessible | ✓ (SecurityError) | ✓ (SecurityError) |

### Why a named init callback instead of a top-level IIFE?

An immediately-invoked function expression (IIFE) at the top level of the `.js` file would
run before the DOM is injected (because the script tag is appended **after** `innerHTML`
assignment, but before the browser has finished rendering). The explicit callback lets the
wrapper control exactly when init runs — after a `setTimeout(0)` tick that allows DOM parsing
to complete.

---

## 3. Real Production Creatives vs. SHARC Test Creatives

### Real MRAID Creative

A production MRAID creative is a **self-contained HTML file** loaded directly by the SDK's
container `webview`. It does **not** use any `__SHARC_TEST_*Init` pattern.

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <!-- The SDK injects window.mraid before this page loads -->
</head>
<body>
  <div id="ad"><!-- creative content --></div>
  <script>
    // Standard MRAID bootstrap — no init callback needed
    (function () {
      if (mraid.getState() === 'loading') {
        mraid.addEventListener('ready', onReady);
      } else {
        onReady();
      }

      function onReady() {
        // Creative logic here
      }
    }());
  </script>
</body>
</html>
```

Key differences from SHARC test creatives:

- The entire creative lives in **one `.html` file** — no companion `.js` split.
- `window.mraid` is provided by the **native SDK webview**, not a JS bridge.
- No `__SHARC_TEST_mraidCreativeInit` function — init happens inline via IIFE or the `ready` event.
- The creative is loaded as a proper first-class document origin, not injected via XHR.

### Real SafeFrame Creative

A production SafeFrame creative is similarly a **self-contained HTML file**, served in a
cross-origin iframe by the publisher's SafeFrame host. It uses `window.$sf.ext` directly:

```html
<!doctype html>
<html>
<body>
  <div id="ad"><!-- creative content --></div>
  <script>
    // $sf.ext is provided by the SafeFrame host before the creative loads
    $sf.ext.register(300, 250, function onMsg(status, data) {
      // Handle geom-update, expanded, collapsed, etc.
    });
  </script>
</body>
</html>
```

Key differences from SHARC test creatives:

- One self-contained `.html` file — no `.js` companion split.
- `$sf.ext` is injected by the **SafeFrame host container**, not by SHARC.
- No `__SHARC_TEST_sfCreativeInit` callback — `$sf.ext.register()` is called inline.

---

## 4. ⚠️ Do NOT Copy Test Patterns Into Production

The following patterns are **SHARC test harness internals** and must not appear in
production creative code:

| Anti-pattern | Why it's wrong |
|---|---|
| `window.__SHARC_TEST_mraidCreativeInit = function ...` | No production SDK calls this. The creative would never initialise. |
| `window.__SHARC_TEST_sfCreativeInit = function ...` | Same — no production SafeFrame host calls this. |
| Splitting creative logic across `.html` + `.js` companion files | Not a MRAID/SafeFrame standard. Publishers expect one self-contained HTML file. |
| Relying on XHR-injected DOM + `setTimeout` for init timing | An artefact of the null-origin sandbox. Real webviews load the document normally. |

### The only safe pattern for production

Write a single, self-contained HTML file that uses the standard MRAID/SafeFrame bootstrap
patterns documented in the [IAB MRAID 3.0 spec](https://www.iab.com/guidelines/mraid/) and
[IAB SafeFrame spec](https://www.iab.com/guidelines/safeframe/).

---

*This file documents SHARC test harness internals. It is not a guide to writing production
MRAID or SafeFrame creatives.*
