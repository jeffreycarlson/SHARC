/**
 * test-renderer-load-reentry.js — issue #321 (reframed) regression.
 *
 * ADR: docs/dev-team/sharc/2026-06-06-renderer-lifecycle-readiness-compat-creatives.md
 *      (Obsidian: ~/Obsidian/dev-team/sharc/2026-06-06-renderer-lifecycle-readiness-compat-creatives.md)
 *
 * SEQUENCE 1 — the load-event re-entry race.
 *
 * `_wireRendererProtocol`'s iframe `load` handler guards ONLY on
 * `this._terminated` — there is no `creativeRendered` check. A real
 * compatibility creative's external scripts navigate / document.open+write the
 * renderer iframe ~1s after first render, firing a SECOND iframe `load`. The
 * handler re-enters the full handshake — re-runs injectors, re-transitions the
 * router to `attaching-renderer`, re-posts `:render`, and RE-ARMS the
 * `rendererReply` timeout. The reloaded document is no longer the SHARC
 * renderer, so no second `:rendered` arrives, the re-armed timeout fires, and
 * a creative that already reached `active` is killed with RENDERER_TIMEOUT
 * (2114, reason `rendered_reply`).
 *
 * CONTRACT (ADR Decision 1): the render-wiring path owns the FIRST load only.
 * Every subsequent iframe `load` is owned exclusively by the navigation
 * backstop (`_armRendererBackstop`). The fix is a single guard
 * (`if (this.creativeRendered) return;`) at the top of the load handler.
 *
 * RED STATE: this test FAILS today because that guard does not exist — the
 * second load re-arms `rendererReply` and fires 2114. It goes GREEN once the
 * guard ships. The failure is the production behavior gap, NOT a harness defect.
 *
 * NODE-RUNNABLE: yes. jsdom + the existing renderer harness fully express the
 * iframe `load` + `:rendered` envelope + timeout machinery. No browser needed.
 *
 * Run after `npm run build`.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.operator.example/0.7.0/';
const RENDERER_ORIGIN = 'https://renderer.operator.example';
const CREATIVE_HTML = '<html><body>ad</body></html>';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
// ADR 2026-06-15: keep Node's NATIVE worker_threads MessageChannel/MessagePort
// (jsdom defines neither; assigning jsdom's `undefined` would null the channel
// and the port-authenticated load-probe would never be answerable). The
// load-probe gate authenticates by port possession, so the container needs a
// real channel. MessageEvent stays jsdom's (used to drive window envelopes).
global.MessageEvent = dom.window.MessageEvent;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('test-renderer-load-reentry.js — #321 reframed: load re-entry race\n');

// ────────────────────────────────────────────────────────────────────────────
// REGRESSION: a SECOND iframe `load` fired AFTER `:rendered` must NOT terminate
// the container with RENDERER_TIMEOUT/rendered_reply.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('1. Second post-render iframe `load` does not re-arm rendererReply (Decision 1)');

  const errors = [];
  const securityEvents = [];
  const slot = freshSlot();
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: slot,
    // Short reply timeout so a re-armed timeout fires fast within the test.
    // The bug is timeout-independent; the short value just keeps the test quick.
    timeouts: { rendererLoad: 5000, rendererReply: 150 },
    onError: (code, msg) => errors.push({ code, msg }),
    onSecurityEvent: (ev) => securityEvents.push(ev),
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');

  // Neutralize outbound postMessage — we drive the envelopes by hand.
  c._iframe.contentWindow.postMessage = () => {};

  // FIRST load — the real render-wiring path. Posts `:render`, arms reply.
  c._iframe.dispatchEvent(new dom.window.Event('load'));

  // Renderer answers `:rendered` — container goes through `_onRendererRendered`,
  // flips creativeRendered, transitions router to `rendered`, arms the backstop.
  const renderedEvt = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(renderedEvt);

  assert(c.creativeRendered === true,
    'precondition: creativeRendered flipped true after first :rendered');
  assert(c._terminated !== true,
    'precondition: container is alive after first render');

  // SECOND load — the real creative's scripts did a legitimate same-origin
  // document.open()+write() reopen ~1s in (a real compatibility-creative
  // pattern). This is the bug trigger. Two listeners fire:
  //   - the navigation backstop (armed in _onRendererRendered), which posts a
  //     loadProbe and waits 100ms for a loadAck;
  //   - the render-wiring path (_wireRendererProtocol), which — lacking the
  //     creativeRendered guard — re-enters the handshake and RE-ARMS
  //     `rendererReply`.
  c._iframe.dispatchEvent(new dom.window.Event('load'));

  // The same-origin reopen kept the surviving `port2`, so it ANSWERS the
  // backstop's loadProbe with a `SHARC:Creative:loadAck` OVER THE PORT (ADR
  // 2026-06-15 — authentication is port possession, not a window-message nonce).
  // This satisfies the backstop (no 2118) — exactly the faithful e2e: the reopen
  // is tolerated by the navigation backstop, ISOLATING the re-armed
  // rendererReply as the sole remaining failure. Without this ack the backstop's
  // 100ms 2118 would mask the 2114; answering it pins the 2114 race precisely
  // (ADR Context, Seq 1).
  const port2 = c._protocol && c._protocol._channel && c._protocol._channel.port2;
  if (port2) {
    port2.postMessage({ type: 'SHARC:Creative:loadAck', probeId: c._armedProbeId });
  }
  // Port delivery is async; let it land before the assertions below.
  await sleep(15);

  // Wait past the (re-armed) rendererReply window. Under the broken code the
  // re-armed timeout fires here → 2114/rendered_reply. Under the fix, the
  // load handler short-circuits on creativeRendered, never re-arms
  // rendererReply, and the (ack'd) backstop tolerates the reopen → no fatal.
  await sleep(400);

  // onError carries the numeric ErrorCode (2114). The security event carries
  // type 'renderer_protocol_error' + details.reason 'rendered_reply' (it does
  // NOT carry a numeric `code` field). Assert both surfaces stay clean.
  const reArmed2114 = errors.some((e) =>
    e.code === protoMod.ErrorCodes.RENDERER_TIMEOUT);
  const secEvent2114 = securityEvents.some((e) =>
    e.type === 'renderer_protocol_error'
    && e.details && e.details.reason === 'rendered_reply');

  assert(!reArmed2114,
    'no RENDERER_TIMEOUT (2114) fired after a post-render second load');
  assert(!secEvent2114,
    'no security event with reason `rendered_reply` after a post-render second load');
  assert(c._terminated !== true,
    'container that already rendered survives a legitimate ack\'d same-origin reopen');

  if (!c._terminated) c._terminate();
}

if (failures === 0) {
  console.log('\n✓ All load-reentry assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} load-reentry assertion(s) failed (expected RED until Decision 1 ships).`);
  process.exit(1);
}
