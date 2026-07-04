#!/usr/bin/env node
/**
 * test-effective-visibility-render-anchor-puppeteer.js — Slice C L-13.
 *
 * The validator/puppeteer tier for the effective-visibility model. Where the
 * node tier (test-effective-visibility-composer.js) proves the composer as pure
 * logic over two scalars, THIS tier proves the properties that need a real
 * load: EV-6 (the render anchor) and the review-F1/F2 positive path.
 *
 * EV-6: before P3 (creative-rendered), effective-visibility MUST be
 * notAttached / 0% even when the REAL IntersectionObserver reports ratio 1.0
 * early; no viewableChange(true) before render. This can only be asserted
 * faithfully with a real renderer + real IO + real page-visibility plumbing
 * (the L-8…L-12 hooks are node-modelable; L-13 is not).
 *
 * Positive post-render assertion (review F2, pinning F1): after render on a
 * fully-visible page, the container MUST push a payload with
 * effectivePercent > 0 and reason === null. Pre-F1 the axis-2 parent-visible
 * field was only written by a `visibilitychange` handler — an event that never
 * fires on a plain load — so a fully-visible rendered ad composed to
 * 0/'backgrounded' and this assertion fails; F1's constructor seeding from
 * document.visibilityState makes it green.
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
  console.log('test-effective-visibility-render-anchor-puppeteer.js — Slice C L-13\n');

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

      // The render → handshake → ACTIVE-sync push cascade is async relative to
      // the page `load` event. Wait (bounded) for the positive post-render push
      // to land end-to-end; on timeout fall through and let the assertions
      // report the observed timeline (red for the right reason, not a runner
      // crash).
      const sawPositive = await page.waitForFunction(
        () => {
          const h = window.__sharcEvHarness;
          return Boolean(h && h.timeline && h.received
            && h.timeline.some((e) => e.afterRender === true
              && e.effectivePercent > 0 && e.reason === null)
            && h.received.some((p) => p.effectivePercent > 0 && p.reason === null));
        },
        { timeout: 15_000 },
      ).then(() => true).catch(() => false);

      // URL-variant leg (Codex-review blocker): the same positive cascade for
      // a Creative URL container, whose render anchor is the iframe `load`
      // event. Bounded wait; on timeout fall through to red assertions.
      const sawUrlPositive = await page.waitForFunction(
        () => {
          const h = window.__sharcEvHarness;
          return Boolean(h && h.urlTimeline && h.urlReceived
            && h.urlTimeline.some((e) => e.afterRender === true
              && e.effectivePercent > 0 && e.reason === null)
            && h.urlReceived.some((p) => p.effectivePercent > 0 && p.reason === null));
        },
        { timeout: 15_000 },
      ).then(() => true).catch(() => false);

      const state = await page.evaluate(() => {
        const h = window.__sharcEvHarness || {};
        return {
          present: Boolean(window.__sharcEvHarness),
          supported: h.supported === true,
          error: h.error || null,
          timeline: h.timeline || [],
          received: h.received || [],
          urlTimeline: h.urlTimeline || [],
          urlReceived: h.urlReceived || [],
        };
      });

      assert(state.present, 'fixture loaded __sharcEvHarness hooks');

      // The composer surface must exist for L-13 to be faithful. Absent it,
      // fail here with a clear reason.
      assert(state.supported,
        'container exposes _composeEffectiveVisibility + EFFECTIVE_VISIBILITY_CHANGE channel'
        + (state.error ? ` (fixture error: ${state.error})` : ''));

      // Review F2 positive assertion (pins F1): a rendered ad on a fully
      // visible page must push >0 / reason:null — never 0/'backgrounded' from
      // an unseeded axis-2.
      if (!sawPositive) {
        console.error('  [timeline]', JSON.stringify(state.timeline));
        console.error('  [received]', JSON.stringify(state.received));
      }
      assert(state.timeline.some((e) => e.afterRender === true
        && e.effectivePercent > 0 && e.reason === null),
        'post-render push carries effectivePercent > 0 with reason null (F1 axis-2 seed)');
      assert(state.received.some((p) => p.effectivePercent > 0 && p.reason === null),
        'creative SDK received the >0 / reason:null payload end-to-end');

      // EV-6 render anchor. Every payload the container pushed BEFORE
      // creative-rendered must be notAttached/0 — non-vacuous now that the
      // fixture drives a real container (an empty pre-render set proves no
      // pre-render push escaped at all).
      const preRender = state.timeline.filter((e) => e.afterRender === false);
      assert(state.supported && preRender.every((e) => e.effectivePercent === 0
        && e.reason === 'notAttached'),
        'no pre-render effective-visibility payload exceeds 0 / notAttached (EV-6)');
      assert(state.supported && !state.timeline.some((e) => e.afterRender === false
        && e.effectivePercent >= 50),
        'no viewableChange-crossing value (≥50) before creative-rendered');

      // ── URL-variant leg ──
      // The iframe `load` event is the URL variant's creative-rendered anchor.
      // A loaded, fully-visible URL creative must receive a positive push —
      // pre-fix the anchor never flipped and the composer emitted
      // 0/'notAttached' forever.
      if (!sawUrlPositive) {
        console.error('  [urlTimeline]', JSON.stringify(state.urlTimeline));
        console.error('  [urlReceived]', JSON.stringify(state.urlReceived));
      }
      assert(state.urlTimeline.some((e) => e.afterRender === true
        && e.effectivePercent > 0 && e.reason === null),
        'URL variant: post-load push carries effectivePercent > 0 with reason null (iframe load flips the anchor)');
      assert(state.urlReceived.some((p) => p.effectivePercent > 0 && p.reason === null),
        'URL variant: creative SDK received the positive payload end-to-end');
      const urlPreRender = state.urlTimeline.filter((e) => e.afterRender === false);
      assert(state.supported && urlPreRender.every((e) => e.effectivePercent === 0
        && e.reason === 'notAttached'),
        'URL variant: no pre-anchor payload exceeds 0 / notAttached (EV-6)');
    } finally {
      await browser.close();
    }
  });
}

run().then(() => {
  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} render-anchor assertion(s) failed.`);
    process.exit(1);
  } else {
    console.log('✓ All effective-visibility render-anchor assertions passed.');
  }
}).catch((err) => {
  console.error('\n✗ render-anchor runner error:', err && err.stack || err);
  process.exit(1);
});
