/**
 * @fileoverview SHARC App Lifecycle Adapter (G6 — in-app / WebView)
 *
 * In-app lifecycle adapter for the WKWebView / Android WebView embed
 * (G6 design Decision 4). Extends {@link HtmlAdapter} — it LAYERS the
 * host-asserted lifecycle axis (the L1 `setHostLifecycle` INPUT, delivered
 * via the `_onHostLifecycle` hook) on top of the browser-native signals,
 * exactly the "framework-specific signals on top" subclass shape the adapter
 * family header promised. It does not replace them: in-app the host page is
 * 1:1 with the WebView, so the in-page signals read ~always-visible and
 * remain a defensive floor, not the authority.
 *
 * Two-axis precedence rule (design § 4.3, the design core):
 *
 *   SHARC state = most-severe( host-asserted state, page-derived state )
 *   on `active < passive < hidden < frozen`.
 *
 * The adapter never lets the page's own (in-app: mostly blind) signals
 * out-promote the host's assertion, and vice versa. In-app the host INPUT is
 * the ONLY source of FROZEN — WebKit does not fire the WICG freeze/resume
 * events, and inside a WebView there is no browser chrome to fire them.
 *
 * Selection is operator-declared via the container's `hostContext: 'app'`
 * option (the embedder KNOWS it is inside a WebView; sniffing lies — same
 * posture as the OMID bridge's `serviceMode`). The web default stays
 * {@link HtmlAdapter}: stock web embeds are byte-identical (NHI C1/C3).
 *
 * @version 0.7.13
 */

'use strict';

import { HtmlAdapter } from './html-adapter.js';
import { ContainerStates } from '../sharc-protocol.js';

/**
 * Severity order for the most-severe rule (design § 4.3). Shared vocabulary
 * between the host-lifecycle enum and the visibility-axis container states
 * (ContainerStates values are the same lowercase strings). LOADING / READY /
 * TERMINATED are outside the visibility axis and never participate.
 * @type {Object<string, number>}
 */
const LIFECYCLE_SEVERITY = Object.freeze({
  active: 0,
  passive: 1,
  hidden: 2,
  frozen: 3,
});

/**
 * App lifecycle adapter — consumes the L1 host-lifecycle INPUT and applies
 * the most-severe rule over the HtmlAdapter's page-derived transitions.
 *
 * Host-enum handling (design § 4.2 mapping, § 4.4 rulings):
 *   - `'frozen'` (M4) → `_transitionToFrozen()` (existing direct edges).
 *   - `'active' | 'passive' | 'hidden'` while host-frozen (M5) → FROZEN-exit
 *     via the existing `_resolveRestoreDestination` machinery (page-derived
 *     destination), then capped at the host ceiling.
 *   - Otherwise → demote-only cap at the host ceiling (host can never
 *     out-promote the page axis; most-severe wins).
 *
 * Page-derived promotions (`_onIntersectionChange`, `_maybeAdvanceToActive`,
 * restore resolution) re-apply the cap after the super handler runs, so the
 * page axis can never out-promote the host's assertion either.
 */
class AppLifecycleAdapter extends HtmlAdapter {
  constructor() {
    super();

    /**
     * `true` while the current FROZEN state was asserted by the HOST axis
     * (`_onHostLifecycle('frozen')`). A host non-frozen assertion exits
     * FROZEN only when the host axis put it there — a page-asserted freeze
     * (real `freeze` / `pagehide{persisted}`, which in-app never fire) keeps
     * FROZEN under most-severe until the page axis resumes.
     * @type {boolean}
     * @private
     */
    this._hostFroze = false;
  }

  /**
   * Attaches like {@link HtmlAdapter#attach}, then applies the latched host
   * value (NHI C7 replay-of-last): a value asserted before the adapter
   * attaches (preload) is retained container-side (`_hostLifecycle`) and
   * applied here.
   * @param {Object} container - The SHARCContainer instance.
   */
  attach(container) {
    super.attach(container);
    if (container._hostLifecycle) {
      this._onHostLifecycle(container._hostLifecycle);
    }
  }

  /**
   * L1 host-lifecycle INPUT consumer (overrides the base no-op). The value
   * arrives validated and deduped by `setHostLifecycle`; the container also
   * re-invites this hook with the latched value on each ACTIVE transition
   * (design § 4.5 replay) so the host ceiling is re-evaluated exactly as
   * `_syncAudioState` re-delivers.
   * @param {string} state - `'active' | 'passive' | 'hidden' | 'frozen'`.
   * @protected
   */
  _onHostLifecycle(state) {
    if (this._container === null) return;

    if (state === 'frozen') {
      this._hostFroze = true;
      this._transitionToFrozen();
      return;
    }

    if (this._container.getState() === ContainerStates.FROZEN) {
      // Host asserts a non-frozen state while FROZEN. Exit only a HOST-driven
      // freeze (most-severe: the page axis keeps its own freeze until it
      // resumes). Resolve the destination from the retained page signals via
      // the existing restore machinery, then re-assert the level (§ 3.2
      // semantics) so a consumer that lost the level re-receives it.
      if (!this._hostFroze) return;
      this._hostFroze = false;
      super._resolveRestoreDestination();
      this._container._reassertCurrentStateAfterRestore();
    }

    this._capAtHostCeiling();
  }

  /**
   * Page-derived intersection transitions, then re-apply the host ceiling —
   * the page axis must not out-promote the host's assertion (§ 4.3).
   * @param {IntersectionObserverEntry[]} entries
   * @protected
   */
  _onIntersectionChange(entries) {
    super._onIntersectionChange(entries);
    this._capAtHostCeiling();
  }

  /**
   * Initial `LOADING → ACTIVE` gate, then re-apply the host ceiling: a host
   * value asserted pre-render (preload) demotes the fresh ACTIVE immediately.
   * @protected
   */
  _maybeAdvanceToActive() {
    super._maybeAdvanceToActive();
    this._capAtHostCeiling();
  }

  /**
   * Restore resolution under most-severe: page restore signals
   * (`pageshow` / `resume` — in-app effectively never fired) cannot exit a
   * HOST-asserted freeze; when they do resolve, the destination is capped at
   * the host ceiling.
   * @protected
   */
  _resolveRestoreDestination() {
    if (this._container === null) return;
    if (this._container._hostLifecycle === 'frozen') return;
    super._resolveRestoreDestination();
    this._capAtHostCeiling();
  }

  /**
   * Demote-only enforcement of the host ceiling on the visibility axis:
   * when the latched host assertion is MORE severe than the current
   * container state, demote to it (`active` never demotes; `frozen` is owned
   * by the `_transitionToFrozen` path). ACTIVE → PASSIVE / HIDDEN and
   * PASSIVE → HIDDEN are all direct edges. States outside the visibility
   * axis (LOADING / READY / TERMINATED) are left alone — the strict-mode
   * handshake race rules own those; FROZEN (severity 3) is already at or
   * beyond any cap and falls out of the severity comparison.
   * @private
   */
  _capAtHostCeiling() {
    if (this._container === null) return;
    const host = this._container._hostLifecycle;
    if (!host || host === 'active' || host === 'frozen') return;

    const state = this._container.getState();
    const stateSeverity = LIFECYCLE_SEVERITY[state];
    if (stateSeverity === undefined) return; // outside the visibility axis
    if (LIFECYCLE_SEVERITY[host] <= stateSeverity) return;

    this._container.setState(
      host === 'passive' ? ContainerStates.PASSIVE : ContainerStates.HIDDEN
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AppLifecycleAdapter };
}

export { AppLifecycleAdapter };
