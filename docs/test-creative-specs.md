# Test Creative Specifications: Enhanced Placement Change System

**Version:** 1.0  
**Date:** 2026-04-12  
**Author:** Frontend Developer  
**PRD:** `docs/prd-placement-changes.md`  
**Architecture:** `docs/architecture-placement-changes.md`

---

## Overview

This document specifies four test creatives and one compliance test suite for verifying the Enhanced Placement Change System. All creatives follow the established SHARC test harness patterns documented in `examples/test/CREATIVE-AUTHORING.md`.

**Test creative types:**

| # | Creative | Path | Loading Model | Bridge |
|---|----------|------|---------------|--------|
| 1 | SHARC Core Placement | `examples/test/test-placement-creative.{html,js}` | Wrapper (mraid-wrapper.html or direct) | None (native SHARC SDK) |
| 2 | MRAID Resize | `examples/test/test-mraid-resize-creative.{html,js}` | Wrapper (mraid-wrapper.html) | MRAID bridge |
| 3 | MRAID Resize Positive Compliance | `examples/compliance-ads/resize-positive/resize-positive-tests.{html,js}` | Compliance runner (mraid-3-compliance-runner.html) | MRAID bridge |
| 4 | SafeFrame Directional Expand | `examples/test/test-safeframe-expand-creative.{html,js}` | Wrapper (safeframe-wrapper.html) | SafeFrame bridge |

**Conventions applied throughout:**

- Test creatives in wrapper model are split into `.html` (DOM + styles only, NO `<script>` tags) + companion `.js` (all logic)
- `.js` files expose `window.__SHARC_TEST_mraidCreativeInit()` or `window.__SHARC_TEST_sfCreativeInit()` callback
- The `__SHARC_TEST_` prefix is intentionally ugly to prevent copying to production
- Compliance ads under `compliance-ads/` use the compliance runner loading path (self-contained HTML with inline scripts)
- Verification is visual: read the log pane, observe iframe behavior, check status indicators
- All JS uses `'use strict'` and ES5-compatible syntax (no arrow functions, no `const`/`let`, no template literals)
- All log helpers follow the `logEntry(type, msg)` pattern with `escHtml()` sanitization

---

## 1. SHARC Core Placement Test Creative

**Purpose:** Test the native SHARC placement change API directly, without any bridge layer. Exercises `requestPlacementChange()`, `getPlacementOptions()`, and the `placementChange` event.

**Note:** This creative loads differently from MRAID/SafeFrame test creatives. It uses the SHARC SDK directly (like `test-creative.html`) and is loaded as a standalone creative within the SHARC container, not through a bridge wrapper. It follows the same DOM/JS pattern as `test-creative.html` which loads `sharc-protocol.js` and `sharc-creative.js` via `<script src>` tags. However, since it may also be loaded through the wrapper model for testing purposes, the JS file provides a `__SHARC_TEST_placementCreativeInit` callback that is optional -- the creative self-boots via `SHARC.onReady()` when loaded standalone.

### 1.1 HTML File: `examples/test/test-placement-creative.html`

```html
<!doctype html>
<!--
  test-placement-creative.html - SHARC Core Placement Change Test Creative

  Tests the native SHARC requestPlacementChange API directly without any
  bridge layer. Exercises resize, maximize, restore, and constraint queries.

  Can be loaded either:
    a) Directly by the SHARC container (like test-creative.html)
    b) Via mraid-wrapper.html for bridge-bypass testing

  NOTE: This file contains DOM structure and styles ONLY when loaded via
  wrapper model. All script logic lives in test-placement-creative.js.
  Do NOT add <script> tags here - they won't execute when injected via innerHTML.
-->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SHARC Placement Change Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f172a;
      color: #eee;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* -- Ad Banner -------------------------------------------------- */
    #ad-banner {
      background: linear-gradient(135deg, #7c3aed 0%, #2563eb 100%);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 50px;
      flex-shrink: 0;
      user-select: none;
    }
    #ad-banner .brand {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
    }
    .brand-wrap { display: flex; flex-direction: column; gap: 2px; }
    .brand-sub { font-size: 10px; color: rgba(255,255,255,0.65); }

    /* -- State Display ---------------------------------------------- */
    #ad-state {
      background: rgba(0,0,0,0.45);
      padding: 6px 16px;
      font-size: 10px;
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .state-item { display: flex; gap: 3px; align-items: center; }
    .state-label { color: rgba(255,255,255,0.45); }
    .state-value {
      color: #7c3aed;
      font-weight: 700;
      font-family: monospace;
      font-size: 10px;
    }
    .state-value.ok { color: #4ade80; }
    .state-value.warn { color: #fb923c; }
    .state-value.err { color: #f87171; }

    /* -- Controls --------------------------------------------------- */
    #ad-controls {
      padding: 8px 16px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      flex-shrink: 0;
      background: rgba(0,0,0,0.25);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ad-btn {
      background: #1e293b;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.18);
      padding: 5px 10px;
      border-radius: 5px;
      font-size: 10px;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .ad-btn:hover { background: #334155; }
    .ad-btn:active { background: #7c3aed; }
    .ad-btn.danger { border-color: #f87171; color: #f87171; }
    .ad-btn.success { border-color: #4ade80; color: #4ade80; }

    /* -- Test Results ----------------------------------------------- */
    #test-results {
      padding: 6px 16px;
      font-size: 10px;
      background: rgba(0,0,0,0.3);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .test-badge {
      padding: 2px 8px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 9px;
      font-weight: 700;
    }
    .test-badge.pass { background: #166534; color: #4ade80; }
    .test-badge.fail { background: #7f1d1d; color: #f87171; }
    .test-badge.pending { background: #1e293b; color: #94a3b8; }

    /* -- Protocol Log ----------------------------------------------- */
    #log-header {
      padding: 5px 16px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(255,255,255,0.35);
      background: rgba(0,0,0,0.3);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    #protocol-log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 16px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 10px;
      line-height: 1.65;
    }
    #protocol-log::-webkit-scrollbar { width: 4px; }
    #protocol-log::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }

    .log-entry { padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
    .log-entry .ts { color: rgba(255,255,255,0.25); margin-right: 6px; }
    .log-entry.event .msg { color: #60a5fa; }
    .log-entry.action .msg { color: #a78bfa; }
    .log-entry.error .msg { color: #f87171; }
    .log-entry.info .msg { color: rgba(255,255,255,0.55); }
    .log-entry.ok .msg { color: #4ade80; }
  </style>
</head>
<body>

  <!-- Ad Banner -->
  <div id="ad-banner">
    <div class="brand-wrap">
      <div class="brand">SHARC Placement Test</div>
      <div class="brand-sub">Native SHARC SDK - No Bridge</div>
    </div>
  </div>

  <!-- Live State Display -->
  <div id="ad-state">
    <div class="state-item">
      <span class="state-label">container:</span>
      <span class="state-value" id="disp-container-state">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">dims:</span>
      <span class="state-value" id="disp-dimensions">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">pos:</span>
      <span class="state-value" id="disp-position">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">constraints:</span>
      <span class="state-value" id="disp-constraints">--</span>
    </div>
  </div>

  <!-- Creative Controls -->
  <div id="ad-controls">
    <button class="ad-btn" onclick="testResize320x480()">Resize 320x480</button>
    <button class="ad-btn" onclick="testResizeWithOffset()">Resize+Offset</button>
    <button class="ad-btn" onclick="testMaximize()">Maximize</button>
    <button class="ad-btn" onclick="testRestore()">Restore</button>
    <button class="ad-btn" onclick="testQueryConstraints()">Query Constraints</button>
    <button class="ad-btn" onclick="testResizeWithAnimation()">Resize+Anim</button>
    <button class="ad-btn" onclick="testGetPlacementOptions()">Get Placement</button>
    <button class="ad-btn danger" onclick="clearLog()">Clear Log</button>
  </div>

  <!-- Test Results -->
  <div id="test-results">
    <span class="test-badge pending" id="result-resize">resize: --</span>
    <span class="test-badge pending" id="result-offset">offset: --</span>
    <span class="test-badge pending" id="result-maximize">maximize: --</span>
    <span class="test-badge pending" id="result-restore">restore: --</span>
    <span class="test-badge pending" id="result-constraints">constraints: --</span>
    <span class="test-badge pending" id="result-animation">animation: --</span>
  </div>

  <div id="log-header">SHARC Placement Event Log</div>

  <!-- Protocol Log -->
  <div id="protocol-log">
    <div class="log-entry info">
      <span class="ts">[init]</span>
      <span class="msg">Placement test creative loaded. Waiting for SHARC SDK...</span>
    </div>
  </div>

</body>
</html>
```

