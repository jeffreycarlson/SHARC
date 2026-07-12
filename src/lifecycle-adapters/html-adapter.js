/**
 * @fileoverview SHARC HTML Lifecycle Adapter
 *
 * Browser-native lifecycle adapter — derives SHARC state transitions from
 * iframe `load`, IntersectionObserver, `pagehide` / `pageshow`, and
 * `freeze` / `resume` events when no handshake-driven path is available.
 *
 * Scope (0.7.2 first half):
 *   - Generic HTML creatives (`apiFramework === null`).
 *   - Creatives whose declared framework does not yet have a dedicated
 *     adapter (MRAID, SafeFrame) — the HTML adapter is the fallback
 *     baseline until 0.7.3 ships framework-specific subclasses.
 *
 * Coexistence with the SHARC handshake (§ 8.2):
 *   - The adapter attaches in `load()` regardless of `requireSharcInit`.
 *   - When a SHARC-aware creative handshakes, the handshake-driven
 *     `LOADING → READY → ACTIVE` transition runs first; the adapter observes
 *     the resulting `ACTIVE` state and yields to it (the initial
 *     `LOADING → ACTIVE` transition is gated on the current state actually
 *     being `LOADING`).
 *   - Subsequent visibility / bfcache / freeze transitions still fire from
 *     the adapter — those layer on top of the existing
 *     `_attachPageLifecycleListeners()` chain without conflict.
 *
 * Test surface limits (§ 8.4):
 *   - jsdom does NOT model bfcache itself; `pagehide` / `pageshow` events
 *     with `persisted: true` can be dispatched programmatically, so the
 *     adapter's wire is testable as event-dispatch even though the bfcache
 *     restoration roundtrip is Chrome-only end-to-end.
 *   - jsdom does NOT ship an IntersectionObserver implementation. Tests
 *     stub `global.IntersectionObserver` with a manually-triggerable mock.
 *
 * @version 0.7.13
 */

'use strict';

import { BaseLifecycleAdapter } from './base-adapter.js';
import { ContainerStates } from '../sharc-protocol.js';

/**
 * Intersection ratio threshold for the ACTIVE / PASSIVE / HIDDEN
 * classification (§ 8.3). 0.5 mirrors common viewability conventions and
 * aligns with the MRAID `viewable` definition.
 * @type {number}
 */
const INTERSECTION_THRESHOLD = 0.5;

/**
 * IntersectionObserver threshold list. Widened (Slice C, EV-2) from the former
 * 3-valued `[0, 0.5, 1]` to a continuous 0.0–1.0 set at 0.05 steps so the raw
 * ratio surfaced to the effective-visibility composer is continuous rather than
 * snapping to three values. INTERSECTION_THRESHOLD (0.5) is retained in the set
 * as the `viewableChange` boolean crossing (EV-7).
 * @type {number[]}
 */
// `i / 20` (not `i * 0.05`): division by the integer step count yields exact
// binary floats where representable and the closest double otherwise, avoiding
// `i * 0.05` accumulation artifacts (e.g. 3 * 0.05 === 0.15000000000000002).
const INTERSECTION_THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/**
 * HTML lifecycle adapter — observes browser-native lifecycle signals and
 * drives SHARC state transitions for non-handshake creatives.
 *
 * Event-to-state mapping (§ 8.3):
 *
 * | Signal                                       | Transition          |
 * |----------------------------------------------|---------------------|
 * | iframe `load` AND intersection ≥ 0.5         | `LOADING → ACTIVE`  |
 * | intersection ≥ 0.5 while in `LOADING` after  | `LOADING → ACTIVE`  |
 * |   iframe-load                                |                     |
 * | intersection ratio 0 in `ACTIVE` / `PASSIVE` | `* → HIDDEN`        |
 * | partial intersection (0 < r < 0.5) in        | `ACTIVE → PASSIVE`  |
 * |   `ACTIVE`                                   |                     |
 * | intersection ≥ 0.5 in `PASSIVE` / `HIDDEN`   | `* → ACTIVE`        |
 * | `pagehide` (persisted: true)                 | `* → FROZEN`        |
 * | `pageshow` (persisted: true)                 | `FROZEN → ACTIVE` / |
 * |                                              |   `FROZEN → PASSIVE`|
 * | `freeze`                                     | `* → FROZEN`        |
 * | `resume`                                     | `FROZEN → ACTIVE` / |
 * |                                              |   `FROZEN → PASSIVE`|
 *
 * Non-goals: the adapter does NOT observe `RESIZED` — there is no clean
 * browser-native signal for "renderable area changed" without coordination
 * with the container's placement-change machinery. Deferred to the MRAID
 * adapter (0.7.3) which can anchor against `mraid.size` semantics.
 *
 * @example
 * // Container wires the adapter in load():
 * this._lifecycleAdapter = SHARCContainer._selectLifecycleAdapter(this._apiFramework);
 * this._lifecycleAdapter.attach(this);
 * // ... and detaches in _terminate():
 * this._lifecycleAdapter.detach();
 */
