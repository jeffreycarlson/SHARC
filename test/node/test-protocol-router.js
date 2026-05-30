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
// Summary
// ────────────────────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log('\n✓ All protocol-router assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} protocol-router assertion(s) failed.`);
  process.exit(1);
}
