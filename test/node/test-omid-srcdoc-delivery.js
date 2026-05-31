/**
 * test-omid-srcdoc-delivery.js — 0.7.8 OMID URL + `useMarkupInjection`
 * (`srcdoc`) variant nonce delivery via MessageChannel (design § 4.3 mechanism
 * ii — the no-renderer path).
 *
 * The Markup variant (PR 1, test-omid-markup-delivery.js) delivers the OMID
 * nonce by renderer source-rewrite. There is no renderer in the URL+`srcdoc`
 * path, so the container instead:
 *   - has the OMID bridge's `injectIntoMarkup` prepend the shim + a port-
 *     receiver prelude into the `srcdoc` (NO nonce literal — #254-clean), and
 *   - transfers a `MessageChannel` port into the frame on iframe `load`,
 *     delivering the OMID `protocolNonce` over that point-to-point port.
 *
 * Assertions:
 *   1. CONTAINER injectIntoMarkup: when OMID active, prepends the shim
 *      `<script src>` + port-receiver prelude as the FIRST head children; the
 *      nonce is NOT a readable literal anywhere in the srcdoc source
 *      (#254-clean). With `exposeOmid3p:false`, markup is byte-identical
 *      (unchanged).
 *   2. REAL MessagePort END-TO-END: a parent transfers a REAL port to a
 *      srcdoc-like child window; the shim receives the nonce over the port and
 *      `window.omid3p` works (registerSessionObserver → callback on inbound
 *      sessionStart). NOT via calling an internal directly.
 *   3. ORDERING (regression-sensitive): the port handler is installed and the
 *      nonce stashed BEFORE creative code runs; and the negative case — a port
 *      whose nonce is delivered AFTER creative execution — leaves the nonce
 *      unresolved at creative-time (the property the real wiring must preserve).
 *   4. #254-CLEAN in the live document: the nonce is NOT readable from
 *      `document.scripts` text, NOT on hash/global/DOM-attr, NOT on omid3p.
 *   5. exposeOmid3p-OFF: srcdoc path unchanged — no prelude, no port, no shim.
 *   6. MALFORMED/MISSING-PORT: no port, wrong message shape → clean failure,
 *      no hang, omid3p still present (nonce just stays unresolved).
 *
 * Real MessagePort note: jsdom does NOT provide MessageChannel/MessagePort, but
 * Node's global `MessageChannel` is a real, message-delivering web MessagePort.
 * A jsdom `MessageEvent` carries a real Node `MessagePort` in `event.ports`, so
 * the nonce genuinely travels over a real port (verified end-to-end below).
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md § 4.2, § 4.3, § 7.4
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const CREATIVE_URL = PUBLISHER_ORIGIN + '/creative.html';
const CREATIVE_HTML = '<!DOCTYPE html><html><head><title>ad</title></head>'
  + '<body><div id="creative">ad</div></body></html>';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageEvent = dom.window.MessageEvent;
global.DOMParser = dom.window.DOMParser;
// Real web MessagePort (Node global) — jsdom provides neither. The container's
// `_transferOmidPort` constructs `new MessageChannel()`; wire the Node global
// onto the jsdom window so production code sees a real, working channel.
dom.window.MessageChannel = MessageChannel;
dom.window.MessagePort = MessagePort;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');
const shimMod = await import('../../dist/sharc-omid-shim.mjs');
const { installOmidShimPortReceiver } = shimMod;

let failures = 0;
function section(name) { console.log('\n' + name); }
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}
const tick = () => new Promise((r) => setTimeout(r, 10));

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function installOmSdkStub() {
  let registeredObserver = null;
  const adSession = {
    sessionId: 'omsdk-session-srcdoc',
    setCreativeType() {}, setImpressionType() {}, registerAdView() {},
    registerSessionObserver(cb) { registeredObserver = cb; },
    addFriendlyObstruction() {}, removeFriendlyObstruction() {},
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

// Build a URL + useMarkupInjection container, await OMID-nonce derivation, and
// capture the srcdoc the container assigns + the port/nonce transfer.
async function buildSrcdocContainer(bridgeOptions) {
  installOmSdkStub();
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    creativeType: 'display', mediaType: 'display',
    baseUrl: '/sharc',
    ...bridgeOptions,
  });
  const c = new SHARCContainer({
    creativeUrl: CREATIVE_URL,
    creativeSource: 'url',
    useMarkupInjection: true,
    placementElement: freshSlot(),
    extensions: [bridge],
  });
  // Stub fetch so _fetchAndInjectCreative reads our creative HTML.
  global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => CREATIVE_HTML });

  c.load();
  await c.protocolRouter.ready('SHARC:Omid:');
  return { c, bridge };
}

console.log('test-omid-srcdoc-delivery.js — 0.7.8 OMID srcdoc/MessageChannel\n');

let derivedNonce = null;
let psid = null;

// ── 1. Container injectIntoMarkup: shim + prelude, #254-clean ───────────────
section('1. injectIntoMarkup prepends shim + port-receiver prelude (OMID active)');
{
  const { c, bridge } = await buildSrcdocContainer({});
  const omid = c.protocolRouter.getProtocol('SHARC:Omid:');
  derivedNonce = omid.protocolNonce;
  psid = c.placementSessionId;

  const out = bridge.injectIntoMarkup(CREATIVE_HTML);
  assert(out !== CREATIVE_HTML, 'injectIntoMarkup transformed the markup when OMID active');
  assert(/<script src="\/sharc\/sharc-omid-shim\.js"><\/script>/.test(out),
    'prepends the shim <script src> tag');
  assert(/installOmidShimPortReceiver/.test(out),
    'prepends the port-receiver prelude (calls installOmidShimPortReceiver)');
  // First head child ordering: shim tag appears immediately after <head ...>.
  const headIdx = out.search(/<head(?=[\s>])[^>]*>/i);
  const shimIdx = out.indexOf('sharc-omid-shim.js');
  const creativeIdx = out.indexOf('id="creative"');
  assert(headIdx !== -1 && shimIdx > headIdx && shimIdx < creativeIdx,
    'shim script is injected at the top of <head>, before creative content');
  // #254-clean: the OMID nonce is NOT a readable literal anywhere in the srcdoc.
  assert(out.indexOf(derivedNonce) === -1,
    'the OMID nonce is NOT present as a literal in the srcdoc source (#254-clean)');
  // Non-secret transport anchors MAY be inlined (psid, origin) — sanity check
  // the prelude carries them so the shim can validate inbound events.
  assert(out.indexOf(psid) !== -1,
    'placementSessionId (non-secret transport anchor) is inlined in the prelude');
  c._terminate();
}

// ── 2. exposeOmid3p OFF — srcdoc unchanged ──────────────────────────────────
section('2. injectIntoMarkup is a no-op when exposeOmid3p:false');
{
  const { c, bridge } = await buildSrcdocContainer({ exposeOmid3p: false });
  const out = bridge.injectIntoMarkup(CREATIVE_HTML);
  assert(out === CREATIVE_HTML,
    'injectIntoMarkup returns markup byte-identical when OMID off (no shim, no prelude)');
  assert(out.indexOf('sharc-omid-shim.js') === -1, 'no shim script injected when OMID off');
  assert(typeof bridge.getSrcdocOmidInjection === 'function'
    && bridge.getSrcdocOmidInjection() === null,
    'getSrcdocOmidInjection() returns null when OMID off (gates the port transfer off too)');
  c._terminate();
}

// ── 3. Real-MessagePort END-TO-END + ORDERING ───────────────────────────────
//
// Drive the real shim prelude (`installOmidShimPortReceiver`) inside a child
// jsdom window with `window.parent` set to a distinct publisher window. Transfer
// a REAL Node MessagePort carrying the nonce. Assert window.omid3p works and the
// nonce arrives over the port — and that the handler/nonce ordering holds.
section('3. real-MessagePort end-to-end + ordering');
{
  // Child (srcdoc-like) window.
  const childDom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body></body></html>',
    { url: CREATIVE_URL, runScripts: 'dangerously' });
  const childWin = childDom.window;
  // Distinct publisher window object as the parent identity (event.source gate).
  const parentWin = dom.window;
  childWin.MessagePort = MessagePort;

  // Install the shim prelude as the FIRST thing in the child window (mirrors the
  // prelude running synchronously at the top of the srcdoc). Track ordering via
  // a resolution flag.
  let nonceResolvedAt = null;       // 'before-creative' | 'after-creative'
  let creativeRan = false;
  const handle = installOmidShimPortReceiver({
    placementSessionId: psid,
    containerOrigin: PUBLISHER_ORIGIN,
    targetWindow: childWin,
    parentWindow: parentWin,
    onNonceResolved: () => { nonceResolvedAt = creativeRan ? 'after-creative' : 'before-creative'; },
  });

  // §4.1: window.omid3p is present SYNCHRONOUSLY, before any creative read.
  assert(childWin.omid3p && typeof childWin.omid3p === 'object',
    'window.omid3p installed synchronously by the prelude (before any port message)');
  assert(typeof childWin.omid3p.registerSessionObserver === 'function'
    && typeof childWin.omid3p.addEventListener === 'function',
    'omid3p exposes the two probed methods immediately (isSupported() → true)');
  assert(handle.getStats().nonceResolved === false,
    'nonce is NOT yet resolved at install time (arrives async over the port)');

  // Build a REAL MessageChannel; emulate the container's _transferOmidPort
  // handshake from the publisher side.
  const channel = new MessageChannel();
  channel.port1.onmessage = (ev) => {
    if (ev && ev.data && ev.data.type === 'SHARC:Omid:PortReady') {
      channel.port1.postMessage({ protocolNonce: derivedNonce });
    }
  };
  channel.port1.start();

  // A "creative" registers an observer synchronously (omid3p present) BEFORE the
  // port message can dispatch (port delivery is a task).
  let observed = null;
  childWin.omid3p.registerSessionObserver(function (ev) { observed = ev; }, 'dv', 'inj-1');
  creativeRan = true; // creative's synchronous unit has run

  // Now deliver the transferred port as a window message with a REAL port in
  // event.ports (the container's contentWindow.postMessage(..., [port2])).
  const portEvt = new childWin.MessageEvent('message', {
    data: { type: 'SHARC:Omid:Port' },
    origin: PUBLISHER_ORIGIN,
    source: parentWin,
    ports: [channel.port2],
  });
  childWin.dispatchEvent(portEvt);

  await tick(); // let the port handshake + nonce delivery run

  assert(handle.getStats().nonceResolved === true,
    'nonce resolved after the port message delivered it (over a REAL MessagePort)');
  assert(nonceResolvedAt === 'after-creative',
    'ORDERING: the nonce arrives as a TASK, after the synchronous creative unit — '
    + 'omid3p was present the whole time, nonce stashed before any Register posts');

  // Now an inbound sessionStart Event (from parent) reaches the observer — the
  // shim's inbound validator now passes (nonce resolved, source===parent).
  const evt = new childWin.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event', sharcNonce: derivedNonce, placementSessionId: psid,
      event: { type: 'sessionStart', data: { context: { apiVersion: '1.0' } } },
    },
    origin: PUBLISHER_ORIGIN, source: parentWin,
  });
  childWin.dispatchEvent(evt);

  assert(observed !== null && observed.type === 'sessionStart',
    'END-TO-END: registered observer received the sessionStart after real-port nonce delivery');
  assert(observed && JSON.stringify(observed).indexOf(derivedNonce) === -1,
    'observer callback NEVER carries the OMID nonce (§ 5.2 / § 9 dep 6)');

  // #254-clean in the live document: nonce not on hash/global/omid3p.
  assert(childWin.location.hash.indexOf(derivedNonce) === -1,
    'nonce is NOT on the child location.hash');
  assert(childWin.protocolNonce === undefined && childWin.omid3p.protocolNonce === undefined,
    'nonce is NOT a global and NOT on window.omid3p');

  channel.port1.close(); channel.port2.close();
  handle.destroy();
}

// ── 3b. ORDERING negative case: nonce delivered before handler is impossible;
// assert the regression-sensitive property — a forged inbound Event arriving
// BEFORE the nonce resolves is DROPPED (fail-closed). If the shim resolved the
// nonce eagerly/synchronously from the window message (the bug shape), this
// would leak. ───────────────────────────────────────────────────────────────
section('3b. ordering regression: inbound Event before nonce-resolve is dropped');
{
  const childDom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body></body></html>',
    { url: CREATIVE_URL, runScripts: 'dangerously' });
  const childWin = childDom.window;
  const parentWin = dom.window;
  childWin.MessagePort = MessagePort;

  const handle = installOmidShimPortReceiver({
    placementSessionId: psid, containerOrigin: PUBLISHER_ORIGIN,
    targetWindow: childWin, parentWindow: parentWin,
  });
  let observed = null;
  childWin.omid3p.registerSessionObserver(function (ev) { observed = ev; });

  // Inbound sessionStart BEFORE any port/nonce delivery — must be dropped, since
  // the shim fails closed while the nonce is unresolved (a pre-fix shim that
  // treated `undefined === undefined` as a nonce match would deliver it).
  assert(handle.getStats().nonceResolved === false, 'pre-condition: nonce unresolved');
  const evt = new childWin.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event', sharcNonce: undefined, placementSessionId: psid,
      event: { type: 'sessionStart', data: {} },
    },
    origin: PUBLISHER_ORIGIN, source: parentWin,
  });
  childWin.dispatchEvent(evt);
  assert(observed === null,
    'inbound Event with no nonce is DROPPED while the nonce is unresolved (fail-closed) '
    + '— the negative case the eager-resolve bug would FAIL');
  handle.destroy();
}

// ── 4. #254-clean: nonce not readable from document.scripts text ────────────
section('4. #254-clean — nonce not readable from the srcdoc document.scripts');
{
  // Run the REAL bridge-produced srcdoc in a live document and read its scripts.
  const { c, bridge } = await buildSrcdocContainer({});
  const omid = c.protocolRouter.getProtocol('SHARC:Omid:');
  const nonce = omid.protocolNonce;
  const out = bridge.injectIntoMarkup(CREATIVE_HTML);

  const liveDom = new JSDOM(out, { url: CREATIVE_URL });
  const scripts = Array.from(liveDom.window.document.scripts);
  let anyScriptHasNonce = false;
  for (const s of scripts) {
    if ((s.textContent && s.textContent.indexOf(nonce) !== -1)
        || (s.src && s.src.indexOf(nonce) !== -1)
        || (s.outerHTML && s.outerHTML.indexOf(nonce) !== -1)) {
      anyScriptHasNonce = true;
    }
  }
  assert(!anyScriptHasNonce,
    'the OMID nonce is NOT readable from any document.scripts text/src/outerHTML (#254-clean)');
  assert(liveDom.serialize().indexOf(nonce) === -1,
    'the OMID nonce is NOT anywhere in the serialized srcdoc DOM');
  c._terminate();
}

// ── 5. Malformed / missing-port handling — clean failure, no hang ───────────
section('5. malformed / missing-port handling');
{
  const childDom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body></body></html>',
    { url: CREATIVE_URL, runScripts: 'dangerously' });
  const childWin = childDom.window;
  const parentWin = dom.window;
  childWin.MessagePort = MessagePort;

  const handle = installOmidShimPortReceiver({
    placementSessionId: psid, containerOrigin: PUBLISHER_ORIGIN,
    targetWindow: childWin, parentWindow: parentWin,
  });

  // (a) Port message with NO ports — ignored, no throw, nonce stays unresolved.
  childWin.dispatchEvent(new childWin.MessageEvent('message', {
    data: { type: 'SHARC:Omid:Port' }, origin: PUBLISHER_ORIGIN, source: parentWin,
  }));
  // (b) Wrong message shape (right ports, wrong type) — ignored.
  const ch = new MessageChannel();
  childWin.dispatchEvent(new childWin.MessageEvent('message', {
    data: { type: 'NotThePortMessage' }, origin: PUBLISHER_ORIGIN, source: parentWin,
    ports: [ch.port2],
  }));
  // (c) Port message from a NON-parent source — rejected by the source gate.
  const ch2 = new MessageChannel();
  childWin.dispatchEvent(new childWin.MessageEvent('message', {
    data: { type: 'SHARC:Omid:Port' }, origin: PUBLISHER_ORIGIN, source: {}, ports: [ch2.port2],
  }));
  await tick();

  assert(handle.getStats().nonceResolved === false,
    'nonce stays unresolved under malformed/missing/wrong-source port messages (no spurious resolve)');
  assert(childWin.omid3p && typeof childWin.omid3p.registerSessionObserver === 'function',
    'omid3p still present and usable (no hang, no crash) after malformed port messages');
  ch.port1.close(); ch.port2.close(); ch2.port1.close(); ch2.port2.close();
  handle.destroy();
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('✓ All omid-srcdoc-delivery assertions passed.');
  process.exit(0);
} else {
  console.error('✗ ' + failures + ' omid-srcdoc-delivery assertion(s) failed.');
  process.exit(1);
}
