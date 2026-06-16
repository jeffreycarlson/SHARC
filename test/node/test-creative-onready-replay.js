/**
 * test-creative-onready-replay.js — Slice B RED tests.
 *
 * DESIGN-stage (red) deliverable for the ADR
 *   ~/Obsidian/dev-team/sharc/2026-06-13-sharc-unified-lifecycle-ordering.md
 *   §4 "onReady as a first-class replaying event", OR-1…OR-6, plus the
 *   wrapper-clobber footgun closure (§4.1 #1, L-7's node-expressible core).
 *
 * These tests express the CONTRACT and are EXPECTED TO FAIL against the
 * current code, where `SHARC.onReady` is a single-slot, last-wins setter
 * OUTSIDE the replaying event bus:
 *
 *     onReady(callback) { this._onReadyCallback = callback; return this; }
 *                                              // src/sharc-creative.js:466-469
 *
 * The replay machinery (`_lastContainerState` cache + replay-on-subscribe)
 * lives only in `on()`/`_emit()` (src/sharc-creative.js:512-528) for the
 * 'stateChange' event. Slice B promotes `onReady` to the same first-class,
 * multi-listener, replaying model — closing the wrapper-clobber footgun (a
 * creative calling `SHARC.onReady` silently overwriting the bridge's
 * handshake callback) and #388-at-source.
 *
 * This file MUST NOT be wired into `test:all:built` while red (it would red
 * CI). It runs via the gated `test:onready-replay` script and is listed in
 * INTENTIONALLY_UNWIRED in scripts/check-ci-test-all-built-parity.js so the
 * orphan-guard parity check tolerates it. The develop-to-green pass removes
 * the allowlist entry and wires it into the gate.
 *
 * Test shape mirrors test-creative-state-replay.js (the ratified stateChange
 * replay suite) — fresh jsdom window + a fresh SHARCCreative instance per
 * case (cache-busting import), inbound Container:init driven via _handleInit,
 * inbound Container:startCreative via _handleStartCreative, the same paths the
 * port message router uses past the session gate.
 *
 * Contract coverage:
 *   OR-1  multi-listener           two onReady callbacks BOTH fire
 *   OR-2  replay-last-once         late listener replayed once, synchronously;
 *                                  early listener fires once on init; none twice
 *   OR-3  per-session              fired-flag + cache reset on teardown;
 *                                  re-established session re-fires onReady
 *   OR-4  never precedes init      onReady never fires before Container:init
 *   OR-5  env honesty preserved    replayed env carries honest currentState
 *   OR-6  ordering vs onStart      onReady before onStart; onStart NOT replayed
 *   ★     footgun closure          bridge burstCb + creative creativeCb BOTH fire
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

  const protoMod = await import(`../../dist/sharc-protocol.mjs?onready=${Date.now()}-${nonce}`);
  dom.window.SHARC = dom.window.SHARC || {};
  dom.window.SHARC.Protocol = protoMod;
  const { ContainerMessages } = protoMod;

  await import(`../../dist/sharc-creative.mjs?onready=${Date.now()}-${nonce++}`);
  const SHARC = dom.window.SHARC;
  const instance = SHARC._instance;

  return {
    SHARC,
    instance,
    ContainerMessages,
    /**
     * Simulates an inbound Container:init that PASSED the session gate. This
     * is the live "onReady fires" moment (P5). The container's init message is
     * resolved/rejected by the creative; we pass a minimal stub `msg` with the
     * resolve/reject seam the handler uses, so the handler runs end-to-end.
     */
    driveInit(env = {}, features = []) {
      instance._handleInit({
        args: { environmentData: env, supportedFeatures: features },
        // minimal seam so _proto.resolve/reject in _handleInit don't throw
        sessionId: instance._proto.sessionId,
        messageId: 1,
        type: ContainerMessages.INIT,
      });
    },
    /** Simulates an inbound Container:startCreative (P6). */
    driveStart() {
      instance._handleStartCreative({
        args: {},
        sessionId: instance._proto.sessionId,
        messageId: 2,
        type: ContainerMessages.START_CREATIVE,
      });
    },
    /**
     * Models a session teardown + a fresh session establishment. Teardown
     * resets per-session protocol state (the existing INV-21 per-session reset
     * seam, src/sharc-protocol.js:605 `reset()`); re-establishment is a fresh
     * Container:init. OR-3 requires the onReady fired-flag + cached (env,
     * features) to be per-session: cleared on teardown, re-fired on the new
     * session's init.
     */
    teardownSession() {
      instance._proto.reset();
      instance._terminated = false;
      instance._proto._terminated = false;
    },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-creative-onready-replay.js — Slice B onReady first-class replaying event (RED)\n');

