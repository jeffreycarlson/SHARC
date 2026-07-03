/**
 * test-protocol-attachport-idempotent.js — #405 follow-up: `_attachPort` must
 * be idempotent under addEventListener semantics.
 *
 * PR #405 switched `_attachPort` from `port.onmessage =` (single-slot,
 * replacement semantics) to `port.addEventListener('message', ...)`
 * (accumulation semantics) for iOS WKWebView listener coexistence. That
 * dropped the replacement behavior: every `_attachPort` call bound a FRESH
 * handler and never removed the previous one, so
 *
 *   1. same-port re-attach (the document.open replay path calls
 *      `attachRendererPort` with the SAME surviving port; bootstrap can also
 *      hit `_onBootstrapMessage` + `attachRendererPort`) accumulated listeners
 *      — one inbound message dispatched `_onPortMessage` N times; and
 *   2. `this._boundOnPortMessage = bind(...)` overwrote the only reference to
 *      the previous bound listener, so `reset()`/`terminate()` could only ever
 *      remove the LAST one — earlier listeners were permanently orphaned.
 *
 * Contract pinned here: exactly one SDK handler is ever live per protocol
 * instance. Re-attach removes the previously retained handler from the
 * previously attached port (same-port AND replacement-port cases) before
 * binding the new one.
 *
 *   A1 — same-port double attach → one peer message → exactly ONE dispatch
 *   A2 — replacement-port attach → new port dispatches once; OLD port zero
 *   A3 — reset() after multiple re-attaches → post after teardown → ZERO
 *        dispatches (no orphaned listener survives)
 *
 * Runs in Node after `npm run build`. No test framework. Uses a real
 * MessageChannel from node:worker_threads (browser-parity addEventListener/
 * start()/close()).
 */

import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

const { SHARCProtocolBase } = await import('../../dist/sharc-protocol.mjs');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

function drain() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function countingProtocol() {
  const proto = new SHARCProtocolBase();
  proto.dispatches = 0;
  proto._onPortMessage = function () { this.dispatches++; };
  return proto;
}

// ---------------------------------------------------------------------------
// A1 — same-port re-attach: one message, exactly one dispatch
// ---------------------------------------------------------------------------
console.log('A1: same-port double attach dispatches exactly once');
{
  const proto = countingProtocol();
  const { port1, port2 } = new NodeMessageChannel();

  proto._attachPort(port2);
  proto._attachPort(port2); // document.open replay path: SAME surviving port

  port1.postMessage({ type: 'probe' });
  await drain();

  assert(
    proto.dispatches === 1,
    `one peer message → one dispatch (got ${proto.dispatches})`
  );

  port1.close();
  port2.close();
}

// ---------------------------------------------------------------------------
// A2 — replacement-port attach: new port live, old port fully detached
// ---------------------------------------------------------------------------
console.log('A2: replacement-port attach detaches the old port');
{
  const proto = countingProtocol();
  const chanA = new NodeMessageChannel();
  const chanB = new NodeMessageChannel();

  proto._attachPort(chanA.port2);
  proto._attachPort(chanB.port2); // bfcache relink: NEW port replaces old

  chanB.port1.postMessage({ type: 'probe-b' });
  await drain();
  assert(
    proto.dispatches === 1,
    `message on replacement port → one dispatch (got ${proto.dispatches})`
  );

  chanA.port1.postMessage({ type: 'probe-a' });
  await drain();
  assert(
    proto.dispatches === 1,
    `message on OLD port → zero dispatches (total still 1, got ${proto.dispatches})`
  );

  chanA.port1.close();
  chanA.port2.close();
  chanB.port1.close();
  chanB.port2.close();
}

// ---------------------------------------------------------------------------
// A3 — reset() after multiple re-attaches leaves no orphaned listener
// ---------------------------------------------------------------------------
console.log('A3: reset() after re-attaches removes the live listener (no orphans)');
{
  const proto = countingProtocol();
  const { port1, port2 } = new NodeMessageChannel();

  proto._attachPort(port2);
  proto._attachPort(port2);
  proto._attachPort(port2);
  proto.reset();

  port1.postMessage({ type: 'post-teardown' });
  await drain();

  assert(
    proto.dispatches === 0,
    `post after reset() → zero dispatches (got ${proto.dispatches})`
  );

  port1.close();
  port2.close();
}

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll attachPort-idempotency assertions passed');
