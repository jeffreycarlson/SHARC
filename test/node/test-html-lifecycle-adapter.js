/**
 * test-html-lifecycle-adapter.js — issue #89 PR 2 coverage (design § 15.4)
 *
 * Targeted jsdom coverage for the HTML lifecycle adapter introduced by
 * 0.7.2 first-half PR 2 (design § 8). Asserts the event-to-state mapping
 * table from § 8.3 end-to-end against a real SHARCContainer + jsdom DOM,
 * with `IntersectionObserver` stubbed for explicit triggering.
 *
 * Coverage matrix (§ 15.4):
 *   - Iframe load fires first, then intersection ≥ 50% → exactly one
 *     LOADING → ACTIVE transition.
 *   - Intersection fires first, then iframe load → same outcome (coalesced).
 *   - Iframe loads off-screen, then scrolls in → LOADING → ACTIVE on
 *     intersection ≥ 50%.
 *   - Partial visibility (0.3) while ACTIVE → ACTIVE → PASSIVE.
 *   - Full hide (isIntersecting: false) while ACTIVE → ACTIVE → HIDDEN.
 *   - Return from PASSIVE to ≥ 50% → PASSIVE → ACTIVE.
 *   - `pagehide` with persisted: true → * → FROZEN.
 *   - `pageshow` with persisted: true → FROZEN → ACTIVE (if visible).
 *   - `freeze` event → * → FROZEN.
 *   - `resume` event → FROZEN → ACTIVE / PASSIVE per visibility.
 *   - Adapter coexistence: handshake fires first, adapter does NOT
 *     duplicate LOADING → ACTIVE; subsequent visibility transitions still
 *     fire from adapter.
 *   - Adapter `detach()` after `close()` → no further transitions on
 *     subsequent event dispatch.
 *   - bfcache restoration flag — dispatchable as event; real bfcache is
 *     NOT modeled in jsdom (Chrome-only end-to-end; § 8.4).
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
// jsdom defaults `document.visibilityState` to `'prerender'`; both the
// container's existing `_onResume` and the HtmlAdapter's
// `_transitionFromFrozen` correctly treat that as not-visible. Override
// to `'visible'` for the tests that assert ACTIVE post-bfcache (#8) and
// post-resume (#10). Real browsers set this to `'visible'` whenever the
// tab is active; `'prerender'` only appears during Chrome's experimental
// prerender flow, which isn't relevant to the bfcache restoration scenarios
// these tests cover.
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
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

// ── IntersectionObserver stub ──────────────────────────────────────────────
// jsdom does not ship an IntersectionObserver. The HTML adapter constructs
// one in `attach()`; this stub captures each instance so tests can fire
// entries on demand. Implements the minimum surface the adapter uses:
// `observe`, `unobserve`, `disconnect`, plus a non-standard `_trigger`
// helper that calls the registered callback.
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

// ── Pre-load protocol exports onto window.SHARC.Protocol ──────────────────
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { ContainerStates } = protoMod;

// ── Container hygiene ─────────────────────────────────────────────────────
const _liveContainers = [];
function track(c) { _liveContainers.push(c); return c; }
function flushContainers() {
  while (_liveContainers.length) {
    const c = _liveContainers.pop();
    try { if (!c._terminated) c._terminate(); } catch (_) { /* ignore */ }
  }
}
process.on('beforeExit', flushContainers);

// ── Assertion harness ─────────────────────────────────────────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

/**
 * Build a permissive URL-variant container, call load(), and return the
 * container plus the most recently constructed IntersectionObserver
 * instance from the stub.
 */
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
  // Sanity: adapter wired a new IO.
  if (_ioInstances.length === prevIoCount) {
    throw new Error('test setup: HtmlAdapter did not construct an IntersectionObserver');
  }
  return { c, io };
}

function dispatchIframeLoad(c) {
  c._iframe.dispatchEvent(new dom.window.Event('load'));
}

