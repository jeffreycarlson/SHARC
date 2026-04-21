#!/usr/bin/env node
// Regenerate the MRAID 3.0 compliance baseline by running the in-browser
// compliance runner in headless Chrome and persisting the resulting
// `window.__SHARC_HARNESS_RESULTS__` as a timestamped baseline JSON.
//
// Usage:
//   node scripts/regen-mraid3-baseline.js
//
// Requires puppeteer-core (already in node_modules via size-limit's deps)
// and a local Chrome install. On macOS the standard path is used by default;
// override with CHROME_EXECUTABLE_PATH if Chrome lives elsewhere.

import { spawn } from 'node:child_process';
import { writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const baselineDir = path.join(repoRoot, 'examples', 'test');

// The dev server hard-codes port 8765 (see server.cjs).
const SERVER_PORT = 8765;
const BASE_URL = `http://localhost:${SERVER_PORT}`;
const RUNNER_PATH = '/examples/test/mraid-3-compliance-runner.html?autorun=1';
const RUN_TIMEOUT_MS = 5 * 60_000;

const CHROME =
  process.env.CHROME_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not respond at ${url} within ${timeoutMs}ms`);
}

async function main() {
  console.log(`[regen] Starting dev server on :${SERVER_PORT}`);
  const server = spawn(process.execPath, [path.join(repoRoot, 'server.cjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) =>
    process.stdout.write(`[server] ${d.toString().trimEnd()}\n`),
  );
  server.stderr.on('data', (d) =>
    process.stderr.write(`[server!] ${d.toString().trimEnd()}\n`),
  );

  let browser;
  try {
    await waitForServer(BASE_URL + '/', 10_000);

    console.log(`[regen] Launching headless Chrome: ${CHROME}`);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    page.on('pageerror', (err) => console.error('[page!]', err.message));
    page.on('console', (msg) => {
      const t = msg.type();
      // Filter to interesting levels; harness is chatty with debug/info.
      if (t === 'error' || t === 'warning' || t === 'warn') {
        console.log(`[page.${t}]`, msg.text().slice(0, 400));
      }
    });
    page.on('requestfailed', (req) =>
      console.log('[page.reqfail]', req.url(), req.failure()?.errorText),
    );

    const url = BASE_URL + RUNNER_PATH;
    console.log(`[regen] Navigating: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    console.log(`[regen] Polling for runFinishedAt (timeout ${RUN_TIMEOUT_MS}ms)…`);
    const pollStart = Date.now();
    let finishedAt = null;
    while (Date.now() - pollStart < RUN_TIMEOUT_MS) {
      const snapshot = await page.evaluate(() => {
        const r = window.__SHARC_HARNESS_RESULTS__;
        if (!r) return { present: false };
        return {
          present: true,
          runId: r.runId,
          runFinishedAt: r.runFinishedAt,
          totals: r.totals,
          suiteCount: r.suites ? Object.keys(r.suites).length : 0,
        };
      });
      if (snapshot.runFinishedAt) {
        finishedAt = snapshot.runFinishedAt;
        console.log(`[regen] runFinishedAt=${finishedAt}`);
        break;
      }
      console.log(
        `[regen] t+${((Date.now() - pollStart) / 1000).toFixed(0)}s: ` +
          `present=${snapshot.present} runId=${snapshot.runId || 'none'} ` +
          `suites=${snapshot.suiteCount} totals=${JSON.stringify(snapshot.totals || {})}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!finishedAt) {
      throw new Error(
        `Timed out after ${RUN_TIMEOUT_MS}ms waiting for runFinishedAt`,
      );
    }

    const results = await page.evaluate(() =>
      JSON.parse(JSON.stringify(window.__SHARC_HARNESS_RESULTS__)),
    );

    const capturedAt = results.capturedAt || new Date().toISOString();
    const tsSafe = capturedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
    const outFile = path.join(
      baselineDir,
      `sharc-mraid3-baseline-${tsSafe}.json`,
    );
    writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n', 'utf8');
    console.log(`\n[regen] Wrote baseline: ${path.relative(repoRoot, outFile)}`);

    const stale = readdirSync(baselineDir).filter(
      (f) =>
        /^sharc-mraid3-baseline-.*\.json$/.test(f) &&
        f !== path.basename(outFile),
    );
    for (const f of stale) {
      unlinkSync(path.join(baselineDir, f));
      console.log(`[regen] Removed stale baseline: ${f}`);
    }

    console.log('\n[regen] Run summary:');
    console.log('  sharcVersion :', results.sharcVersion);
    console.log('  runId        :', results.runId);
    console.log('  capturedAt   :', results.capturedAt);
    console.log('  runFinishedAt:', results.runFinishedAt);
    console.log('  totals       :', results.totals);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('[regen] FAILED:', err);
  process.exit(1);
});
