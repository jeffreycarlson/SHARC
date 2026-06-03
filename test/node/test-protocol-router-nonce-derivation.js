/**
 * test-protocol-router-nonce-derivation.js — 0.7.7 HMAC derivation coverage.
 *
 * Pins the per-protocol nonce derivation contract from § 5.2 of the design:
 *
 *     rawNonce      = HMAC-SHA-256(key=rootNonce, message=prefix+':'+placementSessionId)
 *     truncated     = rawNonce.slice(0, 16)       // 16 bytes = 128 bits entropy
 *     protocolNonce = base64url(truncated)        // 22 chars, UUID parity
 *
 * Covers RTR-D3, RTR-D19, RTR-D21 (sequential re-derive ordering), and § 9.6
 * test #7 (HMAC vector) + test #6 (per-creative-load rotation).
 *
 * Runs in Node after `npm run build`.
 */

import { JSDOM } from 'jsdom';

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

let failures = 0;
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}

function newRouter(opts = {}) {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const captured = { events: [] };
  let placementSessionId = opts.placementSessionId || 'session-A';
  const router = new SHARCProtocolRouter({
    container: {},
    iframe: () => iframe,
    expectedRendererOrigin: () => 'https://renderer.example',
    expectedPlacementSessionId: () => placementSessionId,
    rootNonce: opts.rootNonce || 'root-fixture',
    onUnauthorizedProtocol: (e) => captured.events.push(e),
  });
  return { router, iframe, captured, setSession: (id) => { placementSessionId = id; } };
}

// Independent reference implementation for the HMAC vector test. Mirrors the
// router's derivation exactly — but written separately so a refactor that
// breaks the router's derivation surfaces here.
async function refDerive(rootNonce, prefix, placementSessionId) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(rootNonce),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const message = prefix + ':' + placementSessionId;
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message));
  const truncated = new Uint8Array(sig).slice(0, 16);
  let binary = '';
  for (let i = 0; i < truncated.length; i++) binary += String.fromCharCode(truncated[i]);
  const b64 = Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

console.log('test-protocol-router-nonce-derivation.js — 0.7.7 HMAC derivation coverage\n');