function trigger(io, { isIntersecting, intersectionRatio }) {
  io._trigger([{
    target: io._targets[0],
    isIntersecting,
    intersectionRatio,
  }]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('test-html-lifecycle-adapter.js — issue #89 PR 2 / § 15.4 coverage\n');

// -- 1. Iframe load first, then intersection ≥ 0.5 → LOADING → ACTIVE ------
{
  console.log('1. Iframe load first, then intersection ≥ 0.5 → LOADING → ACTIVE (single transition)');
  const transitions = [];
  const { c, io } = makeContainer({
    onStateChange: (s, prev) => transitions.push(`${prev}->${s}`),
  });

  dispatchIframeLoad(c);
  await sleep(5);
  // No intersection yet — gate not met.
  assert(c.getState() === ContainerStates.LOADING,
    'iframe-load alone (no intersection) keeps state in LOADING');

  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE,
    'both gates met → state is ACTIVE');
  const activeTransitions = transitions.filter((t) => t === 'loading->active');
  assert(activeTransitions.length === 1,
    'exactly one LOADING → ACTIVE transition fired');
}
flushContainers();

// -- 2. Intersection first, then iframe load → coalesced single transition -
{
  console.log('\n2. Intersection first, then iframe load → LOADING → ACTIVE (coalesced)');
  const transitions = [];
  const { c, io } = makeContainer({
    onStateChange: (s, prev) => transitions.push(`${prev}->${s}`),
  });

  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.LOADING,
    'intersection alone (no iframe-load) keeps state in LOADING');

  dispatchIframeLoad(c);
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE,
    'iframe-load completes the gate → state is ACTIVE');
  const activeTransitions = transitions.filter((t) => t === 'loading->active');
  assert(activeTransitions.length === 1,
    'exactly one LOADING → ACTIVE transition fired (coalesced)');
}
flushContainers();

// -- 3. Iframe loads off-screen, then scrolls into view --------------------
{
  console.log('\n3. Iframe loads off-screen, then scrolls into view → LOADING → ACTIVE on intersection');
  const { c, io } = makeContainer();

  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: false, intersectionRatio: 0 });
  await sleep(5);
  assert(c.getState() === ContainerStates.LOADING,
    'iframe-load + 0% visibility → stays in LOADING');

  trigger(io, { isIntersecting: true, intersectionRatio: 0.8 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE,
    'subsequent ≥ 0.5 intersection advances LOADING → ACTIVE');
}
flushContainers();

// -- 4. Partial visibility (ratio 0.3) while ACTIVE → ACTIVE → PASSIVE -----
{
  console.log('\n4. Partial visibility (0 < ratio < 0.5) in ACTIVE → ACTIVE → PASSIVE');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  trigger(io, { isIntersecting: true, intersectionRatio: 0.3 });
  await sleep(5);
  assert(c.getState() === ContainerStates.PASSIVE,
    'partial intersection demotes ACTIVE → PASSIVE');
}
flushContainers();

// -- 5. Full hide (isIntersecting: false) in ACTIVE → ACTIVE → HIDDEN ------
{
  console.log('\n5. Full hide (isIntersecting: false) in ACTIVE → ACTIVE → HIDDEN');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  trigger(io, { isIntersecting: false, intersectionRatio: 0 });
  await sleep(5);
  assert(c.getState() === ContainerStates.HIDDEN,
    'isIntersecting=false demotes ACTIVE → HIDDEN');
}
flushContainers();

// -- 6. Return from PASSIVE to ≥ 0.5 visibility → PASSIVE → ACTIVE ---------
{
  console.log('\n6. Return from PASSIVE to ≥ 0.5 visibility → PASSIVE → ACTIVE');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.3 });
  await sleep(5);
  assert(c.getState() === ContainerStates.PASSIVE, 'pre: PASSIVE');

  trigger(io, { isIntersecting: true, intersectionRatio: 0.75 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE,
    'PASSIVE → ACTIVE when intersection returns to ≥ 0.5');
}
flushContainers();

// -- 7. pagehide with persisted: true → * → FROZEN -------------------------
{
  console.log('\n7. pagehide with persisted: true → * → FROZEN');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  const evt = new dom.window.Event('pagehide');
  Object.defineProperty(evt, 'persisted', { value: true });
  window.dispatchEvent(evt);
  await sleep(5);
  assert(c.getState() === ContainerStates.FROZEN,
    'pagehide(persisted=true) walks ACTIVE → HIDDEN → FROZEN');
}
flushContainers();

