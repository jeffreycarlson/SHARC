/**
 * test-mraid-orientation-properties.js — MRAID setOrientationProperties /
 * getOrientationProperties forwarded to a native-host hook.
 *
 * These two MRAID surface methods were previously a hardcoded no-op:
 * getOrientationProperties() always returned {allowOrientationChange:true,
 * forceOrientation:'none'} and setOrientationProperties() silently dropped its
 * argument, so a creative could never lock/force device orientation. This makes
 * them real: setOrientationProperties() field-wise stores the value and forwards
 * it to the container host via SHARC.requestOrientationProperties() so an
 * embedding host can drive the device orientation lock; getOrientationProperties()
 * reflects the stored value.
 *
 * The forward is GUARDED on the host hook existing (`typeof
 * SHARC.requestOrientationProperties === 'function'`) so a stock embed / older
 * container without the hook degrades to a silent no-op — preserving backward
 * compatibility (and keeping the VM-based check_sharc_mraid_bundle.mjs guard,
 * whose mock SHARC has no such method, green).
 *
 * Coverage:
 *   O1  default getOrientationProperties() before any set ⇒ {true,'none'}
 *   O2  setOrientationProperties({landscape,false}) ⇒ getOrientationProperties reflects it
 *   O3  setOrientationProperties forwards the resolved value to SHARC.requestOrientationProperties
 *   O4  partial update (only forceOrientation) preserves the other field
 *   O5  invalid input is field-wise ignored (non-string force / non-boolean allow kept)
 *   O6  no SHARC.requestOrientationProperties (older container) ⇒ setOrientationProperties
 *       still stores and does NOT throw (silent degrade)
 *   O7  wrong-but-typed forceOrientation string (not in the MRAID 3.0 enum
 *       {portrait,landscape,none}) is ignored: prior value kept, invalid value
 *       never forwarded to the host; valid enum values still round-trip
 *
 * O8–O10 cover the CONTAINER seam (the L1 trust boundary, contract C5). The
 * bridge enum guard (O7) only gates calls routed through
 * mraid.setOrientationProperties() — the creative surface also exposes
 * SHARC.requestOrientationProperties directly, so a creative can bypass the
 * bridge and deliver arbitrary Creative:setOrientationProperties args straight
 * to the container. These cases drive the container handler
 * (_handleSetOrientationProperties) with forged messages and assert only a
 * validated, minimal {allowOrientationChange, forceOrientation} payload can
 * reach the native host hook:
 *   O8  direct-path bypass: all-invalid args ⇒ host hook NOT invoked
 *   O9  direct-path minimization: unknown fields (extra/nested) never cross;
 *       host receives EXACTLY {allowOrientationChange, forceOrientation}
 *   O10 partial-valid: invalid field omitted, valid field forwarded alone
 *
 * Harness for O1–O7 mirrors test-mraid-exposure-change.js: a fresh fake SHARC
 * host + a fresh bridge instance per case from the built bundle under its own
 * globalThis.window via a cache-busting import query. O8–O10 use a JSDOM
 * container harness (mirrors test-active-frozen-edge.js), set up AFTER the
 * bridge cases so the two harnesses' globals never overlap.
 */

import { JSDOM } from 'jsdom';

const BRIDGE_URL = '../../dist/sharc-mraid-bridge.mjs';

let nonce = 0;

const DEFAULT_ENV = {
  currentPlacement: {
    initialDefaultSize: { width: 320, height: 50 },
    maxExpandSize: { width: 1024, height: 768 },
    viewportSize: { width: 1024, height: 768 },
  },
  initialPosition: { x: 0, y: 0, width: 320, height: 50 },
  data: { placement: { instl: 0 }, app: { bundle: 'test-app' } },
};

