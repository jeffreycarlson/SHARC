/**
 * @fileoverview SHARC Navigation Bridge
 *
 * Intercepts non-IAB-spec'd web-native navigation patterns inside a Creative
 * Markup renderer iframe and routes them through `window.SHARC.requestNavigation()`
 * for operator URL review and policy enforcement. Companion to the
 * `sharc-mraid-bridge` and `sharc-safeframe-bridge` (which handle IAB-spec'd
 * navigation surfaces); this bridge fills the gap for creatives that use
 * standard web patterns rather than MRAID/SafeFrame APIs.
 *
 * Patterns intercepted:
 *
 *   - `window.open(url, ...)` — adds `noopener,noreferrer` defensively;
 *     routes URL through `SHARC.requestNavigation()`.
 *   - `window.location.href` setter / `location.assign()` / `location.replace()`
 *     — intercepts in-frame navigation.
 *   - Anchor click delegate — `<a target="_top">` / `target="_parent">` /
 *     `target="_blank">` / no target. Adds `rel="noopener noreferrer"`
 *     defensively.
 *   - Form submit delegate — `<form>` submissions (any target).
 *   - `<meta http-equiv="refresh">` — renderer-side stripping happens BEFORE
 *     `document.write(creativeHtml)` (the renderer page strips; the bridge
 *     can also strip post-load as defense-in-depth).
 *
 * Architecture:
 *
 *   Pure adapter above `window.SHARC.requestNavigation()`. Never touches
 *   MessageChannel directly. Operates on the document the bridge is loaded
 *   into — typically a Creative Markup renderer page that calls
 *   `installNavigationBridge()` BEFORE `document.write(creativeHtml)` so the
 *   interceptors apply to all creative code.
 *
 * Trust model:
 *
 *   The bridge is BEST-EFFORT. Adversarial creative HTML can re-override
 *   `window.open`, redefine `location` getters via `Object.defineProperty`,
 *   or use other patterns to bypass it. The container-side load-event
 *   monitoring (Phase D deliverable 1: `_rendererBackstopHandler` in
 *   `SHARCContainer`) is the defense-in-depth backstop that catches anything
 *   the bridge misses — terminating the session with
 *   `RENDERER_UNAUTHORIZED_NAVIGATION (2118)`.
 *
 *   The bridge's value is the OPERATOR-AUDIT path: legitimate creatives that
 *   use standard web patterns get their navigation URLs reviewed against the
 *   operator's allowlist before the click-through proceeds. Adversarial
 *   creatives are caught by the backstop.
 *
 * Spec: docs/proposals/creative-sources.md § Click-through enforcement.
 *
 * @version 0.7.0
 */

'use strict';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Routes a URL through `window.SHARC.requestNavigation()`. Returns the
 * promise from the SDK (resolves on accept, rejects on refuse).
 *
 * Per the SHARC creative API: `requestNavigation` rejects with code 2105
 * ("Creative handles navigation") to indicate the creative should perform
 * the navigation itself (the container declined to handle it). The bridge's
 * job ends at the SDK call — the SDK decides whether to fire the URL via
 * the container path or fall back.
 *
 * @param {string} url - The destination URL.
 * @param {string} [target='clickthrough'] - SHARC navigation target.
 * @returns {Promise<void> | undefined}
 */
function _routeNavigation(url, target) {
  if (typeof window === 'undefined' || !window.SHARC
      || typeof window.SHARC.requestNavigation !== 'function') {
    // SDK not loaded — bridge is no-op. The renderer is misconfigured;
    // surface the failure cleanly.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC navigation-bridge] window.SHARC.requestNavigation '
        + 'unavailable — navigation NOT routed through audit path. '
        + 'Load sharc-creative.js before this bridge.');
    }
    return undefined;
  }
  try {
    return window.SHARC.requestNavigation({
      url: String(url),
      target: target || 'clickthrough',
    });
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC navigation-bridge] requestNavigation threw; '
        + 'navigation suppressed.', err && (err.message || err));
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// installNavigationBridge — installs all interceptors on the given window
// ---------------------------------------------------------------------------