// -- 8. pageshow with persisted: true → FROZEN → ACTIVE (if visible) -------
//    bfcache restoration: dispatchable as event; the real bfcache roundtrip
//    is NOT modeled in jsdom. This is the Chrome-only end-to-end gap per
//    § 8.4 — Puppeteer follow-up.
{
  console.log('\n8. pageshow with persisted: true → FROZEN → ACTIVE (if visible)');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);

  // Walk into FROZEN.
  const pagehideEvt = new dom.window.Event('pagehide');
  Object.defineProperty(pagehideEvt, 'persisted', { value: true });
  window.dispatchEvent(pagehideEvt);
  await sleep(5);
  assert(c.getState() === ContainerStates.FROZEN, 'pre: FROZEN');

  // (visibility stays at ratio 0.9 in the adapter's cache; jsdom's
  // document.visibilityState defaults to 'visible'.)
  const pageshowEvt = new dom.window.Event('pageshow');
  Object.defineProperty(pageshowEvt, 'persisted', { value: true });
  window.dispatchEvent(pageshowEvt);
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE,
    'pageshow(persisted=true) restores FROZEN → ACTIVE when visible');
}
flushContainers();

// -- 9. freeze event → * → FROZEN ------------------------------------------
{
  console.log('\n9. freeze event → * → FROZEN');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);
  assert(c.getState() === ContainerStates.FROZEN,
    'freeze walks ACTIVE → HIDDEN → FROZEN');
}
flushContainers();

// -- 10. resume event → FROZEN → ACTIVE per visibility ---------------------
{
  console.log('\n10. resume event → FROZEN → ACTIVE / PASSIVE per visibility');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);

  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);
  assert(c.getState() === ContainerStates.FROZEN, 'pre: FROZEN');

  document.dispatchEvent(new dom.window.Event('resume'));
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE,
    'resume → ACTIVE when adapter remembers full intersection');
}
flushContainers();

// -- 11. Adapter coexistence: handshake fires first → no duplicate --------
//    § 8.2: when a SHARC-aware creative handshakes, the handshake-driven
//    path runs LOADING → READY → ACTIVE first. The adapter must NOT
//    duplicate LOADING → ACTIVE; subsequent visibility transitions still
//    fire from the adapter.
{
  console.log('\n11. Adapter coexistence: handshake-driven ACTIVE → adapter does not duplicate');
  const transitions = [];
  const { c, io } = makeContainer({
    onStateChange: (s, prev) => transitions.push(`${prev}->${s}`),
  });

  // Simulate handshake-driven progression. Use the state machine
  // directly to avoid the protocol-port handshake (jsdom MessageChannel
  // limitation) — the seam under test is the adapter's behavior, not
  // the handshake plumbing.
  c.setState(ContainerStates.READY);
  c.setState(ContainerStates.ACTIVE);
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: handshake drove to ACTIVE');

  const beforeCount = transitions.length;
  // Now fire iframe-load + intersection. The adapter must observe that
  // state is already ACTIVE and yield silently.
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  // No further state change — adapter yielded.
  assert(transitions.length === beforeCount,
    'adapter does NOT fire duplicate LOADING → ACTIVE when state is already ACTIVE');

  // But subsequent visibility transitions still fire.
  trigger(io, { isIntersecting: true, intersectionRatio: 0.3 });
  await sleep(5);
  assert(c.getState() === ContainerStates.PASSIVE,
    'adapter still drives ACTIVE → PASSIVE on subsequent partial visibility');
}
flushContainers();

// -- 12. Adapter detach after close() → no further transitions -------------
{
  console.log('\n12. Adapter detach after close() → no transitions on subsequent event dispatch');
  const { c, io } = makeContainer();
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: ACTIVE');

  c._terminate();
  assert(c._terminated === true, 'container terminated');
  assert(c._lifecycleAdapter === null, '_lifecycleAdapter cleared after _terminate');

  // Fire events that previously transitioned — should be no-ops because
  // the adapter has detached and disconnected the IO.
  try {
    io._trigger([{
      target: io._targets[0],
      isIntersecting: false,
      intersectionRatio: 0,
    }]);
  } catch (_) { /* IO disconnect cleared targets — trigger may no-op */ }
  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);
  assert(c.getState() === ContainerStates.TERMINATED,
    'terminated container stays in TERMINATED — adapter listeners detached');
}
flushContainers();

// -- 13. bfcache restoration flag — dispatchable; real bfcache not modeled
//     in jsdom. The pageshow(persisted=true) event roundtrip IS testable as
//     event-dispatch (see #8); this guard documents the gap explicitly so
//     a future reviewer doesn't expect a deeper assertion.
{
  console.log('\n13. bfcache restoration — event-dispatch testable; full roundtrip is Chrome-only (§ 8.4)');
  // We already exercised the pagehide/pageshow event surface in #7 + #8.
  // This case explicitly documents that the bfcache itself (the "page
  // re-runs from snapshot" semantic) is NOT modeled in jsdom — only the
  // event dispatch is. Puppeteer follow-up tracks the gap; not blocking
  // for 0.7.2 ship.
  assert(true,
    'documented: bfcache event-dispatch covered in #7/#8; full Chrome roundtrip is follow-up scope');
}
flushContainers();

