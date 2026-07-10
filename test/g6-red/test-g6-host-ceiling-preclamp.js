#!/usr/bin/env node

/**
 * G6 #433 dynamic contract — pre-clamped host-ceiling destinations (Fix 2).
 *
 * Internal dual review of PR #433 (CR-B1 + SE-F2, BLOCKER): the shipped
 * super-then-cap shape emitted TRANSIENT states above the latched host
 * ceiling and then retracted them — host ceiling 'hidden' + one
 * IntersectionObserver promotion produced the setState sequence
 * ['passive','active','hidden'], and the transient ACTIVE fired the OMID
 * loaded/impression fan-out plus a stateChange pulse to the creative while
 * the host was asserting hidden.
 *
 * Designed contract (design § 4.3 most-severe rule, applied PRE-transition):
 * the destination passed to setState is already
 * `most-severe(pageDestination, hostCeiling)` on
 * `active < passive < hidden < frozen` — no state above the latched ceiling
 * ever appears anywhere in the transition sequence, so no extension or
 * creative consumer can observe an emitted-then-retracted out-promotion.
 * This covers the adapter's page-derived promotions AND the container's
 * handshake-driven `_transitionToActive` (which lands directly at the
 * clamped state).
 *
 * RED on 58d6932: the cap runs AFTER super's transitions, so every scenario
 * below records at least one above-ceiling state.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { OmidCompatBridge } from '../../src/sharc-omid-bridge.js';
import {
  ContainerStates,
  SEVERITY,
  makeContainer,
  recordTransitions,
  dispatchIframeLoad,
  triggerIntersection,
  driveToActive,
  flushContainers,
  sleep,
} from './app-adapter-harness.js';

function assertNothingAboveCeiling(transitions, ceiling, label) {
  const above = transitions.filter(
    (s) => SEVERITY[s] !== undefined && SEVERITY[s] < SEVERITY[ceiling],
  );
  assert.deepEqual(
    above,
    [],
    'G6 #433 F2 contract (CR-B1/SE-F2): NO state above the latched host '
      + `ceiling '${ceiling}' may appear anywhere in the ${label} sequence — `
      + 'an emitted-then-retracted out-promotion pulses the creative and the '
      + 'extension fan-out with a state the host is actively denying (got '
      + JSON.stringify(transitions) + ')',
  );
}

// ── Mock OM SDK (established pattern — test-restore-transient-hidden.js) ────
function createMockOmidSdk() {
  const stats = {
    startCalls: 0, loadedCalls: 0, impressionCalls: 0, visibilityStates: [],
  };
  class Partner { constructor() {} }
  class VerificationScriptResource { constructor() {} }
  class Context {
    constructor() {}
    setContentUrl() {}
    setServiceScriptUrl() {}
  }
  class AdSession {
    constructor() { this._observers = []; }
    isSupported() { return true; }
    setCreativeType() {}
    setImpressionType() {}
    registerAdView() {}
    registerSessionObserver(fn) { this._observers.push(fn); }
    start() { stats.startCalls += 1; }
    finish() { this._observers.forEach((fn) => fn({ type: 'sessionFinish' })); }
  }
  class AdEvents {
    constructor() {}
    loaded() { stats.loadedCalls += 1; }
    impressionOccurred() { stats.impressionCalls += 1; }
    stateChange(v) { stats.visibilityStates.push(v); }
  }
  class VastProperties { constructor() {} }
  return {
    sdk: {
      Partner, VerificationScriptResource, Context, AdSession, AdEvents, VastProperties,
    },
    stats,
  };
}

test('G6 #433 F2: page promotion attempt under a latched hidden ceiling emits NO above-ceiling state', async () => {
  try {
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);

    c.setHostLifecycle('hidden');
    assert.equal(
      c.getState(), ContainerStates.HIDDEN,
      'setup: latching the hidden ceiling demotes ACTIVE → HIDDEN',
    );

    const transitions = recordTransitions(c);
    // The page axis attempts an out-promotion (in-app the IO ratio reads
    // ~always-visible; a fresh ≥0.5 sample is exactly this attempt).
    triggerIntersection(io, { isIntersecting: true, intersectionRatio: 0.9 });
    await sleep(5);

    assertNothingAboveCeiling(transitions, 'hidden', 'IO-promotion');
    assert.equal(
      c.getState(), ContainerStates.HIDDEN,
      'G6 #433 F2 contract: the container rests AT the host ceiling '
        + '(most-severe rule) — got ' + c.getState(),
    );
  } finally {
    flushContainers();
  }
});

test('G6 #433 F2: ceiling latched pre-handshake — the handshake resolution lands at the clamped state, no transient ACTIVE, no OMID impression', async () => {
  const mock = createMockOmidSdk();
  global.OmidSessionClient = mock.sdk;
  window.OmidSessionClient = mock.sdk;
  try {
    const extLog = [];
    const stubExt = {
      onContainerStateChange(newState) { extLog.push(newState); },
    };
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const { c } = makeContainer({
      hostContext: 'app',
      requireSharcInit: true,
      extensions: [bridge, stubExt],
    });

    // Handshake bootstrap: the creative's createSession drives LOADING → READY.
    c.setState(ContainerStates.READY);
    assert.equal(
      bridge._omid.sessionStarted, true,
      'setup: OMID session created at READY (mock SDK present)',
    );

    // Host asserts hidden BEFORE the handshake resolves (app backgrounding /
    // covered view controller mid-load). READY is outside the visibility
    // axis, so the assertion latches without a transition.
    c.setHostLifecycle('hidden');
    assert.equal(c.getState(), ContainerStates.READY, 'setup: READY untouched by the latch');

    const transitions = recordTransitions(c);
    extLog.length = 0;
    // The creative resolves Container:startCreative — the handshake-driven
    // ACTIVE transition site.
    c._handleStartCreativeResolved();
    await sleep(5);

    assertNothingAboveCeiling(transitions, 'hidden', 'handshake-resolution');
    assert.ok(
      !extLog.includes(ContainerStates.ACTIVE),
      'G6 #433 F2 contract: the extension fan-out must never see the '
        + 'transient ACTIVE (got extension stateChange log '
        + JSON.stringify(extLog) + ')',
    );
    assert.equal(
      mock.stats.impressionCalls, 0,
      'G6 #433 F2 contract (SE-F2): no OMID impression may fire while the '
        + 'host asserts hidden — the transient ACTIVE fan-out fired one',
    );
    assert.equal(
      mock.stats.loadedCalls, 0,
      'G6 #433 F2 contract (SE-F2): no OMID loaded event while the host '
        + 'asserts hidden',
    );
    assert.equal(
      c.getState(), ContainerStates.HIDDEN,
      'G6 #433 F2 contract: the handshake resolution lands directly at the '
        + 'clamped state (READY → HIDDEN, no ACTIVE hop) — got ' + c.getState(),
    );
  } finally {
    delete global.OmidSessionClient;
    delete window.OmidSessionClient;
    flushContainers();
  }
});

test('G6 #433 F2: ceiling latched pre-render (preload) — the initial adapter promotion lands at the clamped state, not through ACTIVE', async () => {
  try {
    const { c, io } = makeContainer({
      hostContext: 'app',
      beforeLoad: (container) => container.setHostLifecycle('hidden'),
    });
    const transitions = recordTransitions(c);
    dispatchIframeLoad(c);
    triggerIntersection(io, { isIntersecting: true, intersectionRatio: 0.9 });
    await sleep(5);

    assertNothingAboveCeiling(transitions, 'hidden', 'preload initial-transition');
    assert.equal(
      c.getState(), ContainerStates.HIDDEN,
      'G6 #433 F2 contract: the preloaded container still LEAVES loading — '
        + 'it lands directly at the clamped HIDDEN (endpoint parity with the '
        + 'old cap-after-super behavior, minus the transient ACTIVE) — got '
        + c.getState(),
    );
  } finally {
    flushContainers();
  }
});