/**
 * Installs the navigation interceptors on the supplied window. Idempotent:
 * a flag is set on the window to prevent double-install. Returns an
 * `uninstall()` function for test cleanup.
 *
 * Auto-install is opt-in via `window.__sharcNavBridgeAutoInstall = true`
 * BEFORE this module loads. The renderer page is the typical caller —
 * either set the flag and load the bridge as a `<script>` tag, or import
 * the named export and call `installNavigationBridge()` at the precise
 * install point (recommended: BEFORE `document.write(creativeHtml)`).
 *
 * The bridge mutates global namespaces:
 *
 *   - `window.open` is replaced with a wrapper that routes through
 *     `requestNavigation` BEFORE delegating to the original.
 *   - `window.location.assign`, `.replace`, and the `href` setter are
 *     replaced/wrapped on the location object's property descriptors. Some
 *     browsers make these non-configurable; the bridge tolerates that
 *     (no-throw fallback) and emits a warning.
 *   - A document-level `click` listener handles anchor clicks (capture
 *     phase, runs before any creative-installed handlers).
 *   - A document-level `submit` listener handles form submissions (capture
 *     phase).
 *   - All `<meta http-equiv="refresh">` elements found in the document at
 *     install time are removed (defense-in-depth — the renderer page
 *     SHOULD have stripped these before `document.write`).
 *
 * Recommended install point: in the renderer page, IMMEDIATELY BEFORE the
 * `document.open() / document.write(creativeHtml) / document.close()`
 * sequence. That puts the interceptors in place before any creative code
 * runs.
 *
 * @param {Window} [w] - Target window. Defaults to global `window`.
 * @returns {() => void} uninstall function
 */
