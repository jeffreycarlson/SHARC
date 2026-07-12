#!/usr/bin/env node

/**
 * G6 #438 dynamic contract — host-axis RISE recompute (ruling U7).
 *
 * Issue #438 (iOS Simulator, real WKWebView background → foreground
 * round-trip): the host delivers `passive → hidden → frozen → passive →
 * active` (with U6 `active` re-asserts on foreground) and the page axis
 * delivers ZERO events — WKWebView fires no freeze/resume and no
 * visibility/intersection restore on this path. The container walks
 * `ready → active → passive → hidden → frozen → passive` and STRANDS at
 * PASSIVE: the host axis was implemented demote-only (`_capAtHostCeiling`),
 * so nothing recomputes the § 4.3 most-severe function when the host
 * assertion becomes MORE permissive, and the promotion the design expects
 * depends on page events that do not exist in-app (§ 4.1 blindness).
 *
 * Designed contract (§ 4.3: SHARC state = most-severe(host, page) — a
 * FUNCTION of both axes, in both directions): a host-axis rise re-evaluates
 * the composed target and promotes through the pre-clamped
 * `_promoteContainerState` machinery, honoring the page-axis freeze latch
 * (`_pageFroze`), the ACTIVE prerequisites (a pre-ready container must not
 * jump), and U6 idempotence.
 *
 * RED on 37683c1: R1/R4 strand at 'passive' — the exact #438 symptom.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContainerStates,
  makeContainer,
  recordTransitions,
  dispatchFreeze,
  dispatchResume,
  setDocVisibility,
  driveToActive,
  flushContainers,
  sleep,
} from './app-adapter-harness.js';

test('G6 #438 R1: the simulator host sequence (zero page events) must end ACTIVE with no overshoot', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);
    const transitions = recordTransitions(c);

    // The #438 host input sequence, verbatim — no page-axis events at all.
    c.setHostLifecycle('passive');
    c.setHostLifecycle('hidden');
    c.setHostLifecycle('frozen');
    c.setHostLifecycle('passive');
    c.setHostLifecycle('active');

    assert.equal(
      c.getState(),
      ContainerStates.ACTIVE,
      'G6 #438 contract (ruling U7): the foreground host rise '
        + "passive → active must recompute most-severe(host, page) and "
        + 'promote — the demote-only ceiling strands the container at '
        + "'" + c.getState() + "'",
    );
    assert.deepEqual(
      transitions,
      [
        ContainerStates.PASSIVE,
        ContainerStates.HIDDEN,
        ContainerStates.FROZEN,
        ContainerStates.PASSIVE,
        ContainerStates.ACTIVE,
      ],
      'G6 #438 contract: EMITTED-clean — exactly one transition per host '
        + 'edge, no overshoot past the composed target, no stuck-PASSIVE '
        + '(got ' + JSON.stringify(transitions) + ')',
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});

test('G6 #438 R2: a host rise while the PAGE axis is frozen holds FROZEN (per-axis latch survives the recompute path)', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);

    c.setHostLifecycle('frozen'); // host axis freezes (app backgrounded)
    dispatchFreeze();             // page axis freezes too (Blink WebView: real)
    assert.equal(c.getState(), ContainerStates.FROZEN, 'setup: FROZEN');

    c.setHostLifecycle('active'); // host-axis RISE frozen → active
    assert.equal(
      c.getState(),
      ContainerStates.FROZEN,
      'G6 #438 contract: the rise recompute must not out-promote a freeze '
        + 'the page axis still asserts (most-severe, § 4.3) — got '
        + c.getState(),
    );

    dispatchResume(); // page axis thaws — now the rise may complete
    await sleep(5);
    assert.equal(
      c.getState(),
      ContainerStates.ACTIVE,
      'G6 #438 contract: once both axes thaw, the restore resolves to '
        + 'ACTIVE — got ' + c.getState(),
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});

test('G6 #438 R3: a host rise on a pre-ready container must not jump the ACTIVE prerequisites', async () => {
  try {
    setDocVisibility('visible');
    // Permissive container that has NOT met the LOADING → ACTIVE gates
    // (no iframe load, no intersection) — still LOADING.
    const { c } = makeContainer({ hostContext: 'app' });
    assert.equal(c.getState(), ContainerStates.LOADING, 'setup: LOADING');
    const transitions = recordTransitions(c);

    c.setHostLifecycle('hidden');
    c.setHostLifecycle('active'); // host-axis RISE hidden → active

    assert.equal(
      c.getState(),
      ContainerStates.LOADING,
      'G6 #438 contract: the rise recompute only promotes ON the visibility '
        + 'axis — a pre-ready container (LOADING, gates unmet) must not '
        + 'jump to ACTIVE (got ' + c.getState() + ')',
    );
    assert.deepEqual(
      transitions,
      [],
      'G6 #438 contract: no transition fires off-axis (got '
        + JSON.stringify(transitions) + ')',
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});

test('G6 #438 R4: repeated U6 active re-asserts after the rise are idempotent — no duplicate emissions', async () => {
  try {
    setDocVisibility('visible');
    const { c, io } = makeContainer({ hostContext: 'app' });
    await driveToActive(c, io);
    const transitions = recordTransitions(c);

    c.setHostLifecycle('passive');
    c.setHostLifecycle('hidden');
    c.setHostLifecycle('frozen');
    c.setHostLifecycle('passive');
    c.setHostLifecycle('active');
    const afterRise = transitions.length;

    // U6: the host MUST re-assert on every foreground return — the #438
    // harness observed re-asserts at 250ms / 750ms / 1.25s.
    c.setHostLifecycle('active');
    c.setHostLifecycle('active');
    c.setHostLifecycle('active');

    assert.equal(
      c.getState(),
      ContainerStates.ACTIVE,
      'G6 #438 contract: the rise lands ACTIVE and re-asserts keep it there '
        + '(got ' + c.getState() + ')',
    );
    assert.equal(
      transitions.length,
      afterRise,
      'G6 #438 contract (U6 dedup): identical re-asserts after the rise '
        + 'emit NO further transitions (got '
        + JSON.stringify(transitions.slice(afterRise)) + ')',
    );
  } finally {
    setDocVisibility('visible');
    flushContainers();
  }
});
