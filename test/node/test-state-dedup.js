/**
 * test-state-dedup.js — option-B send-layer dedup (State-Delivery Contract §3).
 *
 * THE exactly-once rule. `SHARCContainerProtocol.sendStateChange` tracks the
 * last queryable state sent on the current session (`_lastSentState`) and
 * suppresses an identical CONSECUTIVE send — strictly last-sent, never
 * set-membership. Both state-emitting container paths (the setState transition
 * send and the D1 establish push) route through this single function, so the
 * normal LOADING→ACTIVE path (transition send + D1 push) collapses to one
 * `active`, matching the already-ACTIVE/#336 path (symmetry, INV-3).
 *
 * Contract coverage (the suite IS the executable spec):
 *   D-1 → INV-1, E4          consecutive identical ⇒ one send
 *   D-2 → INV-2, INV-10, E3  active→passive→active ⇒ three sends (consecutive-only)
 *   D-3 → INV-3, E1, E2      normal vs already-ACTIVE both deliver one active (symmetry)
 *   D-4 → INV-12             non-queryable refused before touching _lastSentState
 *   D-5 → INV-12, E10        sessionId==='' no-op, _lastSentState untouched, no throw
 *   D-6 → INV-20, INV-21     _lastSentState reset on establish AND teardown (per-session)
 *
 * INV-22 (no cross-placement observability) is STRUCTURAL: each container owns
 * one SHARCContainerProtocol / one sessionId / one port, and sendStateChange
 * posts only on that container's own port — there is no API surface by which one
 * placement observes another's lifecycle state. It is covered by the per-session
 * isolation tests here (D-6) + C2's gate test, with no new test surface needed
 * (Contract §11.6).
 *
 * White-box: a real SHARCContainerProtocol with `_sendMessage` spied (so we
 * observe what actually crosses the wire). For D-3's symmetry the real
 * SHARCContainer drives both paths end-to-end.
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
const { SHARCContainerProtocol, ContainerMessages } = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}
function section(name) { console.log(`\n${name}`); }

const SID = '44444444-4444-4444-8444-444444444444';

/**
 * A real container protocol with `_sendMessage` spied. Records the queryable
 * state of every STATE_CHANGE that reaches the send layer (i.e. crosses the
 * wire). The actual port-send is swallowed (no port attached).
 */
function makeProto({ sessionId = SID } = {}) {
  const proto = new SHARCContainerProtocol();
  proto.sessionId = sessionId;
  const sent = [];
  proto._sendMessage = (type, payload) => {
    if (type === ContainerMessages.STATE_CHANGE) sent.push(payload.containerState);
  };
  return { proto, sent };
}

console.log('test-state-dedup.js — option-B send-layer dedup (Contract §3)\n');

// ── D-1 — INV-1, E4: consecutive identical ⇒ one send ────────────────────────
{
  section('D-1 — sendStateChange("active") twice consecutively ⇒ one send');
  const { proto, sent } = makeProto();
  proto.sendStateChange('active');
  proto.sendStateChange('active');
  check(sent.length === 1 && sent[0] === 'active', 'second identical consecutive send suppressed (one wire send)');
}

// ── D-2 — INV-2, INV-10, E3: distinct values always flow (consecutive-only) ──
{
  section('D-2 — active→passive→active ⇒ three sends (re-assert after a different value flows)');
  const { proto, sent } = makeProto();
  proto.sendStateChange('active');
  proto.sendStateChange('passive');
  proto.sendStateChange('active');
  check(
    JSON.stringify(sent) === JSON.stringify(['active', 'passive', 'active']),
    'all three distinct/re-asserted sends flow — dedup is consecutive-only, NOT set-membership',
  );
}

