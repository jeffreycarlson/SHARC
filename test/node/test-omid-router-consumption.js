/**
 * test-omid-router-consumption.js — 0.7.8 OMID bridge as a router consumer.
 *
 * Pins the publisher-page half of the 0.7.8 OMID work (the producer): the
 * `OmidCompatBridge` registers `prefix: 'SHARC:Omid:'` on the container's
 * protocol router, drives container-internal phase transitions off the
 * publisher-page session lifecycle, and relays AdSession events to the iframe
 * via `buildOutbound`. Covers the design's § 10.3 rows reachable at Layer 1:
 *
 *   - OMID registers with declared types/phases; onReady delivers a nonce
 *     distinct from the renderer's (§ 3.2)
 *   - Container drives transitionTo('omid-active') off AdSession.start success;
 *     never from an inbound envelope (§ 3.4 / OMID-Q2)
 *   - Outbound Event envelopes built via buildOutbound carry the OMID nonce +
 *     placementSessionId, posted to the iframe by the bridge (§ 3.3 / § 6.2)
 *   - OMID protocolNonce never equals the renderer nonce (§ 4.3 / § 7.1)
 *   - Register gated to omid-active only; an out-of-phase Register raises
 *     unauthorized_protocol (router gate, § 3.2). Unregister is NOT a declared
 *     type (OMID-Q7 reversed / deferred — #263): an inbound Unregister envelope
 *     is an unknown type the router silently drops, never reaching the handler.
 *   - placementSessionId is structurally immutable (#240)
 *   - No bespoke window 'message' listener added by the OMID bridge
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.example/render.html';
const RENDERER_ORIGIN = 'https://renderer.example';
const CREATIVE_HTML = '<html><body>creative</body></html>';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageEvent = dom.window.MessageEvent;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');

let failures = 0;
function section(name) { console.log('\n' + name); }
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}
function assertThrows(fn, pattern, message) {
  try { fn(); console.error('  ✗', message, '(no throw)'); failures++; }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { console.error('  ✗', message, `(wrong message: ${e.message})`); failures++; return; }
    console.log('  ✓', message);
  }
}

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ── Minimal OM SDK stub (publisher-page Service Script + Session Client) ─────
// Implements only the surface OmidCompatBridge._createSession touches.
function installOmSdkStub() {
  let registeredObserver = null;
  const adSession = {
    sessionId: 'omsdk-session-9',
    setCreativeType() {},
    setImpressionType() {},
    registerAdView() {},
    registerSessionObserver(cb) { registeredObserver = cb; },
    addFriendlyObstruction() {},
    removeFriendlyObstruction() {},
    start() {},
    finish() { if (registeredObserver) registeredObserver({ type: 'sessionFinish' }); },
    _emitError(data) { if (registeredObserver) registeredObserver({ type: 'sessionError', data: data || {} }); },
  };
  window.OmidSessionClient = {
    Partner: function () {},
    Context: function () { this.setContentUrl = function () {}; this.setServiceScriptUrl = function () {}; },
    AdSession: function () { return adSession; },
    AdEvents: function () { return { loaded() {}, impressionOccurred() {}, stateChange() {} }; },
    MediaEvents: function () { return { playerStateChange() {} }; },
    VerificationScriptResource: function () {},
    VastProperties: function () {},
  };
  return adSession;
}

// Build a Markup-variant container with the OMID bridge wired, drive it to a
// live OMID session, and capture every envelope the bridge posts to the iframe.
async function buildWithOmid(options = {}) {
  installOmSdkStub();
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    creativeType: 'display',
    mediaType: 'display',
    ...options,
  });
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    extensions: [bridge],
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');

  // Capture posts to the iframe; suppress the renderer render-post side effects.
  const posted = [];
  c._iframe.contentWindow.postMessage = (msg) => { posted.push(msg); };
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // Accept the renderer handshake so the container becomes live (creative-active).
  const rendered = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(rendered);
  // Let the OMID protocol's onReady (async crypto derivation) resolve.
  await c.protocolRouter.ready('SHARC:Omid:');
  return { c, bridge, posted };
}

console.log('test-omid-router-consumption.js — 0.7.8 OMID router consumer\n');

// ── A. registration + distinct nonce ────────────────────────────────────────
section('A. OMID protocol registration');
{
  const { c, posted } = await buildWithOmid();
  const omid = c.protocolRouter.getProtocol('SHARC:Omid:');
  assert(omid !== null, 'SHARC:Omid: protocol is registered on the router');
  assert(typeof omid.protocolNonce === 'string' && omid.protocolNonce.length > 0,
    'OMID protocolNonce derived and available');
  assert(omid.protocolNonce !== c._rendererProtocolNonce,
    'OMID protocolNonce is DISTINCT from the renderer protocol nonce (§ 4.3 / § 7.1)');
  assert(omid.protocolNonce !== c._sharcNonce,
    'OMID protocolNonce is not the root _sharcNonce');
  c._terminate();
  void posted;
}

// ── B. container-driven phase transition + relay via buildOutbound ──────────
section('B. omid-active transition + event relay');
{
  const { c, posted } = await buildWithOmid();
  // Drive the container to ACTIVE so OMID session creation + active signals fire.
  c.activate ? c.activate() : null;
  // The container reaches active via its state machine; the OMID bridge's
  // onContainerStateChange('active') creates the session, fires loaded/impression.
  // Force the active path explicitly through the state machine if needed.
  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }

  assert(c.protocolRouter.getPhase() === 'omid-active',
    'router phase is omid-active after AdSession.start() success (container-driven, § 3.4)');

  const omidEvents = posted.filter((m) => m && m.type === 'SHARC:Omid:Event');
  const types = omidEvents.map((m) => m.event && m.event.type);
  assert(types.indexOf('sessionStart') !== -1, 'sessionStart relayed as SHARC:Omid:Event');
  assert(types.indexOf('loaded') !== -1, 'loaded relayed as SHARC:Omid:Event');
  assert(types.indexOf('impression') !== -1, 'impression relayed as SHARC:Omid:Event');

  const omidNonce = c.protocolRouter.getProtocol('SHARC:Omid:').protocolNonce;
  assert(omidEvents.every((m) => m.sharcNonce === omidNonce),
    'every relayed Event is signed with the OMID protocolNonce (via buildOutbound)');
  assert(omidEvents.every((m) => m.sharcNonce !== c._rendererProtocolNonce),
    'no relayed Event carries the renderer nonce');
  assert(omidEvents.every((m) => m.placementSessionId === c.placementSessionId),
    'every relayed Event carries the container placementSessionId');
  assert(omidEvents.every((m) => typeof m.sequence === 'number'),
    'every relayed Event carries a monotonic sequence');
  c._terminate();
}

// ── C. phase gating: out-of-phase Register raises unauthorized_protocol ─────
section('C. router phase gating for inbound Register');
{
  installOmSdkStub();
  const security = [];
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    creativeType: 'display', mediaType: 'display',
  });
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    extensions: [bridge],
    onSecurityEvent: (e) => security.push(e),
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  await c.protocolRouter.ready('SHARC:Omid:');
  const omidNonce = c.protocolRouter.getProtocol('SHARC:Omid:').protocolNonce;

  // Router is NOT yet in omid-active (no session started). A well-formed
  // inbound Register is out-of-phase → unauthorized_protocol.
  const reg = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Register',
      sharcNonce: omidNonce,
      placementSessionId: c.placementSessionId,
      subscription: { kind: 'sessionObserver', subscriptionId: 'sub-1' },
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(reg);
  const omidUnauthorized = security.filter(
    (e) => e.type === 'unauthorized_protocol' && e.details && e.details.type === 'SHARC:Omid:'
  );
  assert(omidUnauthorized.length === 1,
    'out-of-phase inbound SHARC:Omid:Register raises unauthorized_protocol (gated to omid-active only)');

  // OMID-Q7 reversed / deferred (#263): `Unregister` is no longer a declared
  // type. A well-formed inbound Unregister is an UNKNOWN type — the router
  // silently drops it at the type-membership check (no handler dispatch, and —
  // unlike the out-of-phase Register above — no unauthorized_protocol event).
  security.length = 0;
  const unreg = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Unregister',
      sharcNonce: omidNonce,
      placementSessionId: c.placementSessionId,
      subscription: { kind: 'sessionObserver', subscriptionId: 'sub-1' },
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(unreg);
  const unregEvents = security.filter(
    (e) => e.details && e.details.type === 'SHARC:Omid:'
  );
  assert(unregEvents.length === 0,
    'inbound SHARC:Omid:Unregister is an unknown type → silently dropped, no security event (OMID-Q7 deferred, #263)');
  c._terminate();
}

// ── D. #240 placementSessionId structural immutability ──────────────────────
section('D. placementSessionId immutability (#240)');
{
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  const original = c.placementSessionId;
  assertThrows(() => { c.placementSessionId = 'forged-session'; }, /immutable/,
    'direct assignment to placementSessionId throws (structural tripwire)');
  assert(c.placementSessionId === original, 'placementSessionId value is unchanged after the rejected write');
  c._terminate();
}

// ── E. no bespoke window 'message' listener from the OMID bridge ────────────
section('E. single-listener invariant preserved');
{
  installOmSdkStub();
  const original = window.addEventListener;
  const messageListeners = [];
  window.addEventListener = function (type, ...rest) {
    if (type === 'message') messageListeners.push(rest[0]);
    return original.call(this, type, ...rest);
  };
  let c;
  try {
    const bridge = new OmidCompatBridge({
      omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
      omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
      creativeType: 'display', mediaType: 'display',
    });
    c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: freshSlot(),
      extensions: [bridge],
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
    });
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    await c.protocolRouter.ready('SHARC:Omid:');
    assert(messageListeners.length === 1,
      `exactly one window 'message' listener with the OMID bridge wired (router only); got ${messageListeners.length}`);
  } finally {
    window.addEventListener = original;
    if (c) c._terminate();
  }
}

// ── F. exposeOmid3p default ──────────────────────────────────────────────────
section('F. exposeOmid3p default');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
  });
  assert(bridge.options.exposeOmid3p === true, 'exposeOmid3p defaults to true (OMID-D21)');
  const off = new OmidCompatBridge({ exposeOmid3p: false });
  assert(off.options.exposeOmid3p === false, 'exposeOmid3p:false opt-out is honored');
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ ${failures} omid-router-consumption assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All omid-router-consumption assertions passed.');
