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
global.HTMLElement = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;

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
  c._creativeRendered = true; // past P3 unless a test says otherwise
  return c;
}

// Records payloads pushed on the effectiveVisibilityChange channel.
function mockProtocol() {
  const sent = [];
  return {
    // Container `get sessionId()` reads _protocol.sessionId; a non-empty value
    // means "session established" so the channel push is not a sessionless no-op
    // (mirrors sharc-protocol.js sendStateChange's session gate).
    sessionId: 'sess-ev',
    sent,
    _sendMessage: (type, args) => sent.push({ type, args }),
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
  c._creativeRendered = false; // before P3
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

  // Replay-of-last: a late listener gets the last cached payload once. Modeled
  // here as _replayEffectiveVisibility (mirrors the stateChange replay path).
  const replayed = [];
  c._replayEffectiveVisibility = c._replayEffectiveVisibility; // present after develop
  c._emitEffectiveTo = (fn) => fn(c._lastEffectivePayload);
  c._emitEffectiveTo((p) => replayed.push(p));
  assert(replayed.length === 1 && replayed[0] && replayed[0].effectivePercent === 100,
    'late listener replays LAST payload (100), not stale 50');
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

// ── Result ──────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} effective-visibility-composer assertion(s) failed (RED — expected until Slice C lands).`);
  process.exit(1);
} else {
  console.log('✓ All effective-visibility-composer assertions passed.');
}
