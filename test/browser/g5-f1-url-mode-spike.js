#!/usr/bin/env node
/**
 * G5 F1 existential spike — SHARC-native Creative URL creative, cross-origin,
 * zero injection, full lifecycle in real Chrome.
 *
 * Question under test (Jeffrey, G5 discovery): "unclear whether a SHARC-only
 * creative URL can work without injection."
 *
 * Topology (three origins — cross-origin is mandatory):
 *   - host page:      http://localhost:18865  (publisher)
 *   - renderer port:  http://localhost:18866  (unused — URL variant has no renderer)
 *   - creative:       http://localhost:18867  (third origin, serves the creative
 *                     page AND dist/sharc-creative.js which it self-includes)
 *
 * Lifecycle driven end-to-end:
 *   handshake completes → ready fires document-load-anchored →
 *   effectiveVisibilityChange delivers → placement change round-trips →
 *   close tears down cleanly.
 *
 * Run: npm run build && node test/browser/g5-f1-url-mode-spike.js
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const HOST_PORT = 18865;
const RENDERER_PORT = 18866; // spawned by server.cjs; unused in URL variant
const CREATIVE_PORT = 18867; // third origin
const CREATIVE_RENDERER_PORT = 18868; // second listener of the creative server.cjs instance; unused

const HOST_URL = `http://localhost:${HOST_PORT}/test/browser/fixtures/g5-url-mode/g5-f1-host.html`;
const CREATIVE_URL = `http://localhost:${CREATIVE_PORT}/test/browser/fixtures/g5-url-mode/g5-f1-creative.html`;
const RUN_TIMEOUT_MS = 30_000;

let failures = 0;

function assert(cond, message) {
  if (cond) {
    process.stdout.write('  ✓ ' + message + '\n');
  } else {
    process.stderr.write('  ✗ ' + message + '\n');
    failures++;
  }
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
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error('Unable to locate Chrome/Chromium. Set CHROME_PATH.');
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
      req.setTimeout(1000, () => req.destroy(new Error('request timed out')));
    }
    attempt();
  });
}

function spawnServer(port, rendererPort, label) {
  const server = spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), RENDERER_PORT: String(rendererPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[${label}]`, text);
  });
  server.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[${label}!]`, text);
  });
  return server;
}

async function killServer(server) {
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const done = () => resolve();
    server.once('exit', done);
    setTimeout(done, 1500);
  });
}

function parseReports(logs) {
  // logs entries look like: 'g5f1:<kind>:<json>'
  const out = [];
  for (const entry of logs) {
    const m = /^g5f1:([a-z-]+):(.*)$/.exec(entry);
    if (!m) continue;
    let data = {};
    try { data = JSON.parse(m[2]); } catch (_) { /* keep {} */ }
    out.push({ kind: m[1], data });
  }
  return out;
}

