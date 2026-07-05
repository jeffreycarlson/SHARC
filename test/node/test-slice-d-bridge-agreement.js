/**
 * test-slice-d-bridge-agreement.js — Slice D RED TESTS (L-11 bridge agreement).
 *
 * Pins L-11 (unified-lifecycle-ordering §3A.6 / Slice D ADR 2026-07-04): ONE
 * composed effective-visibility payload feeds EVERY consumer tier, and all of
 * them report the SAME number:
 *
 *   wire `effectivePercent`
 *     == MRAID `exposureChange` exposedPercentage
 *     == SafeFrame `geom().self.iv * 100`
 *     == OMID `adView.percentageInView`
 *
 * Distribution seams under test:
 *   - creative wire (`SHARC.on('effectiveVisibilityChange')`) for the
 *     creative-side MRAID + SafeFrame bridges;
 *   - container seam `_notifyExtensionsLifecycle('effectiveVisibilityChange',
 *     { payload })` — the ONE new line in `_pushEffectiveVisibility` — for the
 *     container-side OMID extension.
 *
 * Also pins: OMID VISIBLE ⟺ effectivePercent > 0 (Δ8); OMID
 * `adView.reasons` carries the OMID-boundary mapping of the EV-5 token
 * (Slice E6a: offscreen→['clipped'], null→[]); OMID geometry rect fields stay
 * iframe-bounds-derived. The EV-5→OMID vocabulary map itself is pinned in
 * test-omid-reasons-vocab.js; here it only anchors the L-11 number agreement.
 *
 * STATUS: RED by design on bcda6f2. Today: MRAID reads the binary
 * `_isViewable` (100/0); SafeFrame's computeInViewPct reads the enum
 * ({0,100}); OMID computes its own `percentageInView` from iframe∩viewport
 * and `onContainerLifecycleEvent` has no 'effectiveVisibilityChange' case, so
 * the container-seam delivery is dropped on the floor. The composer + wire
 * (Slice C) are live — the wire-payload asserts are green scaffolding that
 * anchor the consumer asserts to real composer output.
 *
 * HARNESS: container/OMID tier mirrors test-omid-container-lifecycle.js
 * (JSDOM + real SHARCContainer + mock OmidSessionClient); the composed
 * payloads are produced by the REAL composer (raw-input drive +
 * `_pushEffectiveVisibility()`, mirroring test-effective-visibility-
 * composer.js) and captured off the stubbed protocol sender. The SAME
 * captured payloads are then delivered to fresh creative-side MRAID and
 * SafeFrame bridge instances over a fake `window.SHARC` bus (mirroring
 * test-mraid-visibility-channel.js), under swapped fake windows so each
 * bridge installs cleanly next to the JSDOM globals.
 */

import { JSDOM } from 'jsdom';

// ── DOM globals — in place before the container module loads ─────────────────
const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body></body></html>',
  { url: 'https://publisher.example/page.html' },
);
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return 'visible'; },
});
global.HTMLElement = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
globalThis.location = { protocol: 'http:', hostname: 'localhost' };

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
dom.window.SHARC = dom.window.SHARC || {};
dom.window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');

const DOM_WIN = dom.window;

// ── Assertion harness ─────────────────────────────────────────────────────────
let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}
const js = (v) => JSON.stringify(v);

