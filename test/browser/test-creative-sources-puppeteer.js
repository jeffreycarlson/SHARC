#!/usr/bin/env node
/**
 * Browser-level coverage for the Creative Sources harness.
 *
 * Issue #69 originally assumed Chromium would let the navigation bridge wrap
 * `location.assign`, `location.replace`, and the `location.href` setter.
 * Chromium exposes those as non-configurable own properties on `Location`, so
 * JavaScript cannot replace them. The load-event backstop is therefore the
 * enforceable browser behavior: each attempted `location.*` navigation must
 * terminate with RENDERER_UNAUTHORIZED_NAVIGATION (2118) instead of escaping
 * silently.
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
const BASE_URL = `http://localhost:${PORT}`;
const HARNESS_URL = `${BASE_URL}/test/browser/test-creative-sources.html`;
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

async function withServer(body) {
  const server = spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      RENDERER_PORT: String(RENDERER_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log('[server]', text);
  });
  server.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error('[server!]', text);
  });

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
  console.log('test-creative-sources-puppeteer.js — issues #69, #83, #84\n');

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
      page.on('console', (msg) => {
        const type = msg.type();
        if (type === 'error' || type === 'warning' || type === 'warn') {
          console.log(`[page.${type}]`, msg.text().slice(0, 400));
        }
      });

      await page.goto(HARNESS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      const hasHarness = await page.evaluate(() => Boolean(
        window.__sharcCreativeSourcesHarness
          && typeof window.__sharcCreativeSourcesHarness.runNavigationProbe === 'function',
      ));
      assert(hasHarness,
        'Puppeteer loaded test/browser/test-creative-sources.html automation hooks');

      console.log('\nbridge_load_failed. unparseable BRIDGE_URL_TEMPLATE');
      {
        const result = await page.evaluate(() =>
          window.__sharcCreativeSourcesHarness.runBridgeLoadFailureProbe());
        const unparseableLog = result.messages.find((m) =>
          m.payload && m.payload.reason === 'bridge_url_unparseable'
            && m.payload.bridge === 'mraid');
        const bridgeFailedLog = result.messages.find((m) =>
          m.payload && m.payload.reason === 'bridge_load_failed'
            && m.payload.bridge === 'mraid');
        const bridgeEvent = result.securityEvents.find((event) =>
          event.type === 'bridge_load_failed');
        const firstError = result.errors[0];

        assert(result.terminated === true,
          'unparseable bridge template: container terminates');
        assert(result.creativeRendered === false,
          'unparseable bridge template: renderer does not report :rendered');
        assert(Boolean(unparseableLog),
          'unparseable bridge template: renderer logs bridge_url_unparseable for mraid');
        assert(Boolean(bridgeFailedLog),
          'unparseable bridge template: renderer logs bridge_load_failed for mraid');
        assert(firstError && firstError.code === 2115,
          'unparseable bridge template: onError fires RENDERER_FAILED (2115)');
        assert(bridgeEvent && bridgeEvent.errorCode === 2115
            && bridgeEvent.details && bridgeEvent.details.bridge === 'mraid'
            && bridgeEvent.details.url === 'http://[invalid',
          'unparseable bridge template: onSecurityEvent bridge_load_failed carries bridge and substituted URL');
      }

      console.log('\nunknown_bridge_skipped. future bridge identifier');
      {
        const result = await page.evaluate(() =>
          window.__sharcCreativeSourcesHarness.runUnknownBridgeProtocolProbe());
        const rendered = result.messages.find((m) =>
          m && m.type === 'SHARC:Renderer:rendered');
        const failed = result.messages.find((m) =>
          m && m.type === 'SHARC:Renderer:failed');
        const unknownLog = result.messages.find((m) =>
          m && m.type === 'SHARC:Test:rendererSecurityLog'
            && m.payload && m.payload.reason === 'unknown_bridge_skipped'
            && m.payload.bridge === 'definitely-not-a-real-bridge');
        const mraidProbe = result.messages.find((m) =>
          m && m.type === 'SHARC:Test:creative:mraid');

        assert(Boolean(rendered),
          'unknown bridge: renderer still posts :rendered');
        assert(!failed,
          'unknown bridge: renderer does not post :failed');
        assert(Boolean(unknownLog),
          'unknown bridge: renderer logs unknown_bridge_skipped with the identifier');
        assert(mraidProbe && mraidProbe.hasMraid === true,
          'unknown bridge: known mraid bridge still loads for the creative');
      }

      for (const kind of ['assign', 'replace', 'href']) {
        console.log(`\n${kind}. window.location.${kind === 'href' ? 'href =' : kind + '()'} browser backstop`);
        const result = await page.evaluate((probeKind) =>
          window.__sharcCreativeSourcesHarness.runNavigationProbe(probeKind), kind);

        const before = result.messages.find((m) =>
          m.type === 'SHARC:Test:navProbe:before');
        const routed = result.messages.find((m) =>
          m.type === 'SHARC:Test:navProbe:routed');
        const navEvent = result.securityEvents.find((event) =>
          event.type === 'unauthorized_navigation');
        const firstError = result.errors[0];

        assert(result.creativeRendered === true,
          `${kind}: renderer reached :rendered before navigation probe fired`);
        assert(before && before.descriptors && before.descriptors[kind]
            && before.descriptors[kind].configurable === false,
          `${kind}: Chromium exposes Location.${kind} as non-configurable`);
        assert(!routed,
          `${kind}: bridge does not falsely report routing for non-overridable Location.${kind}`);
        assert(result.terminated === true,
          `${kind}: container terminates after native iframe navigation`);
        assert(firstError && firstError.code === 2118,
          `${kind}: onError fires RENDERER_UNAUTHORIZED_NAVIGATION (2118)`);
        assert(navEvent && navEvent.errorCode === 2118
            && navEvent.details && navEvent.details.variant === 'markup',
          `${kind}: onSecurityEvent unauthorized_navigation carries code 2118 and variant=markup`);
      }
    } finally {
      await browser.close();
    }
  });

  console.log('');
  if (failures > 0) {
    process.stderr.write(`✗ ${failures} browser assertion(s) failed.\n`);
    process.exit(1);
  }
  console.log('✓ All browser assertions passed.');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
