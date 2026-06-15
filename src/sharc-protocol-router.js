/**
 * @fileoverview SHARC Protocol Router (0.7.7)
 *
 * Single primitive that owns the publisher-side `window` `message` listener
 * for every SHARC cross-frame protocol. Each registered protocol declares
 * a unique prefix, a `types` map (phase memberships + direction), and a
 * handler; the router uniformly validates every inbound envelope before
 * dispatch and emits `unauthorized_protocol` on phase-membership failure.
 *
 * Per-protocol nonces are derived via HMAC-SHA-256 over
 *   `(rootNonce, prefix + ':' + placementSessionId)`
 * — raw HMAC bytes truncated to 16 (128 bits) then base64url-encoded to 22
 * chars. The root `_sharcNonce` never appears on the wire.
 *
 * See `docs/design/0.7.7-cross-frame-protocol-router.md` for the full design.
 * This file is intentionally build-only/internal in 0.7.x: Rollup emits
 * `dist/sharc-protocol-router.{js,mjs,d.ts}` for SHARC's own bundles,
 * tooling, and script-tag loading, but `package.json` does not expose a
 * `./sharc-protocol-router` public import subpath. Consumers should import
 * the container, creative SDK, or bridge modules instead.
 *
 * @version 0.7.11
 */

'use strict';

// `crypto.subtle` is a hard requirement (RTR-D22). Resolve the crypto object
// at construction time from whichever global is available — `globalThis.crypto`
// in modern browsers / Node 19+, `window.crypto` everywhere else. Non-secure
// contexts (HTTP iframes) do not expose `subtle` and trip the throw below.
function _resolveCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    return window.crypto;
  }
  if (typeof crypto !== 'undefined' && crypto && crypto.subtle) {
    return crypto;
  }
  return null;
}

