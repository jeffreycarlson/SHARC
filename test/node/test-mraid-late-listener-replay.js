/**
 * test-mraid-late-listener-replay.js — Slice E1: MRAID `addEventListener`
 * late-listener replay (#388, #389 remainder).
 *
 * The prior bridge's `addEventListener` was a PURE push: a listener attached
 * after `ready`/`stateChange`/`error` had already fired never learned the
 * current state, violating MRAID 3.0's initial-state-on-subscribe expectation
 * (the same mandate Slice C honored for effectiveVisibilityChange on the
 * creative bus). Slice B's replay lives on the creative bus (`SHARC.onReady`),
 * NOT on this MRAID `mraid.addEventListener` surface.
 *
 * Contract under test (scoping 2026-07-04-slice-e-conformance-scoping.md, E1;
 * issues #388/#389), mirroring the `sharc-creative.js` on() replay precedent
 * (_lastContainerState / _lastEffectiveVisibility):
 *   R1  READY (#388): a listener attached AFTER `ready` fired is replayed
 *       `ready` once (no-arg) on registration.
 *   R2  STATECHANGE (#388): a listener attached after a state settled gets the
 *       current MRAID state (`_lastMraidState`) once on registration.
 *   R3  ERROR (#389 remainder): after a rejected expand/resize fired `error`,
 *       a listener attached later is replayed the LAST error (msg, action)
 *       once — the error must be deliverable to a late listener via the same
 *       replay mechanism ("the emit must happen + be replayable per the
 *       late-listener mechanism"). Last-error latch, mirroring the stateChange
 *       last-value cache.
 *   R4  REENTRANCY: a listener that registers ANOTHER listener during its own
 *       replay callback does not double-fire or corrupt iteration — replay
 *       iterates/dispatches against a snapshot (mirrors _emit's `.slice()`).
 *   R5  NEGATIVE PINS:
 *       (a) a listener attached BEFORE the event still fires live exactly once
 *           (no extra fire via replay — replay is only for the late attacher);
 *       (b) replay is once-per-registration: a late attacher replayed on
 *           registration does NOT re-fire on that same registration, and a
 *           subsequent LIVE event still reaches it exactly once (normal live
 *           delivery, not a second replay);
 *       (c) a gate that has NOT fired yet does not replay (no spurious
 *           invocation for events that never happened).
 *
 * Harness mirrors test-mraid-lifecycle-binding.js: a fresh fake SHARC host + a
 * fresh bridge instance per case from the built bundle under its own
 * globalThis.window via a cache-busting import query. Every assertion drives
 * the real `mraid.addEventListener` path — no vacuous checks.
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

async function makeBridge(opts) {
  const readyCallbacks = [];
  const startCallbacks = [];
  const eventListeners = {};
  const rejectPlacement = opts && opts.rejectPlacement;

  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart(cb) { startCallbacks.push(cb); },
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
    },
    hasFeature() { return true; },
    requestNavigation() { return Promise.resolve(); },
    requestPlacementChange() {
      return rejectPlacement
        ? Promise.reject(new Error('Container declined expand'))
        : Promise.resolve();
    },
    requestClose() { return Promise.resolve(); },
  };

  globalThis.location = { protocol: 'http:', hostname: 'localhost' };
  globalThis.window = {
    __sharcMraidBridgeAutoInstall: true,
    SHARC,
    innerWidth: 375,
    innerHeight: 667,
    // Slice E3 (#392): the bridge anchors `ready` to document-load-complete. A
    // load-complete document is the fire-now condition, so the ready burst this
    // suite drives via Container:init fires as before — the E1 replay under test
    // still sees a fired gate. Exercises the real gate (readyState === 'complete').
    document: { readyState: 'complete' },
  };

  await import(`${BRIDGE_URL}?e1replay=${Date.now()}-${nonce++}`);

  const win = globalThis.window;

  return {
    mraid: win.mraid,
    win,
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
    driveState(state) { (eventListeners.stateChange || []).forEach((fn) => fn(state)); },
    driveEV(payload) { (eventListeners.effectiveVisibilityChange || []).forEach((fn) => fn(payload)); },
    drivePlacementChange(update) { (eventListeners.placementChange || []).forEach((fn) => fn(update)); },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-late-listener-replay.js — Slice E1 late-listener replay (#388/#389)\n');

// ── R1 — late `ready` attacher is replayed `ready` once ──────────────────────
{
  console.log('R1 — late ready listener replayed once (no-arg):');
  const h = await makeBridge();
  h.fireReady();
  await tick();

  let readyCalls = 0;
  let replayArgs = null;
  h.mraid.addEventListener('ready', (...args) => { readyCalls++; replayArgs = args; });

  check(readyCalls === 1, 'late ready listener fired exactly once on registration (got ' + readyCalls + ')');
  check(replayArgs != null && replayArgs.length === 0, 'ready replay carries no args (MRAID ready is no-arg)');
}

// ── R2 — late `stateChange` attacher gets the current state once ─────────────
{
  console.log('R2 — late stateChange listener gets current MRAID state once:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  // Settle a real state (default is the MRAID state after ready).
  const stateAtQuery = h.mraid.getState();

  let stateCalls = 0;
  let seenState = null;
  h.mraid.addEventListener('stateChange', (s) => { stateCalls++; seenState = s; });

  check(stateCalls === 1, 'late stateChange listener fired exactly once on registration (got ' + stateCalls + ')');
  check(seenState === stateAtQuery,
    'replayed state equals current getState() ("' + stateAtQuery + '", got "' + seenState + '")');
  check(seenState === 'default', 'replayed state is the settled "default" (got "' + seenState + '")');
}

// ── R3 — late `error` attacher is replayed the last error (#389) ─────────────
{
  console.log('R3 — late error listener replayed the last rejected-command error:');
  const h = await makeBridge({ rejectPlacement: true });
  h.fireReady();
  await tick();

  // A container-rejected expand fires `error` via the async .catch path. No
  // listener is attached at rejection time — the classic #389 hang scenario.
  h.mraid.expand();
  await tick();
  await tick();

  let errCalls = 0;
  let errArgs = null;
  h.mraid.addEventListener('error', (...args) => { errCalls++; errArgs = args; });

  check(errCalls === 1, 'late error listener fired exactly once on registration (got ' + errCalls + ')');
  check(errArgs != null && errArgs[0] === 'Container declined expand',
    'replayed error carries the rejection message (got ' + JSON.stringify(errArgs && errArgs[0]) + ')');
  check(errArgs != null && errArgs[1] === 'expand',
    'replayed error carries the action "expand" (got ' + JSON.stringify(errArgs && errArgs[1]) + ')');
}

// ── R4 — reentrancy: registering a listener during a replay callback is safe ─
{
  console.log('R4 — reentrant registration during replay does not double-fire or corrupt:');
  const h = await makeBridge();
  h.fireReady();
  await tick();

  let outerCalls = 0;
  let innerCalls = 0;
  const inner = () => { innerCalls++; };
  h.mraid.addEventListener('ready', () => {
    outerCalls++;
    // Register another listener from inside our own replay callback.
    h.mraid.addEventListener('ready', inner);
  });

  check(outerCalls === 1, 'outer late listener replayed exactly once (no double-fire from reentrancy) (got ' + outerCalls + ')');
  check(innerCalls === 1, 'inner listener registered during replay itself replays exactly once (got ' + innerCalls + ')');
}

// ── R5a — a listener attached BEFORE the event fires live exactly once ───────
{
  console.log('R5a — parse-time (pre-event) listener fires live once, no replay double-fire:');
  const h = await makeBridge();

  let readyCalls = 0;
  h.mraid.addEventListener('ready', () => { readyCalls++; });   // attached BEFORE ready

  h.fireReady();   // fires ready live
  await tick();

  check(readyCalls === 1, 'pre-event ready listener fired exactly once (live, no replay) (got ' + readyCalls + ')');
}

// ── R5b — replay is once-per-registration; a later LIVE event still delivers ─
{
  console.log('R5b — late attacher replays once, then still receives subsequent live events once:');
  const h = await makeBridge();
  h.fireReady();
  await tick();

  const states = [];
  h.mraid.addEventListener('stateChange', (s) => { states.push(s); });  // late → replay 'default'

  check(states.length === 1 && states[0] === 'default',
    'exactly one replay on registration ("default") (got ' + JSON.stringify(states) + ')');

  // A genuinely new live state must reach the same listener once — not a re-replay,
  // normal live delivery. expand → placementChange settles 'expanded'.
  h.mraid.setExpandProperties && h.mraid.setExpandProperties({ width: -1, height: -1 });
  h.mraid.expand();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 1024, height: 768 }, intent: 'expand' });
  await tick();

  check(states.length === 2 && states[1] === 'expanded',
    'subsequent live stateChange delivered exactly once ("expanded"), no re-replay (got ' + JSON.stringify(states) + ')');
}

// ── R5c — a gate that never fired does not replay ────────────────────────────
{
  console.log('R5c — no replay for gates that have not fired (pre-ready registration):');
  const h = await makeBridge();
  // Bridge installed but fireReady() NOT called — ready/stateChange never fired.

  let readyCalls = 0;
  let stateCalls = 0;
  let errCalls = 0;
  h.mraid.addEventListener('ready', () => { readyCalls++; });
  h.mraid.addEventListener('stateChange', () => { stateCalls++; });
  h.mraid.addEventListener('error', () => { errCalls++; });

  check(readyCalls === 0, 'no ready replay before ready fired (got ' + readyCalls + ')');
  check(stateCalls === 0, 'no stateChange replay before any state settled (got ' + stateCalls + ')');
  check(errCalls === 0, 'no error replay before any error fired (got ' + errCalls + ')');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} late-listener-replay assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All MRAID late-listener-replay assertions passed.');