// ── Mock OM SDK (minimal subset of test-omid-container-lifecycle.js) ─────────
function createMockOmidSdk() {
  const stats = { visibilityStates: [], startCalls: 0 };
  class Partner { constructor(name, version) { this.name = name; this.version = version; } }
  class VerificationScriptResource {}
  class Context {
    constructor(partner, verificationScripts) {
      this.partner = partner;
      this.verificationScripts = verificationScripts;
    }
    setContentUrl() {}
    setServiceScriptUrl() {}
  }
  class AdSession {
    constructor(context) { this.context = context; this._observers = []; }
    setCreativeType() {}
    setImpressionType() {}
    registerAdView() {}
    registerSessionObserver(fn) { this._observers.push(fn); }
    start() { stats.startCalls++; }
    finish() { this._observers.forEach((fn) => fn({ type: 'sessionFinish' })); }
  }
  class AdEvents {
    constructor(session) { this.session = session; }
    loaded() {}
    impressionOccurred() {}
    stateChange(v) { stats.visibilityStates.push(v); }
  }
  class MediaEvents {
    constructor(session) { this.session = session; }
    playerStateChange() {}
  }
  class VastProperties {}
  return {
    sdk: { Partner, VerificationScriptResource, Context, AdSession, AdEvents, MediaEvents, VastProperties },
    stats,
  };
}

// ── Creative-side bridge harnesses (fake window.SHARC bus) ────────────────────
const DEFAULT_ENV = {
  currentPlacement: {
    initialDefaultSize: { width: 320, height: 50 },
    maxExpandSize: { width: 1024, height: 768 },
    viewportSize: { width: 1024, height: 768 },
  },
  initialPosition: { x: 0, y: 0, width: 320, height: 50 },
  data: { placement: { instl: 0 }, app: { bundle: 'test-app' } },
};

let nonce = 0;

function makeFakeSharcBus() {
  const readyCallbacks = [];
  const eventListeners = {};
  let lastBusState;
  let lastBusEV;
  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart() {},
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
      // Creative-bus replay-of-last for both latching value events (R1 D3 +
      // Slice C F4) — the delivery contract the bridges subscribe against.
      if (name === 'stateChange' && lastBusState !== undefined) cb(lastBusState);
      if (name === 'effectiveVisibilityChange' && lastBusEV !== undefined) cb(lastBusEV);
    },
    hasFeature() { return true; },
    requestNavigation() { return Promise.resolve(); },
    requestPlacementChange() { return Promise.resolve(); },
    requestClose() { return Promise.resolve(); },
    requestFeature() {},
  };
  return {
    SHARC,
    driveState(state) {
      lastBusState = state;
      (eventListeners.stateChange || []).forEach((fn) => fn(state));
    },
    driveEV(payload) {
      lastBusEV = payload;
      (eventListeners.effectiveVisibilityChange || []).forEach((fn) => fn(payload));
    },
    drivePlacementChange(update) {
      (eventListeners.placementChange || []).forEach((fn) => fn(update));
    },
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
  };
}

/** Installs a fresh MRAID bridge on a fake window; returns bus + recorders. */
async function makeMraidConsumer() {
  const bus = makeFakeSharcBus();
  globalThis.window = { __sharcMraidBridgeAutoInstall: true, SHARC: bus.SHARC };
  await import(`../../dist/sharc-mraid-bridge.mjs?agreement=${Date.now()}-${nonce++}`);
  const win = globalThis.window;
  const exposures = [];
  const viewables = [];
  const states = [];
  win.mraid.addEventListener('exposureChange', (pct, rect, occl) => exposures.push({ pct, rect, occl }));
  win.mraid.addEventListener('viewableChange', (v) => viewables.push(v));
  win.mraid.addEventListener('stateChange', (s) => states.push(s));
  return { ...bus, mraid: win.mraid, exposures, viewables, states };
}

/** Installs a fresh SafeFrame bridge on a fake window; returns bus + $sf. */
async function makeSafeFrameConsumer() {
  const bus = makeFakeSharcBus();
  globalThis.window = { SHARC: bus.SHARC }; // Path A: SHARC present at load ⇒ synchronous install
  await import(`../../dist/sharc-safeframe-bridge.mjs?agreement=${Date.now()}-${nonce++}`);
  const win = globalThis.window;
  const geomUpdates = [];
  win.$sf.ext.register(320, 50, (status, data) => {
    if (status === 'geom-update') geomUpdates.push(data);
  });
  return { ...bus, $sf: win.$sf, geomUpdates };
}

