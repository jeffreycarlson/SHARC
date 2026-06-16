/**
 * test-renderer-probe-cycle-ceiling.js — issue #332 (Phase 2 of the post-render
 * nav policy).
 *
 * ADR: docs/design/0.7.10-post-render-nav-policy-omid-phase.md — Decision 2,
 * Phase 2; reserved `renderer_navigation_blocked` / 2122 (non-terminating).
 *
 * THE GAP (#332). Phase 1 (#321) gates EVERY post-render load through the
 * controlled-context loadProbe/loadAck round-trip, and an ANSWERED cycle emits
 * one `console.info` + one `renderer_load_observed` security-event callback. A
 * renderer that answers the probe on every load cycle can therefore drive an
 * unbounded `load → runGate → renderer_load_observed` churn — a keep-alive /
 * log-volume DoS-adjacent window. Phase 1 authenticates control but does not
 * classify behavior, so this ceiling was deferred.
 *
 * THE BOUND (#332). After N answered cycles within a sliding window W,
 * `_armRendererBackstop` classifies the renderer as abusively chatty and:
 *   - SUPPRESSES further `renderer_load_observed` emissions (bounds log volume),
 *   - emits the reserved non-terminating `renderer_navigation_blocked` (2122)
 *     diagnostic EXACTLY ONCE on the threshold crossing,
 *   - keeps the ad ALIVE (throttle, not terminate — a legitimate-but-chatty
 *     renderer must not be killed for normal repeated loads; 2118 stays reserved
 *     for lost-control only).
 *
 * Auth is UNTOUCHED: the loadProbe/loadAck gate, nonce model, and
 * `_loadAckConsumed` latch are unchanged. The ceiling is a behavior/rate bound
 * ON TOP of the authenticated gate. No wire-format change, no new message type,
 * no new terminating error code (2122 is reserved + non-terminating).
 *
 * NODE-RUNNABLE: yes — every assertion is expressible with jsdom synthetic
 * load events + authentic router-routed loadAcks; no real renderer needed.
 *
 * Run after `npm run build`.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.operator.example/0.7.0/';
const RENDERER_ORIGIN = 'https://renderer.operator.example';
const CREATIVE_HTML = '<html><body>ad</body></html>';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
// ADR 2026-06-15: keep Node's NATIVE worker_threads MessageChannel/MessagePort
// (jsdom does not implement them); the load-probe gate authenticates by port
// possession, so the container needs a real channel. MessageEvent stays jsdom's.
global.MessageEvent = dom.window.MessageEvent;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Answers the most-recently-armed loadProbe over the PORT (ADR 2026-06-15) —
// the renderer IIFE holds `port2` and posts `:loadAck{probeId}` back over it,
// which arrives on the container's `port1` (the authenticator). The container
// minted the per-cycle `probeId` into `_armedProbeId` when it issued the probe.
function answerLoadProbe(c) {
  const port2 = c._protocol && c._protocol._channel && c._protocol._channel.port2;
  if (!port2) return;
  port2.postMessage({
    type: 'SHARC:Creative:loadAck',
    probeId: c._armedProbeId,
  });
}

// Drives one full answered post-render load cycle: dispatch a load event, answer
// the resulting probe over the port, and WAIT for the async port ack to resolve
// the probe before returning (ADR 2026-06-15: the ack now rides a real
// MessagePort, so delivery is async — polling the consume latch keeps each
// cycle discrete instead of latching the next load against a still-pending
// probe).
async function answeredCycle(c) {
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  answerLoadProbe(c);
  for (let i = 0; i < 50 && c._pendingLoadProbe !== null; i++) {
    await sleep(2);
  }
}

async function rendered() {
  const errors = [];
  const securityEvents = [];
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    timeouts: { rendererLoad: 5000, rendererReply: 150 },
    onError: (code, msg) => errors.push({ code, msg }),
    onSecurityEvent: (ev) => securityEvents.push(ev),
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
  return { c, errors, securityEvents };
}

console.log('test-renderer-probe-cycle-ceiling.js — #332 Phase 2 answered-cycle ceiling\n');

// The ceiling constants are exported on the container constructor as static
// read-only telemetry so tests + operators can reason about the bound without
// re-deriving it. The contract: N answered cycles allowed per window; the
// (N+1)th within the window trips the ceiling.
const N = SHARCContainer.PROBE_CYCLE_CEILING_MAX;
const WINDOW_MS = SHARCContainer.PROBE_CYCLE_CEILING_WINDOW_MS;

// ────────────────────────────────────────────────────────────────────────────
// 0. The ceiling is exposed as named, sane constants (not a magic literal, not a
//    configurable construction option).
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('0. Ceiling is exposed as sane named constants');
  assert(Number.isInteger(N) && N > 0, 'PROBE_CYCLE_CEILING_MAX is a positive integer');
  assert(Number.isInteger(WINDOW_MS) && WINDOW_MS > 0,
    'PROBE_CYCLE_CEILING_WINDOW_MS is a positive integer (ms)');
  // Conservative: must tolerate a handful of legit reopens but bound a flood.
  assert(N >= 8, 'ceiling tolerates at least a handful of legit reopens (N >= 8)');
}

// ────────────────────────────────────────────────────────────────────────────
// 1. NO FALSE POSITIVE: a renderer doing a normal small number of answered
//    post-render reopens stays fully alive, keeps emitting renderer_load_observed
//    for each, and never trips the ceiling (no 2122).
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n1. A few legit answered reopens never trip the ceiling (no false positive)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // Three answered reopens — well under N. The corpus pattern is 1–2.
  for (let i = 0; i < 3; i++) await answeredCycle(c);

  const observed = securityEvents.filter((e) => e.type === 'renderer_load_observed');
  assert(observed.length === 3,
    'each of the 3 legit answered reopens emits its own renderer_load_observed');
  const blocked = securityEvents.filter((e) => e.type === 'renderer_navigation_blocked');
  assert(blocked.length === 0, 'no renderer_navigation_blocked (2122) for a few legit reopens');
  const got2118 = errors.length > 0
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(!got2118, 'no termination for a few legit reopens');
  assert(c._terminated !== true, 'container survives a few legit reopens');
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// 2. CEILING TRIPS (RED on main): a renderer that answers > N probe cycles
//    within the window trips the ceiling exactly once — one 2122
//    renderer_navigation_blocked emitted, redundant renderer_load_observed
//    SUPPRESSED past the threshold, ad kept ALIVE (throttle, not terminate).
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n2. > N answered cycles in the window trips the ceiling once (throttle, not terminate)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // Drive N + 5 answered cycles back-to-back, all inside the window (no waits
  // long enough to slide it).
  const total = N + 5;
  for (let i = 0; i < total; i++) await answeredCycle(c);

  const observed = securityEvents.filter((e) => e.type === 'renderer_load_observed');
  const blocked = securityEvents.filter((e) => e.type === 'renderer_navigation_blocked');

  // Log volume is BOUNDED: at most N renderer_load_observed events ever emit in
  // a window regardless of how many answered cycles ran past the ceiling.
  assert(observed.length <= N,
    `renderer_load_observed is bounded at the ceiling (<= N=${N}); got ${observed.length} for ${total} cycles`);
  assert(observed.length === N,
    `first N=${N} answered cycles each emit renderer_load_observed; got ${observed.length}`);

  // The ceiling fires the reserved 2122 EXACTLY ONCE on the threshold crossing.
  assert(blocked.length === 1,
    `renderer_navigation_blocked (2122) emitted exactly once on threshold crossing; got ${blocked.length}`);
  if (blocked.length >= 1) {
    const ev = blocked[0];
    assert(ev.errorCode === undefined,
      'renderer_navigation_blocked is non-terminating (no top-level errorCode)');
    assert(ev.details?.code === protoMod.ErrorCodes.RENDERER_NAVIGATION_BLOCKED,
      'renderer_navigation_blocked carries details.code === 2122');
    assert(typeof ev.details?.navKind === 'string' && ev.details.navKind.length > 0,
      'renderer_navigation_blocked carries a details.navKind classification');
  }

  // THROTTLE, not terminate: the ad survives the flood.
  const got2118 = errors.length > 0
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(!got2118, 'ceiling does NOT terminate (no 2118) — a chatty renderer is throttled, not killed');
  assert(c._terminated !== true, 'container survives the answered-cycle flood');
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// 3. THE WINDOW SLIDES: after the window elapses, the count resets — a renderer
//    that answers N cycles, lets the window slide, then answers again is NOT
//    re-flagged and resumes emitting renderer_load_observed. The bound is a RATE
//    ceiling, not a lifetime cap.
//
//    Virtual time: the window is WINDOW_MS (10s) of WALL CLOCK. Sleeping that
//    long in jsdom collides with unrelated container-establish timeouts, so we
//    advance `Date.now()` virtually — the ceiling reads `Date.now()` for its
//    timestamps, so overriding it slides the window deterministically without a
//    real wait. (We do NOT touch the 100ms setTimeout probe deadline.)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n3. The window slides: count resets after the window elapses (rate, not lifetime, cap)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // Fill exactly N cycles — right up to but NOT over the ceiling.
  for (let i = 0; i < N; i++) await answeredCycle(c);
  let blocked = securityEvents.filter((e) => e.type === 'renderer_navigation_blocked');
  assert(blocked.length === 0, 'exactly N cycles does NOT trip the ceiling (boundary: N allowed)');

  // Slide the window forward by overriding Date.now: every prior answered cycle
  // is now older than WINDOW_MS, so it expires from the sliding window.
  const realNow = Date.now;
  const jump = realNow() + WINDOW_MS + 1000;
  Date.now = () => jump;
  try {
    // One more answered cycle: the window has slid, so this is cycle 1 of a fresh
    // window, NOT N+1. It must emit a normal renderer_load_observed and NOT trip.
    const beforeObserved = securityEvents.filter((e) => e.type === 'renderer_load_observed').length;
    await answeredCycle(c);
    const afterObserved = securityEvents.filter((e) => e.type === 'renderer_load_observed').length;
    assert(afterObserved === beforeObserved + 1,
      'a cycle after the window slides resumes emitting renderer_load_observed');
    blocked = securityEvents.filter((e) => e.type === 'renderer_navigation_blocked');
    assert(blocked.length === 0, 'no ceiling trip after the window slides (count reset correctly)');
  } finally {
    Date.now = realNow;
  }
  const got2118 = errors.length > 0
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(!got2118, 'no termination across the slide');
  assert(c._terminated !== true, 'container alive across the window slide');
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// 4. AUTH STILL INTACT (regression guard): the rate ceiling is purely ON TOP of
//    the authenticated gate. A genuine UNAUTHORIZED post-render load (probe
//    UNANSWERED — lost control) still terminates with 2118, exactly as Phase 1.
//    The ceiling must not have weakened the loadProbe/loadAck authentication.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n4. Auth intact: an UNANSWERED post-render load still terminates 2118 (lost control)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // A couple of answered cycles first (proves the ceiling path coexists with the
  // terminate-on-unanswered path).
  await answeredCycle(c);
  await answeredCycle(c);
  assert(c._terminated !== true, 'survives the answered cycles');

  // Now a load whose probe is NEVER answered — the controlled document was
  // replaced by an uncontrolled external webpage with no prelude.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // 100ms probe deadline + the 1s force-terminate tail of _handleFatalError.
  await sleep(1200);

  const got2118 = errors.some((e) =>
    e.code === protoMod.ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION)
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(got2118, 'unanswered post-render load still terminates unauthorized_navigation/2118');
  assert(c._terminated === true, 'lost-control load still terminates the container');
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// 5. THROTTLE DOES NOT BLIND THE LOST-CONTROL PATH (security invariant): once the
//    rate ceiling has TRIPPED (renderer is being throttled — renderer_load_observed
//    suppressed), a genuine UNANSWERED post-render load STILL terminates with 2118.
//    Throttling redundant diagnostics must never disarm the loadProbe/loadAck
//    authentication that catches a lost-control swap. This is the case the
//    Security review specifically cared about: a renderer cannot flood past the
//    ceiling to mask a subsequent uncontrolled-navigation as "just more throttle".
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n5. Throttle does not blind 2118: an UNANSWERED load AFTER the ceiling trips still terminates');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // Flood PAST the ceiling so the throttle is active (ceilingTripped === true).
  // N + 5 answered cycles back-to-back inside the window, as in test 2.
  const total = N + 5;
  for (let i = 0; i < total; i++) await answeredCycle(c);

  // Confirm we are in fact throttled: exactly one 2122 fired and observed is
  // bounded at N (the ceiling has tripped — this is the precondition under test).
  const blocked = securityEvents.filter((e) => e.type === 'renderer_navigation_blocked');
  assert(blocked.length === 1, 'precondition: ceiling tripped (one renderer_navigation_blocked / 2122)');
  const observedAtTrip = securityEvents.filter((e) => e.type === 'renderer_load_observed').length;
  assert(observedAtTrip === N, 'precondition: renderer_load_observed bounded at N (throttle active)');
  assert(c._terminated !== true, 'precondition: ad still alive while throttled');

  // Now, WHILE THROTTLED, a load whose probe is NEVER answered — the controlled
  // document was swapped for an uncontrolled external webpage with no prelude.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // 100ms probe deadline + the 1s force-terminate tail of _handleFatalError.
  await sleep(1200);

  const got2118 = errors.some((e) =>
    e.code === protoMod.ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION)
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(got2118,
    'unanswered load AFTER the ceiling trip STILL terminates unauthorized_navigation/2118 (throttle does not blind lost-control)');
  assert(c._terminated === true, 'lost-control load terminates the container even while throttled');
  if (!c._terminated) c._terminate();
}

if (failures === 0) {
  console.log('\n✓ All probe-cycle-ceiling assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} probe-cycle-ceiling assertion(s) failed.`);
  process.exit(1);
}
