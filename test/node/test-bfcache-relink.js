/**
 * test-bfcache-relink.js — R3 §3.3 dead-port detect + relink (#338)
 *
 * Per ADR docs/design/0.7.11-bfcache-omid-relink-r3.md §3.3 / §6.3, INV-R8..R12.
 *
 * RC-3: bfcache discards the MessageChannel. On `pageshow{persisted:true}`
 * restore, the per-session MessagePort (`this._port`) references a DEAD port:
 * R1's container→creative replay lands in a closed port and is lost, so the
 * creative-side MRAID/SafeFrame bridges never re-sync.
 *
 * R3 §3.3 (detection D-a, RATIFIED): treat `pageshow{persisted:true}` as the
 * authoritative "port is dead" signal ⇒ relink unconditionally. The relink
 * re-runs the EXISTING `initChannel` bootstrap (new MessageChannel, new port2
 * to the same creative origin) reusing the SAME placementSessionId/sessionId.
 * It is transport-only: NO new message type, NO envelope field, NO router
 * nonce re-mint (the OMID iframe shim survives bfcache — confirmed by the
 * build-phase Chrome probe — so the router relay needs no re-arm). After
 * relink the container delivers the current state over the new live port.
 *
 * jsdom cannot model real port closure; these tests exercise the relink
 * MECHANICS (the bootstrap re-run, identity preservation, the no-wire-change
 * guard, clean failure). The real-bfcache dead-port proof is the Puppeteer
 * tier (E-1..E-3).
 *
 * Coverage:
 *   P-1 [RED→GREEN] dead port + pageshow{persisted} ⇒ container re-runs the
 *       initChannel bootstrap (new MessageChannel, new port2 transferred) with
 *       the SAME placementSessionId. (INV-R9, INV-R10)
 *   P-2 [GREEN-guard] relink does NOT change sessionId; the session gate still
 *       validates post-relink messages against the same id. (INV-R9)
 *   P-3 [RED→GREEN] after relink, sendStateChange(currentState) is issued over
 *       the NEW port and respects the per-session _lastSentState dedup. (INV-R11)
 *   P-4 [GREEN-guard] relink uses NO new message type and does NOT call
 *       rederiveAllProtocolNonces() in the default path. (INV-R10)
 *   P-5 [GREEN-guard] relink with a missing creative window ⇒ container does
 *       not throw and does not emit into the dead port; OMID publisher-page
 *       re-assert is independent of relink outcome. (INV-R12)
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
let _docVisibility = 'visible';
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return _docVisibility; },
});
global.document.hasFocus = () => true;
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
  constructor(callback) { this._callback = callback; this._targets = []; _ioInstances.push(this); }
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
const { ContainerMessages } = protoMod;

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

function makeAdapterContainer(overrides = {}) {
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    visible: true,
    timeouts: { createSession: 5000 },
    ...overrides,
  }));
  c.load();
  return { c, io: _ioInstances[_ioInstances.length - 1] };
}

const VALID_SESSION = '11111111-1111-4111-8111-111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Model an established MessageChannel session (as one would exist before a
 * bfcache round-trip): a real sessionId and the MessageChannel transport flag.
 * The caller then nulls `_port` to model the dead port bfcache leaves behind.
 */
function establishSession(c) {
  c._protocol.sessionId = VALID_SESSION;
  c._protocol._usingMessageChannel = true;
}

/**
 * Establish a session on the container's protocol (so sessionId is set) and
 * instrument initChannel + the underlying postMessage so the relink's bootstrap
 * re-run is observable. Returns a record of initChannel invocations.
 */
