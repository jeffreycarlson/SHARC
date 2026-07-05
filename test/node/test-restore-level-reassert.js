/**
 * test-restore-level-reassert.js — R3 §3.2 level-triggered visibility replay (#338)
 *
 * Per ADR docs/design/0.7.11-bfcache-omid-relink-r3.md §3.2 / §6.2, INV-R4..R7.
 *
 * RC-1: OMID visibility flips ONLY on a real state-machine `onChange`
 * transition. A restore into a visible viewport that does NOT produce a
 * transition edge crossing into `active` never re-asserts VISIBLE, so OMID
 * stays NON_VISIBLE for a visible ad. R1 named this for the whole channel
 * class: the visibility signal is edge-triggered with no current-state replay.
 *
 * R3 §3.2: on a confirmed restore, the container re-asserts the CURRENT
 * visibility LEVEL to extensions even when `setState` was a no-op, via a
 * restore-scoped re-assert that calls
 * `_notifyExtensionsLifecycle('stateChange', {newState: current,
 * previousState: current, restored: true})`. OMID's
 * `onContainerStateChange('active')` then reaches `_signalVisibility('visible')`;
 * the `lastVisibilityState` guard keeps it idempotent. This is the
 * load-bearing, port-INDEPENDENT fix for the P1 symptom.
 *
 * Coverage:
 *   L-1 [RED→GREEN] restore where destination == pre-freeze state ⇒ even though
 *       setState is a no-op, extensions receive one stateChange re-assert with
 *       the current state and restored:true. (INV-R4)
 *   L-2 [RED→GREEN] OMID bridge: active→hidden→frozen→[restore into visible] ⇒
 *       _signalVisibility('visible') is reached and adEvents.stateChange('VISIBLE')
 *       fires exactly once; baseline leaves lastVisibilityState==='notVisible'.
 *       **THE binding NEW-C/P1 node proof.** (INV-R5)
 *   L-3 [GREEN-guard] OMID already VISIBLE at restore ⇒ the re-assert does NOT
 *       double-fire stateChange('VISIBLE'). (INV-R5, lastVisibilityState dedup)
 *   L-4 [GREEN-guard] the re-assert delivers only queryable states; a restore
 *       resolving to loading/terminated delivers nothing. (INV-R7)
 *   L-5 [GREEN-guard] the restore re-assert does NOT synthesize a phantom
 *       intermediate (no HIDDEN fabricated to provoke an edge). (INV-R6)
 *
 * Runs in Node after `npm run build`.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html', pretendToBeVisual: true },
);
global.window = dom.window;
global.document = dom.window.document;
let _docVisibility = 'visible';
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return _docVisibility; },
});
let _hasFocus = true;
global.document.hasFocus = () => _hasFocus;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');
const { ContainerStates } = protoMod;

let failures = 0;
function assert(condition, message) {
  if (condition) { console.log('  ✓', message); }
  else { console.error('  ✗', message); failures++; }
}
function section(name) { console.log('\n' + name); }

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

// ── Mock OM SDK (mirrors test-omid-container-lifecycle.js) ──────────────────
function createMockOmidSdk() {
  const stats = { startCalls: 0, finishCalls: 0, loadedCalls: 0, impressionCalls: 0, visibilityStates: [], playerStates: [] };
  class Partner { constructor(n, v) { stats.partnerName = n; stats.partnerVersion = v; } }
  class VerificationScriptResource { constructor() {} }
  class Context { constructor() {} setContentUrl() {} setServiceScriptUrl() {} setVideoElement() {} setSlotElement() {} }
  class AdSession {
    constructor() { this._observers = []; }
    setCreativeType() {} setImpressionType() {} registerAdView() {}
    registerSessionObserver(fn) { this._observers.push(fn); }
    start() { stats.startCalls++; }
    finish() { stats.finishCalls++; this._observers.forEach((fn) => fn({ type: 'sessionFinish' })); }
    addFriendlyObstruction() {} removeFriendlyObstruction() {}
  }
  class AdEvents {
    constructor(s) { this.session = s; }
    loaded() { stats.loadedCalls++; }
    impressionOccurred() { stats.impressionCalls++; }
    stateChange(v) { stats.visibilityStates.push(v); }
  }
  class MediaEvents { constructor(s) { this.session = s; } playerStateChange(v) { stats.playerStates.push(v); } }
  class VastProperties { constructor() {} }
  return { sdk: { Partner, VerificationScriptResource, Context, AdSession, AdEvents, MediaEvents, VastProperties }, stats };
}
function installMockSdk(mock) { global.OmidSessionClient = mock.sdk; window.OmidSessionClient = mock.sdk; }
function uninstallMockSdk() { delete global.OmidSessionClient; delete window.OmidSessionClient; }

function createContainerWithOmid(omidBridge) {
  const c = new SHARCContainer({
    creativeHtml: '<html><head></head><body>ad</body></html>',
    creativeRendererUrl: 'https://renderer.example/0.7.1/',
    placementElement: freshSlot(),
    creativeMeta: { apis: [7] },
    extensions: [omidBridge],
  });
  c._iframe = document.createElement('iframe');
  // OMID relay over the router is port-independent; stub the protocol send so
  // these publisher-page-only assertions don't require a live MessagePort.
  c._protocol.sendStateChange = () => {};
  // Slice D: OMID's visibility VALUE rides the composed effective-visibility
  // fan-out (the enum only gates THAT signals fire). Open the composer's push
  // gate and prime the raw inputs (harness precedent: slice-d bridge-agreement)
  // so the REAL ACTIVE-transition replay (C7) feeds the bridge end-to-end.
  c._protocol.sendEffectiveVisibilityChange = () => {};
  c._protocol.sessionId = 'sess-restore-reassert';
  c.creativeRendered = true;
  c._rawParentVisible = true;
  c._rawIntersection = 1.0;
  return c;
}

/** Drive a bridge+container to ACTIVE with an OMID session live. */
function bringOmidToActive(c) {
  c.setState(ContainerStates.READY);
  c.setState(ContainerStates.ACTIVE);
}