class HtmlAdapter extends BaseLifecycleAdapter {
  constructor() {
    super();

    /**
     * `true` once the iframe `load` event has fired. One half of the
     * gate that promotes `LOADING → ACTIVE`.
     * @type {boolean}
     * @private
     */
    this._iframeLoaded = false;

    /**
     * Last observed intersection ratio (`0.0`–`1.0`). `null` until the
     * IntersectionObserver has fired at least once. Other half of the
     * `LOADING → ACTIVE` gate (paired with `_iframeLoaded`).
     * @type {?number}
     * @private
     */
    this._intersectionRatio = null;

    /**
     * Last observed `isIntersecting` flag from the IntersectionObserver.
     * Tracked separately from {@link _intersectionRatio} so the "0% but
     * still intersecting" edge case is unambiguous (browsers can report
     * `isIntersecting: true` with ratio 0 in narrow geometry edge cases).
     * @type {boolean}
     * @private
     */
    this._isIntersecting = false;

    /**
     * The IntersectionObserver instance, or `null` when detached / not
     * yet attached. Constructed in `attach()` once the container's
     * `_iframe` is available.
     * @type {?IntersectionObserver}
     * @private
     */
    this._intersectionObserver = null;

    /**
     * `true` once `_maybeAdvanceToActive` has fired the `LOADING → ACTIVE`
     * transition (or observed it firing from the handshake path). Prevents
     * the adapter from re-issuing the initial transition if both iframe-
     * load and intersection-visible fire after coalescing.
     * @type {boolean}
     * @private
     */
    this._initialTransitionFired = false;

    /** @type {?(event: Event) => void} @private */
    this._iframeLoadHandler = null;
    /** @type {?(event: PageTransitionEvent) => void} @private */
    this._pagehideHandler = null;
    /** @type {?(event: PageTransitionEvent) => void} @private */
    this._pageshowHandler = null;
    /** @type {?(event: Event) => void} @private */
    this._freezeHandler = null;
    /** @type {?(event: Event) => void} @private */
    this._resumeHandler = null;

    /**
     * R3 §3.1 (INV-R3) — restore re-settle pending across a visibility flip.
     * Armed when a restore (`pageshow`/`resume`) resolves while the document is
     * still transiently hidden, so the FROZEN-exit under-resolved to HIDDEN. The
     * next `visibilitychange → visible` consumes it and re-runs
     * `_resolveRestoreDestination`, completing the HIDDEN → PASSIVE → ACTIVE
     * promotion the retained IntersectionObserver ratio supports.
     * @type {boolean}
     * @private
     */
    this._restorePending = false;
    /** @type {?(event: Event) => void} @private */
    this._restoreVisibilityHandler = null;
  }

