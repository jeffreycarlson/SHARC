/**
 * @fileoverview SHARC MRAID Compatibility Bridge
 *
 * Makes existing MRAID 2.0/3.0 creatives run inside a SHARC container
 * without modification. Exposes a spec-compliant `window.mraid` object
 * backed exclusively by the SHARC Creative SDK (`window.SHARC`).
 *
 * Architecture: Pure adapter above `window.SHARC`. Never touches MessageChannel
 * directly. All SHARC protocol communication is delegated to sharc-creative.js.
 *
 * Load order in the creative iframe:
 *   1. sharc-protocol.js  → window.SHARC.Protocol
 *   2. sharc-creative.js  → window.SHARC (SDK methods)
 *   3. sharc-mraid-bridge.js → window.mraid (this file)
 *   4. <MRAID creative>
 *
 * @version 0.1.0
 * @see mraid-bridge-design.md
 */

'use strict';

// ---------------------------------------------------------------------------
// UMD wrapper — same pattern as sharc-protocol.js
// ---------------------------------------------------------------------------
(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    // CommonJS / Node.js
    module.exports = factory();
  } else {
    // Browser script-tag mode — install window.mraid immediately
    const result = factory();

    // Expose MRAIDCompatBridge class on SHARC namespace for container use
    window.SHARC = window.SHARC || {};
    window.SHARC.MRAIDCompatBridge = result.MRAIDCompatBridge;

    // Install window.mraid (singleton guard inside installMRAIDBridge)
    result.installMRAIDBridge(window.SHARC);
  }
}(function () {

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

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
   * Logic per §2 of design doc:
   *   hidden/frozen → 'hidden'
   *   !mraidReady   → 'loading'
   *   expanded      → 'expanded'
   *   resized       → 'resized'
   *   else          → 'default'
   * @param {Object} s - The private _state object
   * @returns {'loading'|'default'|'expanded'|'resized'|'hidden'}
   */
  function getMraidState(s) {
    if (s._sharcState === 'hidden' || s._sharcState === 'frozen') return 'hidden';
    if (!s._mraidReady) return 'loading';
    if (s._placementMode === 'expanded') return 'expanded';
    if (s._placementMode === 'resized') return 'resized';
    return 'default';
  }

  // -------------------------------------------------------------------------
  // installMRAIDBridge — creates and wires window.mraid
  // -------------------------------------------------------------------------

  /**
   * Installs the MRAID bridge using the provided SHARC SDK reference.
   * Safe to call multiple times — singleton guard prevents double-installation.
   *
   * @param {Object} SHARC - The window.SHARC SDK object (from sharc-creative.js)
   */
  function installMRAIDBridge(SHARC) {
    // ── Singleton guard (§8.9) ──────────────────────────────────────────────
    if (window.mraid && window.mraid._sharcBridgeInstalled) {
      return; // Already installed; bail silently
    }

    // ── Private bridge state (§5 Internal Bridge State) ───────────────────
    const _s = {
      _sharcState:    'loading',   // Last known SHARC state
      _placementMode: 'default',   // 'default' | 'expanded' | 'resized'
      _mraidReady:    false,       // true after Container:init processed
      _isViewable:    false,       // cached; changes drive viewableChange event
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
    };

    // ── Internal event emitter (§8.2) ─────────────────────────────────────
    /**
     * Emits an MRAID event to all registered listeners.
     * Swallows listener exceptions so one bad listener can't block others.
     * @param {string} event
     * @param {...*} args
     */
    function _emit(event) {
      const args = Array.prototype.slice.call(arguments, 1);
      const listeners = _s._listeners[event];
      if (!listeners || listeners.length === 0) return;
      // Copy array to avoid mutation issues during iteration
      listeners.slice().forEach(function (fn) {
        try { fn.apply(null, args); } catch (e) { /* swallow — §8.2 */ }
      });
    }

    // ── SHARC event wiring ─────────────────────────────────────────────────

    /**
     * SHARC.onReady — fires when Container:init is received.
     * Caches env, fires 'ready' + 'stateChange(default)'.
     * Must resolve quickly — SHARC container waits on this (§8.3).
     */
    SHARC.onReady(function (env) {
      _s._env = env || {};
      _s._placementType = derivePlacementType(_s._env);

      // Populate currentPosition from initial placement data
      var initSize = (_s._env.currentPlacement && _s._env.currentPlacement.initialDefaultSize) || {};
      _s._currentPosition = {
        x: 0,
        y: 0,
        width: initSize.width || 0,
        height: initSize.height || 0,
      };

      _s._mraidReady = true;
      _s._sharcState = 'ready';

      // Fire MRAID events synchronously (§4 / §8.3)
      _emit('ready');
      _emit('stateChange', 'default');
      // Resolve immediately — no return value needed; SHARC SDK handles Promise wrapping
    });

    /**
     * SHARC.onStart — fires when Container:startCreative is received.
     * No MRAID equivalent; resolve immediately.
     */
    SHARC.onStart(function () {
      // No MRAID mapping for startCreative; just resolve
    });

    /**
     * SHARC stateChange — maps to MRAID stateChange + viewableChange.
     * Ordering contract (§6.5, §8.4):
     *   1. Update internal state FIRST
     *   2. Fire stateChange
     *   3. Fire viewableChange only if viewability flipped
     */
    SHARC.on('stateChange', function (sharcState) {
      var prevViewable = _s._isViewable;

      // 1. Update internal state first (so getState/isViewable are consistent in handlers)
      _s._sharcState = sharcState;
      _s._isViewable = (sharcState === 'active');

      // 2. Derive MRAID state from updated internals
      var mraidState = getMraidState(_s);

      // 3. Fire stateChange
      _emit('stateChange', mraidState);

      // 4. Fire viewableChange only if viewability flipped
      // Exception: do not fire viewableChange for 'frozen' (§2, §8.4)
      if (sharcState !== 'frozen' && _s._isViewable !== prevViewable) {
        _emit('viewableChange', _s._isViewable);
      }
    });

    /**
     * SHARC placementChange — maps to MRAID sizeChange.
     */
    SHARC.on('placementChange', function (placementUpdate) {
      if (!placementUpdate) return;
      var w = placementUpdate.width || 0;
      var h = placementUpdate.height || 0;
      _s._currentPosition = {
        x: placementUpdate.x || 0,
        y: placementUpdate.y || 0,
        width: w,
        height: h,
      };
      _emit('sizeChange', w, h);
    });

    /**
     * SHARC close — maps to MRAID 'unload' event (§8.8).
     */
    SHARC.on('close', function () {
      _emit('unload');
      // sharc-creative.js manages the watchdog and resolves Container:close.
      // Bridge only fires unload here.
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
       * True only when SHARC state is 'active' (§2).
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
        return _s._placementType;
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
        return { x: 0, y: 0, width: size.width || 0, height: size.height || 0 };
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

      // ── Resize Properties (stored; resize() deferred to v2) ────────────

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
       * Stores resize properties. resize() is deferred to v2 (§7.1).
       * Accepts silently; does not throw.
       * @param {Object} props
       */
      setResizeProperties: function (props) {
        if (!props) return;
        if (typeof props.width === 'number')  _s._resizeProps.width  = props.width;
        if (typeof props.height === 'number') _s._resizeProps.height = props.height;
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
       * Expands the ad to maximize available space.
       * If expandProperties.width/height > 0, uses intent:'resize' with those dimensions.
       * Otherwise uses intent:'maximize'.
       *
       * The url parameter is NOT supported (§6.2) — fires error if provided.
       * Idempotent: no-op if already expanded (§8.5).
       *
       * @param {string} [url] — NOT supported
       */
      expand: function (url) {
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
          requestArgs = { intent: 'maximize' };
        }

        SHARC.requestPlacementChange(requestArgs)
          .then(function () {
            _s._placementMode = 'expanded';
            _emit('stateChange', 'expanded');
          })
          .catch(function (err) {
            var msg = (err && err.message) ? err.message : 'Expand rejected by container';
            _emit('error', msg, 'expand');
          });
      },

      /**
       * Collapses the ad back to default placement.
       * Idempotent: no-op if already in default state (§8.5).
       */
      collapse: function () {
        // Idempotency guard
        if (_s._placementMode === 'default') return;

        SHARC.requestPlacementChange({ intent: 'restore' })
          .then(function () {
            _s._placementMode = 'default';
            _emit('stateChange', getMraidState(_s));
          })
          .catch(function (err) {
            var msg = (err && err.message) ? err.message : 'Collapse rejected by container';
            _emit('error', msg, 'collapse');
          });
      },

      /**
       * Requests the container to close the ad.
       * On container rejection: no error event, no stateChange (§6.4).
       */
      close: function () {
        SHARC.requestClose().catch(function () {
          // Rejection is silently ignored — container declined close (§6.4)
        });
      },

      /**
       * Opens a URL via the container; falls back to window.open on SHARC error 2105 (§8.6).
       * @param {string} url
       */
      open: function (url) {
        SHARC.requestNavigation({ url: url, target: 'clickthrough' })
          .catch(function (err) {
            if (err && err.errorCode === 2105) {
              // Container cannot handle navigation; creative handles it (§8.6)
              window.open(url, '_blank');
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
       * Non-fullscreen resize — deferred to v2 (§7.1).
       * Always fires error event.
       */
      resize: function () {
        _emit('error', 'COMMAND_NOT_SUPPORTED', 'resize');
      },

      // ── Audio (MRAID 3.0) ───────────────────────────────────────────────

      /**
       * Returns whether device audio is muted.
       * Init-time value from SHARC env; no live update in SHARC v1.
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
        // Intentionally disabled features (§3)
        if (feature === 'calendar' || feature === 'storePicture' ||
            feature === 'inlineVideo' || feature === 'vpaid') {
          return false;
        }
        // Container-dependent features — check via SHARC.hasFeature
        if (feature === 'sms') {
          return SHARC.hasFeature('com.iabtechlab.sharc.sms');
        }
        if (feature === 'tel') {
          return SHARC.hasFeature('com.iabtechlab.sharc.tel');
        }
        if (feature === 'location') {
          return SHARC.hasFeature('com.iabtechlab.sharc.location');
        }
        // Unknown features — conservative false
        return false;
      },

      // ── Events ──────────────────────────────────────────────────────────

      /**
       * Registers a listener for a named MRAID event.
       * Supported: 'ready', 'stateChange', 'viewableChange', 'sizeChange', 'error', 'unload'
       * Unknown event names are accepted silently (no error, no effect on other events).
       * @param {string} event
       * @param {Function} listener
       */
      addEventListener: function (event, listener) {
        if (typeof listener !== 'function') return;
        if (!_s._listeners[event]) _s._listeners[event] = [];
        _s._listeners[event].push(listener);
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
       * @param {string} url
       */
      storePicture: function (url) {
        _emit('error', 'COMMAND_NOT_SUPPORTED', 'storePicture');
      },

      /**
       * EXCLUDED. Always fires 'error' event (§3).
       * @param {Object} params
       */
      createCalendarEvent: function (params) {
        _emit('error', 'COMMAND_NOT_SUPPORTED', 'createCalendarEvent');
      },

      /**
       * EXCLUDED. Always fires 'error' event (§3).
       * @param {string} url
       */
      playVideo: function (url) {
        _emit('error', 'COMMAND_NOT_SUPPORTED', 'playVideo');
      },

      /**
       * EXCLUDED. Returns safe stub. Does NOT fire error (§5).
       * Rationale: creatives may read this defensively; throwing would break them.
       * @returns {{allowOrientationChange:boolean, forceOrientation:string}}
       */
      getOrientationProperties: function () {
        return { allowOrientationChange: true, forceOrientation: 'none' };
      },

      /**
       * EXCLUDED. Accepted silently; no-op (§5).
       * @param {Object} props
       */
      setOrientationProperties: function (props) {
        // Silently ignored; no SHARC equivalent and no error (§7.4)
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
   * Usage:
   *   import { MRAIDCompatBridge } from './sharc-mraid-bridge.js';
   *   const container = new SHARCContainer({
   *     ...
   *     extensions: [new MRAIDCompatBridge()]
   *   });
   */
  function MRAIDCompatBridge(options) {
    this.name = 'com.iabtechlab.sharc.mraid';
    this.options = options || {};
  }

  MRAIDCompatBridge.prototype = {
    /**
     * Returns the list of script URLs to inject before the creative.
     * The container should prepend these to the wrapper page or inject via srcdoc.
     * @returns {string[]}
     */
    getScriptUrls: function () {
      var base = this.options.baseUrl || '/sharc';
      return [
        base + '/sharc-protocol.js',
        base + '/sharc-creative.js',
        base + '/sharc-mraid-bridge.js',
      ];
    },

    /**
     * Returns the feature advertisement string for Container:init.
     * @returns {string}
     */
    getFeatureName: function () {
      return this.name;
    },

    /**
     * Returns the wrapper URL for a given creative URL.
     * The container should load this URL in the ad iframe instead of the creative directly.
     * @param {string} creativeUrl
     * @returns {string}
     */
    getWrapperUrl: function (creativeUrl) {
      var base = this.options.baseUrl || '/sharc';
      return base + '/mraid-wrapper.html?creative=' + encodeURIComponent(creativeUrl);
    },
  };

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  return {
    MRAIDCompatBridge:   MRAIDCompatBridge,
    installMRAIDBridge:  installMRAIDBridge,
  };

})); // end UMD factory
