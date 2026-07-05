/**
 * test-slice-d-mraid-repoint.js — Slice D RED TESTS (MRAID consumer re-point).
 *
 * Expresses the ratified Slice D contract (ADR 2026-07-04-slice-d-consumer-
 * repoint.md, Δ1–Δ9 signed off): the MRAID bridge derives viewability and
 * exposure from the ONE effective-visibility surface
 * (`SHARC.on('effectiveVisibilityChange')` → {effectivePercent, reason,
 * visibleRectangle}), and `getMraidState` is de-coupled from `_sharcState` —
 * MRAID `'hidden'` comes ONLY from the close/terminate `_closed` latch.
 *
 * STATUS: RED by design. Production code on bcda6f2 still derives viewability
 * from the lifecycle enum (`_isViewable = state==='active'`; binary 100/0
 * exposure; `hidden|frozen → 'hidden'` in getMraidState; no EV subscription;
 * no `_closed` latch). Each block fails on the OLD derivation — not on
 * harness/import errors.
 *
 * Contract coverage:
 *   D1  L-10 state invariance — getState() stays 'default' across EV swings
 *       AND across enum 'hidden'/'frozen' delivery; no stateChange('hidden')
 *       and no viewable/exposure emission from any enum visibility path (Δ5)
 *   D2  EV-7 crossing — 49 ⇒ viewable false, 50 ⇒ viewableChange(true),
 *       re-crossing re-fires (Δ1/Δ4: enum 'active' alone sets nothing)
 *   D3  Continuous exposureChange — 73 ⇒ exposureChange(73,…) not 100; dedup
 *       on repeat; visibleRectangle policy: 100 ⇒ full own-rect from
 *       _currentPosition, 1–99 ⇒ null, 0 ⇒ null (Δ2/Δ3)
 *   D4  Frozen structural — backgrounded {0} then freeze {0,frozen} is a
 *       reason-only change: ZERO additional MRAID events via dedup (Δ9)
 *   D5  Close terminal — SHARC 'close' latches _closed (ratified 2026-07-04
 *       review round, MRAID 3.0 §7.5): stateChange('hidden') once →
 *       exposureChange(0, null, null) iff last exposure was nonzero →
 *       viewableChange(false) iff was true → 'unload'; later EV deliveries
 *       emit NOTHING and getState() stays 'hidden' (no resurrection)
 *   D6  terminated → 'hidden' (bug-fix pin, Δ6) — today falls through to
 *       'default'; same teardown emission order as D5 (minus 'unload');
 *       enum 'active' after terminate must not resurrect
 *   D7  Ready-gating — EV bus replay delivered at subscribe (pre-onReady) is
 *       cached silently; applied ONCE after the ready burst, with ready +
 *       stateChange('default') strictly before the first viewableChange
 *   D8  ★ clickthrough round-trip — backgrounding is resumable, never terminal
 *       (ratified addendum 2026-07-04): getState() 'default' at EVERY step,
 *       ZERO stateChange during the round trip, exposure 100→0→100 (freeze
 *       step contributes NO event), viewable true→false→true, ad still
 *       interactive after return (expand still works)
 *   D9  CR-1 pre-ready latch (ratified 2026-07-04 review round) — a close or
 *       terminate delivered BEFORE onReady latches with the terminal
 *       emissions at latch time; the later S1/S2 ready burst + EV tail emits
 *       ZERO state/viewable/exposure events (no 'default' seed resurrection,
 *       no cached-EV application), getState() stays 'hidden', isViewable()
 *       stays false
 *
 * Harness mirrors test-mraid-visibility-channel.js / test-mraid-exposure-
 * change.js: a fresh fake SHARC host + fresh bridge instance per case from the
 * built bundle under its own globalThis.window via a cache-busting import
 * query. The fake SHARC models the Slice C creative bus for BOTH latching
 * value events: on() replays the cached last 'stateChange' AND the cached last
 * 'effectiveVisibilityChange' payload to a new subscriber (sharc-creative.js
 * F4 replay-of-last), and driveEV() delivers live EV pushes exactly as the
 * container wire does.
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

/**
 * Fresh fake SHARC host + fresh bridge instance.
 * @param {Object} [opts]
 * @param {Object} [opts.seedEV] - EV payload cached on the bus BEFORE the
 *   bridge installs, so the bridge's EV subscription receives the F4
 *   replay-of-last at subscribe time (which precedes onReady).
 */
