#!/usr/bin/env node
/**
 * test-bfcache-relink-e2e.js — R3 §6.4 real-bfcache Puppeteer tier (#338)
 *
 * The BINDING tier for the dead-port half (RC-3): jsdom cannot close a
 * MessagePort, so the relink can only be proven in real Chrome with a genuine
 * bfcache eviction-and-restore. Builds on the 0.7.6 bfcache Puppeteer wiring
 * (docs/design/0.7.6-bfcache-puppeteer-wiring.md).
 *
 * Coverage (ADR docs/design/0.7.11-bfcache-omid-relink-r3.md §6.4):
 *   E-1 [RED→GREEN] real pageshow{persisted:true} after a genuine bfcache
 *       round-trip ⇒ the container relinks the dead port and the creative-side
 *       MRAID isViewable() re-syncs to true over the NEW port. (INV-R8, INV-R11)
 *   E-2 [RED→GREEN] the headline #338 proof: after real bfcache restore into a
 *       visible viewport, OMID reports VISIBLE (publisher-page
 *       adEvents.stateChange('VISIBLE') observed). Baseline: stuck NON_VISIBLE.
 *       This is publisher-page / port-independent — it passes on the §3.2
 *       level-reassert alone. (INV-R5)
 *   E-3 [GREEN-guard] OS-freeze `resume` (NOT bfcache; the port survived) ⇒ NO
 *       relink occurs; restore still re-asserts visibility correctly. Pins the
 *       bfcache-vs-OS-freeze distinction. (INV-R8, INV-R5)
 *
 * Tier + retry policy (mirrors test-html-lifecycle-adapter-bfcache.js):
 *   behavioral sections get up to 3 retries; pass on any-of-3.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = parsePort(process.env.PORT, 18767);
const RENDERER_PORT = parsePort(process.env.RENDERER_PORT, PORT + 1);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const RUN_TIMEOUT_MS = 60_000;
const BFCACHE_INSTALL_MS = Number(process.env.BFCACHE_INSTALL_MS) || 600;

let failures = 0;
function assert(condition, message) {
  if (condition) { console.log('  ✓', message); }
  else { console.error('  ✗', message); failures++; }
}
function section(name) { console.log('\n' + name); }

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
    if (!existsSync(fromEnv)) throw new Error(`Chrome override does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ]
    : process.platform === 'linux'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    : process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : [];
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  throw new Error('Unable to locate Chrome/Chromium. Set CHROME_PATH.');
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', (err) => {
        if (Date.now() >= deadline) { reject(new Error(`Timed out waiting for ${url}: ${err.message}`)); return; }
        setTimeout(attempt, 100);
      });
      req.setTimeout(1000, () => req.destroy(new Error('request timed out')));
    })();
  });
}

async function setupHarness() {
  const serverProc = spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT), RENDERER_PORT: String(RENDERER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (chunk) => { const t = String(chunk).trim(); if (t) console.error('[server!]', t); });
  try {
    await waitForServer(`${BASE_URL}/`, 10_000);
  } catch (err) {
    serverProc.kill('SIGTERM');
    throw new Error('Server failed to start within 10 s: ' + err.message);
  }

  const chromePath = resolveChromePath();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--enable-features=BackForwardCache,BackForwardCacheMemoryControls',
      '--disable-features=BackForwardCacheTimeToLiveControl',
    ],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(RUN_TIMEOUT_MS);
  const consoleWarns = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'warning' || type === 'warn') consoleWarns.push(msg.text());
    if (type === 'error') console.log(`[page.${type}]`, msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => console.error('[page!]', err.message));

  const cleanup = async () => {
    try { await browser.close(); } catch (_) { /* ignore */ }
    serverProc.kill('SIGTERM');
    await new Promise((resolve) => { serverProc.once('exit', resolve); setTimeout(resolve, 1500); });
  };
  return { browser, page, consoleWarns, cleanup };
}