// base64url(Uint8Array) — no padding, URL-safe alphabet. 16 bytes → 22 chars.
function _base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  let b64;
  if (typeof btoa === 'function') {
    b64 = btoa(binary);
  } else if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(binary, 'binary').toString('base64');
  } else {
    throw new Error('[SHARCProtocolRouter] no base64 encoder available');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class SHARCProtocolRouter {
  /**
   * @param {{
   *   container: object,
   *   iframe: () => (HTMLIFrameElement|null),
   *   expectedRendererOrigin: () => (string|null),
   *   expectedPlacementSessionId: () => string,
   *   rootNonce: string,
   *   onUnauthorizedProtocol: (event: object) => void,
   *   initialPhase?: string,
   * }} options
   */
  constructor(options) {
    const crypto = _resolveCrypto();
    if (!crypto || !crypto.subtle || typeof crypto.subtle.sign !== 'function') {
      throw new Error(
        '[SHARCProtocolRouter] crypto.subtle is unavailable — SHARC requires '
        + 'a secure context (HTTPS or localhost). Non-secure contexts cannot '
        + 'derive per-protocol nonces.'
      );
    }
    this._crypto = crypto;

    this._container = options.container;
    this._iframeGetter = options.iframe;
    this._expectedRendererOrigin = options.expectedRendererOrigin;
    this._expectedPlacementSessionId = options.expectedPlacementSessionId;
    this._rootNonce = options.rootNonce;
    this._onUnauthorizedProtocol = options.onUnauthorizedProtocol;
    this._currentPhase = options.initialPhase || 'init';

    // Registry — map prefix → { prefix, types, handler, onReady,
    // protocolNonce, ready: Promise, _resolveReady, _rejectReady, sessionId }.
    this._protocols = new Map();

    this._listener = (event) => this._dispatch(event);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('message', this._listener, false);
    }
  }

  /**
   * Returns the current lifecycle phase.
   * @returns {string}
   */
  getPhase() {
    return this._currentPhase;
  }

  /**
   * Transitions the router to a new lifecycle phase. Called only by
   * container-internal code; not exposed to extensions (RTR-D14).
   *
   * @param {string} phase
   */
  transitionTo(phase) {
    if (typeof phase !== 'string' || phase.length === 0) {
      throw new TypeError('[SHARCProtocolRouter] transitionTo: phase must be a non-empty string');
    }
    this._currentPhase = phase;
  }

  /**
   * Registers a protocol. See § 2.2 of the design doc.
   *
   * @param {{
   *   prefix: string,
   *   types: Object<string, {phases: string[], direction: 'inbound'|'outbound'|'bidirectional'}>,
   *   handler: (envelope: object, context: object) => void,
   *   onReady?: (info: {protocolNonce: string}) => void,
   * }} registration
   */
  register(registration) {
    if (!registration || typeof registration !== 'object') {
      throw new TypeError('[SHARCProtocolRouter] register: registration must be an object');
    }
    const { prefix, types, handler, onReady } = registration;

    if (typeof prefix !== 'string' || prefix.length === 0) {
      throw new TypeError('[SHARCProtocolRouter] register: prefix must be a non-empty string');
    }
    if (prefix.charAt(prefix.length - 1) !== ':') {
      throw new Error(
        '[SHARCProtocolRouter] prefix must end with ":" — got ' + JSON.stringify(prefix)
      );
    }
    if (!types || typeof types !== 'object' || Object.keys(types).length === 0) {
      throw new Error('[SHARCProtocolRouter] types must be a non-empty object');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('[SHARCProtocolRouter] register: handler must be a function');
    }
    if (onReady !== undefined && typeof onReady !== 'function') {
      throw new TypeError('[SHARCProtocolRouter] register: onReady must be a function when provided');
    }

    // Bidirectional prefix-of-prefix collision check (RTR-D5, SEC-4).
    for (const existing of this._protocols.keys()) {
      if (prefix === existing
          || prefix.startsWith(existing)
          || existing.startsWith(prefix)) {
        throw new Error(
          '[SHARCProtocolRouter] prefix "' + prefix
          + '" collides with already-registered prefix "' + existing + '"'
        );
      }
    }

    // Validate `types` map shape.
    for (const t of Object.keys(types)) {
      const decl = types[t];
      if (!decl || typeof decl !== 'object') {
        throw new TypeError(
          '[SHARCProtocolRouter] type "' + t + '" on prefix "' + prefix
          + '" must be an object with `phases` and `direction`'
        );
      }
      if (!Array.isArray(decl.phases) || decl.phases.length === 0) {
        throw new TypeError(
          '[SHARCProtocolRouter] type "' + t + '" on prefix "' + prefix
          + '" must declare a non-empty `phases` array'
        );
      }
      if (decl.direction !== 'inbound'
          && decl.direction !== 'outbound'
          && decl.direction !== 'bidirectional') {
        throw new TypeError(
          '[SHARCProtocolRouter] type "' + t + '" on prefix "' + prefix
          + '" must declare direction "inbound", "outbound", or "bidirectional"'
        );
      }
    }

    const entry = {
      prefix: prefix,
      types: types,
      handler: handler,
      onReady: onReady || null,
      protocolNonce: null,
      ready: null,
      _resolveReady: null,
      _rejectReady: null,
    };
    entry.ready = new Promise((resolve, reject) => {
      entry._resolveReady = resolve;
      entry._rejectReady = reject;
    });
    // Prevent unhandled-rejection noise; callers opt in via `ready(prefix)`.
    entry.ready.catch(() => {});
    this._protocols.set(prefix, entry);

    this._deriveAndDeliver(entry);
  }

  /**
   * Returns a Promise that resolves with `{protocolNonce}` once derivation
   * for the prefix has completed for the current placementSessionId. Re-arms
   * on sequential-impression re-mint (§ 5.5.1).
   *
   * @param {string} prefix
   * @returns {Promise<{protocolNonce: string}>}
   */
  ready(prefix) {
    const entry = this._protocols.get(prefix);
    if (!entry) {
      return Promise.reject(new Error(
        '[SHARCProtocolRouter] no protocol registered for prefix "' + prefix + '"'
      ));
    }
    return entry.ready;
  }

  /**
   * Re-derives every registered protocol's nonce against the current
   * `placementSessionId` and re-fires `onReady` for each. Resolves only after
   * every derivation has completed and every `onReady` has been invoked
   * (RTR-D21 ordering invariant).
   *
   * @returns {Promise<void>}
   */
  rederiveAllProtocolNonces() {
    const tasks = [];
    for (const entry of this._protocols.values()) {
      // Re-arm the ready Promise so callers awaiting the post-mint nonce
      // resolve only against the freshly-derived value.
      entry.ready = new Promise((resolve, reject) => {
        entry._resolveReady = resolve;
        entry._rejectReady = reject;
      });
      entry.ready.catch(() => {});
      tasks.push(this._deriveAndDeliver(entry));
    }
    return Promise.all(tasks).then(() => {});
  }

  /**
   * Builds an outbound envelope for a registered protocol's outbound or
   * bidirectional type. Throws on payload collision with a router-controlled
   * field (RTR-D7 / § 3.3 step 4).
   *
   * @param {string} prefix
   * @param {string} type - The trailing portion (no prefix).
   * @param {Object<string, unknown>} [payload]
   * @returns {object}
   */
  buildOutbound(prefix, type, payload) {
    const entry = this._protocols.get(prefix);
    if (!entry) {
      throw new Error(
        '[SHARCProtocolRouter] no protocol registered for prefix "' + prefix + '"'
      );
    }
    const decl = entry.types[type];
    if (!decl) {
      throw new Error(
        '[SHARCProtocolRouter] type "' + type + '" is not declared on protocol "' + prefix + '"'
      );
    }
    if (decl.direction !== 'outbound' && decl.direction !== 'bidirectional') {
      throw new Error(
        '[SHARCProtocolRouter] type "' + type + '" is not outbound on protocol "' + prefix + '"'
      );
    }
    if (entry.protocolNonce === null) {
      throw new Error(
        '[SHARCProtocolRouter] outbound envelope for "' + prefix
        + '" attempted before per-protocol nonce derivation completed'
      );
    }
    const envelope = {
      type: prefix + type,
      sharcNonce: entry.protocolNonce,
      placementSessionId: this._expectedPlacementSessionId(),
    };
    if (payload && typeof payload === 'object') {
      for (const key of Object.keys(payload)) {
        if (key === 'type' || key === 'sharcNonce' || key === 'placementSessionId') {
          throw new Error(
            '[SHARCProtocolRouter] buildOutbound payload collides with router-controlled '
            + 'field "' + key + '" on protocol "' + prefix + '"'
          );
        }
        envelope[key] = payload[key];
      }
    }
    return envelope;
  }

  /**
   * Returns the registered protocol entry for a prefix (test/diagnostic
   * affordance — extension code should rely on the `onReady` callback or
   * `ready(prefix)`). Read-only snapshot.
   *
   * @param {string} prefix
   * @returns {{prefix: string, protocolNonce: string|null} | null}
   */
  getProtocol(prefix) {
    const entry = this._protocols.get(prefix);
    if (!entry) return null;
    return { prefix: entry.prefix, protocolNonce: entry.protocolNonce };
  }

  /**
   * Detaches the router's `message` listener. Called by the container's
   * `_terminate()` for explicit cleanup; the listener is also GC'd when the
   * container is dropped.
   */
  destroy() {
    if (this._listener && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      try { window.removeEventListener('message', this._listener, false); } catch (_) { /* ignore */ }
    }
    this._listener = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  _deriveAndDeliver(entry) {
    // MAJ-1: read `_expectedPlacementSessionId()` (and anything else before the
    // first await) INSIDE the async body so a synchronous throw becomes a
    // rejection rather than escaping `register()`. The container's load `.catch`
    // (src/sharc-container.js) routes the typed rejection to
    // `feature_load_failed`; a synchronous escape would bypass that path.
    return Promise.resolve()
      .then(() => this._derive(entry.prefix, this._expectedPlacementSessionId()))
      .then((nonce) => {
        // The per-impression HMAC value is the protocol's gate nonce: the
        // `onReady`-delivered value (the container's `_rendererProtocolNonce`
        // mirror + URL fragment), the `buildOutbound` :render nonce, and the
        // value gate step 7 validates inbound `:rendered`/`:failed` against. It
        // is session-stable — the reverse-hash-chain that formerly rotated it
        // per `document.open` generation is RETIRED (ADR 2026-06-15): the
        // post-render navigation backstop now authenticates by MessagePort
        // possession (the surviving `port2` answers the load-probe over the
        // port), so there is no in-realm secret to rotate. The `:rendered`
        // re-anchor on a legit reopen carries this same gen-0 nonce; a real
        // cross-document navigation has no prelude and no nonce, so it cannot
        // forge a `:rendered` to reach the reopen handler — the backstop still
        // fires 2118 keyed on navigation (the port goes unanswered).
        entry.protocolNonce = nonce;
        if (entry.onReady) {
          // SEC-M3: surface a throwing onReady instead of swallowing it. The
          // derivation/delivery flow must NOT break for other protocols, so we
          // still resolve `ready` and keep going — but a silent swallow left
          // the container inconsistent with no signal. There is no diagnostic
          // channel on the router for derivation-side events
          // (`_onUnauthorizedProtocol` is reserved for inbound-envelope
          // rejections), so console.warn with the router prefix is the fit.
          try {
            entry.onReady({ protocolNonce: nonce });
          } catch (e) {
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn(
                '[SHARCProtocolRouter] onReady threw for prefix "' + entry.prefix
                + '": ' + (e && e.message ? e.message : String(e))
              );
            }
          }
        }
        entry._resolveReady({ protocolNonce: nonce });
      })
      .catch((err) => {
        const wrapped = new Error(
          '[SHARCProtocolRouter] HMAC derivation failed for prefix "'
          + entry.prefix + '": '
          + (err && err.message ? err.message : String(err))
        );
        // SEC-H2: stable sentinel for container-side dispatch. The message
        // string is operator-facing; downstream code MUST match on `.code`,
        // not on substring, so future re-wording of the message cannot
        // silently break the protocol-router-derivation feature-load-failed
        // routing.
        /** @type {any} */ (wrapped).code = 'PROTOCOL_DERIVATION_FAILED';
        entry._rejectReady(wrapped);
      });
  }

  async _derive(prefix, placementSessionId) {
    const enc = new TextEncoder();
    const key = await this._crypto.subtle.importKey(
      'raw',
      enc.encode(this._rootNonce),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const message = prefix + ':' + placementSessionId;
    const sig = await this._crypto.subtle.sign('HMAC', key, enc.encode(message));
    // Slice raw bytes (16 = 128 bits) BEFORE encoding. Encoding first and
    // slicing the string would drop entropy to 96 bits.
    const truncated = new Uint8Array(sig).slice(0, 16);
    return _base64url(truncated);
  }

  _dispatch(event) {
    // Gate sequence (§ 3.2). Steps 1–4 are envelope-shape; step 5 picks the
    // owning protocol; steps 6–8 are silent-drop; step 9 emits.

    // 1. object check
    if (!event || typeof event.data !== 'object' || event.data === null) return;
    // 2. source === iframe.contentWindow (lazy getter — iframe may not exist yet)
    const iframe = this._iframeGetter();
    if (!iframe || event.source !== iframe.contentWindow) return;
    // 3. origin matches
    const expectedOrigin = this._expectedRendererOrigin();
    if (expectedOrigin === null || event.origin !== expectedOrigin) return;
    // 4. type is string
    if (typeof event.data.type !== 'string') return;

    // 5. prefix registered. SEC-M2: prefixes are colon-terminated (enforced at
    // register), so `startsWith` already pins the `:`-segment boundary — but
    // require a non-empty remaining segment too, so a bare prefix (`A:B:` with
    // no trailing type) cannot match. `A:B:` vs `A:BC:` stay disjoint because
    // neither colon-terminated prefix is a startsWith of the other.
    let entry = null;
    for (const candidate of this._protocols.values()) {
      if (event.data.type.startsWith(candidate.prefix)
          && event.data.type.length > candidate.prefix.length) {
        entry = candidate;
        break;
      }
    }
    if (entry === null) return;

    // 6. placementSessionId match
    if (event.data.placementSessionId !== this._expectedPlacementSessionId()) return;

    // 7. protocol nonce match (silent drop on mismatch or pre-derivation).
    //
    // The session-stable per-impression HMAC value authenticates every inbound
    // envelope on this protocol — `:rendered` (first render AND a legit
    // `document.open` reopen re-anchor) and `:failed`. The reverse-hash-chain
    // that formerly rotated this per generation is RETIRED (ADR 2026-06-15): the
    // post-render navigation backstop authenticates by MessagePort possession,
    // not by an in-realm secret, so there is nothing to rotate. A legit reopen
    // re-posts `:rendered` with this same gen-0 nonce (the renderer no longer
    // advances any chain); a real cross-document navigation has no prelude and
    // no nonce, so it cannot forge a `:rendered` to reach the reopen handler —
    // the backstop fires 2118 keyed on the port going unanswered, not on this
    // gate. (`:loadAck` no longer rides this window path at all — it is
    // delivered over the captured-native `port1` listener; see
    // `_bindProbePort` / `_dispatchRendererLoadAck` in sharc-container.js.)
    if (entry.protocolNonce === null) return;
    if (event.data.sharcNonce !== entry.protocolNonce) return;

    // 8. type declared
    const typeName = event.data.type.slice(entry.prefix.length);
    const decl = entry.types[typeName];
    if (!decl) return;
    if (decl.direction !== 'inbound' && decl.direction !== 'bidirectional') return;

    // 9. phase membership — the only gate that emits.
    const rejectionPhase = this._currentPhase;
    if (decl.phases.indexOf(rejectionPhase) === -1) {
      this._emitUnauthorizedProtocol(entry, 'out-of-phase', rejectionPhase);
      return;
    }

    const context = Object.freeze({
      type: typeName,
      phase: rejectionPhase,
      protocolNonce: entry.protocolNonce,
      raisedAt: Date.now(),
    });

    try {
      entry.handler(event.data, context);
    } catch (_) { /* handler errors are not the router's concern */ }
  }

  /**
   * Emits an `unauthorized_protocol` security event. The `rejectionPhase`
   * argument is captured by the caller at the point gate step 9 failed; the
   * router does NOT re-read `this._currentPhase` here (§ 8.3).
   *
   * @param {object|null} protocol
   * @param {'out-of-phase'|'nonce-mismatch'|'prefix-unregistered'} reason
   * @param {string} rejectionPhase
   * @private
   */
  _emitUnauthorizedProtocol(protocol, reason, rejectionPhase) {
    const payload = {
      type: 'unauthorized_protocol',
      severity: 'error',
      timestamp: Date.now(),
      placementSessionId: this._expectedPlacementSessionId(),
      // Static message — no attacker-controlled interpolation (§ 8.7).
      message: 'Envelope rejected by router (' + reason + ')',
      details: {
        type: protocol ? protocol.prefix : 'unknown-prefix',
        phase: rejectionPhase,
        reason: reason,
      },
    };
    try { this._onUnauthorizedProtocol(payload); } catch (_) { /* ignore */ }
  }
}

// Dual-mode export (matches sharc-protocol.js's pattern). Module form for
// rollup / Node imports; browser-global attachment via the entry-point shim.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHARCProtocolRouter };
}

export { SHARCProtocolRouter };