async function makeBridge(opts = {}) {
  const readyCallbacks = [];
  const eventListeners = {};
  const placementRequests = [];
  let lastBusState;          // stateChange replay cache (R1 D3)
  let lastBusEV = opts.seedEV; // effectiveVisibilityChange replay cache (Slice C F4)

  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart() {},
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
      if (name === 'stateChange' && lastBusState !== undefined) cb(lastBusState);
      if (name === 'effectiveVisibilityChange' && lastBusEV !== undefined) cb(lastBusEV);
    },
    hasFeature() { return true; },
    requestNavigation() { return Promise.resolve(); },
    requestPlacementChange(args) { placementRequests.push(args); return Promise.resolve(); },
    requestClose() { return Promise.resolve(); },
  };

  globalThis.location = { protocol: 'http:', hostname: 'localhost' };
  globalThis.window = {
    __sharcMraidBridgeAutoInstall: true,
    SHARC,
    // Slice E3 (#392): the bridge anchors `ready` to document-load-complete. A
    // load-complete document is the fire-now condition, so the ready burst this
    // suite drives via Container:init fires as before — exercising the real gate
    // path (readyState === 'complete'), not the non-browser fallback.
    document: { readyState: 'complete' },
  };

  await import(`${BRIDGE_URL}?sliceD=${Date.now()}-${nonce++}`);

  const win = globalThis.window;

  // Unified event trace so cross-channel ordering + "zero events in a window"
  // are assertable from one array. Recorders attach immediately post-install,
  // BEFORE any fireReady/drive — nothing observable is missed.
  const trace = [];
  win.mraid.addEventListener('ready', () => trace.push({ t: 'ready' }));
  win.mraid.addEventListener('stateChange', (s) => trace.push({ t: 'state', v: s }));
  win.mraid.addEventListener('viewableChange', (v) => trace.push({ t: 'view', v }));
  win.mraid.addEventListener('exposureChange', (pct, rect, occl) => trace.push({ t: 'exp', pct, rect, occl }));
  win.mraid.addEventListener('sizeChange', (w, h) => trace.push({ t: 'size', w, h }));
  win.mraid.addEventListener('unload', () => trace.push({ t: 'unload' }));

  const drivePlacementChange = (update) => {
    (eventListeners.placementChange || []).forEach((fn) => fn(update));
  };

  return {
    mraid: win.mraid,
    trace,
    placementRequests,
    since: (mark) => trace.slice(mark),
    driveState(state) {
      lastBusState = state;
      (eventListeners.stateChange || []).forEach((fn) => fn(state));
    },
    driveEV(payload) {
      lastBusEV = payload;
      (eventListeners.effectiveVisibilityChange || []).forEach((fn) => fn(payload));
    },
    driveClose() {
      (eventListeners.close || []).forEach((fn) => fn());
    },
    drivePlacementChange,
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
    // #393 two-phase geometry: real dimensions land on the first post-ready
    // placementChange. Cases asserting the full own-rect at 100% need this.
    fireReadyWithGeometry(env) {
      readyCallbacks[0](env || DEFAULT_ENV);
      drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });
    },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}
const js = (v) => JSON.stringify(v);

console.log('test-slice-d-mraid-repoint.js — Slice D MRAID consumer re-point (RED)\n');

// ── D1 — L-10 state invariance (Δ5) ──────────────────────────────────────────
// MRAID state and visibility are DIFFERENT AXES: the EV surface swinging
// 100→0(backgrounded)→100 and the lifecycle enum delivering 'hidden'/'frozen'
// must both leave getState() at 'default', with zero stateChange('hidden')
// emissions and zero viewable/exposure emissions from the enum path.
{
  console.log('D1 — L-10: getState() invariant across EV swings and enum hidden/frozen:');
  const h = await makeBridge();
  h.fireReadyWithGeometry();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null)); // establish visible
  check(h.mraid.getState() === 'default', 'established: getState() === "default"');

  const evMark = h.trace.length;
  h.driveEV(ev(0, 'backgrounded'));
  check(h.mraid.getState() === 'default', 'EV {0,backgrounded}: getState() stays "default"');
  h.driveEV(ev(100, null));
  check(h.mraid.getState() === 'default', 'EV back to {100}: getState() stays "default"');
  check(
    h.since(evMark).filter((e) => e.t === 'state').length === 0,
    'EV swing emitted ZERO stateChange (visibility is not placement state)',
  );

  const enumMark = h.trace.length;
  h.driveState('hidden');
  check(h.mraid.getState() === 'default', 'enum "hidden" delivered: getState() stays "default" (Δ5 — RED: _sharcState branch flips it)');
  h.driveState('frozen');
  check(h.mraid.getState() === 'default', 'enum "frozen" delivered: getState() stays "default"');
  const enumEvents = h.since(enumMark);
  check(
    enumEvents.filter((e) => e.t === 'state' && e.v === 'hidden').length === 0,
    'no stateChange("hidden") emission from any visibility path',
  );
  check(
    enumEvents.filter((e) => e.t === 'view' || e.t === 'exp').length === 0,
    'enum delivery emitted ZERO viewableChange/exposureChange (viewability rides EV only)',
  );
}

