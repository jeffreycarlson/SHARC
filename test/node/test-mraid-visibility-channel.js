/**
 * test-mraid-visibility-channel.js — MRAID bridge visibility via the R1 channel.
 *
 * TRANSFERRED from #334's test-mraid-visibility-seed.js (commit 2045117) and
 * RE-TARGETED to R1. The bridge's OBSERVABLE contract is unchanged: installed
 * behind an already-ACTIVE container ⇒ isViewable()===true + one
 * viewableChange(true); non-latching toggles keep flowing; late
 * addEventListener('viewableChange') replays.
 *
 * What changed is the DELIVERY PATH. #334 seeded the bridge via a
 * bridge-local SHARC.getContainerState() round-trip. R1 RETIRES that seed: the
 * container delivers the current lifecycle state through the channel itself —
 * SHARC.on('stateChange') fires (the R1 container post-establish push + the
 * creative-bus replay to the bridge's late stateChange subscription). So the
 * fake SHARC here delivers the seed by FIRING the live stateChange listener
 * after onReady (the channel), NOT via getContainerState. There is no
 * getContainerState in the R1 build — the bridge never polls.
 *
 * SLICE D RE-TARGET (ADR 2026-07-04, Δ1/Δ4): viewability now rides the
 * effective-visibility surface (`SHARC.on('effectiveVisibilityChange')` →
 * {effectivePercent, reason, visibleRectangle}); the lifecycle enum is axis-1
 * bookkeeping only. The T-tier's protective intents are unchanged — the DRIVE
 * mechanism is re-targeted to the EV channel (with the same bus replay-of-last
 * on subscribe, Slice C F4), and each case additionally pins that a state-only
 * drive produces NO viewableChange.
 *
 * Each fresh bridge instance loads under its own globalThis.window via a
 * cache-busting import query.
 *
 * Contract coverage (State-Delivery Contract — the bridge-observable T-tier):
 *   T1  → INV-3, INV-8, E1   seed-from-visible EV ⇒ isViewable true + one viewableChange(true)
 *   T2  → INV-8              seed-from-non-visible EV ⇒ false, no viewableChange
 *   T3  → INV-8              default ≠ false (default + viewable true coexist)
 *   T4  → INV-14, E5         late-subscriber bus replay (state + EV) drives viewability
 *   T5  → INV-17, E9         replay respects last value (visible→offscreen)
 *   T6  → INV-10, INV-16, E3 non-latching toggle each traversal (binding non-latch proof)
 *   T7  → INV-19, E6         no double-fire across interleavings
 *   T8  → INV-7, INV-8       ordering: ready/default precede viewableChange
 *   T9  → INV-16             defensive fallback (no delivery ⇒ no throw, live-only)
 *   T10 → INV-1, INV-3, E2   single forward visible EV flips once (genuine first crossing not suppressed)
 */

const BRIDGE_URL = '../../dist/sharc-mraid-bridge.mjs';

let nonce = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Builds the composed EV payload exactly as the container wire carries it. */
function ev(effectivePercent, reason) {
  return { effectivePercent, reason: reason === undefined ? null : reason, visibleRectangle: null };
}

/**
 * Builds a fresh fake SHARC host + installs a fresh bridge instance.
 * The fake SHARC models the R1 channel: on fireReady(seedState), after the
 * bridge's onReady runs, the host delivers the current container state by
 * firing the live stateChange listener (the R1 post-establish push / replay).
 * @param {Object} opts
 * @param {('active'|'passive'|'hidden'|'frozen'|'ready')} [opts.seedState]
 *   Current container state delivered through the channel after ready. Omit
 *   to model a container that delivers no post-establish state (live-only).
 * @param {Object} [opts.seedEV]
 *   Effective-visibility payload cached on the bus BEFORE the bridge installs
 *   (Slice C F4 replay-of-last at subscribe — precedes onReady; the bridge
 *   ready-gates and applies it once after the S1/S2 burst).
 */
