/**
 * @fileoverview SHARC Creative SDK
 *
 * Production-ready creative-side implementation for the SHARC protocol.
 *
 * Design goals:
 *   - Negligible footprint (< 5KB minified, zero dependencies)
 *   - Clean Promise-based API — creative developers don't need to know about
 *     sessionId, messageId, or the wire protocol
 *   - Automatic handling of the SHARC handshake (createSession, port receipt)
 *   - Watchdog timers to prevent creative from blocking close sequence
 *
 * Dependencies:
 *   - sharc-protocol.js (must be loaded first, or required via CommonJS)
 *
 * Usage:
 * ```html
 * <!-- In the creative HTML: -->
 * <script src="sharc-protocol.js"></script>
 * <script src="sharc-creative.js"></script>
 * <script>
 *   SHARC.onReady(async (env, features) => {
 *     // Configure creative based on env (muted, volume, placement, etc.)
 *     // SHARC.hasFeature('com.iabtechlab.sharc.audio') → boolean
 *   });
 *
 *   SHARC.onStart(async () => {
 *     // Show the creative, begin the experience
 *   });
 *
 *   SHARC.on('close', () => {
 *     // Optional: brief close animation (SDK watchdog enforces 1.8s max)
 *   });
 * </script>
 * ```
 *
 * @version 0.1.0
 */

'use strict';

// ---------------------------------------------------------------------------
// Import protocol constants
// ---------------------------------------------------------------------------

let _protocol;
if (typeof module !== 'undefined' && module.exports) {
  _protocol = require('./sharc-protocol');
} else {
  _protocol = (typeof window !== 'undefined' && window.SHARC && window.SHARC.Protocol) || {};
}

const {
  SHARCCreativeProtocol,
  ContainerMessages,
  CreativeMessages,
  ContainerStates,
  ErrorCodes,
} = _protocol;

// ---------------------------------------------------------------------------
// Close watchdog duration
// ---------------------------------------------------------------------------

/** Maximum time (ms) the creative's close handler may run before the SDK force-resolves. */
const CLOSE_WATCHDOG_MS = 1800;

// ---------------------------------------------------------------------------
// SHARCCreativeSDK
// ---------------------------------------------------------------------------

/**
 * Creative-side SHARC SDK.
 *
 * Exposed as the `window.SHARC` global (augmented, not replaced).
 * The SDK instance is created automatically when this script loads.
 *
 * Creative developers use only the public API methods below.
 * The wire protocol (createSession, resolve/reject, etc.) is handled internally.
 */
class SHARCCreativeSDK {
  constructor() {
    /** @type {SHARCCreativeProtocol} */
    this._proto = new SHARCCreativeProtocol();

    /** Cached environment data from Container:init. @type {Object|null} */
    this._env = null;

    /** Cached features from Container:init. @type {Array} */
    this._features = [];

    /** Feature set for O(1) hasFeature lookup. @type {Set<string>} */
    this._featureSet = new Set();

    /** The onReady callback registered by the creative. @type {Function|null} */
    this._onReadyCallback = null;

    /** The onStart callback registered by the creative. @type {Function|null} */
    this._onStartCallback = null;

    /**
     * User-registered event listeners (including 'close' handlers).
     * ALL close handlers participate in the watchdog (see _handleClose).
     * @type {Object.<string, Function[]>}
     */
    // Note: _closeHandler field removed. 'close' listeners live in _eventListeners['close']
    // so all registered handlers (not just the last) receive the watchdog guarantee.

    /** User-registered event listeners. @type {Object.<string, Function[]>} */
    this._eventListeners = {};

    /** Whether the SDK has been initialized. @type {boolean} */
    this._initialized = false;

    /** Whether we're in a dead state (fatalError called or SDK terminated). @type {boolean} */
    this._dead = false;
  }

  // -------------------------------------------------------------------------
  // Initialization — called automatically on script load
  // -------------------------------------------------------------------------

