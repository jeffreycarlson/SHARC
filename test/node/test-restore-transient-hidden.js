/**
 * test-restore-transient-hidden.js — R3 §3.1 transient-hidden restore (#338, audit I-1)
 *
 * Per ADR docs/design/0.7.11-bfcache-omid-relink-r3.md §3.1, INV-R1..R7.
 *
 * Audit I-1 (the window `_resolveRestoreDestination` claimed to close): a real
 * bfcache restore can fire `pageshow{persisted:true}` while
 * `document.visibilityState` is STILL transiently `'hidden'`, only flipping to
 * `'visible'` a moment later via `visibilitychange`. With the retained
 * IntersectionObserver ratio ≥ 0.5, the correct destination is ACTIVE.
 *
 * Baseline `_resolveRestoreDestination` (before this fix) ran ONCE, synchronous
 * to `pageshow`:
 *   1. `_transitionFromFrozen` → docVisible=false → HIDDEN, then the
 *      `if (!docVisible) return` guard bailed. Container = HIDDEN.
 *   2. The later `visibilitychange → 'visible'` reached only the container's
 *      `_onVisibilityChange`, which drove HIDDEN → PASSIVE and stopped. The
 *      adapter never re-ran, so nothing promoted PASSIVE → ACTIVE.
 *   ⇒ Container stuck at PASSIVE, OMID stuck `notVisible` — the EXACT #338
 *      symptom, in the precise window the method claimed to close.
 *
 * The fix arms a one-shot restore-visibility watch when the FROZEN-exit
 * under-resolves transiently-hidden; the next `visibilitychange → visible`
 * re-runs `_resolveRestoreDestination` (now visible) and re-asserts the §3.2
 * level, so the ad reaches ACTIVE and OMID reports VISIBLE.
 *
 * Coverage:
 *   T-1 [RED→GREEN] adapter attached, pageshow{persisted} fires while document
 *       hidden (IO ratio ≥0.5 retained), THEN visibility flips to visible ⇒
 *       container reaches ACTIVE and OMID reports VISIBLE. Baseline: stuck
 *       PASSIVE / notVisible. (INV-R1/R2/R3, INV-R4/R5)
 *   T-2 [GREEN-guard] exactly one FROZEN-exit transition across the whole
 *       restore (HIDDEN at pageshow, then PASSIVE→ACTIVE on the flip — no second
 *       FROZEN-exit, no phantom edge). (INV-R1/R2, INV-R6)
 *   T-3 [GREEN-guard] the watch is one-shot: a SECOND visibilitychange→visible
 *       after the restore completed does NOT re-drive the container. (INV-R2)
 *   T-4 [GREEN-guard] transient-hidden restore where the retained ratio is
 *       BELOW threshold ⇒ on the visible flip the ad resolves to PASSIVE (the
 *       container chain's HIDDEN→PASSIVE), NOT spuriously promoted to ACTIVE.
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
let _hasFocus = false;
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

const _ioInstances = [];
global.IntersectionObserver = class IntersectionObserverStub {
  constructor(callback) {
    this._callback = callback;
    this._targets = [];
    _ioInstances.push(this);
  }
  observe(target) { this._targets.push(target); }
  unobserve(target) { this._targets = this._targets.filter((t) => t !== target); }
  disconnect() { this._targets = []; }
  _trigger(entries) { this._callback(entries, this); }
};
window.IntersectionObserver = global.IntersectionObserver;

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');
const { ContainerStates } = protoMod;

const _liveContainers = [];
function track(c) { _liveContainers.push(c); return c; }
function flushContainers() {
  while (_liveContainers.length) {
    const c = _liveContainers.pop();
    try { if (!c._terminated) c._terminate(); } catch (_) { /* ignore */ }
  }
}
process.on('beforeExit', flushContainers);

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

// ── Mock OM SDK (mirrors test-restore-level-reassert.js) ────────────────────
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

