/**
 * test-omid-bridge-geometry-throttle.js — 0.7.8 bridge-side geometryChange
 * emission throttle (design § 7.3 / OMID-D20).
 *
 * The publisher-page bridge rate-limits `geometryChange` emission to ≤1 event /
 * 100ms (a player-cadence sampling choice — fewer events FIRED, not coalesced at
 * replay). The throttle lives in `OmidCompatBridge._relayOmidEvent`. The
 * existing shim test drives geometryChange via the shim's `_handleInbound`,
 * which is DOWNSTREAM of the bridge throttle and so cannot exercise it. This
 * test drives the BRIDGE path: it builds a live OMID session and counts the
 * `SHARC:Omid:Event{type:'geometryChange'}` envelopes the bridge actually posts
 * to the iframe.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md § 7.3 / OMID-D20
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

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Minimal OM SDK stub (same surface as test-omid-router-consumption.js).
function installOmSdkStub() {
  let registeredObserver = null;
  const adSession = {
    sessionId: 'omsdk-session-geo',
    setCreativeType() {}, setImpressionType() {}, registerAdView() {},
    registerSessionObserver(cb) { registeredObserver = cb; },
    addFriendlyObstruction() {}, removeFriendlyObstruction() {},
    start() {}, finish() { if (registeredObserver) registeredObserver({ type: 'sessionFinish' }); },
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

async function buildLiveOmid() {
  installOmSdkStub();
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
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  const posted = [];
  c._iframe.contentWindow.postMessage = (msg) => { posted.push(msg); };
  c._iframe.dispatchEvent(new dom.window.Event('load'));
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
  await c.protocolRouter.ready('SHARC:Omid:');
  // Drive to active so the session starts (sessionStart fires) and
  // _relayOmidEvent is unblocked for geometryChange.
  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }
  return { c, bridge, posted };
}

function geometryEvents(posted) {
  return posted.filter((m) => m && m.type === 'SHARC:Omid:Event'
    && m.event && m.event.type === 'geometryChange');
}

console.log('test-omid-bridge-geometry-throttle.js — bridge geometryChange ≤1/100ms\n');

// ── A. burst of geometryChange relays within 100ms → ≤1 emitted ─────────────
section('A. emission throttle (≤1/100ms) on the BRIDGE path');
{
  const { c, bridge, posted } = await buildLiveOmid();
  assert(c.protocolRouter.getPhase() === 'omid-active',
    'precondition: router is omid-active (session started, relay unblocked)');

  // Clear the lifecycle envelopes captured during setup (sessionStart, loaded,
  // impression, and any initial visibility geometryChange).
  posted.length = 0;
  // Setup's transition-to-active fires an initial visibility geometryChange,
  // which arms the throttle window. Reset the last-emit clock so the burst's
  // FIRST call lands outside the window (emits) and the rest are throttled —
  // this is what makes "exactly one" the expected outcome rather than "zero
  // because we are still inside the setup window".
  bridge._omidLastGeometryEmitMs = 0;

  // Drive a burst of geometryChange relays through the BRIDGE's own emission
  // path (_relayOmidEvent — the unit under test), with DISTINCT data so the
  // count reflects the throttle, not any value-dedupe. All synchronous, so all
  // within the same 100ms window.
  const start = Date.now();
  for (let i = 0; i < 25; i++) {
    bridge._relayOmidEvent('geometryChange', { tick: i });
  }
  const elapsed = Date.now() - start;
  assert(elapsed < 100, 'the 25 relay calls completed inside one 100ms window (' + elapsed + 'ms)');

  const geo = geometryEvents(posted);
  assert(geo.length <= 1,
    'at most ONE geometryChange Event posted for a 25-call burst within 100ms (got ' + geo.length + ')');
  assert(geo.length === 1,
    'exactly one geometryChange Event emitted (the first sample in the window)');
}

// ── B. non-geometryChange events are NOT throttled ──────────────────────────
section('B. throttle is geometryChange-specific (does not gate other types)');
{
  const { bridge, posted } = await buildLiveOmid();
  posted.length = 0;
  // sessionError is not rate-limited at emission — every one is posted.
  for (let i = 0; i < 3; i++) bridge._relayOmidEvent('sessionError', { code: i });
  const errs = posted.filter((m) => m && m.type === 'SHARC:Omid:Event'
    && m.event && m.event.type === 'sessionError');
  assert(errs.length === 3,
    'three sessionError Events within 100ms are all emitted — throttle is geometryChange-only (' + errs.length + ')');
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ ${failures} omid-bridge-geometry-throttle assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All omid-bridge-geometry-throttle assertions passed.');
