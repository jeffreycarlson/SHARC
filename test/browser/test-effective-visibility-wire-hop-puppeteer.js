#!/usr/bin/env node
/**
 * test-effective-visibility-wire-hop-puppeteer.js — Slice E6a Item B.
 *
 * The unbroken-chain integration proof the node tier can't give. The node
 * tests each stub the protocol sender at some seam; NOTHING there pins ONE
 * real effective-visibility payload traversing ALL hops. This tier drives one
 * payload end-to-end through the LIVE chain (no stubbed sender):
 *
 *   1. container._pushEffectiveVisibility() composes the value →
 *   2. protocol wire send (SHARC:Container:effectiveVisibilityChange) →
 *   3. creative bus cache+emit (+ replay-of-last on a late on()) →
 *   4. MRAID bridge EV subscription → exposureChange delivered to a
 *      creative-registered `mraid` listener.
 *
 * Deterministic drive: after render + mraid-ready, the host calls
 * container.setHostExposure(73) then setHostExposure(40). The L1 host-exposure
 * axis wins the composer, so the composed integer is exactly 73 then 40 — no
 * flaky scroll / IntersectionObserver.
 *
 * Assertions:
 *   (a) the creative-side mraid exposureChange receives exposedPercentage 73 —
 *       the SAME integer the container composed (one number across every hop);
 *   (b) the 73→40 step crosses EV-7: viewableChange(false) delivered AND
 *       mraid.isViewable() === false (73 ≥ 50 true → 40 < 50 false);
 *   (c) a creative-bus SHARC.on('effectiveVisibilityChange') listener attached
 *       LATE (after the pushes) is replayed the current payload (hop-3
 *       replay-of-last, real chain).
 *
 * This test is GREEN from birth — it pins already-shipped behavior across the
 * real hops; that's the point. It would FAIL if any hop were broken (a dropped
 * wire send, a missing bus cache, a bridge that stopped subscribing).
 *
 * Harness mirrors test-effective-visibility-render-anchor-puppeteer.js (Chrome
 * resolution + server.cjs boot + page.evaluate hooks).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = parsePort(process.env.PORT, 18795);
const RENDERER_PORT = parsePort(process.env.RENDERER_PORT, PORT + 1);
const BASE_URL = `http://localhost:${PORT}`;
const HARNESS_URL = `${BASE_URL}/test/browser/effective-visibility-wire-hop.html`;
const RUN_TIMEOUT_MS = 30_000;

let failures = 0;
function assert(cond, message) {
  if (cond) { process.stdout.write('  ✓ ' + message + '\n'); }
  else { process.stderr.write('  ✗ ' + message + '\n'); failures++; }
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
      throw new Error(`Chrome executable override does not exist: ${fromEnv}`);
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
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', (err) => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${url}: ${err.message}`));
          return;
        }
        setTimeout(attempt, 100);
      });
      req.setTimeout(1000, () => { req.destroy(new Error('request timed out')); });
    }
    attempt();
  });
}

async function withServer(body) {
  const server = spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT), RENDERER_PORT: String(RENDERER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { const t = String(c).trim(); if (t) console.log('[server]', t); });
  server.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.error('[server!]', t); });
  try {
    await waitForServer(`${BASE_URL}/`, 10_000);
    return await body();
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const done = () => resolve();
      server.once('exit', done);
      setTimeout(done, 1500);
    });
  }
}

async function run() {
  console.log('test-effective-visibility-wire-hop-puppeteer.js — Slice E6a Item B\n');

  await withServer(async () => {
    const chromePath = resolveChromePath();
    console.log(`[browser] Launching headless Chrome: ${chromePath}`);
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(RUN_TIMEOUT_MS);
      page.on('pageerror', (err) => console.error('[page!]', err.message));

      await page.goto(HARNESS_URL, { waitUntil: 'load', timeout: 30_000 });

      // The composer surface must exist for this proof to be faithful.
      const supported = await page.evaluate(
        () => Boolean(window.__sharcWireHop && window.__sharcWireHop.supported),
      );
      assert(supported, 'container exposes setHostExposure + EFFECTIVE_VISIBILITY_CHANGE channel');

      // Wait (bounded) for the render → handshake → mraid-ready cascade so the
      // bridge is subscribed and post-ready emission is live before we drive.
      const ready = await page.waitForFunction(
        () => window.__sharcWireHop && window.__sharcWireHop.mraidReady() === true,
        { timeout: 20_000 },
      ).then(() => true).catch(() => false);
      assert(ready, 'mraid reached ready (render + handshake + bridge subscription live)');

      // Deterministic drive: one payload at 73, then one at 40, straight
      // through the live chain (no stubbed sender).
      await page.evaluate(() => { window.__sharcWireHop.drive(); });

      // Bounded wait for both exposure hops to land on the creative-side mraid
      // listener across the full chain.
      const sawBoth = await page.waitForFunction(
        () => {
          const h = window.__sharcWireHop;
          return Boolean(h && h.exposures.some((e) => e.pct === 73)
            && h.exposures.some((e) => e.pct === 40)
            && h.viewables.length > 0
            && h.isViewable !== null
            && h.lateReplay.length > 0);
        },
        { timeout: 15_000 },
      ).then(() => true).catch(() => false);

      const state = await page.evaluate(() => {
        const h = window.__sharcWireHop || {};
        return {
          error: h.error || null,
          exposures: (h.exposures || []).map((e) => e.pct),
          viewables: h.viewables || [],
          isViewable: h.isViewable,
          lateReplay: h.lateReplay || [],
        };
      });

      if (!sawBoth) {
        console.error('  [exposures]', JSON.stringify(state.exposures));
        console.error('  [viewables]', JSON.stringify(state.viewables));
        console.error('  [isViewable]', JSON.stringify(state.isViewable));
        console.error('  [lateReplay]', JSON.stringify(state.lateReplay));
        if (state.error) console.error('  [error]', state.error);
      }

      // (a) The SAME integer the container composed reaches the mraid listener.
      assert(state.exposures.includes(73),
        'mraid exposureChange received exposedPercentage 73 across the full chain (container→wire→bus→bridge→mraid)');
      assert(state.exposures.includes(40),
        'mraid exposureChange received exposedPercentage 40 (the second composed integer)');

      // (b) The 73→40 step crosses EV-7 (50 threshold).
      assert(state.viewables.includes(false),
        'viewableChange(false) delivered on the 73→40 step (EV-7 crossing: 73 ≥ 50 → 40 < 50)');
      assert(state.isViewable === false,
        'mraid.isViewable() === false after the 40 push (below the 50 viewability threshold)');

      // (c) A late-attached creative-bus EV listener is replayed the current
      // payload (hop-3 replay-of-last on the REAL bus).
      assert(state.lateReplay.length > 0,
        'a LATE SHARC.on(effectiveVisibilityChange) listener was replayed the current payload (hop-3 replay-of-last)');
      const lastReplay = state.lateReplay[state.lateReplay.length - 1];
      assert(!!lastReplay && lastReplay.effectivePercent === 40,
        'the replayed payload carries the CURRENT composed value (effectivePercent 40) — got '
        + JSON.stringify(lastReplay));
    } finally {
      await browser.close();
    }
  });
}

run().then(() => {
  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} wire-hop assertion(s) failed.`);
    process.exit(1);
  } else {
    console.log('✓ All effective-visibility wire-hop assertions passed.');
  }
}).catch((err) => {
  console.error('\n✗ wire-hop runner error:', err && err.stack || err);
  process.exit(1);
});
