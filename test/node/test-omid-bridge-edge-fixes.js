/**
 * test-omid-bridge-edge-fixes.js — 0.7.8 OMID bridge edge-case fixes (#250).
 *
 * Three publisher-side bridge fixes, each with a regression-sensitive guard:
 *
 *   C5 — sessionStart must NOT be dropped when the router-derived OMID nonce
 *        has not resolved at _createSession time. The bridge records a pending
 *        sessionStart and fires it exactly once from the router onReady, before
 *        any later event. (Pre-fix: sessionStart is silently dropped and never
 *        retried; the shim never flips sessionStarted → queued Registers strand.)
 *
 *   C1 — _relayOmidEvent must FAIL CLOSED on origin: with no concrete iframe
 *        origin it must NOT post (no '*' broadcast of the protocolNonce) and
 *        must warn once. The Markup path (real _rendererOrigin) is unaffected.
 *
 *   C6 — _resetSessionRefs must zero the per-session envelope counters
 *        (_omidSequence, _omidLastGeometryEmitMs) so a subsequent session
 *        restarts at sequence 0 (design § 3.3 / § 3.5).
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

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Minimal OM SDK stub (same surface as test-omid-bridge-geometry-throttle.js).
function installOmSdkStub() {
  let registeredObserver = null;
  const adSession = {
    sessionId: 'omsdk-session-edge',
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

function omidEvents(posted, type) {
  return posted.filter((m) => m && m.type === 'SHARC:Omid:Event'
    && m.event && (type ? m.event.type === type : true));
}

console.log('test-omid-bridge-edge-fixes.js — 0.7.8 OMID bridge edge fixes (#250)\n');

// ════════════════════════════════════════════════════════════════════════════
// C5 — sessionStart is not dropped when the OMID nonce hasn't resolved yet.
//
// Faithful reproduction of the start()-wins-the-race ordering: we intercept the
// router-derived nonce so it is NULL at _createSession time, drive the session
// to start (which relays sessionStart while the nonce is unresolved), then fire
// the captured onReady. Post-fix: sessionStart is relayed exactly once from
// onReady. Pre-fix: the sessionStart relay early-returned on the null nonce with
// no retry, so onReady relays nothing → the "exactly once" assertion FAILS.
// ════════════════════════════════════════════════════════════════════════════
section('C5. sessionStart survives an unresolved OMID nonce at _createSession');
{
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

  // Intercept the OMID protocol registration to (a) capture its real onReady so
  // the test can fire it deterministically, and (b) suppress the router's own
  // onReady invocation so the bridge's nonce stays null past _createSession —
  // recreating the start()-wins race without monkeypatching crypto timing.
  let capturedOnReady = null;
  let capturedNonce = null;
  const realRegister = c.protocolRouter.register.bind(c.protocolRouter);
  c.protocolRouter.register = function (registration) {
    if (registration && registration.prefix === 'SHARC:Omid:') {
      capturedOnReady = registration.onReady;
      const passthrough = Object.assign({}, registration, {
        onReady: function (info) {
          // Stash the nonce the router derived, but do NOT forward to the
          // bridge yet — the bridge nonce must remain null through start().
          capturedNonce = info ? info.protocolNonce : null;
        },
      });
      return realRegister(passthrough);
    }
    return realRegister(registration);
  };

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

  // Drive to active → _createSession runs and relays sessionStart while the
  // bridge's _omidProtocolNonce is still null (our interceptor swallowed it).
  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }

  assert(bridge._omidProtocolNonce === null,
    'precondition: bridge OMID nonce is unresolved at session-start time (race forced)');
  assert(omidEvents(posted, 'sessionStart').length === 0,
    'sessionStart is NOT posted while the nonce is unresolved (no premature, unsigned relay)');
  assert(bridge._omidPendingSessionStart === true,
    'the dropped sessionStart is recorded pending (would strand the shim otherwise)');

  // Now the nonce resolves: fire the bridge's real onReady with the derived
  // nonce, exactly as the router would once crypto.subtle settles.
  assert(typeof capturedOnReady === 'function' && typeof capturedNonce === 'string',
    'captured the bridge onReady and the router-derived nonce');
  capturedOnReady({ protocolNonce: capturedNonce });

  const starts = omidEvents(posted, 'sessionStart');
  // THIS is the regression assertion. Pre-fix: starts.length === 0 → FAILS.
  assert(starts.length === 1,
    'sessionStart is relayed EXACTLY once after onReady resolves (got ' + starts.length + ')');
  assert(bridge._omidPendingSessionStart === false,
    'pending-sessionStart flag is cleared after the deferred relay');
  assert(bridge._omidProtocolNonce === capturedNonce,
    'bridge nonce is now the router-derived value');

  // Firing onReady again must NOT double-relay sessionStart.
  capturedOnReady({ protocolNonce: capturedNonce });
  assert(omidEvents(posted, 'sessionStart').length === 1,
    'a second onReady does NOT double-relay sessionStart (relayed exactly once total)');
}

// ════════════════════════════════════════════════════════════════════════════
// C1 — _relayOmidEvent fails CLOSED on origin: no concrete origin → no post.
// ════════════════════════════════════════════════════════════════════════════
section('C1. _relayOmidEvent fails closed when there is no concrete iframe origin');
{
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
  c._iframe.contentWindow.postMessage = (msg, origin) => { posted.push({ msg, origin }); };
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
  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }
  posted.length = 0;

  const warnings = [];
  const realWarn = console.warn;
  console.warn = function () { warnings.push(Array.prototype.join.call(arguments, ' ')); };
  try {
    // Strip both origin sources so neither _omidIframeOrigin nor
    // container._rendererOrigin yields a concrete target.
    bridge._omidIframeOrigin = null;
    c._rendererOrigin = null;
    bridge._relayOmidEvent('sessionError', { code: 7 });
  } finally {
    console.warn = realWarn;
  }

  const carriesNonce = posted.some((p) => p.msg && typeof p.msg === 'object'
    && typeof p.msg.sharcNonce === 'string');
  assert(posted.length === 0,
    'no postMessage is sent when there is no concrete origin (got ' + posted.length + ')');
  assert(!carriesNonce, 'no nonce-bearing envelope is broadcast to any origin');
  assert(warnings.some((w) => /SHARCOmid/.test(w)),
    'a single [SHARCOmid] warning fires on the fail-closed path');
  // Negative: the wildcard must never appear as a target origin.
  assert(!posted.some((p) => p.origin === '*'),
    'no envelope is ever posted to the "*" wildcard origin');

  // Markup path unaffected: with a real renderer origin, the bridge still posts
  // to the concrete origin.
  posted.length = 0;
  bridge._omidIframeOrigin = RENDERER_ORIGIN;
  bridge._relayOmidEvent('sessionError', { code: 8 });
  assert(posted.length === 1 && posted[0].origin === RENDERER_ORIGIN,
    'Markup path (real _rendererOrigin) still posts to the concrete origin');
  assert(posted[0].msg && posted[0].msg.type === 'SHARC:Omid:Event',
    'the concrete-origin post carries the OMID Event envelope');
}

// ════════════════════════════════════════════════════════════════════════════
// C6 — _resetSessionRefs zeroes the per-session envelope counters.
// ════════════════════════════════════════════════════════════════════════════
section('C6. _resetSessionRefs zeroes _omidSequence and _omidLastGeometryEmitMs');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
  });
  // Advance the per-session counters as a live session would.
  bridge._omidSequence = 17;
  bridge._omidLastGeometryEmitMs = 123456;

  bridge._resetSessionRefs(true);

  assert(bridge._omidSequence === 0,
    '_omidSequence is reset to 0 (per-session sequence — § 3.3/§ 3.5)');
  assert(bridge._omidLastGeometryEmitMs === 0,
    '_omidLastGeometryEmitMs is reset to 0 (per-session geometry clock)');
  assert(bridge._omid.sessionFinished === true,
    'sessionFinished flag still set (existing _resetSessionRefs behavior preserved)');
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ ${failures} omid-bridge-edge-fixes assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All omid-bridge-edge-fixes assertions passed.');
