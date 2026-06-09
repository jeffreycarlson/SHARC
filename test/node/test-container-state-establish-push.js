/**
 * test-container-state-establish-push.js — R1 D1/D2 container source fix.
 *
 * R1 closes #336 (container `_transitionToActive` already-ACTIVE skip drops the
 * creative's only chance to learn it is active) and the §"decisive fact"
 * port-gate timing bug at the container source, not per-bridge:
 *
 *   D1 — in `_handleStartCreativeResolved`, AFTER `_transitionToActive`, push
 *        the current queryable lifecycle state to the creative UNCONDITIONALLY.
 *        This runs after the session is established, so it passes the creative's
 *        session gate — unlike the mid-handshake `setState(ACTIVE)` that is
 *        dropped at the port before the creative has a sessionId, and unlike the
 *        `active` that `_transitionToActive` skips when already-ACTIVE (#336).
 *
 *   D2 — `Container:init` carries the REAL `currentState` (value change, not a
 *        wire change — the field already exists, hard-coded to READY).
 *
 * White-box: a real SHARCContainer with `_protocol.sendStateChange` /
 * `_protocol.sendInit` spied. Drives the state machine via `c.setState` and
 * invokes `c._handleStartCreativeResolved()` directly (the post-startCreative
 * resolve path).
 *
 * Contract coverage (State-Delivery Contract — the suite IS the executable spec):
 *   C1 → INV-4, E1               post-establish push fires even when already-ACTIVE
 *   C2 → INV-5, INV-20, E1       port-gate timing: pre-session dropped, at-resolve delivered
 *   C3 → INV-12, E10             non-queryable never pushed; sessionId==='' no-ops
 *   C4 → INV-6, INV-9, INV-23, E7  Container:init carries the real currentState (value, not wire)
 *   C5 → INV-1, INV-3, E2        normal LOADING→ACTIVE ⇒ one active (transition+D1 deduped)
 *   C6 → INV-2, INV-10, E3       oscillation: all distinct edges delivered
 *   C7 → INV-1, E4               re-assert active (no intervening) ⇒ one delivered
 *   C8 → INV-11, INV-13, E8      terminate ⇒ one terminal hidden, nothing after; already-hidden deduped
 *   C9 → INV-2, INV-10, E9       freeze→restore: active,hidden,frozen,active all delivered
 *
 * Runs in Node after `npm run build`. No test framework.
 */

import { JSDOM } from 'jsdom';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.MessageChannel = NodeMessageChannel;
global.MessagePort = dom.window.MessagePort;

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { CREATIVE_QUERYABLE_STATES } = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}
function section(name) { console.log(`\n${name}`); }

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

function markupOptions(overrides) {
  return {
    creativeHtml: '<html><head></head><body>ad</body></html>',
    creativeRendererUrl: 'https://renderer.example/0.7.1/',
    placementElement: freshSlot(),
    ...overrides,
  };
}

/**
 * Builds a real container with a spy over the protocol's sendStateChange.
 * The state machine is real; we drive it via setState. To pass the
 * `sessionId === ''` no-op gate inside the real sendStateChange we fake an
 * established session by stubbing the protocol's session presence where needed
 * (each test documents whether it relies on the gate or the spy).
 */
function makeContainer(overrides) {
  const c = new SHARCContainer(markupOptions(overrides));
  c._iframe = document.createElement('iframe');
  return c;
}

/** Records sendStateChange calls and lets them through to the real impl. */
function spyStateChange(c) {
  const calls = [];
  const orig = c._protocol.sendStateChange.bind(c._protocol);
  c._protocol.sendStateChange = (state) => { calls.push(state); return orig(state); };
  return calls;
}

console.log('test-container-state-establish-push.js — R1 D1/D2 container source fix\n');