  /**
   * Attaches the adapter to the container. Registers:
   *   - An iframe `load` listener (one-shot — gate flips on first load).
   *   - An IntersectionObserver on the iframe element with a single
   *     threshold at {@link INTERSECTION_THRESHOLD}.
   *   - Window `pagehide` / `pageshow` listeners (bfcache signals).
   *   - Document `freeze` / `resume` listeners (broadens the existing
   *     handler chain which only covers `HIDDEN → FROZEN`).
   *
   * After registration, schedules a microtask that may fire the initial
   * `LOADING → ACTIVE` transition synchronously if both signals are already
   * available (e.g. iframe was cached, intersection observer fired
   * immediately). Subsequent transitions fire on event arrival.
   *
   * @param {Object} container - The {@link SHARCContainer} instance. MUST
   *   have `_iframe` already populated (attach is called from `load()`
   *   AFTER `_createIframe()`).
   */
  attach(container) {
    super.attach(container);

    const iframe = container._iframe;
    if (!iframe) {
      // Defensive — container's load() flow always populates _iframe
      // before adapter.attach(). If this ever fires, container code path
      // re-ordered without updating the adapter; surface loudly.
      throw new Error(
        '[SHARCLifecycleAdapter] attach() called before container._iframe '
        + 'was populated — adapter must attach after _createIframe().'
      );
    }

    // Iframe load — re-fires on every load event. The Markup variant
    // produces two load events: (1) the renderer-doc load, and (2) the
    // `document.write(creativeHtml)` load when the creative content is
    // injected. The Markup gate in `_maybeAdvanceToActive`
    // (`creativeRendered === true`) ensures we only advance after the
    // second load. The URL variant has one load event; `_maybeAdvanceToActive`'s
    // `_initialTransitionFired` latch prevents double-firing. Subsequent
    // unauthorized loads are handled by the container's separate
    // renderer-backstop chain (G2) — adapter is observability-only.
    this._iframeLoadHandler = () => {
      this._iframeLoaded = true;
      this._maybeAdvanceToActive();
    };
    iframe.addEventListener('load', this._iframeLoadHandler, false);

    // IntersectionObserver — environment-provided. jsdom tests stub
    // `global.IntersectionObserver` with a manually-triggerable mock.
    // Guarded: if no IntersectionObserver is available (very old runtime),
    // skip wiring; the adapter still functions for handshake-completed
    // creatives (which advance independently) and degrades gracefully —
    // initial transition will fire on iframe-load alone via the coalesce
    // microtask.
    if (typeof IntersectionObserver === 'function') {
      this._intersectionObserver = new IntersectionObserver(
        (entries) => this._onIntersectionChange(entries),
        { threshold: INTERSECTION_THRESHOLDS },
      );
      this._intersectionObserver.observe(iframe);
    }

    // bfcache wires — `pagehide` / `pageshow` with `persisted: true`.
    // Distinct from `freeze` / `resume` which the container's existing
    // listener chain partially covers (HIDDEN → FROZEN only).
    this._pagehideHandler = (event) => this._onPagehide(event);
    this._pageshowHandler = (event) => this._onPageshow(event);
    window.addEventListener('pagehide', this._pagehideHandler, false);
    window.addEventListener('pageshow', this._pageshowHandler, false);

    // Freeze / resume — broaden the existing container handler chain
    // (`_attachPageLifecycleListeners` covers only HIDDEN → FROZEN per
    // its sync semantics). The adapter widens to `* → FROZEN` per § 8.3
    // so a creative that freezes from PASSIVE / ACTIVE also reaches FROZEN.
    this._freezeHandler = () => this._onFreeze();
    this._resumeHandler = () => this._onResume();
    document.addEventListener('freeze', this._freezeHandler, false);
    document.addEventListener('resume', this._resumeHandler, false);

    // Microtask coalesce — § 8.3 last paragraph. After attach returns
    // synchronously, the next microtask checks whether both gate
    // conditions are already met (iframe cached + initial intersection
    // already fired) and fires at most one transition.
    queueMicrotask(() => {
      if (this._container === null) return; // detached during the microtask gap
      this._maybeAdvanceToActive();
    });
  }

