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
 * Three scenarios, each in its own child process (module caching prevents
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
 *  3. Spoofed renderer marker — `window.__sharcRenderer` before SDK import
 *     skips auto-install, but the SDK emits a warning if the navigation
 *     bridge was not actually installed by the renderer first (#72).
 *
 * Runs in Node after `npm run build` (dev mode, console-call preserving).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// =========================================================================
// Mode dispatch — a single file that runs as both the parent harness and
// as the child worker for each scenario. The parent spawns one child per
// `SHARC_AUTOINSTALL_MODE`; the child runs the assertions
// for its mode and exits with code 0 (pass) or 1 (fail).
// =========================================================================

const MODE = process.env.SHARC_AUTOINSTALL_MODE;

if (!MODE) {
  // -- Parent: spawn one child per scenario, aggregate results. ---------
  console.log('Running creative SDK auto-install tests...\n');

  const __filename = fileURLToPath(import.meta.url);
  let failed = 0;

  for (const mode of ['url', 'markup', 'spoof']) {
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
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const fs = await import('node:fs');
const distSrc = fs.readFileSync(
  new URL('../../dist/sharc-creative.mjs', import.meta.url),
  'utf8',
);
const HAS_DEV_CONSOLE_CALLS = /console\.warn\(/.test(distSrc) || /console\.error\(/.test(distSrc);

// Scenario-specific setup — must happen BEFORE the SDK import.
if (MODE === 'markup') {
  // Pre-set the renderer marker the way `examples/renderer/index.html`
  // does (a module-eval-time global before the creative HTML is written
  // into the renderer document). The SDK's auto-install gate reads this.
  window.__sharcRenderer = {
    installNavigationBridge() {},
    customSecurityLog() {},
  };
  window.__sharcNavBridgeInstalled = true;
} else if (MODE === 'spoof') {
  // Issue #72: a Creative URL document can predefine a minimal marker to
  // suppress SDK bridge auto-install. The SDK cannot safely override the
  // marker, but it should make the suppression visible.
  window.__sharcRenderer = {
    installNavigationBridge() {},
  };
}

const warnOutput = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  warnOutput.push(args.join(' '));
  originalWarn(...args);
};

// Now import the SDK. This evaluation triggers the auto-install path.
try {
  await import('../../dist/sharc-creative.mjs');
} finally {
  console.warn = originalWarn;
}

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
function checkDevConsole(condition, message) {
  if (!HAS_DEV_CONSOLE_CALLS) {
    console.log('  ✓', `${message} (dev-console assertion skipped in prod bundle)`);
    return;
  }
  check(condition, message);
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
  // -- Creative Markup flow: renderer owns bridge install. -------------
  // The renderer runs `installNavigationBridge(window)` before
  // `document.write(creativeHtml)` in the real flow. This harness seeds
  // that installed flag and verifies the SDK does not warn about a
  // legitimate renderer-managed install.
  check(typeof window.SHARC === 'object' && window.SHARC !== null,
    'Markup: window.SHARC namespace is present after SDK import');
  check(typeof window.SHARC.installNavigationBridge === 'function',
    'Markup: window.SHARC.installNavigationBridge is exposed (function) — namespace assignment is independent of the auto-install gate');
  check(window.__sharcNavBridgeInstalled === true,
    'Markup: renderer-installed navigation bridge flag remains present');
  check(window.__sharcRenderer != null,
    'Markup: __sharcRenderer marker remained in place (sanity — pre-import setup intact)');
  check(warnOutput.length === 0,
    'Markup: renderer-installed navigation bridge does NOT warn');
} else if (MODE === 'spoof') {
  // -- Spoofed marker: SDK skips install but warns loudly. -------------
  check(typeof window.SHARC === 'object' && window.SHARC !== null,
    'Spoof: window.SHARC namespace is present after SDK import');
  check(typeof window.SHARC.installNavigationBridge === 'function',
    'Spoof: window.SHARC.installNavigationBridge is still exposed');
  check(window.__sharcNavBridgeInstalled !== true,
    'Spoof: SDK did NOT auto-install the bridge (__sharcRenderer marker present)');
  checkDevConsole(warnOutput.some((s) => /__sharcRenderer marker is present/.test(s)
      && /navigation bridge is not installed/.test(s)
      && /target="_blank"/.test(s)
      && /navigation audit/.test(s)),
    'Spoof: SDK warns that marker suppressed navigation bridge auto-install even when marker is renderer-shaped (#72)');
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
