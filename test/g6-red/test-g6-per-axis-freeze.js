#!/usr/bin/env node

/**
 * G6 #433 dynamic contract — per-axis freeze latches (Fix 4).
 *
 * Internal dual review of PR #433 (CR-F4): the app adapter tracked freezes
 * with a single `_hostFroze` boolean, losing the PAGE axis whenever both
 * axes froze. Android WebView is Blink — the WICG `freeze`/`pagehide`
 * events are real there, so "both axes frozen" is a reachable production
 * state, and a host `'frozen'`-exit must not thaw a freeze the page axis
 * still asserts (most-severe rule, design § 4.3: the FROZEN severity is
 * held by WHICHEVER axis still asserts it).
 *
 * Designed contract: per-axis latches — host `'frozen'`-exit unfreezes ONLY
 * when the page axis is not frozen; page resume unfreezes ONLY when the
 * host axis is not frozen (the existing `_resolveRestoreDestination`
 * override already pins the second leg; both orderings of the first leg are
 * pinned here, from the CR probe).
 *
 * RED on 58d6932: in both orderings the host-frozen call flips the single
 * `_hostFroze` boolean, so the later host `'active'` exits a freeze the page
 * axis still owns.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContainerStates,
  makeContainer,
  dispatchFreeze,
  dispatchResume,
  setDocVisibility,
  driveToActive,
  flushContainers,
  sleep,
} from './app-adapter-harness.js';

test('G6 #433 F4 ordering A: page-freeze → host-frozen → host-active must HOLD FROZEN (page axis still frozen)', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);

    dispatchFreeze(); // page axis freezes (Blink WebView: real)
    assert.equal(c.getState(), ContainerStates.FROZEN, 'setup: page freeze ⇒ FROZEN');

    c.setHostLifecycle('frozen'); // host axis freezes too (app backgrounded)
    assert.equal(c.getState(), ContainerStates.FROZEN, 'setup: still FROZEN');

    c.setHostLifecycle('active'); // host axis thaws — page axis has NOT resumed
    assert.equal(
      c.getState(),
      ContainerStates.FROZEN,
      'G6 #433 F4 contract (CR-F4): a host \'frozen\'-exit may thaw ONLY the '
        + 'host axis — the page-asserted freeze (no `resume` yet) holds FROZEN '
        + 'under most-severe; the single _hostFroze boolean instead exits the '
        + 'page\'s freeze (got ' + c.getState() + ')',
    );

    dispatchResume(); // page axis resumes — now BOTH axes are thawed
    await sleep(5);
    assert.equal(
      c.getState(),
      ContainerStates.ACTIVE,
      'G6 #433 F4 contract: once the page axis resumes (host already active), '
        + 'the restore resolves normally to ACTIVE — got ' + c.getState(),
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});

test('G6 #433 F4 ordering B: host-frozen → page-freeze → host-active must HOLD FROZEN (page axis still frozen)', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);

    c.setHostLifecycle('frozen'); // host axis freezes first
    assert.equal(c.getState(), ContainerStates.FROZEN, 'setup: host frozen ⇒ FROZEN');

    dispatchFreeze(); // page axis freezes while already FROZEN
    assert.equal(c.getState(), ContainerStates.FROZEN, 'setup: still FROZEN');

    c.setHostLifecycle('active'); // host axis thaws — page axis has NOT resumed
    assert.equal(
      c.getState(),
      ContainerStates.FROZEN,
      'G6 #433 F4 contract (CR-F4): the page freeze that arrived WHILE '
        + 'host-frozen must be latched on its own axis — the host exit '
        + 'currently thaws both (got ' + c.getState() + ')',
    );

    dispatchResume(); // page axis resumes — now BOTH axes are thawed
    await sleep(5);
    assert.equal(
      c.getState(),
      ContainerStates.ACTIVE,
      'G6 #433 F4 contract: page resume with the host axis already active '
        + 'resolves the restore to ACTIVE — got ' + c.getState(),
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});