// ── OR-1 — multi-listener: TWO onReady callbacks BOTH fire ───────────────────
{
  console.log('OR-1 — two SHARC.onReady(...) registrations both fire on init:');
  const h = await makeCreative();
  const fired = [];
  h.SHARC.onReady(() => fired.push('A'));
  h.SHARC.onReady(() => fired.push('B'));
  h.driveInit({ currentState: 'ready' }, ['com.iabtechlab.sharc.audio']);
  check(
    fired.includes('A') && fired.includes('B'),
    'BOTH onReady listeners fired — expected multi-listener (OR-1); '
    + 'current single-slot setter at sharc-creative.js:466 keeps only the last, '
    + `so only "B" ran (saw: [${fired.join(', ')}])`,
  );
  check(
    fired.length === 2,
    'exactly two onReady fires (one per listener), no duplicates',
  );
}

// ── OR-2 — replay-last-once: late listener replayed once, synchronously ──────
{
  console.log('OR-2 — listener registered AFTER onReady fired is replayed once at registration:');
  const h = await makeCreative();
  const early = [];
  h.SHARC.onReady((env, features) => early.push({ env, features }));
  h.driveInit({ currentState: 'ready' }, ['feat.a']); // onReady fires here (P5)
  check(early.length === 1, 'early listener fired exactly once when init resolved');

  const late = [];
  h.SHARC.onReady((env, features) => late.push({ env, features }));
  check(
    late.length === 1,
    'late listener replayed exactly once SYNCHRONOUSLY at registration (OR-2 / '
    + 'INV-14 analogue) — current code has no onReady replay cache, so a late '
    + `registrant gets nothing (saw ${late.length} fire(s))`,
  );
  check(
    late.length === 1 && late[0].env && late[0].env.currentState === 'ready',
    'replayed env carries the cached (env, features) from init',
  );

  console.log('OR-2b — no listener fires twice (INV-19 analogue):');
  check(
    early.length === 1,
    'the early listener did NOT fire a second time when the late one replayed',
  );
}

// ── OR-3 — per-session: fired-flag + cache reset on teardown; re-fire ────────
//
// Discriminating observable (the part that is BROKEN today): the per-session
// CACHE. A late listener registered after a session's init must replay THAT
// session's cached (env, features). Across a teardown + re-establish, the
// cache must reflect the NEW session (active), not the torn-down one (ready),
// and not be empty. Current code has no onReady cache at all, so a late
// listener in EITHER session gets nothing → RED. (A bare "live re-fire to an
// already-registered listener" assertion would NOT discriminate: the single-
// slot setter trivially re-fires its retained callback on every _handleInit
// regardless of session, so it would pass against the broken code — that is
// why this case asserts the replay/cache dimension, not the live re-fire.)
{
  console.log('OR-3 — onReady cached (env,features) is per-session (reset on teardown, re-seeded on re-init):');
  const h = await makeCreative();
  h.SHARC.onReady(() => {}); // an early listener so a session-1 fire is observable
  h.driveInit({ currentState: 'ready' }, []); // session 1: fire + seed cache

  const lateS1 = [];
  h.SHARC.onReady((env) => lateS1.push(env && env.currentState));
  check(
    lateS1.length === 1 && lateS1[0] === 'ready',
    'session 1: a late onReady listener replays session-1 cached env "ready" (OR-3) — '
    + 'current code has no onReady cache, so a late listener gets nothing '
    + `(saw: [${lateS1.join(', ')}])`,
  );

  h.teardownSession(); // per-session reset (INV-21 analogue) — cache MUST clear

  // A listener registered after teardown but BEFORE the new session's init must
  // NOT replay the torn-down session's cached env (cache cleared on teardown).
  const betweenSessions = [];
  h.SHARC.onReady((env) => betweenSessions.push(env && env.currentState));
  check(
    betweenSessions.length === 0,
    'between sessions (after teardown, before re-init): NO replay of the '
    + `torn-down session’s cached "ready" (cache cleared on teardown, OR-3) (saw: [${betweenSessions.join(', ')}])`,
  );

  h.driveInit({ currentState: 'active' }, []); // session 2: re-fire + re-seed cache

  const lateS2 = [];
  h.SHARC.onReady((env) => lateS2.push(env && env.currentState));
  check(
    lateS2.length === 1 && lateS2[0] === 'active',
    'session 2: a late onReady listener replays the NEW session’s cached env '
    + '"active", NOT the stale "ready" and NOT empty (OR-3, per-session cache) — '
    + `(saw: [${lateS2.join(', ')}])`,
  );
}

