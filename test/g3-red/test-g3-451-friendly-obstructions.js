#!/usr/bin/env node

/**
 * G3 red contract R6 (#451): the container close button as an OMID friendly
 * obstruction.
 *
 * Service path: there is nothing to call. The pinned session client has no
 * friendly-obstruction API (recorded surface), and omweb's session-service
 * method table has none either (omweb-v1.js `Nc`: setSlotElement,
 * setVideoElement, setElementBounds, setCreativeType, setImpressionType,
 * setContentUrl, adEvents, mediaEvents). omweb measures with an
 * IntersectionObserver, which cannot see overlapping elements, so it reports
 * declaredFriendlyObstructions: 0 and obstructions: [] (probe E, close button
 * overlay at t=3s). The bridge must not probe `addFriendlyObstruction`.
 *
 * omid3p path (SHARC-synthesized, composer-sourced): the close button is
 * declared in the spec shape the omweb geometry builder uses (`Ga`):
 * adView.onScreenGeometry.friendlyObstructions[] =
 *   {x, y, width, height, obstructionPurpose, obstructionReason}
 * plus top-level declaredFriendlyObstructions. Purpose 'closeAd'
 * (OMID FriendlyObstructionPurpose CLOSE_AD; the JS wire spelling of the full
 * enum is #452's scope). It is never filed under `obstructions`, and it does
 * not lower percentageInView (friendly by definition).
 *
 * RED on main 655cab5: registration depends on adSession.addFriendlyObstruction,
 * which the real client lacks, so _friendlyObstructionsGeometry returns [] and
 * the shape (purpose/reason keys, no friendlyObstructions array, no
 * declaredFriendlyObstructions) is non-spec.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlacement, relayed, layOut } from './g3-harness.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('#451 R6: close button declared in spec shape on the omid3p geometry, never via a phantom SDK call', async () => {
  let btn = null;
  let afterRemove = null;
  const r = await runPlacement({
    async whileActive(ctx) {
      btn = document.createElement('div');
      ctx.c.placementElement.appendChild(btn);
      layOut(btn, { x: 250, y: 100, width: 50, height: 50 });
      ctx.c._notifyOmidObstruction(btn, true);
      await wait(120);
      ctx.c._onRawIntersection(0.5);
      await wait(120);
      ctx.c._notifyOmidObstruction(btn, false);
      ctx.c._onRawIntersection(0.6);
      afterRemove = ctx.omidEnvelopes.length;
    },
  });
  const geos = relayed(r, 'geometryChange');
  const withBtn = geos.find((g) => g.data.adView.percentageInView === 50);
  assert.ok(withBtn, 'a geometryChange was relayed while the button was registered');
  assert.deepEqual(withBtn.data.adView.onScreenGeometry.friendlyObstructions, [{
    x: 250, y: 100, width: 50, height: 50,
    obstructionPurpose: 'closeAd', obstructionReason: 'Container close button',
  }], '#451: the close button is a friendlyObstructions entry with obstructionPurpose/obstructionReason (got '
    + JSON.stringify(withBtn.data.adView.onScreenGeometry) + ')');
  assert.deepEqual(withBtn.data.adView.onScreenGeometry.obstructions, [],
    'a friendly obstruction is never filed under obstructions');
  assert.equal(withBtn.data.declaredFriendlyObstructions, 1, 'declaredFriendlyObstructions counts it');
  const last = relayed({ omidEnvelopes: r.omidEnvelopes.slice(0, afterRemove) }, 'geometryChange').at(-1);
  assert.equal(last.data.declaredFriendlyObstructions, 0, 'unregistering the button clears the declaration');
  assert.ok(!r.standin.phantomReads.some((p) => /FriendlyObstruction/.test(p)),
    'no probe of a friendly-obstruction method the real client lacks (got '
    + JSON.stringify(r.standin.phantomReads.filter((p) => /FriendlyObstruction/.test(p))) + ')');
});