console.log('test-slice-d-bridge-agreement.js — Slice D L-11 bridge agreement (RED)\n');

// ══════════════════════════════════════════════════════════════════════════════
// Phase 1 — container + OMID: real composer produces the payloads; the
// container seam must fan them out to the OMID extension.
// ══════════════════════════════════════════════════════════════════════════════

const mock = createMockOmidSdk();
global.OmidSessionClient = mock.sdk;
DOM_WIN.OmidSessionClient = mock.sdk;

const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });

document.body.innerHTML = '';
const slot = document.createElement('div');
slot.id = 'ad-slot';
document.body.appendChild(slot);

const c = new SHARCContainer({
  creativeHtml: '<html><head></head><body>ad</body></html>',
  creativeRendererUrl: 'https://renderer.example/0.7.1/',
  placementElement: slot,
  creativeMeta: { apis: [7] },
  extensions: [bridge],
});

// Registered ad view with REAL bounds so today's self-computed
// percentageInView reads 100 — sharpening the discriminator against the
// composed 73 the re-point must deliver instead.
c._iframe = document.createElement('iframe');
c._iframe.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 250, width: 300, height: 250 });

// Stub the wire senders (harness precedent: test-omid-container-lifecycle.js
// stubs sendStateChange; test-effective-visibility-composer.js captures
// sendEffectiveVisibilityChange). Non-empty sessionId opens the push gate.
const wireSent = [];
c._protocol.sendStateChange = () => {};
c._protocol.sendEffectiveVisibilityChange = (payload) => wireSent.push(payload);
c._protocol.sessionId = 'sess-slice-d';

// Prime the composer raw inputs BEFORE establish so any establish-time
// _syncEffectiveVisibility already composes {73,'offscreen'}.
c.creativeRendered = true;
c._rawParentVisible = true;
c._frozen = false;
c._rawIntersection = 0.73;

// Record every _relayOmidEvent call-in (upstream of the D-7 emission-side
// throttle) — the seam the EV feed must route THROUGH. The original still
// runs, so the real relay path stays exercised.
const relayed = [];
const origRelay = bridge._relayOmidEvent;
bridge._relayOmidEvent = function (type, data) {
  relayed.push({ type, data });
  return origRelay.apply(this, arguments);
};
const geometryRelays = () => relayed.filter((r) => r.type === 'geometryChange');

// Establish: ready → active starts the OM session (HB-6: establish gates THAT).
c.setState('ready');
c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
c.setState('active');
c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

check(mock.stats.startCalls === 1, 'harness: OM AdSession started once at ready/active');
check(bridge._omid.sessionStarted === true, 'harness: sessionStarted true (signals are live, not swallowed by the session gate)');

/** Mutates raw inputs, pushes through the REAL composer, returns the wire payload. */
function composeAndPush(mutate) {
  mutate();
  c._pushEffectiveVisibility();
  return wireSent[wireSent.length - 1];
}

// ── Payload A: 73 / 'offscreen' ───────────────────────────────────────────────
{
  console.log('A — one composed payload {73, offscreen} reaches the OMID extension:');
  const evA = composeAndPush(() => { c._rawIntersection = 0.73; });
  check(!!evA && evA.effectivePercent === 73 && evA.reason === 'offscreen',
    'composer (Slice C, green scaffolding): wire payload is {73, "offscreen"} — got ' + js(evA));

  const gA = geometryRelays()[geometryRelays().length - 1];
  check(!!gA, 'a geometryChange was relayed through _relayOmidEvent for the established/measured ad');
  check(!!gA && gA.data.adView.percentageInView === 73,
    'OMID adView.percentageInView === 73 — the COMPOSED integer, not a self-computed rect∩viewport (RED: reads ' + (gA ? gA.data.adView.percentageInView : 'n/a') + ' today)');
  check(!!gA && js(gA.data.adView.reasons) === js(['clipped']),
    'OMID adView.reasons === ["clipped"] — EV-5 offscreen mapped at the OMID boundary (Slice E6a); wire keeps "offscreen"');
  check(!!gA && gA.data.adView.geometry.width === 300 && gA.data.adView.geometry.height === 250,
    'OMID adView.geometry stays iframe-bounds-derived (D-5: rect fields container-sourced, untouched)');
  check(js(mock.stats.visibilityStates) === js(['VISIBLE']),
    'OMID visibility trace is ["VISIBLE"] — 73 > 0 keeps VISIBLE, no spurious flip');
}

