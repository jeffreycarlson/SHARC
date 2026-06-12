/**
 * test-omid-v1-router-isolation.js — #244 design D5: the OM SDK
 * verification-service protocol (omid_v1) coexists BESIDE the SHARC protocol
 * router on the same `window.message` bus, never THROUGH it.
 *
 * This is the isolation boundary the #244 security verdict (§5.4) is
 * conditional on. With the real `omweb-v1.js` on the publisher page, the page
 * hosts two message surfaces:
 *
 *   - the router's single nonce-gated SHARC-protocol listener, and
 *   - the service's own unauthenticated omid_v1 responder.
 *
 * They are partitioned by `type` namespace. Pinned here, both directions:
 *
 *   A. omid_v1-shaped messages NEVER reach router handlers and NEVER raise
 *      `unauthorized_protocol` — gate steps 1/4/5 silently ignore them
 *      (string payloads, type-less envelopes, and non-SHARC `type` strings) —
 *      while a service-style listener on the same window still receives them
 *      (beside, not blocked).
 *   B. SHARC envelopes never enter the omid_v1 surface: the OM SDK clients'
 *      structural validation (guid/method/version triple) rejects a real
 *      `SHARC:Omid:Event` envelope, so a service-style responder ignores it.
 *   C. Router/nonce surfaces never leak into omid_v1 replies: inbound omid_v1
 *      traffic produces ZERO publisher-side posts — nothing answers, nothing
 *      echoes a protocol nonce.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see #244 design D5 / §5.4 (2026-06-11 omweb service integration ADR)
 * @see docs/design/0.7.7-cross-frame-protocol-router.md (gate step 5)
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

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Minimal OM SDK Session Client stub — only what _createSession touches.
function installOmSdkStub() {
  window.OmidSessionClient = {
    Partner: function () {},
    Context: function () {
      this.setContentUrl = function () {};
      this.setServiceScriptUrl = function () {};
    },
    AdSession: function () {
      return {
        sessionId: 'omsdk-session-isolation',
        setCreativeType() {},
        setImpressionType() {},
        registerAdView() {},
        registerSessionObserver() {},
        start() {},
        finish() {},
      };
    },
    AdEvents: function () {
      return { loaded() {}, impressionOccurred() {}, stateChange() {} };
    },
    VerificationScriptResource: function () {},
  };
}

/**
 * Structural omid_v1 envelope validation, transcribed from the OM SDK
 * communication layer (omweb-v1.js 1.5.2 `Gc` / JSClients
 * `isValidInternalMessage`): a message participates in the protocol only when
 * the guid/method/version triple is present with string guid/method/version.
 * This is the OM SDK's OWN gate — the test uses it as the stub service
 * responder's admission check.
 */
function isOmidV1Envelope(data) {
  return !!data
    && data.omid_message_guid !== undefined
    && data.omid_message_method !== undefined
    && data.omid_message_version !== undefined
    && typeof data.omid_message_guid === 'string'
    && typeof data.omid_message_method === 'string'
    && typeof data.omid_message_version === 'string';
}

// Build a live Markup-variant container with the OMID bridge, capture every
// publisher-side post to the iframe, and bring the router to omid-active.
async function buildLive() {
  installOmSdkStub();
  const security = [];
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    creativeType: 'display',
    mediaType: 'display',
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

  const posted = [];
  c._iframe.contentWindow.postMessage = (msg) => { posted.push(msg); };
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
  await c.protocolRouter.ready('SHARC:Omid:');

  // Spy on the bridge's router-dispatched handler — the only SHARC:Omid:
  // handler. Counts every dispatch that makes it past the router gate.
  let handlerDispatches = 0;
  const originalHandler = bridge._handleOmidEnvelope;
  bridge._handleOmidEnvelope = function (...args) {
    handlerDispatches += 1;
    return originalHandler.apply(this, args);
  };

  // Drive the OMID session live so the router sits in omid-active — the
  // realistic phase while a creative could speak omid_v1.
  bridge.onContainerLifecycleEvent({
    type: 'stateChange', newState: 'ready', previousState: 'loading', container: c,
  });
  return {
    c,
    bridge,
    security,
    posted,
    getHandlerDispatches: () => handlerDispatches,
  };
}

