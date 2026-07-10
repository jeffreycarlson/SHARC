#!/usr/bin/env node

/**
 * G6 #433 dynamic contract — native-mode SERVICE-presence probe (Fix 1).
 *
 * Internal dual review of PR #433 (CR-B2 ≡ SE-F1, BLOCKER): the bounded
 * native-service wait polled `isOmSdkLoaded()`, which detects the
 * OmidSessionClient NAMESPACE — the thing the bridge itself just injected.
 * The REAL `omid-session-client-v1.js` exports that namespace UNCONDITIONALLY
 * at script-evaluation time, with or without a service present (SE proved it
 * executable against the pinned real client: the wait resolved in 1ms with
 * zero service). Consequence: a host that declared `serviceMode:'native'` but
 * forgot to inject omsdk-v1.js got a silently DEAD AdSession latched as
 * `sessionStarted` — and the designed `'native-service-missing'` failure was
 * dead code.
 *
 * Designed contract (design § 1.2, corrected 2026-07-10): service presence is
 * only observable via the session client's public `AdSession.isSupported()`
 * probe — true iff the client's communication resolved against a service or
 * the native `omidSessionInterface` exists (covers both native injection
 * shapes). On false at the bounded-wait expiry: route to the existing
 * `feature_load_failed` chokepoint with reason `'native-service-missing'` and
 * do NOT latch `sessionStarted` (no dead AdSession reported as live). The
 * 50ms poll interval is cleared on bridge destroy (teardown-mid-load is NOT a
 * feature_load_failed — H3 contract).
 *
 * The stub below mirrors the real client's PUBLIC export shape only
 * (unconditional namespace export; isSupported() reports service presence) —
 * self-contained, no private-tree dependency.
 *
 * RED on 58d6932: the wait resolves against the client namespace, the session
 * "starts" dead, and no `native-service-missing` event is ever emitted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { OmidCompatBridge } from '../../src/sharc-omid-bridge.js';

const CLIENT_URL = 'https://cdn.example/omid/omid-session-client-v1.js';

/**
 * Installs a session-client stub that mirrors the REAL client's export shape:
 * the namespace (Partner/Context/AdSession/...) exists unconditionally — its
 * presence proves only that the client script evaluated, never that a service
 * is reachable. `AdSession.isSupported()` is the only service-presence signal.
 */
function installSessionClientStub({ serviceSupported }) {
  const stats = { startCalls: 0, isSupportedCalls: 0 };
  class Partner { constructor() {} }
  class Context {
    constructor() {}
    setContentUrl() {}
    setServiceScriptUrl() {}
  }
  class AdSession {
    constructor() {}
    isSupported() { stats.isSupportedCalls += 1; return serviceSupported; }
    setCreativeType() {}
    setImpressionType() {}
    registerAdView() {}
    registerSessionObserver() {}
    start() { stats.startCalls += 1; }
    finish() {}
  }
  class AdEvents {
    constructor() {}
    loaded() {}
    impressionOccurred() {}
  }
  globalThis.window = {
    OmidSessionClient: { Partner, Context, AdSession, AdEvents },
  };
  // Minimal DOM so `_ensureSdkLoaded`'s Node-safety guard passes (a WebView
  // always has a document); the pre-present client namespace means no script
  // is ever actually injected.
  globalThis.document = { createElement: () => ({}) };
  return stats;
}

function uninstallSessionClientStub() {
  delete globalThis.window;
  delete globalThis.document;
}

function makeContainerStub() {
  const events = [];
  return {
    events,
    _terminated: false,
    _emitFeatureLoadFailed(feature, reason, scriptUrl) {
      events.push({ feature, reason, scriptUrl });
    },
    getState() { return 'ready'; },
  };
}

function makeNativeBridge() {
  return new OmidCompatBridge({
    serviceMode: 'native',
    omSdkSessionClientUrl: CLIENT_URL,
    creativeType: 'display',
    mediaType: 'display',
  });
}

