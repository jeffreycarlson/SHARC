/**
 * @fileoverview SHARC Creative API
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
 *     // Optional: brief close animation (SHARC API watchdog enforces 1.8s max)
 *   });
 * </script>
 * ```
 *
 * @version 0.7.11
 */

'use strict';

// ---------------------------------------------------------------------------
// Import protocol constants
// ---------------------------------------------------------------------------

import {
  SHARCCreativeProtocol,
  ContainerMessages,
  ErrorCodes,
  CREATIVE_QUERYABLE_STATES,
} from './sharc-protocol.js';

// Phase E deliverable 2: bundle the navigation bridge into the SDK so the
// Creative URL flow auto-installs it at SDK init. Markup variant continues
// to install the bridge from the renderer page (operators forking
// `examples/renderer/index.html` get it wired in there); the SDK's auto-
// install is gated on `window.__sharcRenderer` presence so it's a no-op
// when the renderer already installed (idempotent at the bridge level too,
// but the gate avoids a redundant call). +1.1 kB is acceptable for a non-
// optional dependency in the URL flow. Synchronous install at module
// evaluation avoids the first-click race that a dynamic import would
// introduce. Both `installNavigationBridge` and `SHARCNavigationError` are
// re-exported from this module (#370) so ESM consumers that load only
// `sharc-creative` get the install function and the error class for
// `instanceof` parity without a second import — see the export-trailer note
// near the bottom of this file. The IIFE epilogue clobber that originally
// forced `installNavigationBridge` to be dropped (#367) is now neutralized by
// #369's build-layer first-assignment-wins guard. Verified by
// `npm run test:smoke`.
import { installNavigationBridge, SHARCNavigationError } from './sharc-navigation-bridge.js';

// ---------------------------------------------------------------------------
// Close watchdog duration
// ---------------------------------------------------------------------------

/** Maximum time (ms) the creative's close handler may run before the SHARC API force-resolves. */
const CLOSE_WATCHDOG_MS = 1800;

// ---------------------------------------------------------------------------
// SHARCCreative
// ---------------------------------------------------------------------------

/**
 * Creative-side SHARC API.
 *
 * Exposed as the `window.SHARC` global (augmented, not replaced).
 * The instance is created automatically when this script loads.
 *
 * Creative developers use only the public API methods below.
 * The wire protocol (createSession, resolve/reject, etc.) is handled internally.
 */
