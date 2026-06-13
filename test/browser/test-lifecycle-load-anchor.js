#!/usr/bin/env node
/**
 * test-lifecycle-load-anchor.js — Slice A RED tests (validator tier).
 *
 * The FAILING (red) interface contract for the load-anchored cascade
 * (ADR 2026-06-13-sharc-unified-lifecycle-ordering.md §5 "Retiring the 200ms
 * timer", HB-1/HB-3, validator hooks L-3/L-4; reconciliation §8 target log).
 *
 * THESE TESTS ARE EXPECTED TO FAIL against current behavior. They express the
 * post-Slice-A target and fail for the RIGHT reason: the two `setTimeout(…,200)`
 * handshake timers (sharc-container.js:2204 URL / :3365 Markup) and the renderer
 * posting `:rendered` at inner DOMContentLoaded instead of inner `window 'load'`
 * (examples/renderer/index.html:1736/1744) are still present. They go GREEN in
 * the develop step that lands Slice A; do NOT add them to a CI-gated path while
 * red (gated behind `npm run test:sliceA-red`).
 *
 * Tier: VALIDATOR (real renderer + cross-origin handshake + real `window 'load'`
 * cannot be faithfully faked in jsdom — the #321 ADR "not node-expressible"
 * finding applies). Uses the productionized harness (test/browser/lib/
 * lifecycle-harness.js): puppeteer-core → system Chrome, server.cjs dual-origin,
 * CDP cross-frame console capture with a single monotonic timebase per line.
 *
 * Contract under test:
 *   T1 (L-3, HB-1/HB-3) — handshake on the load anchor, not a timer. BOTH the
 *      URL and Markup paths: t[createSession] − t[window 'load'] < 50ms. RED
 *      today (~200ms timer gap).
 *   T2 — Markup `:rendered` anchored to inner `window 'load'`, not DCL. The
 *      handshake (createSession) is anchored at/after inner `window 'load'`,
 *      not at DOMContentLoaded. RED today (renderer posts at DCL).
 *   T3 (L-4) — heavy-creative edge. A creative whose `window 'load'` lags its
 *      DOMContentLoaded by >200ms ⇒ `ready` still fires AFTER `window 'load'`.
 *      RED today on the Markup path (DCL+200ms precedes window load).
 *   T5 (§5.4) — document.open-safe load listener. A creative that
 *      document.open()/write()/close()s its own document MUST still produce a
 *      creative-rendered signal anchored at/after the REOPENED document's
 *      `window 'load'` (handshake completes). RED today (gen=1 DCL listener is
 *      wiped by document.open AND the post-render nav backstop fires).
 */

import {
  captureHost, withServer, launchBrowser, captureRun,
  BASE_URL, dump, timeOf, indexOf, find,
} from './lib/lifecycle-harness.js';

const GAP_THRESHOLD_MS = 50; // §8: 200ms timer guaranteed ≥200ms; target sub-tick.

let failures = 0;
function assert(cond, message, diag) {
  if (cond) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    if (diag) console.error(diag);
    failures++;
  }
}

const url = (p) => `${BASE_URL}/test/browser/fixtures/lifecycle/${p}`;

