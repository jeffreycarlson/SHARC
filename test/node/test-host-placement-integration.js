/**
 * test-host-placement-integration.js — PR #403 review-feedback coverage
 *
 * Exercises the native-host integration hooks added to SHARCContainer:
 *   - hostOwnsClamping flag stored correctly at construction
 *   - _resolveClosePosition clamp skipped/fired consistently on _hostOwnsClamping
 *   - _validatePlacementRequest policy offscreen skip on _hostOwnsClamping (missing gate fix)
 *   - close-region clamp NOT skipped when onPlacementChange wired but hostOwnsClamping false
 *   - (0,0) pin under hostOwnsClamping via _resolveClosePosition
 *   - _buildPlacementChangePayload offset fold (setHostScreenOffset geometry)
 *   - setHostScreenOffset malformed-input rejection (null/NaN/Infinity/missing x,y)
 *   - setHostScreenOffset dedup guard (repeated same-offset calls don't re-fire)
 *   - notifyPlacementChange throwing-host swallow leaves state machine intact
 *   - targetPosition: null forwarded to callback when extra.hostTargetPosition absent
 *
 * Runs in Node after `npm run build`. No test framework.
 * Uses dynamic imports so protocol is wired onto window.SHARC.Protocol before
 * the container module loads (required for ErrorCodes and other protocol refs).
 */

import { JSDOM } from 'jsdom';

// ── DOM globals + protocol — must be in place before the container module loads ──
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: 'https://publisher.example/page.html' },
);
global.window    = dom.window;
global.document  = dom.window.document;
global.HTMLElement   = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort   = dom.window.MessagePort;

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

// ── Harness ───────────────────────────────────────────────────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

// Bind to the prototype without invoking the constructor.
// All module-scope constants (ErrorCodes etc.) are now accessible via closure
// because window.SHARC.Protocol was wired before the module loaded.
function makeContainer() {
  return Object.create(SHARCContainer.prototype);
}

// Minimal mock protocol for tests that send messages.
function mockProtocol() {
  const sent = [];
  return {
    sent,
    _sendMessage: (type, args) => sent.push({ type, args }),
    _reject: () => {},
    _resolve: () => {},
  };
}

console.log('test-host-placement-integration.js — PR #403 review feedback\n');

// ── 1. hostOwnsClamping stored as _hostOwnsClamping ───────────────────────
{
  console.log('1. _hostOwnsClamping field on prototype-bound container');

  const c = makeContainer();
  c._hostOwnsClamping = true;
  assert(c._hostOwnsClamping === true, '_hostOwnsClamping = true round-trips');
  c._hostOwnsClamping = false;
  assert(c._hostOwnsClamping === false, '_hostOwnsClamping = false round-trips');
}

// ── 2. _resolveClosePosition — clamp fired when !_hostOwnsClamping ────────
{
  console.log('\n2. _resolveClosePosition — clamp consistency');

  const c = makeContainer();
  c._iframe = { offsetLeft: 0, offsetTop: 0 };
  // Stub so close rect is always offscreen (left < 0).
  c._computeCloseRegionRect = () => ({ left: -10, top: 0, right: 40, bottom: 40 });
  c._getViewportBounds = () => ({ width: 400, height: 400 });

  // Without hostOwnsClamping: offscreen hint should be overridden to top-right.
  c._hostOwnsClamping = false;
  const r1 = c._resolveClosePosition(
    { position: 'bottom-left', size: 50 },
    { width: 200, height: 200 },
    { x: 0, y: 0 },
  );
  assert(r1.position === 'top-right', 'clamp fires — overrides offscreen hint to top-right');
  assert(r1.overridden === true, 'overridden flag set');

  // With hostOwnsClamping: clamp is skipped; creative hint is honoured.
  c._hostOwnsClamping = true;
  const r2 = c._resolveClosePosition(
    { position: 'bottom-left', size: 50 },
    { width: 200, height: 200 },
    { x: 0, y: 0 },
  );
  assert(r2.position === 'bottom-left', 'clamp skipped — creative hint honoured');
  assert(r2.overridden === false, 'overridden flag not set');
}