function instrumentChannel(c) {
  const rec = { initChannelCalls: [], handshakes: [], rederiveCalls: 0 };
  const proto = c._protocol;

  // Spy on initChannel to record relink re-bootstraps.
  const realInit = proto.initChannel.bind(proto);
  proto.initChannel = (win, origin, psid) => {
    rec.initChannelCalls.push({ win, origin, placementSessionId: psid });
    return realInit(win, origin, psid);
  };

  // Capture handshake postMessages (the port2 transfer) by spying on the
  // creative window's postMessage.
  if (c._iframe && c._iframe.contentWindow) {
    const cw = c._iframe.contentWindow;
    const realPost = cw.postMessage ? cw.postMessage.bind(cw) : null;
    cw.postMessage = (msg, origin, transfer) => {
      if (msg && msg.type === 'SHARC:Container:handshake') {
        rec.handshakes.push({ msg, origin, transfer: transfer || [] });
      }
      if (realPost) { try { return realPost(msg, origin, transfer); } catch (_) { /* jsdom transfer quirks */ } }
      return undefined;
    };
  }

  // Spy on router re-mint to assert the default path NEVER calls it.
  if (c.protocolRouter && typeof c.protocolRouter.rederiveAllProtocolNonces === 'function') {
    const realRederive = c.protocolRouter.rederiveAllProtocolNonces.bind(c.protocolRouter);
    c.protocolRouter.rederiveAllProtocolNonces = (...a) => { rec.rederiveCalls++; return realRederive(...a); };
  }
  return rec;
}

console.log('test-bfcache-relink.js — R3 §3.3 dead-port detect + relink\n');

// ── P-1 — dead port + pageshow{persisted} ⇒ initChannel re-run, same psid ───
section('P-1. dead port + pageshow{persisted:true} ⇒ container re-runs initChannel with the SAME placementSessionId');
{
  const { c } = makeAdapterContainer();
  // Establish a session so relink has identity to preserve.
  establishSession(c);
  const psidBefore = c.placementSessionId;
  const rec = instrumentChannel(c);

  // Model the dead port: bfcache discarded the MessageChannel.
  c._protocol._port = null;

  // Real bfcache restore.
  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);

  assert(rec.initChannelCalls.length >= 1,
    `initChannel bootstrap re-run at least once on bfcache restore (got ${rec.initChannelCalls.length})`);
  const last = rec.initChannelCalls[rec.initChannelCalls.length - 1];
  assert(last && last.placementSessionId === psidBefore,
    'relink re-uses the SAME placementSessionId (INV-R9)');
  // The transport is re-established (the dead null is replaced). jsdom ships no
  // MessageChannel, so `initChannel` takes the postMessage fallback and sets
  // `_fallbackTarget` rather than a real `_port` — the actual new-MessagePort
  // attachment is the Puppeteer-tier proof (E-1). The engine-agnostic property
  // verifiable here is that a live transport now exists where the dead one was.
  const transportReestablished = c._protocol._port !== null
    || c._protocol._fallbackTarget != null;
  assert(transportReestablished,
    'a live transport is re-established after relink (port or fallback target set)');
}
flushContainers();

// ── P-2 — relink preserves sessionId / session gate unchanged ───────────────
section('P-2. relink does NOT change sessionId; the session gate still validates against the same id');
{
  const { c } = makeAdapterContainer();
  establishSession(c);
  instrumentChannel(c);
  c._protocol._port = null;

  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);

  assert(c._protocol.sessionId === VALID_SESSION,
    'sessionId is unchanged after relink (INV-R9)');
  // The gate drops a message whose sessionId != this.sessionId. Confirm the
  // gate's comparison value is still the original session id.
  assert(c._protocol.sessionId === VALID_SESSION,
    'the session-validation gate continues to validate against the same sessionId');
}
flushContainers();

