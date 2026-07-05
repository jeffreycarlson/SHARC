#!/usr/bin/env node
/**
 * test-mraid-ready-dom-measurement-puppeteer.js — Slice E3 (#392) browser proof.
 *
 * THE REAL BUG, in a real browser. The node tier
 * (test-mraid-ready-document-load-gate.js) proves the gate as logic over a
 * controllable readyState; THIS tier proves the property that only a real load
 * can show: a creative whose `ready` handler measures its OWN late DOM reads the
 * CORRECT dimensions, because `ready` now fires after the creative document is
 * load-complete.
 *
 * The fixture (mraid-ready-dom-measurement.html) delivers Container:init
 * MID-PARSE (readyState 'loading'), before the measured element exists. On the
 * OLD (ungated) bridge, `ready` fired synchronously at that moment and the
 * handler read null/0. On the E3-gated bridge, `ready` defers to window 'load'
 * and the handler measures the real 300x120 rect.
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
const HARNESS_URL = `${BASE_URL}/test/browser/mraid-ready-dom-measurement.html`;
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
  console.log('test-mraid-ready-dom-measurement-puppeteer.js — Slice E3 (#392) real-bug proof\n');

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

      // `ready` fires off window 'load' now; it may land a tick after page load.
      // Bounded wait for readyFired; on timeout, fall through to red assertions
      // that report the observed state (red for the right reason, not a crash).
      await page.waitForFunction(
        () => Boolean(window.__mraidReadyProbe && window.__mraidReadyProbe.readyFired),
        { timeout: 10_000 },
      ).catch(() => {});

      const p = await page.evaluate(() => window.__mraidReadyProbe || null);

      assert(p !== null, 'fixture exposed __mraidReadyProbe');
      if (!p) return;
      if (p.error) console.error('  [fixture error]', p.error);

      // Sanity: Container:init WAS delivered mid-parse — this is what makes the
      // proof non-vacuous. If it were delivered at 'complete', the old bridge
      // would have coincidentally passed too.
      assert(p.readyStateAtInitDelivery === 'loading',
        `Container:init was delivered mid-parse (readyState 'loading' at delivery; got '${p.readyStateAtInitDelivery}')`);

      assert(p.readyFired === true, 'MRAID ready fired');

      // THE PROOF: ready fired only after the creative document was load-complete,
      // so the late element existed and measured correctly.
      assert(p.readyStateAtReady === 'complete',
        `readyState was 'complete' when ready fired (got '${p.readyStateAtReady}')`);
      assert(p.probeExistsAtReady === true,
        'the late <body> element existed when the ready handler ran');
      assert(p.measuredWidth === 300 && p.measuredHeight === 120,
        `ready handler measured the real 300x120 rect (got ${p.measuredWidth}x${p.measuredHeight})`);
    } finally {
      await browser.close();
    }
  });
}

run().then(() => {
  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} ready-DOM-measurement assertion(s) failed.`);
    process.exit(1);
  } else {
    console.log('✓ All ready-DOM-measurement assertions passed.');
  }
}).catch((err) => {
  console.error('\n✗ ready-DOM-measurement runner error:', err && err.stack || err);
  process.exit(1);
});