// ── D-3 — INV-3, E1/E2: symmetry — both paths deliver one active ─────────────
{
  section('D-3 — normal LOADING→ACTIVE path vs already-ACTIVE path both send one active (symmetry)');

  function makeContainer() {
    document.body.innerHTML = '';
    const slot = document.createElement('div');
    slot.id = 'ad-slot';
    document.body.appendChild(slot);
    const c = new SHARCContainer({
      creativeHtml: '<html><head></head><body>ad</body></html>',
      creativeRendererUrl: 'https://renderer.example/0.7.1/',
      placementElement: slot,
    });
    c._iframe = document.createElement('iframe');
    c._protocol.sessionId = SID;
    const sent = [];
    c._protocol._sendMessage = (type, payload) => {
      if (type === ContainerMessages.STATE_CHANGE) sent.push(payload.containerState);
    };
    return { c, sent };
  }

  // Normal path: READY transition send, then ACTIVE transition send + D1 push.
  const normal = makeContainer();
  normal.c.setState('ready');
  normal.c._handleStartCreativeResolved();
  check(
    JSON.stringify(normal.sent) === JSON.stringify(['ready', 'active']),
    `normal path delivers ["ready","active"] — D1's identical-consecutive push suppressed (got ${JSON.stringify(normal.sent)})`,
  );
  check(normal.sent.filter((s) => s === 'active').length === 1, 'normal path: exactly one active');

  // Already-ACTIVE path (#336): the adapter promotes LOADING→ACTIVE BEFORE the
  // handshake establishes the session — so that pre-handshake transition send is
  // dropped at the creative's port gate (no sessionId yet), and on establish the
  // dedup is reset per-session (INV-21). At resolve, _transitionToActive skips
  // setState (already ACTIVE, no transition send) so the D1 push is the ONLY
  // active send. Model the realistic ordering: promote with no session, then
  // establish (clears _lastSentState), then resolve.
  const already = makeContainer();
  already.c._protocol.sessionId = '';        // not established yet (pre-handshake)
  already.c.setState('ready');               // pre-handshake (sent dropped at gate)
  already.c.setState('active');              // pre-handshake promotion (dropped at gate)
  already.c._protocol.sessionId = SID;       // session establishes...
  already.c._protocol._lastSentState = undefined; // ...which resets the dedup (INV-21)
  already.sent.length = 0;                    // measure only the resolve-time sends
  already.c._handleStartCreativeResolved();
  check(
    already.sent.filter((s) => s === 'active').length === 1,
    `already-ACTIVE path: exactly one active via D1 only (got ${JSON.stringify(already.sent)})`,
  );
}

// ── D-4 — INV-12: non-queryable refused before touching _lastSentState ───────
{
  section('D-4 — non-queryable (loading/terminated) refused before _lastSentState');
  const { proto, sent } = makeProto();
  proto.sendStateChange('active');           // sets _lastSentState='active'
  const before = proto._lastSentState;
  proto.sendStateChange('loading');          // non-queryable → refused
  proto.sendStateChange('terminated');       // non-queryable → refused
  check(sent.length === 1 && sent[0] === 'active', 'non-queryable states never reach the wire');
  check(proto._lastSentState === before, '_lastSentState untouched by a refused non-queryable send');
}

// ── D-5 — INV-12, E10: sessionId==='' no-op, _lastSentState untouched, no throw
{
  section('D-5 — sessionId==="" ⇒ no-op, _lastSentState untouched, no throw');
  const { proto, sent } = makeProto({ sessionId: '' });
  let threw = false;
  try {
    proto.sendStateChange('active');
    proto.sendStateChange('passive');
  } catch (e) { threw = true; }
  check(!threw, 'sessionless sendStateChange does not throw');
  check(sent.length === 0, 'nothing crosses the wire with no session');
  check(proto._lastSentState === undefined, '_lastSentState stays undefined (no session ⇒ never recorded)');
}

// ── D-6 — INV-20, INV-21: _lastSentState reset on establish AND teardown ─────
{
  section('D-6 — _lastSentState reset per-session (establish + teardown)');

  // Teardown reset: after a send, reset() must clear _lastSentState so a new
  // session's first identical send is NOT deduped against the prior session.
  const { proto, sent } = makeProto();
  proto.sendStateChange('active');
  check(proto._lastSentState === 'active', 'after send, _lastSentState records "active"');
  proto.reset();
  check(proto._lastSentState === undefined, 'reset() (teardown) clears _lastSentState');

  // Establish reset: a stale prior value must not survive acceptSession. Set a
  // stale value, then establish a new session and confirm the first send of the
  // same value still flows (not deduped against the stale prior-session value).
  const proto2 = new SHARCContainerProtocol();
  const sent2 = [];
  proto2._sendMessage = (type, payload) => {
    if (type === ContainerMessages.STATE_CHANGE) sent2.push(payload.containerState);
  };
  proto2.sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  proto2.sendStateChange('active');          // _lastSentState='active' on the OLD session
  proto2._resolve = () => {};                 // acceptSession resolves; stub the wire
  proto2.acceptSession({ sessionId: '55555555-5555-4555-8555-555555555555' });
  check(proto2._lastSentState === undefined, 'acceptSession (establish) clears stale _lastSentState');
  proto2.sendStateChange('active');          // first send on the NEW session
  check(
    sent2.filter((s) => s === 'active').length === 2,
    'first send on the new session is NOT deduped against the prior session value (per-session isolation)',
  );
}

if (failures > 0) {
  console.error(`\n✗ ${failures} state-dedup assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All state-dedup assertions passed.');
