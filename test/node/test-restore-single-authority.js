/**
 * test-restore-single-authority.js — R3 §3.1 single restore authority (#338)
 *
 * Per ADR docs/design/0.7.11-bfcache-omid-relink-r3.md §3.1 / §6.1, INV-R1..R3.
 *
 * RC-2: two uncoordinated restore drivers race on a bfcache/freeze restore —
 * the container chain's `_onResume` (focus-based, NO intersection signal) and
 * the HTML adapter's `_onPageshow → _transitionFromFrozen` / `_onResume`
 * (IntersectionObserver-based). Whichever moves the container out of FROZEN
 * first makes the other a no-op; the container chain under-resolves a
 * visible-but-unfocused page to PASSIVE.
 *
 * R3 §3.1 (audit R4): designate ONE restore authority. When a lifecycle
 * adapter is attached, the adapter owns FROZEN-exit (it holds the intersection
 * ratio, so it resolves the correct destination) and the container's `_onResume`
 * MUST yield. When NO adapter is attached (native-SHARC), the container chain
 * remains the authority. This mirrors the existing strict-LOADING yield
 * (html-adapter.js _maybeAdvanceToActive / _transitionToFrozen).
 *
 * Coverage:
 *   R-1 [RED→GREEN] adapter attached, pageshow{persisted} from FROZEN with
 *       intersection≥0.5 + visible ⇒ exactly ONE setState(ACTIVE); the
 *       container _onResume does NOT independently drive. (INV-R1, INV-R2)
 *   R-2 [RED→GREEN] restore visible-but-unfocused + intersecting≥0.5 ⇒
 *       destination ACTIVE (not the container chain's PASSIVE under-resolution).
 *       (INV-R3)
 *   R-3 [GREEN-guard] no adapter attached ⇒ container _onResume IS the
 *       authority and resolves the restore (native-SHARC path unbroken). (INV-R1)
 *   R-4 [RED→GREEN] both pageshow{persisted} and resume fire for one logical
 *       restore ⇒ still exactly ONE FROZEN-exit transition (idempotent second
 *       driver). (INV-R2)
 *
 * Runs in Node after `npm run build`.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html', pretendToBeVisual: true },
);
global.window = dom.window;
global.document = dom.window.document;
// Force visible — jsdom defaults to 'prerender'.
let _docVisibility = 'visible';
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return _docVisibility; },
});
// hasFocus is the container _onResume's only "active vs passive" lever. Default
// it to false so a naive container-chain resolution would under-resolve to
// PASSIVE — the exact RC-2 window R3 closes via the adapter authority.
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
  constructor(callback, options) {
    this._callback = callback;
    this._options = options || {};
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

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

function makeAdapterContainer(overrides = {}) {
  const prevIoCount = _ioInstances.length;
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    visible: true,
    timeouts: { createSession: 5000 },
    ...overrides,
  }));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drive a permissive container LOADING → ACTIVE, then to FROZEN (bfcache entry). */
async function driveToFrozen(c, io) {
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  if (c.getState() !== ContainerStates.ACTIVE) {
    throw new Error('setup: container did not reach ACTIVE, got ' + c.getState());
  }
  // bfcache entry — pagehide{persisted} drives ACTIVE → FROZEN (direct edge #340).
  window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
  await sleep(5);
  if (c.getState() !== ContainerStates.FROZEN) {
    throw new Error('setup: container did not reach FROZEN, got ' + c.getState());
  }
}

console.log('test-restore-single-authority.js — R3 §3.1 single restore authority\n');

// ── R-1 — adapter attached: exactly one setState(ACTIVE) on restore ─────────
{
  console.log('R-1. adapter attached, pageshow{persisted} from FROZEN (intersect≥0.5, visible, UNFOCUSED) ⇒ one setState(ACTIVE)');
  _docVisibility = 'visible';
  _hasFocus = false; // visible-but-unfocused — the RC-2 under-resolution trap.
  const { c, io } = makeAdapterContainer();
  await driveToFrozen(c, io);

  // Spy on setState to count FROZEN-exit transitions.
  const transitions = [];
  const realSetState = c.setState.bind(c);
  c.setState = (s) => { transitions.push(s); return realSetState(s); };

  // Latest intersection snapshot is still ≥0.5 visible.
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  // Real bfcache restore: pageshow{persisted:true}.
  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);

  assert(c.getState() === ContainerStates.ACTIVE,
    'restore resolves to ACTIVE (adapter authority used the intersection ratio)');
  const exits = transitions.filter((s) => s !== ContainerStates.FROZEN);
  assert(exits.length === 1 && exits[0] === ContainerStates.ACTIVE,
    `exactly one FROZEN-exit transition, and it is ACTIVE (got: ${JSON.stringify(transitions)})`);
}
flushContainers();