// ===========================================================================
// Round-3 fixes (OpenClaw review 2026-05-16) — regression coverage
// ===========================================================================

// -- 14. Strict mode + LOADING + freeze: adapter must NOT walk to FROZEN ---
//    Regression for OpenClaw Finding 1: walking LOADING → ACTIVE → HIDDEN →
//    FROZEN in strict mode corrupts the handshake-driven path. A later
//    setState(READY) from _handleInitResolved would be invalid from FROZEN.
{
  console.log('\n14. Strict mode + LOADING + freeze: adapter must NOT walk to FROZEN');
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    // requireSharcInit omitted → defaults to true (strict)
    timeouts: { createSession: 5000 },
  }));
  c.load();
  assert(c._requireSharcInit === true, 'pre: strict mode active');
  assert(c.getState() === ContainerStates.LOADING, 'pre: state is LOADING');

  // Fire freeze while in LOADING (handshake hasn't completed).
  document.dispatchEvent(new dom.window.Event('freeze'));
  await sleep(5);

  assert(c.getState() === ContainerStates.LOADING,
    'strict + LOADING + freeze: state remains LOADING (adapter yields to handshake)');

  // Also try pagehide(persisted=true).
  const pagehideEvt = new dom.window.Event('pagehide');
  Object.defineProperty(pagehideEvt, 'persisted', { value: true });
  window.dispatchEvent(pagehideEvt);
  await sleep(5);

  assert(c.getState() === ContainerStates.LOADING,
    'strict + LOADING + pagehide(persisted): state remains LOADING (adapter yields)');

  // Verify a subsequent setState(READY) (simulating handshake catch-up after
  // bfcache restore) is still legal — would be invalid if state had moved
  // to FROZEN.
  const ok = c.setState(ContainerStates.READY);
  assert(ok === true,
    'after freeze/pagehide in LOADING: setState(READY) is still legal (LOADING → READY edge intact)');

  // Stronger assertion: the full handshake-driven catch-up path runs
  // cleanly after the freeze/pagehide attempts. This is what OpenClaw
  // Finding 1 was actually about — not just "edge is callable" but
  // "handshake path actually completes without warns."
  const warnOutput = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };
  // Reset state to LOADING for a clean run of the catch-up simulation.
  // (We previously moved to READY for the edge-legality probe.)
  c._stateMachine.state = ContainerStates.LOADING;
  c._handleInitResolved({});
  console.warn = origWarn;
  const invalidWarnAfterFreeze = warnOutput.find((line) => /Invalid transition/.test(line));
  assert(!invalidWarnAfterFreeze,
    'handshake-driven `_handleInitResolved` runs cleanly after strict-mode-LOADING freeze attempts (no invalid-transition warns)');
}
flushContainers();

// -- 15. Permissive + late SHARC handshake after adapter ACTIVE: no warns --
//    Regression for OpenClaw Finding 2: adapter advanced to ACTIVE, then late
//    handshake arrives. _handleInitResolved must skip setState(READY) since
//    state is already past; _transitionToActive must skip setState(ACTIVE)
//    since state is already there. No "Invalid transition" warns.
//    `autoStart: false` so the synthetic _handleInitResolved doesn't call
//    _sendStartCreative (no port in this jsdom setup → would fatal-error).
{
  console.log('\n15. Permissive + late handshake after adapter ACTIVE: handshake catch-up clean');
  const { c, io } = makeContainer({ autoStart: false });
  dispatchIframeLoad(c);
  trigger(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  assert(c.getState() === ContainerStates.ACTIVE, 'pre: adapter advanced to ACTIVE');

  // Capture state-machine warns during the synthetic handshake catch-up.
  const warnOutput = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };

  // Simulate _handleInitResolved (post-handshake init resolve). autoStart
  // is false so this only attempts the setState(READY) — which our fix
  // makes a no-op when state is already past LOADING.
  c._handleInitResolved({});
  // Simulate _handleStartCreativeResolved (start resolve). Calls
  // _transitionToActive which our fix makes a no-op when state is
  // already ACTIVE.
  c._handleStartCreativeResolved();
  await sleep(5);
  console.warn = origWarn;

  // Pin the negative to the broad "no invalid-transition warn at all"
  // claim — earlier arrow-constrained regex could miss a regression that
  // fired a different invalid transition during the catch-up path.
  const invalidTransitionWarn = warnOutput.find((line) =>
    /Invalid transition/.test(line)
  );
  assert(!invalidTransitionWarn,
    'no "Invalid transition" warn of any kind during handshake catch-up after adapter promotion');
  assert(c.getState() === ContainerStates.ACTIVE,
    'state remains ACTIVE after handshake catch-up (adapter promotion preserved)');
}
flushContainers();

