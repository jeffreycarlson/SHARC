#!/usr/bin/env node

/**
 * G5 red contract R4 — F1 conformance assertions (browser, real Chrome).
 *
 * The F1 existential spike (test/browser/g5-f1-url-mode-spike.js, 2026-07-05)
 * PASSED end-to-end: a SHARC-native URL creative (self-loaded SDK, cross-origin
 * third-origin serving, zero injection) completes handshake → document-load-
 * anchored ready → effectiveVisibilityChange delivery → placement round-trip →
 * clean close. Those lifecycle facts are asserted GREEN here, honestly — the
 * runtime already delivers them.
 *
 * RED is gated on what the validator will later gate: VERDICT PRODUCTION.
 * The real-run diagnostics collected below must evaluate through the URL-mode
 * staged gates (diagnose.evaluateUrlLifecycleGates: U1 load/render, U2
 * handshake+ready, U3 visibility delivery) to a passing verdict. That
 * evaluator does not exist yet (see R2).
 *
 * Requires: npm run build (dist/), local Chrome. Skips (fail-loud message)
 * only if Chrome cannot be located — never silently green.
 *
 * See ADR: ~/Obsidian/dev-team/sharc/2026-07-05-g5-url-mode-conformance.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import * as diagnose from '../../tools/creative-validator/src/diagnose.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// pid-salted to avoid parallel-lane/stale-server collisions (#400 class;
// mirrors the mraid-lifecycle-gates pattern). Range 16000-18796 stays clear of
// the validator's fixed 18865-18867.
const PORT_BASE = 16000 + (process.pid % 700) * 4;
const HOST_PORT = PORT_BASE;
const RENDERER_PORT = PORT_BASE + 1;
const CREATIVE_PORT = PORT_BASE + 2;
const CREATIVE_RENDERER_PORT = PORT_BASE + 3;

const HOST_URL = `http://localhost:${HOST_PORT}/test/browser/fixtures/g5-url-mode/g5-f1-host.html`;
const CREATIVE_URL = `http://localhost:${CREATIVE_PORT}/test/browser/fixtures/g5-url-mode/g5-f1-creative.html`;

function resolveChromePath() {
  const fromEnv = process.env.CHROME_PATH
    || process.env.CHROME_EXECUTABLE_PATH
    || process.env.BROWSER_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
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
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function spawnServer(port, rendererPort) {
  return spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), RENDERER_PORT: String(rendererPort) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', (err) => {
        if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${url}: ${err.message}`));
        else setTimeout(attempt, 100);
      });
      req.setTimeout(1000, () => req.destroy(new Error('request timed out')));
    }
    attempt();
  });
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

test('G5 R4: F1 fixture lifecycle is green in real Chrome; URL-mode verdict production is the red gate', { timeout: 120_000 }, async () => {
  const chromePath = resolveChromePath();
  assert.ok(chromePath,
    'Chrome/Chromium required for R4 (set CHROME_PATH) — R4 must run in a real browser');

  assert.ok(existsSync(path.join(repoRoot, 'dist', 'sharc-container.mjs')),
    'dist/ missing — run `npm run build` before test:g5-red (R4 drives built bundles)');

  const hostServer = spawnServer(HOST_PORT, RENDERER_PORT);
  const creativeServer = spawnServer(CREATIVE_PORT, CREATIVE_RENDERER_PORT);
  let browser = null;
  let snapshot = null;

  try {
    await waitForServer(`http://localhost:${HOST_PORT}/`, 10_000);
    await waitForServer(`http://localhost:${CREATIVE_PORT}/`, 10_000);

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(`${HOST_URL}?creativeUrl=${encodeURIComponent(CREATIVE_URL)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    await page.waitForFunction(() => {
      const s = window.__g5;
      if (!s) return false;
      if (s.constructionError) return true;
      const kinds = s.logs.map((l) => l.split(':')[1]);
      return kinds.includes('ready') && kinds.includes('start') && kinds.includes('ev')
        && (kinds.includes('placement-resolved') || kinds.includes('placement-rejected'));
    }, { timeout: 30_000 });

    await page.evaluate(() => window.__g5Container.close());
    await page.waitForFunction(() => window.__g5 && window.__g5.closed === true, { timeout: 10_000 });
    snapshot = await page.evaluate(() => window.__g5);
  } finally {
    if (browser) await browser.close();
    await killServer(hostServer);
    await killServer(creativeServer);
  }

  // ── GREEN lifecycle facts (F1 spike verdict: WORKS — asserted honestly). ──
  const reports = parseReports(snapshot.logs);
  const byKind = (kind) => reports.filter((r) => r.kind === kind);
  assert.equal(snapshot.constructionError, null, 'container constructed');
  assert.equal(snapshot.errors.length, 0, 'no fatal errors across the lifecycle');
  const ready = byKind('ready')[0];
  assert.ok(ready, 'handshake completed (creative onReady fired, cross-origin, zero injection)');
  assert.equal(ready.data.readyState, 'complete', 'ready is document-load-anchored');
  const evPercents = byKind('ev').map((r) => r.data && r.data.effectivePercent);
  assert.ok(evPercents.some((p) => typeof p === 'number' && p > 0),
    'effectiveVisibilityChange delivered with a positive composed percent');
  assert.ok(byKind('placement-resolved').length === 1, 'placement change round-tripped');
  assert.equal(snapshot.closed, true, 'close tore down cleanly');

  // ── RED gate: verdict production over the real run. ──
  const run = diagnose.makeEmptyRun({
    creativeRendered: true,
    terminated: true, // clean close
    urlLifecycle: {
      loaded: true,
      handshake: {
        completed: true,
        readyDocumentLoadAnchored: ready.data.readyState === 'complete',
      },
      visibility: {
        delivered: true,
        lastPercent: evPercents.filter((p) => typeof p === 'number').pop(),
      },
    },
  });

  assert.equal(
    typeof diagnose.evaluateUrlLifecycleGates,
    'function',
    'G5 URL-mode contract: the F1 lifecycle is GREEN end-to-end in a real '
      + 'browser, but the validator cannot yet produce a URL-mode verdict — '
      + 'diagnose.js must export evaluateUrlLifecycleGates (gates U1/U2/U3) '
      + 'so this real run classifies as passed',
  );
  const gates = diagnose.evaluateUrlLifecycleGates(run);
  assert.equal(gates.passed, true,
    `F1 real-run diagnostics must pass all URL gates (failed: ${gates.failedGate})`);
});
