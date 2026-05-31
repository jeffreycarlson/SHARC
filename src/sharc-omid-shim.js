// @ts-nocheck
/**
 * @fileoverview SHARC OMID Shim (0.7.8)
 *
 * Iframe-side shim that installs `window.omid3p` with the IAB-spec surface so
 * OMID-aware verification scripts arriving inline in the creative `adm`
 * (DoubleVerify, IAS, Moat, Integral) detect SHARC's OMID integration and
 * register session observers. The publisher-page `AdSession` (owned by
 * `OmidCompatBridge`) is the single source of truth; this shim is a one-way
 * relay of its events to inline verification scripts.
 *
 * The shim is a pure router CONSUMER artifact: the publisher-side transport is
 * gated by the SHARC Protocol Router (0.7.7) under prefix `SHARC:Omid:`. This
 * shim runs inside the (hostile) creative iframe where there is no router
 * instance, so it carries its own minimal 4-check inbound validator
 * (source / origin / nonce / placementSessionId — § 3.5 / OMID-Q3).
 *
 * Security invariants (design § 5, § 7, § 9):
 *   - `window.omid3p` exposes EXACTLY two methods (`registerSessionObserver`,
 *     `addEventListener`); nothing else (§ 5.1).
 *   - The OMID protocolNonce is NEVER exposed to vendor JS: it is a private
 *     closure constant, never on `window.omid3p`, never in an observer event,
 *     return value, or `data` payload (§ 5.2 / § 9 dep 6).
 *   - Transport fields (`sharcNonce` / `placementSessionId` / `sequence`) are
 *     stripped before observer-callback delivery; the same stripped delivery
 *     path is reused for replay.
 *   - Late-registering observers get FULL replay — every previously-fired event
 *     of the subscribed type, in chronological order. The replay path is never
 *     capped, coalesced, or sampled (§ 5.4 invariant).
 *   - Subscription cap is churn-resistant: bounds BOTH concurrent-live AND
 *     cumulative-per-session registrations, so register→unregister→register
 *     cannot drive repeated replays (§ 7.3).
 *   - Cross-vendor dispatch is direct same-realm callback invocation, NEVER an
 *     in-iframe `postMessage` broadcast (§ 7.2).
 *   - Throws synchronously on a pre-existing `window.omid3p` (§ 11.3 / OMID-D10).
 *
 * @version 0.7.8
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md
 * @see https://iabtechlab.com/standards/open-measurement-sdk/
 */

'use strict';

/**
 * Conservative, finite provisional default for the subscription cap (OMID-D6).
 *
 * NOT FINAL. The cap VALUE is owned by #244 (the validator measures the real
 * DV/IAS/Moat/Integral observer-count distribution against the corpus and sets
 * it at p99 + headroom). What is locked here is the MECHANISM (churn-resistant,
 * bounds both concurrent-live and cumulative-per-session) and that the default
 * ships finite and enforced from day one — never unbounded. Do not treat this
 * number as final; do not read it as `64 is the answer`.
 */
var MAX_OMID_SUBSCRIPTIONS = 64;

/**
 * Emission-side cap on the number of DISTINCT cached `sessionError`s
 * (design § 7.3). Bounds the cached-log size at the input so an OM-SDK
 * error-storm cannot grow the replay log unboundedly. Errors past the cap are
 * not cached (and therefore not replayed). Session-singletons
 * (`sessionStart`/`sessionFinish`/`loaded`/`impression`) are already ≤1 each at
 * the bridge, so they contribute a constant.
 */
var MAX_CACHED_SESSION_ERRORS = 16;

/** Transport fields stripped from every envelope before observer delivery. */
var TRANSPORT_FIELDS = ['sharcNonce', 'placementSessionId', 'sequence'];

/**
 * Mints an opaque subscription id. Uses `crypto.randomUUID` when available
 * (secure context — the SHARC baseline), falling back to a non-crypto token
 * only for environments that lack it (the id is a correlation handle, not a
 * security token).
 *
 * @returns {string}
 */
