/**
 * test-omid-host-driven-session.js — host-driven session entry
 * points on `OmidCompatBridge`.
 *
 * `_createSession`'s `isOmSdkLoaded()` gate never opens for a publisher that
 * never sets `omSdkServiceScriptUrl`/`omSdkSessionClientUrl` — the OM-SDK
 * branch's `omid-active` phase + `sessionStart` relay never fire, so a
 * consumer that owns the ad lifecycle NATIVELY (never loading a web OM SDK
 * client) has no way to drive the SHARC `omid3p` relay. This adds four
 * sanctioned entry points on `OmidCompatBridge.prototype`:
 *
 *   - `startHostSession(nativeSessionId)` — activates host-driven state and
 *     relays a populated `sessionStart`, WITHOUT ever touching
 *     `isOmSdkLoaded()` / `window.OmidSessionClient` / `omid.AdSession`.
 *   - `relayHostSessionEvent(type, data)` — forwards `loaded` / `impression`
 *     / `geometryChange` through the existing `_relayOmidEvent`.
 *   - `finishHostSession()` — delegates to the existing `_finishSession()`.
 *   - `setHostObstructionRects(rects)` — host-push friendly-obstruction
 *     mirroring for native chrome (no DOM element to register).
 *
 * Every entry point reuses the bridge's EXISTING relay machinery
 * (`_relayOmidEvent` / `_signalOmidPhase` / `_finishSession`) rather than
 * adding a parallel transport — the rejected alternative (poking bridge
 * privates from injected native-side JS at each call site) bypasses the
 * queuing / rate-limiting / phase-ordering invariants those methods already
 * enforce.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.example/render.html';
const RENDERER_ORIGIN = 'https://renderer.example';
const CREATIVE_HTML = '<html><body>creative</body></html>';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageEvent = dom.window.MessageEvent;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');

let failures = 0;
function section(name) { console.log('\n' + name); }
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

// NOTE: deliberately NO installOmSdkStub() anywhere in this file —
// `window.OmidSessionClient` stays `undefined` for every test below. If any
// of the four entry points ever called `isOmSdkLoaded()` / `_createSession()`
// / constructed `omid.AdSession`, the assertions on `bridge._omid.adSession`
// staying `null` (and the complete absence of any `OmidSessionClient` global)
// would catch the regression.
assert(typeof window.OmidSessionClient === 'undefined',
  'precondition: window.OmidSessionClient is undefined for this entire file (no OM SDK client ever loaded)');

// Build a Markup-variant container with the OMID bridge wired, WITHOUT
// configuring omSdkServiceScriptUrl/omSdkSessionClientUrl (host-driven-only
// bridge) and drive it to a live (non-OMID) container state so the router
// registers the SHARC:Omid: protocol.
async function buildHostDriven(options = {}, onBeforeLoad) {
  const bridge = new OmidCompatBridge({
    creativeType: 'display',
    mediaType: 'display',
    ...options,
  });
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    extensions: [bridge],
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  if (typeof onBeforeLoad === 'function') onBeforeLoad(c);
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');

  const posted = [];
  c._iframe.contentWindow.postMessage = (msg) => { posted.push(msg); };
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  const rendered = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  });
  window.dispatchEvent(rendered);
  await c.protocolRouter.ready('SHARC:Omid:');
  return { c, bridge, posted };
}

function omidEvents(posted) {
  return posted.filter((m) => m && m.type === 'SHARC:Omid:Event').map((m) => m.event);
}

console.log('test-omid-host-driven-session.js — host-driven session entry points\n');

// ── A. startHostSession activates state WITHOUT any OM SDK surface ──────────
section('A. startHostSession — no OM SDK, host-driven omid-active + sessionStart');
{
  const { c, bridge, posted } = await buildHostDriven();
  assert(bridge._omid.sessionStarted === false, 'precondition: sessionStarted is false before startHostSession');

  bridge.startHostSession('native-session-A');

  assert(bridge._omid.sessionStarted === true, 'startHostSession sets _omid.sessionStarted = true');
  assert(bridge._omid.sessionFinished === false, 'startHostSession sets _omid.sessionFinished = false');
  assert(bridge._omid.adSession === null, 'startHostSession never constructs a JS-side omid.AdSession (_omid.adSession stays null)');
  assert(c.protocolRouter.getPhase() === 'omid-active',
    'router phase reaches omid-active via _signalOmidPhase (container-driven, never from an inbound envelope)');

  const events = omidEvents(posted);
  const starts = events.filter((e) => e.type === 'sessionStart');
  assert(starts.length === 1, 'exactly one sessionStart relayed');
  assert(starts[0].adSessionId === 'native-session-A', 'relayed sessionStart carries the supplied nativeSessionId as adSessionId');
  c._terminate();
}

// ── B. sessionStart payload is never bare {} ───────────────────────────
section('B. sessionStart payload — populated context, honest omidImplementer');
{
  const { c, bridge, posted } = await buildHostDriven();
  bridge.startHostSession('native-session-B');
  const start = omidEvents(posted).find((e) => e.type === 'sessionStart');
  assert(!!start, 'sessionStart relayed');
  assert(start.data && typeof start.data.context === 'object' && start.data.context !== null,
    'relayed sessionStart payload has a defined context object (never bare {})');
  const ctx = start.data.context;
  assert(ctx.apiVersion === '1.0', 'context.apiVersion === "1.0"');
  assert(ctx.environment === 'app', 'context.environment === "app"');
  assert(ctx.accessMode === 'limited', 'context.accessMode === "limited"');
  assert(ctx.omidJsInfo && typeof ctx.omidJsInfo === 'object', 'context.omidJsInfo is defined');
  assert(typeof ctx.omidJsInfo.omidImplementer === 'string' && ctx.omidJsInfo.omidImplementer.length > 0,
    'context.omidJsInfo.omidImplementer is a non-empty string');
  assert(ctx.omidJsInfo.omidImplementer !== 'omsdk',
    'context.omidJsInfo.omidImplementer is NOT "omsdk" (honesty constraint — this relay is not an attested OM SDK session)');
  assert(typeof ctx.omidJsInfo.serviceVersion === 'string' && ctx.omidJsInfo.serviceVersion.length > 0,
    'context.omidJsInfo.serviceVersion is a non-empty string');
  c._terminate();
}

// ── B2. disclosure knob — hostRelayOmidJsInfo option overrides the default ──
section('B2. hostRelayOmidJsInfo option overrides the default disclosure strings');
{
  const { c, bridge, posted } = await buildHostDriven({
    hostRelayOmidJsInfo: { omidImplementer: 'custom-relay', serviceVersion: '9.9.9' },
  });
  bridge.startHostSession('native-session-B2');
  const start = omidEvents(posted).find((e) => e.type === 'sessionStart');
  assert(start.data.context.omidJsInfo.omidImplementer === 'custom-relay',
    'hostRelayOmidJsInfo.omidImplementer option is honored');
  assert(start.data.context.omidJsInfo.serviceVersion === '9.9.9',
    'hostRelayOmidJsInfo.serviceVersion option is honored');
  c._terminate();
}

// ── C. double-start guard ────────────────────────────────────────────────────
section('C. startHostSession double-start guard');
{
  const { c, bridge, posted } = await buildHostDriven();
  bridge.startHostSession('native-session-C1');
  bridge.startHostSession('native-session-C2'); // second call must be a no-op
  const starts = omidEvents(posted).filter((e) => e.type === 'sessionStart');
  assert(starts.length === 1, 'a second startHostSession call is a no-op (exactly one sessionStart relayed)');
  assert(starts[0].adSessionId === 'native-session-C1',
    'the FIRST supplied nativeSessionId sticks (the cached AdSession id is sticky — a late id is ignored)');
  c._terminate();
}

// ── D. nativeSessionId coercion, length-bound, and fallback ─────────────────
section('D. nativeSessionId string-coercion, length-bound, fallback to placementSessionId');
{
  const { c, bridge, posted } = await buildHostDriven();
  bridge.startHostSession(424242); // number input
  const start = omidEvents(posted).find((e) => e.type === 'sessionStart');
  assert(start.adSessionId === '424242', 'a number nativeSessionId is string-coerced');
  c._terminate();
}
{
  const { c, bridge, posted } = await buildHostDriven();
  const long = 'x'.repeat(500);
  bridge.startHostSession(long);
  const start = omidEvents(posted).find((e) => e.type === 'sessionStart');
  assert(start.adSessionId.length === 256, `an over-long nativeSessionId is length-bounded to 256 (got ${start.adSessionId.length})`);
  c._terminate();
}
{
  const { c, bridge, posted } = await buildHostDriven();
  bridge.startHostSession(); // no id supplied
  const start = omidEvents(posted).find((e) => e.type === 'sessionStart');
  assert(start.adSessionId === c.placementSessionId,
    'an absent nativeSessionId falls back to the container placementSessionId (existing _resolveOmidAdSessionId chain)');
  c._terminate();
}

// ── E. relayHostSessionEvent — drop paths ─────────────────────────────
section('E. relayHostSessionEvent — drop paths');
{
  const { c, bridge, posted } = await buildHostDriven();
  // Not started yet — must warn-and-drop.
  bridge.relayHostSessionEvent('loaded', {});
  assert(omidEvents(posted).filter((e) => e.type === 'loaded').length === 0,
    'relayHostSessionEvent("loaded") before startHostSession is dropped (out-of-order guard)');

  bridge.startHostSession('native-session-E');
  const beforeInvalid = posted.length;

  bridge.relayHostSessionEvent('sessionStart', {});
  bridge.relayHostSessionEvent('sessionFinish', {});
  bridge.relayHostSessionEvent('bogus-type', {});
  assert(posted.length === beforeInvalid,
    'relayHostSessionEvent rejects "sessionStart" / "sessionFinish" / any type outside the closed enum {loaded, impression, geometryChange} — no new relay posted');
  c._terminate();
}

// ── F. relayHostSessionEvent — accepted types route through _relayOmidEvent ─
section('F. relayHostSessionEvent — accepted types relay through the existing machinery');
{
  const { c, bridge, posted } = await buildHostDriven();
  bridge.startHostSession('native-session-F');
  bridge.relayHostSessionEvent('loaded', { foo: 1 });
  bridge.relayHostSessionEvent('impression', {});
  bridge.relayHostSessionEvent('geometryChange', { bar: 2 });
  const events = omidEvents(posted);
  assert(events.some((e) => e.type === 'loaded'), '"loaded" relayed');
  assert(events.some((e) => e.type === 'impression'), '"impression" relayed');
  assert(events.some((e) => e.type === 'geometryChange'), '"geometryChange" relayed');
  const omidNonce = c.protocolRouter.getProtocol('SHARC:Omid:').protocolNonce;
  assert(events.length > 0 && posted.filter((m) => m.type === 'SHARC:Omid:Event').every((m) => m.sharcNonce === omidNonce),
    'every host-driven relayed Event is signed with the OMID protocolNonce (inherited from _relayOmidEvent, not re-derived)');
  c._terminate();
}

// ── G. finishHostSession delegates to _finishSession ──────────────────
section('G. finishHostSession — delegates to _finishSession, idempotent, resets state');
{
  const { c, bridge, posted } = await buildHostDriven();
  bridge.startHostSession('native-session-G');
  bridge.setHostObstructionRects([{ x: 1, y: 2, width: 3, height: 4 }]);
  assert(bridge._friendlyObstructionsGeometry().length === 1, 'precondition: host obstruction rect is active pre-finish');

  bridge.finishHostSession();
  assert(bridge._omid.sessionFinished === true, 'finishHostSession sets _omid.sessionFinished = true');
  assert(bridge._omid.sessionStarted === false, '_resetSessionRefs(true) (via _finishSession) clears sessionStarted');
  assert(bridge._omidCachedAdSessionId === null, '_resetSessionRefs clears the cached AdSession id');
  assert(bridge._friendlyObstructionsGeometry().length === 0,
    '_resetSessionRefs clears host-pushed obstruction rects (setHostObstructionRects state does not leak into the next session)');

  const finishes = omidEvents(posted).filter((e) => e.type === 'sessionFinish');
  assert(finishes.length === 1, 'exactly one sessionFinish relayed');

  // Idempotent: a second call must not throw and must not relay a duplicate.
  let threw = false;
  try { bridge.finishHostSession(); } catch (e) { threw = true; }
  assert(!threw, 'a second finishHostSession call does not throw (idempotent)');
  assert(omidEvents(posted).filter((e) => e.type === 'sessionFinish').length === 1,
    'a second finishHostSession call does not relay a duplicate sessionFinish');
  c._terminate();
}

// ── G2. finishHostSession without a prior startHostSession is a safe no-op ──
section('G2. finishHostSession before any session started');
{
  const { c, bridge, posted } = await buildHostDriven();
  let threw = false;
  try { bridge.finishHostSession(); } catch (e) { threw = true; }
  assert(!threw, 'finishHostSession before startHostSession does not throw');
  assert(omidEvents(posted).filter((e) => e.type === 'sessionFinish').length === 0,
    'finishHostSession before startHostSession relays NO sessionFinish (wasStarted gate in _finishSession)');
  c._terminate();
}

// ── H. setHostObstructionRects — validation + geometry mirroring ──────
section('H. setHostObstructionRects — validation, clamping, geometryChange mirroring');
{
  const { c, bridge } = await buildHostDriven();
  bridge.startHostSession('native-session-H');

  bridge.setHostObstructionRects([
    { x: 10, y: 20, width: 30, height: 40, purpose: 'closeAd', id: 'close-btn', reason: 'Close button' },
    { x: -5, y: 0, width: -1, height: -1 }, // negative width/height must clamp to 0; x may stay negative
    { x: 'nope', y: 0, width: 1, height: 1 }, // non-finite x must be DROPPED entirely
    null, // malformed entries must be DROPPED
    { x: 1, y: 1, width: 1, height: 1, purpose: 'not-a-real-purpose' }, // unknown purpose falls back to closeAd
  ]);
  const geo = bridge._friendlyObstructionsGeometry();
  // 5 input entries: [0] fully valid, [1] negative width/height (finite x/y —
  // survives, clamps), [2] non-finite x (dropped), [3] null (dropped), [4]
  // unrecognized purpose (survives, purpose falls back) — 3 of 5 survive.
  assert(geo.length === 3, `3 of 5 entries survive validation (2 dropped: non-finite x, null); got ${geo.length}`);
  assert(geo[0].x === 10 && geo[0].y === 20 && geo[0].width === 30 && geo[0].height === 40,
    'a fully valid rect passes through unchanged');
  assert(geo[0].purpose === 'closeAd' && geo[0].friendlyObstructionViewId === 'close-btn' && geo[0].reason === 'Close button',
    'purpose/id/reason are carried through to the shape _friendlyObstructionsGeometry already returns for the DOM path');
  assert(geo[1].x === -5 && geo[1].width === 0 && geo[1].height === 0,
    'negative width/height clamp to 0 (mirrors setHostExposure clamp discipline); x is left unclamped (off-screen partial overlap is valid)');
  assert(geo[2].purpose === 'closeAd', 'an unrecognized purpose string falls back to "closeAd" (closed OM SDK enum)');

  // Not additive — a second call fully replaces the set.
  bridge.setHostObstructionRects([{ x: 0, y: 0, width: 1, height: 1 }]);
  assert(bridge._friendlyObstructionsGeometry().length === 1, 'setHostObstructionRects REPLACES the full set on each call (not additive)');

  bridge.setHostObstructionRects([]);
  assert(bridge._friendlyObstructionsGeometry().length === 0, 'setHostObstructionRects([]) clears all host-pushed obstructions');

  bridge.setHostObstructionRects('not-an-array');
  assert(bridge._friendlyObstructionsGeometry().length === 0, 'a non-array argument is treated as empty (best-effort-swallow, no throw)');

  // Security: `id` -> `friendlyObstructionViewId` is echoed to third-party
  // verification JS in relayed geometryChange data (same sink as `reason` and
  // `nativeSessionId`) and MUST be length-bounded identically (256 chars).
  bridge.setHostObstructionRects([{ x: 0, y: 0, width: 1, height: 1, id: 'x'.repeat(500) }]);
  const longIdGeo = bridge._friendlyObstructionsGeometry();
  assert(longIdGeo.length === 1 && longIdGeo[0].friendlyObstructionViewId.length === 256,
    `an over-long id is length-bounded to 256 chars in friendlyObstructionViewId (got ${longIdGeo[0] ? longIdGeo[0].friendlyObstructionViewId.length : 'n/a'})`);
  c._terminate();
}

// ── H2. DOM-element obstruction path is untouched for its original use ──────
section('H2. DOM-element registerFriendlyObstruction path is unchanged for a non-host-driven session');
{
  // No startHostSession here: _omid.sessionStarted stays false, so
  // _friendlyObstructionsGeometry must fall through to the pre-existing
  // DOM-element path instead of the host-rects branch.
  const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
  assert(bridge._friendlyObstructionsGeometry().length === 0,
    'with no host-driven session and no registered DOM obstruction, geometry is empty (unchanged baseline)');
}

// ── I. The four entry points are absent from the router types map ─────
// `protocolRouter.getProtocol()` deliberately returns only
// `{prefix, protocolNonce}` (a read-only diagnostic snapshot — it does not
// expose `types`/`handler`, by design). To inspect the ACTUAL `types` object
// OmidCompatBridge hands to `register()`, wrap `register` before `c.load()`
// (which is when `_registerOmidProtocol` calls it) and capture the real
// registration call.
section('I. Router types map absence (only Register is inbound-reachable)');
{
  const registrations = [];
  const { c } = await buildHostDriven({}, (container) => {
    const originalRegister = container.protocolRouter.register.bind(container.protocolRouter);
    container.protocolRouter.register = function (registration) {
      registrations.push(registration);
      return originalRegister(registration);
    };
  });
  const omidReg = registrations.find((r) => r.prefix === 'SHARC:Omid:');
  assert(!!omidReg, 'precondition: SHARC:Omid: protocol register() call captured');
  const types = Object.keys(omidReg.types || {});
  assert(types.indexOf('startHostSession') === -1, '"startHostSession" is not a declared router type');
  assert(types.indexOf('relayHostSessionEvent') === -1, '"relayHostSessionEvent" is not a declared router type');
  assert(types.indexOf('finishHostSession') === -1, '"finishHostSession" is not a declared router type');
  assert(types.indexOf('setHostObstructionRects') === -1, '"setHostObstructionRects" is not a declared router type');
  assert(types.sort().join(',') === ['Event', 'Register'].sort().join(','),
    `the router types map contains exactly {Register, Event} — got {${types.join(',')}}`);
  c._terminate();
}

// ── J. never-inbound-reachable — a crafted creative-origin envelope cannot
//      drive any of the four entry points ───────────────────────────────────
section('J. crafted inbound envelopes naming the new entry points are silently dropped');
{
  const { c, bridge, posted } = await buildHostDriven();
  bridge.startHostSession('native-session-J'); // reach omid-active so phase gating is not the reason for the drop
  const omidNonce = c.protocolRouter.getProtocol('SHARC:Omid:').protocolNonce;
  const beforeStarted = bridge._omid.sessionStarted;
  const postedBefore = posted.length;

  for (const forgedType of ['startHostSession', 'relayHostSessionEvent', 'finishHostSession', 'setHostObstructionRects']) {
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Omid:' + forgedType,
        sharcNonce: omidNonce,
        placementSessionId: c.placementSessionId,
      },
      origin: RENDERER_ORIGIN,
      source: c._iframe.contentWindow,
    });
    window.dispatchEvent(evt);
  }

  assert(bridge._omid.sessionStarted === beforeStarted,
    'crafted inbound envelopes naming the new entry points cause NO bridge state change (undeclared type — router drops before handler dispatch)');
  assert(posted.length === postedBefore,
    'crafted inbound envelopes naming the new entry points trigger NO outbound relay');
  c._terminate();
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ ${failures} omid-host-driven-session assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All omid-host-driven-session assertions passed.');
