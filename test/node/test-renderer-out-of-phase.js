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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// ADR 2026-06-15: keep Node's NATIVE worker_threads MessageChannel/MessagePort
// (jsdom does not implement them); the load-probe gate authenticates by port
// possession, so the container needs a real channel. MessageEvent stays jsdom's.
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

// ────────────────────────────────────────────────────────────────────────────
// #321 Phase 1a — load-probe control channel under OMID.
//
// When an OMID AdSession starts, the bridge parks the router in `omid-active`
// (a window NARROWER than `creative-active`, opened after the container went
// live). The renderer backstop's control channel (`loadAck` / `loadProbe`)
// MUST remain in-phase there, or every post-render load under OMID is
// misclassified as unrecoverable and blanket-fatal'd. These cases pin that the
// `omid-active` / `omid-finishing` phases were added to the load-probe control
// channel ONLY — the handshake types (`rendered` / `failed` / `render`) stay
// `['attaching-renderer']` (anti-forgery), so a replay under OMID is still
// rejected out-of-phase.
// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// Shared driver: render the markup variant, then arm a post-render first-load
// probe by firing a second iframe `load`. Returns the container with
// `_pendingLoadProbe` installed (a function) and `_loadAckConsumed === false`,
// parked in `phase`. The backstop is armed with `verifyFirstLoad: true` inside
// `_onRendererRendered` (src/sharc-container.js:3173); the subsequent `load`
// event posts the `:loadProbe` and installs `onAck` as `_pendingLoadProbe`
// (src ~:4512). A real inbound `:loadAck` routed in-phase then drives
// `_dispatchRendererLoadAck` (src:2757) which latches `_loadAckConsumed` and
// nulls `_pendingLoadProbe`. This is the observable consumption seam — a
// loadAck that is merely "not rejected" but never routed to the handler would
// leave `_loadAckConsumed === false` and let the 100ms backstop deadline fire
// 2118. `rendererReply: 150` keeps that deadline within the test's wait window.
// ────────────────────────────────────────────────────────────────────────────
async function armedProbeInPhase(phase, sink) {
  const slot = freshSlot();
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: slot,
    timeouts: { rendererLoad: 5000, rendererReply: 150 },
    onError: (code, msg) => sink.errors.push({ code, msg }),
    onSecurityEvent: (ev) => sink.securityEvents.push(ev),
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // Valid handshake → phase: rendered; arms the first-load backstop.
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
  // Park the router in the OMID phase under test, mirroring the bridge's
  // AdSession lifecycle transition (`_onOmidLifecycleSignal`).
  c.protocolRouter.transitionTo(phase);
  // Post-render iframe load → posts `:loadProbe`, installs `_pendingLoadProbe`.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  return c;
}

async function loadAckConsumedInPhase(label, phase) {
  console.log('\n' + label);
  const sink = { errors: [], securityEvents: [] };
  const c = await armedProbeInPhase(phase, sink);
  assert(c.protocolRouter.getPhase() === phase,
    `router parked in ${phase}`);
  assert(typeof c._pendingLoadProbe === 'function',
    'precondition: a first-load probe is armed (callback installed)');
  assert(c._loadAckConsumed === false,
    'precondition: loadAck not yet consumed');

  // ADR 2026-06-15: the loadAck is now authenticated by PORT possession — the
  // renderer IIFE posts `:loadAck{probeId}` over `port2`, arriving on the
  // container's `port1`. Simulate that exact answer.
  const port2 = c._protocol && c._protocol._channel && c._protocol._channel.port2;
  if (port2) {
    port2.postMessage({ type: 'SHARC:Creative:loadAck', probeId: c._armedProbeId });
  }
  // Port delivery is async; let it land before asserting consumption.
  await sleep(10);

  const loadAckRejection = sink.securityEvents.find(
    (e) => e.type === 'unauthorized_protocol' && e.details.phase === phase
  );
  assert(loadAckRejection == null,
    `:loadAck in ${phase} is NOT rejected as unauthorized_protocol (#321)`);
  // The decisive consumption assertions: the port ack reached
  // `_dispatchRendererLoadAck`, which latched the single-use flag and resolved
  // the pending probe. A non-delivered ack would fail these.
  assert(c._loadAckConsumed === true,
    `:loadAck in ${phase} is CONSUMED (_loadAckConsumed latched true)`);
  assert(c._pendingLoadProbe === null,
    'consumed loadAck resolves the pending probe (_pendingLoadProbe nulled)');

  // And it survives the 100ms backstop deadline — consumption (not just
  // non-rejection) is what suppresses the 2118 backstop fire.
  await sleep(300);
  const fired2118 = sink.securityEvents.some(
    (e) => e.type === 'unauthorized_navigation'
  ) || sink.errors.some(
    (e) => e.code === protoMod.ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION
  );
  assert(!fired2118,
    `consumed loadAck in ${phase} suppresses the 2118 backstop deadline`);
  assert(c._terminated === false,
    `container remains live after the in-phase :loadAck (${phase})`);
  if (!c._terminated) c._terminate();
}

