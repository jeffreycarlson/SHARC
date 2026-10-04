#!/usr/bin/env node

/**
 * G3 red contract R8 (#486): native-mode impact, stated exactly.
 *
 * In-app the native OM SDK is the authority and measures the WebView itself
 * (ruling 2026-10-04; OMID 1.5 AdView.geometry: "the native-layer WebView
 * container" when no web-layer element is measured). So in
 * serviceMode:'native' the bridge registers NO slot element and sends NO
 * element bounds: unchanged from today (baseline pin, green).
 *
 * What does change in native mode, by design, because it is the same session
 * client: the relayed adSessionId becomes AdSession.getAdSessionId() (R4), and
 * contentUrl follows the R7 rule. The adSessionId part is RED today.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlacement, startedSession } from './g3-harness.js';

test('#486 R8: native mode registers no slot element and no bounds (baseline pin, green today)', async () => {
  const r = await runPlacement({ serviceMode: 'native' });
  assert.ok(startedSession(r.standin), 'harness sanity: the native-mode session started');
  const elementCalls = r.standin.calls.filter((x) => x.api === 'Context.setSlotElement'
    || x.api === 'Context.setVideoElement' || x.api === 'AdSession.setElementBounds');
  assert.deepEqual(elementCalls.map((x) => x.api), [],
    'native SDK measures the WebView; the web integrator calls must not run in native mode');
});

test('#486 R8: native mode relays the SDK adSessionId too (same client, same fix)', async () => {
  const r = await runPlacement({ serviceMode: 'native' });
  const s = startedSession(r.standin);
  const ids = [...new Set(r.omidEnvelopes.filter((e) => e.event).map((e) => e.event.adSessionId))];
  assert.deepEqual(ids, [s.id], 'native omid3p adSessionId === getAdSessionId() (got ' + JSON.stringify(ids) + ')');
});
