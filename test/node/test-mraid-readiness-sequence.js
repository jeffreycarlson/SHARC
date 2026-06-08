/**
 * test-mraid-readiness-sequence.js — #321 MRAID wrapper adapter sequence.
 *
 * Node covers the adapter half of Decision 3: once the renderer-provisioned
 * wrapper has installed sharc-mraid-bridge on top of window.SHARC, the shipped
 * bridge maps Container:init to MRAID ready/default and Container:active to
 * isViewable()/viewableChange(true). Real renderer provisioning is covered by
 * the creative-validator runner, where the raw creative ships no SHARC SDK.
 */

import assert from 'node:assert/strict';

const readyCallbacks = [];
const startCallbacks = [];
const eventListeners = {};

globalThis.location = { protocol: 'http:', hostname: 'localhost' };
globalThis.window = {
  __sharcMraidBridgeAutoInstall: true,
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

await import(`../../dist/sharc-mraid-bridge.mjs?sequence=${Date.now()}`);

assert.equal(window.__sharcMraidBridgeInstalled, true, 'bridge auto-installs on existing SHARC API');
assert.equal(typeof window.mraid, 'object', 'window.mraid exists after bridge install');
assert.equal(window.mraid.getState(), 'loading', 'MRAID starts loading before Container:init');
assert.equal(window.mraid.isViewable(), false, 'MRAID starts non-viewable before active');
assert.equal(readyCallbacks.length, 1, 'bridge registers one SHARC.onReady callback');
assert.equal(startCallbacks.length, 1, 'bridge registers one SHARC.onStart callback');

const observed = {
  ready: 0,
  stateChanges: [],
  viewableChanges: [],
};
window.mraid.addEventListener('ready', () => {
  observed.ready++;
});
window.mraid.addEventListener('stateChange', (state) => {
  observed.stateChanges.push(state);
});
window.mraid.addEventListener('viewableChange', (isViewable) => {
  observed.viewableChanges.push(isViewable);
});

readyCallbacks[0]({
  currentPlacement: {
    initialDefaultSize: { width: 320, height: 50 },
  },
  initialPosition: { x: 0, y: 0, width: 320, height: 50 },
  data: {
    placement: { instl: 0 },
    app: { bundle: 'test-app' },
  },
});

assert.equal(observed.ready, 1, 'Container:init fires MRAID ready');
assert.deepEqual(observed.stateChanges, ['default'], 'Container:init maps to MRAID default');
assert.equal(window.mraid.getState(), 'default', 'MRAID getState is default after init');
assert.equal(window.mraid.isViewable(), false, 'MRAID remains non-viewable until active');

assert.equal(eventListeners.stateChange.length, 1, 'bridge registers SHARC stateChange listener');
eventListeners.stateChange[0]('active');

// #343: active and passive both map to MRAID 'default', so SHARC 'active'
// after the 'default' seed must NOT re-emit stateChange('default') — the MRAID
// state is unchanged, and stateChange fires only on an actual MRAID-state
// change. getState() and viewability still update (asserted below).
assert.deepEqual(observed.stateChanges, ['default'], 'active does not re-emit unchanged MRAID state (default)');
assert.deepEqual(observed.viewableChanges, [true], 'active fires viewableChange(true)');
assert.equal(window.mraid.getState(), 'default', 'MRAID getState stays default at active');
assert.equal(window.mraid.isViewable(), true, 'MRAID is viewable at active');

console.log('✓ MRAID readiness adapter sequence verified.');