async function loadFixture(page, mode) {
  await page.goto(`${BASE_URL}/test/browser/bfcache-relink-fixture.html?mode=${mode}`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
  await Promise.race([
    page.waitForFunction(() => window.__sharcBfcacheReady === true, { timeout: 30_000 }),
    new Promise((_, reject) => page.once('pageerror', (err) => reject(new Error('Fixture page error: ' + err.message)))),
  ]);
}

async function triggerBfcacheEntry(page) {
  await page.goto(`${BASE_URL}/test/browser/bfcache-away.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, BFCACHE_INSTALL_MS));
}

async function triggerBfcacheRestore(page) {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.__lastPageshowPersisted !== undefined, { timeout: 10_000 });
  return { persisted: await page.evaluate(() => window.__lastPageshowPersisted) };
}

async function runWithRetry(fn, attempts) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    console.log(`  [attempt ${i}/${attempts}]`);
    try {
      const before = failures;
      await fn();
      if (failures === before) { if (i > 1) console.log(`  ↳ passed on attempt ${i}`); return; }
      failures = before;
      lastErr = new Error('assertions failed on attempt ' + i);
      console.log(`  ↳ attempt ${i} produced failures, retrying`);
    } catch (e) {
      lastErr = e;
      console.log(`  ↳ attempt ${i} threw: ${e && e.message || e}`);
    }
  }
  console.log(`  ↳ all ${attempts} attempts exhausted; reporting final result`);
  try { await fn(); } catch (e) { assert(false, `section threw after ${attempts} retries: ${e && e.message || e}`); }
  if (lastErr) { /* surfaced via assert/failures */ }
}

console.log('test-bfcache-relink-e2e.js — R3 §6.4 real-bfcache relink (#338)\n');

async function main() {
  // ── E-2 — headline #338 OMID proof (publisher-page; port-independent) ──────
  section('E-2. real bfcache restore into visible viewport ⇒ OMID reports VISIBLE (headline #338 proof)');
  await runWithRetry(async () => {
    let h = null;
    try {
      h = await setupHarness();
      await loadFixture(h.page, 'omid');
      // Wait for the container to reach active so the OMID session starts and
      // VISIBLE is signaled at least once pre-bfcache.
      await h.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.newState === 'active'),
        { timeout: 10_000 },
      );
      await h.page.waitForFunction(
        () => Array.isArray(window.__omidVisibilityStates)
          && window.__omidVisibilityStates.includes('VISIBLE'),
        { timeout: 10_000 },
      );

      await triggerBfcacheEntry(h.page);
      const { persisted } = await triggerBfcacheRestore(h.page);
      assert(persisted === true, 'E-2. bfcache actually installed (pageshow.persisted === true)');

      // Let the restore settle (pageshow → relink + level re-assert + IO).
      await h.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.previousState === 'frozen'),
        { timeout: 10_000 },
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));

      // After restore into a visible viewport, OMID must end at VISIBLE. The
      // level re-assert guarantees the last visibility signal is VISIBLE even
      // if no fresh edge crossed into active.
      const result = await h.page.evaluate(() => ({
        lastVisibility: window.__omidBridge && window.__omidBridge._omid
          ? window.__omidBridge._omid.lastVisibilityState : null,
        signals: window.__omidVisibilityStates.slice(),
      }));
      assert(result.lastVisibility === 'visible',
        `E-2. OMID lastVisibilityState === 'visible' after bfcache restore (got: ${result.lastVisibility})`);
      assert(result.signals[result.signals.length - 1] === 'VISIBLE',
        `E-2. last adEvents.stateChange signal is VISIBLE (got: ${JSON.stringify(result.signals.slice(-4))})`);
    } finally {
      if (h && h.cleanup) await h.cleanup();
    }
  }, 3);

  // ── E-1 — creative-side MRAID re-syncs over the RELINKED port ──────────────
  section('E-1. real bfcache restore ⇒ dead port relinked ⇒ MRAID isViewable() re-syncs true over the new port');
  await runWithRetry(async () => {
    let h = null;
    try {
      h = await setupHarness();
      await loadFixture(h.page, 'mraid');
      // Wait for the handshake + startCreative to land the container at active,
      // and the creative-side MRAID to read viewable=true pre-bfcache.
      await h.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.newState === 'active'),
        { timeout: 15_000 },
      );
      // The creative reports its viewability UP via postMessage (the iframe is
      // opaque-origin). Wait for a snapshot with isViewable===true pre-bfcache.
      await h.page.waitForFunction(
        () => window.__mraidSnapshot && window.__mraidSnapshot.isViewable === true,
        { timeout: 15_000 },
      ).catch(() => {});
      const preViewable = await h.page.evaluate(() => window.__mraidSnapshot && window.__mraidSnapshot.isViewable);
      assert(preViewable === true, `E-1. setup: MRAID isViewable() === true before bfcache (got: ${preViewable})`);

      await triggerBfcacheEntry(h.page);
      const { persisted } = await triggerBfcacheRestore(h.page);
      assert(persisted === true, 'E-1. bfcache actually installed (pageshow.persisted === true)');

      // Settle the restore: relink re-bootstraps the port, the creative
      // re-attaches it, and R1's replay re-delivers `active` ⇒ MRAID
      // viewableChange(true) fires and the creative reports up. Clear the stale
      // snapshot, then poll for a fresh post-restore one.
      await h.page.evaluate(() => { window.__mraidSnapshot = null; });
      await h.page.waitForFunction(
        () => { if (typeof window.__requestMraidSnapshot === 'function') window.__requestMraidSnapshot();
          return window.__mraidSnapshot && window.__mraidSnapshot.isViewable === true; },
        { timeout: 10_000, polling: 300 },
      ).catch(() => {});

      const post = await h.page.evaluate(() => ({
        isViewable: window.__mraidSnapshot ? window.__mraidSnapshot.isViewable : null,
        relinkCount: window.__relinkCount,
      }));
      assert(post.relinkCount >= 1,
        `E-1. container relinked the dead port on bfcache restore (relinkCount=${post.relinkCount})`);
      assert(post.isViewable === true,
        `E-1. MRAID isViewable() re-synced to true over the relinked port (got: ${post.isViewable})`);
    } finally {
      if (h && h.cleanup) await h.cleanup();
    }
  }, 3);

  // ── E-3 — OS-freeze resume does NOT relink (port survived) ─────────────────
  section('E-3. OS-freeze resume (NOT bfcache) ⇒ NO relink; visibility still re-asserted');
  await runWithRetry(async () => {
    let h = null;
    try {
      h = await setupHarness();
      await loadFixture(h.page, 'omid');
      await h.page.waitForFunction(
        () => Array.isArray(window.__capturedStateChanges)
          && window.__capturedStateChanges.some((c) => c.newState === 'active'),
        { timeout: 10_000 },
      );
      // Dispatch a synthetic `freeze` then `resume` (the OS-freeze path), NOT a
      // bfcache pageshow{persisted}. The port survives an OS freeze, so the
      // relink (which is only triggered from the adapter's pageshow handler)
      // MUST NOT run.
      const relinkBefore = await h.page.evaluate(() => window.__relinkCount);
      await h.page.evaluate(() => {
        document.dispatchEvent(new Event('freeze'));
        document.dispatchEvent(new Event('resume'));
      });
      await new Promise((r) => setTimeout(r, 300));
      const result = await h.page.evaluate(() => ({
        relinkAfter: window.__relinkCount,
        lastVisibility: window.__omidBridge && window.__omidBridge._omid
          ? window.__omidBridge._omid.lastVisibilityState : null,
      }));
      assert(result.relinkAfter === relinkBefore,
        `E-3. OS-freeze resume did NOT trigger a relink (before=${relinkBefore}, after=${result.relinkAfter})`);
      assert(result.lastVisibility === 'visible',
        `E-3. visibility still re-asserted to visible on OS-freeze resume (got: ${result.lastVisibility})`);
    } finally {
      if (h && h.cleanup) await h.cleanup();
    }
  }, 3);
}

main().then(() => {
  console.log('');
  if (failures > 0) {
    process.stderr.write(`✗ ${failures} bfcache-relink-e2e assertion(s) failed.\n`);
    process.exit(1);
  }
  console.log('✓ All bfcache-relink-e2e assertions passed.');
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
