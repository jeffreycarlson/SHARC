#!/usr/bin/env node
/**
 * G5 F3 spike — T2 OMID nonce-over-port seam, end-to-end in real Chrome.
 *
 * Extends the F1 spike pattern (test/browser/g5-f1-url-mode-spike.js): a SHARC
 * URL creative self-includes BOTH dist/sharc-creative.js AND
 * dist/sharc-omid-shim.js plus a synthetic omid3p vendor; the host arms OMID
 * via the bid-signaled auto-install path (creativeMeta.apis [7] +
 * measurement.omid sidecar + omidAutoInstall). Cross-origin serving is
 * mandatory (host :18885 / creative :18887 — third origin).
 *
 * Proved end-to-end:
 *   1. Container:omidShimInit delivered over the ESTABLISHED port
 *      post-handshake (URL variant, zero injection).
 *   2. The SDK auto-installed the self-included shim with the delivered nonce
 *      (negative control: a wrong-nonce inbound Event is refused; the
 *      delivered-nonce Event is accepted).
 *   3. The synthetic vendor's omid3p registration round-trips: subscribe →
 *      deferred Register → flushed at sessionStart → arrives at the container
 *      OVER THE PORT signed with the SAME nonce the container armed.
 *
 * Named residual (NOT hacked around here): the publisher→shim OMID Event
 * relay (`_relayOmidEvent`) rides window.postMessage with a concrete
 * targetOrigin and therefore cannot reach the opaque-origin URL-variant
 * iframe — the bridge fails closed (console warn). The fixture stands in with
 * a synthetic in-iframe dispatch signed with the delivered nonce, which is
 * exactly the validator surface under test (the shim's 4-check gate).
 * Events-over-port is future work, outside the ratified T2 seam.
 *
 * Run: npm run build && node test/browser/g5-f3-omid-shim-spike.js
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const HOST_PORT = 18885;
const RENDERER_PORT = 18886; // spawned by server.cjs; unused in URL variant
const CREATIVE_PORT = 18887; // third origin
const CREATIVE_RENDERER_PORT = 18888; // second listener; unused

const HOST_URL = `http://localhost:${HOST_PORT}/test/browser/fixtures/g5-url-mode/g5-f3-host.html`;
const CREATIVE_URL = `http://localhost:${CREATIVE_PORT}/test/browser/fixtures/g5-url-mode/g5-f3-sharc-omid-shim.html`;
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
  // logs entries look like: 'g5f3:<kind>:<json>'
  const out = [];
  for (const entry of logs) {
    const m = /^g5f3:([a-z-]+):(.*)$/.exec(entry);
    if (!m) continue;
    let data = {};
    try { data = JSON.parse(m[2]); } catch (_) { /* keep {} */ }
    out.push({ kind: m[1], data });
  }
  return out;
}