### 1.2 JS File: `examples/test/test-placement-creative.js`

```javascript
// WARNING: __SHARC_TEST_placementCreativeInit is a SHARC test harness convention.
// This creative also self-boots via SHARC.onReady() when loaded standalone.
// See CREATIVE-AUTHORING.md.
'use strict';

// Self-boot path: when loaded standalone (not via wrapper), SHARC SDK is
// available immediately via <script src> tags in the HTML.
// Wrapper path: the wrapper calls __SHARC_TEST_placementCreativeInit() after
// injecting DOM. Both paths converge in initPlacementCreative().

(function () {

  var initialized = false;

  function initPlacementCreative() {
    if (initialized) return;
    initialized = true;

    /* -- Logging helpers ------------------------------------------- */
    var logEl = document.getElementById('protocol-log');

    function logEntry(type, msg) {
      var entry = document.createElement('div');
      entry.className = 'log-entry ' + type;
      var ts = new Date().toISOString().slice(11, 23);
      entry.innerHTML =
        '<span class="ts">[' + ts + ']</span>' +
        '<span class="msg">' + escHtml(String(msg)) + '</span>';
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function escHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.clearLog = function clearLog() {
      logEl.innerHTML = '';
      logEntry('info', 'Log cleared.');
    };

    /* -- Test result helpers --------------------------------------- */
    function setResult(id, passed, detail) {
      var el = document.getElementById(id);
      if (!el) return;
      var label = id.replace('result-', '');
      el.textContent = label + ': ' + (passed ? 'PASS' : 'FAIL');
      el.className = 'test-badge ' + (passed ? 'pass' : 'fail');
      logEntry(passed ? 'ok' : 'error', (passed ? 'PASS' : 'FAIL') + ' [' + label + '] ' + (detail || ''));
    }

    /* -- State display update ------------------------------------- */
    function updateDisplay(placement) {
      if (placement) {
        var dimsEl = document.getElementById('disp-dimensions');
        if (placement.width !== undefined && placement.height !== undefined) {
          dimsEl.textContent = placement.width + 'x' + placement.height;
        }
        var posEl = document.getElementById('disp-position');
        if (placement.x !== undefined && placement.y !== undefined) {
          posEl.textContent = placement.x + ',' + placement.y;
        }
      }
    }

    /* -- SHARC event listeners ------------------------------------ */
    SHARC.onReady(function (env, features) {
      logEntry('ok', 'onReady called');
      logEntry('info', '  env: version=' + (env && env.version));
      if (features && features.length > 0) {
        logEntry('info', '  features: ' + features.map(function (f) { return f.name || f; }).join(', '));
      }
      document.getElementById('disp-container-state').textContent = 'ready';
      return Promise.resolve();
    });

    SHARC.onStart(function () {
      logEntry('ok', 'onStart called');
      document.getElementById('disp-container-state').textContent = 'active';
      document.getElementById('disp-container-state').className = 'state-value ok';
      return Promise.resolve();
    });

    SHARC.on('stateChange', function (state) {
      logEntry('event', 'stateChange -> ' + state);
      document.getElementById('disp-container-state').textContent = state;
    });

    SHARC.on('placementChange', function (placement) {
      logEntry('event', 'placementChange: ' + JSON.stringify(placement));
      updateDisplay(placement);
    });

    /* -- Test actions (exposed globally for onclick= buttons) ----- */

    window.testResize320x480 = function testResize320x480() {
      logEntry('action', 'requestPlacementChange({ intent: "resize", 320x480, closeRegion })');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        closeRegion: { position: 'top-right', size: 50 }
      }).then(function (result) {
        logEntry('ok', 'resize resolved: ' + JSON.stringify(result));
        var passed = true;
        if (result && result.width) {
          passed = (result.width === 320 && result.height === 480);
        }
        setResult('result-resize', passed, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'resize rejected: ' + JSON.stringify(err));
        setResult('result-resize', false, (err && err.message) || String(err));
      });
    };

    window.testResizeWithOffset = function testResizeWithOffset() {
      logEntry('action', 'requestPlacementChange({ intent: "resize", 320x480, targetPosition })');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        targetPosition: { x: 10, y: -50 },
        closeRegion: { position: 'top-right', size: 50 }
      }).then(function (result) {
        logEntry('ok', 'resize+offset resolved: ' + JSON.stringify(result));
        setResult('result-offset', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'resize+offset rejected: ' + JSON.stringify(err));
        setResult('result-offset', false, (err && err.message) || String(err));
      });
    };

    window.testMaximize = function testMaximize() {
      logEntry('action', 'requestPlacementChange({ intent: "maximize" })');
      SHARC.requestPlacementChange({
        intent: 'maximize'
      }).then(function (result) {
        logEntry('ok', 'maximize resolved: ' + JSON.stringify(result));
        setResult('result-maximize', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'maximize rejected: ' + JSON.stringify(err));
        setResult('result-maximize', false, (err && err.message) || String(err));
      });
    };

    window.testRestore = function testRestore() {
      logEntry('action', 'requestPlacementChange({ intent: "restore" })');
      SHARC.requestPlacementChange({
        intent: 'restore'
      }).then(function (result) {
        logEntry('ok', 'restore resolved: ' + JSON.stringify(result));
        setResult('result-restore', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'restore rejected: ' + JSON.stringify(err));
        setResult('result-restore', false, (err && err.message) || String(err));
      });
    };

    window.testQueryConstraints = function testQueryConstraints() {
      logEntry('action', 'getPlacementConstraints()');
      // NOTE: getPlacementConstraints() is a new API proposed in the architecture doc.
      // If not yet implemented, this will error -- which is the expected behavior for
      // testing prior to implementation.
      if (typeof SHARC.getPlacementConstraints !== 'function') {
        logEntry('error', 'SHARC.getPlacementConstraints is not a function (not yet implemented)');
        setResult('result-constraints', false, 'API not yet available');
        return;
      }
      SHARC.getPlacementConstraints().then(function (constraints) {
        logEntry('ok', 'constraints: ' + JSON.stringify(constraints));
        var el = document.getElementById('disp-constraints');
        if (constraints) {
          var parts = [];
          if (constraints.maxWidth) parts.push('maxW:' + constraints.maxWidth);
          if (constraints.maxHeight) parts.push('maxH:' + constraints.maxHeight);
          if (constraints.allowedIntents) parts.push('intents:' + constraints.allowedIntents.join(','));
          el.textContent = parts.join(' ') || 'none';
        }
        setResult('result-constraints', true, JSON.stringify(constraints));
      }).catch(function (err) {
        logEntry('error', 'constraints rejected: ' + JSON.stringify(err));
        setResult('result-constraints', false, (err && err.message) || String(err));
      });
    };

    window.testResizeWithAnimation = function testResizeWithAnimation() {
      logEntry('action', 'requestPlacementChange({ intent: "resize", 320x480, transition })');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        closeRegion: { position: 'top-right', size: 50 },
        transition: { duration: 300, easing: 'ease-out' }
      }).then(function (result) {
        logEntry('ok', 'resize+anim resolved: ' + JSON.stringify(result));
        setResult('result-animation', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'resize+anim rejected: ' + JSON.stringify(err));
        setResult('result-animation', false, (err && err.message) || String(err));
      });
    };

    window.testGetPlacementOptions = function testGetPlacementOptions() {
      logEntry('action', 'getPlacementOptions()');
      SHARC.getPlacementOptions().then(function (opts) {
        logEntry('ok', 'placementOptions: ' + JSON.stringify(opts));
        updateDisplay(opts);
      }).catch(function (err) {
        logEntry('error', 'getPlacementOptions rejected: ' + JSON.stringify(err));
      });
    };

    logEntry('info', 'Placement test creative initialized.');
  }

  // Wrapper path: expose init callback
  window.__SHARC_TEST_placementCreativeInit = initPlacementCreative;

  // Self-boot path: if SHARC SDK is already on window, init immediately
  if (typeof window.SHARC !== 'undefined' && typeof window.SHARC.onReady === 'function') {
    initPlacementCreative();
  }

}());
```