// ── C1 — post-establish push fires even when already-ACTIVE (#336 root) ──────
{
  section('C1 — _handleStartCreativeResolved pushes current state even when already-ACTIVE');
  const c = makeContainer();
  // Simulate adapter-promotion: walk to ACTIVE before the handshake resolves.
  c.setState('ready');
  c.setState('active');
  // From here, the container is already ACTIVE. The pre-R1 _transitionToActive
  // skips setState(ACTIVE) (no transition), so the creative never learns active.
  const calls = spyStateChange(c);
  c._handleStartCreativeResolved();
  assert(
    calls.filter((s) => s === 'active').length === 1,
    'exactly one Container:stateChange("active") sent on resolve despite already-ACTIVE (no skip-suppression)',
  );
}

// ── C2 — port-gate timing: state sent at resolve is delivered; pre-session is dropped ─
{
  section('C2 — state sent before creative sessionId is dropped at the port; at-resolve is delivered');
  // Wire a real container protocol port to a real creative protocol port and
  // prove the §"decisive fact": a Container:stateChange whose sessionId !==
  // the creative's sessionId is dropped by _onPortMessage; once the creative's
  // sessionId is set (session established), the same state is delivered.
  const { SHARCContainerProtocol, SHARCCreativeProtocol, ContainerMessages } = protoMod;
  const containerProto = new SHARCContainerProtocol();
  const creativeProto = new SHARCCreativeProtocol();

  const channel = new NodeMessageChannel();
  // Container holds port1; creative holds port2.
  containerProto._attachPort(channel.port1);
  containerProto.sessionId = '11111111-1111-4111-8111-111111111111';

  const delivered = [];
  creativeProto.addListener(ContainerMessages.STATE_CHANGE, (msg) => {
    delivered.push(msg.args && msg.args.containerState);
  });
  creativeProto._attachPort(channel.port2);

  // Phase 1: creative has NOT set its sessionId yet (sessionId === '').
  creativeProto.sessionId = '';
  containerProto.sendStateChange('active');
  await new Promise((r) => setTimeout(r, 10));
  const droppedCount = delivered.length;

  // Phase 2: creative sets its sessionId (session established). In the real flow
  // the container's session establishes here too (acceptSession), which resets
  // the per-session dedup (INV-21) — so the D1 establish push of the current
  // state is NOT suppressed against the Phase-1 send that was dropped at the gate.
  creativeProto.sessionId = '11111111-1111-4111-8111-111111111111';
  containerProto._lastSentState = undefined; // models the per-session dedup reset on establish
  containerProto.sendStateChange('active');
  await new Promise((r) => setTimeout(r, 10));

  assert(droppedCount === 0, 'state sent before creative sessionId set is dropped at the port (0 delivered)');
  assert(
    delivered.filter((s) => s === 'active').length === 1,
    'state sent after session established is delivered exactly once',
  );

  channel.port1.close();
  channel.port2.close();
}

// ── C3 — non-queryable states never pushed; native/plain-HTML no-ops ─────────
{
  section('C3 — loading/terminated never pushed; sessionId==="" no-ops without throw');
  const c = makeContainer();
  const calls = spyStateChange(c);
  // Container is LOADING at construction. _handleStartCreativeResolved with a
  // non-established session (sessionId === '') must be a clean no-op: the push
  // is gated on isCreativeQueryable AND sendStateChange no-ops on empty session.
  let threw = false;
  try { c._handleStartCreativeResolved(); } catch (e) { threw = true; }
  assert(!threw, '_handleStartCreativeResolved does not throw with no established session');
  assert(
    !calls.some((s) => s === 'loading' || s === 'terminated'),
    'never attempts to push loading or terminated',
  );
  assert(CREATIVE_QUERYABLE_STATES.has('active') && !CREATIVE_QUERYABLE_STATES.has('loading'),
    'queryable set excludes loading (gate invariant)');

  // Plain-HTML / native: sessionId === '' ⇒ sendStateChange no-ops (stays a
  // no-op, NOT a new push). Drive a queryable state and confirm nothing crosses.
  const c2 = makeContainer();
  c2.setState('ready');
  c2.setState('active');
  let crossed = 0;
  const origSend = c2._protocol._sendMessage;
  c2._protocol._sendMessage = (...a) => { crossed++; return origSend && origSend.apply(c2._protocol, a); };
  c2._protocol.sessionId = ''; // no session established (native / plain-HTML)
  c2._handleStartCreativeResolved();
  assert(crossed === 0, 'with sessionId==="" the push never reaches _sendMessage (clean no-op)');
}

