/**
 * test-omid-iab-reference-clients.js: G2 gate. IAB's own reference
 * verification clients run against SHARC's real OMID relay (#449, #450).
 *
 * Our other OMID suites assert against hand-written observers. Those mocks hid
 * two measurement regressions:
 *   - #449: the web path relayed `sessionStart` with a bare `{}`. IAB's
 *     reference clients dereference `data.context` (`removeDomElements`,
 *     window-utils.js), throw a TypeError, the shim's `deliver()` swallows it,
 *     and no sessionStart beacon fires.
 *   - #450: the shim delivered EVERY event to `registerSessionObserver`
 *     observers. OMID API 1.5 p.28 scopes session observers to session events.
 *     A client that registers both surfaces (both IAB reference clients do)
 *     gets each ad event twice and sends each impression beacon twice.
 *
 * This gate runs the IAB code itself, vendored verbatim under
 * test/vendor/omid-jsclients (Apache-2.0, upstream commit ec40856, v1.6.5):
 * `VerificationClient`, `ValidationVerificationClient` and
 * `ComplianceVerificationClient`, booted exactly as their `main.js` boots them,
 * and counts the beacons they send.
 *
 * Chain under test, all real code except the publisher-page OM SDK:
 *   real SHARCContainer + real OmidCompatBridge (dist) on a jsdom publisher page
 *     → bridge postMessage → structuredClone, delivered as a task
 *     → real installOmidShim's own `message` listener in a creative realm
 *     → window.omid3p → IAB VerificationClient (omid3p path)
 *     → IAB Validation/Compliance clients → <img> beacons (counted)
 *   and back: shim Register → parent.postMessage → structuredClone
 *     → the container's protocol router.
 *
 * The publisher-page OM SDK is a stand-in. The pinned omweb-v1.js may not be
 * committed (tools/creative-validator/VENDORED.md), so the stand-in reproduces
 * the behaviour observed from the pinned pair (omweb-v1 1.5.2-google27 +
 * session client 1.6.6-iab457) in Chrome: `registerSessionObserver` receives
 * `sessionStart` SYNCHRONOUSLY inside `adSession.start()`, carrying
 * REAL_SESSION_START_DATA verbatim; `finish()` synchronously delivers a
 * data-less `sessionFinish`. The AdSession exposes no `sessionId` property
 * (the real client exposes `getAdSessionId()`).
 *
 * Runs in Node after `npm run build`. No test framework.
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(__dirname, '../vendor/omid-jsclients');
const JSCLIENTS_SEM_VERSION = '1.6.5';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.example/render.html';
const RENDERER_ORIGIN = 'https://renderer.example';
const CREATIVE_HTML = '<html><body>creative</body></html>';

const VALIDATION_BEACON_PREFIX = 'http://localhost:66/sendmessage?msg=';
const COMPLIANCE_BEACON_PREFIX = 'https://compliance.iabtechnologylab.com/omsdk/sendmessage.json?';

const SESSION_EVENT_TYPES = ['sessionStart', 'sessionError', 'sessionFinish'];

// `sessionStart.data` the pinned OM SDK web pair delivered to the integration's
// session observer, captured in Chrome (partner 'sharc' / '0.7.13', creative
// htmlDisplay, impression beginToRender, page http://localhost:18901/).
// `customReferenceData` is present-but-undefined in the real object.
const REAL_SESSION_START_DATA = Object.freeze({
  context: {
    apiVersion: '1.0',
    accessMode: 'limited',
    environment: 'web',
    omidJsInfo: {
      omidImplementer: 'omsdk',
      serviceVersion: '1.5.2-google27',
      sessionClientVersion: '1.6.6-iab457',
      partnerName: 'sharc',
      partnerVersion: '0.7.13',
    },
    adSessionType: 'html',
    supports: ['clid', 'vlid'],
    sessionOwner: 'javascript',
    customReferenceData: undefined,
    underEvaluation: false,
    canMeasureVisibility: true,
  },
  impressionType: 'beginToRender',
  mediaType: 'display',
  creativeType: 'htmlDisplay',
  supportsLoadedEvent: true,
  pageUrl: 'http://localhost:18901/',
  contentUrl: null,
});

// Outbound OMID envelopes OTHER than sessionStart, captured from origin/main
// 4550bf5 running this exact scenario, normalized (nonce, placementSessionId
// and timestamps replaced). The fix must leave these byte-identical.
const GOLDEN_NON_SESSIONSTART_ENVELOPES = [
  "{\"type\":\"SHARC:Omid:Event\",\"sharcNonce\":\"<omid-nonce>\",\"placementSessionId\":\"<placementSessionId>\",\"sequence\":2,\"event\":{\"adSessionId\":\"<placementSessionId>\",\"timestamp\":\"<timestamp>\",\"type\":\"loaded\",\"data\":{}}}",
  "{\"type\":\"SHARC:Omid:Event\",\"sharcNonce\":\"<omid-nonce>\",\"placementSessionId\":\"<placementSessionId>\",\"sequence\":3,\"event\":{\"adSessionId\":\"<placementSessionId>\",\"timestamp\":\"<timestamp>\",\"type\":\"impression\",\"data\":{}}}",
  "{\"type\":\"SHARC:Omid:Event\",\"sharcNonce\":\"<omid-nonce>\",\"placementSessionId\":\"<placementSessionId>\",\"sequence\":4,\"event\":{\"adSessionId\":\"<placementSessionId>\",\"timestamp\":\"<timestamp>\",\"type\":\"geometryChange\",\"data\":{\"viewport\":{\"width\":1024,\"height\":768},\"adView\":{\"percentageInView\":0,\"reasons\":[\"backgrounded\"],\"geometry\":{\"x\":0,\"y\":0,\"width\":0,\"height\":0},\"onScreenGeometry\":{\"x\":0,\"y\":0,\"width\":0,\"height\":0,\"obstructions\":[]}}}}}",
  "{\"type\":\"SHARC:Omid:Event\",\"sharcNonce\":\"<omid-nonce>\",\"placementSessionId\":\"<placementSessionId>\",\"sequence\":5,\"event\":{\"adSessionId\":\"<placementSessionId>\",\"timestamp\":\"<timestamp>\",\"type\":\"sessionFinish\",\"data\":{}}}",
  "{\"type\":\"SHARC:Omid:Event\",\"sharcNonce\":\"<omid-nonce>\",\"placementSessionId\":\"<placementSessionId>\",\"sequence\":1,\"event\":{\"adSessionId\":\"<placementSessionId>\",\"timestamp\":\"<timestamp>\",\"type\":\"sessionFinish\",\"data\":{}}}",
];

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
const { installOmidShim } = await import('../../dist/sharc-omid-shim.mjs');

let failures = 0;
function section(name) { console.log('\n' + name); }
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}

// ── postMessage as a task, structuredClone-faithful ─────────────────────────
// Real postMessage clones the message and delivers it in a later task. Every
// hop in this harness goes through `post()`, and `settle()` drains the queue.
let pendingTasks = 0;
function post(deliverFn, message) {
  const cloned = structuredClone(message);
  pendingTasks++;
  setTimeout(() => { pendingTasks--; deliverFn(cloned); }, 0);
}
async function settle() {
  for (let i = 0; i < 1000 && pendingTasks > 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  await new Promise((r) => setTimeout(r, 0));
}

// ── Publisher-page OM SDK stand-in (observed behaviour of the pinned pair) ──
function installOmSdk({ deliverSessionStartInStart = true } = {}) {
  const observers = [];
  const sdkAdSessionId = 'omsdk-real-adsession-id';
  const adSession = {
    getAdSessionId() { return sdkAdSessionId; },
    setCreativeType() {},
    setImpressionType() {},
    registerSessionObserver(fn) { observers.push(fn); },
    start() {
      if (!deliverSessionStartInStart) return;
      for (const fn of observers.slice()) {
        fn({
          adSessionId: sdkAdSessionId,
          timestamp: Date.now(),
          type: 'sessionStart',
          data: structuredClone(REAL_SESSION_START_DATA),
        });
      }
    },
    finish() {
      for (const fn of observers.slice()) {
        fn({ adSessionId: sdkAdSessionId, timestamp: Date.now(), type: 'sessionFinish' });
      }
    },
    error() {},
  };
  window.OmidSessionClient = {
    Partner: function () {},
    Context: function () {
      this.setVideoElement = function () {};
      this.setSlotElement = function () {};
      this.setServiceWindow = function () {};
    },
    AdSession: function () { return adSession; },
    AdEvents: function () { return { loaded() {}, impressionOccurred() {} }; },
    MediaEvents: function () { return {}; },
    VerificationScriptResource: function () {},
    VastProperties: function () {},
  };
}

// ── goog.module loader over the vendored IAB sources ────────────────────────
function indexVendoredModules() {
  const byName = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!entry.endsWith('.js')) continue;
      const m = /goog\.module\('([^']+)'\)/.exec(fs.readFileSync(p, 'utf8'));
      if (m) byName.set(m[1], { file: p, source: fs.readFileSync(p, 'utf8') });
    }
  })(path.join(VENDOR_DIR, 'src'));
  // Upstream's build generates omid.common.version from this template and
  // version.txt. Same substitution, in memory.
  const template = fs.readFileSync(path.join(VENDOR_DIR, 'templates/version-js.template'), 'utf8');
  byName.set('omid.common.version', {
    file: path.join(VENDOR_DIR, 'templates/version-js.template'),
    source: template
      .replace('${semVersionString}', JSCLIENTS_SEM_VERSION)
      .replace('${buildVersion}', 'iab'),
  });
  return byName;
}
const VENDORED_MODULES = indexVendoredModules();

function makeGoogLoader(sandbox) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const mod = VENDORED_MODULES.get(name);
    if (!mod) throw new Error('vendored goog.module missing: ' + name);
    const rec = { exports: {} };
    cache.set(name, rec);
    const goog = {
      module: Object.assign(() => {}, { declareLegacyNamespace() {} }),
      require: load,
    };
    const fn = vm.runInContext(
      '(function (goog, __rec) { let exports = __rec.exports;\n' + mod.source + '\n;return exports; })',
      sandbox, { filename: mod.file });
    rec.exports = fn(goog, rec);
    return rec.exports;
  }
  return load;
}

// ── Creative realm: the sandboxed iframe the vendor JS runs in ──────────────
function createCreativeRealm({ protocolNonce, placementSessionId, deliverToPublisher }) {
  const beacons = [];
  const consoleLines = [];
  const messageListeners = new Set();
  // The creative's view of its (cross-origin) parent. Shim Register posts go
  // through it to the publisher page.
  const parentWindow = {
    postMessage(message, targetOrigin) { post((m) => deliverToPublisher(m, targetOrigin), message); },
  };
  const sandbox = {
    console: {
      log: (...a) => consoleLines.push(a.join(' ')),
      warn: (...a) => consoleLines.push(a.join(' ')),
      error: (...a) => consoleLines.push(a.join(' ')),
      info: (...a) => consoleLines.push(a.join(' ')),
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      createElement(tagName) {
        const el = { tagName, addEventListener() {} };
        Object.defineProperty(el, 'src', { set(v) { beacons.push(v); }, configurable: true });
        return el;
      },
    },
    frames: {},
    addEventListener(type, fn) { if (type === 'message') messageListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') messageListeners.delete(fn); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = parentWindow;
  vm.createContext(sandbox);

  installOmidShim({
    protocolNonce,
    placementSessionId,
    containerOrigin: PUBLISHER_ORIGIN,
    targetWindow: sandbox,
    parentWindow,
  });

  // Observation only: record (then rethrow) any vendor session-observer throw
  // the shim's deliver() would otherwise swallow, so a red run names the cause.
  const observerThrows = [];
  const realRegister = sandbox.omid3p.registerSessionObserver;
  sandbox.omid3p.registerSessionObserver = function (cb, vendorKey, injectionId) {
    return realRegister.call(this, function (ev) {
      try { return cb(ev); } catch (e) {
        observerThrows.push({ vendorKey, type: ev && ev.type, error: String(e) });
        throw e;
      }
    }, vendorKey, injectionId);
  };

  return {
    sandbox,
    beacons,
    consoleLines,
    observerThrows,
    load: makeGoogLoader(sandbox),
    receive(message) {
      const event = { source: parentWindow, origin: PUBLISHER_ORIGIN, data: message };
      for (const fn of Array.from(messageListeners)) fn(event);
    },
  };
}

// Boots IAB's clients as their main.js entry points do.
function bootIabReferenceClients(realm) {
  const VerificationClient = realm.load('omid.verificationClient.VerificationClient');
  const Validation = realm.load('omid.validationVerificationScript.ValidationVerificationClient');
  const Compliance = realm.load('omid.complianceVerificationScript.ComplianceVerificationClient');
  const vc = new VerificationClient();
  new Validation(vc, 'iabtechlab.com-omid');
  new Compliance(new VerificationClient(), 'iabtechlab.com-omid');
  return { omid3pBound: !!vc.omid3p, supported: vc.isSupported() };
}

// Decodes the event each IAB client beaconed. Non-event beacons (version,
// supported, OmidSupported[...]) decode to null.
function validationEvent(url) {
  if (!url.startsWith(VALIDATION_BEACON_PREFIX)) return null;
  const msg = decodeURIComponent(url.slice(VALIDATION_BEACON_PREFIX.length));
  const json = msg.slice(msg.indexOf('::') + 2);
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && typeof parsed.type === 'string' ? parsed : null;
  } catch (_) { return null; }
}
function complianceEvent(url) {
  if (!url.startsWith(COMPLIANCE_BEACON_PREFIX)) return null;
  const raw = new URLSearchParams(url.slice(COMPLIANCE_BEACON_PREFIX.length)).get('rawJSON');
  if (raw === null) return null;
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed.type === 'string' ? parsed : null;
}
function countByType(events) {
  const counts = {};
  for (const ev of events) counts[ev.type] = (counts[ev.type] || 0) + 1;
  return counts;
}
function beaconCounts(realm) {
  return {
    validation: countByType(realm.beacons.map(validationEvent).filter(Boolean)),
    compliance: countByType(realm.beacons.map(complianceEvent).filter(Boolean)),
  };
}

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Drives one full placement: render → OMID session → ACTIVE → close, with
// IAB's clients loaded inline in the creative before the session starts.
async function runPlacement({ deliverSessionStartInStart = true } = {}) {
  installOmSdk({ deliverSessionStartInStart });
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    partnerName: 'sharc',
    partnerVersion: '0.7.13',
    creativeType: 'htmlDisplay',
    impressionType: 'beginToRender',
    mediaType: 'display',
  });
  const security = [];
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

  let realm = null;
  const omidEnvelopes = [];
  const phaseAtSessionStart = [];
  c._iframe.contentWindow.postMessage = (message) => {
    if (!message || typeof message.type !== 'string' || message.type.indexOf('SHARC:Omid:') !== 0) return;
    omidEnvelopes.push(structuredClone(message));
    if (message.event && message.event.type === 'sessionStart') {
      phaseAtSessionStart.push(c.protocolRouter.getPhase());
    }
    if (realm) post((m) => realm.receive(m), message);
  };
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
  const omidNonce = c.protocolRouter.getProtocol('SHARC:Omid:').protocolNonce;

  realm = createCreativeRealm({
    protocolNonce: omidNonce,
    placementSessionId: c.placementSessionId,
    deliverToPublisher(message) {
      window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: message, origin: RENDERER_ORIGIN, source: c._iframe.contentWindow,
      }));
    },
  });
  const boot = bootIabReferenceClients(realm);

  // Plain subscriptions on the real omid3p surface (#450 probes): a session
  // observer, and addEventListener for each session-event type.
  const sessionObserverTypes = [];
  realm.sandbox.omid3p.registerSessionObserver((ev) => sessionObserverTypes.push(ev.type), 'probe-vendor');
  const sessionTypeListenerHits = [];
  for (const t of SESSION_EVENT_TYPES) {
    realm.sandbox.omid3p.addEventListener(t, (ev) => sessionTypeListenerHits.push(ev.type));
  }

  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }
  await settle();

  // Late observer: replay must also carry session events only.
  const lateObserverTypes = [];
  realm.sandbox.omid3p.registerSessionObserver((ev) => lateObserverTypes.push(ev.type), 'late-vendor');
  await settle();

  c.close();
  await settle();

  return {
    c, realm, boot, security, omidNonce,
    rendererNonce: c._rendererProtocolNonce,
    omidEnvelopes, phaseAtSessionStart,
    sessionObserverTypes, lateObserverTypes, sessionTypeListenerHits,
    countsAfterClose: beaconCounts(realm),
  };
}

function normalizeEnvelope(env, run) {
  return JSON.stringify(env, (key, value) => {
    if (value === run.omidNonce) return '<omid-nonce>';
    if (value === run.c.placementSessionId) return '<placementSessionId>';
    if (key === 'timestamp' && typeof value === 'number') return '<timestamp>';
    return value;
  });
}

console.log('test-omid-iab-reference-clients.js — IAB reference verification clients gate (#449, #450)\n');

const run = await runPlacement();

if (process.env.SHARC_PRINT_GOLDEN === '1') {
  const golden = run.omidEnvelopes
    .filter((e) => !(e.event && e.event.type === 'sessionStart'))
    .map((e) => normalizeEnvelope(e, run));
  console.log('GOLDEN ' + JSON.stringify(golden, null, 2));
}

section('A. harness is live: IAB clients bound to the SHARC omid3p shim');
assert(run.boot.omid3pBound, 'IAB VerificationClient bound to window.omid3p (omid3p path, not service communication)');
assert(run.boot.supported, 'IAB VerificationClient.isSupported() is true');
assert(run.omidEnvelopes.some((e) => e.event && e.event.type === 'impression'),
  'the bridge relayed an impression (the scenario reached ACTIVE)');

section('B. #449: sessionStart reaches IAB clients without throwing, and its beacon fires');
{
  const ssThrows = run.realm.observerThrows.filter((t) => t.type === 'sessionStart');
  assert(ssThrows.length === 0,
    'no IAB session observer throws on sessionStart (got: '
    + JSON.stringify(ssThrows.map((t) => t.vendorKey + ': ' + t.error)) + ')');
  assert(run.countsAfterClose.validation.sessionStart === 1,
    'ValidationVerificationClient sends exactly 1 sessionStart beacon (got '
    + (run.countsAfterClose.validation.sessionStart || 0) + ')');
  assert(run.countsAfterClose.compliance.sessionStart === 1,
    'ComplianceVerificationClient sends exactly 1 sessionStart beacon (got '
    + (run.countsAfterClose.compliance.sessionStart || 0) + ')');
}

section('C. #449: the relayed sessionStart is the OM SDK\'s real event data, in order');
{
  const starts = run.omidEnvelopes.filter((e) => e.event && e.event.type === 'sessionStart');
  assert(starts.length === 1, 'exactly one sessionStart envelope relayed (got ' + starts.length + ')');
  const wireData = starts.length ? starts[0].event.data : null;
  assert(JSON.stringify(wireData) === JSON.stringify(REAL_SESSION_START_DATA)
    && wireData && Object.prototype.hasOwnProperty.call(wireData.context || {}, 'customReferenceData'),
    'sessionStart data on the wire is the OM SDK session observer\'s own sessionStart data, verbatim');
  const firstEvent = run.omidEnvelopes.find((e) => e.type === 'SHARC:Omid:Event');
  assert(firstEvent && firstEvent.event.type === 'sessionStart',
    'sessionStart is the first OMID Event relayed (before loaded/impression)');
  assert(run.phaseAtSessionStart.length === 1 && run.phaseAtSessionStart[0] === 'omid-active',
    'router phase is omid-active when sessionStart is posted (got '
    + JSON.stringify(run.phaseAtSessionStart) + ')');
}

section('D. #450: exactly one impression beacon per impression, per IAB client');
{
  const impressions = run.omidEnvelopes.filter((e) => e.event && e.event.type === 'impression').length;
  assert(impressions === 1, 'the bridge relayed exactly one impression (got ' + impressions + ')');
  assert(run.countsAfterClose.validation.impression === 1,
    'ValidationVerificationClient sends exactly 1 impression beacon (got '
    + (run.countsAfterClose.validation.impression || 0) + ')');
  assert(run.countsAfterClose.compliance.impression === 1,
    'ComplianceVerificationClient sends exactly 1 impression beacon (got '
    + (run.countsAfterClose.compliance.impression || 0) + ')');
  assert(run.countsAfterClose.validation.loaded === 1 && run.countsAfterClose.compliance.loaded === 1,
    'each IAB client sends exactly 1 loaded beacon (got validation '
    + (run.countsAfterClose.validation.loaded || 0) + ', compliance '
    + (run.countsAfterClose.compliance.loaded || 0) + ')');
}

section('E. #450: session observers receive session events only (OMID API 1.5 p.28)');
{
  assert(run.sessionObserverTypes.length > 0
    && run.sessionObserverTypes.every((t) => SESSION_EVENT_TYPES.includes(t)),
    'a live session observer receives only session events (got '
    + JSON.stringify(run.sessionObserverTypes) + ')');
  assert(run.sessionObserverTypes[0] === 'sessionStart'
    && run.sessionObserverTypes.filter((t) => t === 'sessionFinish').length === 1,
    'the live session observer gets sessionStart first and exactly one sessionFinish');
  assert(JSON.stringify(run.lateObserverTypes) === JSON.stringify(['sessionStart', 'sessionFinish']),
    'a late session observer is replayed session events only, then sessionFinish live (got '
    + JSON.stringify(run.lateObserverTypes) + ')');
  assert(run.sessionTypeListenerHits.length === 0,
    'addEventListener(sessionStart|sessionError|sessionFinish) receives nothing: session events go to session observers only (got '
    + JSON.stringify(run.sessionTypeListenerHits) + ')');
  assert(run.countsAfterClose.validation.sessionFinish === 1 && run.countsAfterClose.compliance.sessionFinish === 1,
    'each IAB client sends exactly 1 sessionFinish beacon (got validation '
    + (run.countsAfterClose.validation.sessionFinish || 0) + ', compliance '
    + (run.countsAfterClose.compliance.sessionFinish || 0) + ')');
}

section('F. nonce isolation: no protocol nonce reaches vendor JS');
{
  const vendorVisible = JSON.stringify({
    beacons: run.realm.beacons,
    console: run.realm.consoleLines,
    surface: Object.keys(run.realm.sandbox),
  });
  assert(vendorVisible.indexOf(run.omidNonce) === -1, 'OMID protocol nonce never appears in any beacon or vendor log');
  assert(vendorVisible.indexOf(run.rendererNonce) === -1, 'renderer protocol nonce never appears in any beacon or vendor log');
  assert(run.security.length === 0, 'no security events raised by the round trip (got '
    + JSON.stringify(run.security) + ')');
}

section('G. regression: OMID envelopes other than sessionStart are byte-identical to main');
{
  const actual = run.omidEnvelopes
    .filter((e) => !(e.event && e.event.type === 'sessionStart'))
    .map((e) => normalizeEnvelope(e, run));
  const golden = GOLDEN_NON_SESSIONSTART_ENVELOPES;
  assert(Array.isArray(golden) && golden.length > 0, 'golden envelope list is present');
  const same = JSON.stringify(actual) === JSON.stringify(golden);
  assert(same, 'non-sessionStart OMID envelopes match origin/main 4550bf5 byte-for-byte'
    + (same ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}

section('H. #449 fallback: an OM SDK that does not deliver sessionStart inside start()');
{
  const fb = await runPlacement({ deliverSessionStartInStart: false });
  const starts = fb.omidEnvelopes.filter((e) => e.event && e.event.type === 'sessionStart');
  const data = starts.length ? starts[0].event.data : {};
  const ctx = data && data.context;
  assert(starts.length === 1 && ctx && typeof ctx === 'object',
    'sessionStart is still relayed exactly once, with a context object');
  assert(ctx && ctx.apiVersion === '1.0' && ctx.environment === 'web' && ctx.accessMode === 'limited',
    'fallback context is spec-shaped: apiVersion 1.0, environment web, accessMode limited');
  assert(ctx && ctx.omidJsInfo && typeof ctx.omidJsInfo.omidImplementer === 'string'
    && ctx.omidJsInfo.omidImplementer !== 'omsdk',
    'fallback omidJsInfo never claims to be the OM SDK (omidImplementer !== "omsdk")');
  assert(fb.realm.observerThrows.filter((t) => t.type === 'sessionStart').length === 0,
    'no IAB session observer throws on the fallback sessionStart');
  assert(fb.countsAfterClose.validation.sessionStart === 1 && fb.countsAfterClose.compliance.sessionStart === 1,
    'each IAB client sends exactly 1 sessionStart beacon on the fallback path');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} IAB reference-client assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All IAB reference-client assertions passed.');
process.exit(0);