// ── 3. _validatePlacementRequest — policy offscreen skip on hostOwnsClamping
{
  console.log('\n3. _validatePlacementRequest — policy offscreen skip (missing gate fix)');

  const c = makeContainer();
  c._iframe = { offsetLeft: 0, offsetTop: 0 };
  c._getViewportBounds = () => ({ width: 400, height: 400 });
  // Stub _resolveClosePosition so step 4 doesn't influence result.
  c._resolveClosePosition = () => ({ position: 'top-right', size: 50, overridden: false });

  c._placementPolicy = { allowedIntents: ['resize'], allowOffscreen: false };

  const oversizeArgs = {
    intent: 'resize',
    targetDimensions: { width: 800, height: 800 }, // clearly offscreen in 400×400 viewport
    allowOffscreen: false,
  };

  // Without hostOwnsClamping: offscreen resize under policy should be rejected.
  c._hostOwnsClamping = false;
  const without = c._validatePlacementRequest(oversizeArgs);
  assert(without.valid === false, 'policy offscreen reject fires when hostOwnsClamping false');

  // With hostOwnsClamping: host owns clamping — policy offscreen check skipped.
  c._hostOwnsClamping = true;
  const withFlag = c._validatePlacementRequest(oversizeArgs);
  assert(withFlag.valid === true, 'policy offscreen reject skipped when hostOwnsClamping true');
}

// ── 4. Regression: clamp NOT skipped when onPlacementChange wired but hostOwnsClamping false
{
  console.log('\n4. Regression guard: onPlacementChange alone does not skip clamp');

  const c = makeContainer();
  c._iframe = { offsetLeft: 0, offsetTop: 0 };
  c._computeCloseRegionRect = () => ({ left: -10, top: 0, right: 40, bottom: 40 });
  c._getViewportBounds = () => ({ width: 400, height: 400 });

  // Observer-only: has callback but hostOwnsClamping is false (default).
  c._onPlacementChange = () => {};
  c._hostOwnsClamping = false;

  const r = c._resolveClosePosition(
    { position: 'bottom-left', size: 50 },
    { width: 200, height: 200 },
    null,
  );
  assert(r.position === 'top-right', 'clamp fires even when onPlacementChange is wired');
  assert(r.overridden === true, 'overridden flag set — observer-only callback has no clamping effect');
}

// ── 5. _buildPlacementChangePayload — offset fold ─────────────────────────
{
  console.log('\n5. _buildPlacementChangePayload — offset fold');

  const c = makeContainer();
  c._iframe = {
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 300, height: 250 }),
  };

  // No offset set: position should equal raw iframe rect.
  c._hostScreenOffset = null;
  const p1 = c._buildPlacementChangePayload({});
  assert(p1.position.x === 10, 'no offset — x equals iframe rect x');
  assert(p1.position.y === 20, 'no offset — y equals iframe rect y');

  // Offset set: position should include offset.
  c._hostScreenOffset = { x: 100, y: 200 };
  const p2 = c._buildPlacementChangePayload({});
  assert(p2.position.x === 110, 'offset folded — x = iframeRect.x + offsetX');
  assert(p2.position.y === 220, 'offset folded — y = iframeRect.y + offsetY');
}

// ── 6. setHostScreenOffset — malformed input rejection ────────────────────
{
  console.log('\n6. setHostScreenOffset — malformed input rejected');

  // Each invalid call should return without updating _hostScreenOffset.
  // The method returns before touching _protocol on bad input.
  const cases = [
    [null, 'null'],
    [undefined, 'undefined'],
    [{ x: NaN, y: 0 }, 'NaN x'],
    [{ x: 0, y: NaN }, 'NaN y'],
    [{ x: Infinity, y: 0 }, 'Infinity x'],
    [{ x: 0, y: Infinity }, 'Infinity y'],
    [{ x: -Infinity, y: 0 }, '-Infinity x'],
    [{}, 'missing x and y'],
    [{ x: 5 }, 'missing y'],
    [{ y: 5 }, 'missing x'],
  ];

  for (const [input, label] of cases) {
    const c = makeContainer();
    c._hostScreenOffset = null;
    c.setHostScreenOffset(input);
    assert(c._hostScreenOffset === null, `${label} → _hostScreenOffset stays null`);
  }
}