// ── C4 — Container:init env carries the REAL current state (D2) ──────────────
{
  section('C4 — Container:init env.currentState is the real state, not hard-coded ready');
  const c = makeContainer();
  // Adapter-promoted past READY to ACTIVE before init is built/sent.
  c.setState('ready');
  c.setState('active');

  let sentEnv = null;
  c._protocol.sendInit = (environmentData) => {
    sentEnv = environmentData;
    return Promise.resolve({});
  };
  // Establish a session so _handleCreateSession proceeds to build/send init.
  const sid = '22222222-2222-4222-8222-222222222222';
  c._protocol.acceptSession = function () { this.sessionId = sid; };
  // Stub the deferred startCreative send so the post-init resolve does not float
  // a "No MessagePort available" console.error (the stubbed session has no port);
  // this measurement only cares about the init env, not the startCreative leg.
  c._sendStartCreative = () => {};

  c._handleCreateSession({ sessionId: sid, args: { version: '0.7.9', placementType: 'inline' } });

  assert(sentEnv !== null, 'Container:init was sent (sendInit invoked)');
  assert(
    sentEnv && sentEnv.currentState === 'active',
    `env.currentState is the real state "active" (got "${sentEnv && sentEnv.currentState}")`,
  );

  // And when still at READY at init-build time, it carries 'ready' (queryable).
  const c2 = makeContainer();
  c2.setState('ready');
  let sentEnv2 = null;
  c2._protocol.sendInit = (environmentData) => { sentEnv2 = environmentData; return Promise.resolve({}); };
  c2._protocol.acceptSession = function () { this.sessionId = sid; };
  c2._sendStartCreative = () => {};
  c2._handleCreateSession({ sessionId: sid, args: { version: '0.7.9', placementType: 'inline' } });
  assert(sentEnv2 && sentEnv2.currentState === 'ready', 'at READY, env.currentState is "ready"');
}

