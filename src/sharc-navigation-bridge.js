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
 *     — best-effort only. Chromium exposes these as non-configurable own
 *     Location properties, so they cannot be replaced there; the container
 *     load-event backstop terminates the post-render navigation instead.
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
 * Failure-signal contract (Phase D round-4 — OpenClaw MEDIUM-3):
 *
 *   When `window.SHARC.requestNavigation` is unavailable (renderer
 *   misconfigured, SDK script tag missing or broken), the bridge fails
 *   loud to the creative by throwing `SHARCNavigationError` (exported
 *   from this module, also exposed on `window.SHARCNavigationError` for
 *   non-module creatives). The throw fires AFTER `event.preventDefault()`
 *   so the native navigation is blocked, but the creative cannot silently
 *   believe a clickthrough succeeded:
 *
 *     - `<a>` click → preventDefault, then throw
 *     - `<form>` submit → preventDefault, then throw
 *     - `location.assign(url)` / `location.replace(url)` / `location.href = url`
 *       → throw only in user agents where the Location surface is actually
 *       replaceable; in Chromium these are enforced by the container
 *       load-event backstop because the properties are non-configurable.
 *     - `window.open(url)` → return null + console.error (NOT throw — IAB
 *       popup-blocker pattern; defensive creatives use the null-return
 *       idiom and would break if window.open synchronously threw)
 *
 *   Container declines (allowlist refusal, policy denial) still resolve
 *   through the SDK's Promise-reject path; the throw is reserved for the
 *   operator-misconfiguration SDK-missing case.
 *
 * Event-propagation contract (Phase D round-4 — OpenClaw MEDIUM-2):
 *
 *   The bridge calls `event.preventDefault()` to block native navigation
 *   but does NOT call `event.stopPropagation()`. Creative-installed
 *   click / submit handlers (analytics, validation, custom UI) still fire
 *   normally — the bridge audits the navigation without taking over the
 *   event.
 *
 * Spec: docs/proposals/creative-sources.md § Click-through audit and policy boundary.
 *
 * @version 0.7.13
 */

'use strict';

// ---------------------------------------------------------------------------
// Error class — exported for creative-side `instanceof` checks
// ---------------------------------------------------------------------------

/**
 * Thrown by the navigation bridge when the SHARC SDK is unavailable on the
 * page. The bridge's contract is fail-loud-to-creative: when the SDK is
 * missing, the bridge has already called `event.preventDefault()` (so the
 * native navigation is blocked), and then throws so the creative cannot
 * silently believe a clickthrough succeeded. Per OpenClaw MEDIUM-3:
 * silent dead-clicks were the prior failure mode and offered no recovery
 * path; the throw lets defensive creatives `try { … } catch (e)` and fall
 * back to whatever they want (own analytics, retry, manual nav, etc.).
 *
 * `code` is currently `'SDK_UNAVAILABLE'` only; reserved for future codes
 * (e.g. policy-decline propagation, transport failure). Operators consuming
 * the bridge should `instanceof`-check against this class rather than match
 * on `code` alone.
 *
 * @property {string} code - Stable machine-readable failure code.
 */
class SHARCNavigationError extends Error {
  /**
   * @param {string} code - One of `'SDK_UNAVAILABLE'` (more codes reserved).
   * @param {string} message - Human-readable explanation.
   */
  constructor(code, message) {
    super(message);
    this.name = 'SHARCNavigationError';
    this.code = code;
  }
}

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
 * Throw contract (OpenClaw MEDIUM-3, Phase D round-4): when the SDK is
 * unavailable, this helper throws `SHARCNavigationError({ code:
 * 'SDK_UNAVAILABLE' })` after emitting a console.warn. Callers MUST be
 * prepared for the throw — most call sites are inside event handlers that
 * have already called `event.preventDefault()`, so the throw propagates to
 * the creative's installed handlers (capture-phase + bubble) and ultimately
 * surfaces as an unhandled rejection / window onerror unless the creative
 * catches it. `window.open` is the documented exception (see below).
 *
 * @param {string} url - The destination URL.
 * @param {string} [target='clickthrough'] - SHARC navigation target.
 * @returns {Promise<void>} resolves on accept; rejects on container refuse
 * @throws {SHARCNavigationError} when the SDK is unavailable
 */
