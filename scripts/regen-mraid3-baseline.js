#!/usr/bin/env node
// Regenerate the MRAID 3.0 compliance baseline by running the in-browser
// compliance runner in headless Chrome and persisting the resulting
// `window.__SHARC_HARNESS_RESULTS__` as a timestamped baseline JSON.
//
// Usage:
//   node scripts/regen-mraid3-baseline.js [--dry-run] [--keep N] [--diagnose]
//   PORT=8765 CHROME_PATH=/path/to/chrome node scripts/regen-mraid3-baseline.js
//
// Flags:
//   --dry-run     Run the harness, write the new baseline, then ALSO list
//                 (but do not delete) baselines that pruning would remove.
//   --keep N      Number of most-recent baselines to retain (default 3).
//                 Pruning is conservative: a candidate file is only deleted
//                 if it parses as JSON, has a `schemaVersion` >= 1, and lives
//                 in examples/test/ matching the strict glob pattern.
//   --diagnose    Append ?diagnose=1 to the runner URL so each protocolTrace
//                 entry carries a relative `t` (ms since suite start) and each
//                 suite carries `diagnosticEvents[]` lifecycle milestones.
//                 After the run, prints a per-suite latency report (handshake,
//                 first-message gap, longest inter-message gap) to stdout.
//                 Diagnostic data also lands in the written baseline JSON; that
//                 file is NOT a candidate for committing — diagnose runs are
//                 for analysis only. Used to localise issue #20.
//
// Environment:
//   PORT                   Dev server port (default 8765, must match server.cjs).
//   CHROME_PATH            Override Chrome executable path (cross-platform).
//   CHROME_EXECUTABLE_PATH Legacy alias for CHROME_PATH.
//
// Cleanup contract:
//   The spawned dev server is killed via SIGTERM in normal exit AND on
//   SIGINT/SIGTERM/uncaughtException/unhandledRejection. A hard `kill -9` of
//   this script is the only path that can leave the server orphaned.
//
// Sandbox note:
//   Chrome is launched with `--no-sandbox` because (a) this script is a
//   localhost-only dev tool, (b) the only content loaded is the repo's own
//   compliance harness from a fixed http://localhost URL, and (c) running as
//   the developer's UID inside the sandbox occasionally trips macOS quarantine.
//   Do NOT remove this comment without also re-evaluating the trust boundary —
//   if this script is ever repurposed to run hostile or untrusted content,
//   `--no-sandbox` MUST be removed.

import { spawn } from 'node:child_process';
import {
  writeFileSync,
  readdirSync,
  unlinkSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const baselineDir = path.join(repoRoot, 'examples', 'test');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DIAGNOSE = args.includes('--diagnose');
const KEEP = (() => {
  const i = args.indexOf('--keep');
  if (i >= 0 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 3;
})();

// The dev server port is configured via PORT env (default 8765). server.cjs
// honors the same env, so PORT=N flows through both ends consistently.
// Validated as a positive integer below — Node's listen() silently picks a
// random port for NaN/0, which would produce a confusing connect-refused.
function parsePort(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `Invalid PORT='${raw}' — must be a positive integer in 1..65535.`,
    );
  }
  return n;
}
const SERVER_PORT = parsePort(process.env.PORT, 8765);
const BASE_URL = `http://localhost:${SERVER_PORT}`;
const RUNNER_PATH =
  '/examples/test/mraid-3-compliance-runner.html?autorun=1' +
  (DIAGNOSE ? '&diagnose=1' : '');
const RUN_TIMEOUT_MS = 5 * 60_000;
const EXPECTED_SCHEMA_VERSION = 3;