// ── T1 + T2 + T3: one capture per path/weight, multiple assertions ─────────
async function captureCase(hostPath, captureMs) {
  const browser = await launchBrowser();
  try {
    return await captureRun(browser, url(hostPath), { captureMs });
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('test-lifecycle-load-anchor.js — Slice A RED contract (validator tier)\n');

  await withServer(async () => {
    // ── T1 (L-3): handshake on the load anchor, not a timer — BOTH paths ──
    console.log('T1 (L-3 / HB-1) — createSession fires within '
      + GAP_THRESHOLD_MS + 'ms of inner window load (not +200ms)');

    for (const [label, hostPath, ms] of [
      ['URL path',    'url-host.html',    4000],
      ['Markup path', 'markup-host.html', 5000],
    ]) {
      const lines = await captureCase(hostPath, ms);
      const tLoad = timeOf(lines, 'window load');
      const tCreate = timeOf(lines, 'SHARC:Creative:createSession');
      const diag = `    [${label}] window-load=${tLoad} createSession=${tCreate}\n` + dump(lines);

      assert(Number.isFinite(tLoad) && Number.isFinite(tCreate),
        `[${label}] both window-load and createSession were captured`, diag);

      const gap = tCreate - tLoad;
      assert(gap >= 0 && gap < GAP_THRESHOLD_MS,
        `[${label}] gap(createSession − window-load) = ${gap.toFixed(1)}ms < ${GAP_THRESHOLD_MS}ms `
          + `(RED today: the 200ms initChannel timer makes this ~200ms)`,
        diag);
    }

    // ── T2: Markup :rendered anchored to inner window load, not DCL ───────
    console.log('\nT2 — Markup createSession anchored at/after inner window load (not DCL)');
    {
      const lines = await captureCase('markup-host.html', 5000);
      const tDCL = timeOf(lines, 'DOMContentLoaded');
      const tLoad = timeOf(lines, 'window load');
      const tCreate = timeOf(lines, 'SHARC:Creative:createSession');
      const diag = `    DCL=${tDCL} window-load=${tLoad} createSession=${tCreate}\n` + dump(lines);

      // Direct anchor proof: the renderer's :rendered (hence createSession)
      // should be triggered by window 'load', so createSession − DCL should be
      // ≥ (window-load − DCL). On a LIGHT creative DCL≈load so this is weak;
      // the decisive proof is T3 (heavy). Here we assert the gap to window-load
      // is sub-threshold, which is only possible if the anchor IS window load
      // and the timer is gone. RED today (createSession = DCL + 200ms).
      assert(Number.isFinite(tCreate) && Number.isFinite(tLoad)
        && (tCreate - tLoad) >= 0 && (tCreate - tLoad) < GAP_THRESHOLD_MS,
        `Markup createSession is within ${GAP_THRESHOLD_MS}ms of window-load `
          + `(anchor = window load, not DCL+200ms). gap=${(tCreate - tLoad).toFixed(1)}ms`,
        diag);
    }

    // ── T3 (L-4): heavy-creative edge — ready never precedes window load ──
    console.log('\nT3 (L-4) — heavy creative (window load lags DCL >200ms): ready fires AFTER window load');
    {
      // asset=1 slow image @ 500ms ⇒ window 'load' lags DCL by ~500ms (>200ms).
      const lines = await captureCase('markup-host.html?asset=1&delay=500', 6000);
      const tDCL = timeOf(lines, 'DOMContentLoaded');
      const tLoad = timeOf(lines, 'window load');
      const tReady = timeOf(lines, 'mraid event: ready');
      const diag = `    DCL=${tDCL} window-load=${tLoad} ready=${tReady} `
        + `(load−DCL=${(tLoad - tDCL).toFixed(1)}ms)\n` + dump(lines);

      assert(Number.isFinite(tLoad) && Number.isFinite(tDCL) && (tLoad - tDCL) > 200,
        `fixture is genuinely heavy: window-load lags DCL by >200ms `
          + `(actual ${(tLoad - tDCL).toFixed(1)}ms)`,
        diag);

      assert(Number.isFinite(tReady) && Number.isFinite(tLoad) && tReady >= tLoad,
        `MRAID ready fires AT/AFTER inner window load `
          + `(RED today on Markup: :rendered anchors at DCL, so ready precedes window load by ~${(tLoad - tReady).toFixed(1)}ms)`,
        diag);
    }

    // ── T5 (§5.4): document.open-safe creative-rendered signal ────────────
    console.log('\nT5 (§5.4) — document.open()-reopening creative still produces a creative-rendered signal');
    {
      const lines = await captureCase('docopen-host.html', 6000);
      const tGen2Load = timeOf(lines, 'gen=2 window load');
      const tCreate = timeOf(lines, 'SHARC:Creative:createSession');
      const terminated = !!find(lines, '-> terminated');
      const diag = `    gen2-load=${tGen2Load} createSession=${tCreate} terminated=${terminated}\n`
        + dump(lines);

      // Sanity: the reopen actually happened (gen=2 document fully loaded).
      assert(Number.isFinite(tGen2Load),
        'the reopened (gen=2) document reached window load (reopen happened)', diag);

      // CONTRACT: a creative-rendered signal (createSession handshake) must
      // still fire, anchored at/after the reopened document's window load.
      // RED today: the gen=1 DCL listener is wiped by document.open AND the
      // post-render navigation backstop (error 2118) terminates the session,
      // so the handshake never completes for the reopened document.
      assert(!terminated,
        'session is NOT terminated by the reopen '
          + '(RED today: document.open trips the post-render nav backstop, error 2118)',
        diag);
      assert(Number.isFinite(tCreate) && Number.isFinite(tGen2Load) && tCreate >= tGen2Load,
        'createSession (creative-rendered) fires at/after the reopened document window load '
          + '(RED today: no creative-rendered signal survives the reopen)',
        diag);
    }
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
    + '— Slice A load-anchor contract');
  if (failures > 0) {
    console.log('\nNOTE: these failures are EXPECTED until Slice A lands (RED-by-design). '
      + 'They assert the load-anchored cascade contract against current timer/DCL behavior.');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