class SHARCCreative {
  constructor() {
    // SEC-003: If the embedder pre-declares `window.SHARC_CONFIG.trustedOrigin`
    // (before this module loads), the bootstrap handshake will reject any
    // postMessage whose `event.origin` doesn't match. The unconditional
    // `event.source === window.parent` check applies either way.
    //
    // Ordering for ESM/module consumers: `window.SHARC_CONFIG` must be set
    // BEFORE `sharc-creative.js` is evaluated, because this constructor runs
    // at module-evaluation time. Since `import` statements hoist to the top
    // of their containing module, you cannot set SHARC_CONFIG inline in the
    // same ESM file that imports the creative library — use a prior classic
    // <script> tag (or a separate module that runs first) to set it:
    //
    //   <script>window.SHARC_CONFIG = { trustedOrigin: 'https://pub.example' };</script>
    //   <script type="module" src="./sharc-creative.js"></script>
    //
    // Format for `trustedOrigin`: exact string match against `event.origin`
    // (scheme + host + optional port, no path, no trailing slash). Example:
    // `"https://pub.example"` or `"http://localhost:3000"`. A scheme mismatch
    // (e.g. `"pub.example"` or `"https://pub.example/"`) will fail every check.
    const cfg = (typeof window !== 'undefined' && window.SHARC_CONFIG) || null;
    const protocolOptions = cfg && typeof cfg.trustedOrigin === 'string'
      ? { trustedOrigin: cfg.trustedOrigin }
      : undefined;

    /** @type {SHARCCreativeProtocol} @private */
    this._proto = new SHARCCreativeProtocol(protocolOptions);

    // OR-3 — the onReady fired-flag + cache are per-session. Clear them on the
    // same teardown seam the protocol uses (reset()), so a re-established
    // session re-fires onReady and a between-sessions listener never replays the
    // torn-down session's env.
    this._proto._onResetHook = () => {
      this._onReadyFired = false;
      this._onReadyCache = null;
    };

    /** Cached environment data from Container:init. @type {Object|null} @private */
    this._env = null;

    /** Cached features from Container:init. @type {Array<string | {name: string, version?: string}>} @private */
    this._features = [];

    /** Feature set for O(1) hasFeature lookup. @type {Set<string>} @private */
    this._featureSet = new Set();

    /** Cached placement constraints from last query or constraintsChange event. @type {Object|null} @private */
    this._cachedConstraints = null;

    /**
     * onReady listeners (OR-1). Registration appends, never overwrites — closes
     * the wrapper-clobber footgun where a creative's onReady silently replaced
     * the bridge's handshake burst. Modeled on the stateChange event bus.
     * @type {Function[]} @private
     */
    this._readyListeners = [];

    /**
     * Whether onReady has fired on the CURRENT session (OR-2/OR-3). Reset on
     * session teardown via the protocol reset hook (INV-21 analogue).
     * @type {boolean} @private
     */
    this._onReadyFired = false;

    /**
     * Cached (env, features) from the init that fired onReady, replayed once to
     * a late listener (OR-2). Carries the honest currentState (OR-5). Per-session
     * — cleared on teardown. @type {{env: Object, features: Array}|null} @private
     */
    this._onReadyCache = null;

    /** The onStart callback registered by the creative. @type {Function|null} @private */
    this._onStartCallback = null;

    /**
     * User-registered event listeners (including 'close' handlers).
     * ALL close handlers participate in the watchdog (see _handleClose).
     * @type {Object.<string, Function[]>}
     * @private
     */
    // Note: _closeHandler field removed. 'close' listeners live in _eventListeners['close']
    // so all registered handlers (not just the last) receive the watchdog guarantee.

    /** User-registered event listeners. @type {Object.<string, Function[]>} @private */
    this._eventListeners = {};

    /**
     * R1 D3 — last container lifecycle state seen on this session, cached so a
     * 'stateChange' listener registered AFTER the value arrived can be replayed
     * the current value once on registration. Seeded from env.currentState in
     * _handleInit and updated on every inbound Container:stateChange. Scope is
     * strictly the latching lifecycle 'stateChange' event; one-shot events
     * (containerError / log / close) are never cached or replayed.
     * @type {string|undefined}
     * @private
     */
    this._lastContainerState = undefined;

    /** Whether the creative has been initialized. @type {boolean} @private */
    this._initialized = false;

    /** Whether the creative has reached its internal terminated bookend. @type {boolean} @private */
    this._terminated = false;

    /** Placement type. Defaults to 'inline'. @type {'inline'|'interstitial'} */
    this.placementType = 'inline';
  }

  // -------------------------------------------------------------------------
  // Initialization — called automatically on script load
  // -------------------------------------------------------------------------