// Cross-platform Chrome resolution:
//   1. CHROME_PATH / CHROME_EXECUTABLE_PATH env (explicit override).
//   2. Common per-platform install paths (best-effort, not exhaustive).
//   3. Hard error with actionable message — we deliberately do NOT silently
//      pick a binary the user did not opt into.
function resolveChromePath() {
  const fromEnv = process.env.CHROME_PATH || process.env.CHROME_EXECUTABLE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `CHROME_PATH=${fromEnv} does not exist. Set it to a valid Chrome/Chromium binary.`,
      );
    }
    return fromEnv;
  }
  const candidates =
    process.platform === 'darwin'
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
          '/snap/bin/chromium',
        ]
      : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate a Chrome/Chromium binary on platform=${process.platform}. ` +
      `Set CHROME_PATH=/full/path/to/chrome and re-run.`,
  );
}

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

// Conservative pruning: only delete files that
//   1. live in baselineDir,
//   2. match the strict baseline filename pattern,
//   3. parse as JSON,
//   4. carry a `schemaVersion` (>=1) — anything else is left alone.
// Keeps the `keep` most-recent files by mtime; never deletes the file we just
// wrote (passed as `protect`). With `dryRun=true`, candidates are listed but
// not unlinked.
function pruneBaselines({ keep, protect, dryRun }) {
  const pattern = /^sharc-mraid3-baseline-.*\.json$/;
  const all = readdirSync(baselineDir)
    .filter((f) => pattern.test(f))
    .map((f) => {
      const full = path.join(baselineDir, f);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { name: f, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  const toKeep = new Set(all.slice(0, keep).map((x) => x.full));
  toKeep.add(protect);

  for (const entry of all) {
    if (toKeep.has(entry.full)) continue;
    // Validate before destruction.
    let safe = false;
    try {
      const raw = readFileSync(entry.full, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.schemaVersion === 'number' && parsed.schemaVersion >= 1) {
        safe = true;
      }
    } catch {
      /* not parseable — leave it alone, surface as warning */
    }
    if (!safe) {
      console.warn(
        `[regen] Skipping prune of ${entry.name}: not a recognized baseline ` +
          `(missing/invalid schemaVersion). Inspect manually.`,
      );
      continue;
    }
    if (dryRun) {
      console.log(`[regen][dry-run] Would prune: ${entry.name}`);
    } else {
      unlinkSync(entry.full);
      console.log(`[regen] Pruned: ${entry.name}`);
    }
  }
}

// Per-suite latency report. Prints lifecycle milestones from
// suite.diagnosticEvents and a per-message gap analysis from suite.protocolTrace
// (where each entry carries a relative `t` ms field under --diagnose). The goal
// is to localise hotspots (e.g. issue #20: vendor compliance ad's hardcoded 3s
// timeout cascading from a slow first round-trip).
function printDiagnosticReport(results) {
  console.log('\n[regen][diagnose] Per-suite latency report');
  console.log('  (gaps in ms; entries with t==undefined are pre-diagnose runs)');
  for (const slug of Object.keys(results.suites || {})) {
    const suite = results.suites[slug];
    console.log(`\n  ── ${slug} (verdict=${suite.verdict}) ──`);
    const events = suite.diagnosticEvents || [];
    if (events.length === 0) {
      console.log('    no diagnosticEvents — runner may not have ?diagnose=1');
    } else {
      for (const ev of events) {
        console.log(
          `    @${String(ev.t).padStart(6)}ms  ${ev.kind}` +
            (ev.detail ? `  ${ev.detail}` : ''),
        );
      }
    }
    const trace = (suite.protocolTrace || []).filter((e) => typeof e.t === 'number');
    if (trace.length === 0) continue;
    let prev = null;
    let maxGap = { gap: 0, idx: -1, type: '?' };
    console.log('    protocol trace (gap from previous → type):');
    for (let i = 0; i < trace.length; i++) {
      const e = trace[i];
      const gap = prev == null ? 0 : e.t - prev;
      if (gap > maxGap.gap) maxGap = { gap, idx: i, type: e.type };
      const arrow = e.dir === 'received' ? '<-' : '->';
      console.log(
        `    @${String(e.t).padStart(6)}ms  +${String(gap).padStart(5)}ms ${arrow} ${e.type}`,
      );
      prev = e.t;
    }
    if (maxGap.idx >= 0) {
      console.log(
        `    longest gap: ${maxGap.gap}ms before ${maxGap.type} (entry #${maxGap.idx})`,
      );
    }
  }
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

  // Crash-proof cleanup. `finally` does not run on SIGINT/SIGTERM/SIGHUP and
  // an uncaught exception in puppeteer's worker can also bypass it. We install
  // signal + crash handlers that hard-kill the spawned server before exiting.
  // Idempotent — multiple paths can call cleanup() safely.
  let cleaned = false;
  function cleanup(reason, code) {
    if (cleaned) return;
    cleaned = true;
    if (reason) console.warn(`[regen] cleanup (${reason})`);
    try {
      if (!server.killed) server.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (typeof code === 'number') process.exit(code);
  }
  process.on('SIGINT', () => cleanup('SIGINT', 130));
  process.on('SIGTERM', () => cleanup('SIGTERM', 143));
  process.on('SIGHUP', () => cleanup('SIGHUP', 129));
  process.on('uncaughtException', (err) => {
    console.error('[regen] uncaughtException:', err);
    cleanup('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[regen] unhandledRejection:', err);
    cleanup('unhandledRejection', 1);
  });

  let browser;
  try {
    await waitForServer(BASE_URL + '/', 10_000);

    const chromePath = resolveChromePath();
    console.log(`[regen] Launching headless Chrome: ${chromePath}`);
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      // See sandbox note in the file header. Localhost-only dev tool loading
      // first-party content; --no-sandbox is intentional and bounded.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    // Headless default viewport is 800×600, which clips MRAID compliance tests
    // that anchor at y≈357 and resize to 320×480 (357+480=837 > 600). The
    // container correctly rejects these as offscreen, but the rejection looks
    // identical to a real bug in trace data. Use a viewport big enough that
    // legitimate placements always fit; real-page rendering uses the full
    // browser viewport, so this matches that reality more closely than 800×600.
    await page.setViewport({ width: 1280, height: 1024 });
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

    // Schema version guard. If the runner is older than this script (or vice
    // versa), the artifact shape will not match what downstream consumers
    // expect. Fail loud rather than silently writing a malformed baseline.
    if (results.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
      throw new Error(
        `Baseline schema mismatch: runner produced schemaVersion=${results.schemaVersion}, ` +
          `script expects ${EXPECTED_SCHEMA_VERSION}. Update the runner or the script ` +
          `together — drift between them produces incompatible baselines.`,
      );
    }

    const capturedAt = results.capturedAt || new Date().toISOString();
    const tsSafe = capturedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
    const outFile = path.join(
      baselineDir,
      `sharc-mraid3-baseline-${tsSafe}.json`,
    );
    writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n', 'utf8');
    console.log(`\n[regen] Wrote baseline: ${path.relative(repoRoot, outFile)}`);

    pruneBaselines({ keep: KEEP, protect: outFile, dryRun: DRY_RUN });

    console.log('\n[regen] Run summary:');
    console.log('  schemaVersion:', results.schemaVersion);
    console.log('  sharcVersion :', results.sharcVersion);
    console.log('  runId        :', results.runId);
    console.log('  capturedAt   :', results.capturedAt);
    console.log('  runFinishedAt:', results.runFinishedAt);
    console.log('  totals       :', results.totals);

    if (DIAGNOSE) {
      printDiagnosticReport(results);
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    cleanup('normal-exit');
  }
}

main().catch((err) => {
  console.error('[regen] FAILED:', err);
  process.exit(1);
});
