/**
 * test-effective-visibility-composer.js — Slice C RED TESTS (jsdom tier).
 *
 * Expresses the EV-1…EV-9 contract (unified-lifecycle-ordering §3A.7) + the L1
 * host-exposure reconciliation, for the container-private effective-visibility
 * composer and its additive `effectiveVisibilityChange` channel.
 *
 * STATUS: RED. Slice C production code does NOT exist yet. Every block below
 * targets a surface that is unimplemented on `7a94ab5`:
 *   - _composeEffectiveVisibility()  (container-private composer)
 *   - _onRawIntersection(ratio)      (axis-3 raw setter)
 *   - _onRawParentVisibility(bool)   (axis-2 raw setter)
 *   - setHostExposure(pct) / _hostExposure  (in-app axis-3 INPUT, L1)
 *   - _syncEffectiveVisibility()     (C7 replay-on-ACTIVE, mirrors _syncAudioState)
 *   - sendEffectiveVisibilityChange  (protocol value-push, mirrors sendAudioVolumeChange)
 * These MUST FAIL because the methods are absent — that is the point of the
 * red step. develop makes them green.
 *
 * TIER: jsdom / node. The composer is pure logic over two scalar inputs plus a
 * host-exposure override; no real IntersectionObserver or page-visibility
 * plumbing is exercised here (that is L-13, test/browser, validator tier).
 *
 * HARNESS: mirrors test-host-placement-integration.js — prototype-bind the
 * container without invoking the constructor, drive the private methods
 * directly, and mirror test-mraid-visibility-channel.js for the channel
 * dedup/replay style.
 *
 * Contract coverage:
 *   EV-1  (single composer / bridge agreement)      → block 5 (L-11)
 *   EV-2  (raw inputs, continuous ratio)            → block 2 (L-9)
 *   EV-3  (composition = intersection% web)         → block 2 (L-9)
 *   EV-4  (parent-visibility gate)                  → block 1 (L-8)
 *   EV-5  (reason enum, axis distinctness)          → blocks 1,2,6 (L-8/L-9/L-12)
 *   EV-6  (render anchor / notAttached pre-render)  → block 7
 *   EV-8  (single-surface channel + dedup + replay) → block 8
 *   C7    (replay-on-ACTIVE, host-exposure INPUT)   → block 9
 *   L1 host-wins axis-3 selection                   → block 3
 *   L1 gate not satisfied by host exposure          → block 4
 */

import { JSDOM } from 'jsdom';

// ── DOM globals + protocol — in place before the container module loads ──────
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: 'https://publisher.example/page.html' },
);
global.window = dom.window;
global.document = dom.window.document;
// jsdom reports 'prerender' by default; the F1 seed test needs the REAL
// browser initial-load condition (visible page, no visibilitychange event).
// Mirrors test-active-frozen-edge.js.
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return 'visible'; },
});
global.HTMLElement = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

// ── Harness ──────────────────────────────────────────────────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

// Runs a block; a thrown error (e.g. "_composeEffectiveVisibility is not a
// function" while Slice C is unimplemented) is recorded as a failure so the
// suite runs ALL blocks and every EV clause is visibly RED, rather than the
// whole file aborting on the first missing method.
function block(fn) {
  try {
    fn();
  } catch (err) {
    console.error('  ✗ block threw:', err && err.message || err);
    failures++;
  }
}

// Bind to the prototype without invoking the constructor (matches
// test-host-placement-integration.js). Module-scope constants resolve via
// closure because window.SHARC.Protocol was wired before the module loaded.
function makeContainer() {
  return Object.create(SHARCContainer.prototype);
}

// A container primed with both raw inputs at neutral values + no host exposure.
function primedContainer() {
  const c = makeContainer();
  c._rawParentVisible = true;
  c._rawIntersection = 0; // 0..1
  c._hostExposure = null; // no in-app host push
  c.creativeRendered = true; // past P3 unless a test says otherwise (F6d: the
  // composer reads the public render anchor directly — no private mirror)
  return c;
}

// Records payloads pushed on the effectiveVisibilityChange channel. Stubs the
// PUBLIC protocol sender (F6b): the container routes its push through
// sendEffectiveVisibilityChange — the wire + swallow live protocol-side.
function mockProtocol() {
  const sent = [];
  return {
    // Container `get sessionId()` reads _protocol.sessionId; a non-empty value
    // means "session established" so the channel push is not a sessionless no-op
    // (mirrors sharc-protocol.js sendStateChange's session gate).
    sessionId: 'sess-ev',
    sent,
    sendEffectiveVisibilityChange: (payload) => sent.push({
      type: protoMod.ContainerMessages.EFFECTIVE_VISIBILITY_CHANGE,
      args: payload,
    }),
    _reject: () => {},
    _resolve: () => {},
  };
}

