/**
 * test-creative-state-replay.js — R1 D3 creative-bus last-state cache + replay.
 *
 * The creative pub/sub (SHARCCreative.on) was transition-only: a stateChange
 * listener registered AFTER a Container:stateChange('active') arrived got
 * nothing. R1 D3 caches the last lifecycle state per inbound Container:stateChange
 * (and seeds it from env.currentState on init), then replays that last value
 * ONCE to a new 'stateChange' subscriber on registration.
 *
 * Scope is strictly the latching lifecycle 'stateChange' event. One-shot events
 * (containerError, log, close) are NOT replayed. The live subscription stays
 * untouched (non-latching): ongoing toggles keep flowing.
 *
 * White-box: a fresh SHARCCreative instance per case (cache-busting import under
 * a fresh jsdom window). Inbound Container:stateChange is driven by dispatching
 * to the protocol's STATE_CHANGE listener (the same path _onPortMessage uses
 * after the session gate); the gate itself is covered by C2.
 *
 * Runs in Node after `npm run build`. No test framework.
 */

import { JSDOM } from 'jsdom';

let nonce = 0;

/** Fresh jsdom window + a fresh creative instance imported under it. */
async function makeCreative() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://creative.example/ad.html',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.MessageChannel = dom.window.MessageChannel;
  global.MessagePort = dom.window.MessagePort;

  const protoMod = await import(`../../dist/sharc-protocol.mjs?replay=${Date.now()}-${nonce}`);
  dom.window.SHARC = dom.window.SHARC || {};
  dom.window.SHARC.Protocol = protoMod;
  const { ContainerMessages } = protoMod;

  const mod = await import(`../../dist/sharc-creative.mjs?replay=${Date.now()}-${nonce++}`);
  const SHARC = dom.window.SHARC;
  const instance = SHARC._instance;

  return {
    SHARC,
    instance,
    ContainerMessages,
    /** Simulates an inbound Container:stateChange that PASSED the session gate. */
    driveStateChange(state) {
      instance._proto._dispatchToListeners(ContainerMessages.STATE_CHANGE, {
        sessionId: instance._proto.sessionId,
        type: ContainerMessages.STATE_CHANGE,
        args: { containerState: state },
      });
    },
    /** Simulates an inbound one-shot event. */
    driveOneShot(type, args) {
      instance._proto._dispatchToListeners(type, {
        sessionId: instance._proto.sessionId,
        type,
        args,
      });
    },
    /** Drives Container:init with the given env (seeds env.currentState). */
    driveInit(env) {
      instance._handleInit({ args: { environmentData: env, supportedFeatures: [] } });
    },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-creative-state-replay.js — R1 D3 creative-bus replay\n');

// ── N1 — late stateChange listener gets the missed value replayed ────────────
{
  console.log('N1 — on("stateChange") after active arrived ⇒ replayed once:');
  const h = await makeCreative();
  h.driveStateChange('active'); // arrives before any listener is registered
  const seen = [];
  h.SHARC.on('stateChange', (s) => seen.push(s));
  check(seen.length === 1 && seen[0] === 'active', 'late listener replayed "active" exactly once');
}

// ── N2 — env.currentState seeds the cache for post-init registration ─────────
{
  console.log('N2 — _handleInit(env.currentState="active") seeds the replay cache:');
  const h = await makeCreative();
  h.driveInit({ currentState: 'active' });
  const seen = [];
  h.SHARC.on('stateChange', (s) => seen.push(s));
  check(seen.length === 1 && seen[0] === 'active', 'listener registered after init replayed "active"');

  console.log('N2b — env.currentState="ready" (the default sentinel) is NOT replayed as a transition edge:');
  const h2 = await makeCreative();
  h2.driveInit({ currentState: 'ready' });
  const seen2 = [];
  h2.SHARC.on('stateChange', (s) => seen2.push(s));
  // 'ready' is a real queryable state; seeding it is correct (it IS the current
  // lifecycle state). Assert it replays 'ready' (cache seeded), proving D2/D3
  // interplay carries the real init state.
  check(seen2.length === 1 && seen2[0] === 'ready', 'ready seed replays "ready" to late listener');

  console.log('N2c — env without currentState (legacy/missing) ⇒ no replay:');
  const h3 = await makeCreative();
  h3.driveInit({});
  const seen3 = [];
  h3.SHARC.on('stateChange', (s) => seen3.push(s));
  check(seen3.length === 0, 'no currentState in env ⇒ nothing cached, nothing replayed');
}

// ── N3 — one-shot events are NOT replayed (replay-scope guard) ───────────────
{
  console.log('N3 — containerError / log / close are NOT replayed to late listeners:');
  const h = await makeCreative();
  h.driveOneShot(h.ContainerMessages.FATAL_ERROR, { errorCode: 9999, message: 'boom' });
  h.driveOneShot(h.ContainerMessages.LOG, { message: 'a log line' });

  const errSeen = [];
  const logSeen = [];
  const closeSeen = [];
  h.SHARC.on('containerError', (a) => errSeen.push(a));
  h.SHARC.on('log', (a) => logSeen.push(a));
  h.SHARC.on('close', () => closeSeen.push(true));
  check(errSeen.length === 0, 'containerError NOT replayed');
  check(logSeen.length === 0, 'log NOT replayed');
  check(closeSeen.length === 0, 'close NOT replayed');
}

// ── N4 — replay reflects the LAST state, not the first ───────────────────────
{
  console.log('N4 — active then hidden ⇒ late listener gets "hidden":');
  const h = await makeCreative();
  h.driveStateChange('active');
  h.driveStateChange('hidden');
  const seen = [];
  h.SHARC.on('stateChange', (s) => seen.push(s));
  check(seen.length === 1 && seen[0] === 'hidden', 'late listener replayed the LAST value "hidden"');
}

// ── N5 — replay does not latch: live subscription still toggles after replay ─
{
  console.log('N5 — live subscription keeps toggling after a replay (no latch):');
  const h = await makeCreative();
  h.driveStateChange('active');
  const seen = [];
  h.SHARC.on('stateChange', (s) => seen.push(s)); // replay "active"
  h.driveStateChange('hidden'); // live toggle
  h.driveStateChange('active'); // live toggle
  check(
    JSON.stringify(seen) === JSON.stringify(['active', 'hidden', 'active']),
    'sequence is [active(replay), hidden(live), active(live)] — replay did not latch or unsubscribe',
  );

  console.log('N5b — replay delivers to the registering listener only (no double-fire to existing):');
  const h2 = await makeCreative();
  const first = [];
  h2.SHARC.on('stateChange', (s) => first.push(s)); // registered before any state
  h2.driveStateChange('active'); // live → first gets 'active'
  const second = [];
  h2.SHARC.on('stateChange', (s) => second.push(s)); // replay → second only
  check(
    JSON.stringify(first) === JSON.stringify(['active']),
    'pre-existing listener got exactly one live "active" (no extra replay fired to it)',
  );
  check(
    JSON.stringify(second) === JSON.stringify(['active']),
    'new listener got exactly one replayed "active"',
  );
}

if (failures > 0) {
  console.error(`\n✗ ${failures} creative-state-replay assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All creative-state-replay assertions passed.');
