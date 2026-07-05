/**
 * test-mraid-adapter-dedup.js — MRAID adapter-level lifecycle output dedup (#343).
 *
 * The container→creative `stateChange` dedup shipped in the State-Delivery
 * Contract (#342), but the MRAID bridge RE-EMITS at the API level, and the
 * SHARC→MRAID mapping collapses distinct SHARC states into identical MRAID
 * states. So the adapter must enforce the same "no redundant consecutive
 * identical lifecycle notification" invariant on its own value-typed outputs.
 *
 * Coverage (issue #343):
 *   D1  MRAID stateChange consecutive-identical dedup. SHARC `active` and
 *       `passive` BOTH map to MRAID `'default'`, so `active→passive→active`
 *       must emit MRAID stateChange('default') exactly ONCE. (RED on main:
 *       the unconditional _emit fires it three times.)
 *   D2  A genuine MRAID-state-change sequence (default→expanded→default via
 *       expand/collapse) emits each MRAID state — dedup must not swallow real
 *       transitions.
 *   D3  audioVolumeChange same-value guard: a repeated identical
 *       volumePercentage is deduped; a changed value flows.
 *   D4  sizeChange same-value guard: a repeated identical (w,h) is deduped; a
 *       changed (w,h) flows.
 *   D5  viewableChange remains edge-guarded (regression: the stateChange dedup
 *       must not interfere with the separate viewableChange channel).
 *
 * Test harness mirrors test-mraid-visibility-channel.js: a fresh fake SHARC
 * host + a fresh bridge instance per case, loaded from the built bundle under
 * its own globalThis.window via a cache-busting import query.
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

/**
 * Builds a fresh fake SHARC host + installs a fresh bridge instance.
 * requestPlacementChange resolves so expand/collapse/resize reach their
 * .then() and emit their stateChange.
 */
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

  await import(`${BRIDGE_URL}?dedup=${Date.now()}-${nonce++}`);

  const win = globalThis.window;
  const observed = { ready: 0, stateChanges: [], viewableChanges: [], sizeChanges: [], audioVolumeChanges: [] };
  win.mraid.addEventListener('ready', () => { observed.ready++; });
  win.mraid.addEventListener('stateChange', (s) => { observed.stateChanges.push(s); });
  win.mraid.addEventListener('viewableChange', (v) => { observed.viewableChanges.push(v); });
  win.mraid.addEventListener('sizeChange', (w, h) => { observed.sizeChanges.push([w, h]); });
  win.mraid.addEventListener('audioVolumeChange', (a) => { observed.audioVolumeChanges.push(a && a.volumePercentage); });

  const driveState = (state) => {
    (eventListeners.stateChange || []).forEach((fn) => fn(state));
  };
  const drivePlacementChange = (update) => {
    (eventListeners.placementChange || []).forEach((fn) => fn(update));
  };
  const driveAudioVolumeChange = (args) => {
    (eventListeners.audioVolumeChange || []).forEach((fn) => fn(args));
  };
  // Slice D: viewability rides the effective-visibility surface.
  const driveEV = (payload) => {
    (eventListeners.effectiveVisibilityChange || []).forEach((fn) => fn(payload));
  };

  return {
    mraid: win.mraid,
    SHARC,
    observed,
    driveState,
    drivePlacementChange,
    driveAudioVolumeChange,
    driveEV,
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-adapter-dedup.js — MRAID adapter-level lifecycle dedup (#343)\n');

// ── D1 — MRAID stateChange consecutive-identical dedup ───────────────────────
// active and passive both map to MRAID 'default'. The onReady seed already
// emitted 'default'. So active→passive→active must add NO further 'default'
// emissions: the whole run emits stateChange('default') exactly once.
{
  console.log('D1 — active→passive→active maps to default, emitted once:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');   // → 'default'
  h.driveState('passive');  // → 'default'
  h.driveState('active');   // → 'default'
  const defaults = h.observed.stateChanges.filter((s) => s === 'default');
  check(
    defaults.length === 1,
    'stateChange("default") emitted exactly once across ready+active→passive→active (got ' + defaults.length + ')',
  );
  check(
    JSON.stringify(h.observed.stateChanges) === JSON.stringify(['default']),
    'full stateChange sequence is exactly ["default"]',
  );
}

// ── D2 — genuine MRAID-state changes are NOT swallowed ───────────────────────
// default→expanded→default (via expand/collapse) must emit each MRAID state.
// #393/RISK-4: stateChange is driven off the placementChange signal (geometry
// settled first), not the requestPlacementChange().then() microtask. So the
// container's placementChange must arrive to settle each in-flight intent.
{
  console.log('D2 — genuine default→expanded→default emits each:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.mraid.expand();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 1024, height: 768 } }); // settles 'expanded'
  h.mraid.collapse();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } }); // settles 'default'
  check(
    JSON.stringify(h.observed.stateChanges) === JSON.stringify(['default', 'expanded', 'default']),
    'stateChange sequence is ["default","expanded","default"] (got ' + JSON.stringify(h.observed.stateChanges) + ')',
  );
}