console.log('test-effective-visibility-composer.js — Slice C composer (RED)\n');

// ── 1. L-8 — the gate: backgrounded ∧ IO=1.0 ⇒ 0% / reason:backgrounded ─────
// EV-4: a fully-in-viewport ad on a hidden page is 0%.
block(() => {
  console.log('1. L-8 (EV-4 gate) — backgrounded page, ad 100% in-viewport');
  const c = primedContainer();
  c._rawParentVisible = false; // page backgrounded (axis 2)
  c._rawIntersection = 1.0; // fully in viewport (axis 3)
  const out = c._composeEffectiveVisibility();
  assert(out.effective === 0, 'effective === 0 despite IO ratio 1.0 (gate fires)');
  assert(out.reason === 'backgrounded', "reason === 'backgrounded' (axis-2 cause)");
});

// ── 2. L-9 — the orthogonal axis: visible ∧ IO=0.5 ⇒ 50% / reason:offscreen ─
// EV-3 continuous %, EV-2 widened thresholds, correct axis-3 reason.
block(() => {
  console.log('\n2. L-9 (EV-2/EV-3) — visible page, ad 50% scrolled off');
  const c = primedContainer();
  c._rawParentVisible = true;
  c._rawIntersection = 0.5;
  const out = c._composeEffectiveVisibility();
  assert(out.effective === 50, 'effective === 50 (continuous %, not 3-valued snap)');
  assert(out.reason === 'offscreen', "reason === 'offscreen' (axis-3 cause, not backgrounded)");
});

// ── 3. Host-wins axis-3 selection (L1 reconciliation) ────────────────────────
// _rawIntersection = hostExposure!=null ? hostExposure/100 : ioRatio.
// Host exposure overrides the in-page IO ratio for the axis-3 magnitude.
block(() => {
  console.log('\n3. Host-wins axis-3 — setHostExposure overrides IO ratio');
  const c = primedContainer();
  c._protocol = mockProtocol(); // setHostExposure pushes live (F3)
  c._rawParentVisible = true;
  c._rawIntersection = 1.0; // in-page IO sees ≈100% of the wrapper (wrong thing)
  // Setter feeds the container field consumed by the composer, NOT the bridge.
  c.setHostExposure(30); // host: only 30% actually on device screen
  const out = c._composeEffectiveVisibility();
  assert(out.effective === 30, 'host exposure 30 overrides IO ratio 1.0 → effective 30');
  assert(out.reason === 'offscreen', "reason 'offscreen' — axis-3 partial (host-sourced)");

  // Absent a host push, IO is authoritative again (byte-identical to web).
  const c2 = primedContainer();
  c2._rawParentVisible = true;
  c2._rawIntersection = 1.0;
  c2._hostExposure = null;
  const out2 = c2._composeEffectiveVisibility();
  assert(out2.effective === 100, 'no host push → IO ratio wins (effective 100)');
});

// ── 4. Gate is NOT satisfied by host exposure (L1 S2, carry-forward (a)) ─────
// A reparented full-screen surface (host exposure 100) on a backgrounded page
// (parentVisible false) is still 0% — host exposure supplies axis-3 magnitude,
// never the axis-2 gate. No double-count; reason stays backgrounded.
block(() => {
  console.log('\n4. Gate not satisfied by host exposure — backgrounded + host 100 ⇒ 0');
  const c = primedContainer();
  c._protocol = mockProtocol(); // setHostExposure pushes live (F3)
  c._rawParentVisible = false; // SHARC-observed backgrounded (axis 2)
  c._rawIntersection = 0; // in-page IO irrelevant
  c.setHostExposure(100); // host claims fully on-screen
  const out = c._composeEffectiveVisibility();
  assert(out.effective === 0, 'host exposure 100 cannot override the axis-2 gate → 0');
  assert(out.reason === 'backgrounded', "reason stays 'backgrounded', not 'offscreen'");
});

