/**
 * @fileoverview SHARC OMID Bridge
 *
 * Bridges the SHARC container protocol to the IAB Open Measurement SDK (OM SDK)
 * JavaScript API. Creatives signal measurement intent through standard SHARC
 * messages; this bridge translates those signals into OM SDK API calls.
 *
 * Architecture:
 *   - Container side: `OmidCompatBridge` — a plugin that injects the OM SDK
 *     service script and session client into the creative's HTML, and registers
 *     the feature name `'com.iabtechlab.sharc.omid'` in Container:init.
 *   - Bridge side: `installOmidBridge()` — called in the creative frame after
 *     the OM SDK scripts are loaded; listens to SHARC events and drives the
 *     OM SDK session lifecycle.
 *
 * Load order in the creative iframe:
 *   1. omweb-v1.js              → window.OmidSessionClient (OM SDK Service)
 *   2. omid-session-client-v1.js → OmidSessionClient namespace
 *   3. sharc-protocol.js        → window.SHARC.Protocol
 *   4. sharc-creative.js        → window.SHARC (SDK methods)
 *   5. sharc-omid-bridge.js     → installs OMID bridge (this file, browser mode)
 *   6. <creative>
 *
 * Key OM SDK constraints enforced by this bridge:
 *   - OM SDK service script MUST be loaded before AdSession is created
 *   - Only ONE AdEvents instance per session (error on duplicate)
 *   - Only ONE MediaEvents instance per session (error on duplicate)
 *   - creativeType and impressionType MUST be set before impressionOccurred()
 *   - AdSession must be started before any events are fired
 *
 * @version 0.1.0
 * @see https://iabtechlab.com/standards/open-measurement-sdk/
 * @see https://github.com/IABTechLab/SHARC
 */

'use strict';