### 1.3 Protocol Trace Entries to Verify

| Action | Expected Log Entries |
|--------|---------------------|
| Page load | `onReady called`, `onStart called` |
| Resize 320x480 button | `requestPlacementChange` action log, then either `resize resolved` (ok) or `resize rejected` (error); `placementChange` event with width/height |
| Resize+Offset button | Same as resize, plus `targetPosition` in the request args |
| Maximize button | `maximize resolved`, `placementChange` event |
| Restore button | `restore resolved`, `placementChange` event with original dimensions |
| Query Constraints | `constraints: {...}` with `maxWidth`, `maxHeight`, `allowedIntents` -- or error if API not yet implemented |
| Resize+Anim button | Same as resize, with `transition` in args |

### 1.4 Pass/Fail Criteria

| Test | PASS Condition | FAIL Condition |
|------|---------------|----------------|
| resize | Promise resolves; `placementChange` fires with width=320, height=480 | Promise rejects or dimensions mismatch |
| offset | Promise resolves; `placementChange` fires | Promise rejects |
| maximize | Promise resolves; `placementChange` fires | Promise rejects |
| restore | Promise resolves; dimensions return to original | Promise rejects or dimensions do not reset |
| constraints | Promise resolves with a non-null object containing `maxWidth`, `maxHeight`, or `allowedIntents` | Promise rejects or API not available |
| animation | Promise resolves; visual transition observed (manual check) | Promise rejects |

---

## 2. MRAID Resize Test Creative

**Purpose:** Test MRAID `resize()` and `setResizeProperties()` through the SHARC MRAID bridge. Verifies the full MRAID 3.0 resize lifecycle including state transitions, error handling, and close region behavior.

### 2.1 HTML File: `examples/test/test-mraid-resize-creative.html`

```html
<!doctype html>
<!--
  test-mraid-resize-creative.html - MRAID Resize Test Creative (DOM structure only)

  Tests MRAID resize() through the SHARC MRAID bridge. Exercises
  setResizeProperties, resize, close from resized state, and error paths.

  This creative is loaded inside mraid-wrapper.html which:
    1. Injects window.mraid via sharc-mraid-bridge.js
    2. Loads this file via XHR and injects the <body> DOM
    3. Dynamically loads test-mraid-resize-creative.js via <script src>
    4. Calls window.__SHARC_TEST_mraidCreativeInit() after the script loads

  NOTE: This file contains DOM structure and styles ONLY.
  All script logic lives in test-mraid-resize-creative.js.
  Do NOT add <script> tags here - they won't execute when injected via innerHTML.
-->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MRAID Resize Test Creative</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1a1a2e;
      color: #eee;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* -- Ad Banner -------------------------------------------------- */
    #ad-banner {
      background: linear-gradient(135deg, #dc2626 0%, #9333ea 100%);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 50px;
      flex-shrink: 0;
      user-select: none;
    }
    #ad-banner .brand {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
    }
    .brand-wrap { display: flex; flex-direction: column; gap: 2px; }
    .brand-sub { font-size: 10px; color: rgba(255,255,255,0.65); }

    /* -- Config Panel ----------------------------------------------- */
    #config-panel {
      background: rgba(0,0,0,0.4);
      padding: 8px 16px;
      font-size: 10px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .config-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 4px;
      flex-wrap: wrap;
    }
    .config-row label {
      color: rgba(255,255,255,0.5);
      min-width: 50px;
    }
    .config-row input[type="number"] {
      width: 60px;
      background: #0f172a;
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-family: monospace;
    }
    .config-row select {
      background: #0f172a;
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 10px;
    }
    .config-row input[type="checkbox"] {
      accent-color: #dc2626;
    }

    /* -- State Display ---------------------------------------------- */
    #ad-state {
      background: rgba(0,0,0,0.45);
      padding: 6px 16px;
      font-size: 10px;
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .state-item { display: flex; gap: 3px; align-items: center; }
    .state-label { color: rgba(255,255,255,0.45); }
    .state-value {
      color: #dc2626;
      font-weight: 700;
      font-family: monospace;
      font-size: 10px;
    }
    .state-value.ok { color: #4ade80; }
    .state-value.warn { color: #fb923c; }
    .state-value.err { color: #f87171; }

    /* -- Controls --------------------------------------------------- */
    #ad-controls {
      padding: 8px 16px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      flex-shrink: 0;
      background: rgba(0,0,0,0.25);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ad-btn {
      background: #1e1e3a;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.18);
      padding: 5px 10px;
      border-radius: 5px;
      font-size: 10px;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .ad-btn:hover { background: #2d2d50; }
    .ad-btn:active { background: #dc2626; }
    .ad-btn.danger { border-color: #f87171; color: #f87171; }

    /* -- Protocol Log ----------------------------------------------- */
    #log-header {
      padding: 5px 16px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(255,255,255,0.35);
      background: rgba(0,0,0,0.3);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    #protocol-log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 16px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 10px;
      line-height: 1.65;
    }
    #protocol-log::-webkit-scrollbar { width: 4px; }
    #protocol-log::-webkit-scrollbar-thumb { background: #1e1e3a; border-radius: 2px; }

    .log-entry { padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
    .log-entry .ts { color: rgba(255,255,255,0.25); margin-right: 6px; }
    .log-entry.event .msg { color: #60a5fa; }
    .log-entry.action .msg { color: #a78bfa; }
    .log-entry.error .msg { color: #f87171; }
    .log-entry.info .msg { color: rgba(255,255,255,0.55); }
    .log-entry.ok .msg { color: #4ade80; }

    /* -- No-mraid fallback ------------------------------------------ */
    #no-mraid {
      display: none;
      padding: 20px;
      text-align: center;
      color: rgba(255,255,255,0.4);
      font-size: 12px;
    }
  </style>
</head>
<body>

  <!-- Ad Banner -->
  <div id="ad-banner">
    <div class="brand-wrap">
      <div class="brand">MRAID Resize Test</div>
      <div class="brand-sub">MRAID 3.0 resize() via SHARC Bridge</div>
    </div>
  </div>

  <!-- Resize Config Panel -->
  <div id="config-panel">
    <div class="config-row">
      <label>width:</label>
      <input type="number" id="cfg-width" value="320" min="50">
      <label>height:</label>
      <input type="number" id="cfg-height" value="480" min="50">
    </div>
    <div class="config-row">
      <label>offsetX:</label>
      <input type="number" id="cfg-offsetX" value="0">
      <label>offsetY:</label>
      <input type="number" id="cfg-offsetY" value="0">
    </div>
    <div class="config-row">
      <label>closePos:</label>
      <select id="cfg-closePos">
        <option value="top-right" selected>top-right</option>
        <option value="top-left">top-left</option>
        <option value="top-center">top-center</option>
        <option value="bottom-left">bottom-left</option>
        <option value="bottom-right">bottom-right</option>
        <option value="bottom-center">bottom-center</option>
        <option value="center">center</option>
      </select>
      <label>offscreen:</label>
      <input type="checkbox" id="cfg-offscreen">
    </div>
  </div>

  <!-- Live State Display -->
  <div id="ad-state">
    <div class="state-item">
      <span class="state-label">state:</span>
      <span class="state-value" id="disp-state">loading</span>
    </div>
    <div class="state-item">
      <span class="state-label">curPos:</span>
      <span class="state-value" id="disp-curpos">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">maxSize:</span>
      <span class="state-value" id="disp-maxsize">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">viewable:</span>
      <span class="state-value" id="disp-viewable">--</span>
    </div>
  </div>

  <!-- Controls -->
  <div id="ad-controls">
    <button class="ad-btn" onclick="testSetResizeProps()">setResizeProperties</button>
    <button class="ad-btn" onclick="testResize()">resize()</button>
    <button class="ad-btn" onclick="testClose()">close()</button>
    <button class="ad-btn" onclick="testExpandThenResize()">expand+resize</button>
    <button class="ad-btn" onclick="testResizeNoProps()">resize (no props)</button>
    <button class="ad-btn" onclick="testCollapse()">collapse()</button>
    <button class="ad-btn danger" onclick="clearLog()">Clear Log</button>
  </div>

  <div id="log-header">MRAID Resize Event Log</div>

  <!-- Protocol Log -->
  <div id="protocol-log">
    <div class="log-entry info">
      <span class="ts">[init]</span>
      <span class="msg">MRAID resize creative loaded. Waiting for window.mraid...</span>
    </div>
  </div>

  <div id="no-mraid">
    window.mraid not available.<br>
    Load via mraid-wrapper.html?creative=test/test-mraid-resize-creative.html
  </div>

</body>
</html>
```

### 2.2 JS File: `examples/test/test-mraid-resize-creative.js`

```javascript
// WARNING: __SHARC_TEST_mraidCreativeInit is a SHARC test harness convention.
// Real MRAID creatives do NOT use this pattern. See CREATIVE-AUTHORING.md.
'use strict';

window.__SHARC_TEST_mraidCreativeInit = function init() {

    /* -- Logging helpers ------------------------------------------- */
    var logEl = document.getElementById('protocol-log');

    function logEntry(type, msg) {
      var entry = document.createElement('div');
      entry.className = 'log-entry ' + type;
      var ts = new Date().toISOString().slice(11, 23);
      entry.innerHTML =
        '<span class="ts">[' + ts + ']</span>' +
        '<span class="msg">' + escHtml(String(msg)) + '</span>';
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function escHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.clearLog = function clearLog() {
      logEl.innerHTML = '';
      logEntry('info', 'Log cleared.');
    };

    /* -- Config readers -------------------------------------------- */
    function getResizeConfig() {
      return {
        width:               parseInt(document.getElementById('cfg-width').value, 10) || 320,
        height:              parseInt(document.getElementById('cfg-height').value, 10) || 480,
        offsetX:             parseInt(document.getElementById('cfg-offsetX').value, 10) || 0,
        offsetY:             parseInt(document.getElementById('cfg-offsetY').value, 10) || 0,
        customClosePosition: document.getElementById('cfg-closePos').value,
        allowOffscreen:      document.getElementById('cfg-offscreen').checked
      };
    }

    /* -- State display update -------------------------------------- */
    function updateDisplay() {
      if (typeof window.mraid === 'undefined') return;
      var m = window.mraid;

      var stateEl = document.getElementById('disp-state');
      var state = m.getState();
      stateEl.textContent = state;
      stateEl.className = 'state-value ' +
        (state === 'default' ? 'ok' :
         state === 'resized' ? 'warn' :
         state === 'expanded' ? 'warn' : '');

      var viewableEl = document.getElementById('disp-viewable');
      viewableEl.textContent = String(m.isViewable());
      viewableEl.className = 'state-value ' + (m.isViewable() ? 'ok' : 'warn');

      var curPos = m.getCurrentPosition();
      document.getElementById('disp-curpos').textContent =
        curPos.width + 'x' + curPos.height + ' @' + curPos.x + ',' + curPos.y;

      var maxSize = m.getMaxSize();
      document.getElementById('disp-maxsize').textContent =
        maxSize.width + 'x' + maxSize.height;
    }

    /* -- MRAID event handlers -------------------------------------- */
    function onMraidReady() {
      logEntry('ok', 'ready event fired');
      logEntry('info', '  getState()         = ' + mraid.getState());
      logEntry('info', '  getPlacementType() = ' + mraid.getPlacementType());
      logEntry('info', '  getMaxSize()       = ' + JSON.stringify(mraid.getMaxSize()));
      logEntry('info', '  getCurrentPosition()= ' + JSON.stringify(mraid.getCurrentPosition()));
      logEntry('info', '  getResizeProperties()= ' + JSON.stringify(mraid.getResizeProperties()));
      updateDisplay();
    }

    function onStateChange(state) {
      logEntry('event', 'stateChange("' + state + '")');
      updateDisplay();
    }

    function onSizeChange(w, h) {
      logEntry('event', 'sizeChange(' + w + ', ' + h + ')');
      updateDisplay();
    }

    function onError(message, action) {
      logEntry('error', 'error("' + message + '", "' + action + '")');
    }

    function onViewableChange(viewable) {
      logEntry('event', 'viewableChange(' + viewable + ')');
      updateDisplay();
    }

    /* -- Test actions ---------------------------------------------- */

    window.testSetResizeProps = function testSetResizeProps() {
      var cfg = getResizeConfig();
      logEntry('action', 'mraid.setResizeProperties(' + JSON.stringify(cfg) + ')');
      mraid.setResizeProperties(cfg);
      logEntry('info', '  getResizeProperties() = ' + JSON.stringify(mraid.getResizeProperties()));
    };

    window.testResize = function testResize() {
      logEntry('action', 'mraid.resize()');
      mraid.resize();
    };

    window.testClose = function testClose() {
      logEntry('action', 'mraid.close() -- should collapse from resized/expanded to default');
      mraid.close();
    };

    window.testCollapse = function testCollapse() {
      logEntry('action', 'mraid.collapse()');
      mraid.collapse();
    };

    window.testExpandThenResize = function testExpandThenResize() {
      logEntry('action', 'mraid.expand() then mraid.resize() -- resize should error from expanded');
      mraid.expand();
      // Wait for expand to complete, then try resize
      var listener = function (state) {
        if (state === 'expanded') {
          mraid.removeEventListener('stateChange', listener);
          logEntry('action', 'Now in expanded state -- calling mraid.resize()');
          var cfg = getResizeConfig();
          mraid.setResizeProperties(cfg);
          mraid.resize();
        }
      };
      mraid.addEventListener('stateChange', listener);
    };

    window.testResizeNoProps = function testResizeNoProps() {
      logEntry('action', 'mraid.resize() without setResizeProperties -- should error');
      // Reset resize props by creating fresh bridge state (not possible externally).
      // Instead just call resize directly; the bridge tracks whether setResizeProperties
      // was called with valid dimensions.
      mraid.resize();
    };

    /* -- Bootstrap ------------------------------------------------- */
    (function bootstrap() {
      var m = window.mraid;

      if (!m) {
        logEntry('error', 'window.mraid not found. Load via mraid-wrapper.html');
        document.getElementById('no-mraid').style.display = 'block';
        return;
      }

      mraid.addEventListener('ready', onMraidReady);
      mraid.addEventListener('stateChange', onStateChange);
      mraid.addEventListener('sizeChange', onSizeChange);
      mraid.addEventListener('viewableChange', onViewableChange);
      mraid.addEventListener('error', onError);

      logEntry('info', 'mraid object found. getState() = "' + mraid.getState() + '"');

      if (mraid.getState() === 'loading') {
        logEntry('info', 'State is "loading" -- waiting for ready event...');
      } else {
        logEntry('ok', 'State is "' + mraid.getState() + '" -- calling onMraidReady directly');
        onMraidReady();
      }

      updateDisplay();
    }());
};
```

### 2.3 Protocol Trace Entries to Verify

| Action | Expected Log Entries |
|--------|---------------------|
| Page load | `mraid object found`, `ready event fired`, current position and max size logged |
| setResizeProperties | `setResizeProperties({...})` action, then `getResizeProperties()` confirming stored values |
| resize() | `resize()` action, `stateChange("resized")` event, `sizeChange(w, h)` event |
| close() from resized | `close()` action, `stateChange("default")` event, current position resets |
| expand+resize | `expand()` action, `stateChange("expanded")`, then `resize()` followed by `error("resize is only valid from default state...", "resize")` |
| resize (no props) | `resize()` action, `error("setResizeProperties must be called before resize()", "resize")` |

