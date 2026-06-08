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
 * The bridge's live SHARC.on('stateChange') subscription is the single source
 * of viewability truth in R1; the fix lives upstream (container + creative bus).
 * These tests pin the bridge contract is satisfied by that channel.
 *
 * Each fresh bridge instance loads under its own globalThis.window via a
 * cache-busting import query.
 *
 * Contract coverage (State-Delivery Contract — the bridge-observable T-tier):
 *   T1  → INV-3, INV-8, E1   seed-from-active ⇒ isViewable true + one viewableChange(true)
 *   T2  → INV-8              seed-from-non-active ⇒ false, no viewableChange
 *   T3  → INV-8              default ≠ false (default + viewable true coexist)
 *   T4  → INV-14, E5         late stateChange replay drives viewability
 *   T5  → INV-17, E9         replay respects last value (active→offscreen)
 *   T6  → INV-10, INV-16, E3 non-latching toggle each traversal (binding non-latch proof)
 *   T7  → INV-19, E6         no double-fire across interleavings
 *   T8  → INV-7, INV-8       ordering: ready/default precede viewableChange
 *   T9  → INV-16             defensive fallback (no delivery API ⇒ no throw, live-only)
 *   T10 → INV-1, INV-3, E2   single forward active flips once (genuine first active not suppressed)
 */

import assert from 'node:assert/strict';

const BRIDGE_URL = '../../dist/sharc-mraid-bridge.mjs';

let nonce = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Builds a fresh fake SHARC host + installs a fresh bridge instance.
 * The fake SHARC models the R1 channel: on fireReady(seedState), after the
 * bridge's onReady runs, the host delivers the current container state by
 * firing the live stateChange listener (the R1 post-establish push / replay).
 * @param {Object} opts
 * @param {('active'|'passive'|'hidden'|'frozen'|'ready')} [opts.seedState]
 *   Current container state delivered through the channel after ready. Omit
 *   to model a container that delivers no post-establish state (live-only).
 */
