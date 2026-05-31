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
  //
  // Two delivery shapes feed this one closure var:
  //   - Markup variant (§ 4.3 mechanism i): the renderer source-rewrites the
  //     nonce in as a baked literal, so `config.protocolNonce` is present at
  //     install and this is a true constant from line one.
  //   - URL/`srcdoc` variant (§ 4.3 mechanism ii): the nonce arrives async over
  //     a transferred MessagePort AFTER install (the shim installs synchronously
  //     so `window.omid3p` is present before any creative read — § 4.1). The
  //     prelude sets it exactly once via the control-handle `_setProtocolNonce`
  //     below the instant the port message arrives. It is still a closure var
  //     never reachable from `window.omid3p`; "constant" is enforced by the
  //     write-once guard (a second set is ignored), not by `var`.
  var protocolNonce = config.protocolNonce;
  // Tracks whether the nonce has been delivered yet (port variant installs with
  // a pending nonce). `false` once a non-empty nonce is in hand. Used to gate
  // the write-once setter and to fail-closed on inbound validation pre-delivery.
  var nonceResolved = (typeof protocolNonce === 'string' && protocolNonce.length > 0);
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
    // Fail closed before the nonce has been delivered (port variant installs
    // with a pending nonce). No legitimate inbound `:Event` can arrive before
    // `sessionStart`, which is itself long after the port-delivered nonce
    // resolves — so this only ever rejects a pre-delivery forgery, never a real
    // event. Guards against `sharcNonce === undefined === protocolNonce` ever
    // passing while the nonce is still pending.
    if (!nonceResolved) return false;
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
      // Re-stamp the live nonce. In the port variant a Register can be built
      // (queued) before the nonce arrives over the port; the envelope captured
      // the then-pending value. Flush runs only at `sessionStart`, by which
      // point the nonce is resolved — re-stamp so the posted envelope carries
      // the real nonce, never a stale pending one.
      queued[i].sharcNonce = protocolNonce;
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
  //
  // `_setProtocolNonce` is the URL/`srcdoc` port variant's one-time nonce
  // delivery seam (§ 4.3 mechanism ii). The shim installs synchronously with a
  // pending nonce (so `window.omid3p` exists before any creative read — § 4.1),
  // then the prelude calls this the instant the nonce arrives over the
  // transferred MessagePort. Write-once: a second call (or a call when the
  // nonce was already baked in by the Markup source-rewrite path) is ignored,
  // so a creative that somehow reached the control handle cannot rotate the
  // nonce. It returns the resulting resolved-state for tests. The handle is
  // NEVER exposed to vendor JS (it is the prelude's private return value), and
  // there is deliberately no getter — the nonce is write-only from here.
  function setProtocolNonce(nonce) {
    if (nonceResolved) return false;
    if (typeof nonce !== 'string' || nonce.length === 0) return false;
    protocolNonce = nonce;
    nonceResolved = true;
    return true;
  }

  return {
    _handleInbound: handleInbound,
    _isValidInbound: isValidInbound,
    _setProtocolNonce: setProtocolNonce,
    getStats: function () {
      return {
        liveSubscriptions: subscriptions.size,
        cumulativeRegistrations: cumulativeRegistrations,
        cachedEvents: eventLog.length,
        cachedSessionErrors: cachedSessionErrorCount,
        sessionStarted: sessionStarted,
        dropped: dropped,
        maxSubscriptions: maxSubscriptions,
        nonceResolved: nonceResolved,
      };
    },
    destroy: dropOmid3p,
  };
}

/**
 * URL/`srcdoc` variant prelude (§ 4.3 mechanism ii — MessageChannel).
 *
 * There is no renderer in the URL+`useMarkupInjection` path, so the Markup
 * variant's source-rewrite-the-nonce-as-a-literal mechanism (i) does not apply.
 * Instead the container transfers a one-time `MessagePort` into the `srcdoc`
 * frame and delivers the OMID `protocolNonce` over it. This function is the
 * shim-side receiver, designed to run as the FIRST script in the `srcdoc`
 * document (synchronously, during parse, before any creative markup executes).
 *
 * ORDERING GUARANTEE (the crux — design § 4.3 ii). Executed synchronously, in
 * this exact order, before yielding to the event loop:
 *   1. Install `window.omid3p` (via `installOmidShim`) with a PENDING nonce, so
 *      a verification script's first synchronous `window.omid3p` read succeeds
 *      (§ 4.1). Vendor `registerSessionObserver`/`addEventListener` calls that
 *      run in the same synchronous parse unit queue locally; the shim defers the
 *      outbound `SHARC:Omid:Register` post to `sessionStart` regardless (§ 5.5),
 *      so no Register can post before the nonce resolves.
 *   2. Install the `window` `message` listener that catches the transferred
 *      port. The port arrives as `event.ports[0]` of a `window` message — this
 *      is the ONLY window message the prelude consumes; the nonce itself rides
 *      the port (`port.onmessage`), point-to-point and invisible to any creative
 *      `window` `message` listener.
 *   3. When the port message arrives (a TASK — it cannot dispatch until the
 *      current synchronous unit, including parser-inserted creative `<script>`s,
 *      has yielded), register `port.onmessage`, then post a readiness ping so
 *      the container can deliver the nonce as the first thing over the port.
 *   4. The nonce message over the port stashes the nonce via the shim handle's
 *      write-once `_setProtocolNonce`. The port handler is provably installed
 *      before the nonce message can be dispatched (handler registered
 *      synchronously; message is a task), so the nonce becomes a resolved
 *      closure constant before any outbound Register is posted (Register posts
 *      defer to `sessionStart`, a later inbound). RACE-FREE.
 *
 * The nonce NEVER transits the `srcdoc` source (so it is not readable from
 * `document.scripts` text — #254-clean), NEVER `location.hash`/query/global/
 * DOM-attr, and NEVER reaches `window.omid3p` or any observer callback.
 *
 * @param {{
 *   placementSessionId: string,
 *   containerOrigin: string,
 *   targetWindow?: Window,
 *   parentWindow?: Window,
 *   maxSubscriptions?: number,
 *   onNonceResolved?: (resolved: boolean) => void,
 * }} config
 * @returns {object} the shim's internal control handle (carries no nonce).
 */