console.log('test-restore-level-reassert.js — R3 §3.2 level-triggered visibility replay\n');

// ── L-1 — destination == pre-freeze state: re-assert still fires ────────────
section('L-1. restore where destination == pre-freeze state ⇒ one stateChange re-assert {restored:true}');
{
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    visible: true,
  });
  // Capture extension-facing stateChange notifications via a fake extension.
  const events = [];
  c._extensions = [{
    onContainerLifecycleEvent: (e) => { if (e.type === 'stateChange') events.push(e); },
  }];
  c._protocol.sendStateChange = () => {};

  // Bring to ACTIVE, freeze, and restore back to ACTIVE (same level). The
  // adapter is detached so we exercise the container-side re-assert seam.
  if (c._lifecycleAdapter) { c._lifecycleAdapter.detach(); c._lifecycleAdapter = null; }
  c.setState(ContainerStates.ACTIVE);
  c.setState(ContainerStates.FROZEN);
  events.length = 0; // clear entry transitions

  _docVisibility = 'visible';
  _hasFocus = true;
  // Confirmed restore via the container chain (native-SHARC path). _onResume
  // resolves FROZEN → ACTIVE AND triggers the level re-assert.
  c._onResume();

  // Even though FROZEN→ACTIVE IS a real edge here, the binding L-1 property is
  // that a restore re-assert carrying restored:true is delivered exactly once.
  const reassert = events.filter((e) => e.restored === true);
  assert(reassert.length === 1,
    `exactly one restore re-assert delivered (restored:true) (got ${reassert.length})`);
  assert(reassert.length === 1 && reassert[0].newState === ContainerStates.ACTIVE,
    'the re-assert carries the current state (active)');
  assert(reassert.length === 1 && reassert[0].newState === reassert[0].previousState,
    'the re-assert carries newState === previousState (no fabricated edge)');
  try { c._terminate(); } catch (_) { /* ignore */ }
}