function _routeNavigation(url, target) {
  if (typeof window === 'undefined' || !window.SHARC
      || typeof window.SHARC.requestNavigation !== 'function') {
    // SDK not loaded — bridge cannot route. The renderer is misconfigured;
    // surface the failure cleanly via console.warn AND a throw so the
    // creative cannot silently believe the clickthrough succeeded.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC navigation-bridge] window.SHARC.requestNavigation '
        + 'unavailable — navigation NOT routed through audit path. '
        + 'Load sharc-creative.js before this bridge.');
    }
    throw new SHARCNavigationError('SDK_UNAVAILABLE',
      'SHARC.requestNavigation unavailable; clickthrough cannot be audited');
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
    // Re-throw as our own type so callers can `instanceof`-check uniformly.
    throw new SHARCNavigationError('SDK_UNAVAILABLE',
      'SHARC.requestNavigation threw synchronously: '
        + (err && err.message ? err.message : 'unknown'));
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
 *     replaced/wrapped when the user agent permits it. Chromium exposes
 *     these as non-configurable own Location properties, so they remain
 *     native there and are enforced by the container load-event backstop.
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
  // setter. Some user agents make Location properties non-configurable;
  // Chromium exposes href/assign/replace as non-configurable own properties.
  // In those browsers we degrade to the container load-event backstop.
  var locationProto = win.location ? Object.getPrototypeOf(win.location) : null;
  var hrefDescriptor = locationProto
    ? Object.getOwnPropertyDescriptor(locationProto, 'href')
    : null;
  var hrefWrapped = false;

  // ─── window.open ────────────────────────────────────────────────────────
  // `window.open` interceptor.
  //
  // Routes the call through `SHARC.requestNavigation({ url, target:
  // 'clickthrough' })` and returns `null`. This is the IAB popup-blocker
  // pattern — defensive creatives already handle null returns from
  // `window.open` (popup blockers return null when they fire).
  //
  // Why null instead of a WindowProxy:
  //   - The renderer iframe is sandboxed; container-mediated navigation
  //     happens on the publisher side, not in the renderer iframe. There's
  //     no WindowProxy for the bridge to return.
  //   - WindowProxy references can't cross postMessage (not structured-
  //     cloneable). Even if the container approved synchronously, no
  //     reference can be transferred back.
  //   - Synchronous URL approval is incompatible with ad-tech reality
  //     (click-through URLs are dynamic per impression, RTB-macro-filled,
  //     not pre-enumerable).
  //
  // Creatives that need programmatic navigation control should call
  // `SHARC.requestNavigation()` directly. WindowProxy semantics are not
  // available in any sandboxed-iframe spec (MRAID `mraid.open()`,
  // SafeFrame `$sf.ext.expand()`, SIMID — all void/null return); SHARC
  // matches that precedent.
  //
  // The bridge does NOT silently call the original window.open behind the
  // operator's back on container rejection — that would defeat the audit
  // path the bridge exists to provide.
  //
  // Throw contract — `window.open` is the IAB popup-blocker exception
  // (Phase D round-4 OpenClaw MEDIUM-3): SDK-missing returns null +
  // console.error rather than throwing. Defensive creatives use the IAB
  // pattern (`var w = window.open(); if (w) { ... }`) to detect popup
  // blockers; throwing would break that idiom and silently introduce
  // synchronous failures into call sites that expect null on failure.
  // Per the IAB precedent, `<a>` / form / `location.*` paths throw
  // SHARCNavigationError on SDK-missing (creatives there don't have a
  // null-return idiom to preserve), but `window.open` keeps null + log.
  win.open = function _sharcWindowOpen(url, target, features) {
    void target;
    void features;
    var routed;
    try {
      routed = _routeNavigation(/** @type {string} */ (String(url || '')), 'clickthrough');
    } catch (err) {
      // SDK-missing — log and return null. Match the popup-blocker idiom.
      if (typeof console !== 'undefined' && console.error) {
        console.error('[SHARC navigation-bridge] window.open could not be '
          + 'audited (SDK unavailable); returning null per popup-blocker '
          + 'pattern.',
          err && err.message ? err.message : 'unknown');
      }
      return null;
    }
    if (routed && typeof routed.catch === 'function') {
      routed.catch(function () { /* container declined — creative handles */ });
    }
    return null;
  };

  // ─── location.assign / replace ──────────────────────────────────────────
  // `location.assign` / `location.replace` interceptor.
  //
  // Routes through `SHARC.requestNavigation({ url, target: 'clickthrough' })`
  // and returns `undefined` (matching the native void return).
  //
  // Throw contract (Phase D round-4 OpenClaw MEDIUM-3): when the SDK is
  // unavailable, _routeNavigation throws `SHARCNavigationError({ code:
  // 'SDK_UNAVAILABLE' })` and the throw propagates out of the wrapper.
  // Real browsers throw `SecurityError` from `location.assign` / `replace`
  // on CSP-block (sandbox without `allow-top-navigation`, mixed-content,
  // etc.) — the bridge's throw matches that precedent. Defensive creatives
  // can `try { location.assign(url); } catch (e) { /* fallback */ }`.
  //
  // Container declines (allowlist mismatch, policy refusal) still resolve
  // through the returned Promise's reject path — the bridge surfaces that
  // through the SDK's rejection chain, not as a synchronous throw. The
  // throw is reserved for the SDK-missing operator-misconfiguration path.
  //
  // Wrap on the live `location` object when possible. Chromium exposes these
  // as non-configurable, non-writable own properties, so direct assignment is
  // accepted in sloppy mode but has no effect. Browser CI locks in the
  // enforceable fallback: the container terminates on the resulting iframe
  // navigation via RENDERER_UNAUTHORIZED_NAVIGATION (2118).
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
  // routes through requestNavigation when the user agent permits it.
  // Best-effort — Chromium puts a non-configurable own `href` descriptor on
  // the Location object, so the prototype setter is shadowed there. Catch
  // and warn if the prototype path itself is also blocked.
  //
  // Throw contract: identical to location.assign / replace — SDK-missing
  // throws SHARCNavigationError out of the setter. Native browsers throw
  // `SecurityError` from the href setter under CSP-block; this matches that
  // precedent.
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
  //
  // Walk up the composed path (crosses shadow boundaries) to find the
  // nearest <a> ancestor. Falls back to parentNode walk if composedPath
  // is unavailable (older browsers). Without composedPath, a creative
  // using Web Components with a hidden <a> inside an open shadow root
  // would bypass the bridge — `event.target` retargets to the host element
  // and `parentNode` does not cross the shadow boundary upward.
  var anchorHandler = function _sharcAnchorClick(event) {
    var path = (typeof event.composedPath === 'function') ? event.composedPath() : null;
    var anchor = null;
    if (path) {
      for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (node && node.nodeType === 1
            && node.tagName === 'A'
            && node.getAttribute && node.getAttribute('href')) {
          anchor = node;
          break;
        }
      }
    } else {
      // Fallback: parentNode walk (no shadow boundary crossing).
      var target = event.target;
      while (target && target.nodeType === 1) {
        if (target.tagName === 'A' && target.getAttribute('href')) {
          anchor = target;
          break;
        }
        target = target.parentNode;
      }
    }
    if (!anchor) return;
    var href = anchor.getAttribute('href');
    if (!href || href.charAt(0) === '#') return; // hash-link, ignore
    // Ignore javascript: URLs — these are in-page script invocations,
    // not navigations. The bridge only routes outbound navigations;
    // routing a `javascript:` URL through the audit path would be a
    // category error (the operator has no destination to review).
    if (/^\s*javascript:/i.test(href)) return;
    // Defensively add rel="noopener noreferrer" before the navigation runs.
    var rel = anchor.getAttribute('rel') || '';
    if (rel.indexOf('noopener') === -1 || rel.indexOf('noreferrer') === -1) {
      anchor.setAttribute('rel', (rel + ' noopener noreferrer').trim());
    }
    // Block native navigation only — DO NOT stopPropagation. Capture-phase +
    // stopPropagation would prevent creative-installed handlers (analytics,
    // validation, custom UI logic) from running. The bridge audits the
    // navigation; the creative's other handlers still get to observe the
    // click event through the normal bubble phase. Per OpenClaw MEDIUM-2:
    // the bridge intercepts the navigation but does not suppress event
    // propagation. (Fail-loud-to-creative throw below: when the SDK is
    // unavailable, _routeNavigation throws SHARCNavigationError after the
    // preventDefault — the creative cannot silently believe a click-through
    // succeeded when it didn't reach the audit path.)
    event.preventDefault();
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
    // Only intercept when the explicit `action` attribute is present and
    // non-empty. `form.action` (the IDL property) falls back to the current
    // page URL when the attribute is omitted, which would route same-page
    // submits as outbound navigations — false positive. The attribute-only
    // check distinguishes "creative explicitly declared a destination"
    // from "browser default same-page submit"; the latter is not an
    // outbound navigation and the bridge leaves native behavior alone.
    //
    // Per HTML5, a submission's `submitter` (the button/input that triggered
    // it) can override the form's action via `formaction`. Prefer the
    // submitter's formaction when present; falls back to the form's own
    // action attribute for programmatic .submit() calls (no submitter).
    var submitter = event.submitter;
    var rawAction = null;
    if (submitter && submitter.getAttribute) {
      var fa = submitter.getAttribute('formaction');
      if (fa != null && fa !== '') rawAction = fa;
    }
    if (rawAction == null) rawAction = form.getAttribute('action');
    if (rawAction == null || rawAction === '') return;
    // Block native submission only — DO NOT stopPropagation (parity with
    // the anchor handler). Creative-installed submit listeners (validation,
    // analytics) MUST still observe the event. Per OpenClaw MEDIUM-2.
    event.preventDefault();
    _routeNavigation(rawAction, 'clickthrough');
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
}