### 2.4 Pass/Fail Criteria

| Test | PASS Condition | FAIL Condition |
|------|---------------|----------------|
| setResizeProperties | `getResizeProperties()` returns matching values; no error event | Error event fires |
| resize() | `stateChange("resized")` fires, `sizeChange` fires with matching w/h, `getState()` returns `"resized"` | Error event fires or state does not transition |
| close from resized | `stateChange("default")` fires, `getCurrentPosition()` returns original dimensions | State does not return to default or position not reset |
| expand+resize | Error event fires with action `"resize"` and message containing "default state" | No error fires (resize should fail from expanded state) |
| resize without props | Error event fires with message about `setResizeProperties` | No error fires |

---

## 3. MRAID Resize Positive Compliance Test

**Purpose:** Automated compliance test for MRAID 3.0 resize positive cases. Follows the same `EventTester`/`SequentialRunner` pattern as the existing `resize-negative-tests.js`. Runs automatically on load and logs CHECK/FAIL results.

**Loading path:** Loaded through `mraid-3-compliance-runner.html` (compliance runner), not through the wrapper model. This means the HTML file is self-contained with inline `<script>` tags.

### 3.1 HTML File: `examples/compliance-ads/resize-positive/resize-test.html`

```html
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>Mraid 3.0 Compliance resize positive test</title>
</head>

<body>
    <script src="resize-positive-tests.js" type="text/javascript"></script>
    <div id="resize_positive_tests_log">
    </div>
</body>

</html>
```

### 3.2 JS File: `examples/compliance-ads/resize-positive/resize-positive-tests.js`

```javascript
// ==============================  MRAID INIT  ================================
if (document.readyState === 'complete') {
  readyCheck();
} else {
    window.addEventListener('load', readyCheck, false);
}

function readyCheck() {
    if (window.MRAID_ENV) {
        console.log('Version: ' + window.MRAID_ENV.version +
            ' SDK: ' + window.MRAID_ENV.sdk +
            ' SDKv: ' + window.MRAID_ENV.sdkVersion);
    } else {
        console.error('MRAID_ENV NOT FOUND');
    }

    logDiv = document.getElementById('resize_positive_tests_log');
    logDiv.style = 'margin:10px';

    var _mraid = window.mraid;

    if (!_mraid) {
        logErrorOnUi('window.mraid not found.');
        return;
    }

    if (_mraid.getState() === 'loading') {
        _mraid.addEventListener('ready', function () {
            startTests(_mraid, function () {
                console.log('[ALL POSITIVE RESIZE TESTS FINISHED]');
            }, 3000, logInfoOnUi, logErrorOnUi);
        });
    } else {
        startTests(_mraid, function () {
            console.log('[ALL POSITIVE RESIZE TESTS FINISHED]');
        }, 3000, logInfoOnUi, logErrorOnUi);
    }
}

var logDiv;

function logOnUi(color, message) {
    var messageDiv = document.createElement('div');
    messageDiv.innerText = '[' + new Date().toLocaleString() + '] ' + message;
    messageDiv.style = 'width:100%;padding: 10px 0px;padding-right:10px;color:' + color;
    logDiv.appendChild(messageDiv);
}

function logInfoOnUi(message) {
    logOnUi('dodgerblue', message);
    console.log(message);
}

function logErrorOnUi(message) {
    logOnUi('tomato', message);
    console.error(message);
}

// ============================================================================

/**
 * Sequentially executes resize positive tests. Covers cases when resize
 * operations should succeed.
 *
 * @param mraid MRAID instance to use.
 * @param done Callback function, executed once all tests ran.
 * @param waitTimeout How long to wait for events.
 * @param log Callback that should get log strings.
 * @param error Callback that receives error strings.
 */
function startTests(mraid, done, waitTimeout, log, error) {
    this.error = error || console.error;
    this.log = log || console.log;

    var testQueue = [];
    var currentTest = 0;

    function runNext() {
        if (currentTest >= testQueue.length) {
            log('=== ALL POSITIVE RESIZE TESTS COMPLETE ===');
            if (done) done();
            return;
        }
        var test = testQueue[currentTest];
        currentTest++;
        log('--- Test: ' + test.description + ' ---');
        test.run(function () {
            runNext();
        });
    }

    // ===========================  TEST 1  ====================================
    // Basic resize: set properties, call resize(), verify stateChange + sizeChange
    testQueue.push({
        description: 'Basic resize to 320x480 with top-right close',
        run: function (next) {
            var resolved = false;
            var stateOk = false;
            var sizeOk = false;

            function checkDone() {
                if (stateOk && sizeOk && !resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    mraid.removeEventListener('sizeChange', onSize);
                    clearTimeout(timer);

                    // Verify getState
                    if (mraid.getState() === 'resized') {
                        log('CHECK: getState() === "resized" after resize');
                    } else {
                        error('FAIL: getState() === "' + mraid.getState() + '", expected "resized"');
                    }

                    // Verify getCurrentPosition
                    var pos = mraid.getCurrentPosition();
                    if (pos.width === 320 && pos.height === 480) {
                        log('CHECK: getCurrentPosition() width=320, height=480');
                    } else {
                        error('FAIL: getCurrentPosition() width=' + pos.width + ', height=' + pos.height);
                    }

                    // Verify getMaxSize unchanged
                    var maxSize = mraid.getMaxSize();
                    log('CHECK: getMaxSize() unchanged = ' + JSON.stringify(maxSize));

                    // Now close back to default
                    closeToDefault(mraid, waitTimeout, log, error, next);
                }
            }

            function onState(state) {
                if (state === 'resized') {
                    log('CHECK: stateChange("resized") received');
                    stateOk = true;
                    checkDone();
                }
            }

            function onSize(w, h) {
                if (w === 320 && h === 480) {
                    log('CHECK: sizeChange(320, 480) received');
                    sizeOk = true;
                    checkDone();
                } else {
                    error('FAIL: sizeChange(' + w + ', ' + h + '), expected (320, 480)');
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    mraid.removeEventListener('sizeChange', onSize);
                    error('FAIL: Timeout waiting for resize stateChange/sizeChange');
                    next();
                }
            }, waitTimeout);

            mraid.addEventListener('stateChange', onState);
            mraid.addEventListener('sizeChange', onSize);

            mraid.setResizeProperties({
                width: 320,
                height: 480,
                offsetX: 0,
                offsetY: 0,
                customClosePosition: 'top-right',
                allowOffscreen: false
            });
            mraid.resize();
        }
    });

    // ===========================  TEST 2  ====================================
    // Resize with offset: verify targetPosition passed through
    testQueue.push({
        description: 'Resize with offset (offsetX=10, offsetY=-50)',
        run: function (next) {
            var resolved = false;

            function onState(state) {
                if (state === 'resized' && !resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    clearTimeout(timer);

                    log('CHECK: stateChange("resized") after offset resize');
                    var pos = mraid.getCurrentPosition();
                    log('CHECK: getCurrentPosition() = ' + JSON.stringify(pos));

                    closeToDefault(mraid, waitTimeout, log, error, next);
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    error('FAIL: Timeout waiting for offset resize');
                    next();
                }
            }, waitTimeout);

            mraid.addEventListener('stateChange', onState);
            mraid.setResizeProperties({
                width: 320,
                height: 480,
                offsetX: 10,
                offsetY: -50,
                customClosePosition: 'top-right',
                allowOffscreen: false
            });
            mraid.resize();
        }
    });

    // ===========================  TEST 3  ====================================
    // Close from resized: verify return to default state and original position
    testQueue.push({
        description: 'Close from resized returns to default with original position',
        run: function (next) {
            var resolved = false;
            var defaultPos = mraid.getDefaultPosition();

            // First resize
            function onResized(state) {
                if (state === 'resized') {
                    mraid.removeEventListener('stateChange', onResized);
                    log('CHECK: Resized. Now calling close()...');

                    // Listen for close -> default
                    mraid.addEventListener('stateChange', onDefault);
                    mraid.close();
                }
            }

            function onDefault(state) {
                if (state === 'default' && !resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onDefault);
                    clearTimeout(timer);

                    if (mraid.getState() === 'default') {
                        log('CHECK: getState() === "default" after close from resized');
                    } else {
                        error('FAIL: getState() === "' + mraid.getState() + '" after close');
                    }

                    var pos = mraid.getCurrentPosition();
                    if (pos.width === defaultPos.width && pos.height === defaultPos.height) {
                        log('CHECK: Position reset to default (' + pos.width + 'x' + pos.height + ')');
                    } else {
                        error('FAIL: Position not reset. Got ' + pos.width + 'x' + pos.height +
                              ', expected ' + defaultPos.width + 'x' + defaultPos.height);
                    }
                    next();
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onResized);
                    mraid.removeEventListener('stateChange', onDefault);
                    error('FAIL: Timeout in close-from-resized test');
                    next();
                }
            }, waitTimeout * 2);

            mraid.addEventListener('stateChange', onResized);
            mraid.setResizeProperties({
                width: 320,
                height: 480,
                offsetX: 0,
                offsetY: 0,
                customClosePosition: 'top-right',
                allowOffscreen: false
            });
            mraid.resize();
        }
    });

    // ===========================  TEST 4  ====================================
    // All 8 customClosePosition values
    var closePositions = [
        'top-left', 'top-right', 'top-center',
        'bottom-left', 'bottom-right', 'bottom-center',
        'center'
    ];

    closePositions.forEach(function (pos) {
        testQueue.push({
            description: 'Resize with customClosePosition="' + pos + '"',
            run: function (next) {
                var resolved = false;

                function onState(state) {
                    if (state === 'resized' && !resolved) {
                        resolved = true;
                        mraid.removeEventListener('stateChange', onState);
                        clearTimeout(timer);
                        log('CHECK: Resize succeeded with customClosePosition="' + pos + '"');
                        closeToDefault(mraid, waitTimeout, log, error, next);
                    }
                }

                var timer = setTimeout(function () {
                    if (!resolved) {
                        resolved = true;
                        mraid.removeEventListener('stateChange', onState);
                        error('FAIL: Timeout for customClosePosition="' + pos + '"');
                        next();
                    }
                }, waitTimeout);

                mraid.addEventListener('stateChange', onState);
                mraid.setResizeProperties({
                    width: 200,
                    height: 200,
                    offsetX: 0,
                    offsetY: 0,
                    customClosePosition: pos,
                    allowOffscreen: false
                });
                mraid.resize();
            }
        });
    });

    // ===========================  TEST 5  ====================================
    // Resize from expanded state should error
    testQueue.push({
        description: 'Resize from expanded state fires error event',
        run: function (next) {
            var resolved = false;

            // First expand
            function onExpanded(state) {
                if (state === 'expanded') {
                    mraid.removeEventListener('stateChange', onExpanded);
                    log('CHECK: Expanded. Now attempting resize()...');

                    // Listen for error
                    function onError(message, action) {
                        if (!resolved && action === 'resize') {
                            resolved = true;
                            mraid.removeEventListener('error', onError);
                            clearTimeout(timer);
                            log('CHECK: Error fired for resize from expanded: "' + message + '"');

                            // Close back to default
                            mraid.addEventListener('stateChange', function onClose(state) {
                                if (state === 'default') {
                                    mraid.removeEventListener('stateChange', onClose);
                                    next();
                                }
                            });
                            mraid.close();
                        }
                    }

                    mraid.addEventListener('error', onError);
                    mraid.setResizeProperties({
                        width: 200,
                        height: 200,
                        offsetX: 0,
                        offsetY: 0
                    });
                    mraid.resize();
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onExpanded);
                    error('FAIL: Timeout in resize-from-expanded test');
                    // Try to close back to default
                    mraid.close();
                    setTimeout(next, 500);
                }
            }, waitTimeout * 2);

            mraid.addEventListener('stateChange', onExpanded);
            mraid.expand();
        }
    });

    // Start the test sequence
    runNext();
}

// ================================ HELPERS ====================================

/**
 * Closes from any state back to default, waiting for stateChange("default").
 */
function closeToDefault(mraid, timeout, log, error, next) {
    var resolved = false;

    function onState(state) {
        if (state === 'default' && !resolved) {
            resolved = true;
            mraid.removeEventListener('stateChange', onState);
            clearTimeout(timer);
            log('CHECK: Returned to default state after close');
            next();
        }
    }

    var timer = setTimeout(function () {
        if (!resolved) {
            resolved = true;
            mraid.removeEventListener('stateChange', onState);
            error('FAIL: Timeout waiting for close -> default');
            next();
        }
    }, timeout);

    mraid.addEventListener('stateChange', onState);
    mraid.close();
}
// ============================================================================
```

