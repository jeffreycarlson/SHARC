/**
 * test-mraid-ready-document-load-gate.js — Slice E3, ready anchored to
 * document-load-complete (#392, ratified 2026-07-05).
 *
 * RATIFIED CONTRACT: the MRAID `ready` event AND the `loading→default`
 * `stateChange('default')` flip fire only when BOTH conditions hold:
 *   (1) Container:init received (MRAID environment ready), AND
 *   (2) the creative document is LOAD-COMPLETE
 *       (`document.readyState === 'complete'` ⇒ fire now; else DEFER to the
 *        inner document's window `'load'` event).
 * `getState()` stays `'loading'` until BOTH. Rationale: the creative document
 * must be load-complete so a creative that measures its own DOM in its `ready`
 * handler does not read nulls/zero-sizes.
 *
 * This is the BRIDGE's own creative-realm ready gate — it mirrors the Slice A
 * load-anchor pattern (window 'load' listener + readyState === 'complete'
 * immediate-fire backup, single-fire guard) used by the renderer and creative.
 *
 * NOT gated on final GEOMETRY: positions/geometry stay the placeholder zeros at
 * ready (§3.2 two-phase geometry, unchanged); the post-ready sizeChange carries
 * real geometry as before.
 *
 * Harness mirrors test-mraid-lifecycle-binding.js: a fresh fake SHARC host + a
 * fresh bridge instance per case from the built bundle under its own
 * globalThis.window, plus a controllable globalThis.window.document whose
 * readyState the case sets and whose 'load' the case can dispatch.
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
 * @param {'loading'|'interactive'|'complete'} initialReadyState
 */
