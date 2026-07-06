/**
 * @fileoverview SHARC MRAID Compatibility Bridge
 *
 * Makes existing MRAID 2.0/3.0 creatives run inside a SHARC container
 * without modification. Exposes a spec-compliant `window.mraid` object
 * backed exclusively by the SHARC Creative API (`window.SHARC`).
 *
 * Architecture: Pure adapter above `window.SHARC`. Never touches MessageChannel
 * directly. All SHARC protocol communication is delegated to sharc-creative.js.
 *
 * Load order in the creative iframe:
 *   1. sharc-protocol.js  → window.SHARC (with .Protocol)
 *   2. sharc-creative.js  → augments window.SHARC with creative API methods
 *   3. sharc-mraid-bridge.js → window.mraid (this file)
 *   4. <MRAID creative>
 *
 * @version 0.7.12
 * @see mraid-bridge-design.md
 */

'use strict';

const MRAID_BRIDGE_AUTOINSTALL_CAP_TICKS = 1000;
const MRAID_BRIDGE_AUTOINSTALL_CAP_MS = 16000;

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

/**
 * Defense-in-depth validation for the operator-supplied `baseUrl` option
 * (issue #140). The bridge `baseUrl` differs from OMID's strict HTTPS URLs
 * because the default (`'/sharc'`) is path-relative, so this validator
 * accepts path-relative URLs while still rejecting dangerous schemes and
 * insecure / userinfo-bearing absolute URLs.
 *
 * Rules:
 *   - `undefined` / `null` are accepted (caller falls back to `'/sharc'`)
 *   - Must be a string
 *   - Must NOT be empty or whitespace-only after trim
 *   - Must NOT contain embedded control / Unicode-whitespace / zero-width
 *     characters (would survive a future WHATWG-parser or ES2019-trim sink
 *     and rehydrate as a dangerous scheme — e.g. `'jav\tascript:alert(1)'`
 *     or `' javascript:alert(1)'` with NBSP)
 *   - Must NOT be protocol-relative (`//host/…` or `\\host\…`) — would resolve
 *     against the page's protocol in an href/srcdoc sink and fetch from an
 *     attacker-controlled origin
 *   - Must NOT contain `%3A` (percent-encoded colon) anywhere or lead with
 *     `%2F` / `%5C` (percent-encoded slash / backslash) — defends a future
 *     decoding sink against scheme-injection and protocol-relative rehydration
 *   - Must NOT start with a dangerous scheme (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`)
 *     in any letter case
 *   - If absolute (has a scheme), must be HTTPS
 *   - No userinfo allowed
 *
 * Throws `TypeError` on invalid input, mirroring the shape of OMID's
 * `validateOmidHttpsUrl` (logs via `console.warn` then throws).
 *
 * @param {*} baseUrl
 * @returns {string|undefined} the input string when valid, or `undefined` for null/undefined input
 */
function validateBridgeBaseUrl(baseUrl) {
  if (baseUrl == null) return undefined;
  if (typeof baseUrl !== 'string') {
    var typeMsg = 'baseUrl must be a string';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + typeMsg);
    }
    throw new TypeError(typeMsg);
  }

  // Trim leading/trailing whitespace before scheme detection. The WHATWG URL
  // parser strips leading C0 control + space, and ES2019 `String.prototype.trim`
  // additionally strips Unicode whitespace — so `'\tjavascript:alert(1)'`,
  // `'<NBSP>javascript:alert(1)'`, and `'<ZWSP>javascript:alert(1)'`
  // would all rehydrate as `javascript:` if forwarded to such a sink
  // without pre-trimming. Strip the full ES2019-trim set plus zero-width chars
  // (ZWSP / ZWNJ / ZWJ / BOM) which are not in the spec set but are stripped
  // by some parsers / normalizers and could mask scheme detection here.
  // eslint-disable-next-line no-control-regex -- intentional: C0 controls + space + Unicode whitespace are the bypass surface this trim defends
  var trimmed = baseUrl.replace(/^[\x00-\x20\x7F\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F-\u2060\u3000\uFEFF]+|[\x00-\x20\x7F\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F-\u2060\u3000\uFEFF]+$/g, '');

  // Empty / whitespace-only baseUrl. Without this check, `'   '` would
  // bypass scheme detection (empty `trimmed` matches no scheme) and be
  // returned verbatim — leading whitespace would propagate into the URL.
  if (trimmed === '') {
    var emptyMsg = 'baseUrl must not be empty or whitespace';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + emptyMsg);
    }
    throw new TypeError(emptyMsg);
  }

  // Embedded control / Unicode-whitespace / zero-width characters. A future
  // WHATWG-parser-backed sink would strip C0 controls and rehydrate
  // `'jav\tascript:alert(1)'` as `javascript:`; an ES2019-trim sink would
  // additionally strip NBSP / line-separator / ZWSP / BOM. Catch all of these
  // bypass shapes at the validator regardless of where the value flows.
  // ASCII space (0x20) is intentionally allowed mid-string so legitimate
  // path-relative values containing spaces still pass — leading/trailing
  // spaces are already removed by the trim above.
  // eslint-disable-next-line no-control-regex -- intentional: embedded C0 controls + DEL + Unicode whitespace + zero-width chars are the bypass surface this check defends
  if (/[\x00-\x1F\x7F\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F-\u2060\u3000\uFEFF]/.test(trimmed)) {
    var ctrlMsg = 'baseUrl must not contain embedded control or whitespace characters';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + ctrlMsg);
    }
    throw new TypeError(ctrlMsg);
  }

  // Protocol-relative URLs (`//host/…` or `\\host\…`). The scheme regex
  // returns no match, so without this check these fall through to
  // "path-relative — accept", but in an href/srcdoc sink the browser
  // resolves `//host/…` against the page protocol and fetches from
  // attacker-controlled origin. Backslash variants are normalized to
  // forward slashes by browsers in special-scheme contexts. Also reject
  // the percent-encoded leading form (`%2F%2F…`, `%5C%5C…`, mixed) so a
  // downstream decoding sink can't rehydrate the bypass.
  if (/^[\\/]{2}/.test(trimmed) || /^%(?:2[Ff]|5[Cc])/.test(trimmed)) {
    var protoRelMsg = 'baseUrl must not be protocol-relative';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + protoRelMsg);
    }
    throw new TypeError(protoRelMsg);
  }

  // Percent-encoded scheme separator (`%3A`). Today the scheme regex requires
  // a literal `:`, so this isn't an active bypass — but if a future code path
  // URL-decodes `baseUrl` before validation (or hands it to a sink that does),
  // `'javascript%3Aalert(1)'` rehydrates as `javascript:`. Lock the bypass
  // shape at the validator. Case-insensitive per RFC 3986 §2.1. Matched
  // anywhere (vs leading-only for `%2F`/`%5C` above) — a decoded `:` mid-path
  // can still influence URL parsing downstream.
  if (/%3[Aa]/.test(trimmed)) {
    var pctColonMsg = 'baseUrl must not contain percent-encoded scheme separator (%3A)';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + pctColonMsg);
    }
    throw new TypeError(pctColonMsg);
  }

  // Scheme detection: `scheme:` per RFC 3986 (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )).
  var schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/);
  if (!schemeMatch) {
    // Path-relative URL (e.g. '/sharc', './sharc', 'sharc'). Accept.
    return baseUrl;
  }

  var scheme = schemeMatch[1].toLowerCase();
  var dangerousSchemes = { 'javascript': 1, 'data': 1, 'vbscript': 1, 'file': 1, 'blob': 1 };
  if (dangerousSchemes[scheme]) {
    var dangerMsg = 'baseUrl must not use the ' + scheme + ': scheme';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + dangerMsg);
    }
    throw new TypeError(dangerMsg);
  }

  var parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    var parseMsg = 'baseUrl must be a valid URL';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + parseMsg);
    }
    throw new TypeError(parseMsg);
  }
  if (parsed.protocol !== 'https:') {
    var httpsMsg = 'baseUrl must use HTTPS when absolute';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + httpsMsg);
    }
    throw new TypeError(httpsMsg);
  }
  if (parsed.username || parsed.password) {
    var userinfoMsg = 'baseUrl must not include userinfo';
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARC MRAID Bridge] ' + userinfoMsg);
    }
    throw new TypeError(userinfoMsg);
  }
  return baseUrl;
}

/**
 * Computes the screen-space bounding rect of the MRAID close button zone.
 * @param {number} adX - Default position X of the ad
 * @param {number} adY - Default position Y of the ad
 * @param {number} adWidth - Resized ad width
 * @param {number} adHeight - Resized ad height
 * @param {number} offsetX - Horizontal offset from ad default position
 * @param {number} offsetY - Vertical offset from ad default position
 * @param {string} closePosition - One of 'top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'
 * @param {number} closeZoneSize - Size of the close button zone (default 50)
 * @returns {{left:number,top:number,right:number,bottom:number}}
 */
