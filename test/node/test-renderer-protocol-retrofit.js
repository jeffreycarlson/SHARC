/**
 * test-renderer-protocol-retrofit.js — 0.7.7 renderer-via-router parity tests.
 *
 * Confirms behavior preservation for the renderer protocol after the 0.7.7
 * retrofit (§ 6 of the design). Specifically pins:
 *
 *   - § 9.6 #3 single-listener invariant during the load window
 *   - § 9.6 #5 bfcache nonce persistence (no rotation across pagehide/show)
 *   - Renderer envelope round-trip preserved bit-for-bit
 *   - Per-protocol prefix isolation — a second registered protocol's
 *     envelope does NOT reach the renderer handler
 *
 * Bulk renderer dispatch parity (envelope shapes, payload validation,
 * timeouts, origin echo) is exercised by test-creative-sources-load.js
 * which now drives every assertion through the router.
 *
 * Runs in Node after `npm run build`.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.operator.example/0.7.0/';
const RENDERER_ORIGIN = 'https://renderer.operator.example';
const CREATIVE_HTML = '<html><body>ad</body></html>';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function buildMarkup() {
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  return c;
}

console.log('test-renderer-protocol-retrofit.js — 0.7.7 renderer parity\n');

// ────────────────────────────────────────────────────────────────────────────
// Single-listener invariant — exactly one window 'message' listener after
// container construction (§ 9.6 #3).
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('1. Single-listener invariant during the entire load window (§ 9.6 #3)');
  const original = window.addEventListener;
  const messageListeners = [];
  window.addEventListener = function (type, ...rest) {
    if (type === 'message') messageListeners.push(rest[0]);
    return original.call(this, type, ...rest);
  };
  let c;
  try {
    const slot = freshSlot();
    c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
    });
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    // Drive the iframe load — would have been the second 'message' listener
    // attach site in the pre-0.7.7 code path. Now it's a no-op for the
    // listener count.
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    assert(messageListeners.length === 1,
      `exactly one window 'message' listener across the entire Markup load window; got ${messageListeners.length}`);
  } finally {
    window.addEventListener = original;
    if (c) c._terminate();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Envelope round-trip — `:rendered` accepted, container.creativeRendered flips
// true, and the URL fragment carries the derived (not root) nonce.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n2. Renderer envelope round-trip preserved (RTR-D3 / § 6.3)');
  const c = await buildMarkup();
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  const evt = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(evt);
  assert(c.creativeRendered === true,
    'envelope-valid :rendered with derived sharcNonce flips creativeRendered=true');
  assert(c._iframe.getAttribute('src') === RENDERER_URL + '#sharcNonce=' + c._rendererProtocolNonce,
    'iframe.src fragment is the derived renderer-protocol nonce (not root _sharcNonce)');
  assert(c._sharcNonce !== c._rendererProtocolNonce,
    'root _sharcNonce stays distinct from the wire-level derived nonce (RTR-D13)');
  c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// Test #5 (SF-2, § 4.5): bfcache nonce persistence — pagehide(persisted=true)
// / pageshow(persisted=true) round trip with the same placementSessionId
// does NOT rotate the derived nonce. A valid envelope post-restore still
// dispatches; no unauthorized_protocol is raised.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n3. bfcache nonce persistence — no rotation across pagehide/show (§ 9.6 #5, § 4.5)');
  const securityEvents = [];
  const slot = freshSlot();
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: slot,
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
    onSecurityEvent: (ev) => securityEvents.push(ev),
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  const preNonce = c._rendererProtocolNonce;
  const preSession = c.placementSessionId;
  assert(typeof preNonce === 'string' && preNonce.length === 22,
    'pre-bfcache: derived renderer-protocol nonce is set');

  // Simulate bfcache round-trip via the page-lifecycle events.
  try {
    window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
  } catch (_) {
    // Some jsdom builds don't support PageTransitionEvent; fall back.
    const e = new dom.window.Event('pagehide');
    Object.defineProperty(e, 'persisted', { value: true });
    window.dispatchEvent(e);
  }
  try {
    window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  } catch (_) {
    const e = new dom.window.Event('pageshow');
    Object.defineProperty(e, 'persisted', { value: true });
    window.dispatchEvent(e);
  }

  assert(c._rendererProtocolNonce === preNonce,
    'post-bfcache: derived renderer-protocol nonce is unchanged (no rotation across freeze/restore)');
  assert(c.placementSessionId === preSession,
    'post-bfcache: placementSessionId is unchanged (same impression)');
  assert(!securityEvents.some((e) => e.type === 'unauthorized_protocol'),
    'no unauthorized_protocol raised for the bfcache round-trip alone');

  // Drive a valid envelope post-restore — still dispatches.
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  const evt = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(evt);
  assert(c.creativeRendered === true,
    'post-bfcache: a valid envelope still dispatches with the persisted nonce');
  c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// Per-protocol prefix isolation — a SECOND registered protocol's envelope
// does NOT reach the renderer handler; out-of-phase enforcement is
// per-protocol.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n4. Per-protocol prefix isolation (no cross-protocol envelope leakage)');
  const c = await buildMarkup();
  // Register a second protocol via the router (extension affordance).
  let secondHandlerCalls = 0;
  c.protocolRouter.register({
    prefix: 'TEST:Second:',
    types: { 'msg': { phases: ['init', 'attaching-renderer', 'rendered', 'creative-active'], direction: 'inbound' } },
    handler: () => { secondHandlerCalls++; },
  });
  await c.protocolRouter.ready('TEST:Second:');
  const secondNonce = c.protocolRouter.getProtocol('TEST:Second:').protocolNonce;

  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));

  // Post an envelope on the SECOND protocol's prefix using the renderer
  // protocol's nonce — must drop at gate step 7 (nonce-mismatch silent).
  const wrongNonceEvt = new dom.window.MessageEvent('message', {
    data: {
      type: 'TEST:Second:msg',
      sharcNonce: c._rendererProtocolNonce,
      placementSessionId: c.placementSessionId,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(wrongNonceEvt);
  assert(secondHandlerCalls === 0,
    'envelope on second-protocol prefix carrying the renderer nonce is silent-dropped (nonce mismatch)');
  assert(c.creativeRendered === false,
    'envelope on second-protocol prefix does NOT reach the renderer handler');

  // Happy path on the second protocol with its own nonce — dispatches there.
  const okEvt = new dom.window.MessageEvent('message', {
    data: {
      type: 'TEST:Second:msg',
      sharcNonce: secondNonce,
      placementSessionId: c.placementSessionId,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(okEvt);
  assert(secondHandlerCalls === 1,
    'second-protocol envelope with its OWN derived nonce dispatches to its OWN handler');
  c._terminate();
}

if (failures === 0) {
  console.log('\n✓ All renderer-protocol-retrofit assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} renderer-protocol-retrofit assertion(s) failed.`);
  process.exit(1);
}
