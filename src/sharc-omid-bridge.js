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
 * @version 0.7.4
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
 *   Must resolve to trusted SHARC-hosted assets when wrapperUrl is used.
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

  /** @private */
  this._container = null;
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
   * Returns creative markup unchanged.
   *
   * This is the method called by `SHARCContainer._fetchAndInjectCreative()`
   * when an extension is detected as an injector. For OMID this method is a
   * true no-op because OM SDK scripts stay in the publisher page:
   *
   *   container calls: `extension.injectIntoMarkup(html)` → string
   *
   * @param {string} html - The raw creative HTML markup.
   * @returns {string} The raw creative HTML markup, unchanged.
   */
  injectIntoMarkup: function (html) {
    return html;
  },

  /**
   * Returns a wrapper URL for a given creative URL.
   *
   * **Status (#127 sub-3c):** legacy compatibility stub. The container-owned
   * OMID model (0.7.3, PR #122) does NOT use a wrapper-page approach — OM
   * SDK runs on the publisher page and the creative iframe loads the
   * creative directly. This method exists for bridge-interface parity with
   * `MRAIDCompatBridge.getWrapperUrl` and `SafeFrameCompatBridge.getWrapperUrl`
   * (where the wrapper page is still part of the legacy flow). Operators
   * should NOT call this method for OMID setup; OMID lifecycle is driven by
   * the container directly via `OmidCompatBridge` as an extension. Retirement
   * of `getWrapperUrl` across all three bridges is a separate decision not
   * scoped to 0.7.3.
   *
   * @param {string} creativeUrl - Original creative URL.
   * @returns {string} The wrapper URL.
   */
  getWrapperUrl: function (creativeUrl) {
    var base = this.options.baseUrl || '/sharc';
    return base + '/omid-wrapper.html?creative=' + encodeURIComponent(creativeUrl);
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
          if (sessionEvent && sessionEvent.type === 'sessionFinish') {
            self._resetSessionRefs(true);
          }
        });
      }
      self._omid.adSession.start();
      self._omid.sessionStarted = true;
      self._omid.sessionFinished = false;
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
    this._omid.sessionFinished = true;
    if (this._omid.adSession && typeof this._omid.adSession.finish === 'function') {
      safeCall('container.adSession.finish', function () {
        self._omid.adSession.finish();
      });
    }
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