function _computeCloseButtonRect(adX, adY, adWidth, adHeight, offsetX, offsetY, closePosition, closeZoneSize) {
  var size = closeZoneSize || 50;
  // The close button is positioned within the resized ad
  // Its screen-space position depends on the ad's screen offset + relative position within ad
  var adScreenLeft = adX + offsetX;
  var adScreenTop = adY + offsetY;
  var adScreenRight = adScreenLeft + adWidth;
  var adScreenBottom = adScreenTop + adHeight;

  // Close button position within the resized ad based on customClosePosition
  var closeX, closeY;
  switch (closePosition) {
    case 'top-left':
      closeX = adScreenLeft;
      closeY = adScreenTop;
      break;
    case 'top-center':
      closeX = adScreenLeft + (adWidth - size) / 2;
      closeY = adScreenTop;
      break;
    case 'top-right':
    default:
      closeX = adScreenRight - size;
      closeY = adScreenTop;
      break;
    case 'bottom-left':
      closeX = adScreenLeft;
      closeY = adScreenBottom - size;
      break;
    case 'bottom-center':
      closeX = adScreenLeft + (adWidth - size) / 2;
      closeY = adScreenBottom - size;
      break;
    case 'bottom-right':
      closeX = adScreenRight - size;
      closeY = adScreenBottom - size;
      break;
  }

  return {
    left: closeX,
    top: closeY,
    right: closeX + size,
    bottom: closeY + size,
  };
}

/**
 * Derives MRAID placement type from SHARC EnvironmentData.
 * Uses AdCOM placement.instl field.
 * @param {Object} env
 * @returns {'inline'|'interstitial'}
 */
function derivePlacementType(env) {
  const placement = env && env.data && env.data.placement;
  if (!placement) return 'inline';
  return placement.instl === 1 ? 'interstitial' : 'inline';
}

/**
 * Computes the current MRAID state from internal bridge state.
 * Slice D (L-10): MRAID state is placement-axis bookkeeping only — it is
 * de-coupled from `_sharcState`. `'hidden'` comes ONLY from the terminal
 * close/terminate `_closed` latch; viewport/backgrounding/freeze never flip it.
 *   _closed       → 'hidden'
 *   !mraidReady   → 'loading'
 *   expanded      → 'expanded'
 *   resized       → 'resized'
 *   else          → 'default'
 * @param {Object} s - The private _state object
 * @returns {'loading'|'default'|'expanded'|'resized'|'hidden'}
 */
function getMraidState(s) {
  if (s._closed) return 'hidden';
  if (!s._mraidReady) return 'loading';
  if (s._placementMode === 'expanded') return 'expanded';
  if (s._placementMode === 'resized') return 'resized';
  return 'default';
}

/**
 * Validates a URL for safe navigation use (NEW-001).
 * Only allows https: and http: schemes. Rejects javascript:, data:, file:, etc.
 * Mirrors the pattern used in SHARCContainer._isNavigationUrlSafe.
 * @param {string} url
 * @returns {boolean}
 */
function _isNavigationUrlSafe(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    var parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (e) {
    return false;
  }
}

/**
 * #394 (tel/sms scheme policy): detects the tel:/sms: scheme (scheme-exact,
 * case-insensitive prefix) so open() can decline it with an accurate,
 * scheme-specific error. tel:/sms: are a deliberate legacy exclusion (§3):
 * the ad-auto-dial/text model predates OS-level permission prompts + user-
 * activation, so SHARC — a clean-slate spec — declines them outright. This is
 * NOT operator-gated; there is no capability that re-enables them.
 * @param {string} url - already type-guarded and trimmed by open()
 * @returns {boolean}
 */
function _isDeclinedLegacyScheme(url) {
  var lower = url.toLowerCase();
  return lower.indexOf('tel:') === 0 || lower.indexOf('sms:') === 0;
}

// -------------------------------------------------------------------------
// installMRAIDBridge — creates and wires window.mraid
// -------------------------------------------------------------------------

/**
 * Installs the MRAID bridge using the provided SHARC API reference.
 * Safe to call multiple times — singleton guard prevents double-installation.
 *
 * @param {Object} SHARC - The window.SHARC object (from sharc-creative.js)
 */