// ── D2 — EV-7 crossing: 49 ⇒ false, 50 ⇒ true ────────────────────────────────
// Establish gates THAT measurement flows (HB-6); the VALUE comes from EV.
// Enum 'active' alone sets no viewability (Δ4); the 0.5 crossing does.
{
  console.log('D2 — EV-7 crossing: 49 ⇒ viewable false, 50 ⇒ viewableChange(true):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(49, 'offscreen'));
  check(h.mraid.isViewable() === false, 'EV 49: isViewable() === false (RED: enum "active" alone set it true)');
  check(
    h.trace.filter((e) => e.t === 'view').length === 0,
    'EV 49: no viewableChange yet (RED: enum "active" emitted viewableChange(true))',
  );
  h.driveEV(ev(50, 'offscreen'));
  check(h.mraid.isViewable() === true, 'EV 50: isViewable() === true (crossing)');
  check(
    js(h.trace.filter((e) => e.t === 'view').map((e) => e.v)) === js([true]),
    'viewableChange trace is [true] — exactly one flip, at the 50 crossing',
  );
  h.driveEV(ev(49, 'offscreen'));
  check(
    js(h.trace.filter((e) => e.t === 'view').map((e) => e.v)) === js([true, false]),
    'crossing back to 49 re-fires viewableChange(false) — non-latching',
  );
}

// ── D3 — continuous exposureChange + visibleRectangle policy (Δ2/Δ3) ─────────
{
  console.log('D3 — exposureChange continuous: 73 ⇒ 73; dedup; rect policy:');
  const h = await makeBridge();
  h.fireReadyWithGeometry(); // real geometry {0,0,320,50} in _currentPosition
  await tick();
  h.driveState('active'); // establish only — must NOT emit an exposure by itself
  h.driveEV(ev(73, 'offscreen'));
  const exps = () => h.trace.filter((e) => e.t === 'exp');
  check(
    exps().length === 1 && exps()[0].pct === 73,
    'EV 73 ⇒ exactly one exposureChange with exposedPercentage 73 (RED: binary 100 rode the enum "active") — got ' + js(exps().map((e) => e.pct)),
  );
  check(exps().length === 1 && exps()[0].rect === null, 'partial exposure (1–99) ⇒ visibleRectangle null (honest-null, Δ3)');
  h.driveEV(ev(73, 'offscreen'));
  check(exps().length === 1, 'repeated EV 73 deduped — no second exposureChange');
  h.driveEV(ev(100, null));
  check(exps().length === 2 && exps()[1].pct === 100, 'EV 100 ⇒ exposureChange(100)');
  check(
    exps().length === 2 && js(exps()[1].rect) === js({ x: 0, y: 0, width: 320, height: 50 }),
    'full exposure ⇒ full own-rect synthesized from _currentPosition',
  );
  h.driveEV(ev(0, 'offscreen'));
  check(exps().length === 3 && exps()[2].pct === 0 && exps()[2].rect === null, 'EV 0 ⇒ exposureChange(0, null, …)');
  check(exps().every((e) => e.occl === null), 'occlusionRectangles always null');
}

// ── D4 — frozen structural: reason-only change absorbed by dedup (Δ9) ────────
{
  console.log('D4 — frozen structural: backgrounded → frozen emits ZERO additional events:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null)); // establish visible
  const mark = h.trace.length;
  h.driveEV(ev(0, 'backgrounded'));
  const afterBg = h.since(mark);
  check(
    afterBg.filter((e) => e.t === 'exp' && e.pct === 0).length === 1,
    'EV {0,backgrounded} ⇒ exactly one exposureChange(0) (RED: bridge ignores the EV event today)',
  );
  check(
    js(afterBg.filter((e) => e.t === 'view').map((e) => e.v)) === js([false]),
    'EV {0,backgrounded} ⇒ exactly one viewableChange(false)',
  );
  const frozenMark = h.trace.length;
  h.driveEV(ev(0, 'frozen'));
  check(
    h.since(frozenMark).length === 0,
    'EV {0,frozen} after backgrounded ⇒ ZERO additional MRAID events (dedup absorbs the reason-only change; no special-case branch needed)',
  );
}

// ── D5 — close terminal: _closed latch, hidden once, no resurrection ─────────
{
  console.log('D5 — close: stateChange("hidden") once, then EV deliveries are dead:');
  const h = await makeBridge();
  h.fireReadyWithGeometry();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null)); // viewable true before close
  check(h.mraid.isViewable() === true, 'precondition: viewable true before close');
  const mark = h.trace.length;
  h.driveClose();
  const afterClose = h.since(mark);
  check(
    js(afterClose.filter((e) => e.t === 'state').map((e) => e.v)) === js(['hidden']),
    'close ⇒ stateChange("hidden") emitted exactly once (MRAID 3.0 §7.3.3) (RED: close only fires unload today)',
  );
  check(h.mraid.getState() === 'hidden', 'getState() === "hidden" after close');
  check(
    js(afterClose.filter((e) => e.t === 'exp').map((e) => e.pct)) === js([0]),
    'close from exposure 100 ⇒ exactly one final exposureChange(0) (MRAID 3.0 §7.5 — hiding an interstitial IS an exposure change) (got ' + js(afterClose.filter((e) => e.t === 'exp').map((e) => e.pct)) + ')',
  );
  check(
    afterClose.filter((e) => e.t === 'exp').every((e) => e.rect === null && e.occl === null),
    'teardown exposure carries (0, null, null) — no fabricated geometry',
  );
  check(
    js(afterClose.filter((e) => e.t === 'view').map((e) => e.v)) === js([false]),
    'close from viewable ⇒ exactly one viewableChange(false)',
  );
  const hiddenIdx = afterClose.findIndex((e) => e.t === 'state' && e.v === 'hidden');
  const expIdx = afterClose.findIndex((e) => e.t === 'exp');
  const viewIdx = afterClose.findIndex((e) => e.t === 'view');
  const unloadIdx = afterClose.findIndex((e) => e.t === 'unload');
  check(
    hiddenIdx !== -1 && expIdx !== -1 && viewIdx !== -1 && unloadIdx !== -1
      && hiddenIdx < expIdx && expIdx < viewIdx && viewIdx < unloadIdx,
    'ordering: stateChange("hidden") → exposureChange(0) → viewableChange(false) → "unload" (ratified teardown order)',
  );
  const postCloseMark = h.trace.length;
  h.driveEV(ev(100, null)); // straggler EV replay after close
  check(h.since(postCloseMark).length === 0, 'post-close EV delivery emits NOTHING (no resurrection)');
  check(h.mraid.getState() === 'hidden', 'getState() stays "hidden" after straggler EV');
  check(h.mraid.isViewable() === false, 'isViewable() stays false after straggler EV (_closed forces it)');
}