function makeAdapterContainer(extensions) {
  const prevIoCount = _ioInstances.length;
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    visible: true,
    timeouts: { createSession: 5000 },
    extensions: extensions || [],
  }));
  // OMID relay over the router is port-independent; stub the protocol send so
  // these publisher-page-only assertions don't require a live MessagePort.
  c._protocol.sendStateChange = () => {};
  c.load();
  if (_ioInstances.length === prevIoCount) {
    throw new Error('test setup: HtmlAdapter did not construct an IntersectionObserver');
  }
  return { c, io: _ioInstances[_ioInstances.length - 1] };
}

function dispatchIframeLoad(c) { c._iframe.dispatchEvent(new dom.window.Event('load')); }
function trigger(io, { isIntersecting, intersectionRatio }) {
  io._trigger([{ target: io._targets[0], isIntersecting, intersectionRatio }]);
}
function dispatchVisibilityChange() { document.dispatchEvent(new dom.window.Event('visibilitychange')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drive a permissive container LOADING → ACTIVE, then to FROZEN (bfcache entry). */
async function driveToFrozen(c, io) {
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  if (c.getState() !== ContainerStates.ACTIVE) {
    throw new Error('setup: container did not reach ACTIVE, got ' + c.getState());
  }
  window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
  await sleep(5);
  if (c.getState() !== ContainerStates.FROZEN) {
    throw new Error('setup: container did not reach FROZEN, got ' + c.getState());
  }
}

console.log('test-restore-transient-hidden.js — R3 §3.1 transient-hidden restore (audit I-1)\n');

// ── T-1 — pageshow while hidden, then flip to visible ⇒ ACTIVE + OMID VISIBLE ─
section('T-1. pageshow{persisted} while hidden (ratio≥0.5), THEN visibility→visible ⇒ container ACTIVE + OMID VISIBLE');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    _docVisibility = 'visible';
    _hasFocus = false;
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const { c, io } = makeAdapterContainer([bridge]);
    bridge.onContainerLifecycleEvent({ type: 'load', container: c });
    await driveToFrozen(c, io);
    // The adapter drove LOADING→ACTIVE, which started the OMID session and
    // signaled VISIBLE; the freeze drove it back to notVisible.
    assert(bridge._omid.sessionStarted === true, 'setup: OMID session started');
    assert(bridge._omid.lastVisibilityState === 'notVisible',
      'setup: OMID notVisible after freeze (the across-freeze level loss)');

    const visibleCountBefore = mock.stats.visibilityStates.filter((v) => v === 'VISIBLE').length;

    // === The transient-hidden restore ===
    // Real bfcache restore fires pageshow{persisted} while the document is
    // STILL hidden; the IO ratio is retained ≥0.5.
    _docVisibility = 'hidden';
    trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
    window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await sleep(5);
    // The FROZEN-exit under-resolves to HIDDEN (document still hidden).
    assert(c.getState() === ContainerStates.HIDDEN,
      'pageshow-while-hidden under-resolves to HIDDEN (the transient window)');

    // A moment later, the browser flips the page visible.
    _docVisibility = 'visible';
    dispatchVisibilityChange();
    await sleep(5);

    assert(c.getState() === ContainerStates.ACTIVE,
      'BINDING: after visibility flips, the restore re-settles to ACTIVE (baseline: stuck PASSIVE)');
    assert(bridge._omid.lastVisibilityState === 'visible',
      'BINDING: OMID reports VISIBLE after the transient-hidden restore completes (baseline: stuck notVisible)');
    const visibleCountAfter = mock.stats.visibilityStates.filter((v) => v === 'VISIBLE').length;
    assert(visibleCountAfter === visibleCountBefore + 1,
      `adEvents.stateChange('VISIBLE') fired exactly once on the completed restore (before=${visibleCountBefore}, after=${visibleCountAfter})`);
  } finally {
    uninstallMockSdk();
    flushContainers();
  }
}