function installMRAIDBridge(SHARC) {
  // Singleton guard - cast window.mraid to any to allow access to _sharcBridgeInstalled property
  if (window.mraid && /** @type {any} */ (window.mraid)._sharcBridgeInstalled) {
    return; // Already installed; bail silently
  }

  // ── NEW-002: Bridge-owned MRAID_ENV initialization ─────────────────────
  // Bridge owns MRAID_ENV entirely. Create a safe default object synchronously
  // so that any writes in onReady cannot silently crash if the object is absent.
  // Runtime values (appId, ifa, etc.) are enriched in onReady below.
  // TODO: enrich publisherContext fields (pageUrl, domain, bundleId, platform) from Container:init env data in v2
  window.MRAID_ENV = window.MRAID_ENV || {
    version: '3.0',
    // Obvious test placeholders — real integrations override these before bridge load.
    // Production hosts supply their own sdk/sdkVersion (e.g., "Google Mobile Ads" / "11.2.0").
    sdk: 'TestAdSDK',
    sdkVersion: '0.0.0',
    appId: '',
    ifa: '',
    limitAdTracking: false,
    coppa: false,
    publisherPageUrl: '',
    publisherDomain: '',
    publisherBundleId: '',
    publisherPlatform: '',
  };

  // SEC-004: Warn when placeholder SDK metadata is still in place on a
  // production-ish host. Test harnesses running on localhost / file:// /
  // *.local stay silent; anywhere else emits once per page load so a
  // misconfigured staging or production deployment is visible in devtools.
  (function warnOnPlaceholderMraidEnv() {
    const env = window.MRAID_ENV;
    if (!env) return;
    if (env.sdk !== 'TestAdSDK' && env.sdkVersion !== '0.0.0') return;
    const host = (typeof location !== 'undefined' && location.hostname) || '';
    const proto = (typeof location !== 'undefined' && location.protocol) || '';
    const isDevHost =
      proto === 'file:' ||
      host === '' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local');
    if (isDevHost) return;
    console.warn(
      '[SHARC MRAID bridge] MRAID_ENV is using placeholder SDK metadata ' +
      '(sdk="' + env.sdk + '", sdkVersion="' + env.sdkVersion + '"). ' +
      'Set window.MRAID_ENV with real host SDK values before loading the bridge in production.'
    );
  }());

  // ── Private bridge state (§5 Internal Bridge State) ───────────────────
  const _s = {
    _sharcState:    'loading',   // Last known SHARC state (axis-1 bookkeeping only)
    _placementMode: 'default',   // 'default' | 'expanded' | 'resized'
    _mraidReady:    false,       // true after Container:init processed
    _isViewable:    false,       // cached; changes drive viewableChange event
    _closed:        false,       // terminal latch (Slice D): true after container close
                                 // or stateChange('terminated') — the ONLY source of
                                 // MRAID 'hidden'; latching, never cleared
    _lastEffective: undefined,   // last effectiveVisibilityChange payload (Slice D):
                                 // {effectivePercent, reason, visibleRectangle}
    _lastError:     undefined,   // last 'error' args [msg, action] emitted (Slice E1,
                                 // #389): latched so a listener attached after a
                                 // rejected expand/resize is replayed the error once on
                                 // registration. undefined = no error fired yet.
    _env:           null,        // EnvironmentData from Container:init
    _placementType: 'inline',    // derived at init
    _listeners:     {},          // MRAID event listeners: eventName → [fn, ...]
    _expandProps: {
      width:          -1,
      height:         -1,
      useCustomClose: false,
      isModal:        true,
    },
    _resizeProps: {
      width:               0,
      height:              0,
      offsetX:             0,
      offsetY:             0,
      customClosePosition: 'top-right',
      allowOffscreen:      true,
    },
    _currentPosition: { x: 0, y: 0, width: 0, height: 0 },
    _initialPosition: null, // Populated from Container:init initialPosition; updated by placementChange
    // ── Lifecycle-binding state (#393) ────────────────────────────────────
    // The bridge maps continuous SHARC lifecycle signals → MRAID events at
    // their real moments rather than snapshotting them once at init. These
    // latches track the two-phase startup geometry (placeholder at ready →
    // real on the first post-ready placementChange — MoPub S1→S3) and the
    // in-flight placement intent used to drive stateChange off placementChange
    // instead of the requestPlacementChange().then() microtask (RISK-4).
    _readyFired:        false,       // true once 'ready' (S2) has emitted
    _realGeometrySeen:  false,       // true once the first post-ready real-geometry sizeChange (S3) fired
    _pendingPlacementMode: null,     // 'expanded' | 'resized' | 'default' — intent awaiting its placementChange
    // ── Adapter-level dedup state (#343) ──────────────────────────────────
    // The SHARC→MRAID mapping collapses distinct SHARC states into identical
    // MRAID states (active and passive both → 'default'), and source events
    // can repeat identical volume/size. Track the last value EMITTED on each
    // value-typed MRAID channel so consecutive-identical notifications are
    // suppressed — the same "no redundant consecutive identical lifecycle
    // notification" invariant the SHARC channel enforces, applied per adapter
    // output. undefined = nothing emitted yet (first emit always flows).
    _lastMraidState:       undefined, // last MRAID state emitted via stateChange
    _lastVolumePercentage: undefined, // last volumePercentage emitted via audioVolumeChange
    _lastSizeW:            undefined, // last width emitted via sizeChange
    _lastSizeH:            undefined, // last height emitted via sizeChange
    _lastExposure:         undefined, // last exposedPercentage emitted via exposureChange (#341)
    // MRAID setOrientationProperties() is a synchronous setter paired with a
    // getOrientationProperties() reader. Store the last value so the getter
    // reflects it (was a hardcoded {none,true} no-op) and forward it to the
    // container host via SHARC.requestOrientationProperties so an embedding host
    // can drive the device orientation lock.
    _orientationProperties: { allowOrientationChange: true, forceOrientation: 'none' },
  };

  // ── Internal event emitter (§8.2) ─────────────────────────────────────
  /**
   * Emits an MRAID event to all registered listeners.
   * Swallows listener exceptions so one bad listener can't block others.
   * @param {string} event
   * @param {...*} args
   */
  function _emit(event, ...args) {
    // Slice E1 (#389): latch the last 'error' args at the single emission point
    // (all reject paths route through here) so a late-attaching listener can be
    // replayed the error on registration — the "replayable per the late-listener
    // mechanism" remainder of #389. Latched BEFORE the zero-listener early-return
    // so an error fired with no listeners attached (the classic hang scenario) is
    // still replayable to a listener that attaches later. Mirrors the stateChange
    // last-value cache (_lastMraidState).
    if (event === 'error') _s._lastError = args;
    const listeners = _s._listeners[event];
    if (!listeners || listeners.length === 0) return;
    // Copy array to avoid mutation issues during iteration
    listeners.slice().forEach(function (fn) {
      try { fn.apply(null, args); } catch (e) { /* swallow — §8.2 */ }
    });
  }

  /**
   * Emits MRAID 'stateChange' with consecutive-identical dedup (#343).
   *
   * MRAID stateChange must fire only on an actual MRAID-state change. Because
   * SHARC `active` and `passive` both map to MRAID `'default'`, firing
   * unconditionally would emit `stateChange('default')` twice across a SHARC
   * `active→passive` transition. This is the single emission point for every
   * MRAID stateChange (onReady seed, SHARC stateChange handler, expand,
   * collapse, resize) so the invariant holds regardless of the trigger path.
   * @param {string} mraidState
   */
  function _emitStateChange(mraidState) {
    if (mraidState === _s._lastMraidState) return;
    _s._lastMraidState = mraidState;
    _emit('stateChange', mraidState);
  }

  /**
   * Emits MRAID 3.0 §4.7 'exposureChange' with consecutive-identical dedup (#341).
   *
   * Slice D (Δ2/Δ3): exposedPercentage is the CONTINUOUS composed integer from
   * the effective-visibility surface (`_s._lastEffective.effectivePercent`) —
   * the one number every consumer tier reports (L-11). visibleRectangle policy
   * (G6-deferred; the wire carries null on web):
   *   - 100   → full own-rect {x:0,y:0,w,h} from _currentPosition (exact by
   *             definition at full exposure; container-sourced — D-5 clean)
   *   - 1–99  → null (honest-null over fabricated geometry)
   *   - 0     → null
   * occlusionRectangles is always null (SHARC does not model occlusion).
   *
   * Same consecutive-identical dedup discipline (#343/#348) as the other
   * value-typed adapter channels: a repeated identical exposedPercentage is
   * NOT a notification. undefined = nothing emitted yet (first emit flows).
   */
  function _emitExposureChange() {
    var exposedPercentage = _s._lastEffective ? _s._lastEffective.effectivePercent : 0;
    if (exposedPercentage === _s._lastExposure) return;
    _s._lastExposure = exposedPercentage;
    var visibleRectangle = exposedPercentage === 100
      ? {
          x: 0,
          y: 0,
          width: _s._currentPosition.width,
          height: _s._currentPosition.height,
        }
      : null;
    _emit('exposureChange', exposedPercentage, visibleRectangle, null);
  }

  /**
   * Applies the cached effective-visibility payload to the MRAID surface
   * (Slice D): viewability = effectivePercent >= 50 (EV-7 crossing), then
   * exposure = the continuous integer. Both channels keep their own dedup, so
   * a reason-only change (e.g. backgrounded→frozen, Δ9) emits nothing — the
   * old frozen special-case branch is now structural.
   */
  function _applyEffectiveVisibility() {
    // CR-1 (ratified 2026-07-04): a latched bridge never re-applies EV — this
    // guards the onReady tail against a replay cached before a pre-ready
    // close/terminate (the live EV handler has its own `_closed` gate).
    if (_s._closed) return;
    if (!_s._lastEffective) return;
    var viewable = _s._lastEffective.effectivePercent >= 50;
    if (viewable !== _s._isViewable) {
      _s._isViewable = viewable;
      _emit('viewableChange', viewable);
    }
    _emitExposureChange();
  }

  /**
   * Terminal teardown latch (ratified 2026-07-04 review round; #414 fatal
   * caller folded in 2026-07-05, Slice E2).
   *
   * The `_closed` latch has exactly ONE assignment site — this function
   * (E-3: no third `_closed = true` write without re-ratification). Its
   * sanctioned callers are the SHARC 'close' handler, the
   * stateChange('terminated') branch, and (ratified E-3, #414) the
   * 'containerError' fatal handler — every terminal signal funnels through
   * this single latch/emission path rather than writing `_closed` directly.
   * Emission order per MRAID
   * 3.0 §7.5 (teardown IS an exposure change — "hiding an interstitial" is
   * the spec's own example; exposed → out of view ⇒ exposureChange(0)):
   *
   *   latch → stateChange('hidden') → exposureChange(0, null, null) →
   *   viewableChange(false) iff it was true
   *
   * The exposure source is zeroed at the latch — the composed teardown value
   * is 0 by definition regardless of the cached EV — and the final 0 rides
   * the existing dedup, so an ad already at exposure 0 emits nothing. This
   * never re-enables EV processing: both the live EV handler and
   * _applyEffectiveVisibility drop everything once `_closed` (no
   * resurrection). Every emitter dedups, so a repeat latch (e.g. 'terminated'
   * delivered after close) emits nothing.
   */
  function _latchClosed() {
    _s._closed = true;
    _emitStateChange(getMraidState(_s));
    _s._lastEffective = { effectivePercent: 0, reason: null, visibleRectangle: null };
    _emitExposureChange();
    if (_s._isViewable) {
      _s._isViewable = false;
      _emit('viewableChange', false);
    }
  }

  /**
   * ACTIVE-transition audio resync (#390).
   *
   * A creative preloaded in READY/HIDDEN buffers its audio state in env (the
   * container buffers READY/HIDDEN audio in environmentData and delivers it on
   * the ACTIVE transition via its own _syncAudioState). A creative that only
   * attaches its audioVolumeChange listener at the first interactive frame
   * would otherwise miss that pre-listener delivery. On the ACTIVE transition
   * the bridge re-fires the MRAID audioVolumeChange event from the buffered
   * env audio — mirroring the container's _syncAudioState / _syncPlacementState
   * / _syncEffectiveVisibility ACTIVE-transition re-push. No-op when audio was
   * never established (env.volumePercentage/isMuted undefined), matching the
   * container guard. isAudioMuted() already reads env live; this closes the
   * event-delivery half.
   */
  function _resyncAudioState() {
    if (!_s._env) return;
    if (_s._env.volumePercentage === undefined || _s._env.isMuted === undefined) return;
    _emit('audioVolumeChange', { volumePercentage: _s._env.volumePercentage });
  }

  /**
   * Re-measures the creative frame's own viewport geometry (RISK-2).
   *
   * Used by the constraintsChange handler to recur sizeChange on orientation /
   * window-resize, which SHARC signals without geometry. Returns {width,height}
   * from window.innerWidth/innerHeight, or null when no measurable viewport
   * exists (non-browser test host) so the caller can no-op.
   * @returns {{width:number, height:number}|null}
   */
  function _measureViewportRect() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    if (typeof w !== 'number' || typeof h !== 'number') return null;
    return { width: w, height: h };
  }

  // ── SHARC event wiring ─────────────────────────────────────────────────

  /**
   * Fires the canonical MoPub S1→S2 ready burst — the ONE emission site for the
   * `loading→default` `stateChange('default')` flip, the placeholder sizeChange,
   * and `ready`. Gated by `_s._readyFired` so it runs at most once regardless of
   * how many times its two triggers (Container:init, document 'load') arrive.
   *
   * Slice E3 (#392, ratified 2026-07-05): the burst fires only when BOTH
   *   (1) Container:init has been received (env-ready — `_s._env` populated), AND
   *   (2) the creative document is load-complete
   * hold. This helper is the "both conditions met" point; its two callers gate on
   * their own half and invoke it when the other half is (or becomes) satisfied.
   *
   *   S1  stateChange('default')  — pre-ready, fired FIRST (§3.1 step 9a → 9b)
   *   S1  sizeChange(w,h)         — placeholder geometry from initialDefaultSize;
   *                                 positions are placeholder zeros at this point
   *   S2  ready                   — AFTER the default+placeholder burst
   *
   * Real geometry (MoPub S3) arrives later on the first post-ready placementChange
   * as a DISTINCT sizeChange — see the placementChange handler; unchanged by E3.
   */
  function _fireReadyBurst() {
    if (_s._readyFired) return;      // double-fire guard (either trigger, any repeat)
    if (!_s._env) return;            // condition 1 not yet met — Container:init pending

    // getState() stays 'loading' until this moment: _mraidReady flips HERE, inside
    // the gated burst, not eagerly at Container:init — so a bridge whose document
    // is still parsing reads 'loading' (E3 contract), and getMraidState() seeds
    // 'default' correctly below.
    _s._mraidReady = true;

    // ── S1 — pre-ready env burst (stateChange('default') BEFORE ready) ──────
    // §3.1 step 9 orders 9a (state→default) before 9b (ready); the prior bridge
    // inverted this. The placeholder sizeChange carries initialDefaultSize while
    // positions are still the placeholder zeros set at onReady (MoPub S1).
    // CR-1 (ratified 2026-07-04): derived, never hardcoded 'default' — a
    // close/terminate delivered before ready has latched terminal 'hidden',
    // and getMraidState reads it back; the dedup absorbs the repeat of the
    // latch-time emission, so a latched bridge seeds NOTHING (no resurrection).
    _emitStateChange(getMraidState(_s));
    var initSize = (_s._env.currentPlacement && _s._env.currentPlacement.initialDefaultSize) || {};
    var phW = initSize.width || 0;
    var phH = initSize.height || 0;
    _s._lastSizeW = phW;
    _s._lastSizeH = phH;
    _emit('sizeChange', phW, phH);

    // ── S2 — ready, anchored to document-load-complete (#392, Slice E3) ──────
    _s._readyFired = true;
    _emit('ready');

    // Slice D ready-gating tail: a pre-ready effectiveVisibilityChange replay
    // (delivered at install-time subscribe) was cached silently; apply it once
    // now, strictly AFTER the S1/S2 burst. Channel dedup makes a later
    // identical live delivery a no-op.
    _applyEffectiveVisibility();
  }

  /**
   * Resolves whether the creative document is load-complete, and if not,
   * registers a one-shot deferral so the ready burst fires when it becomes so.
   *
   * Slice E3 (#392): mirrors the Slice A load-anchor pattern used by the
   * renderer/creative — a one-shot `window 'load'` listener PLUS a
   * `readyState === 'complete'` immediate-fire path. `document` here is the
   * CREATIVE's own document (the bridge runs in the creative realm; `window`
   * throughout this file is the creative-frame window, so `window.document` is
   * its document). Guards for a non-browser host (test/SSR) where `document` is
   * absent: with no document to gate on, there is no load milestone to wait for,
   * so treat env-ready as sufficient and fire now — this keeps pure-adapter
   * hosts working and never strands `ready`.
   */
  function _gateReadyOnDocumentLoad() {
    var doc = (typeof window !== 'undefined' && window.document) || null;

    // No document in this realm (non-browser adapter host): nothing to anchor to.
    if (!doc || typeof doc.readyState === 'undefined') {
      _fireReadyBurst();
      return;
    }

    // Condition 2 already satisfied — fire in this turn (the common case: the
    // Container:init round-trip lands after the creative document completes).
    if (doc.readyState === 'complete') {
      _fireReadyBurst();
      return;
    }

    // Document still parsing / subresources loading — DEFER to the inner
    // document's window 'load'. One-shot; `_fireReadyBurst`'s own `_readyFired`
    // guard is the belt-and-suspenders against a double dispatch.
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('load', function onCreativeLoad() {
        _fireReadyBurst();
      }, { once: true });
    }
  }

  /**
   * SHARC.onReady — fires when Container:init is received.
   *
   * This is the MRAID-environment-ready handshake (#392): env, placement type,
   * supports, sizes and state are populated here. It satisfies condition 1 of the
   * ready gate (env-ready); the burst itself is deferred to document-load-complete
   * (condition 2) via `_gateReadyOnDocumentLoad` — the ratified E3 anchor. Neither
   * final geometry (placeholder zeros ride ready, §3.2 two-phase) nor `ready`
   * itself fires here unless the document is already load-complete.
   *
   * Must resolve quickly — SHARC container waits on this (§8.3).
   */
  SHARC.onReady(function (env) {
    _s._env = env || {};
    _s._placementType = derivePlacementType(_s._env);

    // Placeholder positions until the first post-ready placementChange measures
    // real geometry (MoPub S1: setCurrentPosition(0,0,0,0)). getCurrentPosition()
    // may legitimately still read these zeros at ready (§3.2 two-phase geometry).
    _s._currentPosition = { x: 0, y: 0, width: 0, height: 0 };

    _s._sharcState = 'ready';

    // Store initialPosition from Container:init (Priority 2 — container position injection)
    if (env && env.initialPosition) {
      _s._initialPosition = {
        x: env.initialPosition.x || 0,
        y: env.initialPosition.y || 0,
        width: env.initialPosition.width || 0,
        height: env.initialPosition.height || 0,
      };
    }

    // Enrich MRAID_ENV with runtime values from Container:init (architect: hybrid approach)
    var appInfo = (env && env.data && env.data.app) || {};
    window.MRAID_ENV.appId = appInfo.bundle || '';
    window.MRAID_ENV.ifa = (env && env.ifa) || '';
    window.MRAID_ENV.limitAdTracking = !!(env && env.lmt);
    window.MRAID_ENV.coppa = !!(env && env.coppa);

    // Publisher context — supply chain integrity (SHARC extension; MRAID 3.0 §2.1 empty-string pattern)
    var _pc = (env && env.publisherContext) || {};
    window.MRAID_ENV.publisherPageUrl  = _pc.pageUrl   || '';
    window.MRAID_ENV.publisherDomain   = _pc.domain    || '';
    window.MRAID_ENV.publisherBundleId = _pc.bundleId  || '';
    window.MRAID_ENV.publisherPlatform = _pc.platform  || '';

    // ── #392 (Slice E3) — anchor the ready burst to document-load-complete ──
    // Condition 1 (env-ready) is now met. Fire the S1→S2 burst iff condition 2
    // (creative document load-complete) also holds; otherwise defer to window
    // 'load'. The ORDER within the burst (stateChange('default') → ready) and
    // everything downstream (post-ready sizeChange, viewable, two-phase geometry)
    // are unchanged — only the ANCHOR MOMENT moves.
    _gateReadyOnDocumentLoad();
    // Resolve immediately — no return value needed; SHARC API handles Promise wrapping
  });

  /**
   * SHARC.onStart — fires when Container:startCreative is received.
   * No MRAID equivalent; resolve immediately.
   */
  SHARC.onStart(function () {
    // No MRAID mapping for startCreative; just resolve
  });

  /**
   * SHARC stateChange — axis-1 bookkeeping only (Slice D).
   *
   * Viewability and exposure no longer ride the lifecycle enum — they ride the
   * bridge's effectiveVisibilityChange subscription (L-10: state and visibility
   * are different axes). The enum's residual roles here:
   *   - track `_sharcState` for bookkeeping,
   *   - latch `_closed` on 'terminated' via _latchClosed (a sanctioned latch
   *     caller alongside the SHARC 'close' and 'containerError' handlers; the
   *     single `_closed = true` assignment lives in _latchClosed — E-3, no
   *     direct write) so a previously-delivered ad maps to terminal 'hidden'
   *     instead of falling through to 'default' (Δ6 bug fix),
   *   - re-derive the (placement-axis) MRAID state through the dedup'd emitter.
   */
  SHARC.on('stateChange', function (sharcState) {
    _s._sharcState = sharcState;

    if (sharcState === 'terminated') {
      // Sanctioned latch caller — full teardown emission order lives in
      // _latchClosed (ratified 2026-07-04: hidden → exposureChange(0) →
      // viewableChange(false) iff was-true). Deduped, so a repeat delivery
      // emits nothing.
      _latchClosed();
      return;
    }

    // #390 — ACTIVE-transition audio resync. A creative preloaded in
    // READY/HIDDEN receives its current audio here, mirroring the container's
    // _syncAudioState re-push. No-op if audio was never established; the
    // audioVolumeChange emit runs before the deduped stateChange below.
    if (sharcState === 'active') {
      _resyncAudioState();
    }

    // Deduped: enum visibility states all map to the same placement-axis MRAID
    // state, so hidden/frozen/active/passive deliveries emit nothing (#343/Δ5)
    // — and once `_closed`, this reads the terminal 'hidden' and dedups too.
    _emitStateChange(getMraidState(_s));
  });

  /**
   * SHARC effectiveVisibilityChange — the ONE visibility surface (Slice D).
   *
   * The creative bus replays the last payload at subscribe, which precedes
   * onReady — so the handler always caches, and emission is gated on
   * `_readyFired` (T8/HB-7: ready + stateChange('default') strictly before the
   * first viewableChange). The onReady tail applies a pending cached payload
   * once. Once `_closed`, deliveries are ignored entirely (no resurrection).
   */
  SHARC.on('effectiveVisibilityChange', function (payload) {
    if (_s._closed) return;
    _s._lastEffective = payload;
    if (!_s._readyFired) return; // cached silently; applied after the ready burst
    _applyEffectiveVisibility();
  });

  /**
   * SHARC placementChange — maps to MRAID sizeChange.
   *
   * Updates _currentPosition (live position, returned by getCurrentPosition()).
   * Does NOT touch _initialPosition: that is the MRAID "default position"
   * anchor used for resize offset calculations and must remain immutable for
   * the lifetime of a session. It is set exactly once from
   * Container:init env.initialPosition (see SHARC.onReady above).
   *
   * Why this matters (issue #20): an earlier version of this listener
   * overwrote _initialPosition from placementUpdate.position. After a
   * resize+collapse cycle, the post-collapse iframe rect could land at a
   * different page-relative position (long publisher page, page scroll,
   * normal-flow re-anchoring). Subsequent resizes then targeted that drifted
   * anchor, sometimes overflowing the viewport, where the container correctly
   * rejected the request and the bridge silently swallowed the error — the
   * vendor MRAID compliance ad's resize-positive suite cascaded into 6
   * timeout failures because of this.
   */
  SHARC.on('placementChange', function (placementUpdate) {
    if (!placementUpdate) return;
    // The container enriches the payload with the live getBoundingClientRect()
    // rect under `position` (container:_buildPlacementChangePayload). That is the
    // real measured geometry (x/y/width/height); the top-level width/height are
    // the placement dimensions and carry no x/y. Prefer the measured rect, fall
    // back to top-level dims for hosts that send a bare placement.
    var pos = placementUpdate.position || {};
    var w = (pos.width != null ? pos.width : placementUpdate.width) || 0;
    var h = (pos.height != null ? pos.height : placementUpdate.height) || 0;
    _s._currentPosition = {
      x: (pos.x != null ? pos.x : placementUpdate.x) || 0,
      y: (pos.y != null ? pos.y : placementUpdate.y) || 0,
      width: w,
      height: h,
    };

    // Two-phase geometry (#393, MoPub S3): the FIRST post-ready placementChange
    // is the real-geometry fire that supersedes the placeholder S1 sizeChange.
    // Force it through even if w/h coincide with the placeholder so a creative
    // waiting on real geometry always gets a distinct post-ready sizeChange.
    var isFirstRealGeometry = _s._readyFired && !_s._realGeometrySeen;
    if (isFirstRealGeometry) _s._realGeometrySeen = true;

    // §3.2 chained-event ordering: when this placementChange settles an in-flight
    // placement intent, update geometry FIRST, then emit sizeChange, then
    // stateChange — all from this single site so getCurrentPosition() reflects
    // the new rect inside the stateChange handler. Driving stateChange here (off
    // the placementChange macrotask) instead of off requestPlacementChange().then()
    // (a microtask that runs before this message) fixes the ordering race (RISK-4).
    var pendingMode = _s._pendingPlacementMode;

    // Same-value guard (#343): a position-only move (same w,h) must NOT re-fire
    // sizeChange — UNLESS this is the first real-geometry fire or it settles a
    // placement intent, both of which are real lifecycle moments.
    var sizeUnchanged = (w === _s._lastSizeW && h === _s._lastSizeH);
    if (!sizeUnchanged || isFirstRealGeometry || pendingMode) {
      _s._lastSizeW = w;
      _s._lastSizeH = h;
      _emit('sizeChange', w, h);
    }

    // Placement-mode sync (creative-initiated path): when this placementChange
    // settles an in-flight intent the bridge raised, commit the mode and emit
    // stateChange here (off the placementChange macrotask) so getCurrentPosition()
    // reflects the new rect inside the handler.
    //
    // Operator-initiated path (#391): when there is no pending creative request, derive the
    // placement mode from the intent the container now carries on the placementChange payload
    // (container:notifyPlacementChange). This closes the gap where a placement change the
    // creative did NOT request — most notably the container's own dismiss button collapsing an
    // expand — updated geometry/sizeChange but left getState() stale. A collapse (intent null)
    // returns the creative to 'default'; expand/fullscreen → 'expanded'; resize → 'resized'.
    if (pendingMode) {
      _s._pendingPlacementMode = null;
      _s._placementMode = pendingMode;
      _emitStateChange(getMraidState(_s));
    } else if (placementUpdate.intent !== undefined) {
      var operatorMode =
        (placementUpdate.intent === 'expand' || placementUpdate.intent === 'fullscreen') ? 'expanded'
        : (placementUpdate.intent === 'resize') ? 'resized'
        : 'default';
      if (operatorMode !== _s._placementMode) {
        _s._placementMode = operatorMode;
        _emitStateChange(getMraidState(_s));
      }
    }
  });

  /**
   * SHARC constraintsChange — orientation / window-resize re-measure (RISK-2).
   *
   * §7.3 requires sizeChange to RECUR on orientation change, but the SHARC
   * constraintsChange payload carries only {maxWidth,maxHeight,reason} — no
   * geometry, and it does NOT drive placementChange (container:_sendConstraints
   * Change). So an orientation rotation would otherwise never re-fire MRAID
   * sizeChange. The bridge re-reads its own viewport geometry here (the creative
   * frame's post-rotation size — the bridge is a pure window.SHARC adapter and
   * does not reach into container internals) and emits a recurring sizeChange.
   * Deduped on (w,h) like every other size source: a constraints update that
   * does not change the measured size is not a notification.
   */
  SHARC.on('constraintsChange', function () {
    if (!_s._mraidReady) return;
    var rect = _measureViewportRect();
    if (rect == null) return;
    if (rect.width === _s._lastSizeW && rect.height === _s._lastSizeH) return;
    _s._currentPosition = {
      x: _s._currentPosition.x,
      y: _s._currentPosition.y,
      width: rect.width,
      height: rect.height,
    };
    _s._lastSizeW = rect.width;
    _s._lastSizeH = rect.height;
    _emit('sizeChange', rect.width, rect.height);
  });

  /**
   * SHARC audioVolumeChange — maps to MRAID 3.0 §4.6 audioVolumeChange event.
   *
   * Receives all 3 fields: { volumePercentage, volume, isMuted }.
   * Updates _s._env.isMuted and _s._env.volume INDEPENDENTLY.
   * isMuted is sourced directly from the payload — NOT derived from volumePercentage.
   */
  SHARC.on('audioVolumeChange', function (args) {
    // Update env independently — isMuted is NEVER derived from volumePercentage.
    // (Kept outside the dedup guard so isAudioMuted() stays live even when the
    // reported volumePercentage is unchanged.)
    _s._env.isMuted = args.isMuted;
    _s._env.volume  = args.volume;
    // Buffer the raw volumePercentage on env so the ACTIVE-transition resync
    // (#390 _resyncAudioState) can re-fire the current audio to a listener that
    // attached during preload (READY/HIDDEN). Mirrors the container's
    // environmentData.volumePercentage buffer.
    _s._env.volumePercentage = args.volumePercentage;
    // Same-value guard (#343): a repeated identical volumePercentage must NOT
    // re-fire audioVolumeChange. Only an actual change is a notification.
    if (args.volumePercentage === _s._lastVolumePercentage) return;
    _s._lastVolumePercentage = args.volumePercentage;
    // Fire MRAID audioVolumeChange listeners per MRAID 3.0 §4.6
    _emit('audioVolumeChange', { volumePercentage: args.volumePercentage });
  });

  /**
   * SHARC close — terminal teardown (§8.8 + Slice D).
   *
   * A sanctioned caller of the `_closed` latch (alongside
   * stateChange('terminated') and, post-#414, 'containerError'); the single
   * `_closed = true` assignment lives in _latchClosed (E-3, no direct write).
   * Order per the ratified review-round ruling: latch → stateChange('hidden')
   * (MRAID 3.0 §7.3.3) → exposureChange(0) (§7.5) → viewableChange(false) iff
   * it was true → 'unload' (close path only).
   */
  SHARC.on('close', function () {
    _latchClosed();
    _emit('unload');
    // sharc-creative.js manages the watchdog and resolves Container:close.
  });

  /**
   * SHARC containerError — container fatal-error teardown (#414, ratified E-3).
   *
   * The wire's terminal signal on a container fatal error is delivered
   * creative-side as `containerError` (sharc-creative.js Container:fatalError →
   * _emit('containerError')); 'terminated' never rides the wire (INV-12) and
   * post-Slice-D the bridge no longer treats wire 'hidden' as terminal (Δ5).
   * Route the fatal signal through the EXISTING _latchClosed() so getState()
   * reads 'hidden' and isViewable() is forced false for the ≤1s teardown
   * window — this adds NO new `_closed = true` assignment (E-3: the sole
   * assignment stays inside _latchClosed; this is a third sanctioned latch
   * caller, not a third write site). Deduped, so it is safe alongside a later
   * close/terminated. No 'unload' here (fatal ≠ creative-initiated).
   */
  SHARC.on('containerError', function () {
    _latchClosed();
  });

  // ── window.mraid public API ────────────────────────────────────────────

  var mraid = {

    // Mark as bridge-installed for singleton guard
    _sharcBridgeInstalled: true,

    // ── Version ────────────────────────────────────────────────────────

    /** @returns {string} Always "3.0" (§6.6) */
    getVersion: function () {
      return '3.0';
    },

    // ── State ──────────────────────────────────────────────────────────

    /**
     * Returns the current MRAID state.
     * Derived from _sharcState + _placementMode (§2).
     * @returns {'loading'|'default'|'expanded'|'resized'|'hidden'}
     */
    getState: function () {
      return getMraidState(_s);
    },

    /**
     * Returns whether the ad is currently viewable.
     * Slice D (EV-7): true when the composed effectivePercent >= 50; forced
     * false once `_closed`. Never derived from the lifecycle enum.
     * @returns {boolean}
     */
    isViewable: function () {
      return _s._isViewable;
    },

    // ── Placement ──────────────────────────────────────────────────────

    /**
     * Returns the placement type.
     * Derived from AdCOM placement.instl at init (§6.1).
     * Returns 'inline' before ready.
     * @returns {'inline'|'interstitial'}
     */
    getPlacementType: function () {
      return /** @type {'inline'|'interstitial'} */ (_s._placementType);
    },

    /**
     * Returns the default/initial position of the container.
     * @returns {{x:number, y:number, width:number, height:number}}
     */
    getDefaultPosition: function () {
      if (!_s._env || !_s._env.currentPlacement) {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      var size = _s._env.currentPlacement.initialDefaultSize || {};
      // §6.6 (#395): real captured default position. x/y come from the
      // Container:init _initialPosition (the ad's true default origin); w/h
      // from initialDefaultSize. Falls back to 0 only when init did not carry
      // a position.
      var pos = _s._initialPosition || {};
      return { x: pos.x || 0, y: pos.y || 0, width: size.width || 0, height: size.height || 0 };
    },

    /**
     * Returns the current position and size (updated via placementChange).
     * @returns {{x:number, y:number, width:number, height:number}}
     */
    getCurrentPosition: function () {
      return {
        x: _s._currentPosition.x,
        y: _s._currentPosition.y,
        width: _s._currentPosition.width,
        height: _s._currentPosition.height,
      };
    },

    /**
     * Returns the maximum size available for expansion.
     * @returns {{width:number, height:number}}
     */
    getMaxSize: function () {
      if (!_s._env || !_s._env.currentPlacement) return { width: 0, height: 0 };
      var size = _s._env.currentPlacement.maxExpandSize || {};
      return { width: size.width || 0, height: size.height || 0 };
    },

    /**
     * Returns the viewport/screen size.
     * @returns {{width:number, height:number}}
     */
    getScreenSize: function () {
      if (!_s._env || !_s._env.currentPlacement) return { width: 0, height: 0 };
      var size = _s._env.currentPlacement.viewportSize || {};
      return { width: size.width || 0, height: size.height || 0 };
    },

    // ── Expand Properties ──────────────────────────────────────────────

    /**
     * Returns the current expand properties.
     * @returns {{width:number, height:number, useCustomClose:boolean, isModal:boolean}}
     */
    getExpandProperties: function () {
      return {
        width:          _s._expandProps.width,
        height:         _s._expandProps.height,
        useCustomClose: _s._expandProps.useCustomClose,
        isModal:        true, // always true; cannot be changed
      };
    },

    /**
     * Stores expand properties for use on expand().
     * Only width/height are acted upon; useCustomClose is stored but no-op (§6.3).
     * isModal is always forced to true.
     * @param {{width?:number, height?:number, useCustomClose?:boolean}} props
     */
    setExpandProperties: function (props) {
      if (!props) return;
      if (typeof props.width === 'number')  _s._expandProps.width  = props.width;
      if (typeof props.height === 'number') _s._expandProps.height = props.height;
      if (typeof props.useCustomClose === 'boolean') {
        _s._expandProps.useCustomClose = props.useCustomClose; // stored, ignored
      }
      // isModal always remains true
    },

    // ── Resize Properties (stored; consumed by resize()) ────────────────

    /**
     * Returns stored resize properties.
     * @returns {{width:number, height:number, offsetX:number, offsetY:number,
     *            customClosePosition:string, allowOffscreen:boolean}}
     */
    getResizeProperties: function () {
      return {
        width:               _s._resizeProps.width,
        height:              _s._resizeProps.height,
        offsetX:             _s._resizeProps.offsetX,
        offsetY:             _s._resizeProps.offsetY,
        customClosePosition: _s._resizeProps.customClosePosition,
        allowOffscreen:      _s._resizeProps.allowOffscreen,
      };
    },

    /**
     * Stores resize properties with full MRAID 3.0 §4.4.3 validation.
     * Fires 'error' event for invalid inputs rather than silently accepting.
     * @param {Object} props
     */
    setResizeProperties: function (props) {
      // Test 3: undefined/null
      if (!props || typeof props !== 'object') {
        _emit('error', 'setResizeProperties requires a properties object', 'setResizeProperties');
        return;
      }
      // Test 4-5: width and height are required
      if (typeof props.width !== 'number' || typeof props.height !== 'number') {
        _emit('error', 'setResizeProperties requires numeric width and height', 'setResizeProperties');
        return;
      }
      // Test 6: non-numeric type mismatch (handled above — strings fail typeof check)
      // Test 5 (min 50×50): dimensions must be at least 50×50
      if (props.width < 50 || props.height < 50) {
        _emit('error', 'Resize dimensions must be at least 50x50', 'setResizeProperties');
        return;
      }
      // NEW-003: Skip max-size validation if max size is stale (0×0 — not yet initialized)
      // This happens when setResizeProperties is called before Container:init completes.
      var maxSize = mraid.getMaxSize();
      if (maxSize.width > 0 && maxSize.height > 0) {
        if (props.width > maxSize.width || props.height > maxSize.height) {
          _emit('error', 'Resize dimensions exceed maximum size', 'setResizeProperties');
          return;
        }
      }
      // Close button onscreen validation removed — container owns close button rendering
      // and will override the hint to a visible default if it would be offscreen.
      // See architecture-placement-changes.md ADR-PC-001.

      // Store validated properties
      _s._resizeProps.width  = props.width;
      _s._resizeProps.height = props.height;
      if (typeof props.offsetX === 'number') _s._resizeProps.offsetX = props.offsetX;
      if (typeof props.offsetY === 'number') _s._resizeProps.offsetY = props.offsetY;
      if (typeof props.customClosePosition === 'string') {
        _s._resizeProps.customClosePosition = props.customClosePosition;
      }
      if (typeof props.allowOffscreen === 'boolean') {
        _s._resizeProps.allowOffscreen = props.allowOffscreen;
      }
    },

    // ── Actions ────────────────────────────────────────────────────────

    /**
     * Expands the ad to maximum available space.
     * If expandProperties.width/height > 0, uses intent:'resize' with those dimensions.
     * Otherwise uses intent:'expand'.
     *
     * The url parameter is NOT supported (§6.2) — fires error if provided.
     * Idempotent: no-op if already expanded (§8.5).
     *
     * @param {string} [url] - NOT supported
     */
    expand: function (url) {
      // MRAID 3.0 §4.4.5: expand() is inline-only; interstitials must error.
      if (_s._placementType === 'interstitial') {
        _emit('error', 'expand is not supported for interstitial placements', 'expand');
        return;
      }
      // Guard: url arg not supported (§6.2)
      if (url) {
        _emit('error', 'Two-part expand (expand URL) is not supported by this bridge', 'expand');
        return;
      }

      // Idempotency guard (§8.5)
      if (_s._placementMode === 'expanded') return;

      // Determine placement change intent
      var requestArgs;
      var ep = _s._expandProps;
      if (ep.width > 0 && ep.height > 0) {
        requestArgs = {
          intent: 'resize',
          targetDimensions: { width: ep.width, height: ep.height },
        };
      } else {
        requestArgs = { intent: 'expand' };
      }

      // §3.2/RISK-4: drive stateChange off the placementChange signal, not this
      // .then() microtask. Stamp the in-flight intent so the placementChange
      // handler updates geometry → sizeChange → stateChange in spec order. The
      // .then() retains only error-path bookkeeping; on rejection, clear the
      // pending intent so a later placementChange does not mis-fire (RISK-4).
      _s._pendingPlacementMode = 'expanded';
      SHARC.requestPlacementChange(requestArgs)
        .catch(function (err) {
          if (_s._pendingPlacementMode === 'expanded') _s._pendingPlacementMode = null;
          var msg = (err && err.message) ? err.message : 'Expand rejected by container';
          console.warn('[MRAID Bridge] expand failed: ' + msg);
          _emit('error', msg, 'expand');
        });
    },

    /**
     * Collapses the ad back to default placement.
     * Idempotent: no-op if already in default state (§8.5).
     */
    collapse: function () {
      // MRAID 3.0: resize/expand are inline-only, so collapse on an interstitial
      // is always invalid — state machine can never leave default.
      if (_s._placementType === 'interstitial') {
        _emit('error', 'collapse is not supported for interstitial placements', 'collapse');
        return;
      }
      // Idempotency guard (§8.5)
      if (_s._placementMode === 'default') return;

      // §3.2/RISK-4: drive the collapse → 'default' stateChange off the
      // placementChange signal (geometry settled first), not this microtask.
      _s._pendingPlacementMode = 'default';
      SHARC.requestPlacementChange({ intent: 'collapse' })
        .catch(function (err) {
          if (_s._pendingPlacementMode === 'default') _s._pendingPlacementMode = null;
          var msg = (err && err.message) ? err.message : 'Collapse rejected by container';
          console.warn('[MRAID Bridge] collapse failed: ' + msg);
          _emit('error', msg, 'collapse');
        });
    },

    /**
     * Requests the container to close the ad.
     * MRAID 3.0 §7.3.3: close() from expanded/resized state collapses to default.
     * close() from default state requests ad close.
     * On container rejection: no error event, no stateChange (§6.4).
     */
    close: function () {
      if (_s._placementMode === 'expanded' || _s._placementMode === 'resized') {
        mraid.collapse();
      } else {
        SHARC.requestClose().catch(function () {
          // Rejection is silently ignored — container declined close (§6.4)
        });
      }
    },

    /**
     * MRAID 3.0 §7.3.6 — creative-initiated session end.
     * Maps to SHARC.requestClose().
     */
    unload: function () {
      SHARC.requestClose().catch(function () {
        // Silently ignored when not allowed (§6.4)
      });
    },

    /**
     * Opens a URL via the container; falls back to window.open on SHARC error 2105 (§8.6).
     * NEW-001: Validates URL before any navigation; adds noopener,noreferrer to fallback.
     * @param {string} url
     */
    open: function (url) {
      // #394 (trim): type/emptiness guard BEFORE .trim() — a non-string url
      // (null/undefined/number/object) must be a clean reject via the `error`
      // event, never a thrown TypeError into creative code.
      if (typeof url !== 'string') {
        _emit('error', 'open() requires a non-empty URL string', 'open');
        return;
      }
      url = url.trim();
      if (url === '') {
        _emit('error', 'open() requires a non-empty URL string', 'open');
        return;
      }
      // #394 (tel/sms): tel:/sms: are declined as a deliberate legacy exclusion
      // (§3) — not operator-gated. Reject with an accurate, scheme-specific
      // reason so the creative isn't misled into thinking it just needs https.
      // supports('tel'/'sms') is hardcoded false, so this keeps the invariant
      // supports(scheme)===false consistent with open() rejecting.
      if (_isDeclinedLegacyScheme(url)) {
        _emit('error', 'open() does not support tel:/sms: — legacy scheme unsupported (§3)', 'open');
        return;
      }
      if (!_isNavigationUrlSafe(url)) {
        // NEW-001: https/http-only allowlist.
        _emit('error', 'open() requires a valid http or https URL', 'open');
        return;
      }
      SHARC.requestNavigation({ url: url, target: 'clickthrough' })
        .catch(function (err) {
          if (err && err.errorCode === 2105) {
            // Container cannot handle navigation; creative handles it (§8.6)
            // NEW-001: Add noopener,noreferrer to prevent tab-napping
            window.open(url, '_blank', 'noopener,noreferrer');
          } else {
            var msg = 'Navigation failed: ' + ((err && err.message) || String(err));
            _emit('error', msg, 'open');
          }
        });
    },

    /**
     * Signals whether the creative uses a custom close button.
     * Accepted silently; no SHARC equivalent (§6.3).
     * @param {boolean} bool - stored but ignored
     */
    useCustomClose: function (bool) {
      _s._expandProps.useCustomClose = !!bool; // store for getExpandProperties() consistency
    },

    /**
     * Non-fullscreen resize using stored resize properties (Priority 3).
     * Requires setResizeProperties() to be called first.
     * Uses _initialPosition from Container:init for accurate target placement.
     */
    resize: function () {
      // MRAID 3.0 §4.4.3/§4.4.4: resize() is inline-only; interstitials must error.
      if (_s._placementType === 'interstitial') {
        _emit('error', 'resize is not supported for interstitial placements', 'resize');
        return;
      }
      // MRAID 3.0 §4.4.3: resize() is only valid from 'default' state.
      if (_s._placementMode !== 'default') {
        _emit('error', 'resize is only valid from default state, current: ' + _s._placementMode, 'resize');
        return;
      }
      // Note: _resizeProps is always initialized; width/height of 0 means setResizeProperties was never called with valid dimensions
      if (!_s._resizeProps || !_s._resizeProps.width || !_s._resizeProps.height) {
        _emit('error', 'setResizeProperties must be called before resize()', 'resize');
        return;
      }
      var pos = _s._initialPosition || { x: 0, y: 0 };
      // §3.2/RISK-4: stamp the in-flight 'resized' intent; the placementChange
      // handler updates geometry → sizeChange → stateChange in spec order. The
      // prior .then() emitted stateChange before placementChange updated
      // _currentPosition, so a creative reading getCurrentPosition() at
      // stateChange time saw the stale pre-resize rect.
      _s._pendingPlacementMode = 'resized';
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: {
          width: _s._resizeProps.width,
          height: _s._resizeProps.height,
        },
        targetPosition: {
          x: pos.x + (_s._resizeProps.offsetX || 0),
          y: pos.y + (_s._resizeProps.offsetY || 0),
        },
        closeRegion: {
          position: _s._resizeProps.customClosePosition,
          size: 50,
        },
        allowOffscreen: _s._resizeProps.allowOffscreen || false,
      }).catch(function (err) {
        if (_s._pendingPlacementMode === 'resized') _s._pendingPlacementMode = null;
        // Surface container rejections via console.warn so they are visible in
        // automated test runs even when the creative does not register an
        // 'error' listener. Issue #20: silent rejections cascaded into 3s
        // timeouts in vendor compliance tests because _emit('error') is a
        // no-op when nobody listens.
        var failMsg = 'resize failed: ' + ((err && err.message) || String(err));
        console.warn('[MRAID Bridge] ' + failMsg);
        _emit('error', failMsg, 'resize');
      });
    },

    // ── Audio (MRAID 3.0) ───────────────────────────────────────────────

    /**
     * Returns whether device audio is muted.
     * Live value — reads env.isMuted, which the audioVolumeChange handler
     * updates unconditionally (outside the volumePercentage dedup). On the
     * ACTIVE transition the bridge additionally re-fires the audioVolumeChange
     * EVENT from buffered env audio (#390 _resyncAudioState) so a creative that
     * attached its listener during preload learns the current state. Reflects
     * the latest isMuted delivered by the container; not limited to the
     * init-time snapshot. Returns false when env.isMuted is undefined.
     * @returns {boolean}
     */
    isAudioMuted: function () {
      if (!_s._env) return false;
      return _s._env.isMuted === true;
    },

    // ── Feature Detection ───────────────────────────────────────────────

    /**
     * Returns whether a named MRAID feature is supported.
     * Never throws. Always returns boolean (§3 Feature Support Mapping).
     * @param {string} feature
     * @returns {boolean}
     */
    supports: function (feature) {
      // Intentionally disabled features (§3). tel/sms join this list as a
      // deliberate legacy exclusion: ad-initiated call/text predates OS-level
      // permission prompts + user-activation, so SHARC declines them outright.
      // NOT operator-gated — no capability string re-enables them (lock the door),
      // which keeps supports()===false consistent with open() rejecting tel:/sms:.
      if (feature === 'calendar' || feature === 'storePicture' ||
          feature === 'inlineVideo' || feature === 'vpaid' ||
          feature === 'tel' || feature === 'sms') {
        return false;
      }
      // resize: check SHARC feature string for validated resize support
      if (feature === 'resize') {
        return SHARC.hasFeature('com.iabtechlab.sharc.placement.resize');
      }
      // location: returns false until getLocation() is fully implemented (Priority 3)
      if (feature === 'location') {
        return false;
      }
      // Unknown features — conservative false
      return false;
    },

    // ── Events ──────────────────────────────────────────────────────────

    /**
     * Registers a listener for a named MRAID event.
     * Supported: 'ready', 'stateChange', 'viewableChange', 'exposureChange', 'sizeChange', 'audioVolumeChange', 'error', 'unload'
     * Unknown event names are accepted silently (no error, no effect on other events).
     * @param {string} event
     * @param {Function} listener
     */
    addEventListener: function (event, listener) {
      if (typeof listener !== 'function') return;
      if (!_s._listeners[event]) _s._listeners[event] = [];
      _s._listeners[event].push(listener);

      // Slice E1 (#388/#389) — late-listener replay. Mirrors the creative-bus
      // precedent (sharc-creative.js on(): _lastContainerState /
      // _lastEffectiveVisibility): a listener attached AFTER its event's gate
      // fired is replayed the current value ONCE, on registration, so a
      // late-attaching creative learns the current state instead of hanging
      // (MRAID 3.0 initial-state-on-subscribe). Delivered to the registering
      // listener only — the live subscription above is untouched, so an existing
      // listener never double-fires and this replay does not latch future live
      // deliveries. Guarded like _emit (§8.2): a throwing listener can't break
      // the bridge. Replays only for gate-passed events; a gate that never fired
      // replays nothing.
      //
      // The bridge holds this state at the point of registration, so the replay
      // is inherently a snapshot: the invoked listener may itself call
      // addEventListener (reentrancy), which pushes onto _s._listeners but does
      // not re-enter this replay for the already-registered listener — no
      // double-fire, no iteration corruption (mirrors _emit's snapshot dispatch).
      try {
        if (event === 'ready' && _s._readyFired) {
          listener();
        } else if (event === 'stateChange' && _s._lastMraidState !== undefined) {
          listener(_s._lastMraidState);
        } else if (event === 'error' && _s._lastError !== undefined) {
          listener.apply(null, _s._lastError);
        }
      } catch (e) { /* swallow — §8.2 */ }
    },

    /**
     * Removes a previously registered listener.
     * If listener is not found, does nothing.
     * @param {string} event
     * @param {Function} listener
     */
    removeEventListener: function (event, listener) {
      var arr = _s._listeners[event];
      if (!arr) return;
      var idx = arr.indexOf(listener);
      if (idx !== -1) arr.splice(idx, 1);
    },

    // ── Excluded / Stubbed Methods ──────────────────────────────────────

    /**
     * EXCLUDED. Always fires 'error' event (§3).
     * @param {string} _url
     */
    storePicture: function (_url) {
      _emit('error', 'COMMAND_NOT_SUPPORTED', 'storePicture');
    },

    /**
     * EXCLUDED. Always fires 'error' event (§3).
     * @param {Object} _params
     */
    createCalendarEvent: function (_params) {
      _emit('error', 'COMMAND_NOT_SUPPORTED', 'createCalendarEvent');
    },

    /**
     * EXCLUDED. Always fires 'error' event (§3).
     * @param {string} _url
     */
    playVideo: function (_url) {
      _emit('error', 'COMMAND_NOT_SUPPORTED', 'playVideo');
    },

    /**
     * MRAID getOrientationProperties — returns the last value set via
     * setOrientationProperties (default {allowOrientationChange:true,
     * forceOrientation:'none'}).
     * @returns {{allowOrientationChange:boolean, forceOrientation:string}}
     */
    getOrientationProperties: function () {
      return {
        allowOrientationChange: _s._orientationProperties.allowOrientationChange,
        forceOrientation:       _s._orientationProperties.forceOrientation,
      };
    },

    /**
     * MRAID setOrientationProperties — stores the requested properties (field-wise,
     * type- and enum-checked; the setter never throws on bad input) and forwards them to the
     * container host via SHARC.requestOrientationProperties so an embedding host can
     * lock/force the device orientation. Forwarding is best-effort: a container
     * without the host hook receives nothing and the call is a no-op, preserving
     * stock behaviour.
     * @param {{forceOrientation?:string, allowOrientationChange?:boolean}} props
     */
    setOrientationProperties: function (props) {
      if (typeof props === 'object' && props !== null) {
        if (typeof props.allowOrientationChange === 'boolean') {
          _s._orientationProperties.allowOrientationChange = props.allowOrientationChange;
        }
        // MRAID 3.0 §4.4.5 enum — a wrong-but-typed string ('banana') must not
        // reach the native host; ignored like any other invalid input (C5).
        if (props.forceOrientation === 'portrait' || props.forceOrientation === 'landscape'
            || props.forceOrientation === 'none') {
          _s._orientationProperties.forceOrientation = props.forceOrientation;
        }
      }
      if (typeof SHARC.requestOrientationProperties === 'function') {
        SHARC.requestOrientationProperties({
          allowOrientationChange: _s._orientationProperties.allowOrientationChange,
          forceOrientation:       _s._orientationProperties.forceOrientation,
        });
      }
    },

  }; // end mraid object

  // Install as window.mraid
  window.mraid = mraid;
} // end installMRAIDBridge

// -------------------------------------------------------------------------
// MRAIDCompatBridge — container-side extension plugin
// -------------------------------------------------------------------------

/**
 * Container-side extension that signals the SHARC container to inject the
 * MRAID bridge scripts into the creative iframe before creative code runs.
 *
 * @param {Object} [options] - Configuration options.
 * @param {string} [options.baseUrl='/sharc'] - Base URL path for bridge script injection.
 *   Must resolve to trusted SHARC-hosted assets, because the wrapper injects scripts from this location into the creative iframe before creative code runs.
 *   Use a same-origin or equivalently trusted host that serves the official SHARC bridge files.
 *
 * @example
 *   const container = new SHARCContainer({
 *     extensions: [new MRAIDCompatBridge()]
 *   });
 */
class MRAIDCompatBridge {
  constructor(options = {}) {
    this.name = 'com.iabtechlab.sharc.mraid';
    this.options = options;
    if (this.options.baseUrl != null) {
      validateBridgeBaseUrl(this.options.baseUrl);
    }
  }

  /**
   * Returns the list of script URLs to inject before the creative.
   * The container should prepend these to the wrapper page or inject via srcdoc.
   * @returns {string[]}
   */
  getScriptUrls() {
    var base = this.options.baseUrl || '/sharc';
    return [
      base + '/sharc-protocol.js',
      base + '/sharc-creative.js',
      base + '/sharc-mraid-bridge.js',
    ];
  }

