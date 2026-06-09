/**
 * test-active-frozen-edge.js — issue #340 coverage
 *
 * Direct ACTIVE→FROZEN and PASSIVE→FROZEN state edges.
 *
 * Audit finding NEW-B / F5 (`docs/design/0.7.10-lifecycle-state-mapping-audit.md`
 * §2.2 G-A, Rec R2): before #340 the container state machine had only a
 * `HIDDEN → FROZEN` edge, so the HTML lifecycle adapter walked
 * `ACTIVE → HIDDEN → FROZEN` on every bfcache/freeze entry from a visible
 * state. That intermediate `HIDDEN` is a real `stateChange('hidden')` the
 * creative never actually experienced — a phantom "scrolled off-screen"
 * event fabricated immediately before the freeze.
 *
 * This suite is the RED→GREEN contract for the fix:
 *   - Freezing from ACTIVE emits exactly `active → frozen` — no intervening
 *     HIDDEN in the transition history, and the creative's `onStateChange`
 *     observer never sees a phantom `hidden`.
 *   - Freezing from PASSIVE emits exactly `passive → frozen`.
 *   - A GENUINE offscreen-then-freeze (`active → hidden` via intersection,
 *     THEN freeze) still walks `hidden → frozen` — the HIDDEN→FROZEN edge is
 *     preserved (it must not be removed; a real offscreen freeze needs it).
 *   - The thaw/restore path (`frozen → {active|passive|hidden}`) is intact.
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
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return 'visible'; },
});
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

// ── IntersectionObserver stub (mirrors test-html-lifecycle-adapter.js) ──────
const _ioInstances = [];
class IOStub {
  constructor(cb) {
    this._cb = cb;
    this._targets = [];
    _ioInstances.push(this);
  }
  observe(t) { this._targets.push(t); }
  unobserve() {}
  disconnect() { this._targets = []; }
  _trigger(entries) { this._cb(entries, this); }
}
global.IntersectionObserver = IOStub;
dom.window.IntersectionObserver = IOStub;

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { ContainerStates } = protoMod;

// ── Container tracking / teardown ───────────────────────────────────────────
const _tracked = [];
function track(c) { _tracked.push(c); return c; }
function flushContainers() {
  while (_tracked.length) {
    const c = _tracked.pop();
    try { c.close(); } catch { /* already closed */ }
  }
}
process.on('beforeExit', flushContainers);

// ── Assertion harness ───────────────────────────────────────────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

function makeContainer(overrides = {}) {
  const prevIoCount = _ioInstances.length;
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    timeouts: { createSession: 5000 },
    ...overrides,
  }));
  c.load();
  const io = _ioInstances[_ioInstances.length - 1];
  if (_ioInstances.length === prevIoCount) {
    throw new Error('test setup: HtmlAdapter did not construct an IntersectionObserver');
  }
  return { c, io };
}

function dispatchIframeLoad(c) {
  c._iframe.dispatchEvent(new dom.window.Event('load'));
}

function trigger(io, { isIntersecting, intersectionRatio }) {
  io._trigger([{ target: io._targets[0], isIntersecting, intersectionRatio }]);
}

function dispatchPagehide() {
  const evt = new dom.window.Event('pagehide');
  Object.defineProperty(evt, 'persisted', { value: true });
  window.dispatchEvent(evt);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('test-active-frozen-edge.js — issue #340 direct ACTIVE/PASSIVE → FROZEN edges\n');

// -- 1. ACTIVE → FROZEN: direct edge, NO phantom HIDDEN (freeze event) -------
{
  console.log('1. freeze from ACTIVE → frozen directly (no phantom HIDDEN)');
  const transitions = [];
  const { c, io } = makeContainer({
    onStateChange: (s, prev) => transitions.push(`${prev}->${s}`),
  });
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  const before = transitions.length;
  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);

  assert(c.getState() === ContainerStates.FROZEN, 'post: FROZEN');
  const freezeTransitions = transitions.slice(before);
  assert(freezeTransitions.length === 1,
    `exactly one transition on freeze (got: ${JSON.stringify(freezeTransitions)})`);
  assert(freezeTransitions[0] === 'active->frozen',
    'the single transition is active->frozen (direct edge)');
  assert(!transitions.includes('active->hidden'),
    'NO phantom active->hidden emitted on the freeze path');
  assert(!freezeTransitions.includes('hidden->frozen'),
    'NO intervening hidden->frozen on the freeze path');
}
flushContainers();

// -- 2. ACTIVE → FROZEN via pagehide(persisted) — same no-phantom guarantee --
{
  console.log('\n2. pagehide(persisted) from ACTIVE → frozen directly (no phantom HIDDEN)');
  const transitions = [];
  const { c, io } = makeContainer({
    onStateChange: (s, prev) => transitions.push(`${prev}->${s}`),
  });
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  const before = transitions.length;
  dispatchPagehide();
  await sleep(5);

  assert(c.getState() === ContainerStates.FROZEN, 'post: FROZEN');
  const freezeTransitions = transitions.slice(before);
  assert(freezeTransitions.length === 1
    && freezeTransitions[0] === 'active->frozen',
    `exactly active->frozen on pagehide (got: ${JSON.stringify(freezeTransitions)})`);
  assert(!transitions.includes('active->hidden'),
    'NO phantom active->hidden on the pagehide path');
}
flushContainers();

