/**
 * test-omid-shim-transport.js — 0.7.8 SHARC OMID Shim, REAL two-window transport.
 *
 * This is the regression guard for B1 (code-review BLOCKING): the shim runs
 * INSIDE the creative iframe and must attach its inbound `message` listener to
 * the window it runs in (`targetWindow` === self), NOT to `window.parent` (the
 * cross-origin publisher). The earlier unit test (`test-omid-shim.js`) drives
 * inbound events via the control handle's `_handleInbound(...)` and so could not
 * catch a wrong-window listener attach — that is exactly what hid B1.
 *
 * Here we use TWO distinct jsdom windows (a real iframe, so `parent !== self`).
 * We install the shim on the CHILD (iframe) window, then post a real
 * `SHARC:Omid:Event` MessageEvent that the BROWSER would deliver to the iframe's
 * own message queue (constructed with `source === parent`, as a publisher
 * `iframe.contentWindow.postMessage(...)` produces). The observer must fire
 * THROUGH THE SHIM'S OWN ATTACHED `message` LISTENER — `_handleInbound` is never
 * called directly.
 *
 * Pre-fix (listener attached to `parentWindow`), this dispatch on the child
 * window reaches no listener, the observer never fires, and the asserts below
 * fail. Post-fix (listener on `targetWindow`), they pass.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md §3.5 / §7.4
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM('<!DOCTYPE html><html><body><iframe></iframe></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});

const topWindow = dom.window; // the publisher page (parent)
const iframeEl = topWindow.document.querySelector('iframe');
const childWindow = iframeEl.contentWindow; // the creative iframe (self)

global.window = childWindow;
global.document = childWindow.document;
global.MessageEvent = childWindow.MessageEvent;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const { installOmidShim } = await import('../../dist/sharc-omid-shim.mjs');

let failures = 0;
function section(name) { console.log('\n' + name); }
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}

const NONCE = 'omid-protocol-nonce-XFER';
const PSID = 'placement-session-id-XFER';

// Sanity: this is a genuine two-window setup (the precondition the unit test
// could not provide). If parent === self, the regression guard is meaningless.
section('Precondition: two distinct windows (parent !== self)');
assert(childWindow !== topWindow, 'child (iframe) window is a distinct object from the top (publisher) window');
assert(childWindow.parent === topWindow, 'child.parent resolves to the top window (publisher is the parent)');

// Posts a real inbound SHARC:Omid:Event the way the publisher bridge does:
// `iframe.contentWindow.postMessage(envelope, iframeOrigin)`. jsdom does not
// auto-route cross-frame postMessage, so we faithfully reconstruct what the
// browser delivers to the iframe — a MessageEvent on the CHILD window whose
// `source` is the parent — and dispatch it. This flows through whatever
// `message` listener the shim attached (NOT `_handleInbound`).
function postFromParent(type, data) {
  const envelope = {
    type: 'SHARC:Omid:Event',
    sharcNonce: NONCE,
    placementSessionId: PSID,
    sequence: 1,
    event: { adSessionId: 'adsess-xfer', timestamp: Date.now(), type, data: data || {} },
  };
  const evt = new childWindow.MessageEvent('message', {
    data: envelope,
    origin: PUBLISHER_ORIGIN,
    source: topWindow,
  });
  childWindow.dispatchEvent(evt);
}

// ── Real-transport delivery through the shim's OWN attached listener ─────────
section('Inbound delivered via the shim\'s own message listener (B1 regression guard)');
{
  // Install the shim on the CHILD (iframe) window with no explicit window
  // params beyond targetWindow — mirroring production where targetWindow=self
  // and parentWindow=window.parent (the publisher). postRegister is stubbed so
  // the test does not depend on outbound transport.
  const posted = [];
  installOmidShim({
    protocolNonce: NONCE,
    placementSessionId: PSID,
    containerOrigin: PUBLISHER_ORIGIN,
    targetWindow: childWindow,
    parentWindow: topWindow,
    postRegister(env) { posted.push(env); },
  });

  assert(typeof childWindow.omid3p === 'object' && childWindow.omid3p,
    'shim installed window.omid3p on the iframe (child) window');

  const got = [];
  childWindow.omid3p.registerSessionObserver(function (ev) { got.push(ev); }, 'doubleverify');

  // Drive the WHOLE flow over real transport — never touch _handleInbound.
  postFromParent('sessionStart', {});
  assert(got.length === 1 && got[0].type === 'sessionStart',
    'observer fired for sessionStart posted from the PARENT, via the shim\'s own attached listener');

  postFromParent('impression', { foo: 'bar' });
  assert(got.length === 2 && got[1].type === 'impression',
    'observer fired for a second event (impression) over real transport');
  assert(got[1].data && got[1].data.foo === 'bar', 'event data survived real-transport delivery');

  // Late subscriber gets full replay over the same realm (replay is local; it
  // does not need transport, but proves the listener-fed cache is populated).
  const late = [];
  childWindow.omid3p.addEventListener('impression', function (ev) { late.push(ev); });
  assert(late.length === 1 && late[0].type === 'impression',
    'late addEventListener replays the impression that arrived over real transport');

  // A message that did NOT come from the parent (wrong source) must be ignored
  // even though it lands on the same (correct) window — proving source
  // validation gates delivery, not the window the listener is bound to.
  const wrongSourceWin = new JSDOM('<!DOCTYPE html>', { url: 'https://evil.example/' }).window;
  const spoofed = new childWindow.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: NONCE,
      placementSessionId: PSID,
      sequence: 99,
      event: { adSessionId: 'x', timestamp: Date.now(), type: 'sessionFinish', data: {} },
    },
    origin: PUBLISHER_ORIGIN,
    source: wrongSourceWin,
  });
  childWindow.dispatchEvent(spoofed);
  assert(got.length === 2,
    'a same-window message from a NON-parent source is rejected (source validated against parentWindow)');
  assert(childWindow.omid3p, 'omid3p NOT dropped by the spoofed sessionFinish (it never passed validation)');

  // Now a real sessionFinish from the parent drops omid3p AND removes the
  // listener from the correct (child) window.
  postFromParent('sessionFinish', {});
  assert(childWindow.omid3p === undefined, 'real sessionFinish from parent dropped omid3p');

  // After drop, a further parent post must not reach the (now-removed) observer.
  const before = got.length;
  postFromParent('impression', {});
  assert(got.length === before,
    'listener removed from the child window on drop — no further events delivered');
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ ${failures} omid-shim-transport assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All omid-shim-transport assertions passed.');