function mintSubscriptionId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_) { /* fall through */ }
  return 'omidsub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Produces the observer-facing event from a wire envelope's `event` payload,
 * with all transport fields stripped. The OMID protocolNonce lives only on the
 * envelope wrapper (never on `event`), but we strip defensively from both the
 * wrapper and the inner event so no transport field can ever reach a callback.
 *
 * @param {object} innerEvent - `{ adSessionId, timestamp, type, data }`
 * @returns {object} the exact IAB observer event shape (§ 5.2)
 */
function toObserverEvent(innerEvent) {
  var src = (innerEvent && typeof innerEvent === 'object') ? innerEvent : {};
  // Build the event explicitly from the four spec fields only — an allowlist,
  // not a denylist, so no unexpected field (transport or otherwise) leaks.
  var out = {
    adSessionId: src.adSessionId,
    timestamp: src.timestamp,
    type: src.type,
    data: (src.data && typeof src.data === 'object') ? src.data : {},
  };
  // Belt-and-braces: ensure no transport field survived (defends against a
  // future refactor that widens the allowlist).
  for (var i = 0; i < TRANSPORT_FIELDS.length; i++) {
    if (Object.prototype.hasOwnProperty.call(out, TRANSPORT_FIELDS[i])) {
      delete out[TRANSPORT_FIELDS[i]];
    }
    if (out.data && Object.prototype.hasOwnProperty.call(out.data, TRANSPORT_FIELDS[i])) {
      delete out.data[TRANSPORT_FIELDS[i]];
    }
  }
  return out;
}

/**
 * Installs the SHARC OMID shim into the current iframe `window`.
 *
 * The OMID `protocolNonce` is passed in by the trusted-injection mechanism
 * (renderer source-rewrite for the Markup variant — § 4.3 mechanism i; or
 * MessageChannel transfer for the URL/`srcdoc` variant — PR 2, mechanism ii)
 * and captured here as a PRIVATE CLOSURE CONSTANT. It is never written to
 * `window.omid3p`, never echoed to vendor JS, and never placed on `location`.
 *
 * @param {{
 *   protocolNonce: string,
 *   placementSessionId: string,
 *   containerOrigin: string,
 *   targetWindow?: Window,
 *   parentWindow?: Window,
 *   postRegister?: (envelope: object) => void,
 *   maxSubscriptions?: number,
 * }} config
 * @returns {object} an internal control handle (test/diagnostic affordance;
 *   NOT exposed to vendor JS). Carries no nonce.
 */