// -- 3. PASSIVE → FROZEN: direct edge, NO phantom HIDDEN ---------------------
{
  console.log('\n3. freeze from PASSIVE → frozen directly (no phantom HIDDEN)');
  const transitions = [];
  const { c, io } = makeContainer({
    onStateChange: (s, prev) => transitions.push(`${prev}->${s}`),
  });
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  // Partial visibility demotes ACTIVE → PASSIVE.
  trigger(io, { isIntersecting: true, intersectionRatio: 0.3 });
  await sleep(5);
  assert(c.getState() === ContainerStates.PASSIVE, 'pre: PASSIVE');

  const before = transitions.length;
  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);

  assert(c.getState() === ContainerStates.FROZEN, 'post: FROZEN');
  const freezeTransitions = transitions.slice(before);
  assert(freezeTransitions.length === 1
    && freezeTransitions[0] === 'passive->frozen',
    `exactly passive->frozen on freeze (got: ${JSON.stringify(freezeTransitions)})`);
  assert(!freezeTransitions.includes('passive->hidden'),
    'NO phantom passive->hidden on the freeze path');
  assert(!freezeTransitions.includes('hidden->frozen'),
    'NO intervening hidden->frozen on the freeze path');
}
flushContainers();

// -- 4. GENUINE offscreen-then-freeze: hidden->frozen edge PRESERVED ---------
//    The creative really did go offscreen (intersection 0 → HIDDEN) BEFORE
//    the freeze. This is a real hidden->frozen sequence and must remain
//    legal — the HIDDEN→FROZEN edge must NOT be removed by #340.
{
  console.log('\n4. genuine offscreen (ACTIVE→HIDDEN) then freeze → hidden->frozen preserved');
  const transitions = [];
  const { c, io } = makeContainer({
    onStateChange: (s, prev) => transitions.push(`${prev}->${s}`),
  });
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  // Real scroll-off-screen first: intersection 0 → HIDDEN.
  trigger(io, { isIntersecting: false, intersectionRatio: 0 });
  await sleep(5);
  assert(c.getState() === ContainerStates.HIDDEN, 'mid: HIDDEN (genuine offscreen)');

  const before = transitions.length;
  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);

  assert(c.getState() === ContainerStates.FROZEN, 'post: FROZEN');
  const freezeTransitions = transitions.slice(before);
  assert(freezeTransitions.length === 1
    && freezeTransitions[0] === 'hidden->frozen',
    `genuine offscreen freeze still walks hidden->frozen (got: ${JSON.stringify(freezeTransitions)})`);
  assert(transitions.includes('active->hidden'),
    'the active->hidden was the REAL intersection event, not a fabricated one');
}
flushContainers();

// -- 5. Thaw/restore path intact: FROZEN → ACTIVE on pageshow ----------------
{
  console.log('\n5. thaw: frozen → active on pageshow(persisted) when visible');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);
  assert(c.getState() === ContainerStates.FROZEN, 'pre: FROZEN');

  const pageshowEvt = new dom.window.Event('pageshow');
  Object.defineProperty(pageshowEvt, 'persisted', { value: true });
  window.dispatchEvent(pageshowEvt);
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE,
    'frozen → active restore intact (thaw path unaffected by #340)');
}
flushContainers();

// -- 6. Transition table: direct edges accepted; HIDDEN→FROZEN still legal ---
{
  console.log('\n6. transition-table: ACTIVE→FROZEN, PASSIVE→FROZEN, HIDDEN→FROZEN all legal');
  const { c } = makeContainer();
  c.setState(ContainerStates.ACTIVE);
  assert(c.setState(ContainerStates.FROZEN) === true,
    'ACTIVE → FROZEN accepted by setState');
  flushContainers();

  const { c: c2 } = makeContainer();
  c2.setState(ContainerStates.ACTIVE);
  c2.setState(ContainerStates.PASSIVE);
  assert(c2.setState(ContainerStates.FROZEN) === true,
    'PASSIVE → FROZEN accepted by setState');
  flushContainers();

  const { c: c3 } = makeContainer();
  c3.setState(ContainerStates.ACTIVE);
  c3.setState(ContainerStates.HIDDEN);
  assert(c3.setState(ContainerStates.FROZEN) === true,
    'HIDDEN → FROZEN still accepted by setState (edge preserved)');
}
flushContainers();

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('All test-active-frozen-edge.js assertions passed.');
  process.exit(0);
} else {
  console.error(`${failures} assertion(s) failed.`);
  process.exit(1);
}
