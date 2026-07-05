/**
 * test-mraid-bridge-correctness-e2.js — Slice E2: MRAID-bridge correctness
 * trio (#390, #395, #394-trim) + the folded-in #414 fatal-terminate latch.
 *
 * Four independent bridge-local fixes, one labelled block each. Every
 * assertion drives a real `window.mraid` path against a freshly-imported
 * bridge instance from the built bundle (cache-busting import query) — no
 * vacuous checks (Slice C B.5 lesson; #390 is explicitly closing a
 * "no test caught it" coverage hole).
 *
 * ── A — #390 resync isAudioMuted on ACTIVE transition ────────────────────────
 *   Contract (issue #390 + docs/design/mraid-bridge-design.md §7.2, lines
 *   10/254/576): a creative preloaded in READY/HIDDEN must, on the ACTIVE
 *   transition, receive the CURRENT audio state. The container buffers
 *   READY/HIDDEN audio in environmentData and delivers it via _syncAudioState()
 *   on ACTIVE as an audioVolumeChange message (sharc-container.js:4457).
 *   `sendStateChange` carries ONLY the state string (sharc-protocol.js:889) —
 *   audio rides a SEPARATE message — so the bridge cannot pull a fresher mute
 *   value out of the `stateChange` payload. The design-doc promise is a
 *   RE-FIRE: on stateChange('active') the bridge re-emits the MRAID
 *   audioVolumeChange event from its own buffered audio, mirroring the
 *   container's _syncAudioState / _syncEffectiveVisibility / _syncPlacementState
 *   ACTIVE-transition re-push pattern. Observable: a creative that registered an
 *   audioVolumeChange listener during preload sees the current mute on ACTIVE.
 *   (The docstring at bridge isAudioMuted() FALSELY cited a bridge-side
 *   `_syncAudioState` that exists only in the container — corrected in the fix.)
 *
 * ── B — #395 getDefaultPosition() returns real captured x/y ──────────────────
 *   Contract (issue #395, §6.6): getDefaultPosition() must return the ad's real
 *   default position. The bridge already returns real w/h from
 *   currentPlacement.initialDefaultSize but hardcodes x:0, y:0 even though
 *   _initialPosition (x/y) is captured at onReady. Fix returns the captured x/y.
 *
 * ── C — #394-trim: open() type guard precedes .trim() ────────────────────────
 *   Contract (issue #394 part 1 ONLY — tel/sms scheme policy is E5, NOT here):
 *   open() calls url.trim() BEFORE the type guard, so open(null)/open(123)/
 *   open(undefined) throws a raw TypeError into creative code. Guard the type
 *   first; a non-string url is a clean reject (fire the `error` event, now
 *   replayable via E1), never a thrown TypeError. A valid string still works.
 *
 * ── D — #414 fatal-terminate must latch _closed (E-3-constrained) ────────────
 *   Contract (issue #414, ratified E-3): the wire's terminal signal on a
 *   container fatal error is delivered creative-side as `containerError`
 *   (sharc-creative.js:339). Post-Slice-D the bridge stopped treating wire
 *   'hidden' as terminal (Δ5), and 'terminated' never rides the wire (INV-12),
 *   so on a container fatal error `getState()` reads 'default' and isViewable()
 *   holds the last EV for the ≤1s teardown window — _closed never latches.
 *   Fix routes the fatal signal through the EXISTING _latchClosed() helper (a
 *   one-line SHARC.on('containerError', _latchClosed) subscription) — NO third
 *   `_closed` set site (E-3 invariant). Observable: after containerError,
 *   getState()==='hidden', isViewable()===false, and the ratified teardown
 *   sequence fires (stateChange('hidden') → exposureChange(0) →
 *   viewableChange(false)); post-fatal EV is dead (no resurrection).
 *
 * Harness mirrors test-mraid-exposure-change.js / test-mraid-late-listener-
 * replay.js: a fresh fake SHARC host + a fresh bridge per case.
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
  isMuted: false,
  volume: 1,
};

const ev = (effectivePercent, reason) => ({
  effectivePercent,
  reason: reason === undefined ? null : reason,
  visibleRectangle: null,
});

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
    innerWidth: 375,
    innerHeight: 667,
    // Slice E3 (#392): the bridge anchors `ready` to document-load-complete. A
    // load-complete document is the fire-now condition, so the ready burst this
    // suite drives via Container:init fires as before — exercising the real gate
    // path (readyState === 'complete'), not the non-browser fallback.
    document: { readyState: 'complete' },
  };

  await import(`${BRIDGE_URL}?e2=${Date.now()}-${nonce++}`);

  const win = globalThis.window;

  const drive = (name, ...args) => {
    (eventListeners[name] || []).forEach((fn) => fn(...args));
  };

  return {
    mraid: win.mraid,
    SHARC,
    eventListeners,
    driveState: (state) => drive('stateChange', state),
    driveEV: (payload) => drive('effectiveVisibilityChange', payload),
    driveAudio: (args) => drive('audioVolumeChange', args),
    driveContainerError: (args) => drive('containerError', args),
    fireReady: (env) => readyCallbacks[0](env || DEFAULT_ENV),
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-bridge-correctness-e2.js — Slice E2 correctness trio + #414\n');

// ═════════════════════════════════════════════════════════════════════════
// A — #390: resync isAudioMuted on ACTIVE transition (re-fire on active)
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('A1 — preloaded creative sees current mute on ACTIVE (audioVolumeChange re-fired):');
  const h = await makeBridge();
  // Preload burst: ready with unmuted init snapshot, then a HIDDEN preload
  // during which the device muted. Container buffered isMuted:true in env and
  // delivered it once via audioVolumeChange BEFORE the creative's listener
  // attached (the preload-listener-late scenario). Bridge env now carries the
  // muted state, but the MRAID event already fired to nobody.
  h.fireReady();
  await tick();
  h.driveAudio({ volumePercentage: 40, volume: 0.4, isMuted: true }); // pre-listener delivery
  await tick();

  // A creative that attaches its audioVolumeChange listener at first
  // interactive frame (post-preload) must be re-notified on the ACTIVE
  // transition with the current audio — the #390 gap.
  let fires = 0;
  let lastPct = null;
  h.mraid.addEventListener('audioVolumeChange', (args) => { fires++; lastPct = args && args.volumePercentage; });

  h.driveState('active'); // ACTIVE transition — must re-fire audioVolumeChange
  await tick();

  check(fires === 1, 'audioVolumeChange re-fired exactly once on ACTIVE for the late/preloaded listener (got ' + fires + ')');
  check(lastPct === 40, 'the re-fired audioVolumeChange carries the current volumePercentage 40 (got ' + JSON.stringify(lastPct) + ')');
  check(h.mraid.isAudioMuted() === true, 'isAudioMuted() reflects the current muted state after ACTIVE (got ' + h.mraid.isAudioMuted() + ')');
}

{
  console.log('A2 — no ACTIVE re-fire when audio state was never established (no-op, mirrors container _syncAudioState guard):');
  const h = await makeBridge();
  // env with no audio fields defined — _syncAudioState no-ops container-side;
  // the bridge must likewise not fabricate an audioVolumeChange.
  const noAudioEnv = JSON.parse(JSON.stringify(DEFAULT_ENV));
  delete noAudioEnv.isMuted;
  delete noAudioEnv.volume;
  h.fireReady(noAudioEnv);
  await tick();

  let fires = 0;
  h.mraid.addEventListener('audioVolumeChange', () => { fires++; });
  h.driveState('active');
  await tick();

  check(fires === 0, 'ACTIVE with no established audio fires no spurious audioVolumeChange (got ' + fires + ')');
}

// ═════════════════════════════════════════════════════════════════════════
// B — #395: getDefaultPosition() returns real captured x/y
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('B1 — getDefaultPosition() returns the captured non-zero x/y (not 0/0):');
  const h = await makeBridge();
  const env = JSON.parse(JSON.stringify(DEFAULT_ENV));
  env.initialPosition = { x: 12, y: 34, width: 320, height: 50 };
  h.fireReady(env);
  await tick();

  const pos = h.mraid.getDefaultPosition();
  check(pos.x === 12, 'getDefaultPosition().x is the captured 12 (got ' + pos.x + ')');
  check(pos.y === 34, 'getDefaultPosition().y is the captured 34 (got ' + pos.y + ')');
  // w/h regression guard — must keep returning real initialDefaultSize.
  check(pos.width === 320 && pos.height === 50,
    'getDefaultPosition() keeps real w/h from initialDefaultSize (got ' + pos.width + 'x' + pos.height + ')');
}

{
  console.log('B2 — getDefaultPosition() before env is the safe zero rect (no crash):');
  const h = await makeBridge();
  const pos = h.mraid.getDefaultPosition();
  check(pos && pos.x === 0 && pos.y === 0 && pos.width === 0 && pos.height === 0,
    'pre-env getDefaultPosition() is {0,0,0,0} (got ' + JSON.stringify(pos) + ')');
}

// ═════════════════════════════════════════════════════════════════════════
// C — #394-trim: open() type guard precedes .trim()
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('C1 — open(null)/open(undefined)/open(123) are clean rejects, never a thrown TypeError:');
  // Fresh bridge per bad input — the E1 last-error latch replays to a late
  // listener, so a shared bridge + accumulated listener would over-count.
  for (const bad of [null, undefined, 123, {}, []]) {
    const h = await makeBridge();
    h.fireReady();
    await tick();
    const errs = [];
    h.mraid.addEventListener('error', (msg, action) => errs.push({ msg, action }));
    let threw = false;
    try { h.mraid.open(bad); } catch (e) { threw = true; }
    check(!threw, 'open(' + JSON.stringify(bad) + ') did not throw (clean reject) ');
    check(errs.length === 1 && errs[0].action === 'open',
      'open(' + JSON.stringify(bad) + ') fired a single error event with action "open" (got ' + JSON.stringify(errs) + ')');
  }
}

{
  console.log('C2 — a valid https URL still passes through open() (no regression):');
  const h = await makeBridge();
  let navigated = null;
  h.SHARC.requestNavigation = (req) => { navigated = req; return Promise.resolve(); };
  h.fireReady();
  await tick();

  const errs = [];
  h.mraid.addEventListener('error', (msg, action) => errs.push({ msg, action }));
  h.mraid.open('https://example.com/path');
  await tick();

  check(errs.length === 0, 'valid https URL fired no error (got ' + JSON.stringify(errs) + ')');
  check(navigated && navigated.url === 'https://example.com/path',
    'valid https URL reached requestNavigation with the url (got ' + JSON.stringify(navigated) + ')');
}

{
  console.log('C3 — whitespace-padded valid URL still trims and passes (trim not lost):');
  const h = await makeBridge();
  let navigated = null;
  h.SHARC.requestNavigation = (req) => { navigated = req; return Promise.resolve(); };
  h.fireReady();
  await tick();
  h.mraid.open('  https://example.com/  ');
  await tick();
  check(navigated && navigated.url === 'https://example.com/',
    'padded URL was trimmed before navigation (got ' + JSON.stringify(navigated && navigated.url) + ')');
}

// ═════════════════════════════════════════════════════════════════════════
// D — #414: fatal-terminate (containerError) must latch _closed via _latchClosed
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('D1 — containerError latches terminal: getState()="hidden", isViewable()=false, ordered teardown:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null)); // exposed + viewable before the fatal error
  await tick();

  check(h.mraid.getState() === 'default', 'pre-fatal getState() is "default" (baseline; got "' + h.mraid.getState() + '")');
  check(h.mraid.isViewable() === true, 'pre-fatal isViewable() is true (baseline; got ' + h.mraid.isViewable() + ')');

  const trace = [];
  h.mraid.addEventListener('stateChange', (s) => trace.push('state:' + s));
  h.mraid.addEventListener('exposureChange', (pct) => trace.push('exp:' + pct));
  h.mraid.addEventListener('viewableChange', (v) => trace.push('view:' + v));
  // E1 replays the settled 'default' state once to the just-registered
  // stateChange listener; exposureChange/viewableChange are non-latching (no
  // replay). Clear that seed so the trace isolates the fatal teardown.
  await tick();
  trace.length = 0;

  h.driveContainerError({ code: 'CANNOT_LOAD_RESOURCES', message: 'boom' });
  await tick();

  check(h.mraid.getState() === 'hidden', 'post-fatal getState() is "hidden" (got "' + h.mraid.getState() + '")');
  check(h.mraid.isViewable() === false, 'post-fatal isViewable() is false (got ' + h.mraid.isViewable() + ')');
  check(
    JSON.stringify(trace) === JSON.stringify(['state:hidden', 'exp:0', 'view:false']),
    'teardown emission order is stateChange(hidden) → exposureChange(0) → viewableChange(false) (got ' + JSON.stringify(trace) + ')',
  );
}

{
  console.log('D2 — post-fatal EV deliveries are dead (no resurrection):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.driveState('active');
  h.driveEV(ev(100, null));
  await tick();
  h.driveContainerError({ code: 'X', message: 'boom' });
  await tick();

  const post = [];
  h.mraid.addEventListener('exposureChange', (pct) => post.push(pct));
  h.mraid.addEventListener('viewableChange', (v) => post.push('view:' + v));
  h.driveEV(ev(100, null)); // a late EV push must NOT resurrect
  await tick();

  check(post.length === 0, 'no exposure/viewable events after fatal latch (got ' + JSON.stringify(post) + ')');
  check(h.mraid.getState() === 'hidden', 'getState() stays "hidden" after a post-fatal EV push (got "' + h.mraid.getState() + '")');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