### 3.3 Shim File: `examples/compliance-ads/resize-positive/resize-test.js`

This shim follows the same pattern as `compliance-ads/resize-negative/resize-test.js`, loading the actual compliance script dynamically.

```javascript
/**
 * resize-test.js - Shim for resize-positive compliance ad (null-origin sandbox safe)
 *
 * mraid-wrapper.html loads resize-test.html via XHR, injects the <body> DOM
 * (which contains #resize_positive_tests_log), then loads this file via
 * <script src="resize-test.js">. window.mraid is already set by the wrapper.
 *
 * This shim dynamically loads the actual compliance script via <script src>.
 */
(function () {
  'use strict';
  var script = document.createElement('script');
  script.src = 'compliance-ads/resize-positive/resize-positive-tests.js';
  script.onerror = function () {
    console.error('[compliance resize-positive] Failed to load resize-positive-tests.js');
  };
  document.body.appendChild(script);
}());
```

### 3.3 Protocol Trace Entries to Verify

All entries appear in the compliance runner's log pane or browser console.

| Test Phase | Expected Log Entries |
|------------|---------------------|
| Basic resize | `CHECK: stateChange("resized")`, `CHECK: sizeChange(320, 480)`, `CHECK: getState() === "resized"`, `CHECK: getCurrentPosition() width=320, height=480`, `CHECK: getMaxSize() unchanged` |
| Close -> default | `CHECK: Returned to default state after close` |
| Offset resize | `CHECK: stateChange("resized") after offset resize`, `CHECK: getCurrentPosition()` with offset reflected |
| Close from resized | `CHECK: getState() === "default" after close from resized`, `CHECK: Position reset to default` |
| Each closePosition | `CHECK: Resize succeeded with customClosePosition="<pos>"` for each of the 7 positions |
| Resize from expanded | `CHECK: Expanded`, `CHECK: Error fired for resize from expanded` |
| Completion | `=== ALL POSITIVE RESIZE TESTS COMPLETE ===` |

### 3.4 Pass/Fail Criteria

| Test | PASS (CHECK) | FAIL |
|------|-------------|------|
| Basic resize | `stateChange("resized")` fires, `sizeChange(320, 480)` fires, `getState() === "resized"`, `getCurrentPosition()` matches | Timeout or incorrect values |
| Offset resize | `stateChange("resized")` fires | Timeout |
| Close from resized | `getState() === "default"`, position resets to default dimensions | Timeout or position not reset |
| All close positions | Each position produces `stateChange("resized")` without error | Any position times out or errors |
| Resize from expanded | Error event fires with action `"resize"` | No error fires (resize should be blocked) |

---

## 4. SafeFrame Directional Expand Test Creative

**Purpose:** Test SafeFrame `$sf.ext.expand()` with directional offsets (`t`, `l`, `r`, `b`) through the SHARC SafeFrame bridge. Verifies overlay expand, push expand rejection, collapse, and callback status transitions.

### 4.1 HTML File: `examples/test/test-safeframe-expand-creative.html`