// ── Payload B: 0 / 'backgrounded' ─────────────────────────────────────────────
let evB;
{
  console.log('B — {0, backgrounded}: every consumer reads 0; OMID flips NON_VISIBLE:');
  const geomMark = geometryRelays().length;
  evB = composeAndPush(() => { c._rawParentVisible = false; });
  check(!!evB && evB.effectivePercent === 0 && evB.reason === 'backgrounded',
    'composer: wire payload is {0, "backgrounded"} — got ' + js(evB));

  check(mock.stats.visibilityStates[mock.stats.visibilityStates.length - 1] === 'NON_VISIBLE',
    'OMID adEvents.stateChange("NON_VISIBLE") signaled off the EV delivery (VISIBLE ⟺ pct > 0) (RED: no effectiveVisibilityChange case exists — signal never fires)');
  const newGeoms = geometryRelays().slice(geomMark);
  check(newGeoms.length >= 1,
    'the EV delivery relayed a geometryChange through _relayOmidEvent (D-7 seam) (RED: container never fans EV out to extensions today)');
  const gB = newGeoms[newGeoms.length - 1];
  check(!!gB && gB.data.adView.percentageInView === 0, 'OMID percentageInView === 0 at backgrounded');
  check(!!gB && js(gB.data.adView.reasons) === js(['backgrounded']), 'OMID adView.reasons === ["backgrounded"]');
  check(!!gB && gB.data.adView.onScreenGeometry.width === 0 && gB.data.adView.onScreenGeometry.height === 0,
    'onScreenGeometry zeroed when effectivePercent === 0 (replaces the visibilityState gate)');
}

// ── Payload C: 100 / null ─────────────────────────────────────────────────────
let evC;
{
  console.log('C — {100, null}: OMID back to VISIBLE; reasons pass-through is []:');
  const geomMark = geometryRelays().length;
  evC = composeAndPush(() => { c._rawParentVisible = true; c._rawIntersection = 1.0; });
  check(!!evC && evC.effectivePercent === 100 && evC.reason === null,
    'composer: wire payload is {100, null} — got ' + js(evC));

  check(js(mock.stats.visibilityStates) === js(['VISIBLE', 'NON_VISIBLE', 'VISIBLE']),
    'OMID visibility trace is exactly [VISIBLE, NON_VISIBLE, VISIBLE] — boolean flips ride the EV crossings (RED: trace is ' + js(mock.stats.visibilityStates) + ' today)');
  const gC = geometryRelays().slice(geomMark).pop();
  check(!!gC && gC.data.adView.percentageInView === 100, 'OMID percentageInView === 100 on return');
  check(!!gC && js(gC.data.adView.reasons) === js([]), 'OMID adView.reasons === [] when reason is null');
}

const evA = wireSent.find((p) => p.effectivePercent === 73) || null;
const omidPctAt73 = (() => {
  const g = geometryRelays().find((r) => r.data.adView && r.data.adView.percentageInView === 73
    && js(r.data.adView.reasons) === js(['clipped']));
  return g ? g.data.adView.percentageInView : NaN;
})();

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2 — creative wire: the SAME captured payloads delivered to the MRAID
// and SafeFrame bridges over SHARC.on('effectiveVisibilityChange').
// ══════════════════════════════════════════════════════════════════════════════

