#!/usr/bin/env node

/**
 * G3 red contract R9 (#486 mock honesty): the bridge touches only members the
 * pinned OM SDK session client actually has.
 *
 * #486 hid because ~15 test files mock registerAdView,
 * addFriendlyObstruction, Context.setContentUrl and friends, and every call
 * site is `typeof`-guarded, so against the real client the calls silently do
 * nothing. The stand-in exposes exactly the surface recorded from the real
 * 1.6.6 binary and records every read of anything else, `typeof` probes
 * included. A full placement (render, ACTIVE, placementChange, close button,
 * close) must read zero phantom members.
 *
 * RED on main 655cab5. Expected phantoms: AdSession.registerAdView,
 * Context.setContentUrl, Context.setServiceScriptUrl, AdSession.sessionId,
 * AdSession.context, AdEvents.stateChange, AdSession.addFriendlyObstruction,
 * AdSession.removeFriendlyObstruction (never registered, so not reached).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlacement, layOut } from './g3-harness.js';

test('#486 R9: a full web placement reads no OM SDK member the real client lacks', async () => {
  const r = await runPlacement({
    async whileActive({ c }) {
      layOut(c._iframe, { x: 0, y: 100, width: 300, height: 600 });
      c.notifyPlacementChange({ width: 300, height: 600 });
      const btn = document.createElement('div');
      c.placementElement.appendChild(btn);
      c._notifyOmidObstruction(btn, true);
      c._notifyOmidObstruction(btn, false);
    },
  });
  const phantoms = [...new Set(r.standin.phantomReads)].sort();
  assert.deepEqual(phantoms, [],
    'the bridge must call only the recorded 1.6.6 surface; phantom members read: ' + JSON.stringify(phantoms));
});