// -- 16. No-IntersectionObserver fallback: Markup variant gate re-triggers --
//    Regression for OpenClaw Finding 3: in environments without
//    IntersectionObserver, _onRendererRendered must poke the adapter so the
//    Markup-variant `creativeRendered` gate closes. Otherwise container
//    stays stuck in LOADING.
{
  console.log('\n16. No-IO Markup fallback: _onRendererRendered re-triggers adapter gate');
  // Temporarily disable the IO stub to simulate the degraded environment.
  const SavedIO = global.IntersectionObserver;
  delete global.IntersectionObserver;
  try {
    const c = track(new SHARCContainer({
      creativeHtml: '<html><body>x</body></html>',
      creativeRendererUrl: 'https://r.example/r',
      placementElement: freshSlot(),
      requireSharcInit: false,
      timeouts: { createSession: 5000 },
    }));
    c.load();
    assert(c._lifecycleAdapter._intersectionObserver === null,
      'pre: no IntersectionObserver (degraded fallback active)');

    // Iframe load fires (renderer doc) → Markup gate keeps container in LOADING.
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    await sleep(5);
    assert(c.getState() === ContainerStates.LOADING,
      'pre: Markup variant LOADING with creativeRendered=false → gated, not advanced');

    // Now simulate the renderer protocol completing.
    c.creativeRendered = true;
    c._lifecycleAdapter._maybeAdvanceToActive();
    // (In production, _onRendererRendered would poke the adapter — this test
    // verifies the explicit poke path that _onRendererRendered now uses.)
    await sleep(5);
    assert(c.getState() === ContainerStates.ACTIVE,
      'after creativeRendered flips + adapter poke: advanced to ACTIVE');
  } finally {
    global.IntersectionObserver = SavedIO;
  }
}
flushContainers();

// -- 17. Wiring: _onRendererRendered actually calls adapter poke -----------
//    Closes the gap CR 1.7 flagged: § 16 above verifies the gate works
//    after a manual poke, but doesn't verify that _onRendererRendered
//    is the thing doing the poking. A spy here catches a regression that
//    removed the call from _onRendererRendered (returning the no-IO
//    Markup variant to its stuck-in-LOADING failure mode).
{
  console.log('\n17. Wiring: _onRendererRendered calls _lifecycleAdapter._maybeAdvanceToActive');
  const c = track(new SHARCContainer({
    creativeHtml: '<html><body>x</body></html>',
    creativeRendererUrl: 'https://r.example/r',
    placementElement: freshSlot(),
    requireSharcInit: false,
    timeouts: { rendererReply: 5000 },
  }));
  c.load();

  // Replace the adapter's _maybeAdvanceToActive with a spy that counts calls
  // and still invokes the original.
  const orig = c._lifecycleAdapter._maybeAdvanceToActive.bind(c._lifecycleAdapter);
  let pokeCalls = 0;
  c._lifecycleAdapter._maybeAdvanceToActive = function () {
    pokeCalls++;
    return orig();
  };

  // Pre-condition: creativeRendered is false until renderer protocol completes.
  assert(c.creativeRendered === false, 'pre: creativeRendered is false');
  const pokesBeforeRender = pokeCalls;

  // Invoke _onRendererRendered directly with a synthetic envelope-validated
  // path. The method uses internal state (_terminated guard + _rendererMessageHandler
  // detach + _renderedAt stamp) so we set what it needs and call it.
  c._renderedAt = 0;
  c._onRendererRendered();

  assert(c.creativeRendered === true,
    'post: _onRendererRendered sets creativeRendered = true (sanity)');
  assert(pokeCalls > pokesBeforeRender,
    '_onRendererRendered invoked the adapter poke (wiring intact)');
}
flushContainers();

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} html-lifecycle-adapter assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All html-lifecycle-adapter assertions passed.');
}