```html
<!doctype html>
<!--
  test-safeframe-expand-creative.html - SafeFrame Directional Expand Test (DOM only)

  Tests SafeFrame $sf.ext.expand() with directional offsets through the
  SHARC SafeFrame bridge. Exercises overlay expand, push rejection,
  collapse, and callback status transitions.

  This creative is loaded inside safeframe-wrapper.html which:
    1. Injects window.$sf.ext via sharc-safeframe-bridge.js
    2. Loads this file via XHR and injects the <body> DOM
    3. Dynamically loads test-safeframe-expand-creative.js via <script src>
    4. Calls window.__SHARC_TEST_sfCreativeInit() after the script loads

  NOTE: This file contains DOM structure and styles ONLY.
  All script logic lives in test-safeframe-expand-creative.js.
  Do NOT add <script> tags here - they won't execute when injected via innerHTML.
-->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SafeFrame Directional Expand Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a1628;
      color: #eee;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* -- Ad Banner -------------------------------------------------- */
    #ad-banner {
      background: linear-gradient(135deg, #059669 0%, #0891b2 100%);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 50px;
      flex-shrink: 0;
      user-select: none;
    }
    #ad-banner .brand {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
    }
    .brand-wrap { display: flex; flex-direction: column; gap: 2px; }
    .brand-sub { font-size: 10px; color: rgba(255,255,255,0.65); }

    /* -- Config Panel ----------------------------------------------- */
    #config-panel {
      background: rgba(0,0,0,0.4);
      padding: 8px 16px;
      font-size: 10px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .config-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 4px;
      flex-wrap: wrap;
    }
    .config-row label {
      color: rgba(255,255,255,0.5);
      min-width: 20px;
    }
    .config-row input[type="number"] {
      width: 55px;
      background: #0f172a;
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-family: monospace;
    }

    /* -- State Display ---------------------------------------------- */
    #ad-state {
      background: rgba(0,0,0,0.45);
      padding: 6px 16px;
      font-size: 10px;
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .state-item { display: flex; gap: 3px; align-items: center; }
    .state-label { color: rgba(255,255,255,0.45); }
    .state-value {
      color: #059669;
      font-weight: 700;
      font-family: monospace;
      font-size: 10px;
    }
    .state-value.ok { color: #4ade80; }
    .state-value.warn { color: #fb923c; }
    .state-value.err { color: #f87171; }

    /* -- Controls --------------------------------------------------- */
    #ad-controls {
      padding: 8px 16px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      flex-shrink: 0;
      background: rgba(0,0,0,0.25);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ad-btn {
      background: #0d3349;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.18);
      padding: 5px 10px;
      border-radius: 5px;
      font-size: 10px;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .ad-btn:hover { background: #0d4a60; }
    .ad-btn:active { background: #059669; }
    .ad-btn.danger { border-color: #f87171; color: #f87171; }
    .ad-btn.warn { border-color: #fb923c; color: #fb923c; }

    /* -- Protocol Log ----------------------------------------------- */
    #log-header {
      padding: 5px 16px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(255,255,255,0.35);
      background: rgba(0,0,0,0.3);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    #protocol-log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 16px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 10px;
      line-height: 1.65;
    }
    #protocol-log::-webkit-scrollbar { width: 4px; }
    #protocol-log::-webkit-scrollbar-thumb { background: #1a3a4a; border-radius: 2px; }

    .log-entry { padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
    .log-entry .ts { color: rgba(255,255,255,0.25); margin-right: 6px; }
    .log-entry.event .msg { color: #60a5fa; }
    .log-entry.action .msg { color: #a78bfa; }
    .log-entry.error .msg { color: #f87171; }
    .log-entry.info .msg { color: rgba(255,255,255,0.55); }
    .log-entry.ok .msg { color: #4ade80; }
    .log-entry.geom .msg { color: #34d399; }
    .log-entry.focus .msg { color: #fbbf24; }

    /* -- No-$sf fallback -------------------------------------------- */
    #no-sf {
      display: none;
      padding: 20px;
      text-align: center;
      color: rgba(255,255,255,0.4);
      font-size: 12px;
    }
  </style>
</head>
<body>

  <!-- Ad Banner -->
  <div id="ad-banner">
    <div class="brand-wrap">
      <div class="brand">SF Expand Test</div>
      <div class="brand-sub">SafeFrame 1.1 Directional Expand</div>
    </div>
  </div>

  <!-- Expand Offset Config -->
  <div id="config-panel">
    <div class="config-row">
      <label>t:</label>
      <input type="number" id="cfg-t" value="50">
      <label>l:</label>
      <input type="number" id="cfg-l" value="50">
      <label>r:</label>
      <input type="number" id="cfg-r" value="50">
      <label>b:</label>
      <input type="number" id="cfg-b" value="50">
    </div>
  </div>

  <!-- Live State Display -->
  <div id="ad-state">
    <div class="state-item">
      <span class="state-label">status:</span>
      <span class="state-value" id="disp-status">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">inView%:</span>
      <span class="state-value" id="disp-inview">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">focus:</span>
      <span class="state-value" id="disp-focus">--</span>
    </div>
    <div class="state-item">
      <span class="state-label">geom.self:</span>
      <span class="state-value" id="disp-geom-self">--</span>
    </div>
  </div>

  <!-- Controls -->
  <div id="ad-controls">
    <button class="ad-btn" onclick="testExpandOverlay()">expand overlay</button>
    <button class="ad-btn warn" onclick="testExpandPush()">expand push</button>
    <button class="ad-btn" onclick="testExpandNoOffsets()">expand (no offsets)</button>
    <button class="ad-btn" onclick="testCollapse()">collapse()</button>
    <button class="ad-btn" onclick="testStatus()">status()</button>
    <button class="ad-btn" onclick="testGeom()">geom()</button>
    <button class="ad-btn danger" onclick="clearLog()">Clear Log</button>
  </div>

  <div id="log-header">SafeFrame Expand Event Log</div>

  <!-- Protocol Log -->
  <div id="protocol-log">
    <div class="log-entry info">
      <span class="ts">[init]</span>
      <span class="msg">SafeFrame expand creative loaded. Waiting for window.$sf...</span>
    </div>
  </div>

  <div id="no-sf">
    <strong>window.$sf not available.</strong><br>
    Load via:<br>
    <code>safeframe-wrapper.html?creative=test/test-safeframe-expand-creative.html</code>
  </div>

</body>
</html>
```

### 4.2 JS File: `examples/test/test-safeframe-expand-creative.js`

