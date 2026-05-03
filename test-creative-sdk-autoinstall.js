/**
 * test-creative-sdk-autoinstall.js — Phase E round-1 OpenClaw LOW-2
 *
 * Runtime regression coverage for the SDK's navigation-bridge auto-install
 * behavior at module-evaluation time. Pairs with `test-smoke.js` (which
 * verifies the EXPORTS are reachable on the SDK bundle) and section 18 of
 * `test-creative-sources-load.js` (which verifies the CONTAINER-side
 * load-event backstop) — this file fills the seam between them by proving
 * the SDK actually triggers `installNavigationBridge(window)` at boot in
 * the Creative URL variant and skips it in the Creative Markup variant.
 *
 * Without this coverage, a future tree-shake / sideEffects regression
 * could silently strip the auto-install path while leaving the exports
 * present — bridge would still appear "available" in test-smoke but would
 * never fire on real Creative URL traffic.
 *
 * Two scenarios, each in its own child process (module caching prevents
 * re-importing the SDK with a different `__sharcRenderer` state in a
 * single process):
 *
 *  1. Creative URL flow — `__sharcRenderer` absent → SDK auto-installs
 *     the bridge → `window.__sharcNavBridgeInstalled === true` AND
 *     `window.SHARC.installNavigationBridge` is a function.
 *
 *  2. Creative Markup flow — `__sharcRenderer` pre-set → SDK detects the
 *     renderer marker and SKIPS its own auto-install (the renderer is
 *     responsible for installing the bridge in that variant). The
 *     `installNavigationBridge` export is still reachable on
 *     `window.SHARC` (the namespace assignment is independent of the
 *     auto-install gate), but the install side-effect is absent.
 *
 * Runs in Node after `npm run build` (dev mode, console-call preserving).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// =========================================================================
// Mode dispatch — a single file that runs as both the parent harness and
// as the child worker for each scenario. The parent spawns two children
// with `SHARC_AUTOINSTALL_MODE=url|markup`; the child runs the assertions
// for its mode and exits with code 0 (pass) or 1 (fail).
// =========================================================================

const MODE = process.env.SHARC_AUTOINSTALL_MODE;

if (!MODE) {
  // -- Parent: spawn one child per scenario, aggregate results. ---------
  console.log('Running creative SDK auto-install tests...\n');

  const __filename = fileURLToPath(import.meta.url);
  let failed = 0;

  for (const mode of ['url', 'markup']) {
    console.log(`──── scenario: ${mode} ────`);
    const r = spawnSync(
      process.execPath,
      [__filename],
      {
        env: { ...process.env, SHARC_AUTOINSTALL_MODE: mode },
        stdio: 'inherit',
        cwd: path.dirname(__filename),
      },
    );
    if (r.status !== 0) {
      failed++;
      console.error(`✗ scenario ${mode} failed (exit ${r.status}).`);
    } else {
      console.log(`✓ scenario ${mode} passed.`);
    }
    console.log('');
  }

  if (failed > 0) {
    console.error(`✗ ${failed} auto-install scenario(s) failed.`);
    process.exit(1);
  }
  console.log('✓ All creative SDK auto-install scenarios passed.');
  process.exit(0);
}

// =========================================================================
// Child: run one scenario.
// =========================================================================

const { JSDOM } = await import('jsdom');
const assert = (await import('node:assert/strict')).default;

const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html' },
);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

// Pre-load the protocol so `window.SHARC.requestNavigation` is available
// when the bridge's auto-install gate consults it. Mirrors the renderer
// page's load order and the existing test-creative-sources-load.js setup.
const protoMod = await import('./dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

// Build-mode FATAL guard — same pattern as test-creative-sources-load.js
// and test-navigation-bridge.js. Prod builds with `drop_console: true`
// would silently void any console-related assertions in this harness; the
// bridge install path itself is unaffected, but we keep the guard for
// consistency with sibling tests so a wrong-mode run fails loudly.
{
  const fs = await import('node:fs');
  const distSrc = fs.readFileSync('./dist/sharc-creative.mjs', 'utf8');
  if (!/console\.error/.test(distSrc)) {
    console.error(
      'FATAL: dist/sharc-creative.mjs has zero console.error calls — '
      + 'this is a production build (terser drop_console=true). Re-run '
      + '`npm run build` (dev mode) and try again.'
    );
    process.exit(1);
  }
}

// Scenario-specific setup — must happen BEFORE the SDK import.
if (MODE === 'markup') {
  // Pre-set the renderer marker the way `examples/renderer/index.html`
  // does (a module-eval-time global before the creative HTML is written
  // into the renderer document). The SDK's auto-install gate reads this.
  window.__sharcRenderer = {
    /* opaque sentinel — the SDK only checks for its presence */
  };
}

// Now import the SDK. This evaluation triggers the auto-install path.
await import('./dist/sharc-creative.mjs');

// Allow any synchronous SDK boot work to settle (the auto-install itself
// is synchronous, but defensive — `_boot()` is invoked in the same tick).
await new Promise((r) => setTimeout(r, 5));

// =========================================================================
// Assertions
// =========================================================================

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

if (MODE === 'url') {
  // -- Creative URL flow: SDK installs the bridge synchronously. -------
  check(typeof window.SHARC === 'object' && window.SHARC !== null,
    'URL: window.SHARC namespace is present after SDK import');
  check(typeof window.SHARC.installNavigationBridge === 'function',
    'URL: window.SHARC.installNavigationBridge is exposed (function)');
  check(window.__sharcNavBridgeInstalled === true,
    'URL: SDK auto-installed the navigation bridge (__sharcNavBridgeInstalled === true)');
  check(typeof window.SHARC.requestNavigation === 'function',
    'URL: window.SHARC.requestNavigation is reachable post-install');
  // The bridge sets `window.SHARCNavigationError` independently of the
  // install gate. Verify the class is reachable for `instanceof` checks
  // by non-module creatives that catch the SDK-missing throw.
  check(typeof window.SHARCNavigationError === 'function',
    'URL: window.SHARCNavigationError is exposed (class)');
} else if (MODE === 'markup') {
  // -- Creative Markup flow: SDK skips its own auto-install. -----------
  // The renderer would have run its own `installNavigationBridge(window)`
  // BEFORE `document.write(creativeHtml)` in the real flow. In this
  // jsdom harness we only verify the SDK's gate fires correctly — i.e.
  // the SDK-side install side-effect is absent because `__sharcRenderer`
  // is set. The renderer's own install path is exercised by
  // `test-navigation-bridge.js`.
  check(typeof window.SHARC === 'object' && window.SHARC !== null,
    'Markup: window.SHARC namespace is present after SDK import');
  check(typeof window.SHARC.installNavigationBridge === 'function',
    'Markup: window.SHARC.installNavigationBridge is exposed (function) — namespace assignment is independent of the auto-install gate');
  check(window.__sharcNavBridgeInstalled !== true,
    'Markup: SDK did NOT auto-install the bridge (__sharcRenderer marker present → install gate closed; renderer is responsible for the install in this variant)');
  check(window.__sharcRenderer != null,
    'Markup: __sharcRenderer marker remained in place (sanity — pre-import setup intact)');
} else {
  console.error(`✗ unknown SHARC_AUTOINSTALL_MODE: ${MODE}`);
  process.exit(1);
}

// =========================================================================
// Summary
// =========================================================================
if (failures > 0) {
  console.error(`✗ ${failures} ${MODE}-mode assertion(s) failed.`);
  process.exit(1);
}
process.exit(0);