async function run() {
  console.log('g5-f3-omid-shim-spike.js — G5 T2 nonce-over-port browser proof\n');
  console.log(`host origin:     http://localhost:${HOST_PORT}`);
  console.log(`creative origin: http://localhost:${CREATIVE_PORT} (cross-origin to host)\n`);

  const hostServer = spawnServer(HOST_PORT, RENDERER_PORT, 'host-server');
  const creativeServer = spawnServer(CREATIVE_PORT, CREATIVE_RENDERER_PORT, 'creative-server');

  let browser = null;
  const relayRefusals = [];
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
      const text = msg.text();
      if (text.indexOf('refusing to relay OMID event') !== -1) {
        relayRefusals.push(text);
        return; // named residual — recorded, reported below, not noise
      }
      const type = msg.type();
      if (type === 'error' || type === 'warning' || type === 'warn') {
        console.log(`[page.${type}]`, text.slice(0, 300));
      }
    });
    page.on('response', (res) => {
      if (res.status() >= 400) console.log('[net]', res.status(), res.url());
    });

    await page.goto(`${HOST_URL}?creativeUrl=${encodeURIComponent(CREATIVE_URL)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Wait for the full proof sequence to complete inside the creative.
    try {
      await page.waitForFunction(() => {
        const s = window.__g5;
        if (!s) return false;
        if (s.constructionError) return true; // fail fast — surfaced below
        const kinds = s.logs.map((l) => l.split(':')[1]);
        return kinds.includes('proof-complete');
      }, { timeout: RUN_TIMEOUT_MS });
    } catch (err) {
      const snapshot = await page.evaluate(() => window.__g5 || null);
      console.error('[spike] proof wait timed out; harness state snapshot:');
      console.error(JSON.stringify(snapshot, null, 2));
      throw err;
    }

    const snapshot = await page.evaluate(() => {
      window.__g5ReadArmedNonce();
      return window.__g5;
    });
    const reports = parseReports(snapshot.logs);
    const byKind = (kind) => reports.filter((r) => r.kind === kind);

    console.log('Phase 1 — lifecycle + OMID arming');
    assert(snapshot.constructionError === null,
      `container constructed without error (got: ${snapshot.constructionError})`);
    assert(snapshot.errors.length === 0,
      `no fatal container errors (got: ${JSON.stringify(snapshot.errors)})`);
    assert(!snapshot.securityEvents.some((e) => e.type === 'feature_load_failed'),
      'OMID auto-install armed cleanly (no feature_load_failed)');
    assert(byKind('ready').length === 1, 'creative onReady fired (handshake completed)');
    assert(typeof snapshot.armedOmidNonce === 'string' && snapshot.armedOmidNonce.length > 0,
      'container-side OMID protocol registered with a derived protocolNonce');

    console.log('\nPhase 2 — omidShimInit over the established port');
    const shimInit = byKind('omid-shim-init')[0];
    assert(Boolean(shimInit), 'Container:omidShimInit delivered to the creative over the port');
    assert(shimInit && shimInit.data.noncePresent === true,
      'protocolNonce delivered to the creative-side glue');
    assert(shimInit && shimInit.data.placementSessionId === snapshot.placementSessionId,
      `placementSessionId delivered verbatim (got: ${shimInit && shimInit.data.placementSessionId}, want: ${snapshot.placementSessionId})`);
    assert(shimInit && shimInit.data.postRegisterIsFunction === true,
      'postRegister transport hook provided alongside the nonce');
    assert(shimInit && shimInit.data.omid3pInstalled === true,
      'SDK auto-installed the self-included shim (window.omid3p present at listener time)');

    console.log('\nPhase 3 — shim holds the DELIVERED nonce (negative control)');
    assert(byKind('vendor-registered').length === 1,
      'synthetic vendor found window.omid3p and subscribed');
    const wrongNonce = byKind('wrong-nonce-rejected')[0];
    assert(wrongNonce && wrongNonce.data.rejected === true,
      'wrong-nonce inbound Event refused by the shim validator');
    const vendorEvents = byKind('vendor-event');
    assert(vendorEvents.length === 1 && vendorEvents[0].data.type === 'sessionStart',
      `delivered-nonce sessionStart reached the vendor observer exactly once (got: ${JSON.stringify(vendorEvents.map((v) => v.data.type))})`);

    console.log('\nPhase 4 — Register round-trip over the port');
    assert(snapshot.omidRegisters.length === 1,
      `exactly one SHARC:Omid:Register arrived at the container over the port (got: ${snapshot.omidRegisters.length})`);
    const register = snapshot.omidRegisters[0];
    assert(register && register.sharcNonce === snapshot.armedOmidNonce,
      'the Register is signed with the SAME nonce the container armed (out over the port, back over the port)');
    assert(register && register.placementSessionId === snapshot.placementSessionId,
      'the Register carries the placementSessionId');
    assert(register && register.subscription
      && register.subscription.kind === 'sessionObserver'
      && typeof register.subscription.subscriptionId === 'string',
      `the Register carries the vendor subscription descriptor (got: ${JSON.stringify(register && register.subscription)})`);

    console.log('\nNamed residual (informational, not asserted):');
    console.log(`  publisher→shim window relay refusals observed: ${relayRefusals.length}`
      + ' — the URL-variant iframe is opaque-origin, so _relayOmidEvent fails'
      + ' closed; Events-over-port is future work outside the T2 seam.');
  } finally {
    if (browser) await browser.close();
    await killServer(hostServer);
    await killServer(creativeServer);
  }

  console.log('');
  if (failures > 0) {
    process.stderr.write(`✗ F3 spike: ${failures} assertion(s) failed.\n`);
    process.exit(1);
  }
  console.log('✓ F3 spike: T2 nonce-over-port seam works end-to-end — shim installed with the port-delivered nonce; vendor Register round-tripped over the established port.');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