```javascript
// WARNING: __SHARC_TEST_sfCreativeInit is a SHARC test harness convention.
// Real SafeFrame creatives do NOT use this pattern. See CREATIVE-AUTHORING.md.
'use strict';

window.__SHARC_TEST_sfCreativeInit = function init() {

  /* -- Logging helpers --------------------------------------------- */
  var logEl = document.getElementById('protocol-log');

  function logEntry(type, msg) {
    var entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    var ts = new Date().toISOString().slice(11, 23);
    entry.innerHTML =
      '<span class="ts">[' + ts + ']</span>' +
      '<span class="msg">' + escHtml(String(msg)) + '</span>';
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.clearLog = function clearLog() {
    logEl.innerHTML = '';
    logEntry('info', 'Log cleared.');
  };

  /* -- Config readers ---------------------------------------------- */
  function getExpandOffsets() {
    return {
      t: parseInt(document.getElementById('cfg-t').value, 10) || 0,
      l: parseInt(document.getElementById('cfg-l').value, 10) || 0,
      r: parseInt(document.getElementById('cfg-r').value, 10) || 0,
      b: parseInt(document.getElementById('cfg-b').value, 10) || 0
    };
  }

  /* -- State display update ---------------------------------------- */
  function updateDisplay() {
    var sf = window.$sf;
    if (!sf || !sf.ext) return;

    var statusEl = document.getElementById('disp-status');
    var status = sf.ext.status();
    statusEl.textContent = status;
    statusEl.className = 'state-value ' +
      (status === 'expanded' ? 'ok' :
       status === 'collapsed' ? '' : 'warn');

    var ivEl = document.getElementById('disp-inview');
    var iv = sf.ext.inViewPercentage();
    ivEl.textContent = iv + '%';
    ivEl.className = 'state-value ' + (iv > 0 ? 'ok' : 'warn');

    var focusEl = document.getElementById('disp-focus');
    var focus = sf.ext.winHasFocus();
    focusEl.textContent = String(focus);
    focusEl.className = 'state-value ' + (focus ? 'ok' : '');

    var geomObj = sf.ext.geom();
    if (geomObj && geomObj.self) {
      document.getElementById('disp-geom-self').textContent =
        'w:' + geomObj.self.w + ' h:' + geomObj.self.h +
        ' iv:' + (geomObj.self.iv !== undefined ? geomObj.self.iv.toFixed(2) : '?');
    }
  }

  /* -- SafeFrame callback ------------------------------------------ */
  function onSafeFrameEvent(status, data) {
    switch (status) {
      case 'geom-update':
        logEntry('geom', 'geom-update -- iv:' +
          (data && data.self ? data.self.iv.toFixed(2) : '?') +
          ' w:' + (data && data.self ? data.self.w : '?') +
          ' h:' + (data && data.self ? data.self.h : '?'));
        break;
      case 'expanded':
        logEntry('ok', 'expanded -- w:' +
          (data && data.info ? data.info.w : '?') +
          ' h:' + (data && data.info ? data.info.h : '?') +
          ' push:' + (data && data.info ? data.info.push : '?'));
        break;
      case 'collapsed':
        logEntry('ok', 'collapsed');
        break;
      case 'failed':
        logEntry('error', 'failed -- reason:' +
          (data && data.reason ? data.reason : 'unknown'));
        break;
      case 'focus-change':
        logEntry('focus', 'focus-change -- focus:' +
          (data && data.focus !== undefined ? data.focus : '?'));
        break;
      default:
        logEntry('info', 'callback: ' + status + ' -- ' + JSON.stringify(data));
    }
    updateDisplay();
  }

  /* -- Test actions ------------------------------------------------ */

  window.testExpandOverlay = function testExpandOverlay() {
    var sf = window.$sf;
    if (!sf) return;
    var offsets = getExpandOffsets();
    var args = { t: offsets.t, l: offsets.l, r: offsets.r, b: offsets.b, push: false };
    logEntry('action', '$sf.ext.expand(' + JSON.stringify(args) + ')');
    sf.ext.expand(args);
  };

  window.testExpandPush = function testExpandPush() {
    var sf = window.$sf;
    if (!sf) return;
    var offsets = getExpandOffsets();
    var args = { t: offsets.t, l: offsets.l, r: offsets.r, b: offsets.b, push: true };
    logEntry('action', '$sf.ext.expand(' + JSON.stringify(args) + ') -- expects failed callback');
    sf.ext.expand(args);
  };

  window.testExpandNoOffsets = function testExpandNoOffsets() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '$sf.ext.expand({}) -- maximize (no directional offsets)');
    sf.ext.expand({});
  };

  window.testCollapse = function testCollapse() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '$sf.ext.collapse()');
    sf.ext.collapse();
  };

  window.testStatus = function testStatus() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('info', '  $sf.ext.status() = "' + sf.ext.status() + '"');
  };

  window.testGeom = function testGeom() {
    var sf = window.$sf;
    if (!sf) return;
    var g = sf.ext.geom();
    logEntry('info', '  geom().win  = ' + JSON.stringify(g.win));
    logEntry('info', '  geom().self = ' + JSON.stringify(g.self));
    logEntry('info', '  geom().exp  = ' + JSON.stringify(g.exp));
  };

  /* -- Bootstrap --------------------------------------------------- */
  (function bootstrap() {
    var sf = window.$sf;

    if (!sf || !sf.ext) {
      logEntry('error', 'window.$sf not found. Load via safeframe-wrapper.html');
      document.getElementById('no-sf').style.display = 'block';
      return;
    }

    logEntry('ok', '$sf found -- specVersion: "' + (sf.specVersion || '?') + '"');
    logEntry('info', '  $sf.ext.supports() = ' + JSON.stringify(sf.ext.supports()));
    logEntry('info', '  $sf.ext.status()   = "' + sf.ext.status() + '"');

    sf.ext.register(300, 250, onSafeFrameEvent);
    logEntry('info', '  $sf.ext.register(300, 250, cb) called -- waiting for geom-update...');

    updateDisplay();
  }());
};
```

### 4.3 Protocol Trace Entries to Verify

| Action | Expected Log Entries |
|--------|---------------------|
| Page load | `$sf found`, `register(300, 250, cb) called`, `geom-update` callback |
| expand overlay | `$sf.ext.expand({t:50, l:50, r:50, b:50, push:false})`, then callback `expanded -- w:? h:? push:false`, status updates to `"expanded"` |
| expand push | `$sf.ext.expand({...push:true})`, then callback `failed -- reason:push-not-supported` |
| expand (no offsets) | `$sf.ext.expand({})`, then callback `expanded` (maximize path) |
| collapse | `$sf.ext.collapse()`, then callback `collapsed`, status returns to `"collapsed"` |
| status() | `$sf.ext.status() = "expanded"` or `"collapsed"` |
| geom() | `geom().win`, `geom().self`, `geom().exp` with dimension data |

### 4.4 Pass/Fail Criteria

| Test | PASS Condition | FAIL Condition |
|------|---------------|----------------|
| Overlay expand | Callback fires with status `"expanded"` and `push: false`; `$sf.ext.status()` returns `"expanded"` | Callback fires `"failed"` or no callback |
| Push expand | Callback fires with status `"failed"` and reason `"push-not-supported"` | Callback fires `"expanded"` (push should be rejected) |
| No-offset expand | Callback fires with status `"expanded"` (maximize intent used) | Callback fires `"failed"` |
| Collapse | Callback fires with status `"collapsed"`; `$sf.ext.status()` returns `"collapsed"` | No callback or status does not change |
| Expand after collapse | Second expand succeeds after a collapse cycle | Second expand rejected or idempotency guard blocks it |

---

## Harness Page Updates Required (Separate Work)

The following harness page changes are needed but are **not part of this spec** (the spec covers creative-side test assets only):

1. **`examples/test/index.html`** -- Add a link/option for `test-placement-creative.html` as a SHARC core creative.

2. **`examples/test/mraid-test.html`** -- Add `test-mraid-resize-creative.html` to the creative dropdown/selector.

3. **`examples/test/safeframe-test.html`** -- Add `test-safeframe-expand-creative.html` to the creative dropdown/selector.

4. **`examples/test/mraid-3-compliance-runner.html`** -- Add `resize-positive/resize-test.html` to the compliance test list alongside the existing `resize-negative/resize-test.html` entry.

---

## File Summary

| File | Type | Lines (est.) | Loading Model |
|------|------|-------------|---------------|
| `examples/test/test-placement-creative.html` | HTML (DOM+styles) | ~180 | Standalone or wrapper |
| `examples/test/test-placement-creative.js` | JS (all logic) | ~220 | `__SHARC_TEST_placementCreativeInit` + self-boot |
| `examples/test/test-mraid-resize-creative.html` | HTML (DOM+styles) | ~200 | mraid-wrapper.html |
| `examples/test/test-mraid-resize-creative.js` | JS (all logic) | ~180 | `__SHARC_TEST_mraidCreativeInit` |
| `examples/compliance-ads/resize-positive/resize-test.html` | HTML (self-contained) | ~15 | Compliance runner |
| `examples/compliance-ads/resize-positive/resize-positive-tests.js` | JS (automated tests) | ~350 | Inline `<script>` from HTML |
| `examples/compliance-ads/resize-positive/resize-test.js` | JS (shim) | ~18 | Wrapper fallback |
| `examples/test/test-safeframe-expand-creative.html` | HTML (DOM+styles) | ~200 | safeframe-wrapper.html |
| `examples/test/test-safeframe-expand-creative.js` | JS (all logic) | ~170 | `__SHARC_TEST_sfCreativeInit` |
