/**
 * test-omid-bridge-edge-fixes.js — 0.7.8 OMID bridge edge-case fixes (#250).
 *
 * Three publisher-side bridge fixes, each with a regression-sensitive guard:
 *
 *   C5 — the WHOLE active-burst (sessionStart → loaded → impression → first
 *        geometryChange) must survive an unresolved router-derived OMID nonce at
 *        _createSession time. The bridge queues every dropped relay in order and
 *        flushes the queue from the router onReady — each relayed exactly once,
 *        in chronological order. (Pre-fix: only sessionStart was re-driven;
 *        loaded/impression were dropped permanently because their `*Fired` flags
 *        were already set, so the burst caller never relayed them again →
 *        measurement silently and permanently lost.)
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
const { SHARCContainer, SHARC_BUILD_MODE } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');

let failures = 0;
function section(name) { console.log('\n' + name); }
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}
function assertDevConsole(condition, message) {
  if (SHARC_BUILD_MODE !== 'dev') {
    console.log('  ✓', `${message} (dev-console assertion skipped in prod bundle)`);
    return;
  }
  assert(condition, message);
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

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

console.log('test-omid-bridge-edge-fixes.js — 0.7.8 OMID bridge edge fixes (#250)\n');

// ════════════════════════════════════════════════════════════════════════════
// C5 — the whole active-burst survives an unresolved OMID nonce.
//
// Faithful reproduction of the start()-wins-the-race ordering: we intercept the
// router-derived nonce so it is NULL at _createSession time, drive the container
// to active (which relays the full burst — sessionStart → loaded → impression →
// first geometryChange — while the nonce is unresolved), then fire the captured
// onReady. Post-fix: every burst event is queued and flushed exactly once from
// onReady, in chronological order. Pre-fix: only sessionStart was re-driven;
// loaded/impression early-returned on the null nonce AND had their `*Fired`
// flags set, so they were never relayed again → the "loaded/impression each
// reach the shim exactly once after onReady" assertions FAIL.
// ════════════════════════════════════════════════════════════════════════════
section('C5. the whole active-burst survives an unresolved OMID nonce');
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
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  c._iframe.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 330,
    bottom: 70,
    width: 320,
    height: 50,
  });
  const obstruction = document.createElement('button');
  obstruction.id = 'sharc-close';
  obstruction.getBoundingClientRect = () => ({
    left: 300,
    top: 20,
    right: 330,
    bottom: 50,
    width: 30,
    height: 30,
  });
  bridge.registerFriendlyObstruction(
    obstruction,
    'not-a-purpose',
    'x'.repeat(300)
  );
  bridge._friendlyObstructionRegistered = true;
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
  // Pre-fix the shape was a single _omidPendingSessionStart boolean and the
  // loaded/impression relays were simply dropped. Post-fix the WHOLE burst is
  // queued in chronological order behind sessionStart.
  assert(omidEvents(posted, 'loaded').length === 0
      && omidEvents(posted, 'impression').length === 0,
    'loaded/impression are NOT posted while the nonce is unresolved either');
  const pendingTypes = bridge._omidPendingRelays.map((r) => r.type);
  assert(pendingTypes[0] === 'sessionStart'
      && pendingTypes.indexOf('loaded') > 0
      && pendingTypes.indexOf('impression') > pendingTypes.indexOf('loaded'),
    'the dropped burst is queued in order: sessionStart before loaded before impression '
      + '(got [' + pendingTypes.join(', ') + '])');
  // The first geometryChange is part of the same active burst (§ 7.3) and must
  // be queued too — after impression. A null-nonce throttle-drop here would
  // never consume a sequence, so a monotonic-sequence check downstream cannot
  // detect a missing geometryChange; the queue must carry it explicitly.
  assert(pendingTypes.indexOf('geometryChange') > pendingTypes.indexOf('impression'),
    'the first geometryChange is queued after impression (got [' + pendingTypes.join(', ') + '])');

  // Now the nonce resolves: fire the bridge's real onReady with the derived
  // nonce, exactly as the router would once crypto.subtle settles.
  assert(typeof capturedOnReady === 'function' && typeof capturedNonce === 'string',
    'captured the bridge onReady and the router-derived nonce');
  capturedOnReady({ protocolNonce: capturedNonce });

  const starts = omidEvents(posted, 'sessionStart');
  assert(starts.length === 1,
    'sessionStart is relayed EXACTLY once after onReady resolves (got ' + starts.length + ')');

  // THESE are the regression assertions for the incomplete-fix bug. Pre-fix
  // loaded/impression were dropped permanently (their *Fired flags were already
  // set, so the burst caller never relayed them again, and onReady re-drove
  // sessionStart only) → both lengths are 0 → these assertions FAIL pre-fix.
  const loadeds = omidEvents(posted, 'loaded');
  const impressions = omidEvents(posted, 'impression');
  assert(loadeds.length === 1,
    'loaded reaches the shim EXACTLY once after onReady resolves (got ' + loadeds.length + ')');
  assert(impressions.length === 1,
    'impression reaches the shim EXACTLY once after onReady resolves (got ' + impressions.length + ')');
  // geometryChange is the SAME-CLASS regression as loaded/impression but the
  // one a monotonic-sequence check cannot catch: a null-nonce/throttle drop
  // returns BEFORE consuming a sequence, so [1,2,3] with geometryChange silently
  // dropped still passes monotonic + seqs[0]===1. Assert it positively — exactly
  // once after onReady, and after impression in the flushed order.
  const geometryChanges = omidEvents(posted, 'geometryChange');
  assert(geometryChanges.length === 1,
    'geometryChange reaches the shim EXACTLY once after onReady resolves (got '
      + geometryChanges.length + ')');
  const geometryData = geometryChanges[0].event.data;
  assert(geometryData && isNumber(geometryData.viewport.width) && isNumber(geometryData.viewport.height),
    'geometryChange carries an OMID viewport object');
  assert(geometryData && geometryData.adView && isNumber(geometryData.adView.percentageInView),
    'geometryChange carries adView.percentageInView');
  assert(geometryData.adView.percentageInView === 100,
    'geometryChange computes percentageInView from the registered ad view bounds');
  assert(geometryData && geometryData.adView && geometryData.adView.geometry
      && isNumber(geometryData.adView.geometry.width) && isNumber(geometryData.adView.geometry.height),
    'geometryChange carries adView.geometry dimensions');
  assert(geometryData.adView.geometry.x === 10 && geometryData.adView.geometry.y === 20,
    'geometryChange geometry uses the registered ad view position');
  assert(geometryData && geometryData.adView && geometryData.adView.onScreenGeometry
      && isNumber(geometryData.adView.onScreenGeometry.width)
      && Array.isArray(geometryData.adView.onScreenGeometry.obstructions),
    'geometryChange carries adView.onScreenGeometry with obstructions');
  assert(geometryData.adView.onScreenGeometry.width === 320
      && geometryData.adView.onScreenGeometry.height === 50,
    'geometryChange onScreenGeometry reflects the visible portion');
  assert(geometryData.adView.onScreenGeometry.obstructions.length === 1,
    'geometryChange lists registered friendly obstructions');
  assert(geometryData.adView.onScreenGeometry.obstructions[0].x === 300
      && geometryData.adView.onScreenGeometry.obstructions[0].width === 30,
    'geometryChange obstruction geometry reflects the registered obstruction bounds');
  assert(geometryData.adView.onScreenGeometry.obstructions[0].purpose === 'closeAd',
    'geometryChange obstruction carries the sanitized friendly obstruction purpose');
  assert(geometryData.adView.onScreenGeometry.obstructions[0].reason.length === 256,
    'geometryChange obstruction carries a length-capped friendly obstruction reason');
  assert(geometryData.adView.onScreenGeometry.obstructions[0].friendlyObstructionViewId === 'sharc-close',
    'geometryChange obstruction carries the friendly obstruction view id');

  const notVisibleData = bridge._geometryChangeData('notVisible');
  assert(notVisibleData.adView.percentageInView === 0,
    'notVisible geometryChange intentionally reports percentageInView=0');
  assert(notVisibleData.adView.onScreenGeometry.width === 0
      && notVisibleData.adView.onScreenGeometry.height === 0,
    'notVisible geometryChange intentionally zeroes onScreenGeometry');

  // Chronological order across the FULL relayed burst. The shim's replay
  // invariant depends on this. Compare positions in the posted-envelope stream
  // (all relayed after onReady in this race scenario).
  const burst = omidEvents(posted).map((m) => m.event.type);
  const iStart = burst.indexOf('sessionStart');
  const iLoaded = burst.indexOf('loaded');
  const iImpression = burst.indexOf('impression');
  const iGeometry = burst.indexOf('geometryChange');
  assert(iStart >= 0 && iStart < iLoaded && iLoaded < iImpression && iImpression < iGeometry,
    'burst order preserved: sessionStart → loaded → impression → geometryChange (got ['
      + burst.join(', ') + '])');

  // STRUCTURAL guard against the green-but-broken failure mode: assert the WHOLE
  // flushed burst is EXACTLY the 4-element ordered sequence with sequences
  // [1,2,3,4]. This is stronger than the monotonic check below — a dropped or
  // throttled-away geometryChange yields ['sessionStart','loaded','impression']
  // (3 elements, seqs [1,2,3]), which still passes monotonic + seqs[0]===1 but
  // FAILS this exact-shape assertion. That is the bug this test must catch.
  const seqs = omidEvents(posted).map((m) => m.sequence);
  assert(
    burst.length === 4
      && burst[0] === 'sessionStart' && burst[1] === 'loaded'
      && burst[2] === 'impression' && burst[3] === 'geometryChange'
      && seqs[0] === 1 && seqs[1] === 2 && seqs[2] === 3 && seqs[3] === 4,
    'flushed burst is exactly [sessionStart, loaded, impression, geometryChange] '
      + 'with sequences [1,2,3,4] (got [' + burst.join(', ') + '] / [' + seqs.join(', ') + '])');

  // Monotonic per-session sequence with no double-consume / skip across the
  // flushed burst (retained as a secondary invariant).
  let monotonic = true;
  for (let i = 1; i < seqs.length; i++) {
    if (typeof seqs[i] !== 'number' || seqs[i] !== seqs[i - 1] + 1) monotonic = false;
  }
  assert(seqs[0] === 1 && monotonic,
    'flushed burst consumes a clean monotonic sequence 1,2,3,… (got [' + seqs.join(', ') + '])');

  assert(bridge._omidPendingRelays.length === 0,
    'the pending-relay queue is drained after the deferred flush');
  assert(bridge._omidProtocolNonce === capturedNonce,
    'bridge nonce is now the router-derived value');

  // Firing onReady again must NOT double-relay any burst event.
  const burstCountBefore = omidEvents(posted).length;
  capturedOnReady({ protocolNonce: capturedNonce });
  assert(omidEvents(posted, 'sessionStart').length === 1
      && omidEvents(posted, 'loaded').length === 1
      && omidEvents(posted, 'impression').length === 1
      && omidEvents(posted, 'geometryChange').length === 1
      && omidEvents(posted).length === burstCountBefore,
    'a second onReady does NOT double-relay any burst event (each relayed exactly once total)');
}

// ════════════════════════════════════════════════════════════════════════════
// C5b — normal path: nonce already present at _createSession. The burst relays
// inline (nothing is queued) and each of sessionStart/loaded/impression reaches
// the shim exactly once — no double-relay from the empty-queue flush in onReady.
// ════════════════════════════════════════════════════════════════════════════
section('C5b. normal path (nonce present at _createSession) relays the burst exactly once each');
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

  // No register interception this time: the router delivers the OMID nonce to
  // the bridge via onReady before we drive to active, so _relayOmidEvent posts
  // inline (the null-nonce queue path is never taken).
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

  assert(typeof bridge._omidProtocolNonce === 'string' && bridge._omidProtocolNonce.length > 0,
    'precondition: bridge OMID nonce IS resolved before the active burst (normal path)');

  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }

  assert(bridge._omidPendingRelays.length === 0,
    'nothing is queued on the normal path (the null-nonce branch is never taken)');
  assert(omidEvents(posted, 'sessionStart').length === 1,
    'sessionStart relayed exactly once inline (no double) — got '
      + omidEvents(posted, 'sessionStart').length);
  assert(omidEvents(posted, 'loaded').length === 1,
    'loaded relayed exactly once inline (no double) — got ' + omidEvents(posted, 'loaded').length);
  assert(omidEvents(posted, 'impression').length === 1,
    'impression relayed exactly once inline (no double) — got '
      + omidEvents(posted, 'impression').length);

  const burst = omidEvents(posted).map((m) => m.event.type);
  const iStart = burst.indexOf('sessionStart');
  const iLoaded = burst.indexOf('loaded');
  const iImpression = burst.indexOf('impression');
  assert(iStart === 0 && iStart < iLoaded && iLoaded < iImpression,
    'normal-path burst order preserved: sessionStart → loaded → impression (got ['
      + burst.join(', ') + '])');
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
  assertDevConsole(warnings.some((w) => /SHARCOmid/.test(w)),
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

// ════════════════════════════════════════════════════════════════════════════
// C7 — the OM SDK AdSession id is resolved ONCE at session start and reused
// for every relayed event (#253 Part 4). The JSDoc promised "Reused for every
// event" but `_omidAdSessionId()` re-read `adSession.sessionId` on every relay.
// We count reads of `adSession.sessionId` via a getter: across a full burst of
// relayed events (sessionStart → loaded → impression + a sessionError) the
// derivation source must be read at most once, every relayed Event must carry
// the SAME cached id, and that id must equal the SDK session id.
// ════════════════════════════════════════════════════════════════════════════
section('C7. AdSession id resolved once at sessionStart, reused for every event (#253)');
{
  let sessionIdReads = 0;
  let registeredObserver = null;
  const adSession = {
    get sessionId() { sessionIdReads++; return 'omsdk-session-c7'; },
    setCreativeType() {}, setImpressionType() {}, registerAdView() {},
    registerSessionObserver(cb) { registeredObserver = cb; },
    addFriendlyObstruction() {}, removeFriendlyObstruction() {},
    start() {}, finish() {},
    _emitError(data) { if (registeredObserver) registeredObserver({ type: 'sessionError', data: data || {} }); },
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

  // Drive the active burst (sessionStart → loaded → impression) then an extra
  // SDK-sourced sessionError, so the relay path runs for ≥4 events.
  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }
  adSession._emitError({ code: 13 });

  const burst = omidEvents(posted);
  assert(burst.length >= 4,
    'relayed at least four events (sessionStart, loaded, impression, sessionError) — got ' + burst.length);

  // The derivation runs ONCE at session start, NOT per relayed event. The
  // getter may be touched a small constant number of times during that single
  // resolution (the typeof/length/return reads), so the load-bearing assertion
  // is that the read count does NOT scale with the number of relayed events:
  // relaying several MORE events must add ZERO new sessionId reads.
  const readsAfterBurst = sessionIdReads;
  assert(readsAfterBurst < burst.length,
    'sessionId reads (' + readsAfterBurst + ') are fewer than relayed events (' + burst.length
      + ') — not a per-event recompute');
  const postedBefore = posted.length;
  bridge._relayOmidEvent('sessionError', { code: 21 });
  bridge._relayOmidEvent('geometryChange', { adView: {} });
  bridge._relayOmidEvent('sessionError', { code: 22 });
  assert(posted.length > postedBefore,
    'precondition: the extra relays actually posted (the relay path ran again)');
  assert(sessionIdReads === readsAfterBurst,
    'relaying MORE events adds ZERO new sessionId reads (id resolved once, cached) — was '
      + readsAfterBurst + ', now ' + sessionIdReads);
  assert(bridge._omidCachedAdSessionId === 'omsdk-session-c7',
    'the cached adSessionId is the SDK session id');
  const ids = burst.map((m) => m.event && m.event.adSessionId);
  assert(ids.every((id) => id === 'omsdk-session-c7'),
    'every relayed Event carries the same cached adSessionId === the SDK session id (got ['
      + Array.from(new Set(ids)).join(', ') + '])');

  // Teardown must invalidate the cache so a subsequent session re-resolves.
  bridge._resetSessionRefs(true);
  assert(bridge._omidCachedAdSessionId === null,
    '_resetSessionRefs invalidates the cached adSessionId (next session re-resolves)');
  c._terminate();
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ ${failures} omid-bridge-edge-fixes assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All omid-bridge-edge-fixes assertions passed.');