// makeBridge({ withOrientationHook }) — when withOrientationHook is false the
// mock SHARC omits requestOrientationProperties (the older-container / stock-embed
// case); the recorded forwards array stays empty.
async function makeBridge({ withOrientationHook = true } = {}) {
  const readyCallbacks = [];
  const forwarded = [];

  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart() {},
    on() {},
    hasFeature() { return true; },
    requestNavigation() { return Promise.resolve(); },
    requestPlacementChange() { return Promise.resolve(); },
    requestClose() { return Promise.resolve(); },
  };
  if (withOrientationHook) {
    SHARC.requestOrientationProperties = (args) => { forwarded.push(args); };
  }

  globalThis.location = { protocol: 'http:', hostname: 'localhost' };
  globalThis.window = {
    __sharcMraidBridgeAutoInstall: true,
    SHARC,
    // Slice E3 (#392): the bridge anchors `ready` to document-load-complete. A
    // load-complete document is the fire-now condition, so the ready burst this
    // suite drives via Container:init fires as before — exercising the real gate
    // path (readyState === 'complete'), not the non-browser fallback.
    document: { readyState: 'complete' },
  };

  await import(`${BRIDGE_URL}?orientation=${Date.now()}-${nonce++}`);

  const win = globalThis.window;
  return {
    mraid: win.mraid,
    forwarded,
    fireReady(env) { if (readyCallbacks[0]) readyCallbacks[0](env || DEFAULT_ENV); },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

console.log('test-mraid-orientation-properties.js — MRAID setOrientationProperties host hook\n');

// ── O1 — default getOrientationProperties before any set ─────────────────────
{
  console.log('O1 — default getOrientationProperties() ⇒ {allowOrientationChange:true, forceOrientation:\'none\'}:');
  const h = await makeBridge();
  h.fireReady();
  const p = h.mraid.getOrientationProperties();
  check(p.allowOrientationChange === true, 'allowOrientationChange defaults to true');
  check(p.forceOrientation === 'none', 'forceOrientation defaults to \'none\'');
}

// ── O2 — set then get reflects the stored value ──────────────────────────────
{
  console.log('O2 — setOrientationProperties({landscape,false}) ⇒ getOrientationProperties reflects:');
  const h = await makeBridge();
  h.fireReady();
  h.mraid.setOrientationProperties({ forceOrientation: 'landscape', allowOrientationChange: false });
  const p = h.mraid.getOrientationProperties();
  check(p.forceOrientation === 'landscape' && p.allowOrientationChange === false,
    'getOrientationProperties() === {landscape,false} (got ' + JSON.stringify(p) + ')');
}

// ── O3 — set forwards the resolved value to the host hook ─────────────────────
{
  console.log('O3 — setOrientationProperties forwards to SHARC.requestOrientationProperties:');
  const h = await makeBridge();
  h.fireReady();
  h.mraid.setOrientationProperties({ forceOrientation: 'portrait', allowOrientationChange: true });
  check(h.forwarded.length === 1, 'host hook called exactly once (got ' + h.forwarded.length + ')');
  check(h.forwarded.length === 1 && h.forwarded[0].forceOrientation === 'portrait'
    && h.forwarded[0].allowOrientationChange === true,
    'forwarded {portrait,true} (got ' + JSON.stringify(h.forwarded[0]) + ')');
}

// ── O4 — partial update preserves the untouched field ────────────────────────
{
  console.log('O4 — partial update (only forceOrientation) preserves allowOrientationChange:');
  const h = await makeBridge();
  h.fireReady();
  h.mraid.setOrientationProperties({ forceOrientation: 'landscape', allowOrientationChange: false });
  h.mraid.setOrientationProperties({ forceOrientation: 'portrait' }); // allow omitted
  const p = h.mraid.getOrientationProperties();
  check(p.forceOrientation === 'portrait' && p.allowOrientationChange === false,
    'forceOrientation updated, allowOrientationChange preserved (got ' + JSON.stringify(p) + ')');
}

// ── O5 — invalid input is field-wise ignored (setter never throws) ───────────
{
  console.log('O5 — invalid input is field-wise ignored:');
  const h = await makeBridge();
  h.fireReady();
  h.mraid.setOrientationProperties({ forceOrientation: 'landscape', allowOrientationChange: false });
  // non-string force + non-boolean allow → both ignored, prior values kept
  h.mraid.setOrientationProperties({ forceOrientation: 42, allowOrientationChange: 'yes' });
  const p = h.mraid.getOrientationProperties();
  check(p.forceOrientation === 'landscape' && p.allowOrientationChange === false,
    'invalid-typed fields ignored, prior {landscape,false} kept (got ' + JSON.stringify(p) + ')');
}

// ── O6 — no host hook (older container) ⇒ stores, does not throw ─────────────
{
  console.log('O6 — without SHARC.requestOrientationProperties: stores + silent (no throw):');
  const h = await makeBridge({ withOrientationHook: false });
  h.fireReady();
  let threw = false;
  try {
    h.mraid.setOrientationProperties({ forceOrientation: 'landscape', allowOrientationChange: false });
  } catch (e) { threw = true; }
  check(!threw, 'setOrientationProperties did not throw without the host hook');
  const p = h.mraid.getOrientationProperties();
  check(p.forceOrientation === 'landscape' && p.allowOrientationChange === false,
    'value still stored locally for getOrientationProperties (got ' + JSON.stringify(p) + ')');
}

// ── O7 — non-enum forceOrientation string is ignored (C5 enum guard) ─────────
{
  console.log('O7 — non-enum forceOrientation string ignored; never forwarded; valid enum still round-trips:');
  const h = await makeBridge();
  h.fireReady();
  h.mraid.setOrientationProperties({ forceOrientation: 'landscape', allowOrientationChange: false });
  // wrong-but-typed string → not in {portrait,landscape,none} → ignored
  h.mraid.setOrientationProperties({ forceOrientation: 'sideways' });
  const p = h.mraid.getOrientationProperties();
  check(p.forceOrientation === 'landscape',
    'non-enum string ignored, prior \'landscape\' kept (got ' + JSON.stringify(p.forceOrientation) + ')');
  check(h.forwarded.every((f) => f.forceOrientation !== 'sideways'),
    'invalid value never forwarded to the host (forwards: '
      + JSON.stringify(h.forwarded.map((f) => f.forceOrientation)) + ')');
  // guard is not over-broad: a valid enum value still stores + forwards
  h.mraid.setOrientationProperties({ forceOrientation: 'portrait' });
  const p2 = h.mraid.getOrientationProperties();
  check(p2.forceOrientation === 'portrait' && p2.allowOrientationChange === false,
    'valid enum value still round-trips after rejection (got ' + JSON.stringify(p2) + ')');
  check(h.forwarded.length > 0
    && h.forwarded[h.forwarded.length - 1].forceOrientation === 'portrait',
    'valid enum value still forwarded to the host');
}

// ═══ Container-seam harness (O8–O10) ════════════════════════════════════════
// Set up AFTER the bridge cases: the bridge harness mutated globalThis.window
// with plain fakes; the container needs a real JSDOM window. Mirrors the
// proven setup in test-active-frozen-edge.js (minus load()-time stubs — these
// cases exercise the message handler on a constructed container directly).

const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: 'https://publisher.example/page.html' },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

