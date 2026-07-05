/**
 * test-omid-reasons-vocab.js — Slice E6a Item A (OMID `reasons` boundary map).
 *
 * RATIFIED 2026-07-05. The WIRE carries honest EV-5 reason tokens
 * (`backgrounded` / `frozen` / `offscreen` / `notAttached` / null — the
 * L-12 wire-honesty invariant); the OMID boundary maps them to the
 * OMID-documented `adView.reasons` vocabulary and NOTHING ELSE. This test
 * pins that boundary mapping AND the wire-honesty pin: a creative-side
 * `effectiveVisibilityChange` listener still receives the RAW EV-5 token.
 *
 * Mapping under test (EV-5 wire token → OMID adView.reasons):
 *   null (fully visible) → []            (empty, unchanged)
 *   'backgrounded'       → ['backgrounded']
 *   'frozen'             → ['backgrounded'] (no OMID freeze token; frozen is
 *                                            deeper-backgrounded; WIRE keeps
 *                                            'frozen')
 *   'offscreen'          → ['clipped']    (the pinned OM-SDK's token for
 *                                          <100% in-view; ratified over
 *                                          'viewport')
 *   'notAttached'        → ['notFound']   (pinned SDK maps not-attached →
 *                                          notFound)
 *   any unknown/other    → []             (conservative — never emit an
 *                                          unmapped token to a vendor)
 *
 * Grounding: the OMID reason vocabulary is evidenced from the pinned real OM
 * SDK for Web (tools/creative-validator/private/vendor/omweb-v1.js,
 * checksummed in tools/creative-validator/VENDORED.md) — no OMID API PDF is
 * vendored. The pinned binary emits `clipped` for a clipped (<100% in-view)
 * ad view and `notFound` for a not-attached / no-window-focus / no-ad-view
 * input (see its Qa/S reason-derivation). Source of truth = that binary + this
 * ratification (2026-07-05), not spec text.
 *
 * STATUS: RED by design on the pre-map code. Today src/sharc-omid-bridge.js
 * :1266 is `reasons: reason ? [reason] : []` — a raw EV-5 pass-through — so
 * 'frozen' surfaces as ['frozen'] (OMID expects ['backgrounded']), 'offscreen'
 * as ['offscreen'] (expects ['clipped']), 'notAttached' as ['notAttached']
 * (expects ['notFound']), and an unknown token leaks through verbatim (expects
 * []). backgrounded→['backgrounded'] and null→[] already agree.
 *
 * HARNESS: container/OMID tier mirrors test-slice-d-bridge-agreement.js
 * (JSDOM + real SHARCContainer + mock OmidSessionClient); EV payloads carrying
 * each EV-5 token are driven through the REAL container→OMID seam
 * (`_notifyExtensionsLifecycle('effectiveVisibilityChange', { payload })`, the
 * Slice D fan-out) and `_geometryChangeData().adView.reasons` is read off the
 * bridge. The wire-honesty pin drives the SAME payloads to a fresh creative-
 * side MRAID bridge over a fake `window.SHARC` bus and reads the raw reason
 * back off `_s._lastEffective` via a captured wire listener.
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

// ── Mock OM SDK (minimal subset of test-slice-d-bridge-agreement.js) ─────────
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

console.log('test-omid-reasons-vocab.js — Slice E6a Item A OMID reasons boundary map\n');

// ══════════════════════════════════════════════════════════════════════════════
// Phase 1 — container → OMID seam: each EV-5 token maps to the OMID vocabulary.
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

// Registered ad view with REAL bounds so geometry rect fields stay
// container-sourced (unchanged by the reasons mapping).
c._iframe = document.createElement('iframe');
c._iframe.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 250, width: 300, height: 250 });

// Open the session so the seam is live (mirrors test-slice-d-bridge-agreement).
c._protocol.sendStateChange = () => {};
c._protocol.sendEffectiveVisibilityChange = () => {};
c._protocol.sessionId = 'sess-vocab';

c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
c.setState('active');
c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });
check(bridge._omid.sessionStarted === true, 'harness: OM session started (seam is live)');

// Drives one EV payload through the REAL container→OMID fan-out and reads the
// mapped reasons off the bridge's geometryChange data.
function reasonsFor(effectivePercent, reason) {
  c._notifyExtensionsLifecycle('effectiveVisibilityChange', {
    payload: { effectivePercent, reason, visibleRectangle: null },
  });
  return bridge._geometryChangeData().adView.reasons;
}

const CASES = [
  { label: 'null (fully visible)', pct: 100, reason: null, expect: [] },
  { label: "'backgrounded'",       pct: 0,   reason: 'backgrounded', expect: ['backgrounded'] },
  { label: "'frozen'",             pct: 0,   reason: 'frozen',       expect: ['backgrounded'] },
  { label: "'offscreen'",          pct: 73,  reason: 'offscreen',    expect: ['clipped'] },
  { label: "'notAttached'",        pct: 0,   reason: 'notAttached',  expect: ['notFound'] },
  { label: "unknown token 'wat'",  pct: 42,  reason: 'wat',          expect: [] },
];

for (const t of CASES) {
  const got = reasonsFor(t.pct, t.reason);
  check(js(got) === js(t.expect),
    `OMID adView.reasons for EV-5 ${t.label} === ${js(t.expect)} — got ${js(got)}`);
}

// Geometry rect fields stay iframe-bounds-derived (mapping touches reasons only).
reasonsFor(73, 'offscreen');
const g = bridge._geometryChangeData();
check(g.adView.geometry.width === 300 && g.adView.geometry.height === 250,
  'OMID adView.geometry stays iframe-bounds-derived (reasons mapping touches reasons only)');

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2 — WIRE-HONESTY pin: the creative-side listener still sees RAW EV-5.
// The OMID mapping is boundary-only; the wire never carries OMID tokens.
// ══════════════════════════════════════════════════════════════════════════════

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
  let lastBusEV;
  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart() {},
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
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
    driveEV(payload) {
      lastBusEV = payload;
      (eventListeners.effectiveVisibilityChange || []).forEach((fn) => fn(payload));
    },
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
  };
}

/** Installs a fresh MRAID bridge on a fake window; captures raw EV payloads. */
async function makeMraidConsumer() {
  const bus = makeFakeSharcBus();
  globalThis.window = { __sharcMraidBridgeAutoInstall: true, SHARC: bus.SHARC };
  await import(`../../dist/sharc-mraid-bridge.mjs?vocab=${Date.now()}-${nonce++}`);
  // Capture what the creative wire delivers by subscribing a raw listener on
  // the same bus the bridge subscribes to — this is the creative-side view.
  const rawEV = [];
  bus.SHARC.on('effectiveVisibilityChange', (p) => rawEV.push(p));
  return { ...bus, mraid: globalThis.window.mraid, rawEV };
}

{
  console.log('\nWire-honesty — creative-side effectiveVisibilityChange keeps RAW EV-5:');
  const m = await makeMraidConsumer();
  m.fireReady(DEFAULT_ENV);

  // 'frozen' must stay 'frozen' on the wire (NOT 'backgrounded'); 'offscreen'
  // must stay 'offscreen' (NOT 'clipped') — the OMID map is boundary-only.
  m.driveEV({ effectivePercent: 0, reason: 'frozen', visibleRectangle: null });
  m.driveEV({ effectivePercent: 73, reason: 'offscreen', visibleRectangle: null });

  const reasonsOnWire = m.rawEV.map((p) => p.reason);
  check(js(reasonsOnWire) === js(['frozen', 'offscreen']),
    'creative wire reasons are the RAW EV-5 tokens [frozen, offscreen] — NOT OMID [backgrounded, clipped] — got ' + js(reasonsOnWire));
}

// Restore the JSDOM window for any teardown paths.
globalThis.window = DOM_WIN;

if (failures > 0) {
  console.error(`\n✗ ${failures} OMID reasons-vocab assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All OMID reasons-vocab assertions passed.');
