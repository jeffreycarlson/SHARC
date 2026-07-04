/**
 * test-mraid-exposure-change.js — MRAID 3.0 exposureChange event (#341).
 *
 * MRAID 3.0 §4.7 defines `exposureChange(exposedPercentage, visibleRectangle,
 * occlusionRectangles)` for partial-viewability signalling.
 *
 * SLICE D RE-TARGET (ADR 2026-07-04, Δ2/Δ3): exposure rides the effective-
 * visibility surface (`SHARC.on('effectiveVisibilityChange')`), not the
 * lifecycle enum:
 *
 *   exposedPercentage   = the composed continuous integer (EV.effectivePercent)
 *   visibleRectangle    = full own-rect {x:0,y:0,width,height} at 100;
 *                         null at 1–99 (honest-null until G6); null at 0
 *   occlusionRectangles = null (SHARC does not model occlusion — minimal)
 *
 * exposureChange keeps the consecutive-identical dedup discipline that
 * #343/#348 applied across the other value-typed adapter channels — deduped on
 * the emitted exposedPercentage, so a reason-only EV change fires nothing.
 *
 * This channel is NON-LATCHING (like viewableChange in this bridge): the MRAID
 * adapter does not replay the last exposure to a late mraid listener. (The
 * underlying EV bus replays to the BRIDGE — Slice C F4 — but the adapter
 * output stays live-only.)
 *
 * Coverage (issue #341, re-targeted to the Slice D contract):
 *   X1  EV {100} ⇒ exposureChange(100, {x,y,width,height}, null)
 *   X2  EV {0}   ⇒ exposureChange(0, null, null); a state-only push fires nothing
 *   X3  consecutive-identical exposure does NOT double-fire (dedup on the
 *       emitted value; reason-only changes are not notifications)
 *   X4  a listener registered BEFORE the first EV delivery receives the first
 *       exposure on that delivery (non-latching; no ready-seed)
 *   X5  a listener registered AFTER an EV is already delivered receives ZERO
 *       events until the next delivery (no replay of the last exposure)
 *   X6  oscillation 100→0→100 re-fires 100 each re-entry (dedup is
 *       consecutive-only, not set-membership)
 *   X7  frozen structural + terminated terminal: the backgrounded→frozen
 *       reason-only change fires nothing and does not corrupt the dedup state;
 *       terminated emits NO exposureChange (exposure is never enum-derived —
 *       Δ5/Δ6) and post-terminate EV deliveries are dead (no resurrection)
 *
 * Harness mirrors test-mraid-adapter-dedup.js: a fresh fake SHARC host + a
 * fresh bridge instance per case from the built bundle under its own
 * globalThis.window via a cache-busting import query.
 */

const BRIDGE_URL = '../../dist/sharc-mraid-bridge.mjs';

let nonce = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

const DEFAULT_ENV = {
  currentPlacement: {
    initialDefaultSize: { width: 320, height: 50 },
    maxExpandSize: { width: 1024, height: 768 },
    viewportSize: { width: 1024, height: 768 },
  },
  initialPosition: { x: 0, y: 0, width: 320, height: 50 },
  data: { placement: { instl: 0 }, app: { bundle: 'test-app' } },
};

/** Builds the composed EV payload exactly as the container wire carries it. */
function ev(effectivePercent, reason) {
  return { effectivePercent, reason: reason === undefined ? null : reason, visibleRectangle: null };
}

async function makeBridge() {
  const readyCallbacks = [];
  const startCallbacks = [];
  const eventListeners = {};

  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart(cb) { startCallbacks.push(cb); },
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
    },
    hasFeature() { return true; },
    requestNavigation() { return Promise.resolve(); },
    requestPlacementChange() { return Promise.resolve(); },
    requestClose() { return Promise.resolve(); },
  };

  globalThis.location = { protocol: 'http:', hostname: 'localhost' };
  globalThis.window = {
    __sharcMraidBridgeAutoInstall: true,
    SHARC,
  };

  await import(`${BRIDGE_URL}?exposure=${Date.now()}-${nonce++}`);

  const win = globalThis.window;

  const driveState = (state) => {
    (eventListeners.stateChange || []).forEach((fn) => fn(state));
  };
  const driveEV = (payload) => {
    (eventListeners.effectiveVisibilityChange || []).forEach((fn) => fn(payload));
  };
  const drivePlacementChange = (update) => {
    (eventListeners.placementChange || []).forEach((fn) => fn(update));
  };

  return {
    mraid: win.mraid,
    SHARC,
    driveState,
    driveEV,
    drivePlacementChange,
    // #393 two-phase geometry: real dimensions land on the first post-ready
    // placementChange, not at ready (positions are placeholder zeros at ready).
    // Cases that assert a non-zero visibleRectangle drive the real geometry in.
    fireReadyWithGeometry(env) {
      readyCallbacks[0](env || DEFAULT_ENV);
      drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });
    },
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
  };
}