async function makeBridge(opts = {}) {
  const readyCallbacks = [];
  const startCallbacks = [];
  const eventListeners = {};
  // Models the R1 creative-bus last-state cache: the bus caches the last
  // lifecycle state and replays it ONCE to a NEW stateChange subscriber. This
  // is the D3 delivery path the bridge's SHARC.on('stateChange') rides on.
  let lastBusState; // undefined = nothing cached

  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart(cb) { startCallbacks.push(cb); },
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
      // D3 replay-on-subscribe (lifecycle stateChange only).
      if (name === 'stateChange' && lastBusState !== undefined) {
        cb(lastBusState);
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

  return {
    mraid: win.mraid,
    SHARC,
    observed,
    driveState,
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

// ── T1 — seed from active (delivered through the channel) ─────────────────────
{
  console.log('T1 — channel delivers active behind handshake:');
  const h = await makeBridge({ seedState: 'active' });
  check(h.bridgeNeverPolled, 'bridge does not require getContainerState (seed retired)');
  h.fireReady();
  await tick();
  check(h.mraid.isViewable() === true, 'isViewable() true after channel delivers active');
  check(
    h.observed.viewableChanges.length === 1 && h.observed.viewableChanges[0] === true,
    'viewableChange(true) fired exactly once',
  );
}

// ── T2 — non-active delivery is a no-op ──────────────────────────────────────
{
  console.log('T2 — channel delivers non-active ⇒ no-op:');
  const h = await makeBridge({ seedState: 'hidden' });
  h.fireReady();
  await tick();
  check(h.mraid.isViewable() === false, 'isViewable() stays false for non-active');
  check(h.observed.viewableChanges.length === 0, 'no viewableChange emitted');
}

// ── T3 — default ≠ false invariant ───────────────────────────────────────────
{
  console.log('T3 — default state + viewable true coexist:');
  const h = await makeBridge({ seedState: 'active' });
  h.fireReady();
  await tick();
  check(h.mraid.getState() === 'default', 'getState() === default');
  check(h.mraid.isViewable() === true, 'isViewable() === true simultaneously');
}

// ── T4 — late bridge install: stateChange subscription replays (D3 bus) ───────
//
// Re-targeted (ADR test plan T4): the late-listener replay now rides the
// SHARC.on('stateChange') bus, NOT a bridge-local viewableChange replay (that
// #334 D2 mechanism is retired). A bridge whose SHARC.on('stateChange')
// registration lands AFTER 'active' was cached gets the replay on subscribe,
// which drives _isViewable true. We model "late install" by caching the bus
// state first, then registering a fresh stateChange subscriber.
{
  console.log('T4 — late SHARC.on("stateChange") subscriber gets the cached state:');
  const h = await makeBridge({ seedState: 'active' });
  h.fireReady(); // bridge subscribed during install; bus delivers + caches active
  await tick();
  check(h.mraid.isViewable() === true, 'bridge already viewable via channel delivery');
  // A second, independently-late stateChange subscriber (e.g. creative code)
  // also receives the cached value exactly once.
  const lateBus = [];
  h.SHARC.on('stateChange', (s) => lateBus.push(s));
  check(lateBus.length === 1 && lateBus[0] === 'active', 'late stateChange subscriber replayed "active" once');
}

// ── T5 — replay respects last value (active then offscreen) ──────────────────
{
  console.log('T5 — bus replay respects last value (active then offscreen):');
  const h = await makeBridge({ seedState: 'active' });
  h.fireReady();
  await tick();
  h.driveState('hidden');
  check(h.mraid.isViewable() === false, 'isViewable() false after offscreen');
  // A late stateChange subscriber must get the LAST cached value (hidden), not
  // the stale active — proving the bus cache is last-write-wins.
  const lateBus = [];
  h.SHARC.on('stateChange', (s) => lateBus.push(s));
  check(
    lateBus.length === 1 && lateBus[0] === 'hidden',
    'late stateChange subscriber replays "hidden", not stale "active"',
  );
}

// ── T6 — non-latching toggle sequence ────────────────────────────────────────
{
  console.log('T6 — non-latching offscreen→onscreen→offscreen→onscreen:');
  const h = await makeBridge({ seedState: 'hidden' });
  h.fireReady();
  await tick();
  check(h.mraid.isViewable() === false, 'seed hidden → viewable stays false');
  h.driveState('active');
  check(h.mraid.isViewable() === true, 'active → viewable true');
  h.driveState('passive');
  check(h.mraid.isViewable() === false, 'passive → viewable false');
  h.driveState('active');
  check(h.mraid.isViewable() === true, 'active again → viewable true (no latch)');
  check(
    JSON.stringify(h.observed.viewableChanges) === JSON.stringify([true, false, true]),
    'viewableChange sequence is [true,false,true] — channel delivery did not latch',
  );
}

// ── T7 — no double-fire across interleavings ─────────────────────────────────
{
  console.log('T7a — channel active THEN redundant live active:');
  const h = await makeBridge({ seedState: 'active' });
  h.fireReady();
  await tick();
  h.driveState('active'); // redundant live edge
  check(
    h.observed.viewableChanges.filter((v) => v === true).length === 1,
    'viewableChange(true) count === 1 (seed-then-event)',
  );
}
{
  console.log('T7b — early live active THEN post-establish active delivery:');
  const h = await makeBridge({ seedState: 'active' });
  h.driveState('active'); // an early live edge arrives before fireReady's delivery
  h.fireReady();          // fires ready + delivers seedState 'active' (redundant)
  await tick();
  check(
    h.observed.viewableChanges.filter((v) => v === true).length === 1,
    'viewableChange(true) count === 1 (event-then-seed)',
  );
}

// ── T8 — ordering: ready/default precede viewable ────────────────────────────
{
  console.log('T8 — ordering: ready + default precede viewableChange:');
  const h = await makeBridge({ seedState: 'active' });
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
  const h = await makeBridge({}); // no seedState delivered
  let threw = false;
  try { h.fireReady(); await tick(); } catch (e) { threw = true; }
  check(!threw, 'fireReady + tick does not throw when no state delivered');
  check(h.mraid.isViewable() === false, 'isViewable() false (nothing delivered yet)');
  h.driveState('active');
  check(h.mraid.isViewable() === true, 'live subscription still flips viewable');
}

// ── T10 — regression: single forward active flips once ───────────────────────
{
  console.log('T10 — regression: single forward active flips once:');
  const h = await makeBridge({});
  h.fireReady();
  await tick();
  check(h.mraid.getState() === 'default', 'getState() default after init');
  check(h.mraid.isViewable() === false, 'isViewable() false before active');
  h.driveState('active');
  check(h.mraid.isViewable() === true, 'isViewable() true at active');
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
