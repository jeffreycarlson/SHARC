/**
 * test-terminate-omid-order.js — #337 terminate ordering (P1 live correctness).
 *
 * On a hard-terminate, the container's `_terminate()` must emit (and drain) the
 * OMID terminal `sessionFinish` Event WHILE the protocol router is still live —
 * before `protocolRouter.transitionTo('terminated')` + `destroy()`. The OMID
 * design's Risk R1: a `sessionFinish` relayed into an already-torn-down router
 * is out-of-phase (router phase `terminated` rather than the `omid-finishing`
 * grace window declared for outbound `Event`).
 *
 * This pins the ordering directly off the real `_terminate()`:
 *
 *   - OMID `sessionFinish` is relayed to the iframe BEFORE the router is
 *     destroyed (no "relay into torn-down router"), and the router is in the
 *     `omid-finishing` phase at relay time (not `terminated`).
 *   - The #342 `terminated → hidden` send still fires BEFORE protocol/router
 *     teardown (no regression of INV-13).
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md  (Risk R1)
 * @see issue #337, #342
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

// Minimal OM SDK stub — the surface OmidCompatBridge._createSession touches.
function installOmSdkStub() {
  let registeredObserver = null;
  const adSession = {
    sessionId: 'omsdk-session-337',
    setCreativeType() {},
    setImpressionType() {},
    registerAdView() {},
    registerSessionObserver(cb) { registeredObserver = cb; },
    addFriendlyObstruction() {},
    removeFriendlyObstruction() {},
    start() {},
    finish() { if (registeredObserver) registeredObserver({ type: 'sessionFinish' }); },
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
// live OMID session (omid-active), and return the container plus an ordered
// event log instrumented across the terminate teardown seams.
async function buildLiveOmidContainer() {
  installOmSdkStub();
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
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');

  // Capture posts to the iframe; suppress the renderer render-post side effects.
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

  // Drive to ACTIVE so the OMID session starts (router → omid-active). This is
  // the precondition for a terminal sessionFinish to be relayed on terminate.
  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }

  return { c, bridge, posted };
}

console.log('test-terminate-omid-order.js — #337 terminate OMID/teardown ordering\n');

// ── A. OMID sessionFinish relays BEFORE router teardown ──────────────────────
section('A. terminate ordering — OMID sessionFinish drains before router teardown');
{
  const { c, posted } = await buildLiveOmidContainer();

  assert(c.protocolRouter.getPhase() === 'omid-active',
    'precondition: router phase is omid-active (live OMID session)');

  // Ordered event log across the teardown seams.
  const events = [];
  let finishPhase = null;

  // Seam 1: router teardown.
  const realRouterDestroy = c.protocolRouter.destroy.bind(c.protocolRouter);
  c.protocolRouter.destroy = function () {
    events.push('router.destroy');
    return realRouterDestroy();
  };

  // Seam 2: protocol teardown.
  const realProtocolTerminate = c._protocol.terminate.bind(c._protocol);
  c._protocol.terminate = function () {
    events.push('protocol.terminate');
    return realProtocolTerminate();
  };

  // Seam 3: the #342 terminated→hidden send.
  const realSendStateChange = c._protocol.sendStateChange.bind(c._protocol);
  c._protocol.sendStateChange = function (state) {
    events.push('sendStateChange:' + state);
    return realSendStateChange(state);
  };

  // Seam 4: the OMID terminal sessionFinish relay (posted to the iframe). Record
  // the router phase observed at relay time — must be omid-finishing, NOT
  // terminated (Risk R1).
  const realPost = c._iframe.contentWindow.postMessage;
  c._iframe.contentWindow.postMessage = function (msg) {
    if (msg && msg.type === 'SHARC:Omid:Event' && msg.event && msg.event.type === 'sessionFinish') {
      events.push('omid:sessionFinish');
      finishPhase = c.protocolRouter.getPhase();
    }
    return realPost.call(this, msg);
  };

  c._terminate();

  const iFinish = events.indexOf('omid:sessionFinish');
  const iRouterDestroy = events.indexOf('router.destroy');
  const iProtocolTerminate = events.indexOf('protocol.terminate');
  const iHidden = events.indexOf('sendStateChange:hidden');

  assert(iFinish !== -1, 'OMID sessionFinish was relayed during terminate');
  assert(iRouterDestroy !== -1, 'router.destroy ran during terminate');
  assert(iFinish !== -1 && iRouterDestroy !== -1 && iFinish < iRouterDestroy,
    'OMID sessionFinish is relayed BEFORE the router is destroyed (#337: no relay into torn-down router)');
  assert(iFinish !== -1 && iProtocolTerminate !== -1 && iFinish < iProtocolTerminate,
    'OMID sessionFinish is relayed BEFORE _protocol.terminate()');
  assert(finishPhase === 'omid-finishing',
    'router phase at sessionFinish relay is omid-finishing, NOT terminated (Risk R1 in-phase)');

  // #342 must not regress: terminated→hidden fires, and it fires BEFORE teardown.
  assert(iHidden !== -1, '#342: terminated→hidden sendStateChange still fires on terminate');
  assert(iHidden !== -1 && iProtocolTerminate !== -1 && iHidden < iProtocolTerminate,
    '#342: terminated→hidden fires BEFORE _protocol.terminate() (INV-13 not regressed)');
  assert(iHidden !== -1 && iRouterDestroy !== -1 && iHidden < iRouterDestroy,
    '#342: terminated→hidden fires BEFORE router teardown');

  void posted;
}

// ── B. idempotent terminate — the second _terminate() does no further work ───
// Scope note: a single terminate may relay sessionFinish more than once (the
// OM SDK's finish() observer + the bridge's container-driven relay both fire);
// the shim treats sessionFinish as a session-singleton, so a duplicate within
// ONE terminate is harmless and is a bridge concern outside #337. What #337's
// re-entrancy guard must hold is that a SECOND _terminate() call adds NO new
// relays and NO new teardown.
section('B. terminate is idempotent — a second _terminate() does no further work');
{
  const { c } = await buildLiveOmidContainer();

  let finishCount = 0;
  let routerDestroyCount = 0;
  let protocolTerminateCount = 0;
  const realPost = c._iframe.contentWindow.postMessage;
  c._iframe.contentWindow.postMessage = function (msg) {
    if (msg && msg.type === 'SHARC:Omid:Event' && msg.event && msg.event.type === 'sessionFinish') {
      finishCount++;
    }
    return realPost.call(this, msg);
  };
  const realRouterDestroy = c.protocolRouter.destroy.bind(c.protocolRouter);
  c.protocolRouter.destroy = function () { routerDestroyCount++; return realRouterDestroy(); };
  const realProtocolTerminate = c._protocol.terminate.bind(c._protocol);
  c._protocol.terminate = function () { protocolTerminateCount++; return realProtocolTerminate(); };

  c._terminate();
  const finishAfterFirst = finishCount;
  c._terminate();

  assert(finishAfterFirst >= 1, 'first _terminate() relays the terminal sessionFinish at least once');
  assert(finishCount === finishAfterFirst,
    'second _terminate() relays NO additional sessionFinish (re-entrancy guard holds)');
  assert(routerDestroyCount === 1, 'router.destroy() runs exactly once across two _terminate() calls');
  assert(protocolTerminateCount === 1, '_protocol.terminate() runs exactly once across two _terminate() calls');
}

console.log(failures === 0
  ? `\n✅ All assertions passed.`
  : `\n❌ ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
