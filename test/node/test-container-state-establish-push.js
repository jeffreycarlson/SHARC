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

  // Phase 2: creative sets its sessionId (session established).
  creativeProto.sessionId = '11111111-1111-4111-8111-111111111111';
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
  c._protocol.acceptSession = function (msg) { this.sessionId = sid; };

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
  c2._protocol.acceptSession = function (msg) { this.sessionId = sid; };
  c2._handleCreateSession({ sessionId: sid, args: { version: '0.7.9', placementType: 'inline' } });
  assert(sentEnv2 && sentEnv2.currentState === 'ready', 'at READY, env.currentState is "ready"');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} container-state-establish-push assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All container state establish-push assertions passed.');