// ── C5 — normal LOADING→ACTIVE end-to-end ⇒ creative gets active exactly once ─
//   INV-1, INV-3, E2: transition send + D1 push collapse to one active (dedup).
{
  section('C5 — normal LOADING→ACTIVE through the container ⇒ one active delivered');
  const c = makeContainer();
  c._protocol.sessionId = '66666666-6666-4666-8666-666666666666';
  const wire = [];
  c._protocol._sendMessage = (type, payload) => {
    if (type === protoMod.ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
  };
  c.setState('ready');                 // transition send: ready
  c._handleStartCreativeResolved();    // setState(active) transition send + D1 push
  assert(
    JSON.stringify(wire) === JSON.stringify(['ready', 'active']),
    `creative receives ["ready","active"] — the D1 push after the transition send is deduped (got ${JSON.stringify(wire)})`,
  );
  assert(wire.filter((s) => s === 'active').length === 1, 'exactly one active on the normal path');
}

// ── C6 — oscillation: active→passive→active→hidden→active all distinct flow ───
//   INV-2, INV-10, E3.
{
  section('C6 — active→passive→active→hidden→active ⇒ all five distinct delivered in order');
  const c = makeContainer();
  c._protocol.sessionId = '77777777-7777-4777-8777-777777777777';
  const wire = [];
  c._protocol._sendMessage = (type, payload) => {
    if (type === protoMod.ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
  };
  c.setState('ready');
  c.setState('active');
  c.setState('passive');
  c.setState('active');
  c.setState('hidden');
  c.setState('passive'); // hidden→active is not a legal edge; go hidden→passive→active
  c.setState('active');
  assert(
    JSON.stringify(wire) === JSON.stringify(['ready', 'active', 'passive', 'active', 'hidden', 'passive', 'active']),
    `every distinct oscillation edge delivered (got ${JSON.stringify(wire)})`,
  );
}

// ── C7 — re-assert same state twice with no intervening value ⇒ one delivered ─
//   INV-1, E4.
{
  section('C7 — re-assert active twice (no intervening value) ⇒ one delivered');
  const c = makeContainer();
  c._protocol.sessionId = '88888888-8888-4888-8888-888888888888';
  const wire = [];
  c._protocol._sendMessage = (type, payload) => {
    if (type === protoMod.ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
  };
  c.setState('ready');
  c.setState('active');
  // A redundant sendStateChange('active') (e.g. a second D1-style push) is the
  // consecutive-identical case: it must be suppressed.
  c._protocol.sendStateChange('active');
  assert(
    JSON.stringify(wire) === JSON.stringify(['ready', 'active']),
    `consecutive re-assert of active suppressed (got ${JSON.stringify(wire)})`,
  );
}

// ── C8 — terminate ⇒ exactly one terminal signal (hidden), nothing after ──────
//   INV-11, INV-13, E8.
{
  section('C8 — terminate delivers exactly one terminal signal (hidden), no stateChange after');
  const c = makeContainer();
  c._protocol.sessionId = '99999999-9999-4999-8999-999999999999';
  const wire = [];
  c._protocol._sendMessage = (type, payload) => {
    if (type === protoMod.ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
  };
  // Spy faithfully models the real send layer's _terminated guard so the
  // post-terminal assertion exercises INV-11 (not a spy artifact).
  c._protocol._sendMessage = (type, payload) => {
    if (c._protocol._terminated) return; // real _sendMessage rejects when terminated; here: drop (no push)
    if (type === protoMod.ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
  };
  c.setState('ready');
  c.setState('active');
  wire.length = 0; // measure only the terminate-time delivery
  c._terminate();
  assert(
    JSON.stringify(wire) === JSON.stringify(['hidden']),
    `terminate delivers exactly one terminal "hidden" (got ${JSON.stringify(wire)})`,
  );
  // INV-11: nothing can be delivered after the terminal signal — _terminate()
  // tears down the protocol, so a further sendStateChange reaches a terminated
  // _sendMessage and is rejected (no delivery).
  const afterCount = wire.length;
  c._protocol.sendStateChange('active');
  assert(wire.length === afterCount, 'no stateChange delivered after the terminal signal (protocol terminated)');

  // terminated→hidden dedup: if the container was ALREADY hidden, terminate must
  // not deliver a second hidden (the §3 dedup suppresses it) — still one signal.
  const c2 = makeContainer();
  c2._protocol.sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const wire2 = [];
  c2._protocol._sendMessage = (type, payload) => {
    if (type === protoMod.ContainerMessages.STATE_CHANGE) wire2.push(payload.containerState);
  };
  c2.setState('ready');
  c2.setState('active');
  c2.setState('hidden');
  wire2.length = 0;
  c2._terminate();
  assert(
    wire2.length === 0,
    `already-hidden container delivers NO extra hidden on terminate (dedup) (got ${JSON.stringify(wire2)})`,
  );
}

// ── C9 — freeze→restore: active→hidden→frozen→active all delivered ───────────
//   INV-2, INV-10, E9: restore active not deduped against frozen.
{
  section('C9 — active→hidden→frozen→active ⇒ active,hidden,frozen,active delivered');
  const c = makeContainer();
  c._protocol.sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const wire = [];
  c._protocol._sendMessage = (type, payload) => {
    if (type === protoMod.ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
  };
  c.setState('ready');
  c.setState('active');
  c.setState('hidden');
  c.setState('frozen');
  c.setState('active'); // restore (frozen→active is a legal edge)
  assert(
    JSON.stringify(wire) === JSON.stringify(['ready', 'active', 'hidden', 'frozen', 'active']),
    `restore active is delivered (distinct from frozen, not deduped) (got ${JSON.stringify(wire)})`,
  );
}

if (failures > 0) {
  console.error(`\n✗ ${failures} container-state-establish-push assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All container state establish-push assertions passed.');