// ── T-2 — exactly one FROZEN-exit across the transient restore ──────────────
section('T-2. transient-hidden restore ⇒ exactly one FROZEN-exit, no phantom edge');
{
  _docVisibility = 'visible';
  _hasFocus = false;
  const { c, io } = makeAdapterContainer();
  await driveToFrozen(c, io);

  const transitions = [];
  const realSetState = c.setState.bind(c);
  c.setState = (s) => { transitions.push(s); return realSetState(s); };

  _docVisibility = 'hidden';
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);
  _docVisibility = 'visible';
  dispatchVisibilityChange();
  await sleep(5);

  const frozenExits = transitions.filter((s) => s === ContainerStates.HIDDEN);
  assert(frozenExits.length === 1,
    `exactly one FROZEN-exit transition (the under-resolved HIDDEN) (got: ${JSON.stringify(transitions)})`);
  assert(c.getState() === ContainerStates.ACTIVE, 'final state is ACTIVE');
  // The path is the canonical HIDDEN → PASSIVE → ACTIVE — no fabricated edge.
  assert(JSON.stringify(transitions) === JSON.stringify([
    ContainerStates.HIDDEN, ContainerStates.PASSIVE, ContainerStates.ACTIVE,
  ]), `restore walks HIDDEN → PASSIVE → ACTIVE, nothing else (got: ${JSON.stringify(transitions)})`);
  flushContainers();
}

// ── T-3 — the watch is one-shot ─────────────────────────────────────────────
section('T-3. watch is one-shot ⇒ a second visibilitychange→visible does not re-drive');
{
  _docVisibility = 'visible';
  _hasFocus = false;
  const { c, io } = makeAdapterContainer();
  await driveToFrozen(c, io);

  _docVisibility = 'hidden';
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);
  _docVisibility = 'visible';
  dispatchVisibilityChange();
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'setup: restore completed to ACTIVE');
  assert(c._lifecycleAdapter._restorePending === false, 'watch disarmed after the restore completed');

  // Now demote to PASSIVE (a real partial-intersection edge), then fire another
  // bare visibilitychange→visible. If the watch were still armed it would
  // wrongly re-promote to ACTIVE.
  trigger(io, { isIntersecting: true, intersectionRatio: 0.3 });
  await sleep(5);
  assert(c.getState() === ContainerStates.PASSIVE, 'setup: demoted to PASSIVE on partial intersection');
  dispatchVisibilityChange();
  await sleep(5);
  assert(c.getState() === ContainerStates.PASSIVE,
    'a post-restore visibilitychange does NOT re-promote (watch was one-shot)');
  flushContainers();
}

// ── T-4 — transient-hidden with below-threshold ratio resolves to PASSIVE ───
section('T-4. transient-hidden restore, retained ratio BELOW threshold ⇒ resolves to PASSIVE, not ACTIVE');
{
  _docVisibility = 'visible';
  _hasFocus = false;
  const { c, io } = makeAdapterContainer();
  await driveToFrozen(c, io);

  _docVisibility = 'hidden';
  // Retain a partial ratio (below 0.5) — a transient-hidden restore should NOT
  // arm the promote watch, so the visible flip lands at PASSIVE.
  trigger(io, { isIntersecting: true, intersectionRatio: 0.3 });
  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);
  assert(c.getState() === ContainerStates.HIDDEN, 'pageshow-while-hidden under-resolves to HIDDEN');
  assert(c._lifecycleAdapter._restorePending === false,
    'below-threshold ratio does NOT arm the promote watch');

  _docVisibility = 'visible';
  dispatchVisibilityChange();
  await sleep(5);
  assert(c.getState() === ContainerStates.PASSIVE,
    'visible flip with partial intersection resolves to PASSIVE (container chain), not spuriously ACTIVE');
  flushContainers();
}

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} transient-hidden restore assertion(s) failed.`);
  process.exit(1);
}
console.log('✓ All transient-hidden restore assertions passed.');