// makeContainer(hookCalls) — real container instance with the native-host
// orientation hook wired to a recording spy. Returns the container; deliver a
// forged Creative:setOrientationProperties msg via
// c._handleSetOrientationProperties({args}) — the exact seam the protocol
// listener dispatches to (sharc-container.js Creative:setOrientationProperties
// listener), so the test covers everything between the wire and the host hook.
function makeContainer(hookCalls) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: el,
    requireSharcInit: false,
    onOrientationProperties: (args) => { hookCalls.push(args); },
  });
}

// ── O8 — direct-path bypass: all-invalid creative args never reach the host ──
{
  console.log('\nO8 — direct path, all fields invalid ⇒ host hook NOT invoked:');
  const hookCalls = [];
  const c = makeContainer(hookCalls);
  c._handleSetOrientationProperties({
    type: 'SHARC:Creative:setOrientationProperties',
    args: { forceOrientation: 'sideways', allowOrientationChange: 'yes', extra: 'creative-controlled' },
  });
  check(hookCalls.length === 0,
    'host hook not invoked for all-invalid args (got ' + hookCalls.length
      + ' call(s): ' + JSON.stringify(hookCalls) + ')');
  try { c.close(); } catch { /* not loaded */ }
}

// ── O9 — direct-path minimization: unknown fields never cross the boundary ───
{
  console.log('O9 — direct path, valid fields + unknown fields ⇒ minimal payload only:');
  const hookCalls = [];
  const c = makeContainer(hookCalls);
  c._handleSetOrientationProperties({
    type: 'SHARC:Creative:setOrientationProperties',
    args: { forceOrientation: 'landscape', allowOrientationChange: true, extra: 'x', nested: { a: 1 } },
  });
  check(hookCalls.length === 1, 'host hook invoked exactly once (got ' + hookCalls.length + ')');
  const p = hookCalls[0] || {};
  check(p.allowOrientationChange === true && p.forceOrientation === 'landscape',
    'valid fields forwarded (got ' + JSON.stringify(p) + ')');
  check(!('extra' in p) && !('nested' in p),
    'unknown fields (extra, nested) do not cross the trust boundary');
  check(Object.keys(p).length === 2,
    'payload is EXACTLY the two known fields (keys: ' + JSON.stringify(Object.keys(p)) + ')');
  try { c.close(); } catch { /* not loaded */ }
}

// ── O10 — partial-valid: invalid field omitted, valid field forwarded alone ──
{
  console.log('O10 — direct path, partial-valid ⇒ only the valid field crosses:');
  const hookCalls = [];
  const c = makeContainer(hookCalls);
  c._handleSetOrientationProperties({
    type: 'SHARC:Creative:setOrientationProperties',
    args: { forceOrientation: 'portrait', allowOrientationChange: 'yes' },
  });
  check(hookCalls.length === 1, 'host hook invoked exactly once (got ' + hookCalls.length + ')');
  const p = hookCalls[0] || {};
  check(p.forceOrientation === 'portrait',
    'valid forceOrientation forwarded (got ' + JSON.stringify(p) + ')');
  check(!('allowOrientationChange' in p),
    'invalid (non-boolean) allowOrientationChange omitted from the payload');
  check(Object.keys(p).length === 1,
    'payload is EXACTLY the one valid field (keys: ' + JSON.stringify(Object.keys(p)) + ')');
  try { c.close(); } catch { /* not loaded */ }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} orientation-properties assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All MRAID orientation-properties assertions passed.');
