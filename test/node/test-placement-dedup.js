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

import { SHARCContainer } from '../../dist/sharc-container.mjs';

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

// Cases 6 & 7 drive the full notifyPlacementChange → _syncPlacementState
// round-trip, so notifyPlacementChange's `ContainerMessages.PLACEMENT_CHANGE`
// reference must resolve. The container ESM destructures ContainerMessages from
// window.SHARC.Protocol when neither `module` nor a Protocol global is present.
// Set that up, then re-import the container under a cache-busting query so the
// destructure re-evaluates with the enum available (the static import above ran
// before the global existed and cached ContainerMessages as undefined).
globalThis.window = globalThis.window || {};
globalThis.window.SHARC = globalThis.window.SHARC || {};
globalThis.window.SHARC.Protocol = {
  ContainerMessages: { PLACEMENT_CHANGE: 'SHARC:Container:placementChange' },
};
const { SHARCContainer: SHARCContainerLive } =
  await import(`../../dist/sharc-container.mjs?dedup=${Date.now()}`);
const makeLiveContainer = () => Object.create(SHARCContainerLive.prototype);

// -- Case 6: PR #402 regression — intent-stamped send must dedup on re-sync. --
//          notifyPlacementChange() stamps `intent` onto the stored payload.
//          _syncPlacementState() rebuilds the comparison payload and must
//          produce the IDENTICAL shape (intent included) so an unchanged
//          re-sync is suppressed. Pre-fix, the stored payload carried an
//          `intent` key the rebuilt comparison payload lacked, so every
//          ACTIVE re-sync re-sent a redundant placementChange.
{
  console.log('\nCase 6: intent-stamped send → unchanged re-sync is deduped (PR #402 regression)');
  const c = makeLiveContainer();
  const sent = [];
  c._currentIntent = null;
  c._protocol = { _sendMessage: (type, args) => sent.push({ type, args }) };
  const placement = { width: 320, height: 480, position: { x: 0, y: 0, width: 320, height: 480 } };
  c.environmentData = { currentPlacement: placement };

  c.notifyPlacementChange(placement);
  assert(sent.length === 1, 'first notifyPlacementChange sends exactly one message');

  const syncPayload = c._buildPlacementChangePayload(placement);
  assert(c._placementPayloadUnchanged(syncPayload) === true,
    're-sync payload matches the intent-stamped stored payload (dedup returns true)');

  c._syncPlacementState();
  assert(sent.length === 1, '_syncPlacementState with unchanged intent emits NO second message');
}

// -- Case 7: intent genuinely changed since last send → re-sync must resend. --
//          Guards against the fix over-suppressing: when _currentIntent differs
//          from the value stamped on the last send, the shapes differ and the
//          re-sync must go through.
{
  console.log('\nCase 7: intent changed since last send → re-sync resends (no over-suppression)');
  const c = makeLiveContainer();
  const sent = [];
  c._currentIntent = null;
  c._protocol = { _sendMessage: (type, args) => sent.push({ type, args }) };
  const placement = { width: 320, height: 480, position: { x: 0, y: 0, width: 320, height: 480 } };
  c.environmentData = { currentPlacement: placement };

  c.notifyPlacementChange(placement);
  assert(sent.length === 1, 'first notifyPlacementChange sends exactly one message');

  c._currentIntent = 'expand';
  const syncPayload = c._buildPlacementChangePayload(placement);
  assert(c._placementPayloadUnchanged(syncPayload) === false,
    'changed intent makes the re-sync payload differ (dedup returns false)');

  c._syncPlacementState();
  assert(sent.length === 2, '_syncPlacementState with changed intent emits a second message');
}

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} placement-dedup assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All placement-dedup assertions passed.');
}
