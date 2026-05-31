/**
 * test-omid-markup-delivery.js — 0.7.8 OMID Markup-variant end-to-end nonce
 * delivery (design § 4.3 mechanism i — renderer source-rewrite).
 *
 * Asserts the full Markup path the 0.7.8 markup-wiring work added:
 *
 *   1. CONTAINER: when OMID is active for a Markup placement (`exposeOmid3p`
 *      not opted out + the `SHARC:Omid:` protocol registered + its nonce
 *      derived), the outbound `SHARC:Renderer:render` envelope carries
 *      `omid: true` + `omidProtocolNonce` === the OMID protocol nonce
 *      (NOT the renderer nonce, NOT the root nonce). (§ 4.3, container site)
 *   2. CONTAINER OMID-OFF: with `exposeOmid3p: false`, the render envelope is
 *      byte-identical to the pre-0.7.8 shape — no `omid`/`omidProtocolNonce`.
 *      (additive-only invariant)
 *   3. RENDERER: the renderer's `installOmidShimPrelude` source-rewrites the
 *      shim into the markup with the OMID nonce baked as a CLOSURE CONSTANT
 *      before document.write. After the written document runs, `window.omid3p`
 *      exposes EXACTLY the two probed methods, and the nonce is NOT readable
 *      from any global / location surface. (§ 4.1, § 4.3, § 5.1)
 *   4. END-TO-END: a vendor stub calls `window.omid3p.registerSessionObserver`
 *      and receives the session callback when an inbound `SHARC:Omid:Event`
 *      (sessionStart) arrives over the (shim-gated) channel. (§ 5.4)
 *
 * The renderer ships as `examples/renderer/index.html`; this test is the
 * source-of-truth check that the file contains the real `installOmidShimPrelude`
 * + the `omid` accept-path, and exercises an inlined copy of that function's
 * logic against the BUILT shim (`dist/sharc-omid-shim.js`) under jsdom — the
 * same harness strategy as test-renderer-domparser-fallback.js.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md § 4.1, § 4.3
 */

import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.example/render.html';
const RENDERER_ORIGIN = 'https://renderer.example';
const CREATIVE_HTML = '<html><head></head><body><div id="creative">ad</div></body></html>';

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
global.DOMParser = dom.window.DOMParser;

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

// ── Minimal OM SDK stub (publisher Service Script + Session Client) ──────────
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

// Build a Markup-variant container, drive it to the iframe `load` render-post,
// and capture the outbound SHARC:Renderer:render envelope.
async function captureRenderEnvelope(bridgeOptions) {
  installOmSdkStub();
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    creativeType: 'display',
    mediaType: 'display',
    ...bridgeOptions,
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
  // The OMID protocol registers on the container `load` lifecycle event (fired
  // synchronously inside c.load()); its nonce derivation is a microtask chain.
  // Await it so the render-post site sees a derived OMID nonce — the real-world
  // ordering (iframe `load` is a much-later macrotask) is even more favorable.
  await c.protocolRouter.ready('SHARC:Omid:');

  const captured = [];
  c._iframe.contentWindow.postMessage = (msg) => { captured.push(msg); };
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  const renderMsg = captured.find((m) => m && m.type === 'SHARC:Renderer:render');
  return { c, bridge, renderMsg };
}

console.log('test-omid-markup-delivery.js — 0.7.8 OMID Markup end-to-end\n');

// ── 1. Container render envelope carries omid + nonce when OMID active ──────
section('1. container render envelope (OMID active)');
let omidNonce = null;
let psid = null;
{
  const { c, renderMsg } = await captureRenderEnvelope({});
  assert(renderMsg != null, 'SHARC:Renderer:render envelope was posted to the iframe');
  assert(renderMsg.omid === true, 'render envelope carries omid: true');
  const omid = c.protocolRouter.getProtocol('SHARC:Omid:');
  assert(typeof renderMsg.omidProtocolNonce === 'string' && renderMsg.omidProtocolNonce.length > 0,
    'render envelope carries a non-empty omidProtocolNonce');
  assert(renderMsg.omidProtocolNonce === omid.protocolNonce,
    'omidProtocolNonce === the derived OMID protocol nonce');
  assert(renderMsg.omidProtocolNonce !== c._rendererProtocolNonce,
    'omidProtocolNonce is DISTINCT from the renderer protocol nonce (§ 4.3 / § 7.1)');
  assert(renderMsg.omidProtocolNonce !== c._sharcNonce,
    'omidProtocolNonce is not the root _sharcNonce');
  assert(renderMsg.sharcNonce === c._rendererProtocolNonce,
    'render envelope sharcNonce is still the renderer nonce (unchanged gating field)');
  omidNonce = renderMsg.omidProtocolNonce;
  psid = c.placementSessionId;
  c._terminate();
}