async function makeBridge(opts = {}) {
  const readyCallbacks = [];
  const startCallbacks = [];
  const eventListeners = {};
  // Models the R1 creative-bus last-value caches: the bus caches the last
  // lifecycle state AND the last effective-visibility payload, replaying each
  // ONCE to a NEW subscriber (R1 D3 + Slice C F4).
  let lastBusState; // undefined = nothing cached
  let lastBusEV = opts.seedEV; // undefined = nothing cached

  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart(cb) { startCallbacks.push(cb); },
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
      // Replay-on-subscribe for both latching value events.
      if (name === 'stateChange' && lastBusState !== undefined) {
        cb(lastBusState);
      }
      if (name === 'effectiveVisibilityChange' && lastBusEV !== undefined) {
        cb(lastBusEV);
      }
    },
    hasFeature() { return true; },
    requestNavigation() { return Promise.resolve(); },
    requestPlacementChange() { return Promise.resolve(); },
    requestClose() { return Promise.resolve(); },
  };
  // R1 retires the bridge-local seed: the bridge must NOT poll getContainerState.
  // Deliberately do not define SHARC.getContainerState here.

  globalThis.location = { protocol: 'http:', hostname: 'localhost' };
  globalThis.window = {
    __sharcMraidBridgeAutoInstall: true,
    SHARC,
  };

  await import(`${BRIDGE_URL}?channel=${Date.now()}-${nonce++}`);

  const win = globalThis.window;
  const observed = { ready: 0, stateChanges: [], viewableChanges: [] };
  win.mraid.addEventListener('ready', () => { observed.ready++; });
  win.mraid.addEventListener('stateChange', (s) => { observed.stateChanges.push(s); });
  win.mraid.addEventListener('viewableChange', (v) => { observed.viewableChanges.push(v); });

  const driveState = (state) => {
    lastBusState = state; // bus caches every live lifecycle state
    (eventListeners.stateChange || []).forEach((fn) => fn(state));
  };

  const driveEV = (payload) => {
    lastBusEV = payload; // bus caches every live EV payload
    (eventListeners.effectiveVisibilityChange || []).forEach((fn) => fn(payload));
  };

  return {
    mraid: win.mraid,
    SHARC,
    observed,
    driveState,
    driveEV,
    bridgeNeverPolled: typeof SHARC.getContainerState === 'undefined',
    /**
     * Fires SHARC.onReady (Container:init), then — if a seedState was given —
     * delivers it through the channel (R1 replay/push), exactly as the live
     * container would after the session is established.
     */
    fireReady(env) {
      readyCallbacks[0](env || {
        currentPlacement: { initialDefaultSize: { width: 320, height: 50 } },
        initialPosition: { x: 0, y: 0, width: 320, height: 50 },
        data: { placement: { instl: 0 }, app: { bundle: 'test-app' } },
      });
      if (opts.seedState !== undefined) {
        driveState(opts.seedState);
      }
    },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-visibility-channel.js — MRAID visibility via R1 channel (transferred T1–T10)\n');

// ── T1 — seed from visible EV (replayed through the channel) ──────────────────
{
  console.log('T1 — channel replays visible EV behind handshake:');
  const h = await makeBridge({ seedState: 'active', seedEV: ev(100, null) });
  check(h.bridgeNeverPolled, 'bridge does not require getContainerState (seed retired)');
  h.fireReady();
  await tick();
  check(h.mraid.isViewable() === true, 'isViewable() true after channel delivers EV {100}');
  check(
    h.observed.viewableChanges.length === 1 && h.observed.viewableChanges[0] === true,
    'viewableChange(true) fired exactly once',
  );
}

// ── T2 — non-visible delivery is a no-op ─────────────────────────────────────
{
  console.log('T2 — channel delivers non-visible EV ⇒ no-op:');
  const h = await makeBridge({ seedState: 'hidden', seedEV: ev(0, 'backgrounded') });
  h.fireReady();
  await tick();
  check(h.mraid.isViewable() === false, 'isViewable() stays false for EV {0}');
  check(h.observed.viewableChanges.length === 0, 'no viewableChange emitted');
}

// ── T3 — default ≠ false invariant ───────────────────────────────────────────
{
  console.log('T3 — default state + viewable true coexist:');
  const h = await makeBridge({ seedState: 'active', seedEV: ev(100, null) });
  h.fireReady();
  await tick();
  check(h.mraid.getState() === 'default', 'getState() === default');
  check(h.mraid.isViewable() === true, 'isViewable() === true simultaneously');
}

// ── T4 — late bridge install: bus subscriptions replay (D3 + F4) ──────────────
//
// The late-listener replay rides the SHARC bus caches: a subscriber landing
// AFTER a value was cached gets the replay on subscribe. Slice D: the bridge's
// viewability rides the EV replay; the stateChange replay stays for axis-1.
{
  console.log('T4 — late bus subscribers get the cached state AND EV payload:');
  const h = await makeBridge({ seedState: 'active', seedEV: ev(100, null) });
  h.fireReady(); // bridge subscribed during install; bus delivers + caches
  await tick();
  check(h.mraid.isViewable() === true, 'bridge already viewable via channel delivery');
  // A second, independently-late subscriber (e.g. creative code) also
  // receives each cached value exactly once.
  const lateBus = [];
  h.SHARC.on('stateChange', (s) => lateBus.push(s));
  check(lateBus.length === 1 && lateBus[0] === 'active', 'late stateChange subscriber replayed "active" once');
  const lateEV = [];
  h.SHARC.on('effectiveVisibilityChange', (p) => lateEV.push(p));
  check(
    lateEV.length === 1 && lateEV[0].effectivePercent === 100,
    'late effectiveVisibilityChange subscriber replayed {100} once',
  );
}

// ── T5 — replay respects last value (visible then offscreen) ─────────────────
{
  console.log('T5 — bus replay respects last value (visible then offscreen):');
  const h = await makeBridge({ seedState: 'active', seedEV: ev(100, null) });
  h.fireReady();
  await tick();
  h.driveState('hidden');            // axis-1 bookkeeping push
  h.driveEV(ev(0, 'backgrounded'));  // the composed surface flips viewability
  check(h.mraid.isViewable() === false, 'isViewable() false after EV {0}');
  // A late subscriber must get the LAST cached values, not the stale ones —
  // proving both bus caches are last-write-wins.
  const lateBus = [];
  h.SHARC.on('stateChange', (s) => lateBus.push(s));
  check(
    lateBus.length === 1 && lateBus[0] === 'hidden',
    'late stateChange subscriber replays "hidden", not stale "active"',
  );
  const lateEV = [];
  h.SHARC.on('effectiveVisibilityChange', (p) => lateEV.push(p));
  check(
    lateEV.length === 1 && lateEV[0].effectivePercent === 0,
    'late EV subscriber replays {0}, not stale {100}',
  );
}

// ── T6 — non-latching toggle sequence ────────────────────────────────────────
{
  console.log('T6 — non-latching offscreen→onscreen→offscreen→onscreen:');
  const h = await makeBridge({ seedState: 'hidden', seedEV: ev(0, 'backgrounded') });
  h.fireReady();
  await tick();
  check(h.mraid.isViewable() === false, 'seed EV {0} → viewable stays false');
  h.driveState('active');           // axis-1 establish — sets no viewability (Δ4)
  check(h.mraid.isViewable() === false, 'state-only "active" does NOT flip viewable (enum is not viewability)');
  h.driveEV(ev(100, null));
  check(h.mraid.isViewable() === true, 'EV {100} → viewable true');
  h.driveState('passive');          // state-only push mid-sequence — no effect
  h.driveEV(ev(30, 'offscreen'));
  check(h.mraid.isViewable() === false, 'EV {30} → viewable false (below the 50 crossing)');
  h.driveEV(ev(100, null));
  check(h.mraid.isViewable() === true, 'EV {100} again → viewable true (no latch)');
  check(
    JSON.stringify(h.observed.viewableChanges) === JSON.stringify([true, false, true]),
    'viewableChange sequence is [true,false,true] — EV drives only; state-only pushes contributed nothing',
  );
}

// ── T7 — no double-fire across interleavings ─────────────────────────────────
{
  console.log('T7a — channel EV replay THEN redundant live EV:');
  const h = await makeBridge({ seedState: 'active', seedEV: ev(100, null) });
  h.fireReady();
  await tick();
  h.driveState('active');   // redundant live enum edge — no viewability effect
  h.driveEV(ev(100, null)); // redundant live EV — deduped
  check(
    h.observed.viewableChanges.filter((v) => v === true).length === 1,
    'viewableChange(true) count === 1 (seed-then-event)',
  );
}
{
  console.log('T7b — early live EV THEN post-establish redundant delivery:');
  const h = await makeBridge({ seedState: 'active' });
  h.driveState('active');   // early live edges arrive before fireReady
  h.driveEV(ev(100, null)); // cached silently (ready-gated), applied after the burst
  h.fireReady();
  await tick();
  h.driveEV(ev(100, null)); // post-establish redundant delivery — deduped
  check(
    h.observed.viewableChanges.filter((v) => v === true).length === 1,
    'viewableChange(true) count === 1 (event-then-seed)',
  );
}

// ── T8 — ordering: ready/default precede viewable ────────────────────────────
{
  console.log('T8 — ordering: ready + default precede viewableChange:');
  const h = await makeBridge({ seedState: 'active', seedEV: ev(100, null) });
  const order = [];
  h.mraid.addEventListener('ready', () => order.push('ready'));
  h.mraid.addEventListener('stateChange', (s) => order.push('state:' + s));
  h.mraid.addEventListener('viewableChange', (v) => order.push('view:' + v));
  h.fireReady();
  await tick();
  const firstView = order.indexOf('view:true');
  check(firstView !== -1, 'viewableChange(true) eventually fired');
  check(order.indexOf('ready') !== -1 && order.indexOf('ready') < firstView, 'ready before viewable');
  check(
    order.indexOf('state:default') !== -1 && order.indexOf('state:default') < firstView,
    'stateChange:default before viewable',
  );
}

// ── T9 — defensive: no post-establish delivery ⇒ no throw, live-only ─────────
{
  console.log('T9 — no channel delivery after ready ⇒ no throw, live-only:');
  const h = await makeBridge({}); // nothing delivered
  let threw = false;
  try { h.fireReady(); await tick(); } catch (e) { threw = true; }
  check(!threw, 'fireReady + tick does not throw when nothing delivered');
  check(h.mraid.isViewable() === false, 'isViewable() false (nothing delivered yet)');
  h.driveState('active');
  check(h.mraid.isViewable() === false, 'state-only "active" still does not flip viewable');
  h.driveEV(ev(100, null));
  check(h.mraid.isViewable() === true, 'live EV subscription still flips viewable');
}

// ── T10 — regression: single forward visible EV flips once ───────────────────
{
  console.log('T10 — regression: single forward visible EV flips once:');
  const h = await makeBridge({});
  h.fireReady();
  await tick();
  check(h.mraid.getState() === 'default', 'getState() default after init');
  check(h.mraid.isViewable() === false, 'isViewable() false before any EV');
  h.driveState('active');
  h.driveEV(ev(100, null));
  check(h.mraid.isViewable() === true, 'isViewable() true at EV {100}');
  check(
    JSON.stringify(h.observed.viewableChanges) === JSON.stringify([true]),
    'viewableChange fired exactly once',
  );
}

if (failures > 0) {
  console.error(`\n✗ ${failures} visibility-channel assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All MRAID visibility-via-channel assertions passed.');