// Attaches an exposureChange recorder, returns the captured-args array.
function recordExposure(mraid) {
  const calls = [];
  mraid.addEventListener('exposureChange', (pct, rect, occl) => {
    calls.push({ pct, rect, occl });
  });
  return calls;
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-exposure-change.js — MRAID 3.0 exposureChange (#341)\n');

// ── X1 — EV {100} ⇒ exposureChange(100, ownRect, null) ───────────────────────
{
  console.log('X1 — EV {100} ⇒ exposureChange(100, {x,y,width,height}, null):');
  const h = await makeBridge();
  h.fireReadyWithGeometry(); // real geometry lands on first post-ready placementChange (#393)
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveState('active');   // establish (axis-1) — must fire nothing by itself
  check(calls.length === 0, 'state-only "active" fired NO exposureChange (exposure rides EV only)');
  h.driveEV(ev(100, null));
  check(calls.length === 1, 'exposureChange fired exactly once (got ' + calls.length + ')');
  check(calls.length === 1 && calls[0].pct === 100, 'exposedPercentage === 100');
  check(
    calls.length === 1 && calls[0].rect !== null && typeof calls[0].rect === 'object'
      && calls[0].rect.width === 320 && calls[0].rect.height === 50
      && calls[0].rect.x === 0 && calls[0].rect.y === 0,
    'visibleRectangle is own rect {x:0,y:0,width:320,height:50}',
  );
  check(calls.length === 1 && calls[0].occl === null, 'occlusionRectangles === null');
}

// ── X2 — EV {0} ⇒ exposureChange(0, null, null) ──────────────────────────────
{
  console.log('X2 — EV {100} then EV {0} ⇒ exposureChange(0, null, null):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null));
  const calls = recordExposure(h.mraid);
  h.driveState('passive'); // state-only push — no exposure effect (Δ5)
  check(calls.length === 0, 'state-only "passive" fired NO exposureChange');
  h.driveEV(ev(0, 'offscreen'));
  check(calls.length === 1, 'exposureChange fired exactly once on leaving exposure (got ' + calls.length + ')');
  check(calls.length === 1 && calls[0].pct === 0, 'exposedPercentage === 0');
  check(calls.length === 1 && calls[0].rect === null, 'visibleRectangle === null when not exposed');
  check(calls.length === 1 && calls[0].occl === null, 'occlusionRectangles === null');
}

// ── X3 — consecutive-identical exposure does NOT double-fire ─────────────────
// Same exposedPercentage across deliveries (including reason-only changes)
// must not re-fire — dedup is on the emitted value.
{
  console.log('X3 — consecutive-identical exposure deduped:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveEV(ev(0, 'offscreen'));     // 0 (first delivery after ready)
  h.driveEV(ev(0, 'backgrounded'));  // still 0, reason-only → deduped
  h.driveEV(ev(0, 'offscreen'));     // still 0 → deduped
  const pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([0]),
    'exposedPercentage sequence is [0] across three same-value deliveries (got ' + JSON.stringify(pcts) + ')',
  );
}

// ── X4 — listener before the first EV delivery receives the first exposure ───
// Non-latching channel, no ready-seed: a listener present before the first EV
// delivery observes the exposure that rides that delivery.
{
  console.log('X4 — listener before first EV sees first exposure (no seed):');
  const h = await makeBridge();
  const calls = recordExposure(h.mraid); // registered before the first delivery
  h.fireReadyWithGeometry(); // real geometry on first post-ready placementChange (#393)
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null)); // first exposure rides this delivery
  check(calls.length === 1 && calls[0].pct === 100, 'listener got exposureChange(100, ...) on the EV delivery');
  check(calls.length === 1 && calls[0].rect !== null && calls[0].rect.width === 320, 'with own rect');
}

// ── X5 — listener AFTER a delivery gets ZERO events until the next one ───────
// The adapter does NOT replay the last exposure to a late mraid listener. A
// listener registered after an EV is already delivered receives nothing until
// the next delivery — this is the real non-latching contract.
{
  console.log('X5 — listener after delivery gets ZERO events until next delivery (no replay):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null));              // exposure 100 delivered to nobody recorded yet
  const calls = recordExposure(h.mraid); // registered AFTER the delivery
  check(calls.length === 0, 'late listener received ZERO events (no replay of last exposure)');
  h.driveEV(ev(0, 'offscreen'));         // next live delivery
  check(calls.length === 1 && calls[0].pct === 0, 'late listener received the NEXT delivery: exposureChange(0, null, null)');
  check(calls.length === 1 && calls[0].rect === null, 'visibleRectangle null on leaving exposure');
}

// ── X6 — oscillation re-fires 100 each re-entry (consecutive-only dedup) ──────
{
  console.log('X6 — EV 100→0→100 re-fires 100 on re-entry:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveState('active');
  h.driveEV(ev(100, null));      // 100
  h.driveEV(ev(0, 'offscreen')); // 0
  h.driveEV(ev(100, null));      // 100 again (distinct from the intervening 0)
  const pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([100, 0, 100]),
    'exposedPercentage sequence is [100,0,100] (got ' + JSON.stringify(pcts) + ')',
  );
}

// ── X7 — frozen structural + terminated terminal ─────────────────────────────
// Slice D (Δ9): the old frozen special-case branch is deleted — the exception
// is structural. Browsers only freeze hidden pages, so by freeze time the
// composer already delivered {0, backgrounded}; the freeze push is a
// reason-only change ({0, frozen}) absorbed by the value dedup. The enum
// 'frozen' push is axis-1 bookkeeping and fires nothing either.
{
  console.log('X7a — backgrounded→frozen is a reason-only change: zero events, dedup intact:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveState('active');
  h.driveEV(ev(100, null));         // 100
  h.driveState('hidden');           // axis-1 backgrounding push — nothing
  h.driveEV(ev(0, 'backgrounded')); // 0
  h.driveState('frozen');           // axis-1 freeze push — nothing
  h.driveEV(ev(0, 'frozen'));       // reason-only → deduped, nothing
  let pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([100, 0]),
    'freeze contributed ZERO events: sequence is [100,0] (got ' + JSON.stringify(pcts) + ')',
  );
  h.driveState('active');           // return — axis-1 push, nothing
  h.driveEV(ev(100, null));         // 100 re-fires exactly once (dedup state intact)
  pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([100, 0, 100]),
    'return re-fires 100 exactly once (freeze did not corrupt the dedup state) (got ' + JSON.stringify(pcts) + ')',
  );
}

// terminated is TERMINAL (Δ6): it latches the bridge closed. Exposure is never
// enum-derived, so terminate emits NO exposureChange — and once closed, EV
// deliveries are dead (no resurrection, mirroring slice-d D5/D6).
{
  console.log('X7b — terminated emits NO exposureChange; post-terminate EV deliveries are dead:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null)); // exposed before terminate
  const calls = recordExposure(h.mraid);
  h.driveState('terminated');
  check(calls.length === 0, 'terminated fired ZERO exposureChange (exposure is never enum-derived) (got ' + calls.length + ')');
  h.driveEV(ev(50, 'offscreen')); // straggler delivery after terminal close
  check(calls.length === 0, 'post-terminate EV delivery emits NOTHING (closed latch, no resurrection)');
  check(h.mraid.getState() === 'hidden', 'getState() is terminal "hidden" after terminate');
}

// terminated from a never-exposed state: still no exposure traffic.
{
  console.log('X7c — terminated from a non-exposed state fires nothing:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveEV(ev(0, 'offscreen')); // non-exposed (delivered before the recorder attaches)
  const calls = recordExposure(h.mraid);
  h.driveState('terminated');
  check(calls.length === 0, 'terminated fired ZERO times from a non-exposed state (got ' + calls.length + ')');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} exposureChange assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All MRAID exposureChange assertions passed.');
