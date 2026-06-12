/**
 * test-omid-verification-resource-cap.js — #244 design D7:
 * `MAX_OMID_VERIFICATION_RESOURCES` bounds the DISTINCT verification-script
 * resources fed to one OM SDK `Context` per session.
 *
 * The bound is SHARC L1 resource governance (the service injects one vendor
 * copy per resource — the resource count is the container-controlled input to
 * that fan-out), NOT OMID semantics. Pinned here:
 *
 *   - over-limit lists truncate to the first N distinct resources and emit a
 *     non-terminating `omid_resource_cap` security event (LOUD truncation —
 *     never silent, design D7);
 *   - the session still starts and the container NEVER terminates;
 *   - at/under the limit nothing emits;
 *   - duplicates are deduped BEFORE the bound (the cap counts distinct
 *     resources, not raw list entries);
 *   - a container-less bridge still warns (never silent on any path).
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see #244 design D7 (2026-06-11 omweb service integration ADR)
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
const { OmidCompatBridge, MAX_OMID_VERIFICATION_RESOURCES } = await import('../../dist/sharc-omid-bridge.mjs');

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

// OM SDK Session Client stub capturing the verificationScripts the Context
// actually receives.
function installOmSdkStub(capture) {
  window.OmidSessionClient = {
    Partner: function () {},
    Context: function (partner, verificationScripts) {
      capture.contextScripts = verificationScripts || [];
      this.setContentUrl = function () {};
      this.setServiceScriptUrl = function () {};
    },
    AdSession: function () {
      return {
        sessionId: 'omsdk-session-cap',
        setCreativeType() {},
        setImpressionType() {},
        registerAdView() {},
        registerSessionObserver() {},
        start() { capture.sessionStartCalled = true; },
        finish() {},
      };
    },
    AdEvents: function () {
      return { loaded() {}, impressionOccurred() {}, stateChange() {} };
    },
    VerificationScriptResource: function (url, vendor) {
      this.url = url;
      this.vendor = vendor;
    },
  };
}

function vendorScripts(count, prefix = 'vendor') {
  const scripts = [];
  for (let i = 0; i < count; i++) {
    scripts.push({
      resourceUrl: `https://verify.example/${prefix}-${i}.js`,
      vendor: `${prefix}-${i}`,
      verificationParameters: 'p',
      accessMode: 'limited',
    });
  }
  return scripts;
}

async function buildLive(verificationScripts) {
  const capture = {};
  installOmSdkStub(capture);
  const security = [];
  const errors = [];
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    creativeType: 'display',
    mediaType: 'display',
    verificationScripts,
  });
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    extensions: [bridge],
    onSecurityEvent: (e) => security.push(e),
    onError: (code, message) => errors.push({ code, message }),
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  c._iframe.contentWindow.postMessage = () => {};
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
  // Drive session creation through the bridge's state hook (the path the
  // container's lifecycle dispatcher uses).
  bridge.onContainerLifecycleEvent({
    type: 'stateChange', newState: 'ready', previousState: 'loading', container: c,
  });
  return { c, bridge, security, errors, capture };
}

console.log('test-omid-verification-resource-cap.js — #244 D7 resource cap\n');

section('provisional bound sanity');
{
  assert(MAX_OMID_VERIFICATION_RESOURCES === 16,
    'MAX_OMID_VERIFICATION_RESOURCES provisional value is 16 (re-measure post-#244 corpus integration)');
}

// ── A. over-limit: loud truncation, session unharmed ────────────────────────
section('A. over-limit list truncates loudly and never terminates');
{
  const { c, security, errors, capture } = await buildLive(vendorScripts(20));
  assert(capture.sessionStartCalled === true, 'AdSession still starts after the cap trips');
  assert(Array.isArray(capture.contextScripts)
    && capture.contextScripts.length === MAX_OMID_VERIFICATION_RESOURCES,
    `Context receives exactly ${MAX_OMID_VERIFICATION_RESOURCES} resources (first-N kept)`);
  assert(capture.contextScripts[0] && capture.contextScripts[0].url === 'https://verify.example/vendor-0.js',
    'declaration order preserved — the FIRST resources are the kept ones');

  const capEvents = security.filter((e) => e.type === 'omid_resource_cap');
  assert(capEvents.length === 1, 'exactly one omid_resource_cap security event emitted');
  const event = capEvents[0] || { details: {} };
  assert(event.severity === 'warning', 'omid_resource_cap is severity warning (non-terminating governance notice)');
  assert(event.details.featureName === 'com.iabtechlab.sharc.omid',
    'details.featureName names the OMID feature');
  assert(event.details.requestedCount === 20, 'details.requestedCount reports the configured distinct count');
  assert(event.details.keptCount === MAX_OMID_VERIFICATION_RESOURCES,
    'details.keptCount reports the kept count');
  assert(event.details.limit === MAX_OMID_VERIFICATION_RESOURCES, 'details.limit reports the enforced bound');
  assert(event.placementSessionId === c.placementSessionId, 'event carries the placementSessionId');

  assert(c.getState() !== 'terminated', 'container NOT terminated by the cap trip');
  assert(errors.length === 0, 'no onError from the cap trip (never a creative failure)');
  c._terminate();
}

// ── B. at/under the limit: silent ────────────────────────────────────────────
section('B. at the limit nothing emits');
{
  const { c, security, capture } = await buildLive(vendorScripts(MAX_OMID_VERIFICATION_RESOURCES));
  assert(capture.contextScripts.length === MAX_OMID_VERIFICATION_RESOURCES,
    'all resources pass through at exactly the limit');
  assert(security.filter((e) => e.type === 'omid_resource_cap').length === 0,
    'no omid_resource_cap event at the limit');
  c._terminate();
}

// ── C. the unit is DISTINCT resources: dedup happens before the bound ───────
section('C. duplicates dedup before the bound');
{
  const distinct = vendorScripts(12);
  const withDuplicates = distinct.concat(distinct.slice(0, 8)); // 20 entries, 12 distinct
  const { c, security, capture } = await buildLive(withDuplicates);
  assert(capture.contextScripts.length === 12,
    '20 entries with 12 distinct URLs → 12 resources (dedup-by-URL first)');
  assert(security.filter((e) => e.type === 'omid_resource_cap').length === 0,
    'no cap event — the bound counts distinct resources, not raw entries');
  c._terminate();
}

// ── D. container-less bridge still warns (never silent) ─────────────────────
section('D. container-less trip still warns');
{
  const capture = {};
  installOmSdkStub(capture);
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  try {
    const bridge = new OmidCompatBridge({
      omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
      omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
      creativeType: 'display',
      mediaType: 'display',
      verificationScripts: vendorScripts(20),
    });
    bridge._createSession();
  } finally {
    console.warn = originalWarn;
  }
  assert(capture.contextScripts.length === MAX_OMID_VERIFICATION_RESOURCES,
    'truncation still applies without a container');
  assert(warns.some((w) => w.includes('verification-script resources capped')),
    'dev-channel warn emitted when no container chokepoint is available');
}

if (failures > 0) {
  console.error('\n' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nAll assertions passed');
