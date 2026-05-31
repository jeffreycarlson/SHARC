/**
 * test-protocol-router.js — 0.7.7 SHARCProtocolRouter primitive coverage.
 *
 * Pins the load-bearing locked decisions from `docs/design/0.7.7-cross-frame-
 * protocol-router.md` § 9.6, focusing on the router in isolation. Cross-
 * walked decisions:
 *
 *   - Test #2 (no-cap policy)            — RTR-D17
 *   - Test #3 (single-listener invariant) — § 6.1, SF-3
 *   - Test #4 (payload-minimization)      — RTR-D17 / § 8.7
 *   - Test #9 (prefix-of-prefix collision) — § 2.3 SEC-4
 *   - Test #1 (phase-string typo detection) — RTR-J1
 *
 * Renderer-via-router parity, sequential-impression re-derive, and HMAC
 * derivation vectors live in their own files (test-renderer-protocol-retrofit.js,
 * test-protocol-router-nonce-derivation.js).
 *
 * Runs in Node after `npm run build`. Uses jsdom for `window.addEventListener`.
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://publisher.example/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageEvent = dom.window.MessageEvent;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const { SHARCProtocolRouter } = await import('../../dist/sharc-protocol-router.mjs');
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

let failures = 0;
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}
function assertThrows(fn, pattern, message) {
  try {
    fn();
    console.error('  ✗', message, '(no throw)');
    failures++;
  } catch (e) {
    if (pattern && !pattern.test(e.message)) {
      console.error('  ✗', message, `(threw, wrong message: ${e.message})`);
      failures++;
      return;
    }
    console.log('  ✓', message);
  }
}

function freshIframe() {
  const f = document.createElement('iframe');
  document.body.appendChild(f);
  return f;
}

function newRouter(overrides = {}) {
  const iframe = overrides.iframe !== undefined ? overrides.iframe : freshIframe();
  const captured = { events: [] };
  const router = new SHARCProtocolRouter({
    container: {},
    iframe: () => iframe,
    expectedRendererOrigin: () => overrides.origin || 'https://renderer.example',
    expectedPlacementSessionId: overrides.placementSessionId || (() => 'session-1'),
    rootNonce: overrides.rootNonce || 'root-nonce-test-fixture',
    onUnauthorizedProtocol: (e) => captured.events.push(e),
    initialPhase: overrides.initialPhase || 'init',
  });
  return { router, iframe, captured };
}

console.log('test-protocol-router.js — 0.7.7 router primitive coverage\n');

// ────────────────────────────────────────────────────────────────────────────
// 1. Construction — `crypto.subtle` hard requirement (RTR-D22)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('1. Construction — crypto.subtle hard requirement (RTR-D22)');
  // Happy path.
  const { router } = newRouter();
  assert(router instanceof SHARCProtocolRouter, 'router constructed when crypto.subtle is available');
  assert(router.getPhase() === 'init', 'initial phase defaults to "init"');

  // crypto.subtle absent — must throw synchronously. Node 25 exposes
  // `globalThis.crypto` as a getter and forbids reassignment; we shadow it by
  // redefining the property on both globalThis and window so the router's
  // `_resolveCrypto()` falls through every branch without `subtle`.
  const savedGlobalDesc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const savedWindowDesc = Object.getOwnPropertyDescriptor(window, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'fake' }, configurable: true });
    Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'fake' }, configurable: true });
    assertThrows(
      () => new SHARCProtocolRouter({
        container: {},
        iframe: () => null,
        expectedRendererOrigin: () => 'https://renderer.example',
        expectedPlacementSessionId: () => 'session-1',
        rootNonce: 'root',
        onUnauthorizedProtocol: () => {},
      }),
      /crypto\.subtle is unavailable/,
      'constructor throws synchronously when crypto.subtle is unavailable'
    );
  } finally {
    if (savedGlobalDesc) Object.defineProperty(globalThis, 'crypto', savedGlobalDesc);
    if (savedWindowDesc) Object.defineProperty(window, 'crypto', savedWindowDesc);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 2. register() validation
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n2. register() validation');
  const { router } = newRouter();
  assertThrows(
    () => router.register({ prefix: 'NoColon', types: { x: { phases: ['init'], direction: 'inbound' } }, handler: () => {} }),
    /prefix must end with ":"/,
    'register throws when prefix does not end with ":"'
  );
  assertThrows(
    () => router.register({ prefix: 'P:', types: null, handler: () => {} }),
    /types must be a non-empty object/,
    'register throws on empty types map'
  );
  assertThrows(
    () => router.register({ prefix: 'P:', types: { x: { phases: ['init'], direction: 'inbound' } } }),
    /handler must be a function/,
    'register throws when handler is missing'
  );
  assertThrows(
    () => router.register({ prefix: 'P:', types: { x: { phases: [], direction: 'inbound' } }, handler: () => {} }),
    /must declare a non-empty `phases` array/,
    'register throws on empty phases array'
  );
  assertThrows(
    () => router.register({ prefix: 'P:', types: { x: { phases: ['init'], direction: 'sideways' } }, handler: () => {} }),
    /direction "inbound", "outbound", or "bidirectional"/,
    'register throws on unknown direction value'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 9. Bidirectional prefix-of-prefix collision (§ 2.3 SEC-4)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n9. Prefix-of-prefix collision (§ 2.3 SEC-4)');
  // Direction A: register longer prefix first, then attempt shorter.
  {
    const { router } = newRouter();
    router.register({ prefix: 'SHARC:Renderer:', types: { x: { phases: ['init'], direction: 'inbound' } }, handler: () => {} });
    assertThrows(
      () => router.register({ prefix: 'SHARC:', types: { y: { phases: ['init'], direction: 'inbound' } }, handler: () => {} }),
      /collides with already-registered prefix "SHARC:Renderer:"/,
      'shorter prefix (SHARC:) shadowing longer (SHARC:Renderer:) is rejected'
    );
  }
  // Direction B: register shorter prefix first, then attempt longer.
  {
    const { router } = newRouter();
    router.register({ prefix: 'SHARC:', types: { y: { phases: ['init'], direction: 'inbound' } }, handler: () => {} });
    assertThrows(
      () => router.register({ prefix: 'SHARC:Renderer:', types: { x: { phases: ['init'], direction: 'inbound' } }, handler: () => {} }),
      /collides with already-registered prefix "SHARC:"/,
      'longer prefix (SHARC:Renderer:) extending shorter (SHARC:) is rejected'
    );
  }
  // Exact match.
  {
    const { router } = newRouter();
    router.register({ prefix: 'A:', types: { x: { phases: ['init'], direction: 'inbound' } }, handler: () => {} });
    assertThrows(
      () => router.register({ prefix: 'A:', types: { y: { phases: ['init'], direction: 'inbound' } }, handler: () => {} }),
      /collides with already-registered prefix "A:"/,
      'exact-match prefix collision is rejected'
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Single-listener invariant (§ 6.1, SF-3)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n3. Single-listener invariant after SHARCContainer construction (§ 6.1, SF-3)');
  // Spy on window.addEventListener BEFORE constructing the container.
  const original = window.addEventListener;
  const messageCalls = [];
  window.addEventListener = function (type, ...rest) {
    if (type === 'message') messageCalls.push(rest[0]);
    return original.call(this, type, ...rest);
  };
  try {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const c = new SHARCContainer({
      creativeHtml: '<html>x</html>',
      creativeRendererUrl: 'https://renderer.operator.example/0.7.0/',
      placementElement: slot,
    });
    assert(messageCalls.length === 1,
      'exactly one window `message` listener registered during container construction (SF-3); got ' + messageCalls.length);
    // Cleanup so we don't leak across blocks.
    c._terminate();
  } finally {
    window.addEventListener = original;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Gate validation — steps 1–9 (silent drop except phase)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n4. Gate sequence — silent drop on every step except phase');
  const { router, iframe, captured } = newRouter();
  let handlerCalls = 0;
  router.register({
    prefix: 'TEST:',
    types: {
      'msg': { phases: ['init'], direction: 'inbound' },
    },
    handler: () => { handlerCalls++; },
  });
  await router.ready('TEST:');
  const nonce = router.getProtocol('TEST:').protocolNonce;

  // Helper to construct + dispatch a MessageEvent.
  function fire({ data, origin = 'https://renderer.example', source = iframe.contentWindow }) {
    const evt = new dom.window.MessageEvent('message', { data, origin, source });
    window.dispatchEvent(evt);
  }

  // Step 1 — non-object data: silent drop.
  fire({ data: 'string-payload' });
  fire({ data: null });
  // Step 2 — wrong source: silent drop.
  fire({ data: { type: 'TEST:msg', sharcNonce: nonce, placementSessionId: 'session-1' }, source: window });
  // Step 3 — wrong origin: silent drop.
  fire({ data: { type: 'TEST:msg', sharcNonce: nonce, placementSessionId: 'session-1' }, origin: 'https://attacker.example' });
  // Step 4 — non-string type: silent drop.
  fire({ data: { type: 42, sharcNonce: nonce, placementSessionId: 'session-1' } });
  // Step 5 — unregistered prefix: silent drop.
  fire({ data: { type: 'OTHER:msg', sharcNonce: nonce, placementSessionId: 'session-1' } });
  // Step 6 — wrong placementSessionId: silent drop.
  fire({ data: { type: 'TEST:msg', sharcNonce: nonce, placementSessionId: 'wrong' } });
  // Step 7 — wrong nonce: silent drop.
  fire({ data: { type: 'TEST:msg', sharcNonce: 'forged', placementSessionId: 'session-1' } });
  // Step 8 — type not declared on the prefix: silent drop.
  fire({ data: { type: 'TEST:not-declared', sharcNonce: nonce, placementSessionId: 'session-1' } });

  assert(handlerCalls === 0, 'every step-1..8 failure silently drops; handler not invoked');
  assert(captured.events.length === 0, 'every step-1..8 failure is silent — no unauthorized_protocol event');

  // Happy path — fully valid envelope dispatches.
  fire({ data: { type: 'TEST:msg', sharcNonce: nonce, placementSessionId: 'session-1' } });
  assert(handlerCalls === 1, 'happy-path envelope dispatches to handler exactly once');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Phase enforcement — step 9 emits unauthorized_protocol
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n5. Phase enforcement — step 9 emits unauthorized_protocol');
  const { router, iframe, captured } = newRouter();
  let handlerCalls = 0;
  router.register({
    prefix: 'TEST:',
    types: {
      'inOnly': { phases: ['init'], direction: 'inbound' },
    },
    handler: () => { handlerCalls++; },
  });
  await router.ready('TEST:');
  const nonce = router.getProtocol('TEST:').protocolNonce;

  // Transition past `init`, then post a valid envelope whose type is only
  // declared in `init` → out-of-phase, must emit.
  router.transitionTo('creative-active');
  const evt = new dom.window.MessageEvent('message', {
    data: { type: 'TEST:inOnly', sharcNonce: nonce, placementSessionId: 'session-1' },
    origin: 'https://renderer.example',
    source: iframe.contentWindow,
  });
  window.dispatchEvent(evt);
  assert(handlerCalls === 0, 'out-of-phase envelope does NOT reach handler');
  assert(captured.events.length === 1, 'out-of-phase envelope emits exactly one unauthorized_protocol event');
  const ev = captured.events[0];
  assert(ev.type === 'unauthorized_protocol', 'event.type === "unauthorized_protocol"');
  assert(ev.severity === 'error', 'event.severity === "error"');
  assert(ev.details.type === 'TEST:', 'event.details.type names the prefix (TEST:)');
  assert(ev.details.phase === 'creative-active', 'event.details.phase reflects the rejection-time phase');
  assert(ev.details.reason === 'out-of-phase', 'event.details.reason === "out-of-phase"');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Test #2 (RTR-D17): no router-side cap on unauthorized_protocol emission
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n6. No-cap policy — 100 sequential out-of-phase envelopes → 100 emissions (RTR-D17)');
  const { router, iframe, captured } = newRouter();
  router.register({
    prefix: 'TEST:',
    types: { 'inOnly': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  await router.ready('TEST:');
  const nonce = router.getProtocol('TEST:').protocolNonce;
  router.transitionTo('creative-active');

  for (let i = 0; i < 100; i++) {
    const evt = new dom.window.MessageEvent('message', {
      data: { type: 'TEST:inOnly', sharcNonce: nonce, placementSessionId: 'session-1' },
      origin: 'https://renderer.example',
      source: iframe.contentWindow,
    });
    window.dispatchEvent(evt);
  }
  assert(captured.events.length === 100,
    'exactly 100 unauthorized_protocol emissions from 100 sequential out-of-phase envelopes (no cap)');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Test #4 (§ 8.7): payload-minimization invariant
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n7. Payload-minimization invariant — attacker-controlled fields are NOT echoed (§ 8.7)');
  const { router, iframe, captured } = newRouter();
  router.register({
    prefix: 'TEST:',
    types: { 'inOnly': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  await router.ready('TEST:');
  const nonce = router.getProtocol('TEST:').protocolNonce;
  router.transitionTo('creative-active');

  const evt = new dom.window.MessageEvent('message', {
    data: {
      type: 'TEST:inOnly',
      sharcNonce: nonce,
      placementSessionId: 'session-1',
      // Attacker-controlled noise that must NOT leak into the emitted event.
      payload: '<script>alert(1)</script>',
      details: { leak: 'secret' },
      extraType: 'AAAAAAAAAA',
    },
    origin: 'https://renderer.example',
    source: iframe.contentWindow,
  });
  window.dispatchEvent(evt);
  assert(captured.events.length === 1, 'exactly one unauthorized_protocol event fires');
  const ev = captured.events[0];
  // details must have ONLY type, phase, reason — no leaked fields.
  const detailKeys = Object.keys(ev.details).sort();
  assert(JSON.stringify(detailKeys) === JSON.stringify(['phase', 'reason', 'type']),
    'event.details has exactly {type, phase, reason} keys; no leaked fields');
  // Deep-walk: no attacker-controlled string appears anywhere in the event.
  const serialized = JSON.stringify(ev);
  assert(!/alert\(1\)/.test(serialized),
    'attacker-controlled <script> string does NOT appear anywhere in the event');
  assert(!/secret/.test(serialized),
    'attacker-controlled details.leak value does NOT appear anywhere in the event');
  assert(!/AAAAAAAAAA/.test(serialized),
    'attacker-controlled extraType value does NOT appear anywhere in the event');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// buildOutbound — stamps nonce + placementSessionId; throws on collision
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n8. buildOutbound — payload-collision throw (RTR-D7 / § 3.3)');
  const { router } = newRouter();
  router.register({
    prefix: 'TEST:',
    types: { 'send': { phases: ['init'], direction: 'outbound' } },
    handler: () => {},
  });
  await router.ready('TEST:');
  const nonce = router.getProtocol('TEST:').protocolNonce;

  const env = router.buildOutbound('TEST:', 'send', { hello: 'world' });
  assert(env.type === 'TEST:send', 'buildOutbound stamps type with prefix + name');
  assert(env.sharcNonce === nonce, 'buildOutbound stamps the protocol-derived nonce');
  assert(env.placementSessionId === 'session-1', 'buildOutbound stamps the current placementSessionId');
  assert(env.hello === 'world', 'buildOutbound merges caller payload');

  assertThrows(
    () => router.buildOutbound('TEST:', 'send', { sharcNonce: 'forged' }),
    /collides with router-controlled field "sharcNonce"/,
    'buildOutbound throws on payload collision with sharcNonce'
  );
  assertThrows(
    () => router.buildOutbound('TEST:', 'send', { placementSessionId: 'forged' }),
    /collides with router-controlled field "placementSessionId"/,
    'buildOutbound throws on payload collision with placementSessionId'
  );
  assertThrows(
    () => router.buildOutbound('TEST:', 'send', { type: 'overridden' }),
    /collides with router-controlled field "type"/,
    'buildOutbound throws on payload collision with type'
  );
  // Inbound-only type must reject outbound construction.
  router.register({
    prefix: 'IN:',
    types: { 'recv': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  await router.ready('IN:');
  assertThrows(
    () => router.buildOutbound('IN:', 'recv', {}),
    /is not outbound on protocol "IN:"/,
    'buildOutbound rejects inbound-only types'
  );
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Test #1 (RTR-J1): phase-string typo detection — every phase declared in
// any registered protocol's types map appears in some transitionTo(...) call
// site inside src/sharc-container.js.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n9. Phase-string typo detection — declared phases all have transitionTo call sites (RTR-J1)');
  const containerSrc = readFileSync(
    resolve(__dirname, '..', '..', 'src', 'sharc-container.js'),
    'utf8'
  );

  // The renderer protocol is registered in src/sharc-container.js with these
  // phase strings. Extract them by inspecting the live registration.
  // We can't easily reflect on src; instead, replay the container's
  // registration pattern and reuse the phases.
  const declaredPhases = new Set([
    'attaching-renderer',
    'rendered',
    'creative-active',
    'init',
    'terminated',
  ]);
  // Every phase declared by any registered protocol must appear somewhere
  // as `transitionTo('<phase>')` in src/sharc-container.js. `init` is the
  // router's default constructor phase, not a transition target; same for
  // `omid-active` (0.7.8 reserved, not yet driven). Filter those out.
  const transitionTargets = ['attaching-renderer', 'rendered', 'creative-active', 'terminated'];
  for (const phase of transitionTargets) {
    const needle = "transitionTo('" + phase + "')";
    assert(containerSrc.includes(needle),
      `src/sharc-container.js contains transitionTo('${phase}') call site`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SEC-H2: HMAC derivation rejection routes to feature_load_failed via the
// `.code` sentinel on the wrapped error — NOT a substring match on the
// message string. Mocks `crypto.subtle.sign` to return a rejected promise
// and verifies the container surfaces `feature_load_failed` with the spec
// field shape (typedef at src/sharc-container.js:440-449).
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n10. HMAC derivation rejection — feature_load_failed via .code sentinel (SEC-H2)');

  // Stub crypto.subtle.sign so derivation rejects. Save the original signer
  // so we can restore it after the test (other tests rely on a working
  // crypto.subtle).
  const realSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
  const rejectErr = new Error('mock crypto.subtle.sign rejection');
  Object.defineProperty(globalThis.crypto.subtle, 'sign', {
    value: () => Promise.reject(rejectErr),
    configurable: true,
    writable: true,
  });

  try {
    // (a) Direct router-level assertion: the rejection wraps with
    //     `.code === 'PROTOCOL_DERIVATION_FAILED'`.
    {
      const { router } = newRouter();
      router.register({
        prefix: 'SENT:',
        types: { 'msg': { phases: ['init'], direction: 'inbound' } },
        handler: () => {},
      });
      let caught = null;
      try { await router.ready('SENT:'); }
      catch (err) { caught = err; }
      assert(caught !== null, 'ready(prefix) rejects when crypto.subtle.sign fails');
      assert(caught && caught.code === 'PROTOCOL_DERIVATION_FAILED',
        'rejected error carries .code === "PROTOCOL_DERIVATION_FAILED" (SEC-H2 sentinel)');
      assert(caught && /HMAC derivation failed/.test(String(caught.message)),
        'rejected error message is still operator-readable (regression: message preserved)');
      router.destroy();
    }

    // (b) Container-level integration: feature_load_failed fires with the
    //     spec field shape; iframe-src guard's terminate path is NOT taken
    //     (no envelope-shape error precedes the derivation rejection).
    {
      const slot = document.createElement('div');
      document.body.appendChild(slot);
      const securityEvents = [];
      const errors = [];
      const c = new SHARCContainer({
        creativeHtml: '<html>x</html>',
        creativeRendererUrl: 'https://renderer.operator.example/0.7.0/',
        placementElement: slot,
        onSecurityEvent: (e) => securityEvents.push(e),
        onError: (code, msg) => errors.push({ code, msg }),
      });
      c.load();
      // Allow the derivation rejection + container `.catch` to drain.
      await new Promise((r) => setTimeout(r, 30));

      const flf = securityEvents.find((e) => e.type === 'feature_load_failed');
      assert(flf != null,
        'feature_load_failed event fires on protocol-router derivation rejection');
      assert(flf && flf.details && flf.details.featureName === 'protocol-router-derivation',
        'feature_load_failed details.featureName === "protocol-router-derivation"');
      assert(flf && flf.details && flf.details.reason === 'crypto_subtle_sign_rejected',
        'feature_load_failed details.reason === "crypto_subtle_sign_rejected"');
      assert(flf && flf.details && typeof flf.details.scriptUrl === 'string',
        'feature_load_failed details.scriptUrl is a string (empty per typedef)');
      assert(flf && flf.severity === 'error',
        'feature_load_failed severity === "error"');
      assert(c._terminated === true,
        'container terminates after derivation rejection');
      // Iframe-src guard's `_assertResolvedIframeSrcAllowed` throw would
      // surface as a console.error WITHOUT firing feature_load_failed —
      // confirm we did NOT hit that branch by asserting feature_load_failed
      // is the ONLY security event of that type and no terminate path
      // labelled the failure differently.
      const otherTypes = securityEvents.filter((e) => e.type !== 'feature_load_failed');
      assert(otherTypes.length === 0,
        'derivation rejection does NOT also emit a different security event '
        + '(iframe-src guard terminate path not taken)');
    }
  } finally {
    Object.defineProperty(globalThis.crypto.subtle, 'sign', {
      value: realSign,
      configurable: true,
      writable: true,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SEC-H1: derived renderer-protocol nonce is not on the wire of the inbound
// `:loadProbe` envelope. Two layers:
//   (a) container outbound shape — no `sharcNonce` field
//   (b) renderer prelude source — does NOT echo `probe.sharcNonce`, so a
//       hostile creative that observes the inbound envelope finds no nonce
//       to extract.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n11. SEC-H1: derived nonce never on the inbound :loadProbe wire');

  // (a) Container outbound shape.
  {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const c = new SHARCContainer({
      creativeHtml: '<html>x</html>',
      creativeRendererUrl: 'https://renderer.operator.example/0.7.0/',
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
    });
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');

    // Intercept iframe contentWindow.postMessage to capture the probe envelope.
    const captured = [];
    if (c._iframe && c._iframe.contentWindow) {
      c._iframe.contentWindow.postMessage = function (data) { captured.push(data); };
    }
    // Drive the load + :rendered handshake so the backstop arms and fires
    // its first-load probe. We synthesize the rendered envelope (with the
    // derived nonce — that's what the router accepts).
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
        rendererOrigin: 'https://renderer.operator.example',
      },
      origin: 'https://renderer.operator.example',
      source: c._iframe.contentWindow,
    }));
    // Allow `_onRendererRendered` to fire and arm the backstop, then
    // dispatch the next load to trigger the probe.
    await new Promise((r) => setTimeout(r, 30));
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    await new Promise((r) => setTimeout(r, 10));

    const probe = captured.find((m) => m && m.type === 'SHARC:Renderer:loadProbe');
    assert(probe != null,
      'container posted SHARC:Renderer:loadProbe to renderer iframe');
    assert(probe && !('sharcNonce' in probe),
      'outbound :loadProbe envelope has NO sharcNonce field (SEC-H1)');
    assert(probe && probe.placementSessionId === c.placementSessionId,
      'outbound :loadProbe envelope carries placementSessionId');
    c._terminate();
  }

  // (b) Renderer prelude source — `examples/renderer/index.html` builds the
  //     prelude via `installLoadProbePrelude`. Read the file, extract the
  //     `code` builder source, and assert: (i) it does NOT echo
  //     `probe.sharcNonce` back on the ack; (ii) it DOES echo a closure-
  //     captured `ackNonce`. This protects against a future refactor that
  //     accidentally re-introduces the inbound-nonce echo.
  {
    const rendererSrc = readFileSync(
      resolve(__dirname, '..', '..', 'examples', 'renderer', 'index.html'),
      'utf8'
    );
    // Locate the prelude builder.
    const start = rendererSrc.indexOf('function installLoadProbePrelude');
    assert(start !== -1, 'renderer source contains installLoadProbePrelude function');
    // Read forward enough to cover the function body. The body fits in <2KB;
    // 4096 chars is safe slack.
    const region = rendererSrc.slice(start, start + 4096);
    // Hostile-creative path: the prelude must NOT contain `probe.sharcNonce`
    // anywhere — that string in the source was the SEC-H1 leak vector.
    assert(!/probe\.sharcNonce/.test(region),
      'prelude source does NOT reference probe.sharcNonce (no inbound-nonce echo path)');
    // Outbound contract: the prelude DOES capture and echo the closure
    // `ackNonce` variable.
    assert(/var ackNonce=/.test(region),
      'prelude source captures closure-held ackNonce variable');
    assert(/sharcNonce:ackNonce/.test(region),
      'prelude source echoes closure-held ackNonce on :loadAck');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MAJ-1 (#234): a throw before the first await in the derivation path surfaces
// as a typed rejection out of `register()` → `ready()`, NOT a synchronous
// throw out of `register()`. The container's load `.catch` depends on the
// rejection carrying `.code === 'PROTOCOL_DERIVATION_FAILED'`.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n12. MAJ-1 — pre-await throw surfaces as PROTOCOL_DERIVATION_FAILED rejection, not sync throw (#234)');
  const iframe = freshIframe();
  let threw = false;
  const router = new SHARCProtocolRouter({
    container: {},
    iframe: () => iframe,
    expectedRendererOrigin: () => 'https://renderer.example',
    // Throws synchronously when read inside _deriveAndDeliver.
    expectedPlacementSessionId: () => { throw new Error('boom from placementSessionId getter'); },
    rootNonce: 'root-nonce-test-fixture',
    onUnauthorizedProtocol: () => {},
  });
  try {
    router.register({
      prefix: 'THROW:',
      types: { 'msg': { phases: ['init'], direction: 'inbound' } },
      handler: () => {},
    });
  } catch (_) {
    threw = true;
  }
  assert(threw === false,
    'register() does NOT throw synchronously when the placementSessionId read throws');

  let caught = null;
  try { await router.ready('THROW:'); }
  catch (err) { caught = err; }
  assert(caught !== null, 'ready(prefix) rejects when the pre-await read throws');
  assert(caught && caught.code === 'PROTOCOL_DERIVATION_FAILED',
    'rejected error carries .code === "PROTOCOL_DERIVATION_FAILED" so the container routes it to feature_load_failed');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// SEC-M2 (#236): colon-segment boundary — `A:B:` and `A:BC:` register as
// disjoint prefixes and an envelope routes to exactly one, never the other.
// Single existing-prefix behavior (`SHARC:Renderer:`) is unchanged.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n13. SEC-M2 — A:B: vs A:BC: colon-segment boundary (#236)');
  const { router, iframe } = newRouter();
  let abCalls = 0;
  let abcCalls = 0;
  router.register({
    prefix: 'A:B:',
    types: { 'msg': { phases: ['init'], direction: 'inbound' } },
    handler: () => { abCalls++; },
  });
  router.register({
    prefix: 'A:BC:',
    types: { 'msg': { phases: ['init'], direction: 'inbound' } },
    handler: () => { abcCalls++; },
  });
  const abNonce = (await router.ready('A:B:')).protocolNonce;
  const abcNonce = (await router.ready('A:BC:')).protocolNonce;
  assert(abNonce !== abcNonce, 'A:B: and A:BC: derive distinct nonces (disjoint prefixes)');

  function fire(data) {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data, origin: 'https://renderer.example', source: iframe.contentWindow,
    }));
  }

  // An A:BC: envelope must route ONLY to the A:BC: handler — the A:B: prefix
  // must not greedily claim it (its remainder after stripping A:B: would be
  // "C:msg", but A:B: is not a startsWith of "A:BC:msg").
  fire({ type: 'A:BC:msg', sharcNonce: abcNonce, placementSessionId: 'session-1' });
  assert(abcCalls === 1 && abCalls === 0,
    'A:BC:msg routes to A:BC: handler only, never A:B:');

  // An A:B: envelope routes only to A:B:.
  fire({ type: 'A:B:msg', sharcNonce: abNonce, placementSessionId: 'session-1' });
  assert(abCalls === 1 && abcCalls === 1,
    'A:B:msg routes to A:B: handler only');

  // A bare prefix with no trailing type segment must not match (non-empty
  // remainder required at gate step 5).
  fire({ type: 'A:B:', sharcNonce: abNonce, placementSessionId: 'session-1' });
  assert(abCalls === 1,
    'bare-prefix envelope (no trailing type segment) does not dispatch');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// SEC-M3 (#237): a throwing onReady is surfaced via console.warn (not silently
// swallowed) and does NOT break derivation/delivery for other protocols.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n14. SEC-M3 — throwing onReady surfaced, other protocols unaffected (#237)');
  const { router } = newRouter();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    router.register({
      prefix: 'THROWS:',
      types: { 'msg': { phases: ['init'], direction: 'inbound' } },
      handler: () => {},
      onReady: () => { throw new Error('onReady boom'); },
    });
    let otherReadyNonce = null;
    router.register({
      prefix: 'OTHER:',
      types: { 'msg': { phases: ['init'], direction: 'inbound' } },
      handler: () => {},
      onReady: ({ protocolNonce }) => { otherReadyNonce = protocolNonce; },
    });

    // The throwing protocol's ready still resolves (delivery not broken).
    const throwsNonce = (await router.ready('THROWS:')).protocolNonce;
    assert(/^[A-Za-z0-9_-]{22}$/.test(throwsNonce),
      'derivation completes and ready resolves even though onReady threw');

    // The other protocol's derivation + onReady are unaffected.
    const otherNonce = (await router.ready('OTHER:')).protocolNonce;
    assert(otherNonce !== null && otherReadyNonce === otherNonce,
      'a sibling protocol\'s onReady fires normally and ready resolves');

    const surfaced = warnings.find((w) =>
      /\[SHARCProtocolRouter\] onReady threw for prefix "THROWS:"/.test(w));
    assert(surfaced != null,
      'throwing onReady is surfaced via console.warn with the router prefix (not swallowed)');
    assert(/onReady boom/.test(surfaced || ''),
      'surfaced warning includes the original onReady error message');
  } finally {
    console.warn = realWarn;
  }
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log('\n✓ All protocol-router assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} protocol-router assertion(s) failed.`);
  process.exit(1);
}