  /**
   * Bootstraps the creative. Called automatically when the script loads.
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
    if (this._terminated) return;
    this._proto.setPlacementType(this.placementType);
    this._proto.createSession()
      .then(() => {
        // Session established — wait for Container:init (handled in listener)
      })
      .catch((err) => {
        console.error('[SHARC Creative] createSession failed:', err);
        this._terminated = true;
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
    proto.addListener(ContainerMessages.STATE_CHANGE, /** @type {(msg: any) => void} */ ((msg) => {
      const state = msg.args && msg.args.containerState;
      // R1 D3 — cache the last lifecycle state for replay to late subscribers.
      this._lastContainerState = state;
      this._emit('stateChange', state);
    }));

    // Container:placementChange — container dimensions changed
    proto.addListener(ContainerMessages.PLACEMENT_CHANGE, /** @type {(msg: any) => void} */ ((msg) => {
      const placement = msg.args && msg.args.placementUpdate;
      this._emit('placementChange', placement);
    }));

    // Container:placementConstraintsChange — constraints changed (rotation, resize, policy update)
    proto.addListener(ContainerMessages.PLACEMENT_CONSTRAINTS_CHANGE, /** @type {(msg: any) => void} */ ((msg) => {
      const args = msg.args || {};
      this._cachedConstraints = {
        maxWidth:           args.maxWidth != null ? args.maxWidth : null,
        maxHeight:          args.maxHeight != null ? args.maxHeight : null,
        allowedIntents:     args.allowedIntents || ['resize', 'expand', 'fullscreen', 'collapse'],
        requireCloseRegion: !!args.requireCloseRegion,
        allowOffscreen:     args.allowOffscreen !== false,
      };
      this._emit('constraintsChange', args);
      proto.resolve(msg, {});
    }));

    // Container:placementTransitionEnd — container animation completed (or skipped)
    proto.addListener(ContainerMessages.PLACEMENT_TRANSITION_END, /** @type {(msg: any) => void} */ ((msg) => {
      const args = msg.args || {};
      this._emit('placementTransitionEnd', args);
      proto.resolve(msg, {});
    }));

    // Container:audioVolumeChange — live audio state signal (MRAID 3.0 §4.6)
    proto.addListener(ContainerMessages.AUDIO_VOLUME_CHANGE, /** @type {(msg: any) => void} */ ((msg) => {
      const args = msg.args || {};
      this._emit('audioVolumeChange', args);
    }));

    // Container:log — container sending a log message to creative
    proto.addListener(ContainerMessages.LOG, /** @type {(msg: any) => void} */ ((msg) => {
      const message = msg.args && msg.args.message;
      console.log('[SHARC Container Log]', message);
      this._emit('log', message);
    }));

    // Container:fatalError — container is terminating after a fatal error
    proto.addListener(ContainerMessages.FATAL_ERROR, /** @type {(msg: any) => void} */ ((msg) => {
      console.error('[SHARC Creative] Container fatal error:', msg.args);
      // Must resolve to acknowledge
      proto.resolve(msg, {});
      this._terminated = true;
      this._emit('containerError', msg.args);
    }));

    // Container:close — container has initiated close flow
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

    // R1 D3 — seed the replay cache from env.currentState (D2 sends the real
    // current state here). Only a creative-queryable state is cached; a missing
    // currentState (legacy env) leaves the cache empty so no stale value is
    // replayed. A live inbound Container:stateChange supersedes this seed.
    const initState = this._env.currentState;
    if (CREATIVE_QUERYABLE_STATES.has(initState)) {
      this._lastContainerState = initState;
    }

    // OR-2/OR-3/OR-5 — fire all registered onReady listeners (P5), then set the
    // per-session fired-flag and cache the honest (env, features) so a late
    // listener can replay once on registration.
    this._onReadyFired = true;
    this._onReadyCache = { env: this._env, features: this._features };

    if (this._readyListeners.length === 0) {
      // No onReady registered — resolve anyway to keep the lifecycle moving
      this._proto.resolve(msg, {});
      return;
    }

    // Fire each listener (OR-1, registration order). A throw aborts the init
    // handshake with a reject, preserving the single-callback reject semantics.
    //
    // OR-2 reentrancy (Codex #401): _onReadyFired/_onReadyCache are set ABOVE,
    // so an onReady() call from inside a listener replays the new listener once
    // synchronously. Snapshot the array before dispatch (mirrors _emit's
    // forEach, which freezes its range) so a during-dispatch registrant is NOT
    // also re-visited by this live loop — it fires exactly once, via replay.
    const promises = [];
    for (const listener of this._readyListeners.slice()) {
      let result;
      try {
        result = listener(this._env, this._features);
      } catch (err) {
        console.error('[SHARC Creative] onReady callback threw:', err);
        this._proto.reject(msg, ErrorCodes.AD_INTERNAL_ERROR, err.message || 'onReady threw');
        return;
      }
      promises.push(
        result && typeof result.then === 'function' ? result : Promise.resolve(result)
      );
    }

    // Resolve init when every listener's promise resolves; reject on the first rejection.
    Promise.all(promises)
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
   * @param {Function} callback - (env: Object, features: Array<string | {name: string, version?: string}>) => Promise<void> | void
   * @returns {SHARCCreative} this (for chaining)
   *
   * @example
   * SHARC.onReady(async (env, features) => {
   *   myAd.setMuted(env.isMuted);
   *   await myAd.loadAssets();
   * });
   */
  onReady(callback) {
    this._readyListeners.push(callback);

    // OR-2 — a listener registered AFTER onReady fired is replayed exactly once,
    // synchronously at registration, with the cached (env, features). A listener
    // registered before init fires once in _handleInit. No listener fires twice.
    // Mirrors the stateChange replay in on() (R1 D3). Guarded like _emit (§8.2).
    if (this._onReadyFired && this._onReadyCache) {
      try {
        callback(this._onReadyCache.env, this._onReadyCache.features);
      } catch (e) { /* swallow — match _emit / stateChange replay */ }
    }
    return this;
  }

  /**
   * Registers the "start" callback, called when Container:startCreative is received.
   *
   * The callback should make the creative visible and begin the ad experience.
   * Return a Promise that resolves when the creative is visible and running.
   *
   * @param {Function} callback - () => Promise<void> | void
   * @returns {SHARCCreative} this (for chaining)
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
   *   - 'close'           — container has initiated close flow; callback receives no args
   *   - 'log'             — container sent a log message; callback receives (message: string)
   *   - 'containerError'  — container sent a fatal error; callback receives (args: Object)
   *
   * @param {string} event - Event name.
   * @param {Function} callback - Event handler.
   * @returns {SHARCCreative} this (for chaining)
   *
   * @example
   * SHARC.on('stateChange', (state) => {
   *   if (state === 'hidden') myAd.pauseAnimations(); // pause/save work here
   *   if (state === 'active') myAd.resumeAnimations();
   *   // Do not rely on 'frozen' for cleanup, JS may already be suspended.
   * });
   */
  on(event, callback) {
    if (!this._eventListeners[event]) {
      this._eventListeners[event] = [];
    }
    this._eventListeners[event].push(callback);

    // R1 D3 — replay the current lifecycle state to a late 'stateChange'
    // subscriber, once, on registration. Scope is strictly the latching
    // lifecycle 'stateChange' event — one-shot events (containerError / log /
    // close) are never replayed (replaying a stale error/log is wrong). The
    // live subscription is untouched: ongoing toggles keep flowing, so the
    // replay does not latch. Delivered to the registering listener only, so an
    // existing listener never double-fires. Fires after 'ready' in practice:
    // the cache is seeded in _handleInit and from inbound stateChange, both of
    // which occur during/after the handshake. Guarded like _emit (§8.2).
    if (event === 'stateChange' && this._lastContainerState !== undefined) {
      try { callback(this._lastContainerState); } catch (e) { /* swallow — match _emit */ }
    }

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
   * @returns {SHARCCreative} this
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
    if (this._terminated) return Promise.reject(new Error('SHARC Creative is terminated'));
    return this._proto.getContainerState().then((value) => {
      const result = /** @type {{ currentState?: string }} */ (value);
      return result && result.currentState;
    });
  }

  /**
   * Returns the current placement options.
   * @returns {Promise<Object>} Resolves with placement information.
   */
  getPlacementOptions() {
    if (this._terminated) return Promise.reject(new Error('SHARC Creative is terminated'));
    return this._proto.getPlacementOptions().then((value) => value && value.currentPlacementOptions);
  }

  /**
   * Queries the container's placement constraints.
   * Returns what the container allows before the creative requests a change.
   * Use SHARC.hasFeature('com.iabtechlab.sharc.placement.constraints') to check availability.
   *
   * @returns {Promise<{maxWidth: number|null, maxHeight: number|null,
   *           allowedIntents: string[], requireCloseRegion: boolean, allowOffscreen: boolean}>}
   */
  getPlacementConstraints() {
    if (this._terminated) return Promise.reject(new Error('SHARC Creative is terminated'));
    return this._proto.getPlacementConstraints().then((value) => {
      // Cache the result for getCachedConstraints()
      if (value) this._cachedConstraints = value;
      return value;
    });
  }

  /**
   * Returns the last known placement constraints.
   * Synchronous — uses cached data from the last getPlacementConstraints()
   * call or the last constraintsChange event. Before any query or event,
   * returns unconstrained defaults (never null).
   * @returns {Object}
   */
  getCachedConstraints() {
    return this._cachedConstraints || {
      maxWidth: null,
      maxHeight: null,
      allowedIntents: ['resize', 'expand', 'fullscreen', 'collapse'],
      requireCloseRegion: false,
      allowOffscreen: true,
    };
  }

  /**
   * Requests a placement change.
   *
   * @param {Object} args
   * @param {string} args.intent - 'resize' | 'expand' | 'collapse' | 'fullscreen'
   * @param {Object} [args.targetDimensions] - {width, height} — required when intent === 'resize'
   * @param {string} [args.anchorPoint] - 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
   * @returns {Promise<Object>} Resolves with updated placement.
   *
   * @example
   * await SHARC.requestPlacementChange({ intent: 'expand' });
   * await SHARC.requestPlacementChange({ intent: 'resize', targetDimensions: { width: 320, height: 480 } });
   */
  requestPlacementChange(args) {
    if (this._terminated) return Promise.reject(new Error('SHARC Creative is terminated'));
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
    if (this._terminated) return Promise.resolve(); // Terminated state: return resolved promise for consistency
    // Return the promise so callers can await the container's resolve/reject.
    // Reject with code 2105 (UNSPECIFIED_CONTAINER) means creative should handle navigation itself.
    return this._proto.requestNavigation({ target: 'clickthrough', ...args });
  }

  /**
   * Requests the container to close.
   * The container may refuse (reject) if it cannot honor the close request at this time.
   *
   * @returns {Promise<void>} Resolves if container accepts; rejects if refused.
   *
   * @example
   * document.getElementById('close-btn').addEventListener('click', () => {
   *   SHARC.requestClose();
   * });
   */
  requestClose() {
    if (this._terminated) return Promise.resolve();
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
    if (this._terminated) return Promise.reject(new Error('SHARC Creative is terminated'));
    return this._proto.reportInteraction(trackingUris);
  }

  /**
   * Returns the list of supported features/extensions.
   * Prefer `hasFeature()` for synchronous feature checks using cached init data.
   *
   * @returns {Promise<Array<string | {name: string, version?: string}>>}
   */
  getFeatures() {
    if (this._terminated) return Promise.reject(new Error('SHARC Creative is terminated'));
    return this._proto.getFeatures().then((value) => {
      const result = /** @type {{ features?: Array<string | {name: string, version?: string}> }} */ (value);
      return result && Array.isArray(result.features) ? result.features : [];
    });
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
    if (this._terminated) return Promise.reject(new Error('SHARC Creative is terminated'));
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
   * After calling this, the creative enters a terminated state and no further messages
   * are sent or received.
   *
   * @param {number} code - Error code from ErrorCodes enum.
   * @param {string} [message] - Additional error details.
   *
   * @example
   * SHARC.fatalError(SHARC.ErrorCodes.CANNOT_LOAD_RESOURCES, 'Failed to load video asset');
   */
  fatalError(code, message = '') {
    if (this._terminated) return;
    this._terminated = true;
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
    if (this._terminated) return;
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
   * @returns {Array<string | {name: string, version?: string}>}
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
// Auto-instantiation and browser global exposure
// ---------------------------------------------------------------------------

// #327 — Window-singleton boot guard.
//
// This bundle is evaluated at module scope, which auto-boots a SHARCCreative
// instance. A creative that declares a compat API (e.g. MRAID `api:5`) gets the
// SHARC renderer's wrapper SDK prelude AND may independently ship its own
// `sharc-creative.js`, so the IIFE bundle can be evaluated TWICE in one iframe
// window. Without a window-level guard, the second evaluation spins up a SECOND
// instance + protocol that mints a competing second session and registers its
// OWN 'message' listener on the shared `port2` (`_attachPort` is idempotent
// per instance — addEventListener with the retained handler removed on
// re-attach — but nothing deduplicates ACROSS instances). At the time of the
// #327 incident `_attachPort` was single-slot (`port2.onmessage =`,
// last-attacher-wins), so the surviving instance was bound to the REJECTED
// session, the container's `Container:init` for the ACCEPTED session was
// dropped on a sessionId mismatch, `sendInit` never resolved, and the
// strict-mode handshake route to READY/ACTIVE never opened — the ad rendered
// but viewability/OMID never started (silent under-count). See the discover report:
// Obsidian/dev-team/sharc/2026-06-09-327-double-sdk-never-active-discover.md.
//
// The per-instance `_initialized` guard (constructor) cannot stop a SECOND
// instance, so the guard must live on the window. A SECOND module evaluation is
// a NO-OP for BOOT: no second instance, no second `_proto.init()`, no second
// bootstrap listener, no second `createSession`, no second `_attachPort`.
//
// SCOPE — what this guard does NOT touch: the bfcache relink path (#338). A
// relink re-runs `_attachPort` on a NEW port for the SAME already-booted
// instance via the bootstrap listener that `_proto.init()` registered ONCE on
// the live window — it never re-evaluates this module. The guard keys on
// module-eval/boot, NOT on `_attachPort`, so relink (same instance, new port)
// is structurally unaffected. The transport/wire, lifecycle state machine, and
// init-resolve handshake are likewise untouched.
/** @type {any} */
const _bootWin = (typeof window !== 'undefined') ? window : undefined;
const _alreadyBooted = !!(_bootWin && _bootWin.__sharcCreativeBooted === true);
const _instance = (_alreadyBooted && _bootWin.__sharcCreativeInstance)
  ? /** @type {SHARCCreative} */ (_bootWin.__sharcCreativeInstance)
  : new SHARCCreative();
// True only when THIS module evaluation took the fresh-boot branch above
// (`!_alreadyBooted`), i.e. it constructed `_instance` itself. When false,
// `_instance` came from a pre-existing `__sharcCreativeInstance` window global
// that this eval did NOT create — which on a poisoned page is attacker-set.
// The inert `creative` ESM export is gated on this so it can never surface a
// window-instance this module didn't genuinely boot. See export trailer.
const _bootedHere = !_alreadyBooted;

// document.open self-rewrite re-arm (ADR 2026-06-13-document-open-shim-
// mechanism.md, ADR 2026-06-15). The #327 guard above makes a SECOND module
// eval in the SAME document an inert no-op. But a creative's
// `document.open()/write()/close()` self-rewrite REOPENS the document: window
// globals (including the singleton flags and `_instance`) survive, AND the
// single `port2` survives in the renderer IIFE's closure — but document.open
// WIPES every `window` 'message' listener, including the bootstrap listener
// that `_proto.init()` registered on first boot. The renderer's shim bumps
// `window.__sharcDocGeneration` on each reopen; if THIS already-booted eval is
// running in a generation LATER than the one it last armed in, the listener
// was wiped and the session MUST be re-armed so the SDK re-binds the SURVIVING
// port (the IIFE re-pushes it in-realm via `attachRendererPort`; there is NO
// container re-transfer and NO new port — the relink path is retired). This is
// the document.open analogue of the bfcache re-arm the #327 SCOPE note carves
// out — same instance, re-armed listener, SAME surviving port; no second boot,
// no second session.
if (_alreadyBooted && _instance && typeof window !== 'undefined') {
  /** @type {any} */
  const _gw = window;
  const _curGen = typeof _gw.__sharcDocGeneration === 'number'
    ? _gw.__sharcDocGeneration : 0;
  const _armedGen = typeof _gw.__sharcCreativeArmedGeneration === 'number'
    ? _gw.__sharcCreativeArmedGeneration : 0;
  if (_curGen > _armedGen) {
    _gw.__sharcCreativeArmedGeneration = _curGen;
    try {
      // Re-register the bootstrap listener wiped by document.open and re-arm
      // the session handshake on the reopened document.
      /** @type {any} */
      const _inst = _instance;
      // 1. Re-arm the transport: clear the local port reference, arm a fresh
      //    port-ready gate, and re-register the wiped window 'message' listener
      //    for transport completeness. The live MessageChannel path re-attaches
      //    the SURVIVING port2 in-realm when the IIFE calls
      //    `attachRendererPort` — no container re-transfer, no new port.
      _inst._proto.rearmBootstrap();
      // 2. The prior generation's createSession may have rejected when its
      //    port-ready gate was torn down on the reopen (or never ran before the
      //    reopen). Clear the terminal latches so the reopened SDK can drive a
      //    fresh createSession over the surviving port, and re-register
      //    container listeners on the re-armed protocol.
      _inst._proto._terminated = false;
      _inst._terminated = false;
      _inst._registerContainerListeners();
      // 3. Drive createSession. It awaits the re-armed _portReadyPromise, so it
      //    blocks until the IIFE re-attaches the surviving port2 in-realm (the
      //    IIFE re-pushes it as part of re-anchoring this generation, alongside
      //    the re-anchored :rendered posted off this document's window 'load').
      try { _inst._startSession(); } catch (_) { /* defensive */ }
    } catch (_) { /* defensive — never throw into creative page */ }
  }
}

// In browser contexts, augment window.SHARC with the creative methods.
// We merge into the existing object (set by sharc-protocol.js) rather than
// replacing it, so that any properties added by sharc-protocol.js or other
// modules that ran first (e.g. Protocol, OmidCompatBridge) are preserved.
//
// Gated on the window-singleton flag: on a SECOND module evaluation the boot
// effects below (augmentation + `_boot()` + nav-bridge auto-install) are
// skipped entirely. window.SHARC and its bindings were already established by
// the first boot, so re-running them would only re-bind closures over a phantom
// second instance and re-run the navigation-bridge install — the second eval
// MUST be inert here.
if (typeof window !== 'undefined' && !_alreadyBooted) {
  // Ensure window.SHARC exists (sharc-protocol.js normally creates it, but
  // be defensive in case of load-order variation).
  window.SHARC = window.SHARC || {};

  // Claim the singleton before any boot side-effects run, so a re-entrant
  // second evaluation in the same window short-circuits at the gate above.
  // INVARIANT: `__sharcCreativeBooted` and `__sharcCreativeInstance` are
  // ALWAYS co-set here, written together at boot-claim. Never set one without
  // the other — setting `__sharcCreativeBooted` alone would skip boot on the
  // next eval while leaving a never-booted (or absent) instance to be read by
  // the gate above; setting `__sharcCreativeInstance` alone would not gate.
  _bootWin.__sharcCreativeBooted = true;
  _bootWin.__sharcCreativeInstance = _instance;

  Object.assign(window.SHARC, {
    // Preserve Protocol if already set by sharc-protocol.js; otherwise store null.
    // (Object.assign won't overwrite with undefined, so only set if missing.)
    Protocol: window.SHARC.Protocol || null,
    ErrorCodes: window.SHARC.ErrorCodes || ErrorCodes,

    onReady: (cb) => _instance.onReady(cb),
    onStart: (cb) => _instance.onStart(cb),
    on: (event, cb) => _instance.on(event, cb),
    off: (event, cb) => _instance.off(event, cb),
    getContainerState: () => _instance.getContainerState(),
    getPlacementOptions: () => _instance.getPlacementOptions(),
    getPlacementConstraints: () => _instance.getPlacementConstraints(),
    getCachedConstraints: () => _instance.getCachedConstraints(),
    requestPlacementChange: (args) => _instance.requestPlacementChange(args),
    requestNavigation: (args) => _instance.requestNavigation(args),
    requestClose: () => _instance.requestClose(),
    reportInteraction: (uris) => _instance.reportInteraction(uris),
    getFeatures: () => _instance.getFeatures(),
    hasFeature: (name) => _instance.hasFeature(name),
    requestFeature: (name, args) => _instance.requestFeature(name, args),
    fatalError: (code, msg) => _instance.fatalError(code, msg),
    log: (msg) => _instance.log(msg),
    getEnv: () => _instance.getEnv(),
    getSupportedFeatures: () => _instance.getSupportedFeatures(),

    _instance: _instance,
  });

  // ADR 2026-06-15 § Mechanism point 2: in-realm seam the renderer IIFE calls
  // to push the SURVIVING `port2` to the SDK on a `document.open` reopen
  // (no container re-transfer). Captured by the IIFE at gen-0 (before any
  // creative code) so a later creative cannot intercept the genuine method.
  // IN-REALM ONLY — a hostile caller passing a fake port breaks only its own
  // SDK transport (the IIFE owns the probe answerer; the SDK never answers).
  /** @type {any} */ (window.SHARC).__attachRendererPort = (port) =>
    /** @type {any} */ (_instance)._proto.attachRendererPort(port);

  // Call _boot after window.SHARC assignment completes
  /** @type {any} */ (_instance)._boot();

  // Phase E deliverable 2: auto-install the navigation bridge for the
  // Creative URL flow.
  //
  // Variant detection: `window.__sharcRenderer` is set by the reference
  // renderer (`examples/renderer/index.html`) at module-evaluation time —
  // BEFORE `document.write(creativeHtml)` puts the creative SDK on the
  // page. So if `__sharcRenderer` is present, we're in the Markup variant
  // and the renderer has already installed the bridge (via its own
  // `installNavigationBridge(window)` call). If absent, we're in the
  // Creative URL variant and the SDK is the install point.
  //
  // The bridge install is idempotent at the bridge level
  // (`__sharcNavBridgeInstalled` flag) — calling install twice is safe by
  // construction. The variant gate is a defense-in-depth optimization
  // (avoids a redundant call + log noise), not a correctness requirement.
  //
  // Expose the named export on the SHARC namespace for parity with the
  // standalone bridge module's expose pattern (the standalone module also
  // sets `window.SHARC.installNavigationBridge` for non-module creatives).
  // Operators that need manual install can call it from their own code.
  //
  // First-assignment-wins contract: if the operator pre-sets
  // `window.SHARC.installNavigationBridge` before SHARC modules load (e.g.
  // to wrap the install with telemetry, custom logging, or a feature
  // flag), the SDK does NOT clobber that override. Same guard exists in
  // `sharc-navigation-bridge.js`; if either file's assignment ran
  // unconditionally the operator's override would be silently overwritten
  // depending on script-tag order.
  /** @type {any} */
  const _anyWin = window;
  if (typeof window.SHARC.installNavigationBridge !== 'function') {
    window.SHARC.installNavigationBridge = installNavigationBridge;
  }
  const hasRendererMarker = !!_anyWin.__sharcRenderer;
  if (hasRendererMarker
      && !_anyWin.__sharcNavBridgeInstalled
      && typeof console !== 'undefined'
      && console.warn) {
    console.warn(
      '[SHARC Creative] __sharcRenderer marker is present, but the navigation '
      + 'bridge is not installed. Navigation bridge auto-install will be '
      + 'skipped; if this is Creative URL traffic, native target="_blank" '
      + 'clickthroughs may bypass SHARC navigation audit.'
    );
  }
  if (!hasRendererMarker && !_anyWin.__sharcNavBridgeInstalled) {
    // Creative URL flow — install the bridge synchronously at SDK init.
    // Synchronous install (not dynamic import) avoids the first-click
    // race that a deferred install would introduce — by the time the
    // creative HTML's first script tag runs, the bridge is already in
    // place, intercepting `window.open`, `<a>` clicks, form submits,
    // and `location.*` setters before any creative code can fire.
    try {
      installNavigationBridge(window);
    } catch (e) {
      // Defense-in-depth: bridge install should never throw under normal
      // conditions (the bridge's only throw is for missing window
      // context, which we just verified above). If a future bridge change
      // adds a throw path, we log here rather than letting it crash SDK
      // init — the container-side load-event backstop (RENDERER_
      // UNAUTHORIZED_NAVIGATION 2118) is the load-bearing fallback for
      // any bridge install failure.
      console.error('[SHARC Creative] navigation bridge auto-install failed:', e);
    }
  }
}

// ---------------------------------------------------------------------------
// ESM exports
// ---------------------------------------------------------------------------

// window.SHARC is the public API object (augmented above).
// Export it as a named export so modules can `import { SHARC }`.
const SHARC = (typeof window !== 'undefined') ? window.SHARC : {};

// Legacy IIFE support - ensure global namespace is available even with sideEffects: false
if (typeof window !== 'undefined' && typeof window.SHARC !== 'undefined' && !window.SHARC.Creative) {
  window.SHARC.Creative = SHARCCreative;
}

// The `creative` convenience export is gated on `_bootedHere` so it only ever
// surfaces the genuine instance THIS module constructed and booted. Without the
// gate, a poisoned page that pre-sets `window.__sharcCreativeInstance` would
// make `_instance` resolve to the attacker object (the boot guard correctly
// keeps it OFF the live API, but the unconditional export would still publish
// it as `creative` / `SHARC.creative`). On a non-boot eval we export `null`
// rather than a window-instance this eval did not create.
//
// NULL CONTRACT (documented public-API behavior, #327): the `creative` named
// export is the genuine first-booted instance ONLY on the eval that actually
// performed the boot. On ANY subsequent (guarded) eval — e.g. a creative that
// ships its own bundled `sharc-creative.js` and `import { creative }`s from it
// after a first copy already booted in-frame — this export is `null` BY DESIGN.
// We cannot distinguish a genuine prior boot from an attacker that pre-set
// `window.__sharcCreativeInstance`, so we never surface a possibly-poisoned
// instance as a module export. Consumers needing the live instance after a
// guarded eval MUST read `window.SHARC` (the live public API, always bound to
// the genuine first instance). The `SHARCCreative | null` JSDoc type below
// propagates this contract into the generated `dist/sharc-creative.d.ts`.
/** @type {SHARCCreative | null} */
const creative = _bootedHere ? _instance : null;

export { SHARCCreative, creative, SHARC };

// Phase E deliverable 2: re-export the bundled navigation bridge surface.
// ESM consumers that load `sharc-creative` get both the install function and
// the error class for free; no second import required. The standalone
// `sharc-navigation-bridge` module continues to ship for operators that
// prefer to load it separately (e.g. inside the reference renderer, where it
// imports the standalone module to keep the renderer's single-purpose). Both
// paths share the same exported references — `instanceof` checks against
// `SHARCNavigationError` work regardless of which import was used.
//
// `installNavigationBridge` is re-exported here again as of #370. It was
// dropped in #367 as a point-fix for the IIFE epilogue clobber: rollup turned
// every top-level named export into an UNCONDITIONAL `window.SHARC.<name> =
// <name>` assignment that ran AFTER the module body, overwriting the
// first-assignment-wins guard above (`if (typeof
// window.SHARC.installNavigationBridge !== 'function')`) and silently
// replacing an operator's pre-set override. #369 generalized that fix at the
// build layer — the `firstAssignmentWinsGlobalExports` rollup plugin rewrites
// every IIFE `exports.X = X;` into `if (!('X' in exports)) exports.X = X;`, so
// the epilogue now PRESERVES an operator's pre-set value for EVERY named
// export, including `installNavigationBridge`. With that guard in place the
// #367 drop is redundant, so the named export is restored for parity with
// `SHARCNavigationError` and the standalone bridge module. The operator
// override contract is held by #369's epilogue guard.
export { installNavigationBridge, SHARCNavigationError };