// ── R-2 — visible-but-unfocused resolves to ACTIVE, not PASSIVE ─────────────
{
  console.log('\nR-2. restore visible-but-unfocused + intersecting≥0.5 ⇒ destination ACTIVE (not PASSIVE under-resolution)');
  _docVisibility = 'visible';
  _hasFocus = false;
  const { c, io } = makeAdapterContainer();
  await driveToFrozen(c, io);

  trigger(io, { isIntersecting: true, intersectionRatio: 0.8 });
  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);

  assert(c.getState() === ContainerStates.ACTIVE,
    'visible-unfocused-but-intersecting restore resolves to ACTIVE (INV-R3)');
}
flushContainers();

// ── R-3 — no adapter attached: container _onResume is the authority ─────────
{
  console.log('\nR-3. no adapter attached ⇒ container _onResume resolves the restore (native-SHARC path)');
  _docVisibility = 'visible';
  _hasFocus = true; // focused → container chain resolves FROZEN → ACTIVE.
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    visible: true,
    timeouts: { createSession: 5000 },
  }));
  // Do NOT call load() with an adapter — instead drive the state machine
  // directly and detach any adapter so the container chain is the only driver.
  c.load();
  if (c._lifecycleAdapter) { c._lifecycleAdapter.detach(); c._lifecycleAdapter = null; }
  // Drive to FROZEN via the container chain.
  c.setState(ContainerStates.ACTIVE);
  c.setState(ContainerStates.FROZEN);
  assert(c.getState() === ContainerStates.FROZEN, 'setup: container is FROZEN');

  // Container _onResume should resolve FROZEN → ACTIVE (visible + focused).
  c._onResume();
  assert(c.getState() === ContainerStates.ACTIVE,
    'no-adapter container _onResume resolves FROZEN → ACTIVE (authority unbroken)');
}
flushContainers();

// ── R-4 — both pageshow and resume fire ⇒ still one FROZEN-exit ──────────────
{
  console.log('\nR-4. both pageshow{persisted} and resume fire for one restore ⇒ exactly one FROZEN-exit');
  _docVisibility = 'visible';
  _hasFocus = false;
  const { c, io } = makeAdapterContainer();
  await driveToFrozen(c, io);

  const transitions = [];
  const realSetState = c.setState.bind(c);
  c.setState = (s) => { transitions.push(s); return realSetState(s); };

  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  // Both restore events for the same logical restore.
  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  document.dispatchEvent(new dom.window.Event('resume'));
  await sleep(5);

  const exits = transitions.filter((s) => s !== ContainerStates.FROZEN);
  assert(exits.length === 1,
    `exactly one FROZEN-exit transition across both events (got: ${JSON.stringify(transitions)})`);
  assert(c.getState() === ContainerStates.ACTIVE,
    'final state is ACTIVE');
}
flushContainers();

// ── R-5 — resume-only (OS-freeze) path: no double-drive (the binding RED) ────
// This is the canonical RC-2 race. On `resume` (NOT pageshow), the container
// chain's _onResume runs first and under-resolves a visible-but-UNFOCUSED page
// to PASSIVE; the adapter's _onResume then promotes PASSIVE → ACTIVE. Baseline
// therefore takes TWO FROZEN-exit-region transitions: passive, then active.
// After §3.1 the container _onResume yields to the adapter, and the adapter
// resolves FROZEN → ACTIVE directly via the intersection ratio — exactly ONE
// transition into ACTIVE, no PASSIVE flicker. (INV-R1, INV-R2, INV-R3)
{
  console.log('\nR-5. resume-only (OS-freeze) restore, visible-but-unfocused ⇒ no PASSIVE flicker, one ACTIVE exit');
  _docVisibility = 'visible';
  _hasFocus = false;
  const { c, io } = makeAdapterContainer();
  await driveToFrozen(c, io);

  const transitions = [];
  const realSetState = c.setState.bind(c);
  c.setState = (s) => { transitions.push(s); return realSetState(s); };

  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  document.dispatchEvent(new dom.window.Event('resume'));
  await sleep(5);

  const exits = transitions.filter((s) => s !== ContainerStates.FROZEN);
  assert(exits.length === 1 && exits[0] === ContainerStates.ACTIVE,
    `exactly one FROZEN-exit and it is ACTIVE — no PASSIVE under-resolution flicker (got: ${JSON.stringify(transitions)})`);
  assert(c.getState() === ContainerStates.ACTIVE, 'final state is ACTIVE');
}
flushContainers();

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} single-restore-authority assertion(s) failed.`);
  process.exit(1);
}
console.log('✓ All single-restore-authority assertions passed.');
