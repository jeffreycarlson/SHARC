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
 *     `'com.iabtechlab.sharc.omid'` in Container:init, and reacts to generic
 *     container lifecycle events.
 *
 * Key OM SDK constraints enforced by this bridge:
 *   - OM SDK service script MUST be loaded before AdSession is created
 *   - Only ONE AdEvents instance per session (error on duplicate)
 *   - Only ONE MediaEvents instance per session (error on duplicate)
 *   - creativeType and impressionType MUST be set before impressionOccurred()
 *   - AdSession must be started before any events are fired
 *
 * @version 0.7.2
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

    var parsed;
    try {
      parsed = new URL(resourceUrl);
    } catch (e) {
      throwOmidConfigError('verificationScripts[' + i + '].resourceUrl must be a valid HTTPS URL');
    }
    if (parsed.protocol !== 'https:') {
      throwOmidConfigError('verificationScripts[' + i + '].resourceUrl must use HTTPS');
    }
    if (parsed.username || parsed.password) {
      throwOmidConfigError('verificationScripts[' + i + '].resourceUrl must not include userinfo');
    }

    var dedupeKey = parsed.href;
    if (seen[dedupeKey]) continue;
    seen[dedupeKey] = true;
    if (typeof script.resourceUrl !== 'string') {
      script.resourceUrl = resourceUrl;
    }
    validated.push(script);
  }
  return validated;
}

// -------------------------------------------------------------------------
// OmidCompatBridge — container-side extension plugin
// -------------------------------------------------------------------------

/**
 * Container-side extension plugin for the OMID bridge.
 *
 * Registers the OMID feature name in Container:init, loads OM SDK scripts on
 * the publisher page, and manages the container-owned OM SDK session lifecycle.
 *
 * Usage:
 * ```javascript
 * const bridge = new OmidCompatBridge({
 *   omSdkServiceScriptUrl: '/vendor/omweb-v1.js',
 *   omSdkSessionClientUrl: '/vendor/omid-session-client-v1.js',
 *   partnerName: 'MyPublisher',
 *   partnerVersion: '1.0.0',
 *   verificationScripts: [...],
 * });
 *
 * const container = new SHARCContainer({
 *   supportedFeatures: [bridge.getFeatureDescriptor()],
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
  this.options.verificationScripts = validateVerificationScripts(this.options.verificationScripts);

  /** @private */
  this._container = null;
  /** @private */
  this._sdkLoadPromise = null;
  /** @private */
  this._sdkLoadStarted = false;
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
   * Returns the feature name string for Container:init supportedFeatures.
   * @returns {string} 'com.iabtechlab.sharc.omid'
   */
  getFeatureName: function () {
    return this.name;
  },

  /**
   * Returns a feature descriptor object suitable for the supportedFeatures
   * array in Container:init. Includes capability metadata for the creative.
   *
   * @returns {{ name: string, version: string, capabilities: Object }}
   */
  getFeatureDescriptor: function () {
    return {
      name:    this.name,
      version: BRIDGE_VERSION,
      capabilities: {
        // Indicates the OM SDK service and session client are loaded by the container
        sdkInjected:          true,
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
   * Returns the wrapper URL for a given creative URL.
   *
   * The container should load this URL in the ad iframe instead of the
   * creative directly. OMID remains container-owned; this legacy helper only
   * constructs the wrapper URL.
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
      case 'load':
        this._ensureSdkLoaded();
        break;
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

    var urls = [];
    var serviceUrl = this.options.omSdkServiceScriptUrl;
    var clientUrl = this.options.omSdkSessionClientUrl;
    if (serviceUrl) urls.push(serviceUrl);
    if (clientUrl) urls.push(clientUrl);

    if (urls.length === 0) {
      return Promise.resolve();
    }

    this._sdkLoadStarted = true;
    var self = this;
    this._sdkLoadPromise = urls.reduce(function (chain, url) {
      return chain.then(function () {
        // A publisher may already have loaded the OM SDK service; in that case
        // keep the session-client step idempotent instead of injecting it again.
        if (isOmSdkLoaded() && url === clientUrl) return undefined;
        return self._injectScriptWithTimeout(url, 5000);
      });
    }, Promise.resolve()).then(function () {
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
      var existing = document.querySelector('script[src="' + String(url).replace(/"/g, '\\"') + '"]');
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
      return;
    }
    var loaded = this._ensureSdkLoaded();
    if (loaded && typeof loaded.then === 'function') {
      loaded.then(function () {
        self._createSession();
        if (self._container && self._container.getState && self._container.getState() === 'active') {
          self._fireLoaded();
          self._fireImpression();
          self._signalVisibility('visible');
        }
      }).catch(function () { /* warning already emitted */ });
      return;
    }
    this._createSession();
  },

  /**
   * Creates the container-side OM SDK AdSession.
   * @private
   */
  _createSession: function () {
    if (this._omid.sessionStarted || this._omid.sessionFinished) return;
    if (!isOmSdkLoaded()) {
      if (!this.options.omSdkServiceScriptUrl && !this.options.omSdkSessionClientUrl) {
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
      this._signalVisibility(this._container && this._container.getState && this._container.getState() === 'active' ? 'visible' : 'notVisible');
      return;
    }
    this._omid.lastPlacementMode = mode;
    var self = this;
    safeCall('container.placementChange', function () {
      if (self._omid.mediaEvents && typeof self._omid.mediaEvents.playerStateChange === 'function') {
        self._omid.mediaEvents.playerStateChange(mode);
      }
    });
    this._signalVisibility(this._container && this._container.getState && this._container.getState() === 'active' ? 'visible' : 'notVisible');
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
   * Public cleanup hook called by SHARCContainer.
   */
  destroy: function () {
    this.unregisterFriendlyObstruction();
    this._finishSession();
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