async function run() {
  console.log('g5-f1-url-mode-spike.js — G5 F1 existential spike\n');
  console.log(`host origin:     http://localhost:${HOST_PORT}`);
  console.log(`creative origin: http://localhost:${CREATIVE_PORT} (cross-origin to host)\n`);

  const hostServer = spawnServer(HOST_PORT, RENDERER_PORT, 'host-server');
  const creativeServer = spawnServer(CREATIVE_PORT, CREATIVE_RENDERER_PORT, 'creative-server');

  let browser = null;
  try {
    await waitForServer(`http://localhost:${HOST_PORT}/`, 10_000);
    await waitForServer(`http://localhost:${CREATIVE_PORT}/`, 10_000);

    const chromePath = resolveChromePath();
    console.log(`[browser] Launching headless Chrome: ${chromePath}\n`);
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(RUN_TIMEOUT_MS);
    page.on('pageerror', (err) => console.error('[page!]', err.message));
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning' || type === 'warn') {
        console.log(`[page.${type}]`, msg.text().slice(0, 300));
      }
    });
    page.on('response', (res) => {
      if (res.status() >= 400) console.log('[net]', res.status(), res.url());
    });

    await page.goto(`${HOST_URL}?creativeUrl=${encodeURIComponent(CREATIVE_URL)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Phase 1 — wait for the creative to report ready + start + effective
    // visibility + placement round-trip (all creative-side facts relayed over
    // SHARC.log, the only channel out of a sandboxed cross-origin iframe).
    try {
      await page.waitForFunction(() => {
        const s = window.__g5;
        if (!s) return false;
        if (s.constructionError) return true; // fail fast — surface it below
        const kinds = s.logs.map((l) => l.split(':')[1]);
        return kinds.includes('ready')
          && kinds.includes('start')
          && kinds.includes('ev')
          && (kinds.includes('placement-resolved') || kinds.includes('placement-rejected'));
      }, { timeout: RUN_TIMEOUT_MS });
    } catch (err) {
      const snapshot = await page.evaluate(() => window.__g5 || null);
      console.error('[spike] phase-1 wait timed out; harness state snapshot:');
      console.error(JSON.stringify(snapshot, null, 2));
      throw err;
    }

    const phase1 = await page.evaluate(() => window.__g5);
    const reports = parseReports(phase1.logs);
    const byKind = (kind) => reports.filter((r) => r.kind === kind);

    console.log('Phase 1 — handshake / ready / visibility / placement');
    assert(phase1.constructionError === null,
      `container constructed without error (got: ${phase1.constructionError})`);
    assert(phase1.errors.length === 0,
      `no fatal container errors (got: ${JSON.stringify(phase1.errors)})`);

    const ready = byKind('ready')[0];
    assert(Boolean(ready), 'creative onReady fired (handshake completed cross-origin, zero injection)');
    assert(ready && ready.data.readyState === 'complete',
      `onReady is document-load-anchored: creative saw document.readyState === 'complete' (got: ${ready && ready.data.readyState})`);

    assert(byKind('start').length === 1, 'creative onStart fired (container start delivered)');

    const ev = byKind('ev');
    assert(ev.length > 0, 'effectiveVisibilityChange delivered to the creative');
    const evPercents = ev.map((r) => r.data && r.data.effectivePercent);
    assert(evPercents.some((p) => typeof p === 'number' && p > 0),
      `effective visibility composed to a positive percent (got: ${JSON.stringify(evPercents)})`);

    const placementResolved = byKind('placement-resolved')[0];
    const placementRejected = byKind('placement-rejected')[0];
    assert(Boolean(placementResolved) && !placementRejected,
      `placement change (expand) round-tripped and resolved (rejected: ${placementRejected ? JSON.stringify(placementRejected.data) : 'no'})`);
    assert(phase1.placementChanges.some((c) => c.intent === 'expand'),
      'host onPlacementChange observed the expand');

    const states = phase1.states.map((s) => s.next);
    assert(states.includes('ready') || states.includes('active'),
      `container reached ready/active (states: ${JSON.stringify(states)})`);

    // Phase 2 — close teardown.
    console.log('\nPhase 2 — close teardown');
    await page.evaluate(() => window.__g5Container.close());
    await page.waitForFunction(() => window.__g5 && window.__g5.closed === true,
      { timeout: 10_000 });

    const phase2 = await page.evaluate(() => window.__g5);
    const reports2 = parseReports(phase2.logs);
    assert(phase2.closed === true, 'container onClose fired (clean teardown)');
    assert(reports2.some((r) => r.kind === 'closing'),
      'creative close handler ran before teardown');
    assert(phase2.errors.length === 0,
      `no fatal errors through close (got: ${JSON.stringify(phase2.errors)})`);
    assert(!phase2.securityEvents.some((e) => e.type === 'unauthorized_navigation'),
      'no unauthorized_navigation backstop fired during the clean lifecycle');
  } finally {
    if (browser) await browser.close();
    await killServer(hostServer);
    await killServer(creativeServer);
  }

  console.log('');
  if (failures > 0) {
    process.stderr.write(`✗ F1 spike: ${failures} assertion(s) failed.\n`);
    process.exit(1);
  }
  console.log('✓ F1 spike: SHARC-native URL creative works end-to-end, cross-origin, zero injection.');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
