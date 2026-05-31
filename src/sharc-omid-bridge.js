// @ts-nocheck
/**
 * @fileoverview SHARC OMID Bridge
 *
 * Bridges the SHARC container protocol to the IAB Open Measurement SDK (OM SDK)
 * JavaScript API. The 0.7.3 path is container-owned: the publisher page loads
 * OM SDK, owns AdSession lifecycle, and maps SHARC container lifecycle events
 * to OM SDK calls.
 *
 * Architecture:
 *   - Container side: `OmidCompatBridge` — a plugin that loads OM SDK in the
 *     publisher page, owns AdSession lifecycle, registers
 *     `'com.iabtechlab.sharc.omid'` in Container:init only when both OM SDK
 *     script URLs are configured, and reacts to generic container lifecycle
 *     events.
 *
 * Key OM SDK constraints enforced by this bridge:
 *   - OM SDK service script MUST be loaded before AdSession is created
 *   - Only ONE AdEvents instance per session (error on duplicate)
 *   - Only ONE MediaEvents instance per session (error on duplicate)
 *   - creativeType and impressionType MUST be set before impressionOccurred()
 *   - AdSession must be started before any events are fired
 *
 * @version 0.7.7
 * @see https://iabtechlab.com/standards/open-measurement-sdk/
 * @see https://github.com/IABTechLab/SHARC
 */

'use strict';

// ---------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Internal constants
// -------------------------------------------------------------------------

/** Feature name advertised in Container:init supportedFeatures array. */
var FEATURE_NAME = 'com.iabtechlab.sharc.omid';

/** Bridge version — reads from SHARC_VERSION (single source of truth in sharc-protocol.js). */
var BRIDGE_VERSION = (typeof window !== 'undefined' && window.SHARC && window.SHARC.Protocol && window.SHARC.Protocol.SHARC_VERSION) || '0.0.0';

/**
 * OM SDK partner name reported in Partner constructor.
 * Publishers should override this via OmidCompatBridge options.
 */
var DEFAULT_PARTNER_NAME = 'SHARCOmidBridge';

/** OM SDK partner version reported in Partner constructor. */
var DEFAULT_PARTNER_VERSION = BRIDGE_VERSION;

/** Router protocol prefix for the OMID publisher↔iframe relay (0.7.8). */
var OMID_PROTOCOL_PREFIX = 'SHARC:Omid:';

/**
 * Emission-side `geometryChange` rate-limit (design § 7.3 / OMID-D20): at most
 * one `geometryChange` Event is emitted per this many ms. Frames the cadence as
 * a player-cadence sampling choice (a sampled event is never fired, so it never
 * enters the iframe shim's replay log) — categorically different from
 * coalescing at replay time. Matches OM SDK's internal throttle.
 */
var OMID_GEOMETRY_MIN_INTERVAL_MS = 100;

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

// Declare global OmidSessionClient (provided by OM SDK service script at runtime)
/** @type {any} */
var OmidSessionClient;

/**
 * Safely resolves the OmidSessionClient namespace from the global scope.
 * The OM SDK session client script exposes `OmidSessionClient` globally.
 *
 * @returns {Object|null} The OmidSessionClient namespace, or null if not loaded.
 */
function getOmidSessionClient() {
  if (typeof OmidSessionClient !== 'undefined') {
    return /** @type {any} */ (OmidSessionClient);
  }
  // Fallback: some integrations expose it on window explicitly
  if (typeof window !== 'undefined' && window.OmidSessionClient) {
    return /** @type {any} */ (window.OmidSessionClient);
  }
  return null;
}

/**
 * Returns true if the OM SDK service script has been loaded and is ready.
 * The service script installs a global `omidBridge` or registers itself
 * in a way that `OmidSessionClient.AdSession` can communicate with it.
 *
 * We use the heuristic that the session client namespace must be available
 * and contain at least the core session types.
 *
 * @returns {boolean}
 */
function isOmSdkLoaded() {
  var omid = getOmidSessionClient();
  return !!(omid && omid.AdSession && omid.Partner && omid.Context);
}

/**
 * Wraps a function call in a try/catch, logging any error.
 * Prevents OM SDK errors from disrupting the SHARC protocol.
 *
 * @param {string} label - Name for error logging context.
 * @param {Function} fn - Function to invoke.
 * @returns {*} Return value of fn, or undefined on error.
 */
function safeCall(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.warn('[SHARC OMID Bridge] ' + label + ' threw:', e && (e.message || e));
  }
}

/**
 * Escapes a string for safe inclusion inside a double-quoted HTML attribute.
 * The srcdoc shim `<script src>` URL is operator-controlled (validated
 * `baseUrl`), but escape defensively so a stray quote / angle bracket cannot
 * break out of the attribute context.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Finds the index at which to insert the OMID shim scripts as the FIRST
 * children of `<head>` for the `srcdoc` variant (§ 4.3 ii: prelude must run at
 * the very top, before any creative markup). Most-specific-wins, mirroring the
 * container's `_findCreativeSdkInjectionIndex` contract but scoped to what the
 * shim needs: after `<head ...>` open tag → after `<html ...>` open tag →
 * prepend (null → caller prepends). Token-boundary checks reject `<header>`,
 * `<htmlfoo>`, etc.
 *
 * @param {string} html
 * @returns {number|null} insertion index, or null to prepend.
 */
function findHeadInsertionIndex(html) {
  // After <head ...> open tag. Boundary char after "head" must be whitespace
  // or '>' so <header>/<heading> do not match.
  var headRe = /<head(?=[\s>])[^>]*>/i;
  var m = headRe.exec(html);
  if (m) return m.index + m[0].length;
  // After <html ...> open tag.
  var htmlRe = /<html(?=[\s>])[^>]*>/i;
  m = htmlRe.exec(html);
  if (m) return m.index + m[0].length;
  return null;
}

/**
 * Logs and throws a configuration error before OM SDK session creation starts.
 *
 * @param {string} message
 * @returns {never}
 */
function throwOmidConfigError(message) {
  var error = new TypeError(message);
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[SHARC OMID Bridge] ' + message);
  }
  throw error;
}

/**
 * Returns the configured verification script URL. `resourceUrl` is the OM SDK
 * field name; `url` is accepted for compatibility with existing SHARC configs.
 *
 * @param {Object} script
 * @returns {string|null}
 */
function getVerificationScriptResourceUrl(script) {
  if (typeof script.resourceUrl === 'string') return script.resourceUrl;
  if (typeof script.url === 'string') return script.url;
  return null;
}

/**
 * Defense-in-depth validation for the operator-supplied `baseUrl` option
 * (issue #140). Unlike `validateOmidHttpsUrl`, this validator accepts
 * path-relative URLs because the default (`'/sharc'`) is path-relative —
 * strict HTTPS-only would break the default.
 *
 * Rules (mirror sharc-mraid-bridge.js — see there for full rationale):
 *   - `undefined` / `null` are accepted (caller falls back to `'/sharc'`)
 *   - Must be a string
 *   - Must NOT be empty or whitespace-only after trim
 *   - Must NOT contain embedded control / Unicode-whitespace / zero-width chars
 *   - Must NOT be protocol-relative (literal `//`, `\\`, or percent-encoded `%2F%2F` / `%5C%5C`)
 *   - Must NOT contain `%3A` (percent-encoded colon — gates a future decoding-sink bypass)
 *   - Must NOT start with a dangerous scheme (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`)
 *     in any letter case
 *   - If absolute (has a scheme), must be HTTPS
 *   - No userinfo allowed
 *
 * Throws `TypeError` via `throwOmidConfigError` on invalid input.
 *
 * @param {*} baseUrl
 * @returns {string|undefined} the input string when valid, or `undefined` for null/undefined input
 */
