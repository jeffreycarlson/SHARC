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
 *   3. RENDERER: the renderer's REAL `installOmidShimPrelude` (extracted and
 *      eval'd from `examples/renderer/index.html`, then driven through a real
 *      `SHARC:Renderer:render` envelope — NOT a source-grep and NOT an inlined
 *      copy) source-rewrites the shim into the markup with the OMID nonce baked
 *      as a CLOSURE CONSTANT before document.write. After the written document
 *      runs, `window.omid3p` exposes EXACTLY the two probed methods, and the
 *      nonce is NOT readable from any global / location surface. (§ 4.1, § 4.3,
 *      § 5.1)
 *   4. END-TO-END: a vendor stub calls `window.omid3p.registerSessionObserver`
 *      and receives the session callback when an inbound `SHARC:Omid:Event`
 *      (sessionStart) arrives over the (shim-gated) channel. (§ 5.4)
 *
 * #253 Part 3: sections 3 & 4 previously SOURCE-GREPPED for
 * `installOmidShimPrelude` and ran a HAND-INLINED COPY of its body. That can
 * stay green while the shipped renderer prelude diverges (e.g. the copy here
 * never baked the `rendererNonce` or self-removed the prelude <script>, yet
 * still passed). This version extracts+evals the renderer inline script (same
 * harness as test-omid-renderer-prelude.js) and EXERCISES the real shipped
 * `installOmidShimPrelude` via a `:render` envelope, so a renderer-prelude
 * divergence (wrong omid3p surface, nonce leak, broken delivery) now FAILS.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md § 4.1, § 4.3
 */

import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

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

// ── Extract the REAL renderer inline script (source of truth) ───────────────
//
// #253 Part 3: exercise the SHIPPED `installOmidShimPrelude` by extracting the
// renderer's main inline <script> (LONGEST <script>…</script>) and eval'ing it
// in a fresh jsdom window — the same harness pattern as
// test-omid-renderer-prelude.js. The renderer file is the single source of
// truth; we drive a real `:render` envelope and let the renderer's own prelude
// source-rewrite the BUILT shim into the document.
const RENDERER_PATH = new URL('../../examples/renderer/index.html', import.meta.url);
const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');

function extractInlineScript(src) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let match; let longest = '';
  while ((match = re.exec(src)) !== null) {
    if (match[1].length > longest.length) longest = match[1];
  }
  return longest;
}
const inlineScript = extractInlineScript(rendererSrc);

const SHIM_PATH = new URL('../../dist/sharc-omid-shim.js', import.meta.url);
const shimSource = fs.readFileSync(SHIM_PATH, 'utf8');

const RENDER_NONCE = 'render-nonce-markup';

/**
 * Boots a fresh renderer instance in jsdom (real inline script eval'd), points
 * the OMID shim URL same-origin at the built shim source via the
 * `sharcTestOmidShimUrl` knob with a `fetch` stub that serves `shimSource`,
 * dispatches a `SHARC:Renderer:render` envelope with `omid: true` + a valid
 * nonce, lets the renderer's real `installOmidShimPrelude` + document.write
 * run, and returns the renderer window + every message posted to its parent.
 *
 * The renderer writes the shim-injected markup into its OWN document
 * (document.open/write/close) with runScripts:'dangerously', so the baked
 * prelude executes in `win` and installs `window.omid3p` there.
 *
 * @returns {Promise<{ win: any, parentMessages: Array }>}
 */
async function runRenderWithRealPrelude() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    virtualConsole.on(level, () => {});
  });

  const shimUrl = RENDERER_ORIGIN + '/dist/sharc-omid-shim.js';
  const url = RENDERER_ORIGIN + '/0.7.0/?sharcTestOmidShimUrl='
    + encodeURIComponent(shimUrl) + '#sharcNonce=' + RENDER_NONCE;

  const idom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url,
    runScripts: 'dangerously',
    virtualConsole,
  });
  const win = idom.window;

  // Serve the built shim source same-origin so installOmidShimPrelude's
  // same-origin guard passes and the fetch returns the real shim IIFE.
  win.fetch = async (fetchUrl) => {
    if (String(fetchUrl).indexOf('sharc-omid-shim.js') !== -1) {
      return { ok: true, status: 200, text: async () => shimSource };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  win.eval('this.fetch = window.fetch;');

  const parentMessages = [];
  const fakeParent = {
    postMessage: (msg, origin) => { parentMessages.push({ msg, origin }); },
  };
  Object.defineProperty(win, 'parent', { configurable: true, get: () => fakeParent });

  win.__sharcRenderer = { installNavigationBridge: () => {} };

  win.eval(inlineScript);

  await Promise.resolve();
  await Promise.resolve();

  const renderEvent = new win.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:render',
      placementSessionId: psid,
      containerOrigin: PUBLISHER_ORIGIN,
      sharcNonce: RENDER_NONCE,
      sharcVersion: '0.7.0',
      rendererProtocolVersion: '1',
      omid: true,
      omidProtocolNonce: omidNonce,
      creativeHtml: CREATIVE_HTML,
    },
    origin: PUBLISHER_ORIGIN,
    source: fakeParent,
  });
  win.dispatchEvent(renderEvent);

  // Flush the async :render handler (swCheckPromise + acceptAndRender + the
  // awaited installOmidShimPrelude fetch + document.write).
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) await Promise.resolve();

  return { win, parentMessages };
}