function installOmidShimPortReceiver(config) {
  config = config || {};
  var targetWindow = config.targetWindow
    || (typeof window !== 'undefined' ? window : undefined);
  if (!targetWindow) {
    throw new Error('[SHARC OMID Shim] no target window for port-receiver install');
  }
  var parentWindow = config.parentWindow
    || (targetWindow.parent || (typeof window !== 'undefined' ? window.parent : undefined));

  // STEP 1 — install the shim synchronously with a PENDING nonce so
  // `window.omid3p` is present before any creative read (§ 4.1). The outbound
  // Register path still rides `window.message` (OMID-D1: the port is for the
  // nonce only, steady-state OMID traffic uses the router channel), so the
  // shim's default `postRegister` (parent.postMessage to containerOrigin) is
  // exactly right here — we do NOT route Register over the port.
  var handle = installOmidShim({
    // protocolNonce intentionally omitted — delivered async over the port.
    placementSessionId: config.placementSessionId,
    containerOrigin: config.containerOrigin,
    targetWindow: targetWindow,
    parentWindow: parentWindow,
    maxSubscriptions: config.maxSubscriptions,
  });

  var portWired = false;

  function wirePort(port) {
    if (portWired || !port) return;
    portWired = true;
    // STEP 4 — nonce arrives over the point-to-point port. Stash it write-once.
    port.onmessage = function (ev) {
      var data = ev && ev.data;
      var nonce = (data && typeof data === 'object') ? data.protocolNonce : data;
      var ok = handle._setProtocolNonce(nonce);
      if (typeof config.onNonceResolved === 'function') {
        try { config.onNonceResolved(ok); } catch (_) { /* test hook */ }
      }
    };
    if (typeof port.start === 'function') {
      try { port.start(); } catch (_) { /* ports auto-start on onmessage assign */ }
    }
    // Tell the container the receiver is live so it can post the nonce now.
    // Carries NO secret — it is a bare readiness ping back over the same port.
    try { port.postMessage({ type: 'SHARC:Omid:PortReady' }); } catch (_) { /* best-effort */ }
  }

  // STEP 2/3 — one-time window listener that captures the transferred port.
  // The container posts `contentWindow.postMessage(initMsg, origin, [port2])`;
  // the port shows up as event.ports[0]. We accept the port on a best-effort
  // origin check (srcdoc may be opaque-origin — § 7.4): require source===parent;
  // accept the port and let the nonce-bearing port message (and the inbound
  // `:Event` validator) be the load-bearing nonce gate. No nonce is read here.
  var portListener = function (event) {
    if (parentWindow && event.source !== parentWindow) return;
    if (!event.ports || event.ports.length === 0) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'SHARC:Omid:Port') return;
    if (typeof targetWindow.removeEventListener === 'function') {
      try { targetWindow.removeEventListener('message', portListener, false); } catch (_) { /* ignore */ }
    }
    wirePort(event.ports[0]);
  };
  if (typeof targetWindow.addEventListener === 'function') {
    targetWindow.addEventListener('message', portListener, false);
  }

  return handle;
}

// ---------------------------------------------------------------------------
// Exports — dual-mode (matches sharc-protocol-router.js's pattern).
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    installOmidShim: installOmidShim,
    installOmidShimPortReceiver: installOmidShimPortReceiver,
    MAX_OMID_SUBSCRIPTIONS: MAX_OMID_SUBSCRIPTIONS,
  };
}

export { installOmidShim, installOmidShimPortReceiver, MAX_OMID_SUBSCRIPTIONS };

// Browser-global attachment for the source-rewrite / direct-include path.
if (typeof window !== 'undefined') {
  window.SHARC = window.SHARC || {};
  if (!window.SHARC.installOmidShim) {
    window.SHARC.installOmidShim = installOmidShim;
  }
  if (!window.SHARC.installOmidShimPortReceiver) {
    window.SHARC.installOmidShimPortReceiver = installOmidShimPortReceiver;
  }
}