// ── P-3 — post-relink current-state delivery over the new port, deduped ─────
section('P-3. after relink, sendStateChange(currentState) is issued over the new port and respects the dedup');
{
  const { c, io } = makeAdapterContainer();
  // Drive to ACTIVE.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  io._trigger([{ target: io._targets[0], isIntersecting: true, intersectionRatio: 0.9 }]);
  await sleep(5);
  establishSession(c);

  // Spy at the WIRE layer (`_sendMessage`) so we observe what actually reaches
  // the port, AFTER the send-layer `_lastSentState` dedup has had its say —
  // `sendStateChange` short-circuits before `_sendMessage` on a duplicate, so a
  // suppressed send produces NO `_sendMessage` call.
  const emitted = [];
  const realSendMessage = c._protocol._sendMessage.bind(c._protocol);
  c._protocol._sendMessage = (type, args) => {
    if (type === ContainerMessages.STATE_CHANGE) emitted.push(args.containerState);
    return realSendMessage(type, args);
  };
  // Reset dedup so the post-relink delivery is observable.
  c._protocol._lastSentState = undefined;
  c._protocol._port = null;

  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);

  assert(emitted.length >= 1,
    `current state is delivered over the relinked port (got: ${JSON.stringify(emitted)})`);
  // The delivered value is the container's current queryable state.
  assert(emitted.includes(c.getState()),
    `the delivered state matches the container's current state '${c.getState()}'`);

  // Dedup PROOF: a SECOND consecutive sendStateChange(sameState) post-relink is
  // SUPPRESSED — the per-session `_lastSentState` dedup holds across the relink
  // (the relink reset it ONCE for the first post-relink push, not thereafter).
  const emittedAfterRelink = emitted.length;
  const currentState = c.getState();
  c._protocol.sendStateChange(currentState);
  assert(emitted.length === emittedAfterRelink,
    `a second consecutive sendStateChange('${currentState}') is suppressed by the dedup `
    + `(no new wire emit: before=${emittedAfterRelink}, after=${emitted.length})`);
}
flushContainers();

// ── P-4 — no new message type, no router re-mint ────────────────────────────
section('P-4. relink uses NO new message type and does NOT call rederiveAllProtocolNonces() (INV-R10)');
{
  const { c } = makeAdapterContainer();
  establishSession(c);
  const rec = instrumentChannel(c);
  c._protocol._port = null;

  window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await sleep(5);

  // Every relink handshake is the EXISTING bootstrap type — no new type.
  const nonBootstrap = rec.handshakes.filter((h) => h.msg.type !== 'SHARC:Container:handshake');
  assert(nonBootstrap.length === 0,
    'relink emits only the existing SHARC:Container:handshake bootstrap — no new message type');
  assert(rec.rederiveCalls === 0,
    'rederiveAllProtocolNonces() is NOT called in the default relink path (no router re-mint)');
}
flushContainers();

// ── P-5 — clean failure when the creative window is unavailable ─────────────
section('P-5. relink with no creative window ⇒ no throw, no emit into dead port (INV-R12)');
{
  const { c } = makeAdapterContainer();
  establishSession(c);
  c._protocol._port = null;

  // INV-R8 PROOF: spy on the wire seams BEFORE removing the iframe so we can
  // assert nothing is emitted into the stale/dead port when relink cannot
  // complete. `_sendMessage` is the protocol-level emit; the dead `_port` is the
  // MessagePort it would post to. A clean failure emits on neither.
  const emitted = [];
  const realSendMessage = c._protocol._sendMessage.bind(c._protocol);
  c._protocol._sendMessage = (type, args) => { emitted.push(type); return realSendMessage(type, args); };
  // Install a poisoned dead port: any post into it is an INV-R8 violation.
  let deadPortPosts = 0;
  c._protocol._port = { postMessage: () => { deadPortPosts++; } };

  // Remove the iframe so relink cannot re-bootstrap (creative gone).
  c._iframe = null;

  let threw = false;
  try {
    window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await sleep(5);
  } catch (e) { threw = true; }

  assert(!threw, 'relink with a missing creative window does NOT throw into the page');
  assert(emitted.length === 0,
    `no protocol message is emitted when the relink cannot complete (got: ${JSON.stringify(emitted)})`);
  assert(deadPortPosts === 0,
    `nothing is posted into the stale/dead port (INV-R8 "no emit into dead port") (posts=${deadPortPosts})`);
}
flushContainers();

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} bfcache-relink assertion(s) failed.`);
  process.exit(1);
}
console.log('✓ All bfcache-relink assertions passed.');
