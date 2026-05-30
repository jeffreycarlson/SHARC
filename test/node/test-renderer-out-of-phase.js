/**
 * test-renderer-out-of-phase.js — 0.7.7 out-of-phase enforcement on the
 * renderer protocol.
 *
 * Pins the S1 mitigation (§ 7.1): once the container has transitioned past
 * `attaching-renderer` (or `rendered`), a forged `SHARC:Renderer:rendered`
 * envelope carrying the valid renderer-protocol nonce is rejected at gate
 * step 9 with `unauthorized_protocol`. Container does NOT terminate; the
 * event is non-terminating (RTR-D15).
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

console.log('test-renderer-out-of-phase.js — 0.7.7 phase-enforcement coverage\n');

// ────────────────────────────────────────────────────────────────────────────
// Drive container past `attaching-renderer` (via a valid `:rendered`) and
// then replay a forged `:rendered` with the valid nonce. Gate step 9 must
// raise `unauthorized_protocol` (non-terminating).
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('1. Replayed :rendered after handshake → unauthorized_protocol (S1 mitigation)');
  const errors = [];
  const securityEvents = [];
  const slot = freshSlot();
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: slot,
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
    onError: (code, msg) => errors.push({ code, msg }),
    onSecurityEvent: (ev) => securityEvents.push(ev),
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // Valid handshake — transitions router from `attaching-renderer` to `rendered`.
  const okEvt = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(okEvt);
  assert(c.creativeRendered === true, 'baseline: first :rendered accepted');
  assert(c.protocolRouter.getPhase() === 'rendered', 'baseline: router phase is "rendered"');

  // Now post a forged :rendered with a VALID nonce in the `rendered` phase
  // (where :rendered's declared phase membership is ['attaching-renderer']).
  const forgedEvt = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(forgedEvt);

  const unauthorized = securityEvents.find((e) => e.type === 'unauthorized_protocol');
  assert(unauthorized != null,
    'replayed :rendered post-handshake → unauthorized_protocol fires');
  assert(unauthorized.severity === 'error',
    'unauthorized_protocol severity === "error"');
  assert(unauthorized.details.type === 'SHARC:Renderer:',
    'unauthorized_protocol details.type names the renderer prefix');
  assert(unauthorized.details.phase === 'rendered',
    'unauthorized_protocol details.phase reflects the rejection-time phase');
  assert(unauthorized.details.reason === 'out-of-phase',
    'unauthorized_protocol details.reason === "out-of-phase"');
  assert(errors.length === 0,
    'unauthorized_protocol is NON-TERMINATING — onError is not invoked (RTR-D15)');
  assert(c._terminated === false,
    'unauthorized_protocol does NOT terminate the container (RTR-D15)');
  c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// Drive container into `creative-active` and replay :rendered. Must still
// raise unauthorized_protocol with phase=creative-active.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n2. Replay during creative-active phase → unauthorized_protocol (phase=creative-active)');
  const errors = [];
  const securityEvents = [];
  const slot = freshSlot();
  const { ContainerStates } = protoMod;
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: slot,
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
    requireSharcInit: false,
    onError: (code, msg) => errors.push({ code, msg }),
    onSecurityEvent: (ev) => securityEvents.push(ev),
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // Valid handshake.
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
  // Force the router into `creative-active` via the public setState path.
  c.setState(ContainerStates.READY);
  c.setState(ContainerStates.ACTIVE);
  assert(c.protocolRouter.getPhase() === 'creative-active',
    'router phase transitioned to creative-active');

  // Replay :rendered.
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
  const ev = securityEvents.find((e) => e.type === 'unauthorized_protocol');
  assert(ev != null, 'replayed :rendered in creative-active → unauthorized_protocol fires');
  assert(ev.details.phase === 'creative-active',
    'unauthorized_protocol details.phase === "creative-active"');
  assert(c._terminated === false,
    'container continues running after out-of-phase emit');
  c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// :failed is also out-of-phase post-handshake.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n3. :failed envelope post-handshake is out-of-phase too');
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
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // Valid handshake → phase: rendered.
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
  // Post a forged :failed — declared only in `attaching-renderer`.
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:failed',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      reason: 'forged-failed-post-handshake',
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
  const ev = securityEvents.find((e) => e.type === 'unauthorized_protocol');
  assert(ev != null, 'post-handshake :failed → unauthorized_protocol fires');
  assert(ev.details.reason === 'out-of-phase',
    'unauthorized_protocol details.reason === "out-of-phase"');
  c._terminate();
}

if (failures === 0) {
  console.log('\n✓ All renderer-out-of-phase assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} renderer-out-of-phase assertion(s) failed.`);
  process.exit(1);
}