// ── 5. L-11 (EV-1) — bridge agreement: one surface, all consumers same number ─
// The composer is the single source. viewableChange boolean = effective ≥ 50;
// exposureChange % = effective; OMID percentageInView = effective — the SAME
// number derived once. Here we assert the surface exposes the value the three
// mappings each consume identically.
block(() => {
  console.log('\n5. L-11 (EV-1) — single surface drives identical consumer values');
  const c = primedContainer();
  c._rawParentVisible = true;
  c._rawIntersection = 0.72;
  const out = c._composeEffectiveVisibility();
  // The three consumer mappings all read out.effective — proving one number.
  const viewableChangeBool = out.effective >= 50; // MRAID viewableChange (EV-7)
  const exposurePct = out.effective; // MRAID exposureChange
  const omidPercentageInView = out.effective; // OMID geometryChange
  assert(out.effective === 72, 'composed effective === 72');
  assert(viewableChangeBool === true, 'MRAID viewableChange = (72 ≥ 50) === true');
  assert(exposurePct === 72 && omidPercentageInView === 72,
    'exposureChange% === OMID percentageInView === 72 (all from ONE surface)');
});

// ── 6. L-12 — reason preserved distinct across transitions ───────────────────
// The axis-2/axis-3 causes must stay distinct all the way out, and survive a
// transition sequence rather than collapsing to a single lumped reason.
block(() => {
  console.log('\n6. L-12 — reason distinct across offscreen→backgrounded→frozen');
  const c = primedContainer();

  c._rawParentVisible = true;
  c._rawIntersection = 0;
  assert(c._composeEffectiveVisibility().reason === 'offscreen',
    'visible + IO 0 → offscreen (axis-3)');

  c._rawParentVisible = false;
  c._rawIntersection = 1.0;
  assert(c._composeEffectiveVisibility().reason === 'backgrounded',
    'backgrounded + IO 1 → backgrounded (axis-2), NOT lumped with offscreen');

  // Freeze is the axis-2 sub-state (bfcache/OS-freeze). SHARC splits it out of
  // OMID's backgrounded so a consumer can distinguish a tab-switch from a park.
  c._rawParentVisible = false;
  c._frozen = true;
  assert(c._composeEffectiveVisibility().reason === 'frozen',
    'frozen page → frozen (axis-2 sub-state), distinct from backgrounded');
});

// ── 7. EV-6 — render anchor: pre-render ⇒ 0% / reason:notAttached ────────────
// Before the creative-rendered anchor (P3), effective-visibility is notAttached,
// even if the IO ratio is 1.0 early (OMID AdSession: no measure before ad view).
block(() => {
  console.log('\n7. EV-6 render anchor — pre-render ⇒ 0 / notAttached');
  const c = primedContainer();
  c.creativeRendered = false; // before P3
  c._rawParentVisible = true;
  c._rawIntersection = 1.0; // IO already reports full — must NOT count yet
  const out = c._composeEffectiveVisibility();
  assert(out.effective === 0, 'pre-render effective === 0 despite IO 1.0');
  assert(out.reason === 'notAttached', "reason === 'notAttached' before creative-rendered");
});

// ── 8. EV-8 — additive channel: send shape, dedup, replay-of-last ────────────
// The effectiveVisibilityChange channel mirrors audioVolumeChange (value push)
// for shape + dedup (INV-1/2/3) and stateChange (INV-14) for replay-of-last.
block(() => {
  console.log('\n8. EV-8 — channel push shape + dedup + replay-of-last');
  const c = primedContainer();
  const proto = mockProtocol(); // proto.sessionId non-empty ⇒ session established
  c._protocol = proto;
  c._lastEffectivePayload = undefined;

  // First push flows.
  c._rawParentVisible = true;
  c._rawIntersection = 0.5;
  c._pushEffectiveVisibility(); // composes + sends on the channel
  assert(proto.sent.length === 1, 'first effective push sends one message');
  assert(proto.sent[0].type === protoMod.ContainerMessages.EFFECTIVE_VISIBILITY_CHANGE,
    'message type is Container:effectiveVisibilityChange');
  assert(proto.sent[0].args.effectivePercent === 50, 'payload.effectivePercent === 50');
  assert(proto.sent[0].args.reason === 'offscreen', "payload.reason === 'offscreen'");
  assert('visibleRectangle' in proto.sent[0].args, 'payload carries visibleRectangle field (EV-8)');

  // Consecutive-identical (same effectivePercent AND reason) is deduped.
  c._pushEffectiveVisibility();
  assert(proto.sent.length === 1, 'identical effective+reason is deduped (no second send)');

  // A distinct value flows.
  c._rawIntersection = 1.0;
  c._pushEffectiveVisibility();
  assert(proto.sent.length === 2, 'changed effective flows (100 vs 50)');
  // Replay-of-last to a LATE CREATIVE listener is block 13 (F4) — it drives
  // the real SHARCCreative production path, not a test-local lambda.
});

