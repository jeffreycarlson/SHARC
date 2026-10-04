#!/usr/bin/env node

/**
 * G3 red contract R4 (#486, integrity vet A3): the omid3p relay's adSessionId
 * is the OM SDK's own id, read through the public accessor
 * AdSession.getAdSessionId() (session client 1.6.6 :1161; documented on
 * docs.iabtechlab.com/omsdk-1.5/js/AdSession.html: "Get the ID of this ad
 * session."). Every service-path event carries the same id (probe variant E),
 * so the in-frame (omid3p) and service channels correlate.
 *
 * RED on main 655cab5: _resolveOmidAdSessionId reads `session.sessionId` and
 * `session.context.sessionId`, which the real client lacks, and falls back to
 * the container placementSessionId.
 *
 * Consequence by design: the #484 gate golden (section G) changes in the fix
 * PR, because every relayed envelope's adSessionId changes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlacement, startedSession } from './g3-harness.js';

test('#486 R4: every relayed OMID Event carries AdSession.getAdSessionId()', async () => {
  const r = await runPlacement();
  const s = startedSession(r.standin);
  const ids = [...new Set(r.omidEnvelopes.filter((e) => e.event).map((e) => e.event.adSessionId))];
  assert.deepEqual(ids, [s.id],
    'omid3p adSessionId must equal the OM SDK session id the service-path events carry (got '
    + JSON.stringify(ids) + ', placementSessionId ' + JSON.stringify(r.c.placementSessionId) + ')');
  const serviceIds = [...new Set(r.serviceEvents.map((e) => e.adSessionId))];
  assert.deepEqual(serviceIds, [s.id], 'stand-in sanity: service events carry the same id');
});
