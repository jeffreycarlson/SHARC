/**
 * test-placement-dedup.js — issue #6 regression coverage
 *
 * Exercises SHARCContainer's placement-change dedup directly. Runs in node
 * after `npm run build`. No browser, no test framework — just enough harness
 * to drive the dedup decision and assert the right outcome.
 *
 * The bug: prior to 0.5.4, _placementPayloadUnchanged compared only width,
 * height, and position bounds. If a non-geometric field (inline,
 * placementType, dataspec, data) changed without geometry changing, the
 * dedup falsely returned true and the update was silently suppressed.
 *
 * The fix: full JSON.stringify compare. Same geometry + same other fields →
 * still skipped (no regression on the intended dedup). Same geometry + any
 * other field changed → sent.
 */

import { SHARCContainer } from './dist/sharc-container.mjs';

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.log('  ✗', message);
    failures++;
  }
}

// We exercise _placementPayloadUnchanged directly via the prototype rather
// than instantiating SHARCContainer, because the constructor pulls in
// browser-only globals (MessageChannel, document) that don't exist in node.
// The dedup method only reads this._lastSentPlacement, so a plain object
// bound to the prototype is enough surface for this test.
function makeContainer() {
  return Object.create(SHARCContainer.prototype);
}

console.log('test-placement-dedup.js — issue #6 regression\n');

// -- Case 1: identical payload should be considered unchanged. ---------------
{
  console.log('Case 1: identical payload → unchanged');
  const c = makeContainer();
  const payload = { width: 320, height: 50, position: { x: 0, y: 0, width: 320, height: 50 } };
  c._lastSentPlacement = payload;
  assert(c._placementPayloadUnchanged(payload) === true,
    'identical payload returns true (dedup correct)');
}

// -- Case 2: geometry changes — must NOT be considered unchanged. ------------
{
  console.log('\nCase 2: geometry change → changed');
  const c = makeContainer();
  c._lastSentPlacement = { width: 320, height: 50, position: { x: 0, y: 0, width: 320, height: 50 } };
  const next = { width: 728, height: 90, position: { x: 0, y: 0, width: 728, height: 90 } };
  assert(c._placementPayloadUnchanged(next) === false,
    'width/height change returns false (no false dedup)');
}

// -- Case 3: ISSUE #6 — non-geometric field changes, geometry identical. -----
//          Pre-fix this returned true (bug). Post-fix it returns false.
{
  console.log('\nCase 3: non-geometric field change with identical geometry → changed (issue #6)');
  const c = makeContainer();
  const baseGeom = { width: 320, height: 50, position: { x: 0, y: 0, width: 320, height: 50 } };

  c._lastSentPlacement = { ...baseGeom, inline: true };
  const nextInline = { ...baseGeom, inline: false };
  assert(c._placementPayloadUnchanged(nextInline) === false,
    'inline true→false (geometry unchanged) returns false');

  c._lastSentPlacement = { ...baseGeom, dataspec: { adcom: 'v1' } };
  const nextDataspec = { ...baseGeom, dataspec: { adcom: 'v2' } };
  assert(c._placementPayloadUnchanged(nextDataspec) === false,
    'dataspec swap (geometry unchanged) returns false');

  c._lastSentPlacement = { ...baseGeom, placementType: 'inline' };
  const nextPlacementType = { ...baseGeom, placementType: 'interstitial' };
  assert(c._placementPayloadUnchanged(nextPlacementType) === false,
    'placementType change (geometry unchanged) returns false');

  c._lastSentPlacement = { ...baseGeom, data: { campaignId: 'A' } };
  const nextData = { ...baseGeom, data: { campaignId: 'B' } };
  assert(c._placementPayloadUnchanged(nextData) === false,
    'data field change (geometry unchanged) returns false');
}

// -- Case 4: no prior send — must NOT be considered unchanged. ---------------
{
  console.log('\nCase 4: no prior send → changed');
  const c = makeContainer();
  c._lastSentPlacement = null;
  const payload = { width: 320, height: 50 };
  assert(c._placementPayloadUnchanged(payload) === false,
    'null prior payload returns false');
}

// -- Case 5: deep equality on nested position object. ------------------------
{
  console.log('\nCase 5: nested position field change → changed');
  const c = makeContainer();
  c._lastSentPlacement = { width: 320, height: 50, position: { x: 10, y: 20, width: 320, height: 50 } };
  const next = { width: 320, height: 50, position: { x: 11, y: 20, width: 320, height: 50 } };
  assert(c._placementPayloadUnchanged(next) === false,
    'position.x off-by-one returns false');
}

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} placement-dedup assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All placement-dedup assertions passed.');
}