// ── 7. setHostScreenOffset — dedup guard ─────────────────────────────────
{
  console.log('\n7. setHostScreenOffset — repeated same-offset calls deduplicated');

  const c = makeContainer();
  c._hostScreenOffset = null;
  c._currentIntent = null;
  c._extensions = [];
  c._iframe = {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 50 }),
  };
  c.environmentData = { currentPlacement: {} };
  const proto = mockProtocol();
  c._protocol = proto;
  c._lastSentPlacement = null;

  // First call: should send.
  c.setHostScreenOffset({ x: 10, y: 20 });
  assert(proto.sent.length === 1, 'first setHostScreenOffset sends PLACEMENT_CHANGE');

  // Second call with the same effective payload: dedup should suppress.
  c.setHostScreenOffset({ x: 10, y: 20 });
  assert(proto.sent.length === 1, 'same offset again is deduplicated (no extra send)');

  // Different offset: should send again.
  c.setHostScreenOffset({ x: 10, y: 99 });
  assert(proto.sent.length === 2, 'changed offset sends a second PLACEMENT_CHANGE');
}

// ── 8. notifyPlacementChange — throwing-host swallow ─────────────────────
{
  console.log('\n8. notifyPlacementChange — throwing-host callback does not corrupt state');

  const c = makeContainer();
  c._currentIntent = 'resize';
  c._lastSentPlacement = null;
  c._hostScreenOffset = null;
  c._iframe = {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 50 }),
  };
  c._extensions = [];
  const proto = mockProtocol();
  c._protocol = proto;

  c._onPlacementChange = () => { throw new Error('host exploded'); };

  let threw = false;
  try {
    c.notifyPlacementChange({ width: 320, height: 50 });
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'notifyPlacementChange does not propagate host callback throw');
  assert(c._currentIntent === 'resize', '_currentIntent preserved after host callback throws');
  assert(c._lastSentPlacement !== null, '_lastSentPlacement was committed before callback');
}

// ── 9. notifyPlacementChange — targetPosition null when hostTargetPosition absent
{
  console.log('\n9. notifyPlacementChange — callback receives null targetPosition when extra.hostTargetPosition absent');

  const c = makeContainer();
  c._currentIntent = 'resize';
  c._lastSentPlacement = null;
  c._hostScreenOffset = null;
  c._iframe = {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 50 }),
  };
  c._extensions = [];
  const proto = mockProtocol();
  c._protocol = proto;

  let cbArg;
  c._onPlacementChange = (arg) => { cbArg = arg; };

  // No hostTargetPosition in extra — models non-finite coords being dropped upstream.
  c.notifyPlacementChange({ width: 320, height: 50 }, { transition: 'none' });
  assert(cbArg !== undefined, 'callback was invoked');
  assert(cbArg.targetPosition === null, 'targetPosition is null when extra.hostTargetPosition absent');

  // Valid hostTargetPosition — should be forwarded.
  cbArg = undefined;
  c.notifyPlacementChange({ width: 320, height: 50 }, { hostTargetPosition: { x: 5, y: 10 } });
  assert(cbArg !== undefined, 'callback invoked with hostTargetPosition');
  assert(cbArg.targetPosition !== null, 'targetPosition non-null when hostTargetPosition present');
  assert(cbArg.targetPosition.x === 5 && cbArg.targetPosition.y === 10, 'coords forwarded verbatim');
}

// ── 10. (0,0) pin — _resolveClosePosition at zero origin under hostOwnsClamping
{
  console.log('\n10. (0,0) pin — close region uses zero origin when hostOwnsClamping');

  const c = makeContainer();
  c._iframe = { offsetLeft: 50, offsetTop: 50 };
  c._hostOwnsClamping = true;
  // Rect is in-bounds for any position within 1000×1000.
  c._computeCloseRegionRect = (adX, adY) => ({
    left: adX, top: adY, right: adX + 50, bottom: adY + 50,
  });
  c._getViewportBounds = () => ({ width: 1000, height: 1000 });

  // With hostOwnsClamping and (0,0) origin, hint should be honoured without override.
  const r = c._resolveClosePosition(
    { position: 'top-right', size: 50 },
    { width: 320, height: 50 },
    { x: 0, y: 0 },
  );
  assert(r.position === 'top-right', '(0,0) pin: top-right hint honoured at zero origin');
  assert(r.overridden === false, '(0,0) pin: not overridden when hostOwnsClamping');
}

// ── Result ────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} host-placement-integration assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All host-placement-integration assertions passed.');
}