// ── 9. C7 — replay-on-ACTIVE: last effective value re-delivered on activation ─
// Mirrors _syncAudioState: on every ACTIVE transition, _syncEffectiveVisibility
// re-pushes the current effective value so a preloaded creative gets it. This is
// the L1 C7 obligation the composer inherits (host-exposure INPUT + the channel).
block(() => {
  console.log('\n9. C7 — _syncEffectiveVisibility replays last value on ACTIVE');
  const c = primedContainer();
  const proto = mockProtocol(); // proto.sessionId non-empty ⇒ session established
  c._protocol = proto;
  c._lastEffectivePayload = undefined;

  // Host pushed exposure during preload; nothing delivered to the creative yet.
  c._rawParentVisible = true;
  c.setHostExposure(40);

  // ACTIVE-transition re-sync (the call _transitionToActive() will make).
  c._syncEffectiveVisibility();
  assert(proto.sent.length === 1, 'ACTIVE re-sync delivers the current effective once');
  assert(proto.sent[0].args.effectivePercent === 40,
    'replayed value carries host-sourced axis-3 magnitude (40)');

  // A second ACTIVE transition with unchanged state must not re-spam.
  c._syncEffectiveVisibility();
  assert(proto.sent.length === 1, 'unchanged re-sync is deduped (no redundant replay)');
});

// ── 10. F1 — constructor seeds axis-2 from real visibility state ─────────────
// BLOCKER repro (review F1): `visibilitychange` never fires on initial load, so
// an event-handler-only `_rawParentVisible` write leaves a fully-visible
// rendered ad composing to 0/'backgrounded'. The constructor must DECLARE all
// composer fields and SEED axis-2 from `document.visibilityState`. This block
// uses a REAL constructed container (not the prototype-bind harness) precisely
// because constructor seeding is the surface under test.
block(() => {
  console.log('\n10. F1 — fresh container, NO visibility event ⇒ visible page composes 100/null');
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  // jsdom document.visibilityState === 'visible' — the state to seed FROM.
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: slot,
    requireSharcInit: false,
  });
  try {
    // All composer fields are declared at construction (no undefined reads).
    assert(Object.prototype.hasOwnProperty.call(c, '_rawIntersection') && c._rawIntersection === 0,
      'constructor declares _rawIntersection = 0');
    assert(Object.prototype.hasOwnProperty.call(c, '_rawParentVisible') && c._rawParentVisible === true,
      'constructor SEEDS _rawParentVisible from document.visibilityState (visible ⇒ true)');
    assert(Object.prototype.hasOwnProperty.call(c, '_hostExposure') && c._hostExposure === null,
      'constructor declares _hostExposure = null');
    assert(Object.prototype.hasOwnProperty.call(c, '_frozen') && c._frozen === false,
      'constructor declares _frozen = false');
    assert(Object.prototype.hasOwnProperty.call(c, '_lastEffectivePayload') && c._lastEffectivePayload === undefined,
      'constructor declares _lastEffectivePayload = undefined');

    // The blocker repro: rendered + IO 1.0, no visibilitychange ever fired.
    c.creativeRendered = true;
    c._onRawIntersection(1.0);
    const out = c._composeEffectiveVisibility();
    assert(out.effective === 100, 'fully-visible rendered ad composes effective 100 (was 0)');
    assert(out.reason === null, "reason === null (was 'backgrounded' from unseeded axis-2)");
  } finally {
    try { c.close(); } catch (_) { /* never load()ed — nothing armed */ }
    slot.remove();
  }
});