// ---------------------------------------------------------------------------
// UMD wrapper — same pattern as sharc-mraid-bridge.js / sharc-safeframe-bridge.js
// ---------------------------------------------------------------------------
(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    // CommonJS / Node.js
    module.exports = factory();
  } else {
    // Browser script-tag mode
    var result = factory();

    // Expose OmidCompatBridge on SHARC namespace for container use
    window.SHARC = window.SHARC || {};
    window.SHARC.OmidCompatBridge = result.OmidCompatBridge;

    // Auto-install bridge if SHARC creative SDK is already present
    if (window.SHARC && typeof window.SHARC.onReady === 'function') {
      result.installOmidBridge(window.SHARC);
    }
  }
}(function () {

  // -------------------------------------------------------------------------
  // Internal constants
  // -------------------------------------------------------------------------

  /** Feature name advertised in Container:init supportedFeatures array. */
  var FEATURE_NAME = 'com.iabtechlab.sharc.omid';

  /** Bridge version — should be kept in sync with the SHARC spec release. */
  var BRIDGE_VERSION = '0.1.0';

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

  /**
   * Safely resolves the OmidSessionClient namespace from the global scope.
   * The OM SDK session client script exposes `OmidSessionClient` globally.
   *
   * @returns {Object|null} The OmidSessionClient namespace, or null if not loaded.
   */
  function getOmidSessionClient() {
    if (typeof OmidSessionClient !== 'undefined') {
      return OmidSessionClient;
    }
    // Fallback: some integrations expose it on window explicitly
    if (typeof window !== 'undefined' && window.OmidSessionClient) {
      return window.OmidSessionClient;
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

  // -------------------------------------------------------------------------
  // installOmidBridge — creative-frame session management
  // -------------------------------------------------------------------------

  /**
   * Installs the OMID bridge in the creative iframe.
   * Connects the SHARC Creative SDK event stream to the OM SDK session lifecycle.
   *
   * Safe to call multiple times — singleton guard prevents double-installation.
   *
   * @param {Object} SHARC - The window.SHARC SDK object (from sharc-creative.js).
   * @param {Object} [options] - Optional configuration.
   * @param {string} [options.partnerName] - OM SDK partner name (default: 'SHARCOmidBridge').
   * @param {string} [options.partnerVersion] - OM SDK partner version (default: BRIDGE_VERSION).
   * @param {Array}  [options.verificationScripts] - Array of OM SDK VerificationScriptResource objects.
   * @param {string} [options.creativeType] - OM SDK creative type: 'video'|'display' (default: 'video').
   * @param {string} [options.impressionType] - OM SDK impression type: 'definedByJavaScript'|'beginToRender'|'onePixel' (default: 'definedByJavaScript').
   * @param {string} [options.mediaType] - OM SDK media type: 'video'|'audio'|'display' (default: 'video').
   */
  function installOmidBridge(SHARC, options) {
    // ── Singleton guard ───────────────────────────────────────────────────
    if (installOmidBridge._installed) {
      return;
    }
    installOmidBridge._installed = true;

    options = options || {};

    var partnerName    = options.partnerName    || DEFAULT_PARTNER_NAME;
    var partnerVersion = options.partnerVersion || DEFAULT_PARTNER_VERSION;
    var creativeType   = options.creativeType   || 'video';
    var impressionType = options.impressionType || 'definedByJavaScript';
    var mediaType      = options.mediaType      || 'video';
    var verificationScripts = options.verificationScripts || [];

    // ── Private session state ─────────────────────────────────────────────

    /**
     * Internal state for the OM SDK session.
     * @type {Object}
     */
    var _omid = {
      /**
       * The active OmidSessionClient.AdSession instance.
       * Null before session start and after session finish.
       * @type {Object|null}
       */
      adSession: null,

      /**
       * The OmidSessionClient.AdEvents instance for this session.
       * Only ONE may exist per session — guard via _adEventsCreated.
       * @type {Object|null}
       */
      adEvents: null,

      /**
       * The OmidSessionClient.MediaEvents instance for this session.
       * Only ONE may exist per session — guard via _mediaEventsCreated.
       * @type {Object|null}
       */
      mediaEvents: null,

      /**
       * Whether adSession.start() has been called.
       * @type {boolean}
       */
      sessionStarted: false,

      /**
       * Whether adEvents.loaded() has been called.
       * OM SDK requires loaded() before impressionOccurred().
       * @type {boolean}
       */
      loadedFired: false,

      /**
       * Whether adEvents.impressionOccurred() has been called.
       * Guard against double-firing per OM SDK contract.
       * @type {boolean}
       */
      impressionFired: false,

      /**
       * Whether adSession.finish() has been called or the session has ended.
       * @type {boolean}
       */
      sessionFinished: false,

      /**
       * Whether we are in video media mode (drives mediaEvents vs adEvents for skip).
       * @type {boolean}
       */
      isVideoSession: false,
    };

    // ── Session creation ──────────────────────────────────────────────────

    /**
     * Creates the OM SDK AdSession and registers event observers.
     * Must be called after the OM SDK scripts have been verified as loaded.
     *
     * @param {Object} env - SHARC environment data from Container:init.
     * @private
     */
    function _createOmidSession(env) {
      if (!isOmSdkLoaded()) {
        console.warn('[SHARC OMID Bridge] OM SDK not loaded — cannot create AdSession');
        return;
      }

      var omid = getOmidSessionClient();

      safeCall('createOmidSession', function () {
        // 1. Create Partner
        var partner = new omid.Partner(partnerName, partnerVersion);

        // 2. Build Context with verification scripts
        // VerificationScriptResource objects may be pre-built (passed as options)
        // or empty (no third-party verification).
        var context = new omid.Context(partner, verificationScripts);

        // Set the service script URL if available — required for OMID to route
        // messages from the creative frame to the verification scripts.
        // The container injects omweb-v1.js; its URL should be reflected here.
        // Fall back to empty string (OM SDK handles missing gracefully).
        var serviceScriptUrl = (env && env.omidServiceScriptUrl) || '';
        if (serviceScriptUrl && typeof context.setServiceScriptUrl === 'function') {
          context.setServiceScriptUrl(serviceScriptUrl);
        }

        // Indicate this is a native/web hybrid session if available
        if (typeof context.setContentUrl === 'function') {
          var contentUrl = (env && env.contentUrl) || (
            typeof window !== 'undefined' && window.location && window.location.href
          ) || '';
          if (contentUrl) {
            context.setContentUrl(contentUrl);
          }
        }

        // 3. Create AdSession
        _omid.adSession = new omid.AdSession(context);

        // 4. Set creative and impression types BEFORE starting the session
        //    (required before impressionOccurred() per OM SDK spec)
        if (typeof _omid.adSession.setCreativeType === 'function') {
          _omid.adSession.setCreativeType(creativeType);
        }
        if (typeof _omid.adSession.setImpressionType === 'function') {
          _omid.adSession.setImpressionType(impressionType);
        }

        // 5. Create AdEvents (only ONE per session — guard already applied above)
        _omid.adEvents = new omid.AdEvents(_omid.adSession);

        // 6. Create MediaEvents for video/audio sessions
        _omid.isVideoSession = (mediaType === 'video' || mediaType === 'audio');
        if (_omid.isVideoSession) {
          _omid.mediaEvents = new omid.MediaEvents(_omid.adSession);
        }

        // 7. Register session observers before starting
        _omid.adSession.registerSessionObserver(function (event) {
          _handleSessionEvent(event);
        });

        // 8. Start the session — after this, OM SDK routes messages to verification scripts
        _omid.adSession.start();
        _omid.sessionStarted = true;
      });
    }

    /**
     * Handles OM SDK session lifecycle events from the session observer.
     *
     * @param {Object} event - OM SDK session event with type, data, timestamp fields.
     * @private
     */
    function _handleSessionEvent(event) {
      if (!event) return;
      switch (event.type) {
        case 'sessionStart':
          // Session is fully established — verification scripts have been notified
          console.log('[SHARC OMID Bridge] Session started', event.data);
          break;

        case 'sessionError':
          // Non-fatal error from the session; log but do not abort the ad
          console.warn('[SHARC OMID Bridge] Session error:', event.data);
          break;

        case 'sessionFinish':
          // Session has ended — clean up local references
          console.log('[SHARC OMID Bridge] Session finished');
          _omid.adSession      = null;
          _omid.adEvents       = null;
          _omid.mediaEvents    = null;
          _omid.sessionStarted = false;
          _omid.sessionFinished = true;
          break;

        default:
          break;
      }
    }

    /**
     * Calls adSession.finish() and marks the session as finished.
     * Idempotent — safe to call multiple times.
     * @private
     */
    function _finishSession() {
      if (_omid.sessionFinished || !_omid.adSession) return;
      _omid.sessionFinished = true;
      safeCall('adSession.finish', function () {
        _omid.adSession.finish();
      });
    }

    // ── SHARC event → OM SDK event translation ────────────────────────────

    /**
     * Handles SHARC state changes and maps them to OM SDK events.
     *
     * State mapping:
     *   'ready'   → no-op (container prep phase, session not yet needed)
     *   'active'  → adEvents.loaded(vastProperties) + optionally impressionOccurred()
     *   others    → no direct OM SDK mapping (passive/hidden/frozen are lifecycle)
     *
     * @param {string} state - SHARC container state string.
     * @private
     */
    function _handleStateChange(state) {
      if (!_omid.sessionStarted || !_omid.adEvents) return;

      if (state === 'active') {
        // Fire loaded() with VAST properties if not already done.
        // This maps to the creative becoming active in the container.
        if (!_omid.loadedFired) {
          _omid.loadedFired = true;
          safeCall('adEvents.loaded', function () {
            // Build VastProperties: isSkippable and isAutoPlay are best-effort
            // from env data; default to skippable=false, autoplay=true for video.
            var omid = getOmidSessionClient();
            if (omid && omid.VastProperties) {
              var vastProps = new omid.VastProperties(
                false,    // isSkippable — conservative default
                0,        // skipOffset (seconds)
                true,     // isAutoPlay
                'standalone' // placement: 'standalone'|'accompanying'|'interstitial'
              );
              _omid.adEvents.loaded(vastProps);
            } else {
              // Older SDK versions: loaded() with no args
              _omid.adEvents.loaded();
            }
          });
        }

        // Auto-fire impression when container confirms visibility (active state).
        // Creatives may also explicitly call requestOmid('impression') — the
        // impressionFired guard prevents double-firing.
        if (!_omid.impressionFired) {
          _omid.impressionFired = true;
          safeCall('adEvents.impressionOccurred', function () {
            _omid.adEvents.impressionOccurred();
          });
        }
      }
    }

    /**
     * Handles SHARC `requestOmid` feature invocations from the creative.
     *
     * The creative calls:
     *   SHARC.requestFeature('com.iabtechlab.sharc.omid', { action: 'play', ... })
     *
     * This method receives the parsed args and dispatches to the appropriate
     * OM SDK call.
     *
     * @param {Object} args - Feature request args with `action` and optional payload fields.
     * @private
     */
    function _handleOmidRequest(args) {
      if (!args || !args.action) return;

      var action = args.action;

      // Guard: session must be active for event calls
      if (!_omid.sessionStarted) {
        console.warn('[SHARC OMID Bridge] requestOmid("' + action + '") called before session started — ignoring');
        return;
      }

      switch (action) {

        // ── Ad-level events ─────────────────────────────────────────────

        case 'impression':
          // Creative-initiated impression signal (e.g. custom viewability detection)
          if (!_omid.impressionFired && _omid.adEvents) {
            _omid.impressionFired = true;
            safeCall('adEvents.impressionOccurred', function () {
              _omid.adEvents.impressionOccurred();
            });
          }
          break;

        case 'skip':
          // For video sessions, mediaEvents.skipped() is the correct call.
          // For display/non-video, adEvents.skipped() is used.
          if (_omid.isVideoSession && _omid.mediaEvents) {
            safeCall('mediaEvents.skipped', function () {
              _omid.mediaEvents.skipped();
            });
          } else if (_omid.adEvents) {
            safeCall('adEvents.skipped', function () {
              _omid.adEvents.skipped();
            });
          }
          break;

        // ── Video/media events ──────────────────────────────────────────

        case 'play':
          // mediaEvents.start(duration, volume)
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.start', function () {
              var duration = typeof args.duration === 'number' ? args.duration : 0;
              var volume   = typeof args.volume   === 'number' ? args.volume   : 1;
              _omid.mediaEvents.start(duration, volume);
            });
          }
          break;

        case 'pause':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.pause', function () {
              _omid.mediaEvents.pause();
            });
          }
          break;

        case 'resume':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.resume', function () {
              _omid.mediaEvents.resume();
            });
          }
          break;

        case 'complete':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.complete', function () {
              _omid.mediaEvents.complete();
            });
          }
          break;

        case 'firstQuartile':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.firstQuartile', function () {
              _omid.mediaEvents.firstQuartile();
            });
          }
          break;

        case 'midpoint':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.midpoint', function () {
              _omid.mediaEvents.midpoint();
            });
          }
          break;

        case 'thirdQuartile':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.thirdQuartile', function () {
              _omid.mediaEvents.thirdQuartile();
            });
          }
          break;

        case 'bufferStart':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.bufferStart', function () {
              _omid.mediaEvents.bufferStart();
            });
          }
          break;

        case 'bufferFinish':
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.bufferFinish', function () {
              _omid.mediaEvents.bufferFinish();
            });
          }
          break;

        case 'playerStateChange':
          // args.state: 'normal'|'minimized'|'collapsed'|'expanded'|'fullscreen'
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.playerStateChange', function () {
              var omid = getOmidSessionClient();
              var playerState = args.state;
              // If the SDK has a PlayerState enum, resolve the string to the enum value
              if (omid && omid.PlayerState && omid.PlayerState[playerState]) {
                playerState = omid.PlayerState[playerState];
              }
              _omid.mediaEvents.playerStateChange(playerState);
            });
          }
          break;

        case 'volumeChange':
          // args.volume: 0.0–1.0
          if (_omid.mediaEvents) {
            safeCall('mediaEvents.volumeChange', function () {
              var volume = typeof args.volume === 'number' ? args.volume : 1;
              _omid.mediaEvents.volumeChange(volume);
            });
          }
          break;

        default:
          console.warn('[SHARC OMID Bridge] Unknown requestOmid action:', action);
          break;
      }
    }

    // ── Wire SHARC SDK events ─────────────────────────────────────────────

    /**
     * SHARC.onReady — fires when Container:init is received.
     *
     * Creates the OM SDK AdSession here so that the session is established
     * before the creative starts. The OM SDK service script MUST be loaded
     * before this runs (handled by container injection order).
     */
    SHARC.onReady(function (env) {
      _createOmidSession(env || {});
      // Resolve quickly — SHARC container is waiting on this
    });

    /**
     * SHARC.onStart — fires when Container:startCreative is received.
     * No OM SDK mapping needed; session is already running.
     */
    SHARC.onStart(function () {
      // Nothing required here — OM SDK session was started in onReady
    });

    /**
     * SHARC stateChange — maps to OM SDK ad/impression events.
     *
     * 'active' → adEvents.loaded() + adEvents.impressionOccurred()
     * Other states (passive, hidden, frozen) have no direct OM SDK mapping —
     * they are page lifecycle signals, not measurement events.
     */
    SHARC.on('stateChange', function (state) {
      _handleStateChange(state);
    });

    /**
     * SHARC feature request — handles 'com.iabtechlab.sharc.omid' feature calls.
     *
     * The creative invokes:
     *   SHARC.requestFeature('com.iabtechlab.sharc.omid', { action: 'play', duration: 30, volume: 0.8 })
     *
     * The SHARC protocol routes Creative:requestOmid to the container, which
     * calls back through the registered feature handler. However, since the
     * bridge runs inside the creative frame, we intercept by listening to a
     * custom 'omidRequest' event emitted by the container after it receives the
     * Creative:requestOmid message — or, in the simpler direct-call integration,
     * the creative calls window.SHARC.OmidBridge.request(action, args) directly.
     *
     * To support both patterns, we expose a direct call surface on window.SHARC:
     */
    if (typeof window !== 'undefined') {
      window.SHARC = window.SHARC || {};

      /**
       * Direct OMID bridge request API.
       * Creatives that know they are in an OMID-capable container can call:
       *   window.SHARC.omid.request('play', { duration: 30, volume: 1 });
       *
       * @namespace window.SHARC.omid
       */
      window.SHARC.omid = {
        /**
         * Dispatches an OMID measurement event.
         *
         * @param {string} action - Event name (play, pause, resume, complete, etc.)
         * @param {Object} [args]  - Event-specific arguments.
         */
        request: function (action, args) {
          _handleOmidRequest(Object.assign({ action: action }, args || {}));
        },

        /**
         * Returns whether the OMID session is currently active.
         * @returns {boolean}
         */
        isSessionActive: function () {
          return _omid.sessionStarted && !_omid.sessionFinished;
        },

        /**
         * Returns the active AdSession object (for advanced integrations).
         * Returns null if no session is active.
         * @returns {Object|null}
         */
        getAdSession: function () {
          return _omid.adSession;
        },
      };
    }

    /**
     * Listen for 'omidRequest' custom events posted by the container into the
     * creative frame after processing Creative:requestOmid messages.
     * This enables the full SHARC message-passing path from the creative SDK.
     *
     * Message shape: { type: 'SHARC:Omid:request', action: string, ...rest }
     */
    if (typeof window !== 'undefined') {
      window.addEventListener('message', function (event) {
        if (!event.data || typeof event.data !== 'object') return;
        if (event.data.type !== 'SHARC:Omid:request') return;
        _handleOmidRequest(event.data);
      }, false);
    }

    /**
     * SHARC close — session must be finished when the container closes.
     * The 'close' event fires when Container:close is received.
     */
    SHARC.on('close', function () {
      _finishSession();
    });

    /**
     * SHARC containerError — also finish the session on fatal container errors.
     */
    SHARC.on('containerError', function () {
      _finishSession();
    });

  } // end installOmidBridge

  // -------------------------------------------------------------------------
  // OmidCompatBridge — container-side extension plugin
  // -------------------------------------------------------------------------

  /**
   * Container-side extension plugin for the OMID bridge.
   *
   * Registers the OMID feature name in Container:init, and provides helpers
   * to inject the OM SDK service and session client scripts into the creative's
   * HTML before it is loaded into the SHARC iframe.
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
   *   creativeUrl: bridge.injectScripts(creativeHtml),  // or use wrapperUrl
   *   supportedFeatures: [bridge.getFeatureDescriptor()],
   *   environmentData: bridge.augmentEnvironmentData({ ... }),
   * });
   * ```
   *
   * @param {Object} [options]
   * @param {string} [options.omSdkServiceScriptUrl]  - URL of the OM SDK service script (omweb-v1.js).
   * @param {string} [options.omSdkSessionClientUrl]  - URL of the OM SDK session client script.
   * @param {string} [options.baseUrl='/sharc']       - Base URL for SHARC SDK scripts.
   * @param {string} [options.partnerName]            - OM SDK partner name.
   * @param {string} [options.partnerVersion]         - OM SDK partner version.
   * @param {Array}  [options.verificationScripts]    - OM SDK VerificationScriptResource objects.
   * @param {string} [options.creativeType]           - OM SDK creative type (default: 'video').
   * @param {string} [options.impressionType]         - OM SDK impression type.
   * @param {string} [options.mediaType]              - OM SDK media type (default: 'video').
   */
  function OmidCompatBridge(options) {
    this.name    = FEATURE_NAME;
    this.options = options || {};
  }

  OmidCompatBridge.prototype = {

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
          // Indicates the OM SDK service and session client are injected
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

    // ── Script injection ─────────────────────────────────────────────────

    /**
     * Returns the ordered list of script URLs to inject into the creative page.
     *
     * The container should prepend <script> tags for each URL into the creative's
     * HTML wrapper before loading it in the iframe. Order is critical:
     *   1. OM SDK Service Script (omweb-v1.js) — MUST be first
     *   2. OM SDK Session Client (omid-session-client-v1.js)
     *   3. SHARC Protocol
     *   4. SHARC Creative SDK
     *   5. SHARC OMID Bridge (this file)
     *
     * @returns {string[]} Ordered array of script URLs.
     */
    getScriptUrls: function () {
      var base        = this.options.baseUrl               || '/sharc';
      var serviceUrl  = this.options.omSdkServiceScriptUrl || '/vendor/omweb-v1.js';
      var clientUrl   = this.options.omSdkSessionClientUrl || '/vendor/omid-session-client-v1.js';

      // CRITICAL: OM SDK service script must come before session client,
      // and both must come before the SHARC SDK and this bridge.
      return [
        serviceUrl,                                 // 1. OM SDK Service (omweb-v1.js)
        clientUrl,                                  // 2. OM SDK Session Client
        base + '/sharc-protocol.js',                // 3. SHARC Protocol constants
        base + '/sharc-creative.js',                // 4. SHARC Creative SDK
        base + '/sharc-omid-bridge.js',             // 5. This bridge
      ];
    },

    /**
     * Injects the required OM SDK and SHARC scripts into a raw HTML string.
     *
     * Inserts <script> tags immediately after the opening <head> tag (or at the
     * very beginning of the document if no <head> tag is present). This mirrors
     * the approach used by native SDK integrations: scripts are string-injected
     * into the HTML before it is loaded.
     *
     * The OM SDK service script MUST be present in the creative's document
     * before AdSession is constructed; this method guarantees that ordering.
     *
     * @param {string} html    - The original creative HTML markup.
     * @returns {string}       The HTML with OM SDK and SHARC scripts prepended.
     */
    injectScripts: function (html) {
      var urls   = this.getScriptUrls();
      var tags   = urls.map(function (url) {
        return '<script src="' + url + '"><\/script>';
      }).join('\n');

      // Prefer injection right after <head> so scripts are in <head> scope
      if (/<head[^>]*>/i.test(html)) {
        return html.replace(/(<head[^>]*>)/i, '$1\n' + tags + '\n');
      }
      // Fall back: prepend before any content
      return tags + '\n' + html;
    },

    /**
     * Injects OM SDK and SHARC scripts into a raw HTML string.
     *
     * This is the method called by `SHARCContainer._fetchAndInjectCreative()`
     * when an extension is detected as an injector. It is an alias for
     * `injectScripts()` that follows the standard container extension interface:
     *
     *   container calls: `extension.injectIntoMarkup(html)` → string
     *
     * The container fetches the creative HTML, calls this method, and loads
     * the result via `iframe.srcdoc` instead of `iframe.src`. This guarantees
     * the OM SDK service script is present in the document before any creative
     * JavaScript executes.
     *
     * @param {string} html - The raw creative HTML markup.
     * @returns {string} The HTML with OM SDK and SHARC script tags prepended.
     */
    injectIntoMarkup: function (html) {
      return this.injectScripts(html);
    },

    /**
     * Returns the wrapper URL for a given creative URL.
     *
     * The container should load this URL in the ad iframe instead of the
     * creative directly. The wrapper page handles script injection and
     * embeds the original creative inside it.
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

  }; // end OmidCompatBridge.prototype

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  return {
    /**
     * Container-side extension plugin.
     * Use to configure and inject OMID support into a SHARC container.
     */
    OmidCompatBridge:    OmidCompatBridge,

    /**
     * Creative-frame bridge installer.
     * Called automatically in browser mode; can be called manually in
     * test environments or when deferring installation.
     */
    installOmidBridge:   installOmidBridge,

    /** Bridge feature name constant. */
    FEATURE_NAME:        FEATURE_NAME,

    /** Bridge version string. */
    BRIDGE_VERSION:      BRIDGE_VERSION,
  };

})); // end UMD factory