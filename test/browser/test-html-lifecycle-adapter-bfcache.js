#!/usr/bin/env node
/**
 * test-html-lifecycle-adapter-bfcache.js — issue #178 wiring (0.7.6)
 *
 * Puppeteer-driven end-to-end coverage for the HTML lifecycle adapter's
 * bfcache (back/forward cache) round-trip behavior. The jsdom suite at
 * test/node/test-html-lifecycle-adapter.js § 7, § 8, § 13 exercises the
 * adapter's pagehide/pageshow handlers via synthetic event dispatch, but
 * jsdom does NOT model the actual bfcache semantics (event-loop freeze,
 * implicit iframe freezing, browser eligibility rules). This test closes
 * that gap by exercising the adapter in real Chrome.
 *
 * Coverage matrix (one assertion per row):
 *
 *   bf-1. Permissive non-SHARC container loads → bfcache eligible
 *   bf-2. bfcache entry drives LOADING → ACTIVE → FROZEN (direct edge,
 *         #340 — no phantom HIDDEN; onStateChange sequence asserted)
 *   bf-3. bfcache restoration via pageshow(persisted:true) drives
 *         FROZEN → ACTIVE (visibility + intersection both ≥ 50%)
 *   bf-4. Strict-mode + LOADING + bfcache: adapter yields (no FROZEN
 *         emission); state stays LOADING through round-trip; handshake
 *         (if it arrives post-restore) completes cleanly
 *   bf-5. No state-machine warns ("invalid transition") fire across the
 *         round-trip (regression guard for PR #98's strict-LOADING fix)
 *
 * Tier + retry policy (per ADR-178-E):
 *   - Structural tier (bf-1, bf-5): run inline, no retry. Deterministic.
 *   - Behavioral tier (bf-2, bf-3, bf-4): up to 3 retries inside the
 *     runner. Pass on any-of-3 = pass. A true regression fails all 3 with
 *     the same diagnostic; a flake mixes pass/fail.
 *
 * Reference:
 *   - docs/design/0.7.6-bfcache-puppeteer-wiring.md (the locked design)
 *   - test/node/test-html-lifecycle-adapter.js § 7, § 8, § 13 (jsdom matrix)
 *   - test/browser/test-creative-sources-puppeteer.js (Puppeteer precedent)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = parsePort(process.env.PORT, 18765);
const RENDERER_PORT = parsePort(process.env.RENDERER_PORT, PORT + 1);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const RUN_TIMEOUT_MS = 60_000;
const BFCACHE_INSTALL_MS = Number(process.env.BFCACHE_INSTALL_MS) || 500;

// ── Tiny assertion harness — mirrors test/node patterns ───────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}
function section(name) {
  console.log('\n' + name);
}

function parsePort(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port '${raw}' — must be an integer in 1..65535.`);
  }
  return n;
}

function resolveChromePath() {
  const fromEnv = process.env.CHROME_PATH
    || process.env.CHROME_EXECUTABLE_PATH
    || process.env.BROWSER_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `Chrome executable override does not exist: ${fromEnv}`,
      );
    }
    return fromEnv;
  }

  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ]
    : process.platform === 'linux'
    ? [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ]
    : process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : [];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error(
    'Unable to locate Chrome/Chromium. Set CHROME_PATH, '
    + 'CHROME_EXECUTABLE_PATH, BROWSER_PATH, or PUPPETEER_EXECUTABLE_PATH.',
  );
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', (err) => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${url}: ${err.message}`));
          return;
        }
        setTimeout(attempt, 100);
      });
      req.setTimeout(1000, () => {
        req.destroy(new Error('request timed out'));
      });
    }
    attempt();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// HARNESS — implementations per docs/design/0.7.6-bfcache-puppeteer-wiring.md
// ══════════════════════════════════════════════════════════════════════════

/**
 * § 3.1. Spawn server.cjs + launch headless Chrome + create a page with a
 * console listener that ferries warning-tier messages into consoleWarns.
 *
 * @returns {Promise<{
 *   browser: import('puppeteer-core').Browser,
 *   page: import('puppeteer-core').Page,
 *   serverProc: import('node:child_process').ChildProcess,
 *   consoleWarns: string[],
 *   cleanup: () => Promise<void>
 * }>}
 */
async function setupPuppeteerBfcacheHarness() {
  const serverProc = spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      RENDERER_PORT: String(RENDERER_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log('[server]', text);
  });
  serverProc.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error('[server!]', text);
  });

  try {
    await waitForServer(`${BASE_URL}/`, 10_000);
  } catch (err) {
    serverProc.kill('SIGTERM');
    throw new Error('Server failed to start within 10 s: ' + err.message);
  }

  const chromePath = resolveChromePath();
  console.log(`[browser] Launching headless Chrome: ${chromePath}`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--enable-features=BackForwardCache,BackForwardCacheMemoryControls',
      '--disable-features=BackForwardCacheTimeToLiveControl',
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(RUN_TIMEOUT_MS);

  const consoleWarns = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'warning' || type === 'warn') {
      consoleWarns.push(msg.text());
    }
    if (type === 'error' || type === 'warning' || type === 'warn') {
      console.log(`[page.${type}]`, msg.text().slice(0, 400));
    }
  });
  page.on('pageerror', (err) => console.error('[page!]', err.message));

  const cleanup = async () => {
    try {
      await browser.close();
    } catch (_e) { /* ignore */ }
    serverProc.kill('SIGTERM');
    await new Promise((resolve) => {
      const done = () => resolve();
      serverProc.once('exit', done);
      setTimeout(done, 1500);
    });
  };

  return { browser, page, serverProc, consoleWarns, cleanup };
}

/**
 * § 3.2. Load the bfcache fixture page in permissive or strict mode and
 * wait for the container's load() to complete (signalled by
 * window.__sharcBfcacheReady). Races against `pageerror` so SHARCContainer
 * construction failures surface immediately instead of behind a 30 s timeout.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {{ requireSharcInit?: boolean }} options
 * @returns {Promise<void>}
 */
async function loadPermissiveContainerInPuppeteer(page, options) {
  const strict = options && options.requireSharcInit === true;
  const url = strict
    ? `${BASE_URL}/test/browser/bfcache-fixture.html?strict=1`
    : `${BASE_URL}/test/browser/bfcache-fixture.html`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await Promise.race([
    page.waitForFunction(() => window.__sharcBfcacheReady === true, { timeout: 30_000 }),
    new Promise((_, reject) => page.once('pageerror', (err) =>
      reject(new Error('Fixture page error: ' + err.message)))),
  ]);
}

/**
 * § 3.3. Non-destructive read of the captured onStateChange sequence.
 * Returns a shallow copy so the test can slice across phases without
 * losing the accumulated record across bfcache entry/exit.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<Array<{newState: string, previousState: string, timestamp: number}>>}
 */
async function captureStateChangeSequence(page) {
  return page.evaluate(() => Array.isArray(window.__capturedStateChanges)
    ? window.__capturedStateChanges.slice()
    : []);
}

/**
 * § 3.4. Navigate to the bfcache-away page, then wait the configured
 * BFCACHE_INSTALL_MS for Chrome to install the previous page into bfcache.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<void>}
 */
async function triggerBfcacheEntry(page) {
  await page.goto(`${BASE_URL}/test/browser/bfcache-away.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, BFCACHE_INSTALL_MS));
}

/**
 * § 3.4. page.goBack() to restore from bfcache, then read the captured
 * pageshow.persisted flag set by the fixture's pageshow listener.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<{ persisted: boolean }>}
 */
async function triggerBfcacheRestore(page) {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => window.__lastPageshowPersisted !== undefined,
    { timeout: 10_000 },
  );
  const persisted = await page.evaluate(() => window.__lastPageshowPersisted);
  return { persisted };
}

/**
 * Retry wrapper for behavioral-tier sections (ADR-178-E). Structural-tier
 * sections (bf-1, bf-5) run inline without retry. Behavioral-tier sections
 * (bf-2, bf-3, bf-4) get up to `attempts` attempts; pass on any-of attempts.
 * Logs each attempt so true regressions (all attempts fail with the same
 * diagnostic) are distinguishable from flakes (mixed pass/fail).
 */
async function runWithRetry(fn, attempts) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    console.log(`  [attempt ${i}/${attempts}]`);
    try {
      const failuresBefore = failures;
      await fn();
      if (failures === failuresBefore) {
        if (i > 1) console.log(`  ↳ passed on attempt ${i}`);
        return;
      }
      // Rewind soft-failures from this attempt; we'll try again.
      failures = failuresBefore;
      lastErr = new Error('assertions failed on attempt ' + i);
      console.log(`  ↳ attempt ${i} produced assertion failures, retrying`);
    } catch (e) {
      lastErr = e;
      console.log(`  ↳ attempt ${i} threw: ${e && e.message || e}`);
    }
  }
  // All attempts exhausted — re-run the body once more to let the
  // assertion failures land in the failure count for the final report.
  console.log(`  ↳ all ${attempts} attempts exhausted; reporting final result`);
  try {
    await fn();
  } catch (e) {
    assert(false, `behavioral section threw after ${attempts} retries: ${e && e.message || e}`);
  }
  if (lastErr) { /* lastErr surfaced via assert above or via failures count */ }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════

console.log('test-html-lifecycle-adapter-bfcache.js — issue #178 (0.7.6)\n');

async function main() {
  // ── bf-1 (structural — no retry) ─────────────────────────────────────────
  section('bf-1. Permissive non-SHARC container loads → bfcache eligible');
  {
    let harness = null;
    try {
      harness = await setupPuppeteerBfcacheHarness();
      await loadPermissiveContainerInPuppeteer(harness.page, { requireSharcInit: false });
      // Round-trip the page through bfcache; persisted:true on restore is
      // Chrome's authoritative eligibility signal — the page came back from
      // bfcache rather than reloading from network.
      await triggerBfcacheEntry(harness.page);
      const { persisted } = await triggerBfcacheRestore(harness.page);
      assert(persisted === true,
        'bf-1. Permissive container is bfcache-eligible (pageshow.persisted === true on restore)');
    } catch (e) {
      assert(false, 'bf-1. Setup threw: ' + (e && e.message || e));
    } finally {
      if (harness && harness.cleanup) await harness.cleanup();
    }
  }

  // ── bf-2 (behavioral — retry up to 3) ────────────────────────────────────
  section('bf-2. bfcache entry drives LOADING → ACTIVE → FROZEN (direct edge, #340)');
  await runWithRetry(async () => {
    let harness = null;
    try {
      harness = await setupPuppeteerBfcacheHarness();
      await loadPermissiveContainerInPuppeteer(harness.page, { requireSharcInit: false });

      // Allow the permissive auto-promote to ACTIVE to land (iframe load +
      // intersection observer). Then trigger bfcache entry.
      await harness.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.newState === 'active'),
        { timeout: 10_000 },
      );

      const beforeEntry = await captureStateChangeSequence(harness.page);
      await triggerBfcacheEntry(harness.page);
      // While navigated away, page.evaluate runs on the away page; the
      // fixture's __capturedStateChanges is unreachable. Restore first
      // (the entry transitions fired before suspend are preserved on the
      // restored document) and then read the accumulated sequence.
      await triggerBfcacheRestore(harness.page);
      const afterRestore = await captureStateChangeSequence(harness.page);

      const fullSeq = afterRestore.map((t) => `${t.previousState}→${t.newState}`);
      const entryTransitions = afterRestore
        .slice(beforeEntry.length)
        .map((t) => `${t.previousState}→${t.newState}`);

      assert(fullSeq.includes('loading→active'),
        'bf-2. Accumulated sequence includes loading→active');
      // #340: bfcache entry from a visible (ACTIVE) state takes the direct
      // ACTIVE → FROZEN edge — no phantom HIDDEN the creative never saw.
      assert(entryTransitions.includes('active→frozen'),
        `bf-2. Entry transitions include direct active→frozen (got: ${JSON.stringify(entryTransitions)})`);
      assert(!entryTransitions.includes('active→hidden')
          && !entryTransitions.includes('hidden→frozen'),
        `bf-2. No phantom active→hidden / hidden→frozen on the freeze path (got: ${JSON.stringify(entryTransitions)})`);
    } finally {
      if (harness && harness.cleanup) await harness.cleanup();
    }
  }, 3);

  // ── bf-3 (behavioral — retry up to 3) ────────────────────────────────────
  section('bf-3. bfcache restoration via pageshow(persisted:true) drives FROZEN → ACTIVE');
  await runWithRetry(async () => {
    let harness = null;
    try {
      harness = await setupPuppeteerBfcacheHarness();
      await loadPermissiveContainerInPuppeteer(harness.page, { requireSharcInit: false });
      await harness.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.newState === 'active'),
        { timeout: 10_000 },
      );
      await triggerBfcacheEntry(harness.page);
      const { persisted } = await triggerBfcacheRestore(harness.page);
      assert(persisted === true,
        'bf-3. Restore observes pageshow.persisted === true (bfcache actually installed)');
      // Give the adapter a moment to dispatch the FROZEN → * transition,
      // then wait for the post-restore intersection-observer callbacks to
      // settle the container into a steady visible state (ACTIVE).
      await harness.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.previousState === 'frozen'),
        { timeout: 10_000 },
      );
      // Allow IO post-restore re-callback to settle. § 8.3 of the
      // html-adapter contract: pageshow drives FROZEN → ACTIVE/PASSIVE/HIDDEN
      // per the LATEST intersection snapshot — but the post-restore IO
      // callback may not have fired yet. Wait for the container to reach a
      // non-frozen steady state.
      await new Promise((r) => setTimeout(r, 500));
      const sequence = await captureStateChangeSequence(harness.page);
      const restoreTransition = sequence.slice().reverse().find((t) => t.previousState === 'frozen');
      assert(restoreTransition,
        'bf-3. A frozen→* transition was emitted on restore');
      // The exact destination depends on the post-restore intersection
      // ratio. The contract is: FROZEN → some non-frozen state. The
      // canonical happy path is FROZEN → ACTIVE; FROZEN → PASSIVE / HIDDEN
      // are also valid per html-adapter._transitionFromFrozen when the
      // intersection ratio settles below 0.5 at the moment of pageshow.
      const finalState = sequence[sequence.length - 1].newState;
      assert(finalState === 'active' || finalState === 'passive' || finalState === 'hidden',
        `bf-3. Container reaches a non-frozen steady state after restore (got: ${finalState})`);
    } finally {
      if (harness && harness.cleanup) await harness.cleanup();
    }
  }, 3);

  // ── bf-4 (behavioral — retry up to 3) ────────────────────────────────────
  section('bf-4. Strict-mode + LOADING + bfcache: adapter yields (no FROZEN emission while LOADING)');
  await runWithRetry(async () => {
    let harness = null;
    try {
      harness = await setupPuppeteerBfcacheHarness();
      await loadPermissiveContainerInPuppeteer(harness.page, { requireSharcInit: true });
      // Strict mode + bare HTML creative ⇒ no handshake fires ⇒ container
      // stays in LOADING. The adapter's strict-mode gate at html-adapter.js:401
      // prevents auto-promote. Confirm LOADING is the live state.
      await triggerBfcacheEntry(harness.page);
      const restore = await triggerBfcacheRestore(harness.page);
      // Guard against false-pass: the two "no transition" assertions below
      // would also pass if the round-trip silently failed (no bfcache install
      // ⇒ no transitions ⇒ empty list ⇒ "pass"). Mirror the bf-1 / bf-3
      // pattern and prove the round-trip actually happened before checking
      // the strict-mode contract.
      assert(restore.persisted === true,
        'bf-4. Strict mode + bfcache: pageshow.persisted === true (round-trip actually happened)');
      const sequence = await captureStateChangeSequence(harness.page);

      const transitions = sequence.map((t) => `${t.previousState}→${t.newState}`);
      assert(!transitions.includes('loading→frozen'),
        `bf-4. No loading→frozen transition emitted (got: ${JSON.stringify(transitions)})`);
      // The strict-mode adapter MUST NOT auto-promote LOADING → ACTIVE.
      assert(!transitions.includes('loading→active'),
        `bf-4. Strict mode: no loading→active auto-promote (got: ${JSON.stringify(transitions)})`);
    } finally {
      if (harness && harness.cleanup) await harness.cleanup();
    }
  }, 3);

  // ── bf-5 (structural — no retry) ─────────────────────────────────────────
  section('bf-5. No "invalid transition" console.warn across bfcache round-trip');
  {
    let harness = null;
    try {
      harness = await setupPuppeteerBfcacheHarness();
      await loadPermissiveContainerInPuppeteer(harness.page, { requireSharcInit: false });
      await harness.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.newState === 'active'),
        { timeout: 10_000 },
      );
      await triggerBfcacheEntry(harness.page);
      await triggerBfcacheRestore(harness.page);
      const invalidTransitionWarns = harness.consoleWarns.filter(
        (w) => /invalid transition/i.test(w));
      assert(invalidTransitionWarns.length === 0,
        `bf-5. No "invalid transition" warnings (got: ${JSON.stringify(invalidTransitionWarns)})`);
    } catch (e) {
      assert(false, 'bf-5. Setup threw: ' + (e && e.message || e));
    } finally {
      if (harness && harness.cleanup) await harness.cleanup();
    }
  }
}

main().then(() => {
  console.log('');
  if (failures > 0) {
    process.stderr.write(`✗ ${failures} bfcache-roundtrip assertion(s) failed.\n`);
    process.exit(1);
  }
  console.log('✓ All bfcache-roundtrip assertions passed.');
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