// ── 2. OMID-off path: render envelope is byte-identical to pre-0.7.8 ────────
section('2. container render envelope (OMID off — exposeOmid3p:false)');
{
  const { c, renderMsg } = await captureRenderEnvelope({ exposeOmid3p: false });
  assert(renderMsg != null, 'SHARC:Renderer:render envelope was posted to the iframe');
  assert(!('omid' in renderMsg),
    'render envelope has NO `omid` field when exposeOmid3p:false (additive-only)');
  assert(!('omidProtocolNonce' in renderMsg),
    'render envelope has NO `omidProtocolNonce` field when OMID off');
  // The OMID-off envelope must contain exactly the pre-0.7.8 field set.
  const keys = Object.keys(renderMsg).sort().join(',');
  assert(keys === ['bridges', 'containerOrigin', 'creativeHtml', 'placementSessionId',
    'rendererProtocolVersion', 'sharcNonce', 'sharcVersion', 'type'].sort().join(','),
    'OMID-off render envelope field set is the pre-0.7.8 shape (' + keys + ')');
  c._terminate();
}

// ── Source-of-truth: the renderer file ships the real markup-wiring code ────
section('3. renderer source ships the OMID markup-wiring path');
const RENDERER_PATH = new URL('../../examples/renderer/index.html', import.meta.url);
const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');
assert(/function\s+installOmidShimPrelude\s*\(/.test(rendererSrc),
  'renderer ships installOmidShimPrelude (§ 4.3 mechanism i)');
assert(/data\.omid\s*===\s*true/.test(rendererSrc),
  'renderer gates the shim install on `data.omid === true`');
assert(/OMID_SHIM_URL/.test(rendererSrc),
  'renderer has the OMID_SHIM_URL config knob');
assert(/var\s+protocolNonce\s*=\s*['"]?\s*\+\s*jsonForInlineScript\(omidProtocolNonce\)/.test(rendererSrc)
  || /protocolNonce=['"]?\s*\+\s*jsonForInlineScript\(omidProtocolNonce\)/.test(rendererSrc),
  'renderer bakes the OMID nonce as a closure-constant `var` (not a global/hash)');
assert(!/location\.hash\s*=\s*[^=]*omidProtocolNonce/.test(rendererSrc),
  'renderer never writes the OMID nonce to location.hash');

// ── 4. Renderer source-rewrite → window.omid3p live; nonce is a closure const ─
//
// Inlined copy of the renderer's `installOmidShimPrelude` body (sans the
// fetch — the test reads the BUILT shim source directly), driven against the
// dist shim. The renderer file is the source of truth; the assertions above
// confirm the shipped function matches this shape.
section('4. shim source-rewrite installs window.omid3p with baked nonce');
const shimSource = fs.readFileSync(
  new URL('../../dist/sharc-omid-shim.js', import.meta.url), 'utf8');

function jsonForInlineScript(value) {
  return JSON.stringify(String(value)).replace(/</g, '\\u003c');
}

// Mirror of installOmidShimPrelude's inline-script construction (renderer §4.3).
function buildShimInjectedHtml(html, nonce, placementSessionId, containerOrigin) {
  const code = ''
    + '(function(){'
    + 'var protocolNonce=' + jsonForInlineScript(nonce) + ';'
    + 'var placementSessionId=' + jsonForInlineScript(placementSessionId) + ';'
    + 'var containerOrigin=' + jsonForInlineScript(containerOrigin) + ';'
    + shimSource + ';'
    + 'try{(window.SHARC&&window.SHARC.installOmidShim||installOmidShim)({'
    + 'protocolNonce:protocolNonce,'
    + 'placementSessionId:placementSessionId,'
    + 'containerOrigin:containerOrigin'
    + '});}catch(e){if(window.console&&console.error)console.error('
    + '"[SHARC Renderer] OMID shim install failed:",e&&e.message?e.message:e);}'
    + '}());';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const script = parsed.createElement('script');
  script.text = code;
  const parent = parsed.head || parsed.body || parsed.documentElement;
  parent.insertBefore(script, parent.firstChild);
  return parsed.documentElement.outerHTML;
}

const injectedHtml = buildShimInjectedHtml(
  CREATIVE_HTML, omidNonce, psid, PUBLISHER_ORIGIN);
assert(injectedHtml.indexOf(omidNonce) !== -1,
  'baked nonce literal is present in the injected markup (closure constant)');

// Write the shim-injected markup into a fresh creative-iframe window and let
// the injected script run. A single-window jsdom: window.parent === window,
// so the shim's default parentWindow is this window and we can drive the
// inbound transport by dispatching a message with source === window.
{
  const idom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body></body></html>',
    { url: RENDERER_ORIGIN + '/render.html', runScripts: 'dangerously' });
  const iwin = idom.window;
  const idoc = iwin.document;
  iwin.SHARC = iwin.SHARC || {};

  idoc.open();
  idoc.write(injectedHtml);
  idoc.close();

  // omid3p surface (§ 5.1) — exactly the two probed methods, both functions.
  assert(iwin.omid3p && typeof iwin.omid3p === 'object',
    'window.omid3p installed by the source-rewritten shim');
  assert(typeof iwin.omid3p.registerSessionObserver === 'function',
    'omid3p.registerSessionObserver is a function (isSupported probe)');
  assert(typeof iwin.omid3p.addEventListener === 'function',
    'omid3p.addEventListener is a function (isSupported probe)');
  const surfaceKeys = Object.keys(iwin.omid3p).sort().join(',');
  assert(surfaceKeys === 'addEventListener,registerSessionObserver',
    'omid3p exposes EXACTLY the two methods (' + surfaceKeys + ')');

  // Nonce confidentiality (§ 4.3 / § 5.2): the baked nonce is a closure
  // constant — it must NOT be reachable from any global or location surface.
  assert(iwin.omid3p.protocolNonce === undefined,
    'OMID nonce is NOT on window.omid3p');
  assert(iwin.protocolNonce === undefined,
    'OMID nonce is NOT a global (window.protocolNonce undefined)');
  assert(iwin.location.hash.indexOf(omidNonce) === -1,
    'OMID nonce is NOT on the creative iframe location.hash');
  assert(JSON.stringify(iwin.omid3p).indexOf(omidNonce) === -1,
    'OMID nonce does not serialize out through omid3p');

  // End-to-end delivery (§ 5.4): a vendor stub registers a session observer and
  // receives the session callback when an inbound SHARC:Omid:Event arrives.
  let observed = null;
  iwin.omid3p.registerSessionObserver(function (ev) { observed = ev; }, 'vendor-key', 'inj-1');

  // Drive an inbound sessionStart Event over the shim-gated channel. The shim
  // validates source===parent, origin, nonce, placementSessionId — supply all.
  const evt = new iwin.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: omidNonce,
      placementSessionId: psid,
      event: { type: 'sessionStart', data: { context: { apiVersion: '1.0' } } },
    },
    origin: PUBLISHER_ORIGIN,
    source: iwin.parent,
  });
  iwin.dispatchEvent(evt);

  assert(observed !== null,
    'registered observer received a callback for the inbound sessionStart Event');
  assert(observed && observed.type === 'sessionStart',
    'observer callback carries the sessionStart event type');
  assert(observed && JSON.stringify(observed).indexOf(omidNonce) === -1,
    'observer callback NEVER carries the OMID nonce (§ 5.2 / § 9 dep 6)');

  // Reject a forged inbound Event carrying the WRONG nonce — the shim-side
  // inbound validator drops it; no second callback.
  observed = null;
  const forged = new iwin.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: 'wrong-nonce',
      placementSessionId: psid,
      event: { type: 'impression', data: {} },
    },
    origin: PUBLISHER_ORIGIN,
    source: iwin.parent,
  });
  iwin.dispatchEvent(forged);
  assert(observed === null,
    'forged inbound Event with the wrong nonce is dropped by the shim validator');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('✓ All omid-markup-delivery assertions passed.');
  process.exit(0);
} else {
  console.error('✗ ' + failures + ' omid-markup-delivery assertion(s) failed.');
  process.exit(1);
}