// ── MRAID consumer ────────────────────────────────────────────────────────────
let mraidPctAt73 = NaN;
{
  console.log('M — MRAID reads the composed values off the creative wire:');
  const m = await makeMraidConsumer();
  m.fireReady(DEFAULT_ENV);
  m.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });
  m.driveState('active'); // establish only

  m.driveEV(evA);
  const lastExp = m.exposures[m.exposures.length - 1];
  mraidPctAt73 = lastExp ? lastExp.pct : NaN;
  check(mraidPctAt73 === 73,
    'MRAID exposureChange carries exposedPercentage 73 for the SAME payload (RED: binary 100 off _isViewable today) — got ' + mraidPctAt73);
  check(m.mraid.getState() === 'default', 'MRAID getState() stays "default" while measuring (L-10)');

  m.driveEV(evB);
  check(m.mraid.isViewable() === false, 'MRAID viewable false at {0, backgrounded}');
  m.driveEV(evC);
  check(js(m.exposures.map((e) => e.pct)) === js([73, 0, 100]),
    'MRAID exposure trace across A→B→C is [73, 0, 100] (RED: got ' + js(m.exposures.map((e) => e.pct)) + ')');
  check(js(m.viewables) === js([true, false, true]),
    'MRAID viewable trace across A→B→C is [true, false, true] (EV-7: 73 ≥ 50 crosses on delivery)');
}

// ── SafeFrame consumer ────────────────────────────────────────────────────────
let sfPctAt73 = NaN;
{
  console.log('S — SafeFrame reads the composed values off the creative wire:');
  const s = await makeSafeFrameConsumer();
  s.fireReady(DEFAULT_ENV);
  s.driveState('active'); // establish; today this alone pins iv to 1.0

  const geomMark = s.geomUpdates.length;
  s.driveEV(evA);
  sfPctAt73 = s.$sf.ext.geom().self.iv * 100;
  check(sfPctAt73 === 73,
    'SafeFrame geom().self.iv * 100 === 73 for the SAME payload (RED: enum-derived 100 today) — got ' + sfPctAt73);
  check(s.$sf.ext.inViewPercentage() === 73, 'SafeFrame inViewPercentage() === 73');
  check(s.$sf.ext.geom().self.xiv === 1 && s.$sf.ext.geom().self.yiv === 1,
    'geom SHAPE unchanged: xiv/yiv keep the simplified >0 ⇒ 1 mapping');
  const newGeoms = s.geomUpdates.slice(geomMark);
  check(newGeoms.length >= 1 && newGeoms[newGeoms.length - 1].self.iv === 0.73,
    'geom-update fired on the EV change with self.iv 0.73 (RED: no EV subscription — no callback today)');

  s.driveEV(evB);
  check(s.$sf.ext.geom().self.iv === 0, 'SafeFrame iv reads 0 at {0, backgrounded} regardless of intersection (Δ7)');
  check(s.$sf.ext.winHasFocus() === true,
    'winHasFocus() untouched by EV — focus stays on the enum (correct residual use)');
}

// ══════════════════════════════════════════════════════════════════════════════
// L-11 — the agreement pin: one number everywhere.
// ══════════════════════════════════════════════════════════════════════════════
{
  console.log('L-11 — wire == MRAID == SafeFrame == OMID:');
  const wirePct = evA ? evA.effectivePercent : NaN;
  check(
    wirePct === 73 && mraidPctAt73 === 73 && sfPctAt73 === 73 && omidPctAt73 === 73,
    'ONE composed payload, one number: wire ' + wirePct + ' == MRAID ' + mraidPctAt73
      + ' == SafeFrame ' + sfPctAt73 + ' == OMID ' + omidPctAt73 + ' == 73',
  );
}

// Restore the JSDOM window for any teardown paths.
globalThis.window = DOM_WIN;

if (failures > 0) {
  console.error(`\n✗ ${failures} Slice D bridge-agreement assertion(s) failed (RED expected until develop lands the re-point).`);
  process.exit(1);
}
console.log('\n✓ All Slice D bridge-agreement assertions passed.');