  /**
   * Bootstraps the SDK. Called automatically when the script loads.
   * Starts the MessagePort bootstrap listener and registers protocol handlers.
   * @private
   */
  _boot() {
    if (this._initialized) return;
    this._initialized = true;

    // Initialize the underlying protocol (starts listening for port bootstrap)
    this._proto.init();

    // Register handlers for container-initiated messages
    this._registerContainerListeners();

    // Start createSession as soon as DOM is ready
    const startSession = () => this._startSession();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startSession, { once: true });
    } else {
      // DOM already ready — start on next tick to give creative code time to
      // register onReady/onStart callbacks
      setTimeout(startSession, 0);
    }
  }

  /**
   * Sends createSession to establish the SHARC session.
   * @private
   */
  _startSession() {
    if (this._dead) return;
    this._proto.createSession()
      .then(() => {
        // Session established — wait for Container:init (handled in listener)
      })
      .catch((err) => {
        console.error('[SHARC Creative] createSession failed:', err);
        this._dead = true;
      });
  }

  /**
   * Registers listeners for all container-to-creative messages.
   * @private
   */
  _registerContainerListeners() {
    const proto = this._proto;

    // Container:init — the main initialization message
    proto.addListener(ContainerMessages.INIT, (msg) => {
      this._handleInit(msg);
    });

    // Container:startCreative — begin the ad experience
    proto.addListener(ContainerMessages.START_CREATIVE, (msg) => {
      this._handleStartCreative(msg);
    });

    // Container:stateChange — container visibility/focus changed
    proto.addListener(ContainerMessages.STATE_CHANGE, (msg) => {
      const state = msg.args && msg.args.containerState;
      this._emit('stateChange', state);
    });

    // Container:placementChange — container dimensions changed
    proto.addListener(ContainerMessages.PLACEMENT_CHANGE, (msg) => {
      const placement = msg.args && msg.args.placementUpdate;
      this._emit('placementChange', placement);
    });

    // Container:log — container sending a log message to creative
    proto.addListener(ContainerMessages.LOG, (msg) => {
      const message = msg.args && msg.args.message;
      console.log('[SHARC Container Log]', message);
      this._emit('log', message);
    });

    // Container:fatalError — container is dying
    proto.addListener(ContainerMessages.FATAL_ERROR, (msg) => {
      console.error('[SHARC Creative] Container fatal error:', msg.args);
      // Must resolve to acknowledge
      proto.resolve(msg, {});
      this._dead = true;
      this._emit('containerError', msg.args);
    });

    // Container:close — container is closing
    proto.addListener(ContainerMessages.CLOSE, (msg) => {
      this._handleClose(msg);
    });
  }

  // -------------------------------------------------------------------------
  // Container message handlers
  // -------------------------------------------------------------------------

  /**
   * Handles Container:init.
   * Calls the creative's onReady callback and resolves/rejects based on result.
   * @param {Object} msg
   * @private
   */
  _handleInit(msg) {
    const { environmentData, supportedFeatures = [] } = (msg.args || {});

    this._env = environmentData || {};
    this._features = supportedFeatures;
    this._featureSet = new Set(supportedFeatures.map((f) => f.name || f));

    if (!this._onReadyCallback) {
      // No onReady registered — resolve anyway to keep the lifecycle moving
      this._proto.resolve(msg, {});
      return;
    }

    let callbackResult;
    try {
      callbackResult = this._onReadyCallback(this._env, this._features);
    } catch (err) {
      console.error('[SHARC Creative] onReady callback threw:', err);
      this._proto.reject(msg, ErrorCodes.AD_INTERNAL_ERROR, err.message || 'onReady threw');
      return;
    }

    // If the callback returns a Promise, wait for it
    const promise = callbackResult && typeof callbackResult.then === 'function'
      ? callbackResult
      : Promise.resolve(callbackResult);

    promise
      .then(() => {
        this._proto.resolve(msg, {});
      })
      .catch((err) => {
        console.error('[SHARC Creative] onReady promise rejected:', err);
        this._proto.reject(
          msg,
          (err && err.errorCode) || ErrorCodes.AD_INTERNAL_ERROR,
          (err && err.message) || String(err)
        );
      });
  }

  /**
   * Handles Container:startCreative.
   * Calls the creative's onStart callback and resolves/rejects.
   * @param {Object} msg
   * @private
   */
  _handleStartCreative(msg) {
    if (!this._onStartCallback) {
      this._proto.resolve(msg, {});
      return;
    }

    let callbackResult;
    try {
      callbackResult = this._onStartCallback();
    } catch (err) {
      console.error('[SHARC Creative] onStart callback threw:', err);
      this._proto.reject(msg, ErrorCodes.AD_INTERNAL_ERROR, err.message || 'onStart threw');
      return;
    }

    const promise = callbackResult && typeof callbackResult.then === 'function'
      ? callbackResult
      : Promise.resolve(callbackResult);

    promise
      .then(() => {
        this._proto.resolve(msg, {});
      })
      .catch((err) => {
        console.error('[SHARC Creative] onStart promise rejected:', err);
        this._proto.reject(
          msg,
          (err && err.errorCode) || ErrorCodes.AD_INTERNAL_ERROR,
          (err && err.message) || String(err)
        );
      });
  }

  /**
   * Handles Container:close.
   * Runs the close handler (if any) with a watchdog, then resolves.
   * @param {Object} msg
   * @private
   */
  _handleClose(msg) {
    const closeListeners = this._eventListeners['close'] || [];

    if (closeListeners.length === 0) {
      // No close handlers registered — resolve immediately
      this._proto.resolve(msg, {});
      return;
    }

    let closeHandlerDone = false;
    const resolveClose = () => {
      if (!closeHandlerDone) {
        closeHandlerDone = true;
        this._proto.resolve(msg, {});
      }
    };

    // Watchdog: force-resolve if creative close handlers take too long
    const watchdog = setTimeout(resolveClose, CLOSE_WATCHDOG_MS);

    // Run ALL registered close listeners, collect their return values.
    // Each listener participates in the watchdog (previously only the last-registered
    // listener was tracked, and _emit('close') caused the first call to duplicate).
    const results = closeListeners.map((fn) => {
      try { return fn(); } catch (e) { return undefined; }
    });

    // Also emit to non-watchdog listeners (stateChange, etc.) — but 'close' is
    // handled above, so emit is not needed for 'close' specifically.
    // Emit is still useful if the creative used _emit directly for other consumers.

    // Await all Promises returned by handlers
    const promises = results.map((r) =>
      (r && typeof r.then === 'function') ? r : Promise.resolve(r)
    );

    Promise.all(promises)
      .then(() => { clearTimeout(watchdog); resolveClose(); })
      .catch(() => { clearTimeout(watchdog); resolveClose(); });
  }

  // -------------------------------------------------------------------------
  // Public API — creative developers use these
  // -------------------------------------------------------------------------

  /**
   * Registers the "ready" callback, called when Container:init is received.
   *
   * The callback receives (environmentData, features) and should return a
   * Promise that resolves when the creative is ready to be displayed.
   * Resolve the Promise quickly — the container may time out after 2 seconds.
   *
   * @param {Function} callback - (env: Object, features: Array) => Promise<void> | void
   * @returns {SHARCCreativeSDK} this (for chaining)
   *
   * @example
   * SHARC.onReady(async (env, features) => {
   *   myAd.setMuted(env.isMuted);
   *   await myAd.loadAssets();
   * });
   */
  onReady(callback) {
    this._onReadyCallback = callback;
    return this;
  }

  /**
   * Registers the "start" callback, called when Container:startCreative is received.
   *
   * The callback should make the creative visible and begin the ad experience.
   * Return a Promise that resolves when the creative is visible and running.
   *
   * @param {Function} callback - () => Promise<void> | void
   * @returns {SHARCCreativeSDK} this (for chaining)
   *
   * @example
   * SHARC.onStart(async () => {
   *   myAd.show();
   *   myAd.play();
   * });
   */
  onStart(callback) {
    this._onStartCallback = callback;
    return this;
  }

  /**
   * Registers a listener for a named event.
   *
   * Supported events:
   *   - 'stateChange'     — container state changed; callback receives (state: string)
   *   - 'placementChange' — container placement changed; callback receives (placement: Object)
   *   - 'close'           — container is closing; callback receives no args
   *   - 'log'             — container sent a log message; callback receives (message: string)
   *   - 'containerError'  — container sent a fatal error; callback receives (args: Object)
   *
   * @param {string} event - Event name.
   * @param {Function} callback - Event handler.
   * @returns {SHARCCreativeSDK} this (for chaining)
   *
   * @example
   * SHARC.on('stateChange', (state) => {
   *   if (state === 'hidden') myAd.pauseAnimations();
   *   if (state === 'active') myAd.resumeAnimations();
   * });
   */
  on(event, callback) {
    if (!this._eventListeners[event]) {
      this._eventListeners[event] = [];
    }
    this._eventListeners[event].push(callback);

    // Note: 'close' listeners are NOT stored in _closeHandler separately.
    // The _handleClose() method uses _eventListeners['close'] directly so that
    // ALL registered close handlers participate in the watchdog mechanism.
    // (Fixes duplicate-invocation bug: previously _emit('close') + _closeHandler()
    // would call a single listener twice.)

    return this;
  }

  /**
   * Removes a listener for a named event.
   * @param {string} event
   * @param {Function} callback
   * @returns {SHARCCreativeSDK} this
   */
  off(event, callback) {
    const listeners = this._eventListeners[event];
    if (!listeners) return this;
    const idx = listeners.indexOf(callback);
    if (idx !== -1) {
      listeners.splice(idx, 1);
    }
    return this;
  }

  /**
   * Returns the current container state.
   * @returns {Promise<string>} Resolves with the state string.
   *
   * @example
   * const state = await SHARC.getContainerState();
   * // 'active' | 'passive' | 'hidden' | 'frozen' | 'ready'
   */
  getContainerState() {
    if (this._dead) return Promise.reject(new Error('SDK is dead'));
    return this._proto.getContainerState().then((value) => value && value.currentState);
  }

  /**
   * Returns the current placement options.
   * @returns {Promise<Object>} Resolves with placement information.
   */
  getPlacementOptions() {
    if (this._dead) return Promise.reject(new Error('SDK is dead'));
    return this._proto.getPlacementOptions().then((value) => value && value.currentPlacementOptions);
  }

  /**
   * Requests a placement change.
   *
   * @param {Object} args
   * @param {string} args.intent - 'resize' | 'maximize' | 'minimize' | 'restore' | 'fullscreen'
   * @param {Object} [args.targetDimensions] - {width, height} — required when intent === 'resize'
   * @param {string} [args.anchorPoint] - 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
   * @returns {Promise<Object>} Resolves with updated placement.
   *
   * @example
   * await SHARC.requestPlacementChange({ intent: 'maximize' });
   * await SHARC.requestPlacementChange({ intent: 'resize', targetDimensions: { width: 320, height: 480 } });
   */
  requestPlacementChange(args) {
    if (this._dead) return Promise.reject(new Error('SDK is dead'));
    return this._proto.requestPlacementChange(args);
  }

  /**
   * Requests navigation to a URL.
   * Must always be called for clickthroughs, even if the container cannot
   * handle navigation, so the container can log the event.
   *
   * @param {Object} args
   * @param {string} args.url - The URL to navigate to.
   * @param {string} [args.target='clickthrough'] - 'clickthrough' | 'deeplink' | 'store' | 'custom'
   * @param {string} [args.customScheme] - Required when target === 'custom'
   *
   * @example
   * SHARC.requestNavigation({ url: 'https://example.com', target: 'clickthrough' });
   */
  requestNavigation(args) {
    if (this._dead) return Promise.resolve(); // Dead state: return resolved promise for consistency
    // Return the promise so callers can await the container's resolve/reject.
    // Reject with code 2105 (UNSPECIFIED_CONTAINER) means creative should handle navigation itself.
    return this._proto.requestNavigation({ target: 'clickthrough', ...args });
  }

  /**
   * Requests the container to close.
   * The container may refuse (reject) if closing is not allowed at this time.
   *
   * @returns {Promise<void>} Resolves if container accepts; rejects if refused.
   *
   * @example
   * document.getElementById('close-btn').addEventListener('click', () => {
   *   SHARC.requestClose();
   * });
   */
  requestClose() {
    if (this._dead) return Promise.resolve();
    return this._proto.requestClose();
  }

  /**
   * Reports interaction tracking URIs to the container.
   * The container fires these as HTTP GET requests.
   *
   * @param {string[]} trackingUris - Array of tracker URLs.
   * @returns {Promise<Array>} Resolves with per-tracker results.
   *
   * @example
   * SHARC.reportInteraction([
   *   'https://tracker.example.com/click?sid=%%SHARC_SESSION_ID%%',
   * ]);
   */
  reportInteraction(trackingUris) {
    if (this._dead) return Promise.reject(new Error('SDK is dead'));
    return this._proto.reportInteraction(trackingUris);
  }

  /**
   * Returns the list of supported features/extensions.
   * Prefer `hasFeature()` for synchronous feature checks using cached init data.
   *
   * @returns {Promise<Array>}
   */
  getFeatures() {
    if (this._dead) return Promise.reject(new Error('SDK is dead'));
    return this._proto.getFeatures().then((value) => value && value.features || []);
  }

  /**
   * Synchronously checks if a named feature is supported.
   * Uses the feature list received during Container:init (no network round-trip).
   *
   * @param {string} name - Feature name, e.g. 'com.iabtechlab.sharc.audio'
   * @returns {boolean}
   *
   * @example
   * if (SHARC.hasFeature('com.iabtechlab.sharc.audio')) {
   *   showAudioControls();
   * }
   */
  hasFeature(name) {
    return this._featureSet.has(name);
  }

  /**
   * Invokes a named extension feature.
   *
   * @param {string} featureName - e.g. 'com.iabtechlab.sharc.location'
   * @param {Object} [args={}] - Feature-specific arguments.
   * @returns {Promise<Object>} Resolves with feature-specific result; rejects if unsupported.
   *
   * @example
   * const loc = await SHARC.requestFeature('com.iabtechlab.sharc.location', {});
   */
  requestFeature(featureName, args = {}) {
    if (this._dead) return Promise.reject(new Error('SDK is dead'));
    // SEC-005: Validate feature name against the required namespace format.
    // Feature names must follow the pattern: com.[domain].[...].sharc.[name]
    // where the terminal segment is a simple identifier.
    // This prevents creatives from constructing arbitrary message types that
    // could collide with built-in protocol message types (e.g. 'Close', 'FatalError').
    const FEATURE_NAME_RE = /^com\.[a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9]*$/i;
    if (!FEATURE_NAME_RE.test(featureName)) {
      return Promise.reject(new Error(
        `Invalid feature name: '${featureName}'. ` +
        'Feature names must follow the format: com.[domain].[name] with alphanumeric segments.'
      ));
    }
    // Extension requests use the Creative:request[FeatureName] pattern.
    // Take the last dot-separated segment and capitalize it for the message type.
    const lastSegment = featureName.split('.').pop() || featureName;
    const messageType = `SHARC:Creative:request${this._capitalize(lastSegment)}`;
    return this._proto._sendMessage(messageType, { featureName, args });
  }

  /**
   * Reports a fatal error to the container.
   * After calling this, the SDK enters a dead state and no further messages
   * are sent or received.
   *
   * @param {number} code - Error code from ErrorCodes enum.
   * @param {string} [message] - Additional error details.
   *
   * @example
   * SHARC.fatalError(SHARC.ErrorCodes.CANNOT_LOAD_RESOURCES, 'Failed to load video asset');
   */
  fatalError(code, message = '') {
    if (this._dead) return;
    this._dead = true;
    this._proto.sendFatalError(code, message);
  }

  /**
   * Sends a log message to the container.
   * Prefix with "WARNING:" to signal spec compliance issues.
   *
   * @param {string} message
   *
   * @example
   * SHARC.log('WARNING: requestPlacementChange called before onReady resolved');
   */
  log(message) {
    if (this._dead) return;
    this._proto.log(message);
  }

  /**
   * Returns the environment data received during init.
   * Only available after onReady has been called.
   *
   * @returns {Object|null}
   */
  getEnv() {
    return this._env;
  }

  /**
   * Returns the list of supported features.
   * Only available after onReady has been called.
   *
   * @returns {Array}
   */
  getSupportedFeatures() {
    return this._features;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Emits an event to all registered listeners.
   * @param {string} event
   * @param {*} [data]
   * @private
   */
  _emit(event, data) {
    const listeners = this._eventListeners[event];
    if (!listeners) return;
    listeners.forEach((fn) => {
      try { fn(data); } catch (e) { /* swallow to not break protocol */ }
    });
  }

  /**
   * Capitalizes the first character of a string.
   * @param {string} str
   * @returns {string}
   * @private
   */
  _capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// ---------------------------------------------------------------------------
// Auto-instantiation and global exposure
// ---------------------------------------------------------------------------

/**
 * The singleton SHARC Creative SDK instance.
 * Exposed as window.SHARC in browser environments.
 *
 * In the browser, this global is populated by both sharc-protocol.js
 * (which sets window.SHARC.Protocol) and sharc-creative.js (which adds
 * the SDK methods directly to window.SHARC).
 *
 * @type {SHARCCreativeSDK}
 */
let _sdkInstance;

if (typeof module !== 'undefined' && module.exports) {
  // CommonJS — export the class; caller creates the instance
  _sdkInstance = new SHARCCreativeSDK();
  module.exports = { SHARCCreativeSDK, sdk: _sdkInstance };
} else if (typeof window !== 'undefined') {
  // Browser — create singleton and augment window.SHARC
  _sdkInstance = new SHARCCreativeSDK();

  // Preserve window.SHARC.Protocol if sharc-protocol.js was loaded first
  const existingProtocol = (window.SHARC && window.SHARC.Protocol) || null;

  // Expose SDK methods directly on window.SHARC for ergonomic creative code
  window.SHARC = {
    // Protocol constants (for advanced creative use)
    Protocol: existingProtocol,
    ErrorCodes: (existingProtocol && existingProtocol.ErrorCodes) || ErrorCodes,

    // SDK public API (delegates to _sdkInstance)
    onReady: (cb) => _sdkInstance.onReady(cb),
    onStart: (cb) => _sdkInstance.onStart(cb),
    on: (event, cb) => _sdkInstance.on(event, cb),
    off: (event, cb) => _sdkInstance.off(event, cb),
    getContainerState: () => _sdkInstance.getContainerState(),
    getPlacementOptions: () => _sdkInstance.getPlacementOptions(),
    requestPlacementChange: (args) => _sdkInstance.requestPlacementChange(args),
    requestNavigation: (args) => _sdkInstance.requestNavigation(args),
    requestClose: () => _sdkInstance.requestClose(),
    reportInteraction: (uris) => _sdkInstance.reportInteraction(uris),
    getFeatures: () => _sdkInstance.getFeatures(),
    hasFeature: (name) => _sdkInstance.hasFeature(name),
    requestFeature: (name, args) => _sdkInstance.requestFeature(name, args),
    fatalError: (code, msg) => _sdkInstance.fatalError(code, msg),
    log: (msg) => _sdkInstance.log(msg),
    getEnv: () => _sdkInstance.getEnv(),

    // Internal instance (for testing/debugging)
    _sdk: _sdkInstance,
  };

  // Auto-boot the SDK
  _sdkInstance._boot();
}