function validateBridgeBaseUrl(baseUrl) {
  if (baseUrl == null) return undefined;
  if (typeof baseUrl !== 'string') {
    throwOmidConfigError('baseUrl must be a string');
  }

  // Trim leading/trailing whitespace before scheme detection — see
  // sharc-mraid-bridge.js for full rationale on the Unicode-whitespace +
  // zero-width character set.
  // eslint-disable-next-line no-control-regex -- intentional: C0 controls + space + Unicode whitespace are the bypass surface this trim defends
  var trimmed = baseUrl.replace(/^[\x00-\x20\x7F\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F-\u2060\u3000\uFEFF]+|[\x00-\x20\x7F\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F-\u2060\u3000\uFEFF]+$/g, '');

  // Empty / whitespace-only baseUrl — see sharc-mraid-bridge.js for rationale.
  if (trimmed === '') {
    throwOmidConfigError('baseUrl must not be empty or whitespace');
  }

  // Embedded control / Unicode-whitespace / zero-width characters — see
  // sharc-mraid-bridge.js for rationale.
  // eslint-disable-next-line no-control-regex -- intentional: embedded C0 controls + DEL + Unicode whitespace + zero-width chars are the bypass surface this check defends
  if (/[\x00-\x1F\x7F\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F-\u2060\u3000\uFEFF]/.test(trimmed)) {
    throwOmidConfigError('baseUrl must not contain embedded control or whitespace characters');
  }

  // Protocol-relative URLs (`//host/…`, `\\host\…`, or the percent-encoded
  // leading form `%2F%2F…` / `%5C%5C…` / mixed) — see sharc-mraid-bridge.js
  // for rationale.
  if (/^[\\/]{2}/.test(trimmed) || /^%(?:2[Ff]|5[Cc])/.test(trimmed)) {
    throwOmidConfigError('baseUrl must not be protocol-relative');
  }

  // Percent-encoded scheme separator (`%3A`) — see sharc-mraid-bridge.js
  // for rationale.
  if (/%3[Aa]/.test(trimmed)) {
    throwOmidConfigError('baseUrl must not contain percent-encoded scheme separator (%3A)');
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
    throwOmidConfigError('baseUrl must not use the ' + scheme + ': scheme');
  }

  var parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    throwOmidConfigError('baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throwOmidConfigError('baseUrl must use HTTPS when absolute');
  }
  if (parsed.username || parsed.password) {
    throwOmidConfigError('baseUrl must not include userinfo');
  }
  return baseUrl;
}

/**
 * Validates an OMID-managed script URL using the same hygiene rules as
 * verification script resource URLs.
 *
 * @param {string} url
 * @param {string} fieldName
 * @returns {string}
 */
function validateOmidHttpsUrl(url, fieldName) {
  if (typeof url !== 'string' || url.length === 0) {
    throwOmidConfigError(fieldName + ' must be a non-empty string');
  }

  var parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throwOmidConfigError(fieldName + ' must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throwOmidConfigError(fieldName + ' must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throwOmidConfigError(fieldName + ' must not include userinfo');
  }
  return parsed.href;
}

/**
 * Validates and deduplicates OMID verification script descriptors.
 *
 * @param {*} verificationScripts
 * @returns {Array}
 */
function validateVerificationScripts(verificationScripts) {
  if (verificationScripts == null) return [];
  if (!Array.isArray(verificationScripts)) {
    throwOmidConfigError('verificationScripts must be an array');
  }

  var seen = Object.create(null);
  var validated = [];
  for (var i = 0; i < verificationScripts.length; i++) {
    var script = verificationScripts[i];
    if (!script || typeof script !== 'object') {
      throwOmidConfigError('verificationScripts[' + i + '] must be an object');
    }

    var resourceUrl = getVerificationScriptResourceUrl(script);
    if (typeof resourceUrl !== 'string' || resourceUrl.length === 0) {
      throwOmidConfigError('verificationScripts[' + i + '].resourceUrl must be a non-empty string');
    }

    var parsedUrl = validateOmidHttpsUrl(resourceUrl, 'verificationScripts[' + i + '].resourceUrl');

    var dedupeKey = parsedUrl;
    if (seen[dedupeKey]) continue;
    seen[dedupeKey] = true;
    // 0.7.3 follow-up (#127 sub-3b): push a shallow copy with the normalized
    // resourceUrl rather than mutating the operator's input object. The legacy
    // `url` alias caller may not expect a validation function to write
    // resourceUrl back onto their input.
    if (typeof script.resourceUrl !== 'string') {
      validated.push(Object.assign({}, script, { resourceUrl: resourceUrl }));
    } else {
      validated.push(script);
    }
  }
  return validated;
}

// -------------------------------------------------------------------------
// OmidCompatBridge — container-side extension plugin
// -------------------------------------------------------------------------

/**
 * Container-side extension plugin for the OMID bridge.
 *
 * Registers the OMID feature name in Container:init only when both OM SDK
 * script URLs are configured, loads those scripts on the publisher page, and
 * manages the container-owned OM SDK session lifecycle.
 *
 * Usage:
 * ```javascript
 * const bridge = new OmidCompatBridge({
 *   omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
 *   omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
 *   partnerName: 'MyPublisher',
 *   partnerVersion: '1.0.0',
 *   verificationScripts: [...],
 * });
 *
 * const feature = bridge.getFeatureDescriptor();
 * const container = new SHARCContainer({
 *   supportedFeatures: feature ? [feature] : [],
 *   environmentData: bridge.augmentEnvironmentData({ ... }),
 * });
 * ```
 *
 * @param {Object} [options]
 * @param {string} [options.omSdkServiceScriptUrl]  - URL of the OM SDK service script (omweb-v1.js).
 * @param {string} [options.omSdkSessionClientUrl]  - URL of the OM SDK session client script.
 * @param {string} [options.baseUrl='/sharc']       - Base URL for SHARC scripts.
 *   Must resolve to trusted SHARC-hosted assets.
 * @param {string} [options.partnerName]            - OM SDK partner name.
 * @param {string} [options.partnerVersion]         - OM SDK partner version.
 * @param {Array}  [options.verificationScripts]    - OM SDK VerificationScriptResource objects.
 * @param {string} [options.creativeType]           - OM SDK creative type (default: 'video').
 * @param {string} [options.impressionType]         - OM SDK impression type.
 * @param {string} [options.mediaType]              - OM SDK media type (default: 'video').
 * @param {string} [options.contentUrl]             - OM SDK content URL override.
 * @param {Object} [options.vastProperties]         - Optional VastProperties settings.
 */
function OmidCompatBridge(options) {
  this.name    = FEATURE_NAME;
  this.options = options ? Object.assign({}, options) : {};
  if (this.options.baseUrl != null) {
    validateBridgeBaseUrl(this.options.baseUrl);
  }
  if (this.options.omSdkServiceScriptUrl != null) {
    this.options.omSdkServiceScriptUrl = validateOmidHttpsUrl(
      this.options.omSdkServiceScriptUrl,
      'omSdkServiceScriptUrl'
    );
  }
  if (this.options.omSdkSessionClientUrl != null) {
    this.options.omSdkSessionClientUrl = validateOmidHttpsUrl(
      this.options.omSdkSessionClientUrl,
      'omSdkSessionClientUrl'
    );
  }
  this.options.verificationScripts = validateVerificationScripts(this.options.verificationScripts);

  // 0.7.8: `exposeOmid3p` defaults to `true` (OMID-D21 / OMID-Q6). The bridge
  // installs the `window.omid3p` shim in the creative iframe by default,
  // closing the inline-OMID measurement gap for every operator automatically.
  // Collisions loud-fail at shim install (§ 11.3), never silent-corrupt.
  // Opt out via `exposeOmid3p: false`.
  this.options.exposeOmid3p = (this.options.exposeOmid3p !== false);

  /** @private */
  this._container = null;
  /**
   * Router-derived OMID per-protocol nonce, delivered via `onReady`. Used to
   * sign outbound `SHARC:Omid:Event` envelopes (via `buildOutbound`) and for
   * trusted injection into the iframe shim (§ 4.3). NEVER echoed to vendor JS.
   * @private
   */
  this._omidProtocolNonce = null;
  /** @private Whether the OMID router protocol has been registered. */
  this._omidProtocolRegistered = false;
  /** @private Monotonic uint32 per-session sequence for outbound envelopes. */
  this._omidSequence = 0;
  /** @private Recorded creative-iframe origin for outbound posting. */
  this._omidIframeOrigin = null;
  /**
   * C5 (extended): ordered FIFO queue of `{ type, data }` relay requests that
   * arrived before the router-derived nonce resolved via `onReady`. The whole
   * active-burst races the nonce, not just `sessionStart`: a single synchronous
   * burst relays `sessionStart` → `loaded` → `impression` → first
   * `geometryChange`, and EACH would early-return on the unresolved nonce. The
   * original C5 fix re-drove `sessionStart` only, so `loaded`/`impression` were
   * dropped permanently (their `*Fired` flags were already set, so the burst
   * callers never relay them again). Queueing every dropped relay and flushing
   * the queue in order from `onReady` makes the entire burst survive the race,
   * relayed exactly once each, in chronological order. The shim flips
   * `sessionStarted` (and runs `flushPendingRegisters`) only on the relayed
   * `sessionStart`, which the queue delivers first.
   * @private
   * @type {Array<{ type: string, data: Object }>}
   */
  this._omidPendingRelays = [];
  /** @private Last emission timestamp for the geometryChange rate-limit. */
  this._omidLastGeometryEmitMs = 0;
  /** @private */
  this._sdkLoadPromise = null;
  /** @private */
  this._sessionCreationPromise = null;
  /** @private */
  this._sdkLoadStarted = false;
  /**
   * URL currently being injected by `_ensureSdkLoaded` (service or session
   * client). Reported as `details.scriptUrl` in `feature_load_failed` when
   * the load fails. Reset to `null` on success or before each step.
   * @private
   */
  this._loadingUrl = null;
  /** @private */
  this._loadedScripts = [];
  /** @private */
  this._verificationScripts = null;
  /** @private */
  this._omid = {
    adSession: null,
    adEvents: null,
    mediaEvents: null,
    sessionStarted: false,
    loadedFired: false,
    impressionFired: false,
    sessionFinished: false,
    isVideoSession: false,
    lastVisibilityState: null,
    lastPlacementMode: 'normal',
  };

  /**
   * Currently registered friendly obstruction element (e.g. close button).
   * Tracked to avoid duplicate registrations and allow clean unregistration.
   * @type {HTMLElement|null}
   * @private
   */
  this._friendlyObstruction = null;
  this._friendlyObstructionRegistered = false;
}

OmidCompatBridge.prototype = /** @type {any} */ ({

  // ── Feature registration ─────────────────────────────────────────────

  /**
   * Returns the feature name string for Container:init supportedFeatures when
   * the bridge can load both required OM SDK scripts. Returning null keeps a
   * default-constructed bridge from advertising inert OMID support.
   * @returns {string|null} 'com.iabtechlab.sharc.omid' when configured
   */
  getFeatureName: function () {
    return this._hasSdkInjectionUrls() ? this.name : null;
  },

  /**
   * Returns a feature descriptor object suitable for the supportedFeatures
   * array in Container:init. Includes capability metadata for the creative.
   *
   * @returns {{ name: string, version: string, capabilities: Object }|null}
   */
  getFeatureDescriptor: function () {
    var sdkInjected = this._hasSdkInjectionUrls();
    if (!sdkInjected) return null;

    return {
      name:    this.name,
      version: BRIDGE_VERSION,
      capabilities: {
        // Indicates the OM SDK service and session client are loaded by the container
        sdkInjected:          sdkInjected,
        // Whether mediaEvents are supported (video/audio sessions)
        mediaEvents:          (this.options.mediaType !== 'display'),
        // Whether adEvents are supported (always true)
        adEvents:             true,
        // creativeType reported to OM SDK
        creativeType:         this.options.creativeType   || 'video',
        // impressionType reported to OM SDK
        impressionType:       this.options.impressionType || 'definedByJavaScript',
      },
    };
  },

  /**
   * True only when both OM SDK scripts are explicitly configured. A single URL
   * is insufficient for the bridge to advertise a functional OMID feature.
   * @returns {boolean}
   * @private
   */
  _hasSdkInjectionUrls: function () {
    return !!(this.options.omSdkServiceScriptUrl && this.options.omSdkSessionClientUrl);
  },

  // ── Markup injection compatibility ───────────────────────────────────

  /**
   * Returns the ordered list of OMID/SHARC script URLs historically used by
   * creative-markup injection.
   *
   * OMID 0.7.3 is container-owned, so `injectScripts()` and
   * `injectIntoMarkup()` do not inject these URLs into creative markup. The
   * list remains available for compatibility with callers that inspect the
   * configured script order. Order is:
   *   1. OM SDK Service Script (omweb-v1.js) — MUST be first
   *   2. OM SDK Session Client (omid-session-client-v1.js)
   *   3. SHARC Protocol
   *   4. SHARC Creative API
   *   5. SHARC OMID Bridge (this file)
   *
   * @returns {string[]} Ordered array of script URLs.
   */
  getScriptUrls: function () {
    var base        = this.options.baseUrl               || '/sharc';
    var serviceUrl  = this.options.omSdkServiceScriptUrl || '/vendor/omweb-v1.js';
    var clientUrl   = this.options.omSdkSessionClientUrl || '/vendor/omid-session-client-v1.js';

    // CRITICAL: OM SDK service script must come before session client,
    // and both must come before SHARC Creative and this bridge.
    return [
      serviceUrl,                                 // 1. OM SDK Service (omweb-v1.js)
      clientUrl,                                  // 2. OM SDK Session Client
      base + '/sharc-protocol.js',                // 3. SHARC Protocol constants
      base + '/sharc-creative.js',                // 4. SHARC Creative API
      base + '/sharc-omid-bridge.js',             // 5. This bridge
    ];
  },

  /**
   * Returns creative markup unchanged.
   *
   * OMID 0.7.3 is fully container-owned: the publisher page loads OM SDK and
   * owns the AdSession lifecycle. No OMID or SHARC scripts are injected into
   * creative markup.
   *
   * **Status (#127 sub-3c):** no-op stub. Exists for bridge-interface parity
   * with `MRAIDCompatBridge.injectScripts` and `SafeFrameCompatBridge.injectScripts`
   * (which DO transform markup in their respective legacy-bridge flows).
   * Retirement of this method across all three bridges is a separate decision
   * not scoped to 0.7.3 — the wrapper/injector pattern may still be relevant
   * for MRAID/SafeFrame even if OMID has moved past it.
   *
   * @param {string} html    - The original creative HTML markup.
   * @returns {string}       The original creative HTML markup, unchanged.
   */
  injectScripts: function (html) {
    return html;
  },

  /**
   * URL + `useMarkupInjection` (`srcdoc`) variant shim install (§ 4.2 / § 4.3
   * mechanism ii). Called by `SHARCContainer._fetchAndInjectCreative()` for the
   * Creative URL variant when the operator opted into `useMarkupInjection: true`
   * (the container wraps the creative in a `srcdoc` it controls).
   *
   * When OMID is active for this placement, this prepends — as the FIRST
   * children of `<head>` (or the document if there is no head), before any
   * creative content — two scripts:
   *
   *   1. `<script src="<baseUrl>/sharc-omid-shim.js">` — loads the shim IIFE,
   *      which self-attaches `window.SHARC.installOmidShimPortReceiver`. A
   *      parser-blocking external script in `srcdoc`, so it runs to completion
   *      before the inline prelude below.
   *   2. An inline prelude `<script>` that calls `installOmidShimPortReceiver`,
   *      which installs `window.omid3p` SYNCHRONOUSLY (so a verification
   *      script's first read succeeds — § 4.1) and arms the transferred-port
   *      receiver. The OMID `protocolNonce` is NOT in this source — it arrives
   *      async over the MessagePort the container transfers in (§ 4.3 ii). The
   *      prelude inlines only `placementSessionId` and `containerOrigin`, which
   *      are non-secret transport anchors (they ride every envelope and the
   *      Markup-variant renderer inlines them too).
   *
   * Returns the markup unchanged when OMID is not active for this placement
   * (`exposeOmid3p: false`, the `SHARC:Omid:` protocol not registered, or its
   * nonce not yet derived) — keeping the srcdoc byte-identical to the OMID-off
   * path. The container's port transfer is gated on the SAME conditions
   * (`getSrcdocOmidInjection()`), so the prelude and the port handoff are wired
   * together or not at all.
   *
   *   container calls: `extension.injectIntoMarkup(html)` → string
   *
   * @param {string} html - The raw creative HTML markup.
   * @returns {string} The markup with the shim + prelude prepended, or unchanged.
   */
  injectIntoMarkup: function (html) {
    if (typeof html !== 'string') return html;
    var injection = this.getSrcdocOmidInjection();
    if (injection === null) return html;

    var base = this.options.baseUrl || '/sharc';
    var shimUrl = base.replace(/\/+$/, '') + '/sharc-omid-shim.js';

    var psid = injection.placementSessionId;
    var containerOrigin = injection.containerOrigin;

    // Build the two scripts. The nonce is NOT inlined — only the non-secret
    // transport anchors are. JSON-encode + escape `<` so a hostile value can
    // never break out of the inline-script context.
    var jsonLit = function (v) {
      return JSON.stringify(String(v)).replace(/</g, '\\u003c');
    };
    var shimTag = '<script src="' + escapeHtmlAttr(shimUrl) + '"></script>';
    var preludeTag = '<script>'
      + '(function(){try{'
      + 'var f=(window.SHARC&&window.SHARC.installOmidShimPortReceiver)'
      + '||(typeof installOmidShimPortReceiver==="function"?installOmidShimPortReceiver:null);'
      + 'if(!f){if(window.console&&console.error)console.error('
      + '"[SHARC OMID srcdoc] installOmidShimPortReceiver unavailable — shim script did not load");return;}'
      + 'f({placementSessionId:' + jsonLit(psid) + ','
      + 'containerOrigin:' + jsonLit(containerOrigin) + '});'
      + '}catch(e){if(window.console&&console.error)console.error('
      + '"[SHARC OMID srcdoc] shim port-receiver install failed:",e&&e.message?e.message:e);}}());'
      + '</script>';
    var scripts = shimTag + preludeTag;

    var idx = findHeadInsertionIndex(html);
    if (idx !== null) {
      return html.slice(0, idx) + scripts + html.slice(idx);
    }
    return scripts + html;
  },

  /**
   * Augments an environmentData object with OMID-specific metadata.
   *
   * Adds `omidServiceScriptUrl` so the bridge (running inside the creative
   * frame) knows the canonical URL of the OM SDK service script for
   * Context.setServiceScriptUrl().
   *
   * Call this before passing environmentData to SHARCContainer:
   *   environmentData: bridge.augmentEnvironmentData({ currentPlacement: ... })
   *
   * @param {Object} environmentData - Existing environment data object.
   * @returns {Object} The same object, augmented in place.
   */
  augmentEnvironmentData: function (environmentData) {
    environmentData = environmentData || {};
    environmentData.omidServiceScriptUrl =
      this.options.omSdkServiceScriptUrl || '/vendor/omweb-v1.js';
    return environmentData;
  },

  // ── Container-owned OM SDK lifecycle ─────────────────────────────────

  /**
   * Returns the bridge version for descriptor-capable integrations.
   * @returns {string}
   */
  getFeatureVersion: function () {
    return BRIDGE_VERSION;
  },

  /**
   * Returns feature functions exposed by the container-owned extension.
   * These are descriptive capabilities, not creative-callable OMID APIs.
   * @returns {string[]}
   */
  getFeatureFunctions: function () {
    return ['startSession', 'signalAdEvent', 'signalMediaEvent', 'finishSession'];
  },

  /**
   * Generic lifecycle hook called by SHARCContainer.
   *
   * @param {Object} event - { type, container, state, ...detail }
   */
  onContainerLifecycleEvent: function (event) {
    if (!event) return;
    if (event.container) this._container = event.container;

    switch (event.type) {
      case 'load': {
        // 0.7.8: register the OMID router protocol (prefix 'SHARC:Omid:') as a
        // pure consumer. The renderer protocol is already registered by the
        // container itself (router § 2.3 ordering), so the prefix is free.
        this._registerOmidProtocol(event.container);
        // Fire-and-forget the SDK kickoff. Attach a no-op catch so the
        // rejected promise doesn't surface as an unhandled rejection — the
        // failure is routed via `_createSessionWhenReady`'s catch (which
        // is where `feature_load_failed` is emitted on the structured
        // channel). Without this catch, the 'load'-triggered call would
        // leak an unhandled-rejection trace whenever the SDK fails to
        // load, even though the failure is correctly handled downstream.
        var sdkLoad = this._ensureSdkLoaded();
        if (sdkLoad && typeof sdkLoad.catch === 'function') {
          sdkLoad.catch(function () { /* routed via _createSessionWhenReady */ });
        }
        break;
      }
      case 'stateChange':
        this.onContainerStateChange(event.newState, event.previousState, event.container);
        break;
      case 'placementChange':
        this._handlePlacementChange(event);
        break;
      case 'close':
      case 'destroy':
      case 'error':
        this._finishSession();
        break;
      default:
        break;
    }
  },

  /**
   * State-only compatibility hook. The container calls this through its generic
   * lifecycle dispatcher so the hook is available to non-OMID extensions too.
   *
   * @param {string} newState
   * @param {string} previousState
   * @param {Object} container
   */
  onContainerStateChange: function (newState, previousState, container) {
    if (container) this._container = container;
    if (newState === 'ready') {
      this._createSessionWhenReady();
      return;
    }
    if (newState === 'active') {
      this._createSessionWhenReady();
      this._fireLoaded();
      this._fireImpression();
      this._signalVisibility('visible');
      return;
    }
    if (newState === 'passive' || newState === 'hidden' || newState === 'frozen') {
      this._signalVisibility('notVisible');
      return;
    }
    if (newState === 'terminated') {
      this._finishSession();
    }
  },

  /**
   * Returns true when the bound container reports the given lifecycle state.
   * @param {string} state
   * @returns {boolean}
   * @private
   */
  _isContainerState: function (state) {
    return !!(this._container && typeof this._container.getState === 'function' &&
      this._container.getState() === state);
  },

  /**
   * Fires active-state OMID signals after a deferred session creation catches up.
   * @private
   */
  _signalActiveStateIfNeeded: function () {
    if (!this._isContainerState('active')) return;
    this._fireLoaded();
    this._fireImpression();
    this._signalVisibility('visible');
  },

  /**
   * Loads OM SDK scripts in the publisher page. Idempotent.
   *
   * @returns {Promise<void>|null}
   * @private
   */
  _ensureSdkLoaded: function () {
    if (isOmSdkLoaded()) {
      return Promise.resolve();
    }
    if (this._sdkLoadPromise) {
      return this._sdkLoadPromise;
    }
    if (typeof document === 'undefined' || !document.createElement) {
      return null;
    }
    if (!this._hasSdkInjectionUrls()) {
      return Promise.resolve();
    }

    var urls = [];
    var serviceUrl = this.options.omSdkServiceScriptUrl;
    var clientUrl = this.options.omSdkSessionClientUrl;
    urls.push(serviceUrl);
    urls.push(clientUrl);

    this._sdkLoadStarted = true;
    var self = this;
    this._sdkLoadPromise = urls.reduce(function (chain, url) {
      return chain.then(function () {
        // A publisher may already have loaded the OM SDK service; in that case
        // keep the session-client step idempotent instead of injecting it again.
        if (isOmSdkLoaded() && url === clientUrl) return undefined;
        // Track the URL currently being injected so the catch in
        // _createSessionWhenReady can report the URL that actually failed
        // (either serviceUrl or clientUrl) in feature_load_failed.details.scriptUrl.
        self._loadingUrl = url;
        return self._injectScriptWithTimeout(url, 5000);
      });
    }, Promise.resolve()).then(function () {
      self._loadingUrl = null;
      return undefined;
    }).catch(function (err) {
      console.warn('[SHARC OMID Bridge] OM SDK script load failed:', err && (err.message || err));
      throw err;
    });
    return this._sdkLoadPromise;
  },

  /**
   * Injects one publisher-page script with a bounded wait.
   * @param {string} url
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   * @private
   */
  _injectScriptWithTimeout: function (url, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timeoutId = setTimeout(function () {
        settled = true;
        reject(new Error('Timed out loading OM SDK script after ' + timeoutMs + 'ms: ' + url));
      }, timeoutMs);

      self._injectScript(url).then(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      }, function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  },

  /**
   * Injects one publisher-page script.
   * @param {string} url
   * @returns {Promise<void>}
   * @private
   */
  _injectScript: function (url) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var existing = null;
      var scripts = document.getElementsByTagName ? document.getElementsByTagName('script') : [];
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].getAttribute('src') === url || scripts[i].src === url) {
          existing = scripts[i];
          break;
        }
      }
      if (existing) {
        resolve();
        return;
      }
      var script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Failed to load ' + url)); };
      (document.head || document.documentElement).appendChild(script);
      self._loadedScripts.push(script);
    });
  },

  /**
   * Creates an OM SDK session once scripts are available.
   * @private
   */
  _createSessionWhenReady: function () {
    var self = this;
    if (this._omid.sessionStarted || this._omid.sessionFinished) return;
    if (isOmSdkLoaded()) {
      this._createSession();
      this._signalActiveStateIfNeeded();
      return;
    }
    if (this._sessionCreationPromise) {
      return this._sessionCreationPromise;
    }
    var loaded = this._ensureSdkLoaded();
    if (loaded && typeof loaded.then === 'function') {
      this._sessionCreationPromise = loaded.then(function () {
        self._sessionCreationPromise = null;
        self._createSession();
        self._signalActiveStateIfNeeded();
      }).catch(function (err) {
        self._sessionCreationPromise = null;
        // 0.7.4 #125: route SDK-load failure to the container's
        // feature_load_failed security-event chokepoint. Gated on
        // _container being non-null (destroy() clears it — H3 contract:
        // teardown-mid-load is NOT a feature_load_failed) and the container
        // being non-terminated. /* warning already emitted */ — the warn
        // in _ensureSdkLoaded.catch is the dev-channel signal; this is the
        // structured-channel signal.
        if (self._container
            && !self._container._terminated
            && typeof self._container._emitFeatureLoadFailed === 'function') {
          var reason = self._classifySdkLoadError(err);
          // Prefer the URL that was being loaded when the failure occurred
          // (set by _ensureSdkLoaded before each _injectScriptWithTimeout call).
          // Falls back to omSdkServiceScriptUrl only when _loadingUrl is unset
          // (e.g. failure happened outside the reduce loop, or test stubs that
          // don't exercise the real loader).
          var scriptUrl = (typeof self._loadingUrl === 'string' && self._loadingUrl.length > 0)
            ? self._loadingUrl
            : ((self.options && typeof self.options.omSdkServiceScriptUrl === 'string')
                ? self.options.omSdkServiceScriptUrl
                : '');
          self._container._emitFeatureLoadFailed(FEATURE_NAME, reason, scriptUrl);
        }
      });
      return this._sessionCreationPromise;
    }
    this._createSession();
    this._signalActiveStateIfNeeded();
  },

  /**
   * Creates the container-side OM SDK AdSession.
   * @private
   */
  _createSession: function () {
    if (this._omid.sessionStarted || this._omid.sessionFinished) return;
    if (!isOmSdkLoaded()) {
      if (!this._hasSdkInjectionUrls()) {
        console.warn('[SHARC OMID Bridge] OM SDK not loaded on publisher page — cannot create container AdSession');
      }
      return;
    }

    var self = this;
    safeCall('container.createSession', function () {
      var omid = getOmidSessionClient();
      var partner = new omid.Partner(
        self.options.partnerName || DEFAULT_PARTNER_NAME,
        self.options.partnerVersion || DEFAULT_PARTNER_VERSION
      );
      var verificationScripts = self._buildVerificationScripts(omid);
      var context = new omid.Context(partner, verificationScripts);
      var contentUrl = self.options.contentUrl || (
        typeof window !== 'undefined' && window.location && window.location.href
      ) || '';
      if (contentUrl && typeof context.setContentUrl === 'function') {
        context.setContentUrl(contentUrl);
      }
      if (self.options.omSdkServiceScriptUrl && typeof context.setServiceScriptUrl === 'function') {
        context.setServiceScriptUrl(self.options.omSdkServiceScriptUrl);
      }

      self._omid.adSession = new omid.AdSession(context);
      if (typeof self._omid.adSession.setCreativeType === 'function') {
        self._omid.adSession.setCreativeType(self.options.creativeType || 'video');
      }
      if (typeof self._omid.adSession.setImpressionType === 'function') {
        self._omid.adSession.setImpressionType(self.options.impressionType || 'definedByJavaScript');
      }
      if (self._container && self._container._iframe &&
          typeof self._omid.adSession.registerAdView === 'function') {
        self._omid.adSession.registerAdView(self._container._iframe);
      }

      self._omid.adEvents = new omid.AdEvents(self._omid.adSession);
      self._omid.isVideoSession = ((self.options.mediaType || self.options.creativeType || 'video') !== 'display');
      if (self._omid.isVideoSession && omid.MediaEvents) {
        self._omid.mediaEvents = new omid.MediaEvents(self._omid.adSession);
      }
      if (typeof self._omid.adSession.registerSessionObserver === 'function') {
        self._omid.adSession.registerSessionObserver(function (sessionEvent) {
          if (!sessionEvent) return;
          // Relay OM-SDK-sourced session events to the iframe shim (§ 6.2).
          if (sessionEvent.type === 'sessionError') {
            self._relayOmidEvent('sessionError', sessionEvent.data || {});
          } else if (sessionEvent.type === 'sessionFinish') {
            self._relayOmidEvent('sessionFinish', sessionEvent.data || {});
            self._resetSessionRefs(true);
          }
        });
      }
      self._omid.adSession.start();
      self._omid.sessionStarted = true;
      self._omid.sessionFinished = false;
      // Record the creative-iframe origin for outbound posting (§ 6.2 step 2).
      //   - Markup variant: the renderer's validated origin (`_rendererOrigin`).
      //   - URL + `useMarkupInjection` (`srcdoc`) variant: there is no renderer,
      //     so `_rendererOrigin` is null. A srcdoc frame inherits the publisher
      //     origin (Chromium) or is opaque (Safari/others). Outbound `:Event`
      //     posts target the publisher origin; the shim tolerates the opaque
      //     case via its load-bearing `event.source === parent` check (§ 7.4).
      //     This keeps `_relayOmidEvent`'s C1 fail-closed guard from refusing to
      //     post on the no-renderer path (it would otherwise see a null origin
      //     and drop every event).
      if (self._container) {
        var iframeOrigin = self._container._rendererOrigin;
        if (!iframeOrigin && self._container._useMarkupInjection
            && typeof window !== 'undefined' && window.location) {
          iframeOrigin = window.location.origin;
        }
        self._omidIframeOrigin = iframeOrigin || self._omidIframeOrigin;
      }
      // OMID session has started on the publisher page — this is router
      // § 4.1's documented `omid-active` entry condition. Drive the phase
      // transition via the container (OMID-Q2 res. b), then relay sessionStart.
      self._signalOmidPhase('omid-active');
      self._relayOmidEvent('sessionStart', {});
      if (self._friendlyObstruction) {
        self.registerFriendlyObstruction(self._friendlyObstruction);
      }
    });
  },

  /**
   * Converts configured verification-script descriptors to OM SDK resources
   * when the SDK exposes VerificationScriptResource. Already-constructed
   * resources are passed through.
   *
   * @param {Object} omid
   * @returns {Array}
   * @private
   */
  _buildVerificationScripts: function (omid) {
    if (this._verificationScripts) return this._verificationScripts;
    var scripts = this.options.verificationScripts || [];
    if (!omid || !omid.VerificationScriptResource) {
      this._verificationScripts = scripts;
      return this._verificationScripts;
    }
    this._verificationScripts = scripts.map(function (script) {
      var resourceUrl = getVerificationScriptResourceUrl(script);
      if (!resourceUrl) return script;
      return new omid.VerificationScriptResource(
        resourceUrl,
        script.vendor || script.vendorKey || '',
        script.verificationParameters || '',
        script.accessMode || 'limited'
      );
    });
    return this._verificationScripts;
  },

  /**
   * Fires OM SDK loaded() once.
   * @private
   */
  _fireLoaded: function () {
    var self = this;
    if (!this._omid.sessionStarted || !this._omid.adEvents || this._omid.loadedFired) return;
    this._omid.loadedFired = true;
    safeCall('container.adEvents.loaded', function () {
      var omid = getOmidSessionClient();
      var vp = self.options.vastProperties || {};
      if (omid && omid.VastProperties && self._omid.isVideoSession) {
        self._omid.adEvents.loaded(new omid.VastProperties(
          !!vp.isSkippable,
          typeof vp.skipOffset === 'number' ? vp.skipOffset : 0,
          vp.isAutoPlay !== false,
          vp.position || 'standalone'
        ));
      } else {
        self._omid.adEvents.loaded();
      }
    });
    this._relayOmidEvent('loaded', {});
  },

  /**
   * Fires OM SDK impression once when the container first becomes active.
   * @private
   */
  _fireImpression: function () {
    var self = this;
    if (!this._omid.sessionStarted || !this._omid.adEvents || this._omid.impressionFired) return;
    this._omid.impressionFired = true;
    safeCall('container.adEvents.impressionOccurred', function () {
      self._omid.adEvents.impressionOccurred();
    });
    this._relayOmidEvent('impression', {});
  },

  /**
   * Best-effort viewability/state re-evaluation on visibility transitions.
   * @param {'visible'|'notVisible'} visibilityState
   * @private
   */
  _signalVisibility: function (visibilityState) {
    var self = this;
    if (!this._omid.sessionStarted || this._omid.lastVisibilityState === visibilityState) return;
    this._omid.lastVisibilityState = visibilityState;
    safeCall('container.visibilityState', function () {
      if (self._omid.adEvents && typeof self._omid.adEvents.stateChange === 'function') {
        self._omid.adEvents.stateChange(visibilityState === 'visible' ? 'VISIBLE' : 'NON_VISIBLE');
      }
      if (self._omid.mediaEvents && typeof self._omid.mediaEvents.playerStateChange === 'function') {
        self._omid.mediaEvents.playerStateChange(visibilityState === 'visible' ? 'normal' : 'minimized');
      }
    });
    // Relay as geometryChange (emission-side rate-limited in _relayOmidEvent).
    this._relayOmidEvent('geometryChange', { visibility: visibilityState });
  },

  /**
   * Handles resize / expand / collapse placement notifications.
   * @param {Object} event
   * @private
   */
  _handlePlacementChange: function (event) {
    if (!this._omid.sessionStarted) return;
    var mode = (event && event.intent) || 'normal';
    if (mode === 'expand') mode = 'expanded';
    if (mode === 'resize') mode = 'normal';
    if (this._omid.lastPlacementMode === mode) {
      // Placement mode can be unchanged while container state changes, so keep
      // visibility in sync even when there is no playerStateChange to send.
      this._signalVisibility(this._isContainerState('active') ? 'visible' : 'notVisible');
      return;
    }
    this._omid.lastPlacementMode = mode;
    var self = this;
    safeCall('container.placementChange', function () {
      if (self._omid.mediaEvents && typeof self._omid.mediaEvents.playerStateChange === 'function') {
        self._omid.mediaEvents.playerStateChange(mode);
      }
    });
    this._signalVisibility(this._isContainerState('active') ? 'visible' : 'notVisible');
  },

  /**
   * Finishes the OM SDK session and cleans references. Idempotent.
   * @private
   */
  _finishSession: function () {
    var self = this;
    if (this._omid.sessionFinished) return;
    var wasStarted = this._omid.sessionStarted;
    this._omid.sessionFinished = true;
    // Enter the `omid-finishing` grace window BEFORE finish()/reset so the
    // final `sessionFinish` Event is in-phase when relayed (Risk R1). Driven
    // container-internally (OMID-Q2 res. b); never from an inbound envelope.
    if (wasStarted) {
      this._signalOmidPhase('omid-finishing');
    }
    if (this._omid.adSession && typeof this._omid.adSession.finish === 'function') {
      safeCall('container.adSession.finish', function () {
        self._omid.adSession.finish();
      });
    }
    // Relay the terminal sessionFinish to the iframe shim while still in the
    // `omid-finishing` window. The OM SDK observer may also have relayed one on
    // its own `sessionFinish` callback; the shim treats sessionFinish as a
    // session-singleton (it drops omid3p on the first), so a duplicate is
    // harmless.
    if (wasStarted) {
      this._relayOmidEvent('sessionFinish', {});
    }
    // Fail-closed: if the session terminates synchronously before the OMID nonce
    // resolves, _resetSessionRefs clears _omidPendingRelays — those queued relays
    // are intentionally dropped (the shim's 3p session never started, so there is
    // nothing to finish).
    this._resetSessionRefs(true);
  },

  /**
   * Clears active session references.
   * @param {boolean} finished
   * @private
   */
  _resetSessionRefs: function (finished) {
    this._omid.adSession = null;
    this._omid.adEvents = null;
    this._omid.mediaEvents = null;
    this._omid.sessionStarted = false;
    this._omid.sessionFinished = !!finished;
    // C6: the envelope sequence and geometry rate-limit clock are per-session
    // (design § 3.3 / § 3.5). The constructor zeroes them at birth; a session
    // teardown must zero them too so the next session starts at sequence 0
    // rather than continuing the prior session's monotonic counter.
    this._omidSequence = 0;
    this._omidLastGeometryEmitMs = 0;
    // C5 (extended): drop any active-burst relays still queued against the
    // dead session. `onReady` fires at most once per registration
    // (`_registerOmidProtocol` early-returns once registered), so the only way
    // a stale entry could survive is a teardown between enqueue and flush;
    // clearing here guarantees it can never replay into a later session.
    this._omidPendingRelays = [];
  },

  /**
   * Classifies an OM SDK load failure into one of the canonical
   * `feature_load_failed.details.reason` tokens (0.7.4 ADR § 2.2):
   * `'timeout'`, `'network'`, `'evaluation_throw'`. Pure string-matching
   * over the failure's message — browsers don't expose HTTP status codes
   * on `<script>` load failures (the `onerror` handler fires with no
   * status detail), so 404 vs. transport failure is indistinguishable
   * here and both surface as `'network'`.
   *
   * @param {Error|unknown} err
   * @returns {string} classified reason token
   * @private
   */
  _classifySdkLoadError: function (err) {
    var msg = (err && typeof err.message === 'string') ? err.message : String(err || '');
    if (/timed out/i.test(msg)) return 'timeout';
    if (/failed to load/i.test(msg)) return 'network';
    return 'evaluation_throw';
  },

  /**
   * Public cleanup hook called by SHARCContainer.
   *
   * Multi-instance contract (0.7.3 follow-up #127): each bridge instance
   * owns and removes ONLY the `<script>` tags IT actually injected.
   * `_injectScript` skips DOM injection (and the push to `_loadedScripts`)
   * when it finds an existing matching tag — that tag remains owned by
   * whoever appended it. If two `OmidCompatBridge` instances configured
   * with the same OM SDK URL coexist on a page, instance B sees A's tag
   * and resolves early without tracking it; A.destroy() removes the
   * shared tag while B's `_loadedScripts` stays empty. OM SDK globals
   * (`window.omid`, `window.OmidSessionClient`) persist after the script
   * element is removed, so B's existing AdSession keeps working — but
   * no instance will re-inject the SDK after that. Operators running
   * multiple OMID bridges on one page should expect at-most-one cleanup
   * pass to fire; long-lived multi-instance setups are out of scope for
   * the 0.7.3 cleanup model.
   */
  destroy: function () {
    this.unregisterFriendlyObstruction();
    this._finishSession();
    for (var i = 0; i < this._loadedScripts.length; i++) {
      var script = this._loadedScripts[i];
      if (script && script.parentNode) {
        script.parentNode.removeChild(script);
      }
    }
    this._loadedScripts = [];
    this._sessionCreationPromise = null;
    this._loadingUrl = null;
    this._container = null;
  },

  // ── 0.7.8 router consumption: OMID as 'SHARC:Omid:' protocol ─────────

  /**
   * Registers the OMID router protocol (prefix `SHARC:Omid:`) on the container's
   * protocol router. The OMID bridge is a PURE CONSUMER (OMID-D7): zero
   * router-side code. The handler does payload-shape + dispatch ONLY — the
   * router gate already validated source/origin/nonce/placementSessionId/
   * prefix/type/phase before the handler runs (router § 3.2). There is NO
   * bespoke `window.addEventListener('message')` in this bridge.
   *
   * Type map (§ 3.2): `Register`/`Unregister` are inbound and gated to
   * `omid-active` ONLY — the iframe shim defers posting `Register` until
   * `sessionStart`, so a legitimate registration can never arrive earlier
   * (OMID-Q1). `Event` is outbound, valid across `omid-active` + the
   * `omid-finishing` grace window.
   *
   * @param {Object} container
   * @private
   */
  _registerOmidProtocol: function (container) {
    if (this._omidProtocolRegistered) return;
    if (!container || !container.protocolRouter
        || typeof container.protocolRouter.register !== 'function') {
      return;
    }
    this._omidProtocolRegistered = true;
    var self = this;
    container.protocolRouter.register({
      prefix: OMID_PROTOCOL_PREFIX,
      types: {
        'Register':   { phases: ['omid-active'], direction: 'inbound' },
        'Unregister': { phases: ['omid-active'], direction: 'inbound' },
        'Event':      { phases: ['omid-active', 'omid-finishing'], direction: 'outbound' },
      },
      handler: function (envelope, context) {
        self._handleOmidEnvelope(envelope, context);
      },
      onReady: function (info) {
        // Router-derived OMID per-protocol nonce. Stash for outbound
        // construction and for trusted injection into the shim (§ 4.3).
        // NEVER echoed to vendor JS.
        self._omidProtocolNonce = info ? info.protocolNonce : null;
        // C5 (extended): if any active-burst relays raced ahead of nonce
        // derivation, flush them now — each exactly once, in the chronological
        // order they were enqueued (sessionStart → loaded → impression → first
        // geometryChange). Guard on a resolved nonce so a null/absent `info`
        // does not re-enter `_relayOmidEvent` and immediately re-enqueue every
        // event (which would also strand them). The shim's replay invariant
        // depends on this order, and `sessionStart` arriving first is what flips
        // its `sessionStarted` gate.
        if (self._omidProtocolNonce !== null) {
          self._flushPendingOmidRelays();
        }
      },
    });
  },

  /**
   * Renderer Markup-variant trusted-injection accessor (§ 4.3 mechanism i).
   *
   * The container queries this at the `SHARC:Renderer:render` envelope-build
   * site to decide whether to flag OMID on the render envelope and which OMID
   * `protocolNonce` to deliver to the renderer for source-rewrite into the
   * shim. Returns `null` whenever OMID is not active for this placement so the
   * container leaves the render envelope byte-identical to the OMID-off path:
   *
   *   - `exposeOmid3p` opted out (`false`) → no shim install (OMID-D21).
   *   - The OMID router protocol is not registered yet → no nonce to deliver.
   *   - The router-derived `protocolNonce` has not arrived via `onReady` → the
   *     nonce derivation (a microtask chain kicked off synchronously at
   *     container `load`) has not resolved. In practice it resolves long before
   *     the iframe `load` macrotask, but returning `null` keeps the contract
   *     honest if it ever races.
   *
   * The returned nonce is delivered ONLY over the renderer-protocol channel
   * (already gated by the renderer's own nonce/origin/source) to the trusted
   * renderer; it is NEVER exposed to the creative here. The renderer bakes it
   * into the shim as a closure constant (§ 4.3 mechanism i).
   *
   * @returns {{ protocolNonce: string }|null}
   */
  getRendererOmidInjection: function () {
    if (this.options.exposeOmid3p === false) return null;
    if (!this._omidProtocolRegistered) return null;
    if (typeof this._omidProtocolNonce !== 'string'
        || this._omidProtocolNonce.length === 0) {
      return null;
    }
    return { protocolNonce: this._omidProtocolNonce };
  },

  /**
   * URL/`srcdoc` variant trusted-injection accessor (§ 4.3 mechanism ii). The
   * counterpart to `getRendererOmidInjection` for the no-renderer path.
   *
   * The container queries this in two places, which MUST agree:
   *   1. `injectIntoMarkup(html)` — to decide whether to prepend the shim +
   *      port-receiver prelude into the `srcdoc`.
   *   2. The iframe `load` handler — to decide whether to create the
   *      `MessageChannel`, transfer a port into the frame, and deliver the OMID
   *      `protocolNonce` over it.
   *
   * Returns `null` whenever OMID is not active for this placement, so both
   * sites no-op together and the `srcdoc` stays byte-identical to the OMID-off
   * path. Same gate as `getRendererOmidInjection` plus the transport anchors the
   * prelude needs inlined (non-secret: `placementSessionId` + `containerOrigin`).
   *
   * The returned `protocolNonce` is for the container's port-transfer step ONLY;
   * it is NEVER inlined into the `srcdoc` source (that would re-introduce the
   * #254 DOM-readable exposure). It travels exclusively over the transferred
   * MessagePort.
   *
   * @returns {{ protocolNonce: string, placementSessionId: string, containerOrigin: string }|null}
   */
  getSrcdocOmidInjection: function () {
    if (this.options.exposeOmid3p === false) return null;
    if (!this._omidProtocolRegistered) return null;
    if (typeof this._omidProtocolNonce !== 'string'
        || this._omidProtocolNonce.length === 0) {
      return null;
    }
    var container = this._container;
    var psid = (container && typeof container.placementSessionId === 'string')
      ? container.placementSessionId
      : null;
    if (psid === null) return null;
    var containerOrigin = (typeof window !== 'undefined' && window.location)
      ? window.location.origin
      : '';
    return {
      protocolNonce: this._omidProtocolNonce,
      placementSessionId: psid,
      containerOrigin: containerOrigin,
    };
  },

  /**
   * Handles a router-validated inbound `SHARC:Omid:` envelope. Payload-shape +
   * dispatch ONLY — the router already gated the envelope (NEVER re-validate
   * source/origin/nonce/placementSessionId/phase here). The inbound surface is
   * the registration handshake (`Register`/`Unregister`); `Event` is outbound
   * only, so it never reaches this handler.
   *
   * @param {Object} envelope - router-validated `event.data`
   * @param {Object} context  - frozen `{ type, phase, protocolNonce, raisedAt }`
   * @private
   */
  _handleOmidEnvelope: function (envelope, context) {
    if (!envelope || typeof envelope !== 'object') return;
    var type = context ? context.type : undefined;
    var sub = envelope.subscription;
    if ((type === 'Register' || type === 'Unregister')) {
      if (!sub || typeof sub !== 'object') return;
      if (typeof sub.subscriptionId !== 'string' || sub.subscriptionId.length === 0) return;
      if (sub.kind !== 'sessionObserver' && sub.kind !== 'eventListener') return;
      // 0.7.8 PR 1 relays publisher AdSession events to the iframe shim; the
      // shim materializes the local subscription and replays the cached log.
      // The publisher side records the handshake for diagnostics; no
      // per-subscription publisher state is required for the relay model
      // (events are broadcast to the iframe, the shim fans out per § 7.2).
      // `Unregister` ack machinery is part of the shim's callbackMap (dep 7).
    }
  },

  /**
   * Returns the next monotonic uint32 sequence for outbound OMID envelopes.
   * @returns {number}
   * @private
   */
  _nextOmidSequence: function () {
    this._omidSequence = (this._omidSequence + 1) >>> 0;
    return this._omidSequence;
  },

  /**
   * Relays a publisher-page AdSession event to the iframe shim as a
   * `SHARC:Omid:Event` envelope built via the router's `buildOutbound` helper
   * (which stamps `type`/`sharcNonce`/`placementSessionId`). The bridge does
   * the actual `postMessage` (the router does not post outbound — router
   * § 2.5). Faithful relay only: no SHARC- or publisher-specific fields are
   * added (OMID-D5).
   *
   * @param {string} type - EventType (§ 5.3)
   * @param {Object} [data] - event-type-specific payload
   * @private
   */
  _relayOmidEvent: function (type, data) {
    if (!this.options.exposeOmid3p) return;
    if (!this._omidProtocolRegistered) return;
    var container = this._container;
    if (!container || !container.protocolRouter
        || typeof container.protocolRouter.buildOutbound !== 'function') {
      return;
    }
    if (this._omidProtocolNonce === null) {
      // C5 (extended): nonce not derived yet. The whole active-burst races the
      // nonce — `sessionStart`, `loaded`, `impression`, and the first
      // `geometryChange` are relayed in one synchronous burst, and each would be
      // dropped here. The earlier C5 fix re-drove `sessionStart` only, so
      // `loaded`/`impression` were lost permanently (their `*Fired` flags are
      // set by the burst caller BEFORE the relay, so the caller never relays
      // them again). Queue every dropped relay in order; `onReady` flushes the
      // queue once the nonce resolves, exactly once each, in arrival order. No
      // sequence number is consumed here — `_nextOmidSequence` runs only on the
      // successful post path at flush time, so the flushed burst gets a clean
      // monotonic 1,2,3,… with no double-consume or skip.
      this._omidPendingRelays.push({
        type: type,
        data: (data && typeof data === 'object') ? data : {},
      });
      return;
    }
    var iframe = container._iframe;
    if (!iframe || !iframe.contentWindow) return;

    // Emission-side geometryChange rate-limit (≤1/100ms — § 7.3 / OMID-D20).
    if (type === 'geometryChange') {
      var now = Date.now();
      if (now - this._omidLastGeometryEmitMs < OMID_GEOMETRY_MIN_INTERVAL_MS) return;
      this._omidLastGeometryEmitMs = now;
    }

    var self = this;
    safeCall('omid.relayEvent', function () {
      var envelope = container.protocolRouter.buildOutbound(OMID_PROTOCOL_PREFIX, 'Event', {
        sequence: self._nextOmidSequence(),
        event: {
          adSessionId: self._omidAdSessionId(),
          timestamp: Date.now(),
          type: type,
          data: (data && typeof data === 'object') ? data : {},
        },
      });
      // SECURITY (C1): the envelope carries the OMID protocolNonce. FAIL CLOSED
      // when there is no concrete target origin — NEVER fall back to `'*'`,
      // which would broadcast the nonce to any origin. Mirrors the shim's
      // postRegister refusal on the same secret (sharc-omid-shim.js § 5.2).
      var origin = self._omidIframeOrigin || container._rendererOrigin;
      if (!origin) {
        console.warn('[SHARCOmid] refusing to relay OMID event without a concrete iframe origin (would broadcast the protocolNonce to any origin)');
        return;
      }
      iframe.contentWindow.postMessage(envelope, origin);
    });
  },

  /**
   * Flushes the active-burst relay queue accumulated while the router-derived
   * nonce was unresolved (C5, extended). Drains the queue to a local snapshot
   * BEFORE relaying so a relay-time re-entrant call cannot mutate the array
   * mid-iteration, then replays each entry through `_relayOmidEvent` in arrival
   * order. With the nonce now resolved each replay posts inline (it cannot
   * re-enqueue), so the burst reaches the shim exactly once each, in
   * chronological order, consuming a clean monotonic sequence per event.
   *
   * Caller must ensure `_omidProtocolNonce !== null` before invoking — otherwise
   * every replayed relay would immediately re-enqueue itself.
   * @private
   */
  _flushPendingOmidRelays: function () {
    if (this._omidPendingRelays.length === 0) return;
    var pending = this._omidPendingRelays;
    this._omidPendingRelays = [];
    for (var i = 0; i < pending.length; i++) {
      this._relayOmidEvent(pending[i].type, pending[i].data);
    }
  },

  /**
   * Reads the OM SDK AdSession id off the publisher-page session, when the SDK
   * exposes it. Reused for every event in the session (§ 5.2). Falls back to
   * the container `placementSessionId` only as a stable correlation handle when
   * the stub/SDK does not surface a session id.
   *
   * @returns {string}
   * @private
   */
  _omidAdSessionId: function () {
    var session = this._omid && this._omid.adSession;
    if (session) {
      if (typeof session.sessionId === 'string' && session.sessionId.length > 0) {
        return session.sessionId;
      }
      if (session.context && typeof session.context.sessionId === 'string') {
        return session.context.sessionId;
      }
    }
    return (this._container && this._container.placementSessionId) || '';
  },

  /**
   * Emits a container-internal OMID lifecycle signal so the CONTAINER can drive
   * `transitionTo('omid-active')` / `transitionTo('omid-finishing')` from within
   * `sharc-container.js` (OMID-Q2 resolution b — `transitionTo` stays
   * container-internal per RTR-D14, and router § 9.6 test #1 requires the
   * `transitionTo` site to live in the container).
   *
   * Trust constraint (§ 3.4): the signal is sourced ONLY from publisher-page
   * OMID session state (`AdSession.start()` success / `finish()`). It is NEVER
   * triggered by an inbound `SHARC:Omid:` envelope.
   *
   * @param {'omid-active'|'omid-finishing'} phase
   * @private
   */
  _signalOmidPhase: function (phase) {
    var container = this._container;
    if (!container || typeof container._onOmidLifecycleSignal !== 'function') return;
    safeCall('omid.signalPhase', function () {
      container._onOmidLifecycleSignal(phase);
    });
  },

  // ── Friendly obstruction management ────────────────────────────────

  /**
   * Registers a DOM element as a friendly obstruction on the active OM SDK
   * AdSession. Called by the container when a close button is rendered over
   * the ad iframe. The OM SDK will exclude this element from viewability
   * obstruction calculations.
   *
   * Safe to call multiple times with the same element — duplicate registrations
   * are suppressed. Call `unregisterFriendlyObstruction()` when the element is
   * removed.
   *
   * @param {HTMLElement} element - The DOM element to register (e.g. close button).
   * @param {string} [purpose='closeAd'] - OM SDK FriendlyObstructionPurpose string.
   * @param {string} [reason='Container close button'] - Human-readable reason.
   */
  registerFriendlyObstruction: function (element, purpose, reason) {
    // Cast to any to allow access to _friendlyObstruction private property
    var self = /** @type {any} */ (this);
    if (!element) return;
    if (self._friendlyObstruction === element && self._friendlyObstructionRegistered) return;

    // Unregister previous obstruction if switching elements
    if (self._friendlyObstruction && self._friendlyObstruction !== element) {
      this.unregisterFriendlyObstruction();
    }

    self._friendlyObstruction = element;
    self._friendlyObstructionRegistered = false;

    safeCall('registerFriendlyObstruction', function () {
      var adSession = self._omid && self._omid.adSession;
      if (adSession && typeof adSession.addFriendlyObstruction === 'function') {
        // Cast to any to allow calling the method on the session
        /** @type {any} */ (adSession).addFriendlyObstruction(
          element,
          purpose || 'closeAd',
          reason  || 'Container close button'
        );
        self._friendlyObstructionRegistered = true;
      }
    });
  },

  /**
   * Unregisters the currently tracked friendly obstruction from the OM SDK
   * AdSession. Called by the container when the close button is removed
   * (e.g. on collapse).
   *
   * Idempotent — safe to call when no obstruction is registered.
   */
  unregisterFriendlyObstruction: function () {
    // Cast to any to allow access to _friendlyObstruction private property
    var self = /** @type {any} */ (this);
    var element = self._friendlyObstruction;
    if (!element) return;
    self._friendlyObstruction = null;
    var wasRegistered = self._friendlyObstructionRegistered;
    self._friendlyObstructionRegistered = false;
    if (!wasRegistered) return;

    safeCall('unregisterFriendlyObstruction', function () {
      var adSession = self._omid && self._omid.adSession;
      if (adSession && typeof adSession.removeFriendlyObstruction === 'function') {
        // Cast to any to allow calling the method on the session
        /** @type {any} */ (adSession).removeFriendlyObstruction(element);
      }
    });
  },

}); // end OmidCompatBridge.prototype

// ---------------------------------------------------------------------------
// ESM exports
// ---------------------------------------------------------------------------

export { OmidCompatBridge };

// Legacy IIFE support - ensure global namespace is available even with sideEffects: false
if (typeof window !== 'undefined' && typeof window.SHARC !== 'undefined' && !window.SHARC.OmidCompatBridge) {
  window.SHARC.OmidCompatBridge = OmidCompatBridge;
}