// ── 11. F3 — live push on change (MRAID exposureChange / IO event pattern) ───
// MRAID 3.0 exposureChange and IntersectionObserver are change-driven live
// event streams. Every raw-input setter must push (composer + dedup absorb the
// noise): the IO 0.05-step quantization + INTEGER rounding + (effectivePercent,
// reason) dedup IS the rate limiting — no wall-clock throttle (§5.0).
block(() => {
  console.log('\n11. F3 — raw-input changes push live, integer-rounded, deduped');
  const c = primedContainer();
  const proto = mockProtocol();
  c._protocol = proto;

  // Baseline delivered value (the C7 ACTIVE sync).
  c._rawIntersection = 1.0;
  c._syncEffectiveVisibility();
  assert(proto.sent.length === 1 && proto.sent[0].args.effectivePercent === 100,
    'baseline: ACTIVE sync delivers 100');

  // (a) mid-ACTIVE IO change fires exactly one push — no external sync call.
  c._onRawIntersection(0.4);
  assert(proto.sent.length === 2, 'IO 1.0→0.4 fires exactly one live push');
  assert(proto.sent[1].args.effectivePercent === 40 && proto.sent[1].args.reason === 'offscreen',
    'live push carries 40 / offscreen');

  // (b) float jitter composing to the same integer+reason produces ONE push.
  c._onRawIntersection(0.333333333);
  assert(proto.sent.length === 3 && proto.sent[2].args.effectivePercent === 33,
    'jitter A (0.333333333) pushes integer 33');
  c._onRawIntersection(0.333333334);
  assert(proto.sent.length === 3,
    'jitter B (0.333333334, same rounded integer) is deduped — no float-jitter dedup defeat');

  // (c) host-exposure INPUT mid-session fires a push.
  c.setHostExposure(30);
  assert(proto.sent.length === 4 && proto.sent[3].args.effectivePercent === 30,
    'setHostExposure(30) mid-session fires a push (30)');

  // Axis-2 flip pushes the gate result.
  c._onRawParentVisibility(false);
  assert(proto.sent.length === 5 && proto.sent[4].args.effectivePercent === 0
    && proto.sent[4].args.reason === 'backgrounded',
    'parent-visibility flip pushes 0 / backgrounded');
});

// ── 11b. F6e — subpixel wobble at visual-full rounds to 100 ⇒ reason null ────
block(() => {
  console.log('\n11b. F6e — IO 0.999 rounds to 100, reason null (no phantom offscreen)');
  const c = primedContainer();
  const proto = mockProtocol();
  c._protocol = proto;
  c._onRawIntersection(0.999); // 99.9 — IO subpixel wobble at visual-full
  assert(proto.sent.length === 1 && proto.sent[0].args.effectivePercent === 100,
    'effectivePercent === 100 (Math.round on the composed percent)');
  assert(proto.sent[0].args.reason === null,
    'reason === null — visual-full compares on the ROUNDED integer');
});

// ── 11c. F3 guard — sessionless raw changes stay silent, dedup unpoisoned ────
block(() => {
  console.log('\n11c. F3 — stock embeds (no session) send zero new messages');
  const c = primedContainer();
  const proto = mockProtocol();
  proto.sessionId = ''; // no session established (stock embed)
  c._protocol = proto;
  c._onRawIntersection(0.5);
  assert(proto.sent.length === 0, 'sessionless raw change sends nothing');
  proto.sessionId = 'sess-late'; // session establishes later
  c._syncEffectiveVisibility();
  assert(proto.sent.length === 1 && proto.sent[0].args.effectivePercent === 50,
    'first post-session sync delivers — the sessionless push did NOT seed the dedup cache');
});

// ── 12. F5 — setHostExposure(null) clears (platform null-to-clear) ───────────
// MediaSession-style convention: exactly `null` is an explicit clear — the
// composer falls back to the in-page IO ratio. Without it, host-wins is sticky
// forever (a host that reparented once could never hand axis-3 back).
block(() => {
  console.log('\n12. F5 — setHostExposure(null) clears the host override');
  const c = primedContainer();
  const proto = mockProtocol();
  c._protocol = proto;
  c._rawIntersection = 1.0;

  c.setHostExposure(30);
  assert(c._composeEffectiveVisibility().effective === 30, 'host 30 composes 30 (host-wins)');

  const sentBefore = proto.sent.length;
  c.setHostExposure(null);
  assert(c._hostExposure === null, 'null clears _hostExposure');
  assert(c._composeEffectiveVisibility().effective === 100,
    'after clear, the in-page IO ratio is authoritative again (100)');
  assert(proto.sent.length === sentBefore + 1
    && proto.sent[proto.sent.length - 1].args.effectivePercent === 100,
    'the clear pushes the fallback value (F3 live push)');

  // Everything else non-finite / non-number is still rejected silently.
  const snap = proto.sent.length;
  c.setHostExposure('50');
  c.setHostExposure(NaN);
  c.setHostExposure(undefined);
  assert(c._hostExposure === null && proto.sent.length === snap,
    "'50' / NaN / undefined still rejected: no change, no push");
});

