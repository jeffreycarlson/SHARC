#!/usr/bin/env node

/**
 * G6 red contract R-A — the L1 host-lifecycle INPUT seam.
 *
 * Designed contract (G6 design doc, Decision 4.5 — NHI ADR amendment): the
 * container exposes `setHostLifecycle(state)`, a HOST-PROVIDED INPUT (NHI C6
 * `set*` naming) with the page-lifecycle enum 'active'|'passive'|'hidden'|
 * 'frozen'. In-app this INPUT is the ONLY source of FROZEN (WebKit does not
 * fire the WICG freeze/resume events, and there is no browser chrome inside a
 * WebView to fire them).
 *
 *   - Validate-first, STRICT (Rule-11/13 pattern, deliberately stricter than
 *     setHostExposure's silent-ignore): a value outside the enum throws
 *     TypeError — a silently dropped 'frozen' leaves the container measuring
 *     a suspended app.
 *   - Declared consumer: the app lifecycle adapter, NEVER a bridge (NHI C2).
 *     The base adapter grows the `_onHostLifecycle` hook (base no-op) so the
 *     container forwards through the adapter seam.
 *   - Dedup: consecutive-identical values are no-ops, so the host's mandatory
 *     re-assert-on-foreground (seam U6) is free.
 *
 * RED today: neither setHostLifecycle nor _onHostLifecycle exists.
 *
 * See ADR: ~/Obsidian/dev-team/sharc/2026-07-08-g6-omid-in-app-design.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARCContainer } from '../../src/sharc-container.js';
import { BaseLifecycleAdapter } from '../../src/lifecycle-adapters/base-adapter.js';

const CONTRACT_MISSING =
  'G6 L1 contract: SHARCContainer must expose the host-lifecycle INPUT '
  + 'setHostLifecycle(state) (NHI set* naming; the only in-app source of '
  + 'FROZEN) — no such surface exists today';

test('G6 R-A: container exposes the setHostLifecycle INPUT', () => {
  assert.equal(
    typeof SHARCContainer.prototype.setHostLifecycle,
    'function',
    CONTRACT_MISSING,
  );
});

test('G6 R-A: setHostLifecycle validates first — non-enum values throw TypeError', () => {
  assert.equal(
    typeof SHARCContainer.prototype.setHostLifecycle, 'function',
    CONTRACT_MISSING,
  );
  // Validate-first means validation precedes any state access, so a bare
  // receiver is sufficient to exercise the guard.
  for (const bad of ['banana', 'terminated', '', 42, null, undefined, {}]) {
    assert.throws(
      () => SHARCContainer.prototype.setHostLifecycle.call({}, bad),
      TypeError,
      'G6 L1 contract (Rule-11/13 strictness): setHostLifecycle('
        + JSON.stringify(bad) + ') must throw TypeError — the lifecycle enum '
        + 'comes from host adapter glue, and a silently dropped value is the '
        + 'worst silent failure this surface can produce',
    );
  }
});

test('G6 R-A: setHostLifecycle accepts the four page-lifecycle enum values and latches the value', () => {
  assert.equal(
    typeof SHARCContainer.prototype.setHostLifecycle, 'function',
    CONTRACT_MISSING,
  );
  for (const state of ['active', 'passive', 'hidden', 'frozen']) {
    const receiver = { _lifecycleAdapter: null };
    SHARCContainer.prototype.setHostLifecycle.call(receiver, state);
    assert.equal(
      receiver._hostLifecycle,
      state,
      'G6 L1 contract: setHostLifecycle(' + JSON.stringify(state) + ') must '
        + 'latch the host-asserted value (_hostLifecycle) for replay-of-last '
        + 'to a late-attaching adapter (NHI C7)',
    );
  }
});

test('G6 R-A: the base adapter declares the _onHostLifecycle consumer hook (base no-op)', () => {
  assert.equal(
    typeof BaseLifecycleAdapter.prototype._onHostLifecycle,
    'function',
    'G6 L1 contract (NHI C2 — declared consumer): the lifecycle-adapter '
      + 'family is the INPUT\'s consumer, so BaseLifecycleAdapter must declare '
      + 'the _onHostLifecycle hook (base no-op, mirroring '
      + '_maybeAdvanceToActive) — the bridge is never the consumer',
  );
});

test('G6 R-A: consecutive-identical host assertions dedup to one adapter delivery', () => {
  assert.equal(
    typeof SHARCContainer.prototype.setHostLifecycle, 'function',
    CONTRACT_MISSING,
  );
  const deliveries = [];
  const receiver = {
    _lifecycleAdapter: { _onHostLifecycle: (state) => deliveries.push(state) },
  };
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'frozen');
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'frozen');
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'active');
  assert.deepEqual(
    deliveries,
    ['frozen', 'active'],
    'G6 L1 contract: consecutive-identical values are no-ops (dedup mirrors '
      + '_lastSentState) so the host\'s mandatory re-assert-on-foreground '
      + '(seam U6) is idempotent — got ' + JSON.stringify(deliveries),
  );
});