// ── D6 — terminated → 'hidden' (bug-fix pin, Δ6) ─────────────────────────────
{
  console.log('D6 — stateChange("terminated") ⇒ terminal "hidden", no resurrection:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null));
  const mark = h.trace.length;
  h.driveState('terminated');
  check(
    h.mraid.getState() === 'hidden',
    'terminated ⇒ getState() === "hidden" (RED: falls through to "default" today — the :602 warn comment lies)',
  );
  check(
    js(h.since(mark).filter((e) => e.t === 'state').map((e) => e.v)) === js(['hidden']),
    'terminated ⇒ exactly one stateChange("hidden")',
  );
  check(
    js(h.since(mark).filter((e) => e.t === 'exp').map((e) => e.pct)) === js([0]),
    'terminated from exposure 100 ⇒ exactly one final exposureChange(0) (ratified teardown order, MRAID 3.0 §7.5) (got ' + js(h.since(mark).filter((e) => e.t === 'exp').map((e) => e.pct)) + ')',
  );
  {
    const afterTerm = h.since(mark);
    const tHidden = afterTerm.findIndex((e) => e.t === 'state' && e.v === 'hidden');
    const tExp = afterTerm.findIndex((e) => e.t === 'exp');
    const tView = afterTerm.findIndex((e) => e.t === 'view');
    check(
      tHidden !== -1 && tExp !== -1 && tView !== -1 && tHidden < tExp && tExp < tView,
      'ordering: stateChange("hidden") → exposureChange(0) → viewableChange(false)',
    );
  }
  check(h.mraid.isViewable() === false, 'isViewable() false after terminate');
  const postMark = h.trace.length;
  h.driveEV(ev(100, null));
  h.driveState('active'); // enum resurrection attempt
  check(h.mraid.getState() === 'hidden', 'enum "active" after terminate does NOT resurrect getState() (stays "hidden")');
  check(
    h.since(postMark).filter((e) => e.t === 'state' || e.t === 'view' || e.t === 'exp').length === 0,
    'no stateChange/viewableChange/exposureChange emissions after terminal hidden',
  );
}

// ── D7 — ready-gating of the EV subscribe-time replay ────────────────────────
// The creative bus replays the cached EV payload at subscribe, which precedes
// onReady. The bridge caches silently and applies ONCE after the S1/S2 burst,
// preserving T8/HB-7: ready + stateChange('default') strictly before the
// first viewableChange.
{
  console.log('D7 — ready-gating: pre-ready EV replay cached, applied once after the burst:');
  const h = await makeBridge({ seedEV: ev(100, null) }); // replay fired at install-time subscribe
  check(
    h.trace.filter((e) => e.t === 'view' || e.t === 'exp').length === 0,
    'pre-ready replay emitted nothing (cached only)',
  );
  h.fireReady();
  await tick();
  check(
    js(h.trace.filter((e) => e.t === 'view').map((e) => e.v)) === js([true]),
    'cached EV applied exactly once after ready: viewableChange(true) (RED: no EV subscription exists today)',
  );
  check(
    h.trace.filter((e) => e.t === 'exp' && e.pct === 100).length === 1,
    'cached EV applied exactly once: exposureChange(100)',
  );
  const readyIdx = h.trace.findIndex((e) => e.t === 'ready');
  const defaultIdx = h.trace.findIndex((e) => e.t === 'state' && e.v === 'default');
  const viewIdx = h.trace.findIndex((e) => e.t === 'view');
  check(
    readyIdx !== -1 && viewIdx !== -1 && readyIdx < viewIdx,
    'ordering: ready strictly before the first viewableChange',
  );
  check(
    defaultIdx !== -1 && viewIdx !== -1 && defaultIdx < viewIdx,
    'ordering: stateChange("default") strictly before the first viewableChange',
  );
  const dupMark = h.trace.length;
  h.driveEV(ev(100, null));
  check(
    h.since(dupMark).filter((e) => e.t === 'view' || e.t === 'exp').length === 0,
    'identical live EV after the applied replay is deduped (no double-apply)',
  );
}

// ── D8 — ★ clickthrough round-trip — backgrounding is resumable, never
//         terminal (ratified addendum 2026-07-04) ─────────────────────────────
// Ad clicked → user exits to native browser / another tab → returns. The
// navigation must not kill, close, or state-flip the ad. The enum drives model
// the container's axis-1 wire pushes across the trip; the EV drives model the
// composer. MRAID must ride ONLY the EV values and keep placement state
// untouched throughout.
{
  console.log('D8 — clickthrough round-trip — backgrounding is resumable, never terminal:');
  const h = await makeBridge();
  h.fireReadyWithGeometry();
  await tick();

  // Establish visible: state 'default', exposure 100, viewable true.
  h.driveState('active');
  h.driveEV(ev(100, null));
  check(h.mraid.getState() === 'default', 'established: getState() === "default"');
  check(h.mraid.isViewable() === true, 'established: viewable true');
  const tripMark = h.trace.length; // stateChange must stay silent from here until the expand
  const traceFrom = (mark) => h.since(mark);
  const establishMark = tripMark; // exposure/viewable traces measured across the trip only

  // Background (user leaves the app: visibilitychange).
  h.driveState('hidden');           // axis-1 bookkeeping push still arrives on the wire
  h.driveEV(ev(0, 'backgrounded')); // the composed surface
  check(h.mraid.getState() === 'default', 'backgrounded: getState() STAYS "default" (RED: enum "hidden" flips it today — the legacy-SDK bug class Δ5 eliminates)');

  // Freeze (browser freezes the hidden page).
  h.driveState('frozen');
  h.driveEV(ev(0, 'frozen'));       // reason-only change ⇒ dedup ⇒ zero MRAID events
  check(h.mraid.getState() === 'default', 'frozen: getState() STAYS "default"');

  // Return (user comes back).
  h.driveState('active');
  h.driveEV(ev(100, null));
  check(h.mraid.getState() === 'default', 'returned: getState() === "default"');
  check(h.mraid.isViewable() === true, 'returned: viewable true again');

  const trip = traceFrom(establishMark);
  check(
    trip.filter((e) => e.t === 'state').length === 0,
    'ZERO stateChange emissions during the entire round trip (got ' + js(trip.filter((e) => e.t === 'state').map((e) => e.v)) + ')',
  );
  check(
    js(trip.filter((e) => e.t === 'exp').map((e) => e.pct)) === js([0, 100]),
    'exposure trace across the trip is exactly 100→0→100 (freeze step contributed NO event) — post-establish deltas [0,100], got ' + js(trip.filter((e) => e.t === 'exp').map((e) => e.pct)),
  );
  check(
    js(trip.filter((e) => e.t === 'view').map((e) => e.v)) === js([false, true]),
    'viewable trace across the trip is exactly true→false→true — post-establish deltas [false,true]',
  );
  // _closed never latched: pinned observably — a latched _closed would force
  // getState() 'hidden' and isViewable() false above, and would kill the
  // expand below (post-close EV/requests are dead per D5).

  // Ad still interactive after return: the creative-initiated expand flow
  // works end-to-end (request → placementChange settles → 'expanded').
  h.mraid.expand();
  check(
    h.placementRequests.length === 1 && h.placementRequests[0].intent === 'expand',
    'expand() after return still issues requestPlacementChange({intent:"expand"})',
  );
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 1024, height: 768 } });
  await tick();
  check(h.mraid.getState() === 'expanded', 'expand settles: getState() === "expanded" — ad fully interactive after the round trip');
  check(
    js(traceFrom(tripMark).filter((e) => e.t === 'state').map((e) => e.v)) === js(['expanded']),
    'the ONLY stateChange after establish is the post-return "expanded" (no hidden/default churn from the trip)',
  );
}