// ── 12b. F5 — validation matrix (L1 validate-first contract) ─────────────────
block(() => {
  console.log('\n12b. F5 — setHostExposure validation matrix');
  const c = primedContainer();
  const proto = mockProtocol();
  c._protocol = proto;
  c._rawIntersection = 0.5; // IO fallback distinct from every matrix value

  // Rejected (no change, no push): NaN, Infinity, -Infinity, string, boolean.
  const rejects = [NaN, Infinity, -Infinity, '50', true];
  for (const v of rejects) c.setHostExposure(v);
  assert(c._hostExposure === null && proto.sent.length === 0,
    'NaN / Infinity / -Infinity / "50" / true all rejected: no change, no push');

  // Clamped low: -5 → 0.
  c.setHostExposure(-5);
  assert(c._hostExposure === 0, '-5 clamps to 0');
  assert(proto.sent[proto.sent.length - 1].args.effectivePercent === 0
    && proto.sent[proto.sent.length - 1].args.reason === 'offscreen',
    'clamped 0 composes 0 / offscreen (host-sourced axis-3)');

  // Clamped high: 150 → 100.
  c.setHostExposure(150);
  assert(c._hostExposure === 100, '150 clamps to 100');
  assert(proto.sent[proto.sent.length - 1].args.effectivePercent === 100
    && proto.sent[proto.sent.length - 1].args.reason === null,
    'clamped 100 composes 100 / null');

  // In-range accepted verbatim.
  c.setHostExposure(42);
  assert(c._hostExposure === 42 && proto.sent[proto.sent.length - 1].args.effectivePercent === 42,
    '42 accepted verbatim and pushed');
});

// ── 14. F6c — visibilitychange→visible clears a stale freeze flag ────────────
// A freeze whose `resume` never fires (observed bfcache oddity) would leave
// `_frozen` latched: the NEXT backgrounding would misreport 'frozen' instead of
// 'backgrounded'. A visible visibilitychange proves the page is running again —
// clear the flag there too.
block(() => {
  console.log('\n14. F6c — visible visibilitychange clears missed-resume _frozen staleness');
  const c = primedContainer();
  c._protocol = mockProtocol();
  c._stateMachine = { getState: () => 'passive' }; // visible branch: no transition from passive
  c._frozen = true; // freeze observed, resume MISSED
  c._onVisibilityChange(); // document.visibilityState === 'visible' (suite-wide override)
  assert(c._frozen === false, 'visible visibilitychange clears _frozen');
  c._rawParentVisible = false;
  assert(c._composeEffectiveVisibility().reason === 'backgrounded',
    "next backgrounding reports 'backgrounded', not stale 'frozen'");
});

// ── 15. F6a — reopen/relink reset the EV dedup so the replay re-delivers ─────
// document.open reopen and bfcache relink both re-arm the creative SDK with an
// EMPTY replay cache. Exactly like `_lastSentState` at the same two sites, the
// container must reset `_lastEffectivePayload` and re-push — an UNCHANGED value
// would otherwise be dedup-suppressed and the reopened/relinked SDK would never
// see it.
block(() => {
  console.log('\n15. F6a — document.open reopen re-delivers the (unchanged) EV value');
  const c = primedContainer();
  const proto = mockProtocol();
  proto.sendStateChange = () => {};
  c._protocol = proto;
  c._terminated = false;
  c._iframe = { contentWindow: {} };
  c._stateMachine = { getState: () => 'active', isCreativeQueryable: () => true };

  c._rawIntersection = 1.0;
  c._pushEffectiveVisibility();
  assert(proto.sent.length === 1 && proto.sent[0].args.effectivePercent === 100,
    'pre-reopen: value 100 delivered once');

  c._onRendererReopened();
  assert(proto.sent.length === 2 && proto.sent[1].args.effectivePercent === 100,
    'reopen resets the dedup and re-pushes the UNCHANGED value (100) to the re-armed SDK');
});