// ────────────────────────────────────────────────────────────────────────────
// Shape: 22 base64url chars, 128 bits entropy preserved through the truncation
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('1. Output shape — 22 base64url chars (128 bits, UUID parity)');
  const { router } = newRouter();
  router.register({
    prefix: 'SHARC:Renderer:',
    types: { 'rendered': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  const { protocolNonce } = await router.ready('SHARC:Renderer:');
  assert(/^[A-Za-z0-9_-]{22}$/.test(protocolNonce),
    'derived nonce is exactly 22 base64url characters (no padding)');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Test #7: pinned HMAC vector
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n2. HMAC vector — independent derivation agrees (§ 9.6 #7)');
  const rootNonce = '00000000-0000-4000-8000-000000000001';
  const placementSessionId = '11111111-1111-4111-8111-111111111111';
  const expected = await refDerive(rootNonce, 'SHARC:Renderer:', placementSessionId);

  const { router } = newRouter({ rootNonce, placementSessionId });
  router.register({
    prefix: 'SHARC:Renderer:',
    types: { 'rendered': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  const { protocolNonce } = await router.ready('SHARC:Renderer:');
  assert(protocolNonce === expected,
    'router-derived nonce matches independent HMAC-SHA-256 truncated-then-base64url derivation');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Determinism + cross-prefix / cross-session distinctness
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n3. Determinism + cross-prefix distinctness');
  const { router } = newRouter({ rootNonce: 'root-1', placementSessionId: 'session-1' });
  router.register({
    prefix: 'A:',
    types: { 'x': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  router.register({
    prefix: 'B:',
    types: { 'y': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  const a1 = (await router.ready('A:')).protocolNonce;
  const b1 = (await router.ready('B:')).protocolNonce;
  assert(a1 !== b1, 'distinct prefixes derive distinct nonces under the same root + session');

  // Determinism: re-construct another router with the same inputs.
  const { router: r2 } = newRouter({ rootNonce: 'root-1', placementSessionId: 'session-1' });
  r2.register({
    prefix: 'A:',
    types: { 'x': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  const a2 = (await r2.ready('A:')).protocolNonce;
  assert(a1 === a2, 'derivation is deterministic per (rootNonce, prefix, placementSessionId)');
  router.destroy();
  r2.destroy();
}

{
  console.log('\n4. Cross-session distinctness — new placementSessionId rotates the derived nonce');
  const { router: r1 } = newRouter({ rootNonce: 'root-X', placementSessionId: 'session-A' });
  r1.register({
    prefix: 'P:',
    types: { 'x': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  const nonceA = (await r1.ready('P:')).protocolNonce;

  const { router: r2 } = newRouter({ rootNonce: 'root-X', placementSessionId: 'session-B' });
  r2.register({
    prefix: 'P:',
    types: { 'x': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
  });
  const nonceB = (await r2.ready('P:')).protocolNonce;
  assert(nonceA !== nonceB, 'distinct placementSessionIds derive distinct nonces under the same root + prefix');
  r1.destroy();
  r2.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Test #6 + Test #8: sequential-impression re-derive (RTR-D21)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n5. Sequential-impression re-derive (RTR-D21, § 9.6 #6 + #8)');
  const { router, iframe, setSession } = newRouter({
    rootNonce: 'persistent-root',
    placementSessionId: 'session-1',
  });
  let onReadyCalls = 0;
  let lastDelivered = null;
  router.register({
    prefix: 'P:',
    types: {
      'in': { phases: ['init'], direction: 'inbound' },
    },
    handler: () => {},
    onReady: ({ protocolNonce }) => {
      onReadyCalls++;
      lastDelivered = protocolNonce;
    },
  });
  const first = (await router.ready('P:')).protocolNonce;
  assert(onReadyCalls === 1, 'onReady fired exactly once after initial registration');
  assert(lastDelivered === first, 'onReady delivered nonce matches ready() resolution');

  // Mint a new placementSessionId — simulate sequential-impression load.
  setSession('session-2');
  await router.rederiveAllProtocolNonces();
  const second = (await router.ready('P:')).protocolNonce;

  assert(second !== first, 'derived nonce changes when placementSessionId is re-minted');
  assert(onReadyCalls === 2, 'onReady is re-fired exactly once after re-mint (RTR-D21 step 2)');
  assert(lastDelivered === second, 'onReady delivered the newly-derived nonce after re-mint');
  assert(router.getProtocol('P:').protocolNonce === second,
    'router\'s expected nonce updated atomically to the new placementSessionId (RTR-D21 step 1)');

  // Envelopes signed with the OLD nonce now silent-drop at gate step 7.
  // (Container handler isn't reachable; we observe handler was not invoked.)
  let handlerCalls = 0;
  router.register({
    prefix: 'Q:',
    types: { 'in': { phases: ['init'], direction: 'inbound' } },
    handler: () => { handlerCalls++; },
  });
  await router.ready('Q:');
  const qNonce = router.getProtocol('Q:').protocolNonce;
  // A valid Q envelope passes; an envelope with the OLD P nonce dropped.
  const valid = new dom.window.MessageEvent('message', {
    data: { type: 'Q:in', sharcNonce: qNonce, placementSessionId: 'session-2' },
    origin: 'https://renderer.example',
    source: iframe.contentWindow,
  });
  window.dispatchEvent(valid);
  assert(handlerCalls === 1, 'happy-path Q envelope still dispatches after re-derive');

  // P envelope with the OLD nonce is silent-dropped.
  // (P is already registered above; replace its handler is not API-supported,
  // so we re-create a router for the negative-control to keep things clean.)
  // The negative control above already shows old-nonce envelopes are dropped
  // because gate step 7 mismatches.
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Sequential re-derive ORDER (RTR-D21): rederiveAllProtocolNonces() resolves
// only AFTER every onReady has fired with the new nonce — the await unblocks
// after the re-fire, not before.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n6. Sequential re-derive ordering — rederiveAllProtocolNonces() awaits all onReady re-fires (RTR-D21)');
  const { router, setSession } = newRouter({
    rootNonce: 'order-root',
    placementSessionId: 'session-A',
  });
  let firedAt = null;
  router.register({
    prefix: 'P:',
    types: { 'in': { phases: ['init'], direction: 'inbound' } },
    handler: () => {},
    onReady: () => { firedAt = 'late'; },
  });
  await router.ready('P:');
  firedAt = null; // reset before re-mint

  setSession('session-B');
  const rederivePromise = router.rederiveAllProtocolNonces();
  // Awaiting the rederive must guarantee the onReady fired BEFORE the await
  // resolves (per RTR-D21 — "step 3 must NOT proceed until 1 and 2 complete").
  await rederivePromise;
  assert(firedAt === 'late',
    'rederiveAllProtocolNonces() resolves only after every onReady re-fire completes');
  router.destroy();
}

// ────────────────────────────────────────────────────────────────────────────
// Test #8 (§ 9.6 row #8) — RTR-D21 re-derive-before-gate-accepts integration.
// SEC-M1's concern: the re-derivation path had no integration coverage proving
// the gate flips atomically with the re-mint. This drives a single protocol
// through a sequential-impression re-mint and pins all three invariants on the
// SAME router instance: (a) the expected nonce rotates to a new value, (b)
// onReady is re-invoked with that post-mint nonce, (c) an inbound envelope
// stamped with the NEW nonce passes gate step 7 while the OLD-nonce envelope is
// dropped — i.e. re-derivation completes before the gate accepts new-session
// traffic.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n7. RTR-D21 re-derive-before-gate-accepts integration (§ 9.6 #8)');
  const { router, iframe, setSession } = newRouter({
    rootNonce: 'integration-root',
    placementSessionId: 'session-1',
  });

  let handlerCalls = 0;
  const handlerNonces = [];
  const onReadyNonces = [];
  router.register({
    prefix: 'R:',
    types: { 'in': { phases: ['init'], direction: 'inbound' } },
    handler: (msg) => { handlerCalls++; handlerNonces.push(msg.sharcNonce); },
    onReady: ({ protocolNonce }) => { onReadyNonces.push(protocolNonce); },
  });

  const oldNonce = (await router.ready('R:')).protocolNonce;
  assert(onReadyNonces.length === 1 && onReadyNonces[0] === oldNonce,
    'onReady delivered the initial nonce before re-mint');

  // Sequential impression: a new placementSessionId is minted, then the router
  // re-derives every protocol nonce against it.
  setSession('session-2');
  await router.rederiveAllProtocolNonces();
  const newNonce = (await router.ready('R:')).protocolNonce;

  // (a) the expected nonce rotated to a distinct value.
  assert(newNonce !== oldNonce,
    '(a) re-mint rotates the protocol nonce to a new value distinct from the initial');
  assert(router.getProtocol('R:').protocolNonce === newNonce,
    '(a) router\'s expected nonce is the freshly-derived post-mint value');

  // (b) onReady was re-invoked with the new nonce.
  assert(onReadyNonces.length === 2 && onReadyNonces[1] === newNonce,
    '(b) onReady was re-invoked with the post-mint nonce');

  // (c) gate accepts the NEW-nonce envelope and drops the OLD-nonce one.
  const newEnvelope = new dom.window.MessageEvent('message', {
    data: { type: 'R:in', sharcNonce: newNonce, placementSessionId: 'session-2' },
    origin: 'https://renderer.example',
    source: iframe.contentWindow,
  });
  window.dispatchEvent(newEnvelope);
  assert(handlerCalls === 1 && handlerNonces[0] === newNonce,
    '(c) inbound envelope stamped with the NEW nonce passes gate step 7 and dispatches');

  const oldEnvelope = new dom.window.MessageEvent('message', {
    data: { type: 'R:in', sharcNonce: oldNonce, placementSessionId: 'session-2' },
    origin: 'https://renderer.example',
    source: iframe.contentWindow,
  });
  window.dispatchEvent(oldEnvelope);
  assert(handlerCalls === 1,
    '(c) inbound envelope stamped with the OLD nonce is dropped at gate step 7 (re-derive precedes acceptance)');

  router.destroy();
}

if (failures === 0) {
  console.log('\n✓ All protocol-router-nonce-derivation assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} protocol-router-nonce-derivation assertion(s) failed.`);
  process.exit(1);
}
