/**
 * test-lifecycle-conjunction-gate.js — Slice A RED test (node tier).
 *
 * The FAILING (red) contract for "conjunction, not timer" (ADR
 * 2026-06-13-sharc-unified-lifecycle-ordering.md §5.2 step 2, HB-3, R-1):
 *
 *   The container MUST trigger `initChannel` (the createSession handshake) on
 *   the `creative-rendered ∧ env-ready` conjunction — i.e. promptly off the
 *   render-anchor signal — NOT after a fixed 200ms wall-clock.
 *
 * This is node-expressible on the URL path: the container constructs under
 * jsdom (cf. test-html-lifecycle-adapter.js), the iframe's `load` event is the
 * URL-path render anchor, env-ready is true at construction, and
 * `_protocol.initChannel` is spy-able on the instance. We dispatch the iframe
 * `load` event and assert `initChannel` was called within a short window after
 * the signal. RED today: the call is wrapped in `setTimeout(…, 200)`
 * (sharc-container.js:2204), so it has NOT fired ~25ms after the load signal,
 * and only fires ~200ms later — proving the gate is a wall-clock timer, not the
 * render∧env conjunction.
 *
 * (The Markup-path conjunction is NOT cleanly node-expressible — it needs the
 * real cross-origin renderer to post `:rendered`; that path is covered at
 * validator tier in test-lifecycle-load-anchor.js T1/T2.)
 *
 * Tier: NODE (jsdom). RED-by-design until Slice A lands; gated behind
 * `npm run test:sliceA-red`, NOT in test:all while red.
 *
 * Runs after `npm run build` (imports the built dist bundle).
 */

import { JSDOM } from 'jsdom';

const SIGNAL_WINDOW_MS = 25; // conjunction ⇒ initChannel within a tick or two;
                             // the 200ms timer guarantees it has NOT fired yet.

const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html', pretendToBeVisual: true },
);
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true, get() { return 'visible'; },
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

// IntersectionObserver stub (the HtmlAdapter constructs one in attach()).
const _ioInstances = [];
global.IntersectionObserver = class {
  constructor(cb) { this._cb = cb; this._targets = []; _ioInstances.push(this); }
  observe(t) { this._targets.push(t); }
  unobserve(t) { this._targets = this._targets.filter((x) => x !== t); }
  disconnect() { this._targets = []; }
  _trigger(entries) { this._cb(entries, this); }
};
window.IntersectionObserver = global.IntersectionObserver;

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
function assert(cond, message, diag) {
  if (cond) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    if (diag) console.error('   ', diag);
    failures++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

console.log('test-lifecycle-conjunction-gate.js — Slice A RED contract (node tier)\n');

console.log('T4 (R-1 / HB-3) — initChannel fires on the render∧env conjunction, '
  + 'not after a 200ms wall-clock');
{
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    timeouts: { createSession: 5000 },
  });

  // Spy on the protocol handshake entry-point. initChannel is the first
  // post-render container action (P4); when it is called == when the handshake
  // gate opened. We record the time RELATIVE to the render-anchor dispatch.
  const initChannelCalls = [];
  const realInitChannel = c._protocol.initChannel.bind(c._protocol);
  c._protocol.initChannel = function (...args) {
    initChannelCalls.push(performance.now());
    return realInitChannel(...args);
  };

  c.load();

  // env-ready is true at construction; fire the URL-path render anchor (the
  // iframe's cross-document `load`). Under the target conjunction, initChannel
  // must fire promptly off THIS signal.
  const tSignal = performance.now();
  c._iframe.dispatchEvent(new dom.window.Event('load'));

  // Give the event loop a couple of ticks — enough for a conjunction-driven
  // (synchronous / microtask / next-tick) initChannel, but FAR short of 200ms.
  await sleep(SIGNAL_WINDOW_MS);

  const firedPromptly = initChannelCalls.length > 0;
  const diag = `initChannel calls within ${SIGNAL_WINDOW_MS}ms of render anchor: `
    + `${initChannelCalls.length} `
    + (initChannelCalls.length
        ? `(Δ=${(initChannelCalls[0] - tSignal).toFixed(1)}ms)`
        : '(none — gated behind the 200ms setTimeout)');

  assert(firedPromptly,
    `initChannel fired within ${SIGNAL_WINDOW_MS}ms of the render anchor `
      + '(RED today: it is wrapped in setTimeout(…,200) at sharc-container.js:2204, '
      + 'so it has NOT fired this soon — the gate is a wall-clock timer, not the conjunction)',
    diag);

  // Positive control: confirm the call DOES eventually happen (~200ms later),
  // so we know the red above is the timer delay, NOT a harness wiring failure
  // (initChannel never being called at all would be a setup bug, not the
  // contract failure we are asserting).
  await sleep(300);
  assert(initChannelCalls.length > 0,
    'control: initChannel IS eventually called (~200ms later) — confirms the spy is '
      + 'wired and the red above is the timer delay, not a missing call',
    `total initChannel calls after 325ms: ${initChannelCalls.length}`);

  try { if (!c._terminated) c._terminate(); } catch (_) { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
  + '— Slice A conjunction-gate contract');
if (failures > 0) {
  console.log('\nNOTE: the first assertion is EXPECTED to fail until Slice A replaces the '
    + '200ms timer with the creative-rendered ∧ env-ready conjunction (RED-by-design).');
}
process.exit(failures === 0 ? 0 : 1);