// ── L-2 — THE binding OMID NEW-C/P1 node proof ──────────────────────────────
// The failure window (ADR §1.1 Fact A3): the restore's effective destination
// equals the state the container already holds (ACTIVE), so `setState(ACTIVE)`
// is a NO-OP — no `onChange`, no extension notify, no `_signalVisibility`. OMID
// is stuck at `notVisible` for a visible ad. We reproduce that window
// deterministically: the container ends a restore at ACTIVE while OMID's
// lastVisibilityState is `notVisible` (it lost the level across the freeze).
// Without R3, a confirmed restore that does not cross a fresh edge into `active`
// leaves OMID NON_VISIBLE. With R3's level re-assert, OMID flips to VISIBLE.
section('L-2. OMID restore into ACTIVE with no fresh edge ⇒ level re-assert flips OMID to VISIBLE (binding #338 proof)');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);
    if (c._lifecycleAdapter) { c._lifecycleAdapter.detach(); c._lifecycleAdapter = null; }
    bridge.onContainerLifecycleEvent({ type: 'load', container: c });

    bringOmidToActive(c);
    // Slice D: deliver the composed EV {100} (production: _transitionToActive's
    // C7 replay does this; the harness's bare setState bypasses that helper).
    c._pushEffectiveVisibility();
    assert(bridge._omid.lastVisibilityState === 'visible', 'setup: OMID VISIBLE after active');

    // Model the freeze round-trip's effect on OMID: it went notVisible at
    // freeze entry (active→…→frozen drives _signalVisibility('notVisible')),
    // and on restore the container resolves back to ACTIVE *via a path that
    // produces no fresh edge into active* — the no-op window. We pin that no-op
    // window directly: force OMID to notVisible (the across-freeze loss) and
    // leave the container ACTIVE, so a restore re-assert is the ONLY thing that
    // can re-deliver `active`.
    bridge._omid.lastVisibilityState = 'notVisible';
    assert(c.getState() === ContainerStates.ACTIVE, 'setup: container is ACTIVE (restore destination == current)');
    assert(bridge._omid.lastVisibilityState === 'notVisible',
      'setup: OMID stuck notVisible (the stuck-NON_VISIBLE window for a visible ad)');
    const visibleCountBefore = mock.stats.visibilityStates.filter((v) => v === 'VISIBLE').length;

    // Confirmed restore. setState(ACTIVE) would be a no-op (already ACTIVE), so
    // baseline fires no onChange and OMID stays notVisible. R3's restore
    // re-assert delivers the current level (active) to extensions regardless.
    _docVisibility = 'visible';
    _hasFocus = true;
    if (typeof c._reassertCurrentStateAfterRestore === 'function') {
      c._reassertCurrentStateAfterRestore();
    }

    assert(bridge._omid.lastVisibilityState === 'visible',
      'BINDING: OMID flips back to VISIBLE on restore-into-ACTIVE with no fresh edge (baseline: stuck notVisible)');
    const visibleCountAfter = mock.stats.visibilityStates.filter((v) => v === 'VISIBLE').length;
    assert(visibleCountAfter === visibleCountBefore + 1,
      `BINDING: adEvents.stateChange('VISIBLE') fired exactly once on restore (before=${visibleCountBefore}, after=${visibleCountAfter})`);
    try { c._terminate(); } catch (_) { /* ignore */ }
  } finally {
    uninstallMockSdk();
  }
}