test('G6 #433 F1: no service behind the client ⇒ sessionStarted stays false and native-service-missing reaches feature_load_failed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  installSessionClientStub({ serviceSupported: false });
  try {
    const bridge = makeNativeBridge();
    const container = makeContainerStub();
    bridge.onContainerLifecycleEvent({ type: 'load', container });
    bridge.onContainerStateChange('ready', 'loading', container);
    const pending = bridge._sessionCreationPromise;
    // Drain microtasks so the bounded wait's interval is scheduled (the
    // client-step .then runs as a microtask), THEN advance the mocked clock.
    await new Promise((resolve) => { setImmediate(resolve); });
    t.mock.timers.tick(6000);
    await pending; // null on the vacuous-detection code path — await tolerates

    assert.equal(
      bridge._omid.sessionStarted,
      false,
      'G6 #433 F1 contract (CR-B2/SE-F1): with serviceMode:\'native\' and NO '
        + 'reachable service, sessionStarted must stay false — the session '
        + 'client exports its namespace unconditionally, so a namespace-only '
        + 'probe (isOmSdkLoaded) latches a silently DEAD AdSession as live. '
        + 'Service presence is only observable via AdSession.isSupported().',
    );
    assert.equal(
      container.events.length,
      1,
      'G6 #433 F1 contract: the bounded-wait expiry must route to the '
        + 'feature_load_failed chokepoint exactly once — on the vacuous '
        + 'namespace probe this path is dead code (got '
        + JSON.stringify(container.events) + ')',
    );
    assert.equal(
      container.events[0].reason,
      'native-service-missing',
      'G6 #433 F1 contract: the structured reason must be '
        + '\'native-service-missing\' (design § 1.2 failure mode) — got '
        + JSON.stringify(container.events[0]),
    );
  } finally {
    uninstallSessionClientStub();
  }
});

test('G6 #433 F1: service present behind the client (isSupported true) ⇒ the session proceeds', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const stats = installSessionClientStub({ serviceSupported: true });
  try {
    const bridge = makeNativeBridge();
    const container = makeContainerStub();
    bridge.onContainerLifecycleEvent({ type: 'load', container });
    bridge.onContainerStateChange('ready', 'loading', container);

    assert.equal(
      bridge._omid.sessionStarted,
      true,
      'G6 #433 F1 contract: when AdSession.isSupported() reports a reachable '
        + 'service, the native-mode session must start normally',
    );
    assert.equal(
      stats.startCalls,
      1,
      'G6 #433 F1 contract: exactly one AdSession.start() for the live session',
    );
    assert.equal(
      container.events.length,
      0,
      'G6 #433 F1 contract: no feature_load_failed when the service is present '
        + '(got ' + JSON.stringify(container.events) + ')',
    );
  } finally {
    uninstallSessionClientStub();
  }
});

test('G6 #433 F1: destroy mid-wait clears the poll interval and emits no feature_load_failed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  installSessionClientStub({ serviceSupported: false });
  try {
    const bridge = makeNativeBridge();
    const container = makeContainerStub();
    bridge.onContainerLifecycleEvent({ type: 'load', container });
    bridge.onContainerStateChange('ready', 'loading', container);
    // Drain microtasks so the bounded wait's interval is scheduled.
    await new Promise((resolve) => { setImmediate(resolve); });

    // Mid-wait: nothing has started and nothing has failed yet. RED today for
    // the same root cause — the vacuous namespace probe resolves instantly and
    // latches the dead session, so there IS no wait to be mid-way through.
    assert.equal(
      bridge._omid.sessionStarted,
      false,
      'G6 #433 F1 contract: the bounded service wait must still be pending '
        + 'mid-wait — the vacuous isOmSdkLoaded probe instead resolves '
        + 'instantly and starts a dead session',
    );

    bridge.destroy();
    assert.equal(
      bridge._nativeWaitIntervalId,
      null,
      'G6 #433 F1 contract: destroy() must clear the 50ms native-service poll '
        + 'interval (no orphaned timer after teardown)',
    );

    t.mock.timers.tick(6000);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(
      container.events.length,
      0,
      'G6 #433 F1 contract (H3): teardown-mid-load is NOT a '
        + 'feature_load_failed — got ' + JSON.stringify(container.events),
    );
    assert.equal(
      bridge._omid.sessionStarted,
      false,
      'G6 #433 F1 contract: no session may start after destroy',
    );
  } finally {
    uninstallSessionClientStub();
  }
});