// ── 3. The real shipped prelude installs window.omid3p with a baked nonce ───
section('3. real installOmidShimPrelude → window.omid3p live; nonce is a closure const');
const { win: rwin, parentMessages } = await runRenderWithRealPrelude();
{
  // No :failed reply: the prelude resolved + fetched + installed cleanly.
  const failed = parentMessages.filter((m) => m.msg && m.msg.type === 'SHARC:Renderer:failed');
  assert(failed.length === 0,
    'the real prelude install posts NO :failed reply (clean source-rewrite + install) — got '
      + (failed.length ? failed.map((m) => m.msg.reason).join(',') : 0));

  // omid3p surface (§ 5.1) — exactly the two probed methods, both functions.
  assert(rwin.omid3p && typeof rwin.omid3p === 'object',
    'window.omid3p installed by the shipped source-rewritten shim');
  assert(typeof rwin.omid3p.registerSessionObserver === 'function',
    'omid3p.registerSessionObserver is a function (isSupported probe)');
  assert(typeof rwin.omid3p.addEventListener === 'function',
    'omid3p.addEventListener is a function (isSupported probe)');
  const surfaceKeys = Object.keys(rwin.omid3p).sort().join(',');
  assert(surfaceKeys === 'addEventListener,registerSessionObserver',
    'omid3p exposes EXACTLY the two methods (' + surfaceKeys + ')');

  // Nonce confidentiality (§ 4.3 / § 5.2): the baked nonce is a closure
  // constant — it must NOT be reachable from any global or location surface.
  assert(rwin.omid3p.protocolNonce === undefined,
    'OMID nonce is NOT on window.omid3p');
  assert(rwin.protocolNonce === undefined,
    'OMID nonce is NOT a global (window.protocolNonce undefined)');
  assert(rwin.location.hash.indexOf(omidNonce) === -1,
    'OMID nonce is NOT on the creative iframe location.hash');
  assert(JSON.stringify(rwin.omid3p).indexOf(omidNonce) === -1,
    'OMID nonce does not serialize out through omid3p');

  // #254: the prelude <script> self-removes after capturing the nonce into the
  // shim closure, so the nonce literal is no longer DOM-readable as source text.
  const preludeScripts = rwin.document.querySelectorAll('script[data-sharc-prelude="omid-shim"]');
  assert(preludeScripts.length === 0,
    'the prelude <script> self-removed after install (#254 — nonce source-text unreachable)');
  const anyScriptCarriesNonce = Array.prototype.some.call(
    rwin.document.scripts, (s) => (s.textContent || '').indexOf(omidNonce) !== -1);
  assert(!anyScriptCarriesNonce,
    'no surviving <script> source text carries the OMID nonce literal');
}

// ── 4. End-to-end delivery through the shipped shim ─────────────────────────
section('4. inbound SHARC:Omid:Event delivered through the shipped shim');
{
  // A vendor stub registers a session observer and receives the session
  // callback when an inbound SHARC:Omid:Event arrives over the shim-gated
  // channel. The shim's default parentWindow is rwin.parent (the fakeParent),
  // so we dispatch with source === rwin.parent and the validated origin/nonce.
  let observed = null;
  rwin.omid3p.registerSessionObserver(function (ev) { observed = ev; }, 'vendor-key', 'inj-1');

  const evt = new rwin.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: omidNonce,
      placementSessionId: psid,
      event: { type: 'sessionStart', data: { context: { apiVersion: '1.0' } } },
    },
    origin: PUBLISHER_ORIGIN,
    source: rwin.parent,
  });
  rwin.dispatchEvent(evt);

  assert(observed !== null,
    'registered observer received a callback for the inbound sessionStart Event');
  assert(observed && observed.type === 'sessionStart',
    'observer callback carries the sessionStart event type');
  assert(observed && JSON.stringify(observed).indexOf(omidNonce) === -1,
    'observer callback NEVER carries the OMID nonce (§ 5.2 / § 9 dep 6)');

  // Reject a forged inbound Event carrying the WRONG nonce — the shim-side
  // inbound validator drops it; no second callback.
  observed = null;
  const forged = new rwin.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: 'wrong-nonce',
      placementSessionId: psid,
      event: { type: 'impression', data: {} },
    },
    origin: PUBLISHER_ORIGIN,
    source: rwin.parent,
  });
  rwin.dispatchEvent(forged);
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
