#!/usr/bin/env node

/**
 * G6 #433 dynamic contract — container visibilitychange vs the host ceiling,
 * and the dedup self-heal (Fix 3).
 *
 * Internal dual review of PR #433 (CR-F3), two legs:
 *
 *  (a) The container's `_onVisibilityChange` visible-branch drives
 *      HIDDEN → PASSIVE directly (`setState`), bypassing the lifecycle
 *      adapter entirely — so a latched host ceiling of 'hidden' is
 *      out-promoted by a plain web `visibilitychange → visible` and NOTHING
 *      re-applies the cap (the cap only runs on IO/host deliveries). The
 *      promotion must route through the adapter (mirroring the `_onResume`
 *      single-authority yield) so the app adapter pre-clamps it; the web
 *      path keeps today's HIDDEN → PASSIVE behavior.
 *
 *  (b) `setHostLifecycle`'s consecutive-identical dedup early-returns BEFORE
 *      re-inviting the adapter, so the host's mandatory
 *      re-assert-on-foreground (design § 4.4 seam U6) cannot self-heal a
 *      container state that sits ABOVE the latched ceiling. The dedup must
 *      skip the latch write but still reconcile a ceiling violation.
 *
 * RED on 58d6932: (a) rests at PASSIVE above the hidden ceiling;
 * (b) the repeated assertion is a full no-op.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContainerStates,
  SEVERITY,
  makeContainer,
  recordTransitions,
  triggerIntersection,
  dispatchVisibilityChange,
  setDocVisibility,
  driveToActive,
  flushContainers,
  sleep,
} from './app-adapter-harness.js';

test('G6 #433 F3a: visibilitychange→visible under a latched hidden ceiling must not out-promote past the ceiling', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);

    c.setHostLifecycle('hidden');
    assert.equal(c.getState(), ContainerStates.HIDDEN, 'setup: ceiling latched, ACTIVE → HIDDEN');

    // Web visibility round-trip while the HOST still asserts hidden (e.g. the
    // WebView's page flips visibility while the covering view controller has
    // not been dismissed).
    setDocVisibility('hidden');
    dispatchVisibilityChange();
    assert.equal(c.getState(), ContainerStates.HIDDEN, 'setup: still HIDDEN while page hidden');

    const transitions = recordTransitions(c);
    setDocVisibility('visible');
    dispatchVisibilityChange();
    await sleep(5);

    const above = transitions.filter(
      (s) => SEVERITY[s] !== undefined && SEVERITY[s] < SEVERITY.hidden,
    );
    assert.deepEqual(
      above,
      [],
      'G6 #433 F3a contract (CR-F3): the container\'s visible-branch '
        + 'HIDDEN → PASSIVE promotion must route through the adapter so the '
        + 'app adapter pre-clamps it at the host ceiling — it currently '
        + 'bypasses the adapter and setStates PASSIVE directly (got '
        + JSON.stringify(transitions) + ')',
    );
    assert.equal(
      c.getState(),
      ContainerStates.HIDDEN,
      'G6 #433 F3a contract: the container rests AT the hidden ceiling after '
        + 'the visibility flip, and nothing re-caps it later — got '
        + c.getState(),
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});

test('G6 #433 F3a guard: the web path keeps the HIDDEN → PASSIVE visible-flip promotion (green baseline pin)', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer(); // hostContext omitted — stock web embed
    await driveToActive(c, io);

    setDocVisibility('hidden');
    dispatchVisibilityChange();
    assert.equal(c.getState(), ContainerStates.HIDDEN, 'setup: page hidden ⇒ HIDDEN');

    setDocVisibility('visible');
    dispatchVisibilityChange();
    await sleep(5);
    assert.equal(
      c.getState(),
      ContainerStates.PASSIVE,
      'G6 #433 F3a web pin: stock web embeds keep today\'s HIDDEN → PASSIVE '
        + 'promotion on visibilitychange → visible — routing through the '
        + 'adapter must not change web behavior',
    );
    // And the retained IO signal still promotes back to ACTIVE.
    triggerIntersection(io, { isIntersecting: true, intersectionRatio: 0.9 });
    await sleep(5);
    assert.equal(c.getState(), ContainerStates.ACTIVE, 'web pin: IO ≥ 0.5 re-promotes to ACTIVE');
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});

test('G6 #433 F3b: a repeated identical setHostLifecycle reconciles a state above the latched ceiling (U6 self-heal)', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);

    c.setHostLifecycle('hidden');
    assert.equal(c.getState(), ContainerStates.HIDDEN, 'setup: ceiling latched, ACTIVE → HIDDEN');

    // Artificially violate the ceiling through the raw container API (any
    // ceiling-bypassing promotion path stands in here).
    c.setState(ContainerStates.PASSIVE);
    assert.equal(c.getState(), ContainerStates.PASSIVE, 'setup: state forced above the ceiling');

    // U6: the host re-asserts its CURRENT state. The value is identical, so
    // the dedup skips the latch write — but it must still reconcile the
    // violated ceiling instead of early-returning past the adapter.
    c.setHostLifecycle('hidden');
    assert.equal(
      c.getState(),
      ContainerStates.HIDDEN,
      'G6 #433 F3b contract (CR-F3 / seam U6): the dedup early-return must '
        + 'not swallow the re-assert when the container state sits ABOVE the '
        + 'latched ceiling — the host\'s mandatory re-assert-on-foreground is '
        + 'the designed self-heal, and today it is a full no-op (got '
        + c.getState() + ')',
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});