// ── D9 — CR-1: pre-ready latch is not resurrected by the ready burst ─────────
// Ratified 2026-07-04 (review round, CR-1): a close/terminate delivered BEFORE
// onReady latches `_closed` and emits the terminal teardown at latch time
// (stateChange('hidden') + the final exposureChange(0); no viewableChange —
// viewable was never true pre-ready). The later S1/S2 ready burst and its EV
// tail must then emit ZERO state/viewable/exposure events: the burst's
// 'default' seed must not resurrect the latched 'hidden', and the EV replay
// cached at install-time subscribe must never be applied.
{
  console.log('D9 — CR-1 pre-ready latch: ready burst + tail emit zero state/view/exposure:');
  const latchPaths = [
    ['close', (h) => h.driveClose()],
    ['terminated', (h) => h.driveState('terminated')],
  ];
  for (const [label, latch] of latchPaths) {
    const h = await makeBridge({ seedEV: ev(100, null) }); // EV replay cached pre-ready
    latch(h);
    check(
      js(h.trace.filter((e) => e.t === 'state').map((e) => e.v)) === js(['hidden']),
      `[${label} pre-ready] latch-time emits the terminal stateChange("hidden") exactly once`,
    );
    check(
      js(h.trace.filter((e) => e.t === 'exp').map((e) => e.pct)) === js([0]),
      `[${label} pre-ready] latch-time emits the final exposureChange(0) exactly once`,
    );
    check(
      h.trace.filter((e) => e.t === 'view').length === 0,
      `[${label} pre-ready] no viewableChange at latch (viewable was never true)`,
    );
    const burstMark = h.trace.length;
    h.fireReady();
    await tick();
    const burst = h.since(burstMark);
    check(
      burst.filter((e) => e.t === 'state' || e.t === 'view' || e.t === 'exp').length === 0,
      `[${label} pre-ready] ready burst + tail emitted ZERO state/viewable/exposure (RED: burst seeds 'default' and the tail applies the cached EV today) (got ${js(burst)})`,
    );
    check(h.mraid.getState() === 'hidden', `[${label} pre-ready] getState() === "hidden" after ready`);
    check(h.mraid.isViewable() === false, `[${label} pre-ready] isViewable() === false after ready`);
    const postMark = h.trace.length;
    h.driveEV(ev(100, null)); // straggler live EV after ready — still dead
    check(
      h.since(postMark).length === 0,
      `[${label} pre-ready] post-ready EV delivery still emits NOTHING (no resurrection)`,
    );
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} Slice D MRAID re-point assertion(s) failed (RED expected until develop lands the re-point).`);
  process.exit(1);
}
console.log('\n✓ All Slice D MRAID re-point assertions passed.');