  /**
   * Returns the feature advertisement string for Container:init.
   * @returns {string}
   */
  getFeatureName() {
    return this.name;
  }
}

// ---------------------------------------------------------------------------
// ESM exports
// ---------------------------------------------------------------------------

export {
  MRAIDCompatBridge,
  installMRAIDBridge,
  MRAID_BRIDGE_AUTOINSTALL_CAP_TICKS,
  MRAID_BRIDGE_AUTOINSTALL_CAP_MS,
};

// Browser auto-install — two distinct paths.
//
// Path A: SDK-already-loaded (existing wrapper-test pattern). When loaded as
// a <script> tag after sharc-creative.js, `window.SHARC.onReady` is already
// a function, so install runs synchronously. This is the load-order used by
// `test/browser/mraid-wrapper.html` and any operator-fork wrapper page.
//
// Path B: Renderer-side opt-in (added 0.7.1, issue #82). The reference
// renderer at `examples/renderer/index.html` dynamic-imports the bridge
// module BEFORE `document.write(creativeHtml)` so the creative HTML's first
// synchronous script — which may call `mraid.foo()` — finds `window.mraid`
// already in place. At that moment `window.SHARC` does not exist yet (the
// SHARC SDK is loaded as a <script> INSIDE creativeHtml). Renderer signals
// opt-in by setting `window.__sharcMraidBridgeAutoInstall = true` BEFORE
// the import. Mirrors the existing `__sharcNavBridgeAutoInstall` pattern.
//
// Path B uses `setTimeout(0)` polling to wait for `window.SHARC.onReady` to
// appear (it appears once the creative SDK script inside creativeHtml runs
// and calls `Object.assign(window.SHARC, …)`). Once present, calls
// `installMRAIDBridge(window.SHARC)` exactly once. Idempotency is enforced
// by `window.__sharcMraidBridgeInstalled`.
if (typeof window !== 'undefined') {
  /** @type {any} */
  var anyWin = window;
  if (anyWin.SHARC && typeof anyWin.SHARC.onReady === 'function') {
    // Path A: SDK already on window — install synchronously (wrapper pattern).
    if (!anyWin.__sharcMraidBridgeInstalled) {
      anyWin.SHARC.MRAIDCompatBridge = MRAIDCompatBridge;
      installMRAIDBridge(anyWin.SHARC);
      anyWin.__sharcMraidBridgeInstalled = true;
    }
  } else if (anyWin.__sharcMraidBridgeAutoInstall && !anyWin.__sharcMraidBridgeInstalled) {
    // Path B: renderer-side opt-in — defer install until SHARC SDK loads.
    // Polls via setTimeout(0); the SDK call to `Object.assign(window.SHARC, …)`
    // runs synchronously when the creative's <script src="…sharc-creative.js">
    // tag executes after `document.write(creativeHtml)`. In practice the wait
    // is one or two ticks. A polling cap protects against an infinite loop
    // and provides a deterministic timeout for the G9 operator-visible warn.
    var _mraidWireTries = 0;
    // 0.7.2 G9: strict cap. 1000 ticks × the setTimeout(0) clamp floor
    // (~4 ms in modern browsers, ~16 ms in older). We report the integer
    // tick count and the conservative wall-clock upper bound for operator
    // forensics. See 0.7.2 design § 10.1.
    var _mraidWireMax = MRAID_BRIDGE_AUTOINSTALL_CAP_TICKS;
    var _mraidWireCapMs = MRAID_BRIDGE_AUTOINSTALL_CAP_MS; // conservative upper bound: 1000 × 16 ms
    function _trySharcMraidWire() {
      if (anyWin.__sharcMraidBridgeInstalled) return;
      if (anyWin.SHARC && typeof anyWin.SHARC.onReady === 'function') {
        anyWin.SHARC.MRAIDCompatBridge = MRAIDCompatBridge;
        installMRAIDBridge(anyWin.SHARC);
        anyWin.__sharcMraidBridgeInstalled = true;
        return;
      }
      _mraidWireTries++;
      if (_mraidWireTries >= _mraidWireMax) {
        // G9: surface the auto-install failure at timeout-time, not just
        // when the creative eventually calls `mraid.*`. The bridge stays
        // uninstalled (correct failure mode); the warn gives operators a
        // ~16s-earlier diagnostic. The reference renderer threads
        // placementSessionId before importing the bridge; unknown covers
        // direct bridge loads and older renderers.
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          var placementSessionId = (typeof anyWin.__sharcPlacementSessionId__ === 'string'
            && anyWin.__sharcPlacementSessionId__.length > 0)
            ? anyWin.__sharcPlacementSessionId__
            : 'unknown';
          console.warn(
            '[SHARC MRAID bridge] Auto-install failed: placementSessionId='
            + placementSessionId + '; '
            + 'window.SHARC not available after ' + _mraidWireMax + ' ticks '
            + '(cap ' + _mraidWireCapMs + 'ms). window.mraid will not be wired. '
            + 'Consider removing "mraid" from bridges, or loading sharc-creative.js '
            + 'in your creative so the bridge can install on top of the SHARC SDK.'
          );
        }
        return;
      }
      setTimeout(_trySharcMraidWire, 0);
    }
    _trySharcMraidWire();
  }
}

// Legacy IIFE support - ensure global namespace is available even with sideEffects: false
if (typeof window !== 'undefined' && typeof window.SHARC !== 'undefined' && !window.SHARC.MRAIDCompatBridge) {
  window.SHARC.MRAIDCompatBridge = MRAIDCompatBridge;
}
