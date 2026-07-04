/**
 * test-omid-postclose-adversarial.js — post-close OMID bridge zombie defense
 * (PR #413 security review, promoted repro).
 *
 * THREAT MODEL (SE review of the Slice D consumer re-point): the
 * container-side OMID bridge is the measurement root. A hostile or buggy
 * upstream that keeps pushing container lifecycle events AFTER `close` must
 * not be able to
 *
 *   Q3a  produce vendor-visible output (adEvents.stateChange /
 *        geometryChange relays) from post-close effectiveVisibilityChange
 *        stragglers — "measured-and-visible" after teardown would let a
 *        zombie frame keep earning viewability;
 *   Q3b  restart a finished session via a post-close 'active' stateChange
 *        (sessionFinish is terminal — OMID: always the last event);
 *   Q3c  re-arm the internal visibility signal (`_signalVisibility`) once
 *        the session is finished;
 *   Q1   flood the geometryChange relay: 50 rapid EV deliveries within a few
 *        ms must be absorbed by the D-7 ≤1-event/100ms bridge throttle.
 *
 * These pins are GREEN from birth — they pin current correct behavior as
 * regression armor for the measurement root. Every assert drives the REAL
 * built bridge (`dist/sharc-omid-bridge.mjs`): only the vendor-side sinks
 * (adEvents/mediaEvents) and, in the flood case, the postMessage transport
 * preconditions are stubbed; the lifecycle entry points, session latch, and
 * the throttle under test are production code paths.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://publisher.example/page.html',
});
global.window = dom.window;
global.document = dom.window.document;

const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}

console.log('test-omid-postclose-adversarial.js — post-close OMID zombie defense (PR #413 SE review)\n');

// ── Q3 — post-close EV / stateChange / _signalVisibility are all dead ────────
{
  console.log('Q3 — post-close deliveries produce zero vendor-visible output:');
  const bridge = new OmidCompatBridge({ exposeOmid3p: true });

  // Vendor-visible sinks (what a verification script would observe).
  const adEventCalls = [];
  const relayCalls = [];
  bridge._omid.sessionStarted = true;
  bridge._omid.adEvents = { stateChange: (s) => adEventCalls.push(s) };
  bridge._omid.mediaEvents = { playerStateChange: () => {} };
  bridge._relayOmidEvent = function (type, data) { relayCalls.push({ type, data }); };

  const fakeContainer = { getState: () => 'active', _iframe: null };

  // 1. Live EV while the session runs → exactly one vendor-visible VISIBLE.
  bridge.onContainerLifecycleEvent({
    type: 'effectiveVisibilityChange', container: fakeContainer,
    payload: { effectivePercent: 80, reason: null, visibleRectangle: null },
  });
  assert(adEventCalls.length === 1 && adEventCalls[0] === 'VISIBLE',
    'live EV(80) → adEvents.stateChange(VISIBLE) exactly once');

  // 2. close → session finished (sessionFinish is the terminal signal).
  bridge.onContainerLifecycleEvent({ type: 'close', container: fakeContainer });
  assert(bridge._omid.sessionStarted === false && bridge._omid.sessionFinished === true,
    'close → sessionStarted=false, sessionFinished=true');

  const adMark = adEventCalls.length;
  const relayMark = relayCalls.length;

  // 3. Q3a — post-close EV straggler must be dead on BOTH vendor surfaces.
  bridge.onContainerLifecycleEvent({
    type: 'effectiveVisibilityChange', container: fakeContainer,
    payload: { effectivePercent: 100, reason: null, visibleRectangle: null },
  });
  assert(adEventCalls.length === adMark, 'post-close EV(100) → zero adEvents calls');
  assert(relayCalls.length === relayMark, 'post-close EV(100) → zero geometryChange relays');

  // 4. Q3b — post-close 'active' stateChange must NOT restart the session,
  // even with a fresh (attacker-supplied) adEvents sink wired in.
  bridge._omid.adEvents = { stateChange: (s) => adEventCalls.push(s) };
  bridge.onContainerStateChange('active', 'hidden', fakeContainer);
  assert(bridge._omid.sessionStarted === false,
    'post-close stateChange(active) does NOT restart the session');
  assert(adEventCalls.length === adMark, 'post-close active → zero adEvents calls');

  // 5. Q3c — the internal visibility signal is inert once finished.
  bridge._signalVisibility('visible');
  assert(adEventCalls.length === adMark, '_signalVisibility after close is a no-op');
}

// ── Q1 — D-7 flood: the real _relayOmidEvent throttle absorbs a 50-push burst ─
{
  console.log('\nQ1 — D-7 flood: 50 rapid EV pushes pass the real relay throttle ≤1 time:');
  const b2 = new OmidCompatBridge({ exposeOmid3p: true });
  b2._omid.sessionStarted = true;
  b2._omid.adEvents = { stateChange: () => {} };
  b2._omid.mediaEvents = { playerStateChange: () => {} };
  // Keep the REAL _relayOmidEvent throttle in the path; stub only the
  // transport preconditions below it and count actual postMessage sends.
  b2._omidProtocolRegistered = true;
  b2._omidProtocolNonce = 'nonce';
  b2._omidIframeOrigin = 'https://renderer.example';
  let posted = 0;
  const iframeStub = { contentWindow: { postMessage: () => { posted++; } } };
  b2._container = {
    getState: () => 'active',
    _iframe: iframeStub,
    _rendererOrigin: 'https://renderer.example',
    protocolRouter: { buildOutbound: () => ({}) },
  };
  // Seed a stable viewability boolean so every subsequent delivery takes the
  // geometryChange-only relay path (no stateChange edges to muddy the count).
  b2.onContainerLifecycleEvent({
    type: 'effectiveVisibilityChange', container: b2._container,
    payload: { effectivePercent: 50, reason: null, visibleRectangle: null },
  });
  const seedPosts = posted;
  for (let i = 0; i < 50; i++) {
    b2.onContainerLifecycleEvent({
      type: 'effectiveVisibilityChange', container: b2._container,
      payload: { effectivePercent: 50 + (i % 40), reason: null, visibleRectangle: null },
    });
  }
  // All 50 deliveries land within a few ms — the ≥100ms-interval throttle
  // must suppress essentially all of them.
  assert(posted - seedPosts <= 1,
    `50 same-boolean EV bursts → ${posted - seedPosts} geometryChange posts (throttle holds, ≤1)`);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} post-close adversarial assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✓ All post-close OMID adversarial assertions passed.');
