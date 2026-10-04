#!/usr/bin/env node

/**
 * G3 red contract R5 (#485): the relayed impression honors `clid`.
 *
 * After #484 the relayed sessionStart forwards the OM SDK's
 * supports:['clid','vlid'] verbatim (ruling 2026-10-04: pass SDK context
 * through unchanged). OMID API 1.5 defines clid as "always provides the
 * geometryChange event and geometry data on the impression event"
 * (omid15 Context Object, `supports`). So the relayed impression must carry
 * geometry, in the shape the real omweb-v1 1.5.2 emits on its own impression
 * (probe variant E):
 *   { viewport, adView: { percentageInView, pixelsInView, reasons,
 *       geometry: {x,y,width,height,pixels},
 *       onScreenGeometry: {x,y,width,height,pixels,obstructions,friendlyObstructions} },
 *     declaredFriendlyObstructions, impressionType, mediaType, creativeType }
 * sourced from SHARC's composer (single geometry authority for the omid3p
 * channel, L1 §1.9): percentageInView === effectivePercent.
 *
 * `loaded` is NOT a geometry event: clid names only impression, and the real
 * omweb loaded data is { impressionType, mediaType, creativeType } (probe E;
 * IAB event-typedefs.js LoadedDisplayEventData). This corrects #485's
 * "impression/loaded" premise.
 *
 * RED on main 655cab5: impression and loaded relay `{}`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlacement, relayed, validationEvents } from './g3-harness.js';

const TYPES = { impressionType: 'beginToRender', mediaType: 'display', creativeType: 'htmlDisplay' };

test('#485 R5: relayed impression carries the clid geometry, in omweb\'s shape, from the composer', async () => {
  const r = await runPlacement();
  const [imp] = relayed(r, 'impression');
  assert.ok(imp, 'an impression was relayed');
  const ev = r.c._lastExtensionEffectivePayload;
  assert.equal(ev.effectivePercent, 100, 'harness sanity: composer reads 100%');
  assert.deepEqual(imp.data, {
    viewport: { width: 1024, height: 768 },
    adView: {
      percentageInView: 100,
      pixelsInView: 75000,
      reasons: [],
      geometry: { x: 0, y: 100, width: 300, height: 250, pixels: 75000 },
      onScreenGeometry: { x: 0, y: 100, width: 300, height: 250, pixels: 75000,
        obstructions: [], friendlyObstructions: [] },
    },
    declaredFriendlyObstructions: 0,
    ...TYPES,
  }, '#485: sessionStart promises clid, so impression.data must carry viewport + adView (got '
    + JSON.stringify(imp.data) + ')');
});

test('#485 R5: relayed geometryChange uses the same omweb-shaped adView builder', async () => {
  const r = await runPlacement();
  const geo = relayed(r, 'geometryChange').at(-1);
  assert.ok(geo, 'a geometryChange was relayed');
  assert.equal(geo.data.adView.pixelsInView, 75000, 'adView.pixelsInView is present (OMID 1.5 AdView object)');
  assert.equal(geo.data.adView.geometry.pixels, 75000, 'geometry.pixels is present (omweb Ga)');
  assert.deepEqual(geo.data.adView.onScreenGeometry.friendlyObstructions, [], 'friendlyObstructions array is present');
  assert.equal(geo.data.declaredFriendlyObstructions, 0, 'declaredFriendlyObstructions is present');
});

test('#485 R5: relayed loaded carries the type fields only, as the real omweb does', async () => {
  const r = await runPlacement();
  const [loaded] = relayed(r, 'loaded');
  assert.deepEqual(loaded && loaded.data, TYPES,
    'loaded.data is { impressionType, mediaType, creativeType } (got ' + JSON.stringify(loaded && loaded.data) + ')');
});

test('#485 R5: a clid-trusting IAB client reads adView off the impression it beacons', async () => {
  const r = await runPlacement();
  const imp = validationEvents(r.realm).find((e) => e.type === 'impression');
  assert.ok(imp, 'IAB ValidationVerificationClient beaconed the impression');
  assert.equal(imp.data && imp.data.adView && imp.data.adView.percentageInView, 100,
    'the vendor-visible impression carries adView.percentageInView (got ' + JSON.stringify(imp.data) + ')');
});
