/**
 * @fileoverview SHARC SafeFrame 1.1 Compatibility Bridge
 *
 * Makes existing SafeFrame 1.1 creatives run inside a SHARC container
 * without modification. Exposes a spec-compliant `window.$sf.ext` object
 * backed exclusively by the SHARC Creative SDK (`window.SHARC`).
 *
 * Architecture: Pure adapter above `window.SHARC`. Never touches MessageChannel
 * directly. All SHARC protocol communication is delegated to sharc-creative.js.
 *
 * Load order in the creative iframe:
 *   1. sharc-protocol.js  → window.SHARC.Protocol
 *   2. sharc-creative.js  → window.SHARC (SDK methods)
 *   3. sharc-safeframe-bridge.js → window.$sf.ext (this file)
 *   4. <SafeFrame creative>
 *
 * What is NOT implemented:
 *   - window.$sf.host — intentionally absent; SHARC container replaces it entirely
 *   - exp-push (push expand) — deferred to v2; fires 'failed' callback
 *   - $sf.ext.cookie() — permanently excluded; fires 'failed' callback
 *
 * @version 0.1.0
 * @see safeframe-bridge-design.md
 */

'use strict';

// ---------------------------------------------------------------------------
// UMD wrapper — same pattern as sharc-mraid-bridge.js
// ---------------------------------------------------------------------------
(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    // CommonJS / Node.js
    module.exports = factory();
  } else {
    // Browser script-tag mode — install window.$sf immediately
    var result = factory();

    // Expose SafeFrameCompatBridge class on SHARC namespace for container use
    window.SHARC = window.SHARC || {};
    window.SHARC.SafeFrameCompatBridge = result.SafeFrameCompatBridge;

    // Install window.$sf.ext (singleton guard inside installSafeFrameBridge)
    result.installSafeFrameBridge(window.SHARC);
  }
}(function () {

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Computes the in-view percentage (0–100) from SHARC state and cached geometry.
   * Returns 0 when hidden, frozen, or pre-init.
   * @param {string} sharcState
   * @param {Object|null} env
   * @returns {number} 0–100
   */
  function computeInViewPct(sharcState) {
    if (sharcState === 'hidden' || sharcState === 'frozen' || sharcState === 'loading') {
      return 0;
    }
    if (sharcState === 'active') return 100;
    if (sharcState === 'passive') return 100; // visible but unfocused; geometry-based (simplified)
    return 0;
  }

  /**
   * Builds the zeroed-out geom object returned before init.
   * @returns {Object}
   */
  function zeroGeom() {
    return {
      win:  { t: 0, l: 0, r: 0, b: 0, w: 0, h: 0 },
      self: { t: 0, l: 0, r: 0, b: 0, w: 0, h: 0, xiv: 0, yiv: 0, iv: 0, ovx: 0, ovy: 0, ov: 0, ex: false },
      exp:  { t: 0, l: 0, r: 0, b: 0, push: false },
    };
  }

  // -------------------------------------------------------------------------
  // installSafeFrameBridge — creates and wires window.$sf.ext
  // -------------------------------------------------------------------------

  /**
   * Installs the SafeFrame bridge using the provided SHARC SDK reference.
   * Safe to call multiple times — singleton guard prevents double-installation.
   *
   * @param {Object} SHARC - The window.SHARC SDK object (from sharc-creative.js)
   */
  function installSafeFrameBridge(SHARC) {
    // ── Singleton guard (§8.9) ──────────────────────────────────────────────
    if (window.$sf && window.$sf._sharcBridgeInstalled) {
      return; // Already installed; bail silently
    }

    // ── Private bridge state (§5 Internal Bridge State) ────────────────────
    var _s = {
      _sharcState:     'loading',   // Last SHARC state: 'ready'|'active'|'passive'|'hidden'|'frozen'
      _placementMode:  'collapsed', // 'collapsed'|'collapsing'|'expanded'|'expanding'
      _sfReady:        false,       // true after SHARC Container:init has been processed
      _env:            null,        // SHARC EnvironmentData from Container:init
      _sfMeta:         null,        // { shared: {}, owned: { [ownerKey]: {} } }
      _registeredW:    0,           // Width declared in $sf.ext.register()
      _registeredH:    0,           // Height declared in $sf.ext.register()
      _callback:       null,        // The cb registered via $sf.ext.register()
      _inViewPct:      0,           // Cached 0–100 viewability percentage
      _winHasFocus:    false,       // Cached focus state
      _geomCache:      null,        // Cached geom() object; updated on stateChange + placementChange
    };

    // ── Internal helpers ───────────────────────────────────────────────────

    /**
     * Fires the registered SafeFrame callback.
     * Swallows creative exceptions so they cannot disrupt the SHARC protocol.
     * @param {string} status
     * @param {*} data
     */
    function _fireCallback(status, data) {
      if (!_s._callback) return;
      try {
        _s._callback(status, data);
      } catch (e) {
        // Swallow — don't let creative errors break SHARC protocol (§8.2)
        console.warn('[SafeFrame Bridge] Callback threw for status:', status, e);
      }
    }

    /**
     * Rebuilds the cached geom object from current state and env data.
     * Must be called any time state or placement changes.
     * See §8.7 for field definitions.
     */
    function _rebuildGeomCache() {
      var env = _s._env;
      var placement = (env && env.currentPlacement) || {};
      var vpSize = placement.viewportSize || { width: 0, height: 0 };

      // Self size: use placement data, fall back to registered dimensions
      var selfSize = placement.initialDefaultSize || {
        width:  _s._registeredW,
        height: _s._registeredH,
      };

      var maxExpand = placement.maxExpandSize || {
        width:  vpSize.width,
        height: vpSize.height,
      };

      var iv = _s._inViewPct / 100;
      var isExpanded = (_s._placementMode === 'expanded');

      _s._geomCache = {
        win: {
          t: 0,
          l: 0,
          r: vpSize.width,
          b: vpSize.height,
          w: vpSize.width,
          h: vpSize.height,
        },
        self: {
          // Absolute position not available in sandboxed iframe (§6.3)
          t: 0,
          l: 0,
          r: selfSize.width,
          b: selfSize.height,
          w: selfSize.width,
          h: selfSize.height,
          // Simplified intersection: fully in or fully out
          xiv: iv > 0 ? 1.0 : 0.0,
          yiv: iv > 0 ? 1.0 : 0.0,
          iv:  iv,
          // Overflow — not applicable in sandboxed iframe
          ovx: 0,
          ovy: 0,
          ov:  0,
          ex:  isExpanded,
        },
        exp: {
          t: maxExpand.height - selfSize.height,
          l: maxExpand.width  - selfSize.width,
          r: maxExpand.width  - selfSize.width,
          b: maxExpand.height - selfSize.height,
          push: false, // Push expand not supported (§7.1)
        },
      };
    }

    // ── SHARC event wiring ─────────────────────────────────────────────────

    /**
     * SHARC.onReady — fires when Container:init is received.
     * Caches env and sfMeta. Resolves quickly — the container waits on this (§8.3).
     * Does NOT fire the SafeFrame callback here — geometry not meaningful yet.
     */
    SHARC.onReady(function (env) {
      _s._env      = env || {};
      _s._sfMeta   = (_s._env.sfMeta) || { shared: {}, owned: {} };
      _s._sfReady  = true;
      _s._sharcState = 'ready';

      // Build initial geom cache so geom() is non-null after init
      _rebuildGeomCache();

      // Resolve immediately — SHARC container is waiting on this Promise.
      // Do NOT fire creative callback here — first geom-update fires on stateChange(active).
    });

    /**
     * SHARC.onStart — fires when Container:startCreative is received.
     * No SafeFrame equivalent; resolve immediately.
     */
    SHARC.onStart(function () {
      // No SafeFrame mapping for startCreative; just resolve
    });

    /**
     * SHARC stateChange — maps to SafeFrame 'geom-update' and/or 'focus-change'.
     *
     * Ordering contract (§6.8, §8.4):
     *   1. Update internal state FIRST
     *   2. Rebuild geom cache
     *   3. Fire 'geom-update' (except for 'frozen')
     *   4. Fire 'focus-change' if active ↔ passive transition
     */
    SHARC.on('stateChange', function (newState) {
      var prevState = _s._sharcState;

      // 1. Update internal state FIRST — callbacks may read these synchronously
      _s._sharcState   = newState;
      _s._winHasFocus  = (newState === 'active');
      _s._inViewPct    = computeInViewPct(newState);

      // 2. Rebuild geom cache with updated state
      _rebuildGeomCache();

      // 3. Fire 'geom-update' — but NOT for 'frozen' (JS suspended; callback cannot fire)
      if (newState !== 'frozen') {
        _fireCallback('geom-update', _s._geomCache);
      }

      // 4. Fire 'focus-change' only for active ↔ passive transitions (§6.7, §8.4)
      //    NOT for transitions involving hidden/frozen/ready/loading
      var focusFlipped =
        (prevState === 'active'  && newState === 'passive') ||
        (prevState === 'passive' && newState === 'active');
      if (focusFlipped) {
        _fireCallback('focus-change', { focus: newState === 'active' });
      }
    });

    /**
     * SHARC placementChange — update self dimensions and rebuild geom cache.
     * Does not fire a SafeFrame callback on its own; geom-update is driven by stateChange.
     */
    SHARC.on('placementChange', function (placementUpdate) {
      if (!placementUpdate) return;
      // Update env placement data with new dimensions
      if (_s._env && _s._env.currentPlacement) {
        _s._env.currentPlacement.initialDefaultSize = {
          width:  placementUpdate.width  || (_s._env.currentPlacement.initialDefaultSize || {}).width  || 0,
          height: placementUpdate.height || (_s._env.currentPlacement.initialDefaultSize || {}).height || 0,
        };
      }
      _rebuildGeomCache();
    });

    /**
     * SHARC close — cleanup; no direct SafeFrame callback mapping.
     */
    SHARC.on('close', function () {
      // No SafeFrame 'close' event to fire; creative will be destroyed.
      _s._callback = null;
    });

    // ── window.$sf public API ─────────────────────────────────────────────

    var $sf = {

      // ── Spec version ────────────────────────────────────────────────────

      /**
       * SafeFrame spec version this bridge presents as.
       * Hyphenated per IAB spec format.
       * @type {string}
       */
      specVersion: '1-1-0',

      // Sentinel for singleton guard
      _sharcBridgeInstalled: true,

      // ── $sf.ext ─────────────────────────────────────────────────────────

      ext: {

        /**
         * Registers the creative with the SafeFrame host.
         * Stores width, height, and event callback. Does NOT fire callback immediately.
         * First callback fires on stateChange(active) as 'geom-update'.
         *
         * If called multiple times, replaces all stored values with latest.
         *
         * @param {number} w   - Initial width in pixels
         * @param {number} h   - Initial height in pixels
         * @param {Function} cb - Event callback: cb(status, data)
         */
        register: function (w, h, cb) {
          _s._registeredW = (typeof w === 'number') ? w : 0;
          _s._registeredH = (typeof h === 'number') ? h : 0;
          _s._callback    = (typeof cb === 'function') ? cb : null;
          // If env already available (late register), rebuild geom with declared size
          if (_s._sfReady) {
            _rebuildGeomCache();
          }
          // Do NOT fire callback here — §6.1
        },

        /**
         * Returns the feature support object.
         * Static — does not depend on init. Never throws.
         *
         * @returns {{ 'exp-ovr': boolean, 'exp-push': boolean,
         *             'read-cookie': boolean, 'write-cookie': boolean }}
         */
        supports: function () {
          return {
            'exp-ovr':      true,   // Overlay expand supported via SHARC maximize
            'exp-push':     false,  // Push expand deferred to v2 (§7.1)
            'read-cookie':  false,  // No SHARC equivalent; permanently excluded (§6.6)
            'write-cookie': false,  // No SHARC equivalent; permanently excluded (§6.6)
          };
        },

        /**
         * Returns geometric information about the container's position on screen.
         * Returns a zeroed-out object if called before init.
         *
         * Shape: { win: {t,l,r,b,w,h}, self: {t,l,r,b,w,h,xiv,yiv,iv,ovx,ovy,ov,ex}, exp: {t,l,r,b,push} }
         *
         * @returns {Object}
         */
        geom: function () {
          if (_s._geomCache) return _s._geomCache;
          return zeroGeom();
        },

        /**
         * Requests expansion of the container.
         *
         * Overlay mode (push: false, default):
         *   → SHARC.requestPlacementChange({ intent: 'maximize' })
         *
         * Push mode (push: true):
         *   → fires callback('failed', { reason: 'push-not-supported' }) immediately
         *
         * On SHARC resolve: _placementMode = 'expanded'; fires callback('expanded', info)
         * On SHARC reject:  _placementMode = 'collapsed'; fires callback('failed', { reason: 'expand-rejected' })
         *
         * Idempotent: no-op if already expanded or currently expanding.
         *
         * @param {{ t?: number, l?: number, r?: number, b?: number, push?: boolean }} [obj]
         */
        expand: function (obj) {
          // Idempotency guard (§8.5)
          if (_s._placementMode === 'expanded')  return;
          if (_s._placementMode === 'expanding') return;

          var push = obj && obj.push === true;

          // Push mode not supported (§6.2, §7.1)
          if (push) {
            _fireCallback('failed', { reason: 'push-not-supported' });
            return;
          }

          // Set transient state BEFORE async call (§8.5)
          _s._placementMode = 'expanding';

          SHARC.requestPlacementChange({ intent: 'maximize' })
            .then(function (placement) {
              // 1. Update state FIRST
              _s._placementMode = 'expanded';
              // 2. Rebuild geom (container may have resized)
              _rebuildGeomCache();
              // 3. Fire callback
              var w = (placement && placement.width)  || 0;
              var h = (placement && placement.height) || 0;
              _fireCallback('expanded', { info: { w: w, h: h, push: false } });
            })
            .catch(function () {
              _s._placementMode = 'collapsed';
              _fireCallback('failed', { reason: 'expand-rejected' });
            });
        },

        /**
         * Collapses the container to its registered (initial) size.
         * → SHARC.requestPlacementChange({ intent: 'restore' })
         *
         * On resolve: _placementMode = 'collapsed'; fires callback('collapsed', null)
         * On reject:  _placementMode restored to 'expanded'; fires callback('failed', ...)
         *
         * No-op if already collapsed or currently collapsing.
         */
        collapse: function () {
          // Idempotency guard (§8.6)
          if (_s._placementMode === 'collapsed')  return;
          if (_s._placementMode === 'collapsing') return;

          // Set transient state BEFORE async call (§8.6)
          _s._placementMode = 'collapsing';

          SHARC.requestPlacementChange({ intent: 'restore' })
            .then(function () {
              // 1. Update state FIRST
              _s._placementMode = 'collapsed';
              // 2. Rebuild geom
              _rebuildGeomCache();
              // 3. Fire callback
              _fireCallback('collapsed', null);
            })
            .catch(function () {
              // Restore prior state on reject
              _s._placementMode = 'expanded';
              _fireCallback('failed', { reason: 'collapse-rejected' });
            });
        },

        /**
         * Returns the current placement status string.
         * Derived from _placementMode — one of the four SafeFrame status strings.
         *
         * @returns {'expanded'|'expanding'|'collapsed'|'collapsing'}
         */
        status: function () {
          return _s._placementMode; // values always match the four valid SF status strings
        },

        /**
         * Reads metadata provided by the host.
         * Reads from _sfMeta populated at init from SHARC environmentData.sfMeta.
         *
         * Without ownerKey: reads from sfMeta.shared[propName]
         * With ownerKey:    reads from sfMeta.owned[ownerKey][propName]
         *
         * Returns undefined if property missing or before init. Never throws.
         *
         * @param {string} propName
         * @param {string} [ownerKey]
         * @returns {*}
         */
        meta: function (propName, ownerKey) {
          if (!_s._sfMeta) return undefined;
          try {
            if (ownerKey !== undefined) {
              var ownedNs = _s._sfMeta.owned;
              if (!ownedNs || !ownedNs[ownerKey]) return undefined;
              return ownedNs[ownerKey][propName];
            }
            var shared = _s._sfMeta.shared;
            if (!shared) return undefined;
            return shared[propName];
          } catch (e) {
            return undefined;
          }
        },

        /**
         * EXCLUDED — no SHARC equivalent for host-domain cookie access.
         * Fires callback('failed', { reason: 'cookie-not-supported' }) and returns.
         * Never throws. Permanently excluded (§6.6).
         *
         * @param {string} cookieName
         * @param {*} [cookieData]
         */
        cookie: function (cookieName, cookieData) {
          _fireCallback('failed', { reason: 'cookie-not-supported' });
        },

        /**
         * Returns the estimated in-view percentage of the creative (0–100).
         * Returns 0 when state is hidden, frozen, or pre-init.
         *
         * @returns {number} 0–100
         */
        inViewPercentage: function () {
          return _s._inViewPct;
        },

        /**
         * Returns whether the top-level browser window has focus.
         * True only when SHARC state is 'active'.
         *
         * @returns {boolean}
         */
        winHasFocus: function () {
          return _s._winHasFocus;
        },

      }, // end $sf.ext

    }; // end $sf object

    // Install as window.$sf
    window.$sf = $sf;
  } // end installSafeFrameBridge

  // -------------------------------------------------------------------------
  // SafeFrameCompatBridge — container-side extension plugin
  // -------------------------------------------------------------------------

  /**
   * Container-side extension that signals the SHARC container to inject the
   * SafeFrame bridge scripts into the creative iframe before creative code runs.
   *
   * Usage:
   *   import { SafeFrameCompatBridge } from './sharc-safeframe-bridge.js';
   *   const container = new SHARCContainer({
   *     ...
   *     extensions: [new SafeFrameCompatBridge()]
   *   });
   */
  function SafeFrameCompatBridge(options) {
    this.name    = 'com.iabtechlab.sharc.safeframe';
    this.options = options || {};
  }

  SafeFrameCompatBridge.prototype = {
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
        base + '/sharc-safeframe-bridge.js',
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
      return base + '/safeframe-wrapper.html?creative=' + encodeURIComponent(creativeUrl);
    },

    /**
     * Augments environmentData with sfMeta before Container:init is sent.
     * Call this from the container before creating the SHARC session.
     *
     * @param {Object} environmentData - The environment data object to augment
     * @param {Object} [sfMeta] - SafeFrame metadata: { shared: {}, owned: {} }
     */
    setMeta: function (environmentData, sfMeta) {
      if (!environmentData) return;
      environmentData.sfMeta = sfMeta || { shared: {}, owned: {} };
    },
  };

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  return {
    SafeFrameCompatBridge:  SafeFrameCompatBridge,
    installSafeFrameBridge: installSafeFrameBridge,
  };

})); // end UMD factory