// ---------------------------------------------------------------------------
// ESM exports
// ---------------------------------------------------------------------------

export { installNavigationBridge, SHARCNavigationError };

// Always expose the error class on `window` so non-module creatives can
// `instanceof`-check against it without an import. Independent of the
// SDK-loaded check below — the error class is meaningful even if the SDK
// hasn't loaded (the throw it powers fires in exactly that case).
//
// First-assignment-wins contract: an operator that pre-sets
// `window.SHARCNavigationError` before SHARC modules load (e.g. for a
// custom subclass with extra telemetry fields) keeps their override —
// the bridge does NOT clobber it. Same pattern as
// `window.SHARC.installNavigationBridge` below.
if (typeof window !== 'undefined') {
  /** @type {any} */
  var _winForErr = window;
  if (typeof _winForErr.SHARCNavigationError !== 'function') {
    _winForErr.SHARCNavigationError = SHARCNavigationError;
  }
}

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
  //
  // First-assignment-wins contract: operators may pre-set
  // `window.SHARC.installNavigationBridge` (e.g. wrapped with telemetry)
  // before SHARC modules load; the bridge won't clobber that override.
  // The SDK in `sharc-creative.js` carries the same guard — if either
  // file's assignment ran unconditionally the operator's override would
  // be silently overwritten depending on script-tag order.
  if (typeof window.SHARC.installNavigationBridge !== 'function') {
    window.SHARC.installNavigationBridge = installNavigationBridge;
  }
}
