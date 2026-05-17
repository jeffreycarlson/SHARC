/**
 * @fileoverview SHARC Lifecycle Adapter — Abstract Base Class
 *
 * Abstract base for the SHARC lifecycle adapter family introduced in 0.7.2.
 * Concrete subclasses derive container state transitions from environment-
 * specific signals: the 0.7.2 first-half ships {@link HtmlAdapter} (browser-
 * native signals only); 0.7.3 will add `MraidAdapter` and `SafeFrameAdapter`
 * subclasses that layer framework-specific signals on top.
 *
 * Open-closed contract:
 *   - Container instantiates exactly one adapter in `load()` via
 *     `SHARCContainer._selectLifecycleAdapter(apiFramework)`.
 *   - Container calls `adapter.attach(this)` once `_iframe` exists.
 *   - Container calls `adapter.detach()` in `_terminate()`.
 *
 * Subclasses override `attach` and `detach` to register and tear down
 * environment listeners. The base implementation tracks the attached
 * container and defends against double-attach (a class of double-listener
 * bugs that surfaced during 0.7.0 development).
 *
 * See 0.7.2 design doc § 8.1 ("Architectural shape — adapter classes")
 * for the rationale that picked the adapter-class shape over inline-switch
 * or registry alternatives.
 *
 * @version 0.7.1
 */

'use strict';

/**
 * Abstract base class for SHARC lifecycle adapters.
 *
 * Subclasses MUST override `attach(container)` and `detach()`. The base
 * implementation enforces the single-attach invariant — calling `attach`
 * twice without an intervening `detach` throws to surface the bug at the
 * second-call site rather than silently double-registering listeners.
 *
 * @example
 * // Subclassing (skeleton):
 * class MyAdapter extends BaseLifecycleAdapter {
 *   attach(container) {
 *     super.attach(container);  // sets this._container and runs the guard
 *     // register listeners...
 *   }
 *   detach() {
 *     // unregister listeners...
 *     super.detach();           // clears this._container
 *   }
 * }
 */
class BaseLifecycleAdapter {
  constructor() {
    /**
     * The container instance this adapter is attached to, or `null` when
     * detached. Subclasses read `this._container` to reach the state machine,
     * iframe element, and protocol surface.
     * @type {?Object}
     * @protected
     */
    this._container = null;
  }

  /**
   * Attaches the adapter to a container. Subclasses MUST call `super.attach`
   * first to enforce the single-attach invariant and store the container
   * reference, then register their own listeners / observers.
   *
   * @param {Object} container - The {@link SHARCContainer} instance to observe.
   * @throws {Error} If the adapter is already attached (defense-in-depth
   *   against double-listener registration).
   */
  attach(container) {
    if (this._container !== null) {
      throw new Error(
        '[SHARCLifecycleAdapter] attach() called twice without detach() — '
        + 'lifecycle adapters MUST be detached before re-attaching to '
        + 'prevent double-listener registration.'
      );
    }
    this._container = container;
  }

  /**
   * Detaches the adapter. Subclasses MUST unregister their listeners /
   * observers and then call `super.detach()` to clear the container
   * reference. Safe to call when not attached — a no-op in that case.
   */
  detach() {
    this._container = null;
  }

  /**
   * Internal-but-cross-class hook the container calls to invite the
   * adapter to re-check its initial-transition gate. Used when a
   * container-side signal relevant to the adapter's gate has changed
   * (e.g., Markup variant flipping `creativeRendered = true` after
   * `:rendered` envelope validation). Base class is a no-op; subclasses
   * override if they have an initial-transition gate to re-evaluate.
   *
   * **Subclass authors:** any override MUST respect
   * `container._requireSharcInit === true` and yield to the
   * handshake-driven `LOADING → READY → ACTIVE` path during LOADING.
   * The strict-mode race (adapter promotes before handshake completes)
   * permanently corrupts the handshake-driven lifecycle — see PR #98
   * findings + 0.7.2 design § 8.2.
   *
   * Underscore-prefix marks this as an internal API; `@protected`
   * scopes it to the class hierarchy (container + 0.7.3 framework
   * subclasses) while keeping it accessible across the cross-class
   * boundary that TS would otherwise reject.
   * @protected
   */
  _maybeAdvanceToActive() {
    /* base no-op — subclasses override */
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BaseLifecycleAdapter };
}

export { BaseLifecycleAdapter };
