/**
 * test-mraid-lifecycle-binding.js — MRAID 3.0 lifecycle-binding core (#393, #392).
 *
 * The prior bridge fired the whole MRAID lifecycle as a synchronous burst at
 * Container:init and emitted `ready` BEFORE `stateChange('default')` (inverted).
 * This slice replaces that with continuous binding: each MRAID event fires at
 * its real lifecycle moment, in the canonical MoPub S1→S4 order, with two-phase
 * geometry (placeholder zeros at ready, real dimensions in a distinct post-ready
 * sizeChange).
 *
 * Contract under test (ADR 2026-06-12-mraid-lifecycle-binding-architecture.md):
 *   L1  ORDER: emitted sequence is default < ready < {real sizeChange, viewable},
 *       with S3 (real sizeChange) and S4 (viewable) UNORDERED relative to each
 *       other after ready/active — viewability ⊥ geometry, neither orders the
 *       other (PA-3, unified-lifecycle-ordering §3A).
 *   L2  ENV-READY ANCHOR (#392): `ready` fires on env-readiness with
 *       placeholder-zero geometry — getCurrentPosition() is zeros at ready, NOT
 *       final geometry, NOT document-load.
 *   L3  TWO-PHASE GEOMETRY: a distinct post-ready sizeChange carries the real
 *       measured rect (from the placementChange `position` rect); the first
 *       post-ready placementChange is forced through even if its dims match the
 *       placeholder, and getCurrentPosition() then reflects the real rect.
 *   L4  PLACEMENT-MODE SYNC (RISK-4): stateChange('expanded'/'resized'/
 *       'default') is driven off the placementChange signal (geometry settled
 *       first), NOT the requestPlacementChange().then() microtask — so
 *       getCurrentPosition() reflects the new rect inside the stateChange
 *       handler. This covers the CREATIVE-initiated path (a placementChange
 *       that settles an intent the bridge raised). L4b pins that a bare
 *       geometry-only placementChange (no `intent` field) updates geometry but
 *       does NOT sync state. L4c asserts the operator-initiated path: a
 *       placementChange carrying `intent` syncs MRAID placement mode and emits
 *       stateChange without any pending creative request (closes #391).
 *   L5  RECURRENCE: sizeChange and viewableChange recur on later transitions
 *       (not one-shot).
 *   L6  RISK-2: orientation/window-resize fires SHARC constraintsChange (no
 *       geometry); the bridge re-measures its own viewport and emits a recurring
 *       sizeChange.
 *
 * Harness mirrors test-mraid-adapter-dedup.js: a fresh fake SHARC host + a fresh
 * bridge instance per case from the built bundle under its own globalThis.window
 * via a cache-busting import query. A monotonic sequence counter timestamps each
 * emitted event so ORDER can be asserted across channels.
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

async function makeBridge(viewport) {
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
    // RISK-2: the constraintsChange handler re-measures the creative frame's
    // own viewport. Provide a controllable viewport on the fake window.
    innerWidth: (viewport && viewport.width) != null ? viewport.width : 375,
    innerHeight: (viewport && viewport.height) != null ? viewport.height : 667,
  };

  await import(`${BRIDGE_URL}?lifecycle=${Date.now()}-${nonce++}`);

  const win = globalThis.window;

  // Monotonic sequence so ORDER is observable across channels.
  let seq = 0;
  const events = []; // { type, args, seq }
  const record = (type) => (...args) => events.push({ type, args, seq: seq++ });
  win.mraid.addEventListener('ready', record('ready'));
  win.mraid.addEventListener('stateChange', record('stateChange'));
  win.mraid.addEventListener('sizeChange', record('sizeChange'));
  win.mraid.addEventListener('viewableChange', record('viewableChange'));

  return {
    mraid: win.mraid,
    win,
    events,
    seqOfFirst: (type, predicate) => {
      const e = events.find((ev) => ev.type === type && (!predicate || predicate(ev)));
      return e ? e.seq : -1;
    },
    fireReady(env) { readyCallbacks[0](env || DEFAULT_ENV); },
    driveState(state) { (eventListeners.stateChange || []).forEach((fn) => fn(state)); },
    drivePlacementChange(update) { (eventListeners.placementChange || []).forEach((fn) => fn(update)); },
    driveConstraintsChange(args) { (eventListeners.constraintsChange || []).forEach((fn) => fn(args || {})); },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-lifecycle-binding.js — MRAID 3.0 lifecycle-binding core (#393)\n');

// ── L1 + L2 — startup ORDER and env-ready anchor ─────────────────────────────
// default < ready < {real sizeChange, viewable} (S3/S4 unordered after ready),
// and `ready` fires with placeholder-zero geometry (env-ready, not final geometry).
{
  console.log('L1/L2 — order default<ready<{real sizeChange, viewable}, ready on placeholder geometry:');
  const h = await makeBridge();

  h.fireReady();              // S1 default + placeholder sizeChange, then S2 ready
  await tick();

  // At ready, geometry is still the placeholder zeros (two-phase, MoPub S2).
  const posAtReady = h.mraid.getCurrentPosition();
  check(posAtReady.width === 0 && posAtReady.height === 0,
    'getCurrentPosition() is placeholder-zero at ready (env-ready anchor, not final geometry)');

  // Real SHARC order: `active` arrives BEFORE the first post-ready placementChange,
  // so viewableChange(true) (S4) precedes the real-geometry sizeChange (S3). We do
  // NOT manufacture an S3-before-S4 order here — see the unordered-S3/S4 note below.
  h.driveState('active');     // S4 — ad enters the viewport.
  h.drivePlacementChange({ position: { x: 0, y: 190, width: 320, height: 50 } }); // S3 real geometry.

  const defaultSeq  = h.seqOfFirst('stateChange', (e) => e.args[0] === 'default');
  const readySeq    = h.seqOfFirst('ready');
  const realSizeSeq = h.seqOfFirst('sizeChange', (e) => e.seq > readySeq); // post-ready real sizeChange
  const viewSeq     = h.seqOfFirst('viewableChange', (e) => e.args[0] === true);

  check(defaultSeq >= 0 && readySeq >= 0 && realSizeSeq >= 0 && viewSeq >= 0,
    'all four lifecycle events were emitted');
  check(defaultSeq < readySeq, 'stateChange("default") fires BEFORE ready (inversion fixed)');
  check(readySeq < realSizeSeq, 'ready fires BEFORE the real-geometry sizeChange (HB-7, two-phase geometry)');
  check(readySeq < viewSeq, 'ready fires BEFORE viewableChange(true)');
  // S3 (real sizeChange) and S4 (viewableChange) are UNORDERED relative to each
  // other — both fire after ready/active, but neither orders the other. WHY:
  // viewability ⊥ geometry (independent axes) — viewableChange fires on the
  // visibility transition, sizeChange on geometry measurement; neither gates the
  // other (PA-3, unified-lifecycle-ordering §3A). We intentionally do NOT assert
  // realSizeSeq < viewSeq; the real browser order is the opposite on both paths.

  // Real geometry now reflected in getCurrentPosition().
  const posAfter = h.mraid.getCurrentPosition();
  check(posAfter.width === 320 && posAfter.height === 50 && posAfter.y === 190,
    'getCurrentPosition() reflects the real measured rect after the post-ready sizeChange');
}

// ── L3 — two-phase geometry: distinct placeholder then real sizeChange ────────
// The placeholder S1 sizeChange (from initialDefaultSize) and the real S3
// sizeChange are BOTH emitted even when their dimensions coincide.
{
  console.log('L3 — placeholder S1 and real S3 sizeChange are both emitted (distinct fires):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  // Real geometry happens to equal the placeholder size — must still re-fire.
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });

  const sizeFires = h.events.filter((e) => e.type === 'sizeChange').map((e) => e.args);
  check(sizeFires.length === 2,
    'exactly two sizeChange fires (placeholder + real) even with identical dims (got ' + sizeFires.length + ')');
  check(JSON.stringify(sizeFires) === JSON.stringify([[320, 50], [320, 50]]),
    'both fires carry the dimensions (got ' + JSON.stringify(sizeFires) + ')');

  // A redundant subsequent placementChange with the same size is deduped.
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });
  const sizeFiresAfter = h.events.filter((e) => e.type === 'sizeChange');
  check(sizeFiresAfter.length === 2, 'a third identical placementChange is deduped (no third sizeChange)');
}

// ── L4 — placement-mode stateChange driven off placementChange (RISK-4) ──────
// expand(): stateChange('expanded') must fire only after the placementChange
// settles geometry, and getCurrentPosition() inside that ordering reflects the
// new rect (not the stale pre-expand rect).
{
  console.log('L4 — expand stateChange driven off placementChange; geometry settled first:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 190, width: 320, height: 50 } }); // S3 real
  h.driveState('active');

  const beforeExpand = h.events.length;
  h.mraid.expand();
  await tick(); // requestPlacementChange().then() microtask drains here

  // The .then() microtask must NOT have emitted stateChange('expanded') on its own.
  const expandedBeforePlacement = h.events
    .slice(beforeExpand)
    .some((e) => e.type === 'stateChange' && e.args[0] === 'expanded');
  check(!expandedBeforePlacement,
    'stateChange("expanded") does NOT fire from the .then() microtask (no premature emit)');
  check(h.mraid.getState() === 'default',
    'getState() still "default" until the placementChange settles the expand');

  // The container's placementChange settles the expand with the real max rect.
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 1024, height: 768 } });

  const tail = h.events.slice(beforeExpand);
  const sizeIdx = tail.findIndex((e) => e.type === 'sizeChange');
  const stateIdx = tail.findIndex((e) => e.type === 'stateChange' && e.args[0] === 'expanded');
  check(sizeIdx >= 0 && stateIdx >= 0 && sizeIdx < stateIdx,
    'sizeChange fires BEFORE stateChange("expanded") in the chain (§3.2 ordering)');
  check(h.mraid.getState() === 'expanded', 'getState() is "expanded" after placementChange settles');
  check(h.mraid.getCurrentPosition().width === 1024,
    'getCurrentPosition() reflects the expanded rect at stateChange time (no stale value)');
}

// ── L4b — geometry-only placementChange WITHOUT an intent: geometry, not state ──
// A placementChange that settles an in-flight intent the bridge raised updates
// _placementMode (L4); a bare geometry-only placementChange that carries NO `intent`
// field leaves the MRAID state untouched and only re-fires sizeChange. (Operator-
// initiated changes that DO carry `intent` sync state — see L4c.)
{
  console.log('L4b — geometry-only (no-intent) placementChange re-fires sizeChange without changing state:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 190, width: 320, height: 50 } }); // S3 real
  const before = h.events.length;
  h.drivePlacementChange({ position: { x: 0, y: 190, width: 300, height: 250 } }); // pure geometry change
  const tail = h.events.slice(before);
  check(tail.some((e) => e.type === 'sizeChange' && e.args[0] === 300 && e.args[1] === 250),
    'geometry change re-fires sizeChange(300,250)');
  check(!tail.some((e) => e.type === 'stateChange'),
    'no stateChange emitted for a geometry-only placementChange (no intent field)');
  check(h.mraid.getState() === 'default', 'getState() stays "default"');
}

// ── L4c — operator-initiated placementChange WITH intent syncs state (#391) ──
// When the container drives a placement change the creative did not request — most
// notably its own dismiss button collapsing an expand — it carries `intent` on the
// placementChange payload and the bridge derives the MRAID placement mode from it,
// even with no pending creative request. Closes #391.
{
  console.log('L4c — operator-initiated placementChange carries intent and syncs getState() (#391):');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 190, width: 320, height: 50 }, intent: null }); // default
  check(h.mraid.getState() === 'default', 'baseline getState() is "default"');

  // Operator EXPAND (no pending creative request): intent drives 'expanded'.
  let before = h.events.length;
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 480 }, intent: 'expand' });
  let tail = h.events.slice(before);
  check(h.mraid.getState() === 'expanded', 'operator expand (intent:"expand") syncs getState() to "expanded"');
  check(tail.some((e) => e.type === 'stateChange' && e.args[0] === 'expanded'),
    'operator expand emits stateChange("expanded")');

  // Operator RESIZE: intent 'resize' → 'resized'.
  before = h.events.length;
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 250 }, intent: 'resize' });
  tail = h.events.slice(before);
  check(h.mraid.getState() === 'resized',
    'operator resize (intent:"resize") syncs getState() to "resized"');
  check(tail.some((e) => e.type === 'stateChange' && e.args[0] === 'resized'),
    'operator resize emits stateChange("resized")');

  // Operator COLLAPSE (e.g. container dismiss button): intent null → 'default'.
  before = h.events.length;
  h.drivePlacementChange({ position: { x: 0, y: 190, width: 320, height: 50 }, intent: null });
  tail = h.events.slice(before);
  check(h.mraid.getState() === 'default', 'operator collapse (intent:null) returns getState() to "default"');
  check(tail.some((e) => e.type === 'stateChange' && e.args[0] === 'default'),
    'operator collapse emits stateChange("default")');
}

// ── L5 — recurrence: sizeChange and viewableChange recur ─────────────────────
{
  console.log('L5 — sizeChange and viewableChange recur on later transitions:');
  const h = await makeBridge();
  h.fireReady();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 50 } });  // real
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 300, height: 250 } }); // resize 1
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 320, height: 480 } }); // resize 2
  const sizeFires = h.events.filter((e) => e.type === 'sizeChange').length;
  check(sizeFires >= 4, 'sizeChange recurred across multiple geometry changes (got ' + sizeFires + ')');

  h.driveState('active');   // viewable true
  h.driveState('passive');  // viewable false
  h.driveState('active');   // viewable true again
  const viewFires = h.events.filter((e) => e.type === 'viewableChange').map((e) => e.args[0]);
  check(JSON.stringify(viewFires) === JSON.stringify([true, false, true]),
    'viewableChange recurs on each visibility flip [true,false,true] (got ' + JSON.stringify(viewFires) + ')');
}

// ── L6 — RISK-2: constraintsChange (orientation/resize) recurs sizeChange ─────
// SHARC fires constraintsChange (no geometry) on orientation/window-resize. The
// bridge re-measures its own viewport and emits a recurring sizeChange.
{
  console.log('L6 — orientation/resize constraintsChange re-fires sizeChange from re-measured geometry:');
  const h = await makeBridge({ width: 375, height: 667 }); // portrait
  h.fireReady();
  await tick();
  h.drivePlacementChange({ position: { x: 0, y: 0, width: 375, height: 100 } }); // real geometry
  const before = h.events.length;

  // Rotate to landscape: the creative frame's viewport changes; SHARC sends
  // constraintsChange with no geometry. The bridge re-reads window.inner* .
  h.win.innerWidth = 667;
  h.win.innerHeight = 375;
  h.driveConstraintsChange({ maxWidth: 667, maxHeight: 375, reason: 'rotation' });

  const tail = h.events.slice(before);
  const sizeFire = tail.find((e) => e.type === 'sizeChange');
  check(sizeFire != null, 'constraintsChange (rotation) re-fired sizeChange (RISK-2 closed)');
  check(sizeFire != null && sizeFire.args[0] === 667 && sizeFire.args[1] === 375,
    'recurring sizeChange carries the re-measured viewport (667x375) (got ' +
      (sizeFire ? JSON.stringify(sizeFire.args) : 'none') + ')');

  // A constraintsChange that does not change the measured size is deduped.
  const before2 = h.events.length;
  h.driveConstraintsChange({ maxWidth: 667, maxHeight: 375, reason: 'policyUpdate' });
  const tail2 = h.events.slice(before2);
  check(!tail2.some((e) => e.type === 'sizeChange'),
    'a constraintsChange with unchanged viewport does NOT re-fire sizeChange (deduped)');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} lifecycle-binding assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All MRAID lifecycle-binding assertions passed.');
