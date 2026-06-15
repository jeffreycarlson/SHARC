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

// Length of the per-protocol reverse hash chain (C1 fresh-nonce-per-generation).
// Bounds the number of self-rewrite generations a single impression can rotate
// through. Far beyond any legitimate creative's reopen count (the #332 answered-
// probe-cycle ceiling throttles abusive reopen storms long before this), and the
// gen-0 anchor itself derives from the per-impression HMAC, so exhausting the
// chain only degrades to gate-unanswered (2118) — never a security regression.
const NONCE_CHAIN_LENGTH = 512;

// One SHA-256 step over a base64url nonce string → base64url(16 bytes). Same
// truncation shape as `_derive` (128 bits).
function _hashNonceStep(crypto, nonceStr) {
  const enc = new TextEncoder();
  return crypto.subtle.digest('SHA-256', enc.encode(nonceStr)).then((digest) => {
    const truncated = new Uint8Array(digest).slice(0, 16);
    return _base64url(truncated);
  });
}

// Build the REVERSE hash chain for forward-secure per-generation rotation (C1).
//
// From the gen-0 HMAC seed `r` compute `chain[i] = H^i(r)` for i in [0, L]:
//   chain[0] = r, chain[1] = H(r), ..., chain[L] = H^L(r) (the TIP).
// Generation g uses `chain[L - g]` as its nonce — so consuming generations walks
// the chain DOWN from the tip toward the seed, revealing PREIMAGES in reverse.
//
// Forward secrecy (the property a forward chain LACKS): generation g's nonce is
// `chain[L-g]`; generation g+1's is `chain[L-g-1]`. Anyone can verify
// `H(chain[L-g-1]) === chain[L-g]` (chain integrity), but recovering
// `chain[L-g-1]` from a HARVESTED `chain[L-g]` requires INVERTING SHA-256. So a
// nonce harvested in generation g cannot be advanced by the attacker to forge
// generation g+1 — which a forward chain (`next = H(current)`) would hand them
// for free. Both the container and the renderer build the identical chain from
// the same per-impression seed, so neither puts any generation's nonce on the
// wire.
//
// Maps a generation index to its gate nonce on the reverse chain. Generation 0
// is the per-impression HMAC value (NOT on this chain — handled separately), so
// gen-0 returns null. Generation g ≥ 1 uses chain[L-(g-1)] = chain[length-g]
// (gen-1 = the tip, walking DOWN toward the seed as generations advance).
// Returns null past the chain end (exhausted) so the gate fails closed.
function _chainNonceForGen(chain, gen) {
  if (!chain || gen < 1) return null;
  const idx = chain.length - gen;
  return idx >= 0 ? chain[idx] : null;
}

