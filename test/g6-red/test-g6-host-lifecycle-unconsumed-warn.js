#!/usr/bin/env node

/**
 * G6 #433 contract — one-time dev-channel warn for an unconsumed
 * setHostLifecycle (Fix 5, SE-F4).
 *
 * Internal dual review of PR #433: a host integration that wires
 * `setHostLifecycle` but leaves the container at `hostContext:'web'`
 * (default) selects the HtmlAdapter, whose `_onHostLifecycle` hook is the
 * base no-op — every host assertion is latched and silently dropped. That is
 * exactly the misconfiguration class `serviceMode`'s pre-injection warn
 * covers for OMID; the lifecycle INPUT gets the same one-time console.warn
 * naming the misconfiguration and the fix (`hostContext:'app'`). Dev channel
 * only — the structured channel stays quiet.
 *
 * Small GREEN-on-landing test per the review dispatch (warn-once assertion).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARCContainer } from '../../src/sharc-container.js';

function captureWarns(t) {
  const warns = [];
  t.mock.method(console, 'warn', (...args) => { warns.push(args.join(' ')); });
  return warns;
}

test('G6 #433 F5: setHostLifecycle under hostContext web warns once, naming hostContext app as the fix', (t) => {
  const warns = captureWarns(t);
  const receiver = { _hostContext: 'web', _lifecycleAdapter: null };
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'hidden');
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'active');
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'frozen');

  const relevant = warns.filter((w) => w.includes('setHostLifecycle'));
  assert.equal(
    relevant.length,
    1,
    'G6 #433 F5 contract (SE-F4): exactly ONE warn for the unconsumed '
      + 'host-lifecycle INPUT across repeated calls (got '
      + JSON.stringify(relevant) + ')',
  );
  assert.ok(
    relevant[0].includes("hostContext: 'app'") || relevant[0].includes("hostContext:'app'"),
    'G6 #433 F5 contract: the warn must name the fix — construct with '
      + "hostContext:'app' (got " + JSON.stringify(relevant[0]) + ')',
  );
});

test('G6 #433 F5: no warn when hostContext is app (the INPUT has its declared consumer)', (t) => {
  const warns = captureWarns(t);
  const deliveries = [];
  const receiver = {
    _hostContext: 'app',
    _lifecycleAdapter: { _onHostLifecycle: (s) => deliveries.push(s) },
  };
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'hidden');
  SHARCContainer.prototype.setHostLifecycle.call(receiver, 'active');

  const relevant = warns.filter((w) => w.includes('setHostLifecycle'));
  assert.deepEqual(
    relevant,
    [],
    'G6 #433 F5 contract: hostContext app selects the AppLifecycleAdapter — '
      + 'the INPUT is consumed and no misconfiguration warn may fire (got '
      + JSON.stringify(relevant) + ')',
  );
  assert.deepEqual(deliveries, ['hidden', 'active'], 'sanity: the adapter hook received both values');
});