async function makeBridge(initialReadyState) {
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

  // Minimal controllable document + window 'load' event target. The bridge
  // gates on window.document.readyState and, when not yet complete, registers a
  // one-shot window 'load' listener — so the harness needs both a mutable
  // readyState and a window-level addEventListener/dispatch for 'load'.
  const loadListeners = [];
  const doc = { readyState: initialReadyState };

  globalThis.location = { protocol: 'http:', hostname: 'localhost' };
  globalThis.window = {
    __sharcMraidBridgeAutoInstall: true,
    SHARC,
    document: doc,
    innerWidth: 375,
    innerHeight: 667,
    addEventListener(type, fn, opts) {
      if (type === 'load') loadListeners.push({ fn, once: !!(opts && opts.once) });
    },
    removeEventListener(type, fn) {
      if (type !== 'load') return;
      const i = loadListeners.findIndex((l) => l.fn === fn);
      if (i !== -1) loadListeners.splice(i, 1);
    },
  };

  await import(`${BRIDGE_URL}?ready-load-gate=${Date.now()}-${nonce++}`);

  const win = globalThis.window;
  const events = [];
  let seq = 0;
  const record = (type) => (...args) => events.push({ type, args, seq: seq++ });
  win.mraid.addEventListener('ready', record('ready'));
  win.mraid.addEventListener('stateChange', record('stateChange'));
  win.mraid.addEventListener('sizeChange', record('sizeChange'));

  return {
    mraid: win.mraid,
    win,
    doc,
    events,
    countOf: (type) => events.filter((e) => e.type === type).length,
    seqOfFirst: (type, predicate) => {
      const e = events.find((ev) => ev.type === type && (!predicate || predicate(ev)));
      return e ? e.seq : -1;
    },
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
    // Simulate the creative document reaching load-complete: flip readyState and
    // dispatch the window 'load' event, exactly as a browser does.
    dispatchLoad() {
      doc.readyState = 'complete';
      loadListeners.slice().forEach((l) => {
        try { l.fn.call(win, { type: 'load' }); } finally {
          if (l.once) {
            const i = loadListeners.indexOf(l);
            if (i !== -1) loadListeners.splice(i, 1);
          }
        }
      });
    },
    loadListenerCount: () => loadListeners.length,
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-ready-document-load-gate.js — ready anchored to document-load-complete (#392)\n');

// ── C1 — deferred while the document is still loading ─────────────────────────
// Container:init received but readyState==='loading': ready must NOT fire; the
// loading→default flip must NOT happen; getState() stays 'loading'.
{
  console.log("C1 — Container:init while readyState==='loading' defers the ready burst:");
  const h = await makeBridge('loading');
  h.fireReady();
  await tick();

  check(h.countOf('ready') === 0, 'ready does NOT fire while document is still loading');
  check(h.countOf('stateChange') === 0,
    "stateChange('default') does NOT fire while document is still loading");
  check(h.mraid.getState() === 'loading', "getState() stays 'loading' pre-load-complete");
  check(h.loadListenerCount() === 1, 'a one-shot window load listener is registered to defer the burst');
}

// ── C2 — 'interactive' also defers ────────────────────────────────────────────
// readyState 'interactive' (DOM parsed, subresources still loading) is NOT
// load-complete; the burst must still defer.
{
  console.log("C2 — Container:init while readyState==='interactive' also defers:");
  const h = await makeBridge('interactive');
  h.fireReady();
  await tick();

  check(h.countOf('ready') === 0, "ready does NOT fire at readyState 'interactive'");
  check(h.mraid.getState() === 'loading', "getState() stays 'loading' at 'interactive'");
}

// ── C3 — fires once the document reaches load-complete ────────────────────────
// After deferral, dispatching window 'load' (readyState→'complete') fires the
// full burst: stateChange('default') then ready, and getState() flips.
{
  console.log('C3 — deferred burst fires when the document reaches load-complete:');
  const h = await makeBridge('loading');
  h.fireReady();
  await tick();
  check(h.countOf('ready') === 0, 'still deferred before load');

  h.dispatchLoad();
  await tick();

  check(h.countOf('ready') === 1, 'ready fires exactly once on window load');
  check(h.countOf('stateChange') === 1, "stateChange('default') fires exactly once on window load");
  check(h.seqOfFirst('stateChange', (e) => e.args[0] === 'default') >= 0,
    "the stateChange carried 'default'");
  check(h.mraid.getState() === 'default', "getState() flips to 'default' after load-complete + init");
}

// ── C4 — document already complete at Container:init ⇒ fire immediately ────────
// The common case: by the time Container:init round-trips, the creative document
// is already load-complete. No unnecessary defer — fire in the onReady turn.
{
  console.log("C4 — document already 'complete' at Container:init fires immediately (no defer):");
  const h = await makeBridge('complete');
  h.fireReady();

  check(h.countOf('ready') === 1, 'ready fires synchronously in the onReady turn when already complete');
  check(h.countOf('stateChange') === 1, "stateChange('default') fires synchronously when already complete");
  check(h.mraid.getState() === 'default', "getState() is 'default' immediately");
  check(h.loadListenerCount() === 0, 'no window load listener registered when already complete');
}

// ── C5 — S1→S2 order preserved: stateChange('default') BEFORE ready ────────────
// The #392 anchor moves the WHOLE burst later; the ORDER within it is unchanged.
{
  console.log("C5 — stateChange('default') emits BEFORE ready in the gated burst:");
  const h = await makeBridge('loading');
  h.fireReady();
  await tick();
  h.dispatchLoad();
  await tick();

  const defaultSeq = h.seqOfFirst('stateChange', (e) => e.args[0] === 'default');
  const readySeq = h.seqOfFirst('ready');
  check(defaultSeq >= 0 && readySeq >= 0, 'both stateChange(default) and ready emitted');
  check(defaultSeq < readySeq, "stateChange('default') fires BEFORE ready (S1→S2 preserved)");
  // Placeholder sizeChange also rides the gated burst (unchanged content).
  check(h.seqOfFirst('sizeChange') >= 0, 'placeholder sizeChange rides the gated burst');
}

// ── C6 — double-fire guard: load fires twice ⇒ ready once ─────────────────────
{
  console.log('C6 — window load dispatched twice fires ready only once:');
  const h = await makeBridge('loading');
  h.fireReady();
  await tick();
  h.dispatchLoad();
  await tick();
  // A second spurious load dispatch (e.g. a document.open()/reload edge) must
  // not re-run the burst.
  h.doc.readyState = 'complete';
  h.dispatchLoad();
  await tick();

  check(h.countOf('ready') === 1, 'ready fired exactly once across two load dispatches');
  check(h.countOf('stateChange') === 1, 'stateChange fired exactly once across two load dispatches');
}

// ── C7 — double-fire guard: Container:init delivered twice ⇒ ready once ────────
{
  console.log('C7 — Container:init delivered twice (already complete) fires ready only once:');
  const h = await makeBridge('complete');
  h.fireReady();
  h.fireReady();
  await tick();

  check(h.countOf('ready') === 1, 'ready fired exactly once across two Container:init deliveries');
  check(h.countOf('stateChange') === 1, 'stateChange fired exactly once across two Container:init deliveries');
}

// ── C8 — E1 interaction: a ready listener attached AFTER the gated fire replays once
// Slice E1 replays `ready` to a listener that registers after the gate fired.
// Under the new gate, "gate fired" = both conditions met.
{
  console.log('C8 — E1 late-listener replay: ready attached after the gated fire replays once:');
  const h = await makeBridge('loading');
  h.fireReady();
  await tick();
  h.dispatchLoad();
  await tick();

  let lateReady = 0;
  h.mraid.addEventListener('ready', () => { lateReady++; });
  check(lateReady === 1, 'a ready listener attached AFTER the gated fire is replayed exactly once (E1)');

  // And a ready listener attached BEFORE the gate fired must NOT be replayed
  // early (nothing to replay yet) — proven by C1/C3 where the pre-attached
  // recorder saw zero readys until load. Re-assert the invariant directly:
  const h2 = await makeBridge('loading');
  let earlyReady = 0;
  h2.mraid.addEventListener('ready', () => { earlyReady++; });
  h2.fireReady();
  await tick();
  check(earlyReady === 0, 'a ready listener attached BEFORE the gate fired is NOT replayed prematurely (E1)');
  h2.dispatchLoad();
  await tick();
  check(earlyReady === 1, 'that same pre-gate listener fires once when the gate opens');
}

// ── C9 — latch either order: load-complete BEFORE Container:init ───────────────
// Unlikely but handled: if the document is already complete when Container:init
// finally arrives, the burst fires on init (C4 is the same-turn case; this pins
// the both-conditions latch semantics explicitly).
{
  console.log('C9 — load-complete already true before Container:init fires on init:');
  const h = await makeBridge('complete');
  await tick(); // document has been complete for a while; no init yet
  check(h.countOf('ready') === 0, 'no ready before Container:init even when already load-complete');
  h.fireReady();
  check(h.countOf('ready') === 1, 'ready fires when Container:init arrives (both conditions now met)');
  check(h.mraid.getState() === 'default', "getState() is 'default' after init on an already-complete doc");
}

if (failures > 0) {
  console.error(`\n✗ ${failures} ready-document-load-gate assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All ready-document-load-gate assertions passed.');