// ── D3 — audioVolumeChange same-value guard ──────────────────────────────────
{
  console.log('D3 — audioVolumeChange dedups same value, flows on change:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveAudioVolumeChange({ volumePercentage: 50, volume: 0.5, isMuted: false });
  h.driveAudioVolumeChange({ volumePercentage: 50, volume: 0.5, isMuted: false }); // redundant
  h.driveAudioVolumeChange({ volumePercentage: 80, volume: 0.8, isMuted: false }); // changed
  h.driveAudioVolumeChange({ volumePercentage: 80, volume: 0.8, isMuted: false }); // redundant
  check(
    JSON.stringify(h.observed.audioVolumeChanges) === JSON.stringify([50, 80]),
    'audioVolumeChange sequence is [50,80] (got ' + JSON.stringify(h.observed.audioVolumeChanges) + ')',
  );
}

// ── D4 — sizeChange same-value guard ─────────────────────────────────────────
// #393 two-phase geometry: the placeholder S1 sizeChange (from initialDefaultSize)
// fires at ready, and the FIRST post-ready placementChange is the real-geometry
// S3 fire — forced through even when it matches the placeholder so a creative
// always gets a distinct post-ready sizeChange. After S3, the same-value guard
// resumes: redundant (w,h) deduped, position-only moves deduped.
{
  console.log('D4 — sizeChange dedups same (w,h), flows on change:');
  const h = await makeBridge();
  h.fireReady();                                                       // S1 placeholder [320,50]
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });  // S3 real (forced) [320,50]
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });  // redundant → deduped
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 300, height: 250 } }); // changed
  h.drivePlacementChange({ position: { x: 10, y: 10, width: 300, height: 250 } }); // pos moved, size same → dedup
  check(
    JSON.stringify(h.observed.sizeChanges) === JSON.stringify([[320, 50], [320, 50], [300, 250]]),
    'sizeChange sequence is [[320,50],[320,50],[300,250]] (placeholder, real, changed) (got ' + JSON.stringify(h.observed.sizeChanges) + ')',
  );
}

// ── D5 — viewableChange still edge-guarded (regression) ──────────────────────
// The stateChange dedup must not break the separate viewableChange channel.
// Slice D re-target: viewability rides the effective-visibility surface (the
// enum drives here are axis-1 bookkeeping that the stateChange dedup absorbs);
// the EV crossings below prove the two channels stay independent.
{
  console.log('D5 — viewableChange unaffected by stateChange dedup:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');   // → 'default' (deduped against the ready seed)
  h.driveEV({ effectivePercent: 100, reason: null, visibleRectangle: null }); // viewable true
  h.driveState('passive');  // → 'default' (deduped again)
  h.driveEV({ effectivePercent: 0, reason: 'offscreen', visibleRectangle: null }); // viewable false
  h.driveState('active');   // → 'default' (deduped again)
  h.driveEV({ effectivePercent: 100, reason: null, visibleRectangle: null }); // viewable true
  check(
    JSON.stringify(h.observed.viewableChanges) === JSON.stringify([true, false, true]),
    'viewableChange sequence is [true,false,true] (got ' + JSON.stringify(h.observed.viewableChanges) + ')',
  );
}

if (failures > 0) {
  console.error(`\n✗ ${failures} adapter-dedup assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All MRAID adapter-dedup assertions passed.');
