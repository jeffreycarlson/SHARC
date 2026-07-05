/**
 * test-safeframe-readiness-sequence.js — #339 SafeFrame wrapper adapter sequence.
 *
 * The SafeFrame analogue of test-mraid-readiness-sequence.js. Node covers the
 * adapter half of the wrapper: once the renderer-provisioned wrapper has
 * installed sharc-safeframe-bridge on top of window.SHARC (the
 * `__sharcSafeFrameBridgeAutoInstall` opt-in path the renderer uses), the
 * shipped bridge:
 *   - installs window.$sf.ext synchronously,
 *   - registers the SHARC.onReady / onStart / stateChange subscriptions,
 *   - maps Container:init to a populated geom cache, and
 *   - maps stateChange('active') to the SafeFrame 'geom-update' callback.
 *
 * That stateChange('active') -> geom-update is exactly the late-subscriber
 * path #339 closes: R1's container->creative current-state push reaches the
 * bridge only once the wrapper has established a SHARC session, after which
 * this mapping delivers visibility to the creative. Real renderer provisioning
 * (a raw SafeFrame creative that ships NO SHARC SDK) is covered end-to-end by
 * the creative-validator runner.
 */

import assert from 'node:assert/strict';

const readyCallbacks = [];
const startCallbacks = [];
const eventListeners = {};

globalThis.location = { protocol: 'http:', hostname: 'localhost' };
globalThis.console = console;
globalThis.window = {
  __sharcSafeFrameBridgeAutoInstall: true,
  SHARC: {
    onReady(callback) {
      readyCallbacks.push(callback);
    },
    onStart(callback) {
      startCallbacks.push(callback);
    },
    on(eventName, callback) {
      eventListeners[eventName] = eventListeners[eventName] || [];
      eventListeners[eventName].push(callback);
    },
    hasFeature() {
      return true;
    },
    requestNavigation() {
      return Promise.resolve();
    },
    requestPlacementChange() {
      return Promise.resolve();
    },
    requestClose() {
      return Promise.resolve();
    },
  },
};

await import(`../../dist/sharc-safeframe-bridge.mjs?sequence=${Date.now()}`);

assert.equal(
  window.__sharcSafeFrameBridgeInstalled, true,
  'bridge auto-installs on existing SHARC API');
assert.equal(
  typeof window.$sf, 'object',
  'window.$sf exists after bridge install');
assert.equal(
  typeof window.$sf.ext, 'object',
  'window.$sf.ext is installed (the SafeFrame creative API surface)');
assert.equal(
  typeof window.$sf.ext.register, 'function',
  '$sf.ext.register is available before the creative runs');
assert.equal(
  readyCallbacks.length, 1,
  'bridge registers one SHARC.onReady callback (session-establish hook)');
assert.equal(
  eventListeners.stateChange && eventListeners.stateChange.length, 1,
  'bridge registers one SHARC stateChange listener (R1 state-delivery sink)');

// The creative registers its event callback. Before Container:init the bridge
// holds the callback but fires nothing (geom not meaningful yet).
const observed = { statuses: [], geomUpdates: [] };
window.$sf.ext.register(320, 50, function (status, data) {
  observed.statuses.push(status);
  if (status === 'geom-update') observed.geomUpdates.push(data);
});

assert.deepEqual(
  observed.statuses, [],
  'no callback before Container:init — geometry is not meaningful pre-session');

// Container:init — the wrapper-provisioned SDK established the SHARC session;
// the bridge caches env and builds an initial geom. No creative callback yet
// (first geom-update is gated on stateChange(active)).
readyCallbacks[0]({
  currentPlacement: {
    initialDefaultSize: { width: 320, height: 50 },
    viewportSize: { width: 375, height: 667 },
  },
  initialPosition: { x: 0, y: 0, width: 320, height: 50 },
  sfMeta: { shared: {}, owned: {} },
  publisherContext: { pageUrl: '', domain: '', bundleId: '', platform: '' },
});

assert.deepEqual(
  observed.statuses, [],
  'Container:init alone does not fire the creative callback (geom-update gated on active)');

// Container:active — R1's state push lands here. This is the late-subscriber
// case: the bridge subscribed in onReady, and the active state arriving via
// the unified container->creative push is delivered as a SafeFrame geom-update.
assert.equal(
  eventListeners.stateChange.length, 1, 'one stateChange sink to drive');
eventListeners.stateChange[0]('active');

assert.deepEqual(
  observed.statuses, ['geom-update'],
  'stateChange(active) maps to a SafeFrame geom-update callback');
assert.equal(
  observed.geomUpdates.length, 1,
  'exactly one geom-update delivered on active');

const geom = observed.geomUpdates[0];
assert.equal(typeof geom, 'object', 'geom-update carries a geom object');
assert.equal(geom.self.w, 320, 'geom self width reflects placement size');
assert.equal(geom.self.h, 50, 'geom self height reflects placement size');

// Slice D (Δ7): in-view rides the effective-visibility surface, not the
// lifecycle enum — establish alone reads iv 0 until the composer delivers a
// value; the driven EV 100 is what makes the creative fully in-view.
assert.equal(geom.self.iv, 0, 'establish alone sets no in-view value (enum is not viewability)');
assert.equal(
  eventListeners.effectiveVisibilityChange && eventListeners.effectiveVisibilityChange.length, 1,
  'bridge registers one effectiveVisibilityChange listener (Slice D in-view sink)');
eventListeners.effectiveVisibilityChange[0]({ effectivePercent: 100, reason: null, visibleRectangle: null });
assert.equal(
  observed.geomUpdates.length, 2,
  'the EV delivery fires a geom-update (in-view value changed)');
assert.equal(
  observed.geomUpdates[1].self.iv, 1,
  'creative is fully in-view at the composed EV 100');

console.log('✓ SafeFrame readiness adapter sequence verified (#339).');
