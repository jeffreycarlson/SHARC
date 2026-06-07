/**
 * test-lifecycle-ordering-conformance.js — the audit ordering invariants as
 * observable, end-to-end delivered sequences (State-Delivery Contract §5).
 *
 * Drives a REAL SHARCContainer over the legal transition graph (audit §2:
 * loading→ready→active⇄passive⇄hidden→frozen→…→terminated) and asserts the
 * creative-facing DELIVERY ordering — what crosses the wire to the creative,
 * post-dedup, post-gate. This is the lifecycle-ordering conformance test the
 * contract's §11 plan calls for: the suite IS the executable spec.
 *
 * Contract coverage:
 *   L1 → INV-7, INV-9   `ready` precedes `active`; queryable floor is `ready`
 *                       (`loading` is never delivered)
 *   L2 → INV-8          no active-equivalent (viewability) signal before `active`
 *                       is delivered (asserted at the channel: nothing ≥ready
 *                       implying viewable precedes the first `active`)
 *   L3 → INV-10         oscillation edges flow on every traversal; each distinct
 *                       state delivered; re-entry after a different value flows
 *   L4 → INV-11, INV-13 `terminated` is terminal: one terminal signal (hidden),
 *                       then nothing
 *
 * White-box: real container, `_protocol._sendMessage` spied to capture the
 * delivered queryable-state sequence. Runs in Node after `npm run build`.
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
const { ContainerMessages } = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}
function section(name) { console.log(`\n${name}`); }

let sidCounter = 0;
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
  c._protocol.sessionId = `${(++sidCounter).toString().padStart(8, '0')}-0000-4000-8000-000000000000`;
  const wire = [];
  c._protocol._sendMessage = (type, payload) => {
    if (type === ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
    return undefined;
  };
  return { c, wire };
}

console.log('test-lifecycle-ordering-conformance.js — delivered-sequence ordering invariants\n');

// ── L1 — ready precedes active; loading never delivered (INV-7, INV-9) ───────
{
  section('L1 — ready precedes active; queryable floor is ready (loading never delivered)');
  const { c, wire } = makeContainer();
  // LOADING is the construction state; it is non-queryable and must never be sent.
  c.setState('ready');
  c.setState('active');
  check(!wire.includes('loading'), 'loading is never delivered (non-queryable floor)');
  const iReady = wire.indexOf('ready');
  const iActive = wire.indexOf('active');
  check(iReady !== -1, 'ready is delivered');
  check(iActive !== -1 && iReady < iActive, 'ready is delivered BEFORE active');
  check(wire[0] === 'ready', 'the first delivered queryable state is ready');
}

// ── L2 — no active-equivalent delivered before active (INV-8) ─────────────────
{
  section('L2 — nothing implying viewability is delivered before the first active');
  const { c, wire } = makeContainer();
  c.setState('ready');
  // Before active, only ready (the floor) may have been delivered. The first
  // value that drives viewability (active) must be the first 'active' in the
  // sequence, with no earlier value that a bridge maps to viewable.
  const firstActive = wire.indexOf('active');
  check(firstActive === -1, 'before active is driven, no active in the delivered sequence');
  c.setState('active');
  const idx = wire.indexOf('active');
  const before = wire.slice(0, idx);
  check(before.every((s) => s === 'ready'), 'only ready precedes the first active (no premature viewable state)');
}

// ── L3 — oscillation flows on every traversal (INV-10) ───────────────────────
{
  section('L3 — oscillation: each distinct state delivered; re-entry after a different value flows');
  const { c, wire } = makeContainer();
  c.setState('ready');
  c.setState('active');
  c.setState('passive');
  c.setState('active');   // re-entry after passive → must flow (consecutive-only dedup)
  c.setState('hidden');
  c.setState('frozen');
  c.setState('active');   // restore after frozen → must flow
  check(
    JSON.stringify(wire) === JSON.stringify(['ready', 'active', 'passive', 'active', 'hidden', 'frozen', 'active']),
    `every distinct oscillation/restore edge delivered (got ${JSON.stringify(wire)})`,
  );
  check(wire.filter((s) => s === 'active').length === 3, 'active re-delivered on each distinct re-entry (3×)');
}

// ── L4 — terminated is terminal: one terminal signal, then nothing (INV-11/13)─
{
  section('L4 — terminate ⇒ one terminal hidden, then nothing');
  const { c, wire } = makeContainer();
  // Faithful send layer: drop sends once the protocol is terminated (real
  // _sendMessage rejects when _terminated), so the post-terminal assertion
  // exercises INV-11 rather than a spy artifact.
  c._protocol._sendMessage = (type, payload) => {
    if (c._protocol._terminated) return undefined;
    if (type === ContainerMessages.STATE_CHANGE) wire.push(payload.containerState);
    return undefined;
  };
  c.setState('ready');
  c.setState('active');
  wire.length = 0;
  c._terminate();
  check(JSON.stringify(wire) === JSON.stringify(['hidden']), 'terminate delivers exactly one terminal hidden');
  const after = wire.length;
  c._protocol.sendStateChange('active');
  c._protocol.sendStateChange('passive');
  check(wire.length === after, 'no stateChange delivered after the terminal signal');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} lifecycle-ordering assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All lifecycle-ordering conformance assertions passed.');