// ── OR-4 — never precedes Container:init ─────────────────────────────────────
{
  console.log('OR-4 — onReady MUST NOT fire before Container:init is received:');
  const h = await makeCreative();
  const fired = [];
  h.SHARC.onReady(() => fired.push('early'));
  // No driveInit yet — registration alone must not fire (the cached state is
  // seeded FROM init; before init there is no env to replay).
  check(
    fired.length === 0,
    'onReady did NOT fire on registration before any Container:init (OR-4) — '
    + `no premature fire/replay (saw: [${fired.join(', ')}])`,
  );

  console.log('OR-4b — a SECOND late registration before init also does not fire prematurely:');
  const late = [];
  h.SHARC.onReady(() => late.push('late'));
  check(
    late.length === 0,
    'a listener registered before init is not replayed (nothing cached yet, OR-4)',
  );

  console.log('OR-4c — once init arrives, both pre-init listeners fire (and only then):');
  h.driveInit({ currentState: 'ready' }, []);
  check(
    fired.length === 1 && late.length === 1,
    'both pre-init onReady listeners fired exactly once when init finally arrived '
    + '(OR-1 + OR-4: deferred until init, then both run)',
  );
}

// ── OR-5 — env honesty preserved on replay ───────────────────────────────────
{
  console.log('OR-5 — replayed env carries the honest currentState (INV-6), not a stale default:');
  const h = await makeCreative();
  h.SHARC.onReady(() => {}); // early listener
  // Container:init with an HONEST non-'ready' currentState (D2 sends the real
  // queryable state — e.g. the ad established 'active' while it was already
  // visible). The live fire and any replay MUST carry this exact value.
  h.driveInit({ currentState: 'active' }, []);

  const late = [];
  h.SHARC.onReady((env) => late.push(env && env.currentState));
  check(
    late.length === 1 && late[0] === 'active',
    'late onReady listener replayed the HONEST currentState "active" (OR-5 / '
    + 'INV-6) — a bridge seeding its cache from env.currentState gets the real '
    + `state, not a stale "ready" (saw: [${late.join(', ')}], len ${late.length})`,
  );
}

// ── OR-6 — ordering vs onStart; onStart is NOT folded into replay ────────────
{
  console.log('OR-6 — onReady ⟶ onStart ordering preserved:');
  const h = await makeCreative();
  const order = [];
  h.SHARC.onReady(() => order.push('ready'));
  h.SHARC.onStart(() => order.push('start'));
  h.driveInit({ currentState: 'ready' }, []); // P5
  h.driveStart(); // P6
  check(
    JSON.stringify(order) === JSON.stringify(['ready', 'start']),
    `onReady fired before onStart (HB-5/P5⟶P6) (saw: [${order.join(', ')}])`,
  );

  console.log('OR-6b — onStart is one-shot, NOT replayed: a late onStart listener is NOT invoked:');
  const lateStart = [];
  h.SHARC.onStart(() => lateStart.push('late-start'));
  check(
    lateStart.length === 0,
    'a late onStart listener registered AFTER startCreative fired is NOT replayed '
    + '(OR-6: onStart is a one-shot start signal, not a latching readiness state) — '
    + `(saw: [${lateStart.join(', ')}])`,
  );
}

// ── ★ Footgun closure — bridge burstCb + creative creativeCb BOTH fire ───────
{
  console.log('★ Footgun closure — creative onReady alongside the bridge’s onReady: BOTH fire:');
  const h = await makeCreative();
  const ran = [];
  // The renderer-provisioned bridge installs its handshake burst via onReady
  // (e.g. sharc-mraid-bridge.js runs the S1→S2 burst inside its onReady).
  const burstCb = () => ran.push('bridge-burst');
  h.SHARC.onReady(burstCb);
  // The wrapped creative ALSO legitimately registers onReady. Today this
  // silently clobbers _onReadyCallback (last-wins), disabling the MRAID
  // handshake burst.
  const creativeCb = () => ran.push('creative');
  h.SHARC.onReady(creativeCb);

  h.driveInit({ currentState: 'ready' }, []);

  check(
    ran.includes('bridge-burst'),
    'the BRIDGE handshake burst onReady fired — NOT clobbered by the creative’s '
    + 'later onReady (the headline footgun) — current single-slot setter at '
    + `sharc-creative.js:466 silently overwrote it, so only the last ran (saw: [${ran.join(', ')}])`,
  );
  check(
    ran.includes('creative'),
    'the CREATIVE onReady also fired (both coexist as N listeners)',
  );
  check(
    JSON.stringify(ran) === JSON.stringify(['bridge-burst', 'creative']),
    'both fired in registration order (bridge installed first, creative second)',
  );
}

if (failures > 0) {
  console.error(`\n✗ ${failures} onReady-replay assertion(s) failed (EXPECTED RED at design stage).`);
  process.exit(1);
}
console.log('\n✓ All onReady-replay assertions passed.');