function installOmidShim(config) {
  config = config || {};

  var targetWindow = config.targetWindow
    || (typeof window !== 'undefined' ? window : undefined);
  if (!targetWindow) {
    throw new Error('[SHARC OMID Shim] no target window to install window.omid3p on');
  }

  // § 11.3 / OMID-D10: loud-fail on a pre-existing omid3p. Never silent-overwrite.
  if (targetWindow.omid3p) {
    throw new Error(
      '[SHARC OMID Shim] window.omid3p is already installed. '
      + 'SHARC manages omid3p exposure; nested or duplicate installations are not supported.'
    );
  }

  // ── Private closure state (NOT reachable from window.omid3p) ──────────────

  // The OMID protocolNonce — private closure constant. Outbound SHARC:Omid:
  // Register envelopes are signed with it; it is NEVER read back out.
  var protocolNonce = config.protocolNonce;
  var placementSessionId = config.placementSessionId;
  var containerOrigin = config.containerOrigin;
  var parentWindow = config.parentWindow
    || (targetWindow.parent || (typeof window !== 'undefined' ? window.parent : undefined));
  var maxSubscriptions = (typeof config.maxSubscriptions === 'number' && config.maxSubscriptions > 0)
    ? config.maxSubscriptions
    : MAX_OMID_SUBSCRIPTIONS;

  // postRegister: how the shim posts an inbound SHARC:Omid:Register envelope to
  // the publisher. Default is parent.postMessage; injectable for tests and for
  // the URL/srcdoc port variant (PR 2).
  var postRegister = (typeof config.postRegister === 'function')
    ? config.postRegister
    : function (envelope) {
      // SECURITY: the Register envelope carries the OMID protocolNonce. NEVER
      // broadcast it with a `'*'` targetOrigin — that would hand the nonce to
      // any origin the iframe's parent chain resolves to. Refuse to post when
      // `containerOrigin` is falsy. (Today the Markup path always sets a real
      // origin; the future URL/srcdoc variant could pass empty — fail closed.)
      if (!containerOrigin) {
        throw new Error(
          '[SHARC OMID Shim] refusing to post Register without a concrete containerOrigin '
          + '(would broadcast the OMID protocolNonce to any origin).'
        );
      }
      if (parentWindow && typeof parentWindow.postMessage === 'function') {
        parentWindow.postMessage(envelope, containerOrigin);
      }
    };

  // Live subscriptions: subscriptionId -> { kind, eventType|null, callback }.
  var subscriptions = new Map();
  // GUID-keyed callback map for response correlation (§ 5.5 / dep 7).
  var callbackMap = new Map();
  // Cumulative-per-session registration count (churn resistance — § 7.3).
  var cumulativeRegistrations = 0;
  // Chronological event log for full replay (§ 5.4). Stores observer-shaped
  // (already-stripped) events so replay reuses the stripped delivery path.
  var eventLog = [];
  var cachedSessionErrorCount = 0;
  // Whether the publisher OMID session has started. Pre-session register calls
  // queue locally and defer the Register post until sessionStart (§ 5.5).
  var sessionStarted = false;
  // Pending Register envelopes to flush at sessionStart.
  var pendingRegisterEnvelopes = [];
  var dropped = false; // set after sessionFinish — omid3p removed, no new subs

  // ── Cap enforcement (churn-resistant — § 7.3) ────────────────────────────

  function capExceeded() {
    return subscriptions.size >= maxSubscriptions
      || cumulativeRegistrations >= maxSubscriptions;
  }

  // ── Delivery (direct same-realm callback — § 7.2) ─────────────────────────

  function deliver(callback, observerEvent) {
    // Direct callback invocation in the same JS context. NEVER a postMessage
    // broadcast (§ 7.2). A throwing vendor callback must not break delivery to
    // other vendors or the shim itself.
    try {
      callback(observerEvent);
    } catch (_) { /* vendor callback errors are not the shim's concern */ }
  }

  function matchesSubscription(sub, observerEvent) {
    if (sub.kind === 'sessionObserver') return true;
    return sub.kind === 'eventListener' && sub.eventType === observerEvent.type;
  }

  // Replays the full chronological log of matching events to a freshly-
  // registered subscription. NO cap, NO coalescing, NO sampling (§ 5.4).
  function replayTo(sub) {
    for (var i = 0; i < eventLog.length; i++) {
      var ev = eventLog[i];
      if (matchesSubscription(sub, ev)) {
        deliver(sub.callback, ev);
      }
    }
  }

  // Live fan-out to all currently-registered subscriptions.
  //
  // SNAPSHOT before iterating (§ 7.2 re-entrancy): a vendor callback may call
  // registerSessionObserver/addEventListener synchronously during dispatch. The
  // event being dispatched has already been pushed to `eventLog` (handleInbound,
  // before dispatchLive), so registerSubscription→replayTo delivers it to the
  // new subscription at registration time. Iterating the live Map would ALSO
  // visit that freshly-inserted entry, double-delivering this event to the new
  // sub. Snapshotting the values up-front means a subscription added mid-dispatch
  // is not visited by the in-flight dispatch (it already got the event via
  // replay), and a subscription removed mid-dispatch is not re-fetched. Either
  // way: exactly once, never twice, never zero.
  function dispatchLive(observerEvent) {
    var snapshot = Array.from(subscriptions.values());
    for (var i = 0; i < snapshot.length; i++) {
      var sub = snapshot[i];
      if (matchesSubscription(sub, observerEvent)) {
        deliver(sub.callback, observerEvent);
      }
    }
  }

  // ── Inbound envelope handling (publisher → shim) ──────────────────────────

  // Shim-side 4-check inbound validator (§ 3.5 / § 7.4 / OMID-Q3). This is NOT
  // a router re-implementation — the shim knows exactly one nonce and one
  // counterpart. `event.source === parent` is load-bearing; `event.origin` is
  // best-effort to tolerate srcdoc/opaque-origin (OMID-D9).
  function isValidInbound(event) {
    if (!event || typeof event.data !== 'object' || event.data === null) return false;
    if (parentWindow && event.source !== parentWindow) return false;
    // Origin: pass if it matches; pass if null/opaque AND source === parent;
    // fail otherwise.
    if (event.origin && event.origin !== 'null') {
      if (containerOrigin && event.origin !== containerOrigin) return false;
    }
    if (event.data.sharcNonce !== protocolNonce) return false;
    if (event.data.placementSessionId !== placementSessionId) return false;
    return true;
  }

  function handleInbound(event) {
    if (!isValidInbound(event)) return;
    var data = event.data;
    if (typeof data.type !== 'string' || data.type.indexOf('SHARC:Omid:') !== 0) return;
    var typeName = data.type.slice('SHARC:Omid:'.length);
    if (typeName !== 'Event') return; // shim only consumes :Event inbound
    if (!data.event || typeof data.event !== 'object') return;

    var observerEvent = toObserverEvent(data.event);
    if (typeof observerEvent.type !== 'string') return;

    // sessionStart flips the session live and flushes deferred Register posts.
    if (observerEvent.type === 'sessionStart' && !sessionStarted) {
      sessionStarted = true;
      flushPendingRegisters();
    }

    // Emission-side cached-log bound for sessionError (§ 7.3). The publisher
    // bridge already rate-limits geometryChange at emission; the shim caps the
    // count of distinct cached sessionErrors so an error-storm cannot grow the
    // replay log unboundedly. Errors past the cap are delivered live but NOT
    // cached (and so not replayed).
    var cache = true;
    if (observerEvent.type === 'sessionError') {
      if (cachedSessionErrorCount >= MAX_CACHED_SESSION_ERRORS) {
        cache = false;
      } else {
        cachedSessionErrorCount++;
      }
    }
    if (cache) eventLog.push(observerEvent);

    dispatchLive(observerEvent);

    // sessionFinish: drop omid3p and refuse new subscriptions (§ 6.1).
    if (observerEvent.type === 'sessionFinish') {
      dropOmid3p();
    }
  }

  function flushPendingRegisters() {
    if (pendingRegisterEnvelopes.length === 0) return;
    var queued = pendingRegisterEnvelopes;
    pendingRegisterEnvelopes = [];
    for (var i = 0; i < queued.length; i++) {
      postRegister(queued[i]);
    }
  }

  function dropOmid3p() {
    if (dropped) return;
    dropped = true;
    try { delete targetWindow.omid3p; } catch (_) { targetWindow.omid3p = undefined; }
    // Mirror the install-side wiring: the listener lives on `targetWindow`
    // (self), so it must be removed from there — not from the cross-origin
    // `parentWindow` (which would throw and leave the listener attached).
    if (typeof targetWindow.removeEventListener === 'function') {
      try { targetWindow.removeEventListener('message', inboundListener, false); } catch (_) { /* ignore */ }
    }
  }

  // ── Registration internals ────────────────────────────────────────────────

  // Builds the inbound Register envelope. Signed with the injected protocolNonce
  // (the shim has no buildOutbound — that is a publisher-page helper — so it
  // constructs the shape by hand using the nonce verbatim, § 3.3).
  function buildRegisterEnvelope(subscription) {
    return {
      type: 'SHARC:Omid:Register',
      sharcNonce: protocolNonce,
      placementSessionId: placementSessionId,
      subscription: subscription,
    };
  }

  function registerSubscription(kind, eventType, callback) {
    if (dropped) return null; // session finished — refuse silently
    // Churn-resistant cap: calls past EITHER ceiling are accepted silently and
    // ignored (matches a vendor SDK that ignores internally — no throw).
    if (capExceeded()) return null;

    cumulativeRegistrations++;
    var subscriptionId = mintSubscriptionId();
    var sub = { kind: kind, eventType: eventType, callback: callback, subscriptionId: subscriptionId };
    subscriptions.set(subscriptionId, sub);
    callbackMap.set(subscriptionId, callback);

    // Full replay of prior matching events (§ 5.4) — reuses the stripped
    // delivery path. Replayed synchronously, before any live event.
    replayTo(sub);

    var envelope = buildRegisterEnvelope({
      kind: kind === 'sessionObserver' ? 'sessionObserver' : 'eventListener',
      eventType: eventType || undefined,
      subscriptionId: subscriptionId,
    });

    if (sessionStarted) {
      postRegister(envelope);
    } else {
      // Defer the post until sessionStart so a legitimate Register never arrives
      // before omid-active (§ 3.2 / § 5.5 / OMID-Q1).
      pendingRegisterEnvelopes.push(envelope);
    }
    return subscriptionId;
  }

  // ── window.omid3p surface — EXACTLY two methods (§ 5.1) ────────────────────

  var omid3p = {
    /**
     * @param {function(object)} observer
     * @param {string=} _vendorKey - accepted per the reference Verification
     *   Client call shape; not consumed by the shim (faithful relay — § 5.1).
     * @param {string=} _injectionId - accepted defensively; not consumed.
     */
    registerSessionObserver: function (observer, _vendorKey, _injectionId) {
      if (typeof observer !== 'function') return;
      registerSubscription('sessionObserver', null, observer);
    },

    /**
     * @param {string} eventType
     * @param {function(object)} listener
     * @param {string=} _injectionId - accepted defensively; not consumed.
     */
    addEventListener: function (eventType, listener, _injectionId) {
      if (typeof eventType !== 'string' || typeof listener !== 'function') return;
      registerSubscription('eventListener', eventType, listener);
    },
  };

  targetWindow.omid3p = omid3p;

  // ── Inbound transport listener ────────────────────────────────────────────

  var inboundListener = function (event) { handleInbound(event); };
  // The shim runs INSIDE the creative iframe, so the inbound listener belongs on
  // the window the shim runs in (`targetWindow` === self). The publisher posts
  // `parentWindow.postMessage(envelope, iframeOrigin)`, which the BROWSER
  // delivers to the iframe's own `message` queue — never to the parent's. The
  // source-of-truth gate is `isValidInbound`'s `event.source === parentWindow`
  // check (§ 3.5), NOT the window the listener is bound to. Binding to
  // `parentWindow` (the cross-origin publisher) both throws on `addEventListener`
  // property access AND would never receive the publisher→iframe message.
  if (typeof targetWindow.addEventListener === 'function') {
    targetWindow.addEventListener('message', inboundListener, false);
  }

  // Internal control handle — test/diagnostic affordance only. Deliberately
  // carries NO nonce. Not the omid3p surface.
  return {
    _handleInbound: handleInbound,
    _isValidInbound: isValidInbound,
    getStats: function () {
      return {
        liveSubscriptions: subscriptions.size,
        cumulativeRegistrations: cumulativeRegistrations,
        cachedEvents: eventLog.length,
        cachedSessionErrors: cachedSessionErrorCount,
        sessionStarted: sessionStarted,
        dropped: dropped,
        maxSubscriptions: maxSubscriptions,
      };
    },
    destroy: dropOmid3p,
  };
}

// ---------------------------------------------------------------------------
// Exports — dual-mode (matches sharc-protocol-router.js's pattern).
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installOmidShim: installOmidShim, MAX_OMID_SUBSCRIPTIONS: MAX_OMID_SUBSCRIPTIONS };
}

export { installOmidShim, MAX_OMID_SUBSCRIPTIONS };

// Browser-global attachment for the source-rewrite / direct-include path.
if (typeof window !== 'undefined') {
  window.SHARC = window.SHARC || {};
  if (!window.SHARC.installOmidShim) {
    window.SHARC.installOmidShim = installOmidShim;
  }
}