// @returns {Promise<string[]>} chain[0..L].
function _buildReverseNonceChain(crypto, seed) {
  const chain = new Array(NONCE_CHAIN_LENGTH + 1);
  chain[0] = seed;
  let i = 1;
  function step() {
    if (i > NONCE_CHAIN_LENGTH) return chain;
    return _hashNonceStep(crypto, chain[i - 1]).then((h) => {
      chain[i] = h;
      i += 1;
      return step();
    });
  }
  return Promise.resolve().then(step);
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
   * Commits the staged next-generation gate nonce (C1 fresh-nonce-per-generation),
   * advancing the reverse hash chain ONE generation: `entry.protocolNonce` ←
   * `entry._nextNonce`, and re-stages the following generation. Called by the
   * gate (step 7) the instant it accepts a next-generation nonce — i.e. a LEGIT
   * reopen whose re-injected prelude posted `chain[L-(g)]` (the next preimage).
   *
   * This is what closes C1 (SE re-review): once a reopen advances the chain, a
   * nonce HARVESTED in the prior generation (via a Document.prototype.querySelector
   * / Node.prototype.removeChild trap firing during the prelude's self-removal)
   * is DEAD for every subsequent gate — recovering the next generation's value
   * from a harvested one requires INVERTING SHA-256 (the chain is REVERSED; a
   * naive FORWARD chain `next = H(current)` would instead hand the attacker the
   * next generation for one hash). A real post-render navigation supplies no
   * re-injected prelude → it can only replay a stale harvested nonce, which the
   * advanced gate rejects → 2118 fires.
   *
   * #321 router-guard honored: the router's OWN primitive over the SAME
   * placementSessionId and validated origin — no new trust grant, no
   * router-contract/wire change beyond rotating the per-protocol nonce. Does NOT
   * re-fire `onReady`: the `_rendererProtocolNonce` mirror carries the
   * generation-0 anchor (the URL-fragment value), which never changes — only the
   * GATE nonce rotates.
   *
   * @param {string} prefix
   * @returns {string|null} the committed nonce, or null if none was staged
   *   (chain exhausted, or the chain not yet built).
   */
  commitNextNonce(prefix) {
    const entry = this._protocols.get(prefix);
    if (!entry || !entry._nextNonce) return null;
    const next = entry._nextNonce;
    entry.protocolNonce = next;
    entry._genIndex += 1;
    // Re-stage the following generation synchronously (chain is prebuilt) so the
    // accepted {current, next} window stays exactly one generation ahead. Null
    // at the chain end (exhausted) → subsequent reopens fail closed.
    entry._nextNonce = _chainNonceForGen(entry._nonceChain, entry._genIndex + 1);
    return next;
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
        // Generation 0 is the per-impression HMAC value, UNCHANGED — it remains
        // the gate nonce (`entry.protocolNonce`), the `onReady`-delivered value
        // (the container's `_rendererProtocolNonce` mirror + URL fragment), and
        // the `buildOutbound` :render nonce. Gen-0 is NOT harvestable: the gen-0
        // prelude self-removes BEFORE the creative's first script (which installs
        // the harvest traps) runs, and the fragment is cleared before creative
        // code executes.
        entry.protocolNonce = nonce;
        entry._genIndex = 0;
        entry._nextNonce = null;
        // C1 reverse hash chain for generations ≥ 1 (the harvestable reopens).
        // Both sides derive the SAME chain seed `s = H(gen0)` and build
        // chain[0..L]; generation g (g ≥ 1) uses chain[L-(g-1)] — gen-1 = tip.
        // Advancing reveals PREIMAGES, so a harvested generation-g nonce cannot
        // yield generation g+1 (would require inverting SHA-256). The gen-0 → 1
        // transition is a fresh-chain jump (gen-1 = H^L(s)), so even though `s`
        // is derivable from gen-0, the attacker harvests gen-1 (not gen-0) and
        // cannot walk BACKWARD from it. Built async, off the gate path; the
        // FIRST reopen cannot occur until the creative has rendered + reopened,
        // well after this resolves.
        _hashNonceStep(this._crypto, nonce)
          .then((s) => _buildReverseNonceChain(this._crypto, s))
          .then((chain) => {
            entry._nonceChain = chain;
            // Stage generation 1 (the chain tip) so the first reopen's
            // next-generation nonce is accepted the moment it arrives.
            entry._nextNonce = _chainNonceForGen(chain, 1);
          })
          .catch(() => { /* chain unavailable → reopens fail closed (2118) */ });
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
    // C1 reverse-chain rotation. The gate validates against a forward-secure
    // reverse hash chain: generation g's nonce is chain[L-(g-1)] for g ≥ 1
    // (gen-0 = the per-impression HMAC value); advancing a generation reveals the
    // PREIMAGE, which a HARVESTED later-chain value cannot yield (SHA-256 is
    // one-way). The accepted window is exactly {current, staged-next}:
    //
    //   a. `sharcNonce === entry.protocolNonce` (CURRENT generation) — carries
    //      same-generation traffic: the loadAck answering this generation's
    //      probe, AND a benign post-render re-load whose still-present prelude
    //      re-answers with the current nonce (no document replacement). The
    //      renderer does NOT advance on a benign load, so it keeps answering
    //      current — which must stay accepted (corpus: nested-iframe / srcdoc
    //      subresource loads that re-fire the element load).
    //   b. `sharcNonce === entry._nextNonce` (staged NEXT generation) — a LEGIT
    //      reopen advancing the chain. Accept and COMMIT (current ← next,
    //      re-stage next+1). Driving the advance off the gate (not the iframe
    //      `load`) is essential: a document.write reopen does NOT reliably fire
    //      its own element load, but it ALWAYS re-posts `:rendered`/`:loadAck`
    //      with the next-generation nonce.
    //
    // C1 GUARANTEE: a nonce harvested in generation g is DEAD for generation
    // g+1's gate. Once a legit reopen advances current to g+1 (case b), the
    // window is {g+1, g+2}; a forged `:loadAck` replaying the harvested g (a real
    // post-render navigation has no re-injected prelude, only the harvested
    // value) is < current → rejected → gate unanswered → 2118. The reverse chain
    // also blocks the forward-hash attack: H(harvested g) = g-1's value (a PAST
    // generation), never g+1.
    if (entry.protocolNonce === null) return;
    if (entry._nextNonce && event.data.sharcNonce === entry._nextNonce) {
      // Case b — legit reopen to the next generation. Commit (advance + re-stage).
      this.commitNextNonce(entry.prefix);
    } else if (event.data.sharcNonce === entry.protocolNonce) {
      // Case a — current-generation traffic (loadAck / benign re-answer).
    } else {
      return;
    }

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