// ── L-3 — already VISIBLE at restore: no double-fire ────────────────────────
section('L-3. OMID already VISIBLE at restore ⇒ re-assert does NOT double-fire stateChange(VISIBLE)');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);
    if (c._lifecycleAdapter) { c._lifecycleAdapter.detach(); c._lifecycleAdapter = null; }
    bridge.onContainerLifecycleEvent({ type: 'load', container: c });
    bringOmidToActive(c);
    // Freeze from ACTIVE (direct edge), then restore into visible+focused.
    c.setState(ContainerStates.FROZEN);
    // Slice D: model the composer's backgrounding push at freeze (production:
    // the visibilitychange/freeze handlers feed it; direct setState bypasses
    // the adapter). OMID drops to NON_VISIBLE on the composed {0}.
    c._rawParentVisible = false;
    c._pushEffectiveVisibility();
    const visibleCountBefore = mock.stats.visibilityStates.filter((v) => v === 'VISIBLE').length;
    _docVisibility = 'visible';
    _hasFocus = true;
    // The page is visible again at restore; the ACTIVE transition's C7 replay
    // re-composes {100} and the restore re-assert catches up — dedup must
    // collapse the two delivery paths into exactly one VISIBLE fire.
    c._rawParentVisible = true;
    c._onResume();
    const visibleCountAfter = mock.stats.visibilityStates.filter((v) => v === 'VISIBLE').length;
    assert(bridge._omid.lastVisibilityState === 'visible', 'OMID is VISIBLE after restore');
    assert(visibleCountAfter === visibleCountBefore + 1,
      `stateChange('VISIBLE') fired exactly once (the lastVisibilityState dedup holds) (before=${visibleCountBefore}, after=${visibleCountAfter})`);
    try { c._terminate(); } catch (_) { /* ignore */ }
  } finally {
    uninstallMockSdk();
  }
}

// ── L-4 — only queryable states delivered ───────────────────────────────────
section('L-4. re-assert delivers only creative-queryable states (never loading/terminated)');
{
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    visible: true,
  });
  const events = [];
  c._extensions = [{ onContainerLifecycleEvent: (e) => { if (e.type === 'stateChange') events.push(e); } }];
  c._protocol.sendStateChange = () => {};
  if (c._lifecycleAdapter) { c._lifecycleAdapter.detach(); c._lifecycleAdapter = null; }

  // Call the re-assert seam directly while in LOADING (non-queryable). It MUST
  // NOT deliver anything marked restored:true for a non-queryable state.
  events.length = 0;
  if (typeof c._reassertCurrentStateAfterRestore === 'function') {
    c._reassertCurrentStateAfterRestore();
  }
  const reassertWhileLoading = events.filter((e) => e.restored === true);
  assert(reassertWhileLoading.length === 0,
    'no restore re-assert delivered while in LOADING (non-queryable) (INV-R7)');
  try { c._terminate(); } catch (_) { /* ignore */ }
}

// ── L-5 — no phantom intermediate fabricated ────────────────────────────────
section('L-5. restore re-assert does NOT synthesize a phantom HIDDEN to provoke an edge');
{
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    visible: true,
  });
  const events = [];
  c._extensions = [{ onContainerLifecycleEvent: (e) => { if (e.type === 'stateChange') events.push(e); } }];
  c._protocol.sendStateChange = () => {};
  if (c._lifecycleAdapter) { c._lifecycleAdapter.detach(); c._lifecycleAdapter = null; }
  c.setState(ContainerStates.ACTIVE);
  c.setState(ContainerStates.FROZEN);
  events.length = 0;
  _docVisibility = 'visible';
  _hasFocus = true;
  c._onResume();
  // The full set of stateChange events delivered during restore MUST NOT
  // include a HIDDEN that the creative never actually experienced.
  const states = events.map((e) => e.newState);
  assert(!states.includes(ContainerStates.HIDDEN),
    `no phantom HIDDEN fabricated on the restore path (delivered: ${JSON.stringify(states)})`);
  try { c._terminate(); } catch (_) { /* ignore */ }
}

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} level-reassert assertion(s) failed.`);
  process.exit(1);
}
console.log('✓ All level-reassert assertions passed.');