function creativeMessage(c, data) {
  return new dom.window.MessageEvent('message', {
    data,
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
}

console.log('test-omid-v1-router-isolation.js — #244 D5 omid_v1 ↔ router isolation\n');

// ── A. omid_v1 traffic never enters the router; service listener beside it ──
section('A. omid_v1-shaped messages: silent non-events for the router, delivered beside it');
{
  const { c, security, getHandlerDispatches } = await buildLive();
  assert(c.protocolRouter.getPhase() === 'omid-active',
    'precondition: router is in omid-active (live OMID session)');
  security.length = 0;

  // Service-style listener on the SAME window (what the real omweb-v1.js
  // installs). It must still see every omid_v1 message — the router does not
  // consume, gate, or block the bus.
  const serviceSaw = [];
  const serviceListener = (event) => {
    let data = event.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { return; }
    }
    if (isOmidV1Envelope(data)) serviceSaw.push(data.omid_message_method);
  };
  window.addEventListener('message', serviceListener);

  // Shape 1: modern raw omid_v1 envelope (object, NO `type` field) — the
  // wire shape the bundled verification clients post to the service window.
  window.dispatchEvent(creativeMessage(c, {
    omid_message_guid: 'guid-1',
    omid_message_method: 'VerificationService.addEventListener',
    omid_message_version: '1.5.2',
    omid_message_args: ['impression', 'injection-1'],
  }));
  // Shape 2: legacy serialized envelope (JSON string payload) — router gate
  // step 1 (object check) ignores it.
  window.dispatchEvent(creativeMessage(c, JSON.stringify({
    omid_message_guid: 'guid-2',
    omid_message_method: 'VerificationService.addSessionListener',
    omid_message_version: '1.0.3',
    omid_message_args: '["vendor","injection-1"]',
  })));
  // Shape 3: a hostile/defensive variant that DOES carry a string `type` in
  // the omid namespace — router gate step 5 finds no registered `SHARC:`
  // prefix and must return SILENTLY (no unauthorized_protocol; that gate
  // emits only on phase-membership failures of registered protocols).
  window.dispatchEvent(creativeMessage(c, {
    type: 'omid.v1_VerificationServiceCommunication',
    omid_message_guid: 'guid-3',
    omid_message_method: 'VerificationService.sendUrl',
    omid_message_version: '1.5.2',
    omid_message_args: ['https://tracker.example/pixel'],
  }));

  assert(getHandlerDispatches() === 0,
    'no omid_v1 shape reaches the SHARC:Omid: handler (router gate steps 1/4/5)');
  assert(security.filter((e) => e.type === 'unauthorized_protocol').length === 0,
    'no omid_v1 shape raises unauthorized_protocol (silent drop, never an emit)');
  assert(security.length === 0, 'no security event of any kind from omid_v1 traffic');
  assert(serviceSaw.length === 3,
    'a service-style listener on the same window receives all three messages (beside, not through)');
  assert(c.getState() !== 'terminated', 'container unaffected by omid_v1 traffic');

  window.removeEventListener('message', serviceListener);
  c._terminate();
}

// ── B. SHARC envelopes never enter the omid_v1 surface ──────────────────────
section('B. SHARC:Omid:Event envelopes fail the OM SDK structural gate');
{
  const { c, posted } = await buildLive();
  const omidEvents = posted.filter((m) => m && m.type === 'SHARC:Omid:Event');
  assert(omidEvents.length > 0,
    'precondition: the bridge relayed SHARC:Omid:Event envelopes (live session)');
  assert(omidEvents.every((m) => !isOmidV1Envelope(m)),
    'a real SHARC:Omid:Event envelope fails the omid_v1 structural validation (guid/method/version triple absent)');

  // Stub service responder: replies ONLY to structurally valid omid_v1
  // envelopes. Feeding it every envelope the bridge actually posted must
  // produce zero replies.
  let replies = 0;
  const respondIfOmid = (data) => { if (isOmidV1Envelope(data)) replies += 1; };
  for (const envelope of omidEvents) respondIfOmid(envelope);
  assert(replies === 0, 'a service-style responder ignores every SHARC envelope');
  c._terminate();
}

// ── C. nothing answers omid_v1 from SHARC; no nonce in any reply path ───────
section('C. omid_v1 inbound traffic draws no publisher-side response (no nonce leak surface)');
{
  const { c, posted } = await buildLive();
  const omidNonce = c.protocolRouter.getProtocol('SHARC:Omid:').protocolNonce;
  const rendererNonce = c._rendererProtocolNonce;
  const postedBefore = posted.length;

  window.dispatchEvent(creativeMessage(c, {
    omid_message_guid: 'guid-probe',
    omid_message_method: 'VerificationService.addSessionListener',
    omid_message_version: '1.5.2',
    omid_message_args: ['probe-vendor'],
  }));
  window.dispatchEvent(creativeMessage(c, {
    type: 'omid.v1_VerificationServiceCommunication',
    omid_message_guid: 'guid-probe-2',
    omid_message_method: 'VerificationService.addEventListener',
    omid_message_version: '1.5.2',
    omid_message_args: ['impression'],
  }));

  assert(posted.length === postedBefore,
    'SHARC posts NOTHING in response to omid_v1 traffic (router never answers; bridge relays only AdSession events)');
  const serialized = JSON.stringify(posted.slice(postedBefore));
  assert(!serialized.includes(omidNonce) && !serialized.includes(rendererNonce),
    'no protocol nonce appears in any post triggered by omid_v1 traffic');
  c._terminate();
}

if (failures > 0) {
  console.error('\n' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nAll assertions passed');
