/**
 * test-mraid-exposure-change.js — MRAID 3.0 exposureChange event (#341).
 *
 * MRAID 3.0 §4.7 defines `exposureChange(exposedPercentage, visibleRectangle,
 * occlusionRectangles)` for partial-viewability signalling. The SHARC bridge
 * never implemented it (audit F8 / NEW-F). This wires a LEAN minimal mapping
 * off the viewability signal the bridge already has:
 *
 *   exposedPercentage   = 100 when viewable (sharcState==='active'), else 0
 *   visibleRectangle    = the ad's own rect {x:0,y:0,width,height} when >0, null when 0
 *   occlusionRectangles = null (SHARC does not model occlusion — minimal)
 *
 * exposureChange fires on the SAME viewability transitions that drive
 * viewableChange, with the SAME consecutive-identical dedup discipline that
 * #343/#348 applied across the other value-typed adapter channels.
 *
 * This channel is NON-LATCHING (like viewableChange in this bridge): there is
 * no ready-seed and no replay. The first exposure rides the first `active`
 * stateChange; a listener registered AFTER `active` is already delivered
 * receives nothing until the next transition.
 *
 * Coverage (issue #341):
 *   X1  becomes viewable ⇒ exposureChange(100, {x,y,width,height}, null)
 *   X2  leaves viewable  ⇒ exposureChange(0, null, null)
 *   X3  consecutive-identical exposure does NOT double-fire (dedup)
 *   X4  a listener registered BEFORE the first `active` receives the first
 *       exposure on that transition (non-latching; no ready-seed)
 *   X5  a listener registered AFTER `active` is already delivered receives ZERO
 *       events until the next transition (no replay of the last exposure)
 *   X6  oscillation active→passive→active re-fires 100 each time it re-enters
 *       viewable (dedup is consecutive-only, not set-membership)
 *   X7  frozen suppression + terminated finalization: frozen fires nothing and
 *       does not mutate _lastExposure; terminated emits one final 0 from a
 *       viewable state and is deduped from an already-non-viewable state
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
  const drivePlacementChange = (update) => {
    (eventListeners.placementChange || []).forEach((fn) => fn(update));
  };

  return {
    mraid: win.mraid,
    SHARC,
    driveState,
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

// ── X1 — becomes viewable ⇒ exposureChange(100, ownRect, null) ───────────────
{
  console.log('X1 — active ⇒ exposureChange(100, {x,y,width,height}, null):');
  const h = await makeBridge();
  h.fireReadyWithGeometry(); // real geometry lands on first post-ready placementChange (#393)
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveState('active');
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

// ── X2 — leaves viewable ⇒ exposureChange(0, null, null) ─────────────────────
{
  console.log('X2 — active→passive ⇒ exposureChange(0, null, null):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  const calls = recordExposure(h.mraid);
  h.driveState('passive');
  check(calls.length === 1, 'exposureChange fired exactly once on leaving viewable (got ' + calls.length + ')');
  check(calls.length === 1 && calls[0].pct === 0, 'exposedPercentage === 0');
  check(calls.length === 1 && calls[0].rect === null, 'visibleRectangle === null when not exposed');
  check(calls.length === 1 && calls[0].occl === null, 'occlusionRectangles === null');
}

// ── X3 — consecutive-identical exposure does NOT double-fire ─────────────────
// passive→hidden are both non-viewable → exposure stays 0 → no second fire.
{
  console.log('X3 — consecutive-identical exposure deduped:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveState('passive'); // 0 (first non-viewable after ready)
  h.driveState('hidden');  // still 0 → deduped
  h.driveState('passive'); // still 0 → deduped
  const pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([0]),
    'exposedPercentage sequence is [0] across passive→hidden→passive (got ' + JSON.stringify(pcts) + ')',
  );
}

// ── X4 — listener before the first `active` receives the first exposure ──────
// Non-latching channel, no ready-seed: a listener present before the first
// `active` stateChange observes the exposure that rides that transition. The
// "before ready" timing is incidental — the load-bearing fact is that the
// listener is registered before `active` is delivered.
{
  console.log('X4 — listener before first `active` sees first exposure (no seed):');
  const h = await makeBridge();
  const calls = recordExposure(h.mraid); // registered before the first `active`
  h.fireReadyWithGeometry(); // real geometry on first post-ready placementChange (#393)
  await tick();
  h.driveState('active'); // first exposure rides this transition
  check(calls.length === 1 && calls[0].pct === 100, 'listener got exposureChange(100, ...) on the active transition');
  check(calls.length === 1 && calls[0].rect !== null && calls[0].rect.width === 320, 'with own rect');
}

// ── X5 — listener AFTER active gets ZERO events until next transition ─────────
// The channel does NOT replay the last exposure to a late listener. A listener
// registered after `active` is already delivered receives nothing until the
// next state transition — this is the real non-latching contract.
{
  console.log('X5 — listener after active gets ZERO events until next transition (no replay):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');                // exposure 100 delivered to nobody recorded yet
  const calls = recordExposure(h.mraid); // registered AFTER active is delivered
  check(calls.length === 0, 'late listener received ZERO events (no replay of last exposure)');
  h.driveState('passive');               // next live transition
  check(calls.length === 1 && calls[0].pct === 0, 'late listener received the NEXT transition: exposureChange(0, null, null)');
  check(calls.length === 1 && calls[0].rect === null, 'visibleRectangle null on leaving viewable');
}

// ── X6 — oscillation re-fires 100 each re-entry (consecutive-only dedup) ──────
{
  console.log('X6 — active→passive→active re-fires 100 on re-entry:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveState('active');  // 100
  h.driveState('passive'); // 0
  h.driveState('active');  // 100 again (distinct from the intervening 0)
  const pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([100, 0, 100]),
    'exposedPercentage sequence is [100,0,100] (got ' + JSON.stringify(pcts) + ')',
  );
}

// ── X7 — frozen suppression + terminated finalization ────────────────────────
// frozen is the property "most likely to regress": the stateChange handler
// skips the entire viewableChange/exposureChange block for 'frozen', so frozen
// must (a) fire NO exposureChange and (b) NOT mutate _lastExposure — proven by
// a subsequent `active` with identical exposure NOT re-firing.
{
  console.log('X7a — frozen fires nothing and does not mutate _lastExposure:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  const calls = recordExposure(h.mraid);
  h.driveState('active'); // 100
  h.driveState('frozen'); // suppressed entirely — no fire, _lastExposure stays 100
  let pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([100]),
    'active→frozen yields sequence [100] (frozen fired nothing) (got ' + JSON.stringify(pcts) + ')',
  );
  h.driveState('active'); // identical exposure 100 → deduped because _lastExposure was never reset by frozen
  pcts = calls.map((c) => c.pct);
  check(
    JSON.stringify(pcts) === JSON.stringify([100]),
    'frozen→active does NOT re-fire (proves _lastExposure still 100; frozen did not mutate it) (got ' + JSON.stringify(pcts) + ')',
  );
}

// terminated DOES run the block (terminated !== 'frozen'): from a viewable
// state it flips exposure to 0 and emits exactly one final exposureChange.
{
  console.log('X7b — terminated from viewable emits one final exposureChange(0, null, null):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active'); // 100
  const calls = recordExposure(h.mraid);
  h.driveState('terminated'); // 0 → one final fire
  check(calls.length === 1, 'terminated fired exactly once from viewable (got ' + calls.length + ')');
  check(calls.length === 1 && calls[0].pct === 0, 'final exposedPercentage === 0');
  check(calls.length === 1 && calls[0].rect === null, 'visibleRectangle === null');
  check(calls.length === 1 && calls[0].occl === null, 'occlusionRectangles === null');
}

// terminated from an already-non-viewable state is deduped (exposure already 0).
{
  console.log('X7c — terminated from non-viewable state is deduped (no fire):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('passive'); // 0 (first non-viewable after ready)
  const calls = recordExposure(h.mraid);
  h.driveState('terminated'); // still 0 → deduped, no fire
  check(calls.length === 0, 'terminated fired ZERO times from a non-viewable state (got ' + calls.length + ')');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} exposureChange assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All MRAID exposureChange assertions passed.');
