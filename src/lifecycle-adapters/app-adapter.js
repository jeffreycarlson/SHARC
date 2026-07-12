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
 * out-promote the host's assertion, and vice versa. On WKWebView the host
 * INPUT is the ONLY source of FROZEN — WebKit does not fire the WICG
 * freeze/resume events. Android WebView is Blink, where the page-axis
 * freeze events ARE real (#433 CR-F4), so FROZEN is tracked per-axis: it is
 * held by whichever axis still asserts it.
 *
 * Selection is operator-declared via the container's `hostContext: 'app'`
 * option (the embedder KNOWS it is inside a WebView; sniffing lies — same
 * posture as the OMID bridge's `serviceMode`). The web default stays
 * {@link HtmlAdapter}: stock web embeds are byte-identical (NHI C1/C3).
 *
 * @version 0.7.13
 */

'use strict';

import { HtmlAdapter, INTERSECTION_THRESHOLD } from './html-adapter.js';
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
 *     out-promote the page axis; most-severe wins), then — on a host-axis
 *     RISE (#438, ruling U7) — a recompute of the composed most-severe
 *     target with promotion through the pre-clamped chokepoint (in-app the
 *     page axis delivers no restore events, so the host rise is the only
 *     recompute trigger a foreground return produces).
 *
 * Page-derived promotions (`_onIntersectionChange`, `_maybeAdvanceToActive`,
 * restore resolution) are PRE-CLAMPED at the `_promoteContainerState`
 * chokepoint (#433 Fix 2): the destination passed to setState is already
 * `most-severe(pageDestination, hostCeiling)`, so the page axis can never
 * out-promote the host's assertion — not even transiently. The demote-only
 * `_capAtHostCeiling` remains as the reconcile for host-delivery time and
 * for any path that reaches the container outside the chokepoint.
 */
class AppLifecycleAdapter extends HtmlAdapter {
  constructor() {
    super();

    /**
     * `true` while the HOST axis asserts FROZEN (`_onHostLifecycle('frozen')`
     * latched it and no host non-frozen assertion has cleared it). One of the
     * two per-axis freeze latches (#433 CR-F4): a host non-frozen assertion
     * thaws ONLY this axis.
     * @type {boolean}
     * @private
     */
    this._hostFroze = false;

    /**
     * `true` while the PAGE axis asserts FROZEN — a real `freeze` /
     * `pagehide{persisted}` arrived and no `resume` / `pageshow{persisted}`
     * has cleared it. Android WebView is Blink, so the page-axis freeze
     * events are real in-app (#433 CR-F4). The other per-axis latch: a host
     * `'frozen'`-exit unfreezes only when this axis is not frozen, and the
     * page-axis restore machinery unfreezes only when the host axis is not
     * frozen (`_resolveRestoreDestination` override below). FROZEN severity
     * is held by WHICHEVER axis still asserts it (most-severe, § 4.3).
     * @type {boolean}
     * @private
     */
    this._pageFroze = false;

    /**
     * Last host-lifecycle value this adapter consumed, for host-axis RISE
     * detection (#438, ruling U7). Tracked adapter-side because the container
     * latches `_hostLifecycle` BEFORE inviting `_onHostLifecycle`, so the
     * previous assertion is no longer observable there. `null` until the
     * first delivery — a first assertion is never a rise (nothing was
     * host-demoted before it).
     * @type {?string}
     * @private
     */
    this._lastHostAssertion = null;
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

    const previous = this._lastHostAssertion;
    this._lastHostAssertion = state;

    if (state === 'frozen') {
      this._hostFroze = true;
      this._transitionToFrozen();
      return;
    }

    if (this._container.getState() === ContainerStates.FROZEN) {
      // Host asserts a non-frozen state while FROZEN. Thaw ONLY the host
      // axis (most-severe, #433 CR-F4): a freeze the page axis asserted —
      // before OR after the host froze — holds FROZEN until the page axis
      // resumes. When the host axis was the last one holding the freeze,
      // resolve the destination from the retained page signals via the
      // existing restore machinery, then re-assert the level (§ 3.2
      // semantics) so a consumer that lost the level re-receives it.
      if (!this._hostFroze) return;
      this._hostFroze = false;
      if (this._pageFroze) return;
      super._resolveRestoreDestination();
      this._container._reassertCurrentStateAfterRestore();
    }

    this._capAtHostCeiling();

    // #438 (ruling U7) — host-axis RISE: the new assertion is MORE permissive
    // than the previous one. The § 4.3 most-severe rule is a function of BOTH
    // axes in BOTH directions, but the cap above is demote-only and in-app
    // the page axis delivers no restore events (WKWebView fires no
    // freeze/resume, no visibility/intersection edge on a background →
    // foreground round-trip — the #438 simulator evidence), so nothing else
    // recomputes. Re-evaluate the composed target and promote. The FROZEN
    // early-returns above keep a page-held freeze authoritative; the
    // host-held FROZEN-exit already resolved via the restore machinery, for
    // which this recompute is an idempotent no-op.
    if (previous !== null
        && LIFECYCLE_SEVERITY[state] < LIFECYCLE_SEVERITY[previous]) {
      this._recomputeAfterHostRise();
    }
  }

  /**
   * Re-evaluates `most-severe(host, page)` after a host-axis rise (#438,
   * ruling U7) and promotes the container to the composed target through the
   * pre-clamped {@link _promoteContainerState} chokepoint — EMITTED-clean:
   * the destination of every fired transition is at or below the composed
   * target, never setState-then-retract.
   *
   * Page-axis contribution: derived from the RETAINED in-page signals
   * (document visibility + last IntersectionObserver ratio), mirroring
   * `_resolveRestoreDestination`'s classification. Page-axis default (the
   * in-app blindness choice, design § 4.1/§ 4.3): when the page axis has
   * never asserted — the IO ratio is still `null` (degraded / no IO event
   * yet) — it contributes `'active'`, i.e. it does not constrain and the
   * host assertion governs alone. In-app the host page is 1:1 with the
   * WebView and IO reads ~always-visible, so a non-asserting page axis is
   * the permissive axis, not an unknown to fail closed on — failing closed
   * here would re-create the #438 strand for degraded environments.
   *
   * Scope guards: only promotes ON the visibility axis — LOADING / READY /
   * TERMINATED are owned by the handshake race rules (a pre-ready container
   * must not jump to ACTIVE; the `_maybeAdvanceToActive` gates are not
   * host-sensitive, so a rise cannot unblock them), and a page-held FROZEN
   * is owned by the per-axis freeze latches.
   * @private
   */
  _recomputeAfterHostRise() {
    if (this._container === null) return;
    if (this._pageFroze) return; // page axis holds FROZEN (most-severe)

    const current = this._container.getState();
    const currentSeverity = LIFECYCLE_SEVERITY[current];
    if (currentSeverity === undefined) return; // off the visibility axis
    if (current === ContainerStates.FROZEN) return; // freeze latches own it

    const docVisible = typeof document !== 'undefined'
      && document.visibilityState === 'visible';
    const ratio = this._intersectionRatio;
    let page;
    if (!docVisible) {
      // A non-'visible' document caps the page axis at 'hidden'. Unlike
      // _resolveRestoreDestination we arm no transient-hidden watch here: the
      // in-app round-trip this recompute serves keeps visibilityState 'visible'
      // throughout (WebKit fires no visibilitychange edge on app background —
      // design §4.1), so a host rise arriving under a transient 'hidden' is not
      // reachable on the #438 path. If a future platform breaks that premise,
      // add the watch; today it would be dead code.
      page = 'hidden';
    } else if (ratio === null) {
      page = 'active'; // never-asserted page axis — host governs (see above)
    } else if (this._isIntersecting && ratio >= INTERSECTION_THRESHOLD) {
      page = 'active';
    } else if (this._isIntersecting && ratio > 0) {
      page = 'passive';
    } else {
      page = 'hidden';
    }

    const host = this._container._hostLifecycle;
    const target = LIFECYCLE_SEVERITY[host] > LIFECYCLE_SEVERITY[page]
      ? host
      : page;
    if (LIFECYCLE_SEVERITY[target] >= currentSeverity) return; // no rise due

    // HIDDEN → ACTIVE is not a direct edge — step through PASSIVE (same
    // walk as `_onIntersectionChange`). Each step is ≤ target, so nothing
    // overshoots; `_promoteContainerState` re-clamps at the host ceiling
    // (a no-op here — target is already host-bounded) and dedups.
    if (current === ContainerStates.HIDDEN) {
      this._promoteContainerState(ContainerStates.PASSIVE);
    }
    if (target === ContainerStates.ACTIVE
        && this._container.getState() === ContainerStates.PASSIVE) {
      this._promoteContainerState(ContainerStates.ACTIVE);
    }
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
   * (`pageshow` / `resume` — real on Blink WebViews) cannot exit a
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

  // ── Per-axis freeze latch wiring (#433 CR-F4) ─────────────────────────────
  // The page-axis freeze/restore events latch and release `_pageFroze`; the
  // transition work itself stays in the inherited handlers.

  /** @protected */
  _onFreeze() {
    this._pageFroze = true;
    super._onFreeze();
  }

  /** @param {PageTransitionEvent} event @protected */
  _onPagehide(event) {
    if (event && event.persisted) this._pageFroze = true;
    super._onPagehide(event);
  }

  /** @protected */
  _onResume() {
    this._pageFroze = false;
    super._onResume();
  }

  /** @param {PageTransitionEvent} event @protected */
  _onPageshow(event) {
    if (event && event.persisted) this._pageFroze = false;
    super._onPageshow(event);
  }

  /**
   * Pre-clamped promotion chokepoint (#433 CR-B1/SE-F2, Fix 2). Every
   * page-derived promotion the HtmlAdapter fires routes through here; the
   * destination is clamped to `most-severe(target, hostCeiling)` BEFORE the
   * transition, so a state above the latched host assertion never appears —
   * even transiently — in the setState/fan-out sequence. When the clamped
   * destination IS the current state, nothing fires (the container already
   * rests at the ceiling). The old shape (super's transition, then a
   * demote-only cap) emitted-then-retracted the out-promotion: one IO event
   * under a 'hidden' ceiling produced ['passive','active','hidden'], and the
   * transient ACTIVE pulsed the OMID loaded/impression fan-out.
   * @param {string} target - Promotion destination (a ContainerStates value).
   * @protected
   */
  _promoteContainerState(target) {
    if (this._container === null) return;
    const host = this._container._hostLifecycle;
    let clamped = target;
    if (host && LIFECYCLE_SEVERITY[host] !== undefined) {
      const targetSeverity = LIFECYCLE_SEVERITY[target];
      if (targetSeverity !== undefined
          && LIFECYCLE_SEVERITY[host] > targetSeverity) {
        // Host-lifecycle enum values ARE ContainerStates values (§ 4.2).
        clamped = host;
      }
    }
    if (this._container.getState() === clamped) return;
    super._promoteContainerState(clamped);
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
  module.exports = { AppLifecycleAdapter, LIFECYCLE_SEVERITY };
}

export { AppLifecycleAdapter, LIFECYCLE_SEVERITY };