await loadAckConsumedInPhase(
  '4. #321: :loadAck inbound during omid-active is CONSUMED (recovery enabler)',
  'omid-active'
);

// ────────────────────────────────────────────────────────────────────────────
// Anti-forgery under OMID, parameterized over the OMID phase. The handshake
// types (`rendered` / `failed`) stay declared in `['attaching-renderer']` only
// — adding `omid-active` / `omid-finishing` to the load-probe CONTROL channel
// (#321) must NOT widen the handshake window — so a forged replay carrying a
// valid nonce is still rejected out-of-phase in either OMID phase.
// ────────────────────────────────────────────────────────────────────────────
async function forgedHandshakeStaysRejected(label, phase) {
  console.log('\n' + label);
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
  c.protocolRouter.transitionTo(phase);
  assert(c.protocolRouter.getPhase() === phase,
    `router parked in ${phase}`);

  // Forged :rendered with a VALID nonce — handshake type is declared ONLY in
  // `attaching-renderer`, so this must reject out-of-phase even under OMID.
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
  const renderedRej = securityEvents.find(
    (e) => e.type === 'unauthorized_protocol'
      && e.details.phase === phase
      && e.details.reason === 'out-of-phase'
  );
  assert(renderedRej != null,
    `forged :rendered in ${phase} → unauthorized_protocol (out-of-phase)`);

  // Forged :failed — also declared only in `attaching-renderer`.
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:failed',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      reason: 'forged-failed-under-omid',
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
  const failedRej = securityEvents.filter(
    (e) => e.type === 'unauthorized_protocol'
      && e.details.phase === phase
      && e.details.reason === 'out-of-phase'
  );
  assert(failedRej.length >= 2,
    `forged :failed in ${phase} → unauthorized_protocol (out-of-phase)`);

  // :render is the OUTBOUND handshake type — an inbound forgery of it is
  // dropped at the direction gate (inbound !== outbound), never reaching the
  // phase gate, so it does not surface as unauthorized_protocol. It must NOT
  // be accepted into the handler regardless.
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:render',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
  assert(c._terminated === false,
    'forged handshake envelopes under OMID do not terminate (non-terminating reject)');
  assert(errors.length === 0,
    'forged handshake envelopes under OMID do not surface onError (RTR-D15)');
  c._terminate();
}

await forgedHandshakeStaysRejected(
  '5. #321 anti-forgery: forged :rendered / :failed / :render in omid-active STAY rejected',
  'omid-active'
);

// ────────────────────────────────────────────────────────────────────────────
// #321 — `omid-finishing` coverage. The production change added
// `omid-finishing` to the load-probe control channel's phase set
// (src/sharc-container.js:1267,1269) but no case exercised it. Cases 6 & 7
// mirror Cases 4 & 5 with the router parked in `omid-finishing`:
//   6. inbound :loadAck is CONSUMED (control channel stays in-phase);
//   7. forged :rendered / :failed stay rejected out-of-phase (anti-forgery
//      holds in this phase too).
// ────────────────────────────────────────────────────────────────────────────
await loadAckConsumedInPhase(
  '6. #321: :loadAck inbound during omid-finishing is CONSUMED',
  'omid-finishing'
);

await forgedHandshakeStaysRejected(
  '7. #321 anti-forgery: forged :rendered / :failed / :render in omid-finishing STAY rejected',
  'omid-finishing'
);

if (failures === 0) {
  console.log('\n✓ All renderer-out-of-phase assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} renderer-out-of-phase assertion(s) failed.`);
  process.exit(1);
}
