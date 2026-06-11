/**
 * test-iife-global-first-assignment-wins.js — IIFE global-export clobber
 *
 * Structural defect (Codex cross-lane finding; root cause #367 only point-fixed
 * `installNavigationBridge`): the rollup IIFE epilogue for `dist/sharc-creative.js`
 * emits one UNCONDITIONAL global-export assignment per named export
 *
 *     exports.SHARCNavigationError = SHARCNavigationError;
 *
 * where `exports` IS `window.SHARC` (the bundle trailer is
 * `})(this.SHARC = this.SHARC || {})`). Every such line runs AFTER the module
 * body and overwrites a `window.SHARC.X` an operator pre-set BEFORE the bundle
 * loaded — bypassing the source-level first-assignment-wins guards. #367 fixed
 * ONE symbol (`installNavigationBridge`) by dropping it from the named exports,
 * but that does not generalize: `SHARCNavigationError` is a real ESM export
 * consumers `import { SHARCNavigationError }`, so it CANNOT be dropped, and the
 * same clobber structurally affects EVERY named export.
 *
 * The structural fix (rollup.config.js `firstAssignmentWinsGlobalExports`)
 * rewrites the IIFE epilogue from
 *     exports.X = X;
 * into first-assignment-wins form
 *     if (!('X' in exports)) exports.X = X;
 * so the bundle installs its default ONLY when the property is absent. The ESM
 * (`format: 'es'`) `export { ... }` surface is untouched.
 *
 * This file runs the SHIPPED IIFE bundle (`dist/sharc-creative.js`) via
 * `new Function(src).call(window)` — modelling a classic <script src> tag —
 * across two scenarios (each in its own child process, fresh `global.window`):
 *
 *   (a) OPERATOR PRE-SETS SURVIVE — the headline. An operator pre-sets
 *       `window.SHARC = { SHARCNavigationError, installNavigationBridge,
 *       someCustomProp }` BEFORE the bundle evaluates; after load ALL three
 *       must be the operator's EXACT values (===). RED before the fix
 *       (`SHARCNavigationError` clobbered by the unconditional epilogue).
 *
 *   (b) FRESH DEFAULTS INSTALL — the fix must not break the default path. With
 *       an empty `window.SHARC`, a clean load must still expose the bundle's
 *       real `SHARCCreative` / `SHARCNavigationError` / `creative`.
 *
 * Models `test-creative-sdk-nav-bridge-override.js` + `test-creative-sdk-singleton.js`.
 * Runs in Node after `npm run build`.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODE = process.env.SHARC_FAW_MODE;

// ===========================================================================
// Parent: spawn one child per scenario (fresh global.window each), aggregate.
// ===========================================================================
if (!MODE) {
  console.log('Running IIFE global first-assignment-wins tests...\n');
  const __filename = fileURLToPath(import.meta.url);
  let failed = 0;
  for (const mode of ['a', 'b']) {
    console.log(`──── scenario (${mode}) ────`);
    const r = spawnSync(
      process.execPath,
      [__filename],
      {
        env: { ...process.env, SHARC_FAW_MODE: mode },
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
    console.error(`✗ ${failed} first-assignment-wins scenario(s) failed.`);
    process.exit(1);
  }
  console.log('✓ All IIFE global first-assignment-wins scenarios passed.');
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

// Wire the browser globals the IIFE bundle references as bare identifiers
// through Node's `global` (mirrors the other node tests' setup so the bundle
// evaluates exactly as a classic <script> would).
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
// is `})(this.SHARC = this.SHARC || {})`), so `exports` IS `window.SHARC`.
function runIIFE() {
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
  // -- (a) OPERATOR PRE-SETS SURVIVE — the headline. ----------------------
  // An operator stamps window.SHARC with their own values BEFORE any SHARC
  // module loads: a sentinel error class (collides with the bundle's
  // SHARCNavigationError named export), a custom install wrapper (collides
  // with installNavigationBridge), and a bespoke property that the bundle
  // never names. Every one must SURVIVE the bundle eval (first-assignment-wins).
  const operatorSentinelError = class OperatorNavError extends Error {};
  const operatorInstall = function operatorInstall() { /* operator override */ };
  const operatorCustom = { tag: 'operator-custom-prop' };

  win.SHARC = win.SHARC || {};
  win.SHARC.SHARCNavigationError = operatorSentinelError;
  win.SHARC.installNavigationBridge = operatorInstall;
  win.SHARC.someCustomProp = operatorCustom;

  runIIFE();

  check(win.SHARC.SHARCNavigationError === operatorSentinelError,
    '(a) operator pre-set window.SHARC.SHARCNavigationError SURVIVES bundle load '
    + '(NOT clobbered by the unconditional IIFE export epilogue) — the headline');
  check(win.SHARC.installNavigationBridge === operatorInstall,
    '(a) operator pre-set window.SHARC.installNavigationBridge SURVIVES (#367 + structural)');
  check(win.SHARC.someCustomProp === operatorCustom,
    '(a) operator pre-set window.SHARC.someCustomProp (bundle never names it) SURVIVES');
} else if (MODE === 'b') {
  // -- (b) FRESH DEFAULTS INSTALL — the fix must not break the default path.
  // Empty window.SHARC: a clean load must expose the bundle's real public
  // symbols. (`creative` is the genuine first-booted instance on the boot eval;
  // the `creative` named export is non-null here because this is that eval.)
  check(!win.SHARC || !('SHARCNavigationError' in win.SHARC),
    '(b) precondition: no SHARCNavigationError on window.SHARC before load');

  runIIFE();

  check(win.SHARC && typeof win.SHARC.SHARCCreative === 'function',
    '(b) fresh load exposes the bundled SHARCCreative class');
  check(win.SHARC && typeof win.SHARC.SHARCNavigationError === 'function',
    '(b) fresh load exposes the bundled SHARCNavigationError class');
  check(win.SHARC && typeof win.SHARC.installNavigationBridge === 'function',
    '(b) fresh load exposes the bundled installNavigationBridge — the restored '
    + 'named export (#370) installs as the default when none is pre-set, while '
    + 'scenario (a) proves an operator pre-set still survives (#369 guard)');
  check(win.SHARC && ('creative' in win.SHARC),
    '(b) fresh load exposes the `creative` namespace property');
  check(win.SHARC && win.SHARC.creative
    && typeof win.SHARC.creative === 'object',
    '(b) `creative` is the genuine first-booted instance on the boot eval (non-null)');
} else {
  console.error(`✗ unknown SHARC_FAW_MODE: ${MODE}`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} (${MODE}) assertion(s) failed.`);
  process.exit(1);
}
process.exit(0);