block(() => {
  console.log('\n15b. F6a — bfcache relink re-delivers the (unchanged) EV value');
  const c = primedContainer();
  const proto = mockProtocol();
  proto.sendStateChange = () => {};
  proto.initChannel = () => {};
  proto._usingMessageChannel = true;
  proto._lastSentState = 'active';
  c._protocol = proto;
  c._terminated = false;
  c._iframe = { contentWindow: {} };
  c.creativeSource = 'url';
  c.placementSessionId = 'psess-relink';
  c._stateMachine = { getState: () => 'active', isCreativeQueryable: () => true };

  c._rawIntersection = 0.5;
  c._pushEffectiveVisibility();
  assert(proto.sent.length === 1 && proto.sent[0].args.effectivePercent === 50,
    'pre-relink: value 50 delivered once');

  c._relinkCreativeChannel();
  assert(proto.sent.length === 2 && proto.sent[1].args.effectivePercent === 50,
    'relink resets the dedup and re-pushes the UNCHANGED value (50) over the new port');
});

// ── 13. F4 — creative-side replay-of-last to a late listener ─────────────────
// MRAID 3.0 mandates the initial state be delivered to a listener that
// registers after the value arrived. Mirrors the R1 D3 stateChange replay
// EXACTLY (sharc-creative.js on(): latching value event, registering listener
// only, live subscription untouched) — driven through the REAL SHARCCreative
// production path (protocol dispatch → SDK cache → on() replay), not a
// test-local lambda. Harness mirrors test-creative-state-replay.js.
let creativeNonce = 0;
async function makeCreative() {
  const cdom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://creative.example/ad.html',
  });
  global.window = cdom.window;
  global.document = cdom.window.document;
  global.HTMLElement = cdom.window.HTMLElement;
  global.MessageChannel = cdom.window.MessageChannel;
  global.MessagePort = cdom.window.MessagePort;

  const cproto = await import(`../../dist/sharc-protocol.mjs?ev-replay=${Date.now()}-${creativeNonce}`);
  cdom.window.SHARC = cdom.window.SHARC || {};
  cdom.window.SHARC.Protocol = cproto;
  await import(`../../dist/sharc-creative.mjs?ev-replay=${Date.now()}-${creativeNonce++}`);
  const SHARC = cdom.window.SHARC;
  const instance = SHARC._instance;
  return {
    SHARC,
    /** Simulates an inbound Container:effectiveVisibilityChange PAST the session gate. */
    driveEffectiveVisibility(payload) {
      instance._proto._dispatchToListeners(cproto.ContainerMessages.EFFECTIVE_VISIBILITY_CHANGE, {
        sessionId: instance._proto.sessionId,
        type: cproto.ContainerMessages.EFFECTIVE_VISIBILITY_CHANGE,
        args: payload,
      });
    },
  };
}

try {
  console.log('\n13. F4 — late effectiveVisibilityChange listener replayed the cached payload');
  const h = await makeCreative();

  // Payload arrives BEFORE any listener is registered.
  h.driveEffectiveVisibility({ effectivePercent: 40, reason: 'offscreen', visibleRectangle: null });
  const seen = [];
  h.SHARC.on('effectiveVisibilityChange', (p) => seen.push(p));
  assert(seen.length === 1 && seen[0] && seen[0].effectivePercent === 40,
    'late listener receives the cached payload exactly once');

  // Live subscription keeps flowing (no latch) and updates the cache.
  h.driveEffectiveVisibility({ effectivePercent: 70, reason: 'offscreen', visibleRectangle: null });
  assert(seen.length === 2 && seen[1].effectivePercent === 70,
    'live subscription still flows after the replay');

  // A second late registration replays the LAST value, exactly once, without
  // double-firing the first listener.
  const seen2 = [];
  h.SHARC.on('effectiveVisibilityChange', (p) => seen2.push(p));
  assert(seen2.length === 1 && seen2[0].effectivePercent === 70,
    'second late registration replays the LAST payload (70) exactly once');
  assert(seen.length === 2, 'existing listener does NOT re-fire on another registration');

  // No payload yet ⇒ no replay (nothing fabricated).
  const h2 = await makeCreative();
  const seen3 = [];
  h2.SHARC.on('effectiveVisibilityChange', (p) => seen3.push(p));
  assert(seen3.length === 0, 'listener registered before any payload gets NO replay');
} catch (err) {
  console.error('  ✗ block threw:', err && err.message || err);
  failures++;
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} effective-visibility-composer assertion(s) failed (RED — expected until Slice C lands).`);
  process.exit(1);
} else {
  console.log('✓ All effective-visibility-composer assertions passed.');
}