  /**
   * Detaches the adapter — disconnects the IntersectionObserver,
   * removes all event listeners, and clears handler references. Safe to
   * call when not attached (no-op).
   */
  detach() {
    if (this._container === null) {
      // No-op — adapter was never attached, or detach was already called.
      super.detach();
      return;
    }

    const iframe = this._container._iframe;
    if (iframe && this._iframeLoadHandler) {
      try {
        iframe.removeEventListener('load', this._iframeLoadHandler, false);
      } catch (_) { /* ignore — iframe may already be detached from DOM */ }
    }
    this._iframeLoadHandler = null;

    if (this._intersectionObserver) {
      try { this._intersectionObserver.disconnect(); } catch (_) { /* ignore */ }
      this._intersectionObserver = null;
    }

    if (this._pagehideHandler) {
      window.removeEventListener('pagehide', this._pagehideHandler, false);
      this._pagehideHandler = null;
    }
    if (this._pageshowHandler) {
      window.removeEventListener('pageshow', this._pageshowHandler, false);
      this._pageshowHandler = null;
    }
    if (this._freezeHandler) {
      document.removeEventListener('freeze', this._freezeHandler, false);
      this._freezeHandler = null;
    }
    if (this._resumeHandler) {
      document.removeEventListener('resume', this._resumeHandler, false);
      this._resumeHandler = null;
    }

    this._disarmRestoreVisibilityWatch();

    super.detach();
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  /**
   * IntersectionObserver callback. Tracks the most recent ratio +
   * `isIntersecting` flag and drives the visibility transitions per § 8.3.
   * `@protected` (G6): AppLifecycleAdapter overrides to re-apply the host
   * ceiling after the page-derived transition.
   * @param {IntersectionObserverEntry[]} entries
   * @protected
   */
  _onIntersectionChange(entries) {
    if (this._container === null) return;
    if (!entries || entries.length === 0) return;

    // Latest entry wins — observe() is called with a single target so
    // multi-entry batches collapse to the most recent state.
    const entry = entries[entries.length - 1];
    this._intersectionRatio = typeof entry.intersectionRatio === 'number'
      ? entry.intersectionRatio
      : 0;
    this._isIntersecting = !!entry.isIntersecting;

    // Slice C — surface the raw (un-thresholded) ratio to the container's
    // effective-visibility composer alongside the existing setState path below.
    if (typeof this._container._onRawIntersection === 'function') {
      this._container._onRawIntersection(this._intersectionRatio);
    }

    const state = this._container.getState();

    if (state === ContainerStates.LOADING) {
      // Initial-transition gate — paired with iframe-load.
      this._maybeAdvanceToActive();
      return;
    }

    // Post-LOADING visibility classification per § 8.3.
    if (!this._isIntersecting || this._intersectionRatio === 0) {
      // Fully off-screen — drive to HIDDEN if we're somewhere visible.
      if (state === ContainerStates.ACTIVE || state === ContainerStates.PASSIVE) {
        this._container.setState(ContainerStates.HIDDEN);
      }
      return;
    }

    if (this._intersectionRatio >= INTERSECTION_THRESHOLD) {
      // Sufficiently visible — promote to ACTIVE from PASSIVE / HIDDEN.
      // § 8.3 row 5: "Gated on parent document also being visible."
      // (Browsers usually suspend IO callbacks while the document is
      // hidden, but the spec doesn't guarantee it — synthetic events
      // can still trigger this branch. Matches `_transitionFromFrozen`'s
      // visibility check at line ~509.)
      const docVisible = typeof document !== 'undefined'
        && document.visibilityState === 'visible';
      if (!docVisible) return;

      if (state === ContainerStates.PASSIVE || state === ContainerStates.HIDDEN) {
        // HIDDEN → ACTIVE is not a direct edge in STATE_TRANSITIONS
        // (HIDDEN → PASSIVE → ACTIVE is the canonical path). Step through
        // PASSIVE so the state machine accepts the transition.
        if (state === ContainerStates.HIDDEN) {
          this._promoteContainerState(ContainerStates.PASSIVE);
        }
        this._promoteContainerState(ContainerStates.ACTIVE);
      }
      return;
    }

    // Partial (0 < ratio < 0.5) — demote ACTIVE to PASSIVE.
    if (state === ContainerStates.ACTIVE) {
      this._container.setState(ContainerStates.PASSIVE);
    }
  }

  /**
   * Fires the initial `LOADING → ACTIVE` transition when both gates are
   * met: iframe-load has fired AND intersection ratio ≥ threshold. Also
   * accommodates the case where IntersectionObserver is unavailable
   * (environment fallback): a fired iframe-load alone advances after
   * the coalesce microtask.
   *
   * Skipped when:
   *   - The container is no longer in `LOADING` (handshake-driven path
   *     already advanced it, or `close()` raced and put it in
   *     `TERMINATED`).
   *   - The initial transition has already fired.
   *   - Strict mode (`requireSharcInit: true`) — the handshake-driven
   *     path owns the initial transition; adapter yields per § 8.2.
   *   - Markup variant with `creativeRendered === false` — iframe
   *     `load` fired on the renderer document, not the creative.
   *
   * Overrides `BaseLifecycleAdapter._maybeAdvanceToActive` (base no-op).
   * Container may call this to invite a gate re-evaluation when a
   * container-side signal changed (e.g., `_onRendererRendered` flipping
   * `creativeRendered = true`).
   * @protected
   */
  _maybeAdvanceToActive() {
    if (this._container === null) return;
    if (this._initialTransitionFired) return;

    const state = this._container.getState();

    if (state !== ContainerStates.LOADING) {
      // Handshake-driven path advanced the container before our gates
      // closed. § 8.2: yield silently — record that we've observed the
      // transition so we don't double-fire if a late intersection event
      // arrives.
      this._initialTransitionFired = true;
      return;
    }

    // ── Race-avoidance: yield to the handshake-driven path in strict mode ──
    // The adapter exists for non-handshake creatives. In strict mode
    // (`requireSharcInit: true`, the default), the container expects a
    // SHARC handshake; the `createSession` timeout fatal-errors at 5s if
    // none arrives. If the adapter races ahead and fires `LOADING →
    // ACTIVE` synchronously before the handshake's `setState(READY)`
    // bootstrap (~200ms after iframe-load via `initChannel`), the
    // handshake's `READY` and `ACTIVE` transitions are rejected by the
    // state machine ("Invalid transition: 'active' → 'ready'") and
    // operators never see `onStateChange(READY)`. Gate on permissive
    // mode so the adapter's initial-transition path only fires when the
    // operator has explicitly opted out of expecting a handshake. The
    // adapter's other transitions (visibility, freeze, bfcache) still
    // fire in both modes — they're observability augmentation that
    // doesn't conflict with the handshake-driven `LOADING → READY →
    // ACTIVE` path.
    if (this._container._requireSharcInit === true) return;

    // ── Markup-variant gate: wait for the renderer protocol to complete ──
    // For the Markup variant, the iframe `load` event fires when the
    // renderer document loads — BEFORE `document.write(creativeHtml)`
    // writes the actual creative content. Advancing to ACTIVE on
    // renderer-load is premature: operators using `onStateChange(ACTIVE)`
    // for impression/viewability timing would start measurement before
    // the creative is visible. Wait for `creativeRendered === true`
    // (set in `_onRendererRendered` after `:rendered` envelope
    // validation). URL variant unaffected — its iframe `load` IS the
    // creative document loading.
    if (this._container.creativeSource === 'html'
        && !this._container.creativeRendered) {
      return;
    }

    // Both gates required when IntersectionObserver is available.
    if (this._intersectionObserver) {
      if (!this._iframeLoaded) return;
      if (this._intersectionRatio === null) return;
      if (!this._isIntersecting) return;
      if (this._intersectionRatio < INTERSECTION_THRESHOLD) return;
    } else {
      // Degraded mode — no IntersectionObserver, advance on iframe-load
      // alone. Matches the "polyfill-able with explicit triggering"
      // contract in § 8.4: environments without IO get a less precise
      // signal but the adapter still functions.
      if (!this._iframeLoaded) return;
    }

    this._initialTransitionFired = true;
    this._promoteContainerState(ContainerStates.ACTIVE);
  }

  /**
   * Single chokepoint for the adapter's page-derived PROMOTIONS (G6 #433,
   * Fix 2). Base implementation is a pass-through `setState` — web behavior
   * is unchanged. `AppLifecycleAdapter` overrides it to pre-clamp the
   * destination at the latched host ceiling BEFORE any transition fires
   * (design § 4.3 most-severe rule), so an above-ceiling state never appears
   * even transiently in the fan-out. Demotions and the FROZEN edge-walking
   * in {@link _transitionToFrozen} deliberately do NOT route through here —
   * they move toward (or already sit at) maximum severity.
   * @param {string} state - Promotion destination (a ContainerStates value).
   * @protected
   */
  _promoteContainerState(state) {
    this._container.setState(state);
  }

  /**
   * `pagehide` handler. § 8.3 — when `persisted: true`, the page is
   * entering bfcache; drive to FROZEN from any pre-TERMINATED state.
   * `@protected` (G6 #433): AppLifecycleAdapter overrides to latch the
   * page-axis freeze (`_pageFroze`) — per-axis freeze tracking.
   * @param {PageTransitionEvent} event
   * @protected
   */
  _onPagehide(event) {
    if (this._container === null) return;
    if (!event || !event.persisted) return;
    this._transitionToFrozen();
  }

  /**
   * `pageshow` handler. § 8.3 — when `persisted: true`, the page is
   * restoring from bfcache; advance from FROZEN per current visibility.
   *
   * Real-bfcache restoration in jsdom is not modeled — only the event
   * dispatch is. Chrome-only end-to-end (Puppeteer follow-up per § 8.4).
   * `@protected` (G6 #433): AppLifecycleAdapter overrides to release the
   * page-axis freeze latch — per-axis freeze tracking.
   * @param {PageTransitionEvent} event
   * @protected
   */
  _onPageshow(event) {
    if (this._container === null) return;
    if (!event || !event.persisted) return;

    // R3 §3.3 (INV-R8..R11), detection D-a (RATIFIED): a `pageshow` with
    // `persisted:true` is the authoritative "the MessageChannel was discarded
    // by bfcache" signal — relink FIRST so the port is live before any send.
    // INV-R8: never emit a FROZEN-exit `stateChange` into the known-dead port,
    // so the relink precedes the `_transitionFromFrozen` below. The relink
    // re-runs the existing `initChannel` bootstrap (transport-only: same
    // placementSessionId / sessionId, same session gate, NO new message type,
    // NO router re-mint — the OMID iframe shim survives bfcache, confirmed by
    // the build-phase Chrome probe), then delivers the current state over the
    // new live port. OS-freeze `resume` does NOT come through here, so the
    // port-survived case never relinks. Failure to relink is handled cleanly
    // inside `_relinkCreativeChannel` (INV-R12).
    this._container._relinkCreativeChannel();

    // R3 §3.1 (INV-R1/R2/R3): adapter owns the FROZEN-exit; resolve the
    // destination from the IntersectionObserver ratio. Its `setState` send now
    // rides the relinked live port. `pageshow{persisted}` can fire while
    // visibility is transiently hidden — when it does, `_resolveRestoreDestination`
    // under-resolves to HIDDEN and ARMS a one-shot visibility watch so the next
    // `visibilitychange → visible` completes the promotion to ACTIVE (audit I-1).
    this._resolveRestoreDestination();

    // R3 §3.2 (INV-R4/R5): re-assert the current visibility level (publisher-
    // page / OMID reach) — independent of the relink outcome.
    this._container._reassertCurrentStateAfterRestore();
  }

  /**
   * `freeze` handler. § 8.3 — broadens the container's existing
   * `_onFreeze` (which only fires HIDDEN → FROZEN) to `* → FROZEN`.
   * `@protected` (G6 #433): AppLifecycleAdapter overrides to latch the
   * page-axis freeze (`_pageFroze`) — per-axis freeze tracking.
   * @protected
   */
  _onFreeze() {
    if (this._container === null) return;
    this._transitionToFrozen();
  }

  /**
   * `resume` handler. § 8.3 says "adapter does not duplicate" the
   * container's existing `_onResume` FROZEN → ACTIVE/PASSIVE/HIDDEN
   * resolution — but the existing handler resolves to PASSIVE whenever
   * `document.hasFocus()` is false (no way to be more precise without
   * intersection signal). The adapter LAYERS intersection-driven
   * promotion on top: if the container resolved to PASSIVE because
   * focus is unknown but the iframe is fully visible per
   * IntersectionObserver, promote to ACTIVE. This is the "adapter
   * contributes browser signals the container chain lacks" pattern
   * from § 8.2 — not a duplicate, an augmentation.
   *
   * Future framework-specific subclasses (MraidAdapter, SafeFrameAdapter
   * in 0.7.3) will override `_onResume` to layer framework signals
   * (e.g. `mraid.viewableChange`) on top of this intersection-driven
   * promotion. `@protected` (G6 #433): AppLifecycleAdapter overrides to
   * release the page-axis freeze latch — per-axis freeze tracking.
   * @protected
   */
  _onResume() {
    if (this._container === null) return;
    // R3 §3.1 (INV-R1/R2/R3): the adapter is the single restore authority when
    // attached — the container's own `_onResume` now yields to it (it checks
    // `this._lifecycleAdapter` and returns). So on a `resume` (OS-freeze; the
    // MessagePort survives — no relink), the adapter owns the FROZEN-exit and
    // resolves the destination from the IntersectionObserver ratio, exactly as
    // it does for `pageshow`. This replaces the old "augment the container's
    // PASSIVE under-resolution" behavior with authoritative resolution, so a
    // visible-but-unfocused page resolves straight to ACTIVE (no PASSIVE
    // flicker) and there is exactly one FROZEN-exit transition. If visibility is
    // still transiently hidden, `_resolveRestoreDestination` arms the one-shot
    // watch so the next `visibilitychange → visible` finishes the promotion
    // (audit I-1).
    this._resolveRestoreDestination();
    // R3 §3.2 (INV-R4/R5): re-assert the current visibility level after the
    // restore resolves, even when no fresh edge fired.
    this._container._reassertCurrentStateAfterRestore();
  }

  /**
   * Adapter-mediated HIDDEN → PASSIVE promotion for the container's
   * `visibilitychange → visible` branch (G6 #433, Fix 3a). The container
   * yields the promotion to the attached adapter (mirroring the `_onResume`
   * single-authority yield) so the app adapter can pre-clamp it at the
   * latched host ceiling; this base implementation preserves the exact web
   * behavior — the same single HIDDEN → PASSIVE edge the container fired
   * directly before, routed through the promotion chokepoint.
   * @protected
   */
  _onParentVisibilityRestored() {
    if (this._container === null) return;
    if (this._container.getState() !== ContainerStates.HIDDEN) return;
    this._promoteContainerState(ContainerStates.PASSIVE);
  }

  // -------------------------------------------------------------------------
  // Transition helpers
  // -------------------------------------------------------------------------

  /**
   * Drives the container to FROZEN from any pre-TERMINATED state.
   * ACTIVE / PASSIVE / HIDDEN each have a direct `→ FROZEN` edge in
   * `STATE_TRANSITIONS` (#340), so a freeze from a visible state goes
   * straight to FROZEN without fabricating an intervening HIDDEN the
   * creative never experienced. READY steps through ACTIVE first (no
   * direct `READY → FROZEN` edge); permissive LOADING promotes to ACTIVE
   * first per § 4.5. `@protected` (G6): AppLifecycleAdapter drives this from
   * the host-lifecycle INPUT (`'frozen'`) — the design reuses these existing
   * transition helpers rather than duplicating the edge-walking.
   * @protected
   */
  _transitionToFrozen() {
    const state = this._container.getState();

    if (state === ContainerStates.FROZEN || state === ContainerStates.TERMINATED) {
      return; // already there / done
    }

    // ── Race-avoidance: yield to handshake in strict + LOADING ─────────
    // In strict mode (`requireSharcInit: true`), the handshake is the
    // canonical driver of state. If the adapter walks LOADING → ACTIVE
    // → FROZEN on a freeze/pagehide event while a handshake
    // is in-flight, the subsequent `_handleInitResolved` →
    // `setState(READY)` becomes invalid (`'frozen' → 'ready'`) and the
    // handshake-driven lifecycle is permanently broken.
    //
    // For strict-mode LOADING, no-op on freeze/pagehide. The browser's
    // bfcache freezes the iframe implicitly; when the page is restored,
    // the container is still in LOADING and the handshake can proceed
    // normally. Operators don't get an `onStateChange(FROZEN)` callback
    // in this narrow window, which is consistent with the broader
    // principle: in strict mode with no handshake yet, there is no
    // SHARC session and no SHARC state lifecycle to report.
    if (state === ContainerStates.LOADING
        && this._container._requireSharcInit === true) {
      return;
    }

    if (state === ContainerStates.LOADING) {
      // Permissive-mode LOADING — operator opted out of expecting a
      // handshake, so the adapter owns the lifecycle. Promote to
      // ACTIVE first (new 0.7.2 edge from § 4.5), then take the
      // direct ACTIVE → FROZEN edge (#340).
      this._initialTransitionFired = true;
      this._container.setState(ContainerStates.ACTIVE);
    }

    if (this._container.getState() === ContainerStates.READY) {
      this._container.setState(ContainerStates.ACTIVE);
    }

    // ACTIVE / PASSIVE / HIDDEN → FROZEN are all direct edges (#340). A
    // freeze from ACTIVE or PASSIVE goes straight to FROZEN — no phantom
    // HIDDEN. A creative that was already HIDDEN (genuine offscreen) uses
    // its own retained HIDDEN → FROZEN edge.
    const current = this._container.getState();
    if (current === ContainerStates.ACTIVE
        || current === ContainerStates.PASSIVE
        || current === ContainerStates.HIDDEN) {
      this._container.setState(ContainerStates.FROZEN);
    }
  }

  /**
   * Drives the container from FROZEN to ACTIVE or PASSIVE per current
   * visibility. No-op when not in FROZEN.
   * @private
   */
  _transitionFromFrozen() {
    const state = this._container.getState();
    if (state !== ContainerStates.FROZEN) return;

    // Restore via the canonical FROZEN → ACTIVE / PASSIVE / HIDDEN edges
    // already in STATE_TRANSITIONS. Pick destination based on visibility:
    //   - intersection ≥ 0.5 and document visible → ACTIVE
    //   - intersection > 0 but < 0.5 and document visible → PASSIVE
    //   - otherwise → HIDDEN
    const docVisible = typeof document !== 'undefined'
      && document.visibilityState === 'visible';
    const ratio = this._intersectionRatio;

    if (docVisible && ratio !== null
        && this._isIntersecting && ratio >= INTERSECTION_THRESHOLD) {
      this._promoteContainerState(ContainerStates.ACTIVE);
    } else if (docVisible && ratio !== null
        && this._isIntersecting && ratio > 0) {
      this._promoteContainerState(ContainerStates.PASSIVE);
    } else {
      this._container.setState(ContainerStates.HIDDEN);
    }
  }

  /**
   * R3 §3.1 (INV-R3) — restore re-settle to the correct level.
   *
   * As the single restore authority, the adapter must land the container at
   * the destination its RETAINED IntersectionObserver signal supports —
   * ACTIVE when fully visible. A `pageshow{persisted}` (or `resume`) can fire
   * while `document.visibilityState` is transiently still `'hidden'` (the
   * bfcache restore has not flipped visibility yet), so the initial
   * `_transitionFromFrozen` under-resolves to HIDDEN. When that happens this
   * helper CANNOT promote yet (the document is hidden); instead it ARMS a
   * one-shot restore-pending watch (see {@link _armRestoreVisibilityWatch}) so
   * the next `visibilitychange → visible` re-runs the resolution. Without that
   * watch the container's own `_onVisibilityChange` would drive only
   * HIDDEN → PASSIVE and stop, leaving the ad stuck at PASSIVE (OMID
   * `notVisible`) — the exact #338 symptom (audit I-1, empirically confirmed).
   *
   * When the document IS visible, it re-resolves from whatever post-freeze
   * state the container holds (FROZEN / HIDDEN / PASSIVE) using the retained
   * ratio, mirroring `_onIntersectionChange`'s HIDDEN/PASSIVE → ACTIVE
   * promotion (stepping through PASSIVE so the state machine accepts the edge —
   * no phantom FROZEN-exit, INV-R6; the FROZEN-exit already happened at
   * `pageshow` time). It does NOT down-level a visible ad. Idempotent when
   * already at the correct level.
   *
   * `@protected` (G6): AppLifecycleAdapter both overrides this (a page
   * restore must not exit a HOST-asserted freeze) and reuses it for the
   * host-driven FROZEN-exit.
   * @protected
   */
  _resolveRestoreDestination() {
    if (this._container === null) return;
    const state = this._container.getState();

    // From FROZEN, take the canonical FROZEN-exit resolution first.
    if (state === ContainerStates.FROZEN) {
      this._transitionFromFrozen();
    }

    const docVisible = typeof document !== 'undefined'
      && document.visibilityState === 'visible';
    const ratio = this._intersectionRatio;

    // Transient-hidden restore: the retained ratio would support ACTIVE, but
    // the document is still hidden so we cannot promote yet. Arm the watch so
    // the next visibility flip completes the re-settle. (INV-R3, audit I-1)
    if (!docVisible) {
      if (ratio !== null && this._isIntersecting && ratio >= INTERSECTION_THRESHOLD) {
        this._armRestoreVisibilityWatch();
      }
      return;
    }

    if (ratio === null || !this._isIntersecting) return;
    if (ratio < INTERSECTION_THRESHOLD) return;

    // Fully visible — ensure the container reaches ACTIVE from a post-restore
    // PASSIVE/HIDDEN that an under-resolution or a visibilitychange left it at.
    const post = this._container.getState();
    if (post === ContainerStates.HIDDEN) {
      this._promoteContainerState(ContainerStates.PASSIVE);
    }
    if (this._container.getState() === ContainerStates.PASSIVE) {
      this._promoteContainerState(ContainerStates.ACTIVE);
    }
  }

  /**
   * R3 §3.1 (INV-R3) — one-shot visibility watch for a transient-hidden
   * restore. When a restore under-resolves to HIDDEN because the document is
   * still hidden, the adapter must complete the re-settle once visibility
   * flips. It listens for the NEXT `visibilitychange`; on the first
   * `'visible'` it disarms, re-runs `_resolveRestoreDestination` (now that
   * `document.visibilityState === 'visible'`, this promotes the container the
   * retained ratio supports), then re-asserts the §3.2 level so a consumer
   * (OMID) that lost the level across the freeze re-receives `visible`.
   *
   * Re-arming is idempotent — a second arm while already pending keeps the
   * single registered listener. The listener is one-shot per restore (it
   * removes itself on the visible flip) and is also torn down in
   * {@link detach}. The container's own `_onVisibilityChange` still drives the
   * real HIDDEN → PASSIVE edge; this watch only contributes the
   * PASSIVE → ACTIVE promotion the container chain cannot resolve (it has no
   * intersection signal), preserving single authority.
   * @private
   */
  _armRestoreVisibilityWatch() {
    this._restorePending = true;
    if (this._restoreVisibilityHandler) return;
    if (typeof document === 'undefined') return;
    this._restoreVisibilityHandler = () => {
      if (this._container === null) return;
      if (document.visibilityState !== 'visible') return;
      this._disarmRestoreVisibilityWatch();
      this._resolveRestoreDestination();
      this._container._reassertCurrentStateAfterRestore();
    };
    document.addEventListener(
      'visibilitychange', this._restoreVisibilityHandler, false,
    );
  }

  /**
   * Disarms the transient-hidden restore watch and removes its listener.
   * Safe to call when not armed.
   * @private
   */
  _disarmRestoreVisibilityWatch() {
    this._restorePending = false;
    if (this._restoreVisibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange', this._restoreVisibilityHandler, false,
      );
    }
    this._restoreVisibilityHandler = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HtmlAdapter, INTERSECTION_THRESHOLD };
}

export { HtmlAdapter, INTERSECTION_THRESHOLD };
