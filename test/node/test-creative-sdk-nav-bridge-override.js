/**
 * test-creative-sdk-nav-bridge-override.js — #365 nav-bridge override clobber
 *
 * Defect (#365, pre-existing, surfaced during #327): the rollup IIFE build
 * epilogue for `dist/sharc-creative.js` emits
 *
 *     exports.installNavigationBridge = installNavigationBridge;
 *
 * where `exports` IS `window.SHARC` (the bundle trailer is
 * `})(this.SHARC = this.SHARC || {})`). This generated line runs AFTER the
 * in-source first-assignment-wins guard
 *
 *     if (typeof window.SHARC.installNavigationBridge !== 'function') {
 *       window.SHARC.installNavigationBridge = installNavigationBridge;
 *     }
 *
 * and UNCONDITIONALLY overwrites an operator's pre-set
 * `window.SHARC.installNavigationBridge` override (the documented extension
 * point — wrap install with telemetry / a feature flag / custom logging).
 * The operator's override is silently replaced by the bundled default on SDK
 * load. This is a single-SDK-load correctness gap, independent of #327's
 * double-eval path.
 *
 * This file runs the SHIPPED IIFE bundle (`dist/sharc-creative.js`) against a
 * window, twice over (models `test-creative-sdk-singleton.js`):
 *   (a) OPERATOR OVERRIDE SURVIVES: an operator pre-sets
 *       `window.SHARC.installNavigationBridge` BEFORE the bundle evaluates;
 *       after load it must STILL be the operator's exact function (===), not
 *       the bundled default. (RED before the fix — the epilogue clobbers it.)
 *   (b) FRESH DEFAULT INSTALLS: no pre-set override; after a clean load
 *       `window.SHARC.installNavigationBridge` is a function (the bundled
 *       default), so the fix does not break the default install path.
 *
 * Runs in Node after `npm run build`.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODE = process.env.SHARC_NAV_OVERRIDE_MODE;

// ===========================================================================
// Parent: spawn one child per scenario (fresh global.window each), aggregate.
// ===========================================================================
if (!MODE) {
  console.log('Running creative SDK nav-bridge override (#365) tests...\n');
  const __filename = fileURLToPath(import.meta.url);
  let failed = 0;
  for (const mode of ['a', 'b']) {
    console.log(`──── scenario (${mode}) ────`);
    const r = spawnSync(
      process.execPath,
      [__filename],
      {
        env: { ...process.env, SHARC_NAV_OVERRIDE_MODE: mode },
        stdio: 'inherit',
        cwd: path.dirname(__filename),
      },
    );
    if (r.status !== 0) {
      failed++;
      console.error(`✗ scenario (${mode}) failed (exit ${r.status}).`);
    } else {
      console.log(`✓ scenario (${mode}) passed.`);
    }
    console.log('');
  }
  if (failed > 0) {
    console.error(`✗ ${failed} nav-bridge override scenario(s) failed.`);
    process.exit(1);
  }
  console.log('✓ All #365 nav-bridge override scenarios passed.');
  process.exit(0);
}

// ===========================================================================
// Child: one scenario.
// ===========================================================================

const { JSDOM } = await import('jsdom');
const fs = await import('node:fs');

const PUBLISHER_ORIGIN = 'https://publisher.example';

const dom = new JSDOM(
  '<!DOCTYPE html><html><body><div id="ad">ad</div></body></html>',
  { url: PUBLISHER_ORIGIN + '/creative.html', pretendToBeVisual: true },
);
const win = dom.window;

global.window = win;
global.document = win.document;
global.HTMLElement = win.HTMLElement;
global.HTMLIFrameElement = win.HTMLIFrameElement;
global.MessageChannel = globalThis.MessageChannel;
global.MessagePort = globalThis.MessagePort;
global.MessageEvent = win.MessageEvent;
win.MessageChannel = globalThis.MessageChannel;
win.MessagePort = globalThis.MessagePort;
global.setTimeout = win.setTimeout ? win.setTimeout.bind(win) : setTimeout;
global.clearTimeout = win.clearTimeout ? win.clearTimeout.bind(win) : clearTimeout;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}
if (typeof win.crypto === 'undefined' || typeof win.crypto.randomUUID !== 'function') {
  try { win.crypto = globalThis.crypto; } catch { /* jsdom exposes crypto as a getter-only prop; ignore */ }
}

const IIFE_SRC = fs.readFileSync(
  new URL('../../dist/sharc-creative.js', import.meta.url),
  'utf8',
);

// Execute the IIFE bundle against the shared window, modelling a classic
// <script src> tag. `this` at the top of the bundle is the window (the trailer
// is `})(this.SHARC = this.SHARC || {})`).
function runIIFE() {
  // eslint-disable-next-line no-new-func
  const fn = new Function(IIFE_SRC);
  fn.call(win);
}

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

if (MODE === 'a') {
  // -- (a) OPERATOR OVERRIDE SURVIVES — the #365 headline. ----------------
  // Operator pre-binds a custom installNavigationBridge (the documented
  // extension point) BEFORE any SHARC module loads.
  const operatorSentinel = function operatorInstall() { /* operator override */ };
  win.SHARC = win.SHARC || {};
  win.SHARC.installNavigationBridge = operatorSentinel;

  runIIFE();

  check(typeof win.SHARC.installNavigationBridge === 'function',
    '(a) nav-bridge install surface is a function after load');
  check(win.SHARC.installNavigationBridge === operatorSentinel,
    '(a) operator pre-set installNavigationBridge SURVIVES SDK load '
    + '(first-assignment-wins honored — NOT clobbered by the bundled default)');
} else if (MODE === 'b') {
  // -- (b) FRESH DEFAULT INSTALLS — fix must not break the default path. --
  // No operator pre-set: a clean load must install the bundled default.
  check(!win.SHARC || typeof win.SHARC.installNavigationBridge !== 'function',
    '(b) precondition: no installNavigationBridge bound before load');

  runIIFE();

  check(win.SHARC && typeof win.SHARC.installNavigationBridge === 'function',
    '(b) fresh load installs the bundled default installNavigationBridge');
} else {
  console.error(`✗ unknown SHARC_NAV_OVERRIDE_MODE: ${MODE}`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} (${MODE}) assertion(s) failed.`);
  process.exit(1);
}
process.exit(0);
