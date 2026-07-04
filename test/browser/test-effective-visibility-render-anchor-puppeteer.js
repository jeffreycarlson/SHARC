#!/usr/bin/env node
/**
 * test-effective-visibility-render-anchor-puppeteer.js — Slice C L-13 (RED).
 *
 * The validator/puppeteer tier for the effective-visibility model. Where the
 * node tier (test-effective-visibility-composer.js) proves the composer as pure
 * logic over two scalars, THIS tier proves the one property that needs a real
 * load: EV-6, the render anchor.
 *
 * EV-6: before P3 (creative-rendered), effective-visibility MUST be
 * notAttached / 0% even when the REAL IntersectionObserver reports ratio 1.0
 * early; no viewableChange(true) before render. This can only be asserted
 * faithfully with a real renderer + real IO + real page-visibility plumbing
 * (the L-8…L-12 hooks are node-modelable; L-13 is not).
 *
 * STATUS: RED. On `7a94ab5` the container exposes no effectiveVisibilityChange
 * channel and no _composeEffectiveVisibility composer, so the fixture reports
 * `supported === false` and this runner FAILS on that assertion — the right
 * reason (surface absent), not an infra flake. When Slice C lands and the load
 * anchor (R-2) is faithful, the fixture wires a real container and this test
 * asserts the pre-render timeline carries only notAttached/0 values.
 *
 * Harness mirrors test-creative-sources-puppeteer.js (Chrome resolution +
 * server.cjs boot + page.evaluate hooks).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = parsePort(process.env.PORT, 18785);
const RENDERER_PORT = parsePort(process.env.RENDERER_PORT, PORT + 1);
const BASE_URL = `http://localhost:${PORT}`;
const HARNESS_URL = `${BASE_URL}/test/browser/effective-visibility-render-anchor.html`;
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
  console.log('test-effective-visibility-render-anchor-puppeteer.js — Slice C L-13 (RED)\n');

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

      const state = await page.evaluate(() => {
        const h = window.__sharcEvHarness || {};
        return {
          present: Boolean(window.__sharcEvHarness),
          supported: h.supported === true,
          error: h.error || null,
          timeline: h.timeline || [],
        };
      });

      assert(state.present, 'fixture loaded __sharcEvHarness hooks');

      // The load-bearing RED assertion: the composer surface must exist for L-13
      // to be faithful. Absent it, fail here with a clear reason.
      assert(state.supported,
        'container exposes _composeEffectiveVisibility + EFFECTIVE_VISIBILITY_CHANGE channel'
        + (state.error ? ` (fixture error: ${state.error})` : ''));

      // EV-6 render anchor — only meaningful once supported. Every payload the
      // creative received BEFORE creative-rendered must be notAttached/0.
      const preRender = state.timeline.filter((e) => e.afterRender === false);
      assert(state.supported && preRender.every((e) => e.effectivePercent === 0
        && e.reason === 'notAttached'),
        'no pre-render effective-visibility payload exceeds 0 / notAttached (EV-6)');
      assert(state.supported && !state.timeline.some((e) => e.afterRender === false
        && e.effectivePercent >= 50),
        'no viewableChange-crossing value (≥50) before creative-rendered');
    } finally {
      await browser.close();
    }
  });
}

run().then(() => {
  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} render-anchor assertion(s) failed (RED — expected until Slice C + R-2 land).`);
    process.exit(1);
  } else {
    console.log('✓ All effective-visibility render-anchor assertions passed.');
  }
}).catch((err) => {
  console.error('\n✗ render-anchor runner error:', err && err.stack || err);
  process.exit(1);
});
