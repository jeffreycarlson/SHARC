/**
 * test-omid-shim.js — 0.7.8 SHARC OMID Shim (Layer 1, producer-side).
 *
 * Pins the iframe-side `window.omid3p` shim against a synthetic OMID
 * Verification-Client stub that mirrors IAB `verification-client.js`'s
 * detection (probes `window.omid3p` for the two functions). Covers the design's
 * § 10 Layer-1 rows reachable in isolation:
 *
 *   - omid3p two-method surface (§ 5.1)
 *   - registration → observer callback (§ 5.4)
 *   - full chronological replay, never capped/coalesced (§ 5.4 invariant)
 *   - nonce never in observer event / callback (§ 5.2 / § 9 dep 6)
 *   - churn-resistant subscription cap (§ 7.3)
 *   - emission-side sessionError cache cap (§ 7.3)
 *   - phase/queue: defers Register until sessionStart (§ 5.5 / OMID-Q1)
 *   - cross-vendor: two observers both get events via direct callback (§ 7.2)
 *   - shim-side inbound validator: bad source/origin/nonce/placementSessionId (§ 3.5)
 *   - loud-fail on a pre-existing window.omid3p (§ 11.3 / OMID-D10)
 *   - omid3p dropped after sessionFinish (§ 6.1)
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.MessageEvent = dom.window.MessageEvent;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const { installOmidShim, MAX_OMID_SUBSCRIPTIONS } = await import('../../dist/sharc-omid-shim.mjs');

let failures = 0;
function section(name) { console.log('\n' + name); }
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}
function assertThrows(fn, pattern, message) {
  try { fn(); console.error('  ✗', message, '(no throw)'); failures++; }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { console.error('  ✗', message, `(wrong message: ${e.message})`); failures++; return; }
    console.log('  ✓', message);
  }
}

const NONCE = 'omid-protocol-nonce-AAAA';
const PSID = 'placement-session-id-1234';

// A fake "iframe window" object onto which the shim installs omid3p. We never
// attach a real parent listener — we drive inbound events via the control
// handle's `_handleInbound`, and capture outbound Register posts via an
// injected `postRegister`. This isolates shim behavior from transport plumbing.
function makeWin() {
  const listeners = [];
  return {
    omid3p: undefined,
    parent: { postMessage() {}, addEventListener() {}, removeEventListener() {} },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    _listeners: listeners,
  };
}

function installShim(overrides = {}) {
  const win = overrides.targetWindow || makeWin();
  const posted = [];
  const handle = installOmidShim({
    protocolNonce: NONCE,
    placementSessionId: PSID,
    containerOrigin: PUBLISHER_ORIGIN,
    targetWindow: win,
    parentWindow: overrides.parentWindow || win.parent,
    postRegister(env) { posted.push(env); },
    maxSubscriptions: overrides.maxSubscriptions,
  });
  return { win, posted, handle };
}

// Build a valid inbound SHARC:Omid:Event MessageEvent-like object.
function inboundEvent(type, data, opts = {}) {
  return {
    source: opts.source !== undefined ? opts.source : SOURCE_PARENT,
    origin: opts.origin !== undefined ? opts.origin : PUBLISHER_ORIGIN,
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: opts.nonce !== undefined ? opts.nonce : NONCE,
      placementSessionId: opts.psid !== undefined ? opts.psid : PSID,
      sequence: opts.sequence || 1,
      event: { adSessionId: 'adsess-1', timestamp: Date.now(), type, data: data || {} },
    },
  };
}

let SOURCE_PARENT; // set per test to the shim's parentWindow

// ── A. omid3p two-method surface (§ 5.1) ────────────────────────────────────
section('A. omid3p surface');
{
  const { win } = installShim();
  assert(win.omid3p && typeof win.omid3p === 'object', 'window.omid3p installed');
  assert(typeof win.omid3p.registerSessionObserver === 'function', 'registerSessionObserver is a function');
  assert(typeof win.omid3p.addEventListener === 'function', 'addEventListener is a function');
  const keys = Object.keys(win.omid3p);
  assert(keys.length === 2, 'omid3p exposes EXACTLY two own keys (got ' + keys.length + ')');
  assert(keys.indexOf('registerSessionObserver') !== -1 && keys.indexOf('addEventListener') !== -1,
    'the two keys are exactly the spec methods');
  // The protocolNonce must NOT be discoverable on the surface.
  const serialized = JSON.stringify(Object.keys(win.omid3p)) + Object.values(win.omid3p).map(String).join('');
  assert(serialized.indexOf(NONCE) === -1, 'protocolNonce does not appear anywhere on the omid3p surface');
}

// ── B. registration → observer callback (live + sessionStart) ───────────────
section('B. registration → callback');
{
  const { win, posted, handle } = installShim();
  SOURCE_PARENT = win.parent;
  const got = [];
  win.omid3p.registerSessionObserver(function (ev) { got.push(ev); }, 'doubleverify', 'inj-1');
  // Pre-session: Register is queued, not posted.
  assert(posted.length === 0, 'pre-session registerSessionObserver does NOT post Register yet (§ 5.5)');
  // sessionStart flips session live and flushes the deferred Register post.
  handle._handleInbound(inboundEvent('sessionStart', {}));
  assert(posted.length === 1 && posted[0].type === 'SHARC:Omid:Register',
    'Register posted at sessionStart (deferred post — OMID-Q1)');
  assert(posted[0].sharcNonce === NONCE, 'Register envelope signed with injected protocolNonce');
  assert(got.length === 1 && got[0].type === 'sessionStart', 'observer received sessionStart live');
  handle._handleInbound(inboundEvent('loaded', {}));
  handle._handleInbound(inboundEvent('impression', {}));
  assert(got.length === 3 && got[1].type === 'loaded' && got[2].type === 'impression',
    'observer received loaded then impression in order');
}

// ── C. full chronological replay, never capped/coalesced (§ 5.4) ────────────
section('C. full replay');
{
  const { win, handle } = installShim();
  SOURCE_PARENT = win.parent;
  handle._handleInbound(inboundEvent('sessionStart', {}));
  handle._handleInbound(inboundEvent('loaded', {}));
  handle._handleInbound(inboundEvent('impression', {}));
  // Fire several geometryChange events into the cache (no replay-time coalescing).
  for (let i = 0; i < 5; i++) handle._handleInbound(inboundEvent('geometryChange', { n: i }));

  // Late observer registers AFTER all the above fired.
  const got = [];
  win.omid3p.registerSessionObserver(function (ev) { got.push(ev); });
  const types = got.map((e) => e.type);
  assert(types[0] === 'sessionStart' && types[1] === 'loaded' && types[2] === 'impression',
    'late observer replayed sessionStart→loaded→impression in chronological order');
  const geo = got.filter((e) => e.type === 'geometryChange');
  assert(geo.length === 5, 'late observer replayed ALL 5 geometryChange events (no replay-time coalescing)');
  assert(geo[0].data.n === 0 && geo[4].data.n === 4, 'replayed geometryChange events preserve order');

  // addEventListener(type) replays only prior events of that type.
  const geoOnly = [];
  win.omid3p.addEventListener('geometryChange', function (ev) { geoOnly.push(ev); });
  assert(geoOnly.length === 5 && geoOnly.every((e) => e.type === 'geometryChange'),
    'addEventListener(geometryChange) replays only the 5 geometryChange events');
  const noneOnly = [];
  win.omid3p.addEventListener('volumeChange', function (ev) { noneOnly.push(ev); });
  assert(noneOnly.length === 0, 'addEventListener for an un-fired type replays nothing');
}

// ── D. nonce never reaches observer event / callback (§ 5.2 / dep 6) ─────────
section('D. nonce isolation in observer events');
{
  const { win, handle } = installShim();
  SOURCE_PARENT = win.parent;
  const got = [];
  win.omid3p.registerSessionObserver(function (ev) { got.push(ev); });
  handle._handleInbound(inboundEvent('sessionStart', {}));
  handle._handleInbound(inboundEvent('impression', { foo: 'bar' }));
  let leaked = false;
  for (const ev of got) {
    const s = JSON.stringify(ev);
    if (s.indexOf(NONCE) !== -1) leaked = true;
    if (Object.prototype.hasOwnProperty.call(ev, 'sharcNonce')) leaked = true;
    if (Object.prototype.hasOwnProperty.call(ev, 'placementSessionId')) leaked = true;
    if (Object.prototype.hasOwnProperty.call(ev, 'sequence')) leaked = true;
  }
  assert(!leaked, 'no observer event contains the protocolNonce or any transport field');
  // Event shape is exactly the 4 spec fields.
  const keys = Object.keys(got[0]).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['adSessionId', 'data', 'timestamp', 'type']),
    'observer event is exactly {adSessionId, data, timestamp, type}');
}

// ── E. churn-resistant subscription cap (§ 7.3) ─────────────────────────────
section('E. churn-resistant cap');
{
  assert(typeof MAX_OMID_SUBSCRIPTIONS === 'number' && MAX_OMID_SUBSCRIPTIONS > 0 && isFinite(MAX_OMID_SUBSCRIPTIONS),
    'MAX_OMID_SUBSCRIPTIONS is a finite, positive default (' + MAX_OMID_SUBSCRIPTIONS + ')');

  const cap = 3;
  const { win, handle } = installShim({ maxSubscriptions: cap });
  SOURCE_PARENT = win.parent;
  handle._handleInbound(inboundEvent('sessionStart', {}));

  // Concurrent-live cap: 4th live registration is ignored.
  for (let i = 0; i < 10; i++) win.omid3p.registerSessionObserver(function () {});
  let stats = handle.getStats();
  assert(stats.liveSubscriptions <= cap, 'concurrent-live registrations bounded by cap (' + stats.liveSubscriptions + ' ≤ ' + cap + ')');
  assert(stats.cumulativeRegistrations <= cap, 'cumulative registrations bounded by cap');
}
{
  // Cumulative cap defeats a register→(unregister)→register churn loop. Since
  // the shim has no live-unregister surface yet, simulate churn by repeated
  // registration: each register increments the cumulative counter and stops at
  // the cap regardless of how many callbacks "drop". We assert the cumulative
  // counter never resets across many register calls and bounds replays.
  const cap = 4;
  const { win, handle } = installShim({ maxSubscriptions: cap });
  SOURCE_PARENT = win.parent;
  handle._handleInbound(inboundEvent('sessionStart', {}));
  handle._handleInbound(inboundEvent('loaded', {}));
  let replays = 0;
  for (let i = 0; i < 50; i++) {
    win.omid3p.registerSessionObserver(function (ev) { if (ev.type === 'sessionStart') replays++; });
  }
  const stats = handle.getStats();
  assert(stats.cumulativeRegistrations === cap,
    'cumulative registration count saturates at the cap and never resets (churn-resistant)');
  assert(replays === cap, 'replay count bounded by the cap — churn cannot drive unbounded full-replays (' + replays + ')');
}

// ── F. emission-side sessionError cache cap (§ 7.3) ─────────────────────────
section('F. sessionError cache cap');
{
  const { win, handle } = installShim();
  SOURCE_PARENT = win.parent;
  handle._handleInbound(inboundEvent('sessionStart', {}));
  // Storm of sessionErrors — far beyond the internal MAX_CACHED_SESSION_ERRORS.
  for (let i = 0; i < 200; i++) handle._handleInbound(inboundEvent('sessionError', { i }));
  const got = [];
  win.omid3p.addEventListener('sessionError', function (ev) { got.push(ev); });
  assert(got.length > 0, 'some sessionErrors are cached and replayed');
  assert(got.length < 200, 'sessionError cache is bounded — an error-storm does not grow the replay log unboundedly (' + got.length + ' < 200)');
  const stats = handle.getStats();
  assert(stats.cachedSessionErrors === got.length, 'cached sessionError count matches replayed count');
}

// ── G. cross-vendor: two observers both receive events via direct callback ──
section('G. cross-vendor isolation (direct callback)');
{
  const { win, handle } = installShim();
  SOURCE_PARENT = win.parent;
  const a = []; const b = [];
  win.omid3p.registerSessionObserver(function (ev) { a.push(ev); }, 'vendorA');
  win.omid3p.registerSessionObserver(function (ev) { b.push(ev); }, 'vendorB');
  handle._handleInbound(inboundEvent('sessionStart', {}));
  assert(a.length === 1 && b.length === 1 && a[0].type === 'sessionStart' && b[0].type === 'sessionStart',
    'both vendor observers receive sessionStart via direct same-realm callback');
  // A throwing observer must not break delivery to the other vendor.
  const c = [];
  win.omid3p.registerSessionObserver(function () { throw new Error('hostile vendor'); });
  win.omid3p.registerSessionObserver(function (ev) { c.push(ev); }, 'vendorC');
  handle._handleInbound(inboundEvent('impression', {}));
  // vendorC replayed sessionStart on registration, then received impression live.
  assert(c.some((e) => e.type === 'impression'), 'a throwing vendor callback does not break live delivery to others');
  assert(a.some((e) => e.type === 'impression') && b.some((e) => e.type === 'impression'),
    'earlier observers still receive impression after a hostile vendor throws');
}

// ── H. shim-side inbound validator (§ 3.5 / OMID-Q3) ────────────────────────
section('H. shim-side inbound validator');
{
  const { win, handle } = installShim();
  SOURCE_PARENT = win.parent;
  const got = [];
  win.omid3p.registerSessionObserver(function (ev) { got.push(ev); });

  // Bad source — rejected.
  handle._handleInbound(inboundEvent('sessionStart', {}, { source: { not: 'parent' } }));
  assert(got.length === 0, 'inbound with wrong source is rejected');
  // Bad nonce — rejected.
  handle._handleInbound(inboundEvent('sessionStart', {}, { nonce: 'wrong-nonce' }));
  assert(got.length === 0, 'inbound with wrong nonce is rejected');
  // Bad placementSessionId — rejected.
  handle._handleInbound(inboundEvent('sessionStart', {}, { psid: 'wrong-psid' }));
  assert(got.length === 0, 'inbound with wrong placementSessionId is rejected');
  // Bad origin (non-null, mismatched) — rejected.
  handle._handleInbound(inboundEvent('sessionStart', {}, { origin: 'https://evil.example' }));
  assert(got.length === 0, 'inbound with mismatched non-null origin is rejected');
  // Opaque origin ('null') WITH correct source/nonce/psid — accepted (OMID-D9 srcdoc).
  handle._handleInbound(inboundEvent('sessionStart', {}, { origin: 'null' }));
  assert(got.length === 1 && got[0].type === 'sessionStart', 'opaque-origin inbound with correct source/nonce/psid is accepted (srcdoc)');
}

// ── I. loud-fail on a pre-existing window.omid3p (§ 11.3 / OMID-D10) ─────────
section('I. loud-fail on collision');
{
  const win = makeWin();
  win.omid3p = { registerSessionObserver() {}, addEventListener() {} };
  assertThrows(
    () => installOmidShim({ protocolNonce: NONCE, placementSessionId: PSID, containerOrigin: PUBLISHER_ORIGIN, targetWindow: win, parentWindow: win.parent }),
    /already installed/,
    'installing over a pre-existing window.omid3p throws (never silent-overwrite)'
  );
}

// ── J. omid3p dropped after sessionFinish (§ 6.1) ───────────────────────────
section('J. drop after sessionFinish');
{
  const { win, handle } = installShim();
  SOURCE_PARENT = win.parent;
  handle._handleInbound(inboundEvent('sessionStart', {}));
  assert(typeof win.omid3p === 'object' && win.omid3p, 'omid3p present during active session');
  handle._handleInbound(inboundEvent('sessionFinish', {}));
  assert(win.omid3p === undefined, 'window.omid3p removed after sessionFinish');
  assert(handle.getStats().dropped === true, 'shim marks itself dropped after sessionFinish');
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ ${failures} omid-shim assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All omid-shim assertions passed.');