function installNavigationBridge(w) {
  /* eslint-disable no-param-reassign */
  var win = w || (typeof window !== 'undefined' ? window : null);
  if (!win) {
    throw new Error('[SHARC navigation-bridge] No window context available.');
  }
  if (win.__sharcNavBridgeInstalled) {
    // Already installed — return a no-op uninstall to keep the contract.
    return function () {};
  }
  win.__sharcNavBridgeInstalled = true;

  var doc = win.document;
  var originalWindowOpen = win.open;
  var originalAssign = win.location && win.location.assign;
  var originalReplace = win.location && win.location.replace;
  // Capture the original href descriptor so we can attempt to wrap the
  // setter. Some user agents make Location.prototype properties
  // non-configurable; we degrade gracefully.
  var locationProto = win.location ? Object.getPrototypeOf(win.location) : null;
  var hrefDescriptor = locationProto
    ? Object.getOwnPropertyDescriptor(locationProto, 'href')
    : null;
  var hrefWrapped = false;

  // ─── window.open ────────────────────────────────────────────────────────
  // Wrap to route through requestNavigation BEFORE delegating. The bridge
  // suppresses the actual window.open call by default (the SDK / container
  // does the navigation through its own path on accept). If the container
  // rejects (2105 — creative handles navigation), the creative is on its
  // own; the bridge does NOT silently call the original window.open behind
  // the operator's back, because that would defeat the audit path.
  win.open = function _sharcWindowOpen(url, target, features) {
    var routed = _routeNavigation(/** @type {string} */ (String(url || '')), 'clickthrough');
    void target;
    void features;
    if (routed && typeof routed.catch === 'function') {
      routed.catch(function () { /* container declined — creative handles */ });
    }
    // Return null per the signature contract — the bridge has consumed the
    // call. Creatives that test for a non-null return need to handle this;
    // the alternative (delegating to original window.open) would defeat the
    // audit path the bridge exists to provide.
    return null;
  };

  // ─── location.assign / replace ──────────────────────────────────────────
  // Wrap on the live `location` object. If non-configurable, fall back to
  // direct assignment (still wraps the function reference, just not a
  // descriptor swap).
  if (typeof originalAssign === 'function') {
    try {
      win.location.assign = function _sharcLocationAssign(url) {
        _routeNavigation(String(url), 'clickthrough');
      };
    } catch (_) { /* non-configurable — bridge can't intercept */ }
  }
  if (typeof originalReplace === 'function') {
    try {
      win.location.replace = function _sharcLocationReplace(url) {
        _routeNavigation(String(url), 'clickthrough');
      };
    } catch (_) { /* non-configurable */ }
  }

  // ─── location.href setter ───────────────────────────────────────────────
  // Replace the descriptor on Location.prototype so `location.href = url`
  // routes through requestNavigation. Best-effort — some browsers / sandbox
  // configurations make this non-configurable. Catch and warn if so.
  if (locationProto && hrefDescriptor && hrefDescriptor.configurable) {
    try {
      Object.defineProperty(locationProto, 'href', {
        configurable: true,
        enumerable: hrefDescriptor.enumerable,
        get: hrefDescriptor.get,
        set: function _sharcLocationHrefSet(url) {
          _routeNavigation(url, 'clickthrough');
        },
      });
      hrefWrapped = true;
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[SHARC navigation-bridge] location.href setter '
          + 'non-configurable; relying on container load-event backstop.',
          err && (err.message || err));
      }
    }
  }

  // ─── Anchor click delegate ──────────────────────────────────────────────
  // Capture-phase listener so it runs before creative-installed handlers.
  // Walks up from event.target to find the nearest <a> ancestor (handles
  // creatives that wrap the anchor's text in nested spans).
  var anchorHandler = function _sharcAnchorClick(event) {
    var target = event.target;
    if (!target) return;
    var anchor = null;
    while (target && target.nodeType === 1) {
      if (target.tagName === 'A' && target.getAttribute('href')) {
        anchor = target;
        break;
      }
      target = target.parentNode;
    }
    if (!anchor) return;
    var href = anchor.getAttribute('href');
    if (!href || href.charAt(0) === '#') return; // hash-link, ignore
    // Defensively add rel="noopener noreferrer" before the navigation runs.
    var rel = anchor.getAttribute('rel') || '';
    if (rel.indexOf('noopener') === -1 || rel.indexOf('noreferrer') === -1) {
      anchor.setAttribute('rel', (rel + ' noopener noreferrer').trim());
    }
    event.preventDefault();
    event.stopPropagation();
    _routeNavigation(href, 'clickthrough');
  };
  doc.addEventListener('click', anchorHandler, true);

  // ─── Form submit delegate ───────────────────────────────────────────────
  // Capture-phase. Routes the form's `action` URL through requestNavigation.
  // Form-data submission (POST body, encoded query string) is NOT preserved —
  // the bridge intentionally limits navigation to URL review; creatives that
  // need form-data submission should use the SHARC SDK directly.
  var formHandler = function _sharcFormSubmit(event) {
    var form = event.target;
    if (!form || form.nodeType !== 1 || form.tagName !== 'FORM') return;
    var action = form.getAttribute('action') || form.action || '';
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    _routeNavigation(action, 'clickthrough');
  };
  doc.addEventListener('submit', formHandler, true);

  // ─── meta http-equiv="refresh" stripping ────────────────────────────────
  // Defense-in-depth — the renderer page SHOULD have stripped these from
  // creativeHtml before document.write (per spec § Renderer implementation
  // contract operational constraints). The bridge re-checks at install time
  // in case the renderer fork omitted the strip.
  //
  // Entity-encoding-safe by construction: this strip operates on the LIVE
  // DOM (already parsed by the browser), so `getAttribute('http-equiv')`
  // returns the parser-decoded value — `&#114;efresh` arrives here as
  // `refresh` and is caught by the lowercase comparison. Contrast with
  // string-regex strips (renderer-side, pre-document.write), which must
  // use DOMParser to get the same guarantee.
  try {
    var metas = doc.querySelectorAll('meta[http-equiv]');
    for (var i = 0; i < metas.length; i++) {
      var meta = metas[i];
      var hv = meta.getAttribute('http-equiv') || '';
      if (hv.toLowerCase() === 'refresh' && meta.parentNode) {
        meta.parentNode.removeChild(meta);
      }
    }
  } catch (_) { /* no DOM — bridge installed pre-document */ }

  // ─── Uninstall (test hook) ──────────────────────────────────────────────
  return function uninstall() {
    win.open = originalWindowOpen;
    if (typeof originalAssign === 'function') {
      try { win.location.assign = originalAssign; } catch (_) { /* ignore */ }
    }
    if (typeof originalReplace === 'function') {
      try { win.location.replace = originalReplace; } catch (_) { /* ignore */ }
    }
    if (hrefWrapped && locationProto && hrefDescriptor) {
      try { Object.defineProperty(locationProto, 'href', hrefDescriptor); }
      catch (_) { /* ignore */ }
    }
    doc.removeEventListener('click', anchorHandler, true);
    doc.removeEventListener('submit', formHandler, true);
    delete win.__sharcNavBridgeInstalled;
  };
  /* eslint-enable no-param-reassign */
}

// ---------------------------------------------------------------------------
// ESM exports
// ---------------------------------------------------------------------------

export { installNavigationBridge };

// Browser auto-install: when loaded as a <script> tag in the renderer page
// after sharc-creative.js, install the interceptors immediately. Operators
// that want manual control can import the named export and call
// installNavigationBridge() at their preferred install point.
//
// The auto-install only fires when the host explicitly opts in via
// `window.__sharcNavBridgeAutoInstall = true` BEFORE this module loads.
// Default-off keeps the test surface clean and matches the load-order
// pattern operators actually use (install at a specific point in the
// renderer page lifecycle, not implicitly at module evaluation).
if (typeof window !== 'undefined' && window.SHARC
    && typeof window.SHARC.requestNavigation === 'function') {
  /** @type {any} */
  var anyWin = window;
  if (anyWin.__sharcNavBridgeAutoInstall && !window.__sharcNavBridgeInstalled) {
    installNavigationBridge(window);
  }
  // Expose the named export on the SHARC namespace for parity with the
  // other bridges (window.SHARC.MRAIDCompatBridge, etc.).
  window.SHARC.installNavigationBridge = installNavigationBridge;
}
