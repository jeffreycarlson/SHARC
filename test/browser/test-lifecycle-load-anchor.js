#!/usr/bin/env node
/**
 * test-lifecycle-load-anchor.js — Slice A T1–T3 tests (validator tier).
 *
 * The interface contract for the load-anchored cascade (ADR
 * 2026-06-13-sharc-unified-lifecycle-ordering.md §5 "Retiring the 200ms timer",
 * HB-1/HB-3, validator hooks L-3/L-4; reconciliation §8 target log). GREEN since
 * Slice A landed (200ms handshake timers retired for the `creative-rendered ∧
 * env-ready` conjunction; renderer `:rendered` re-anchored from DCL to inner
 * `window 'load'`). Now CI-gated via `npm run test:lifecycle-load-anchor` in
 * `test:all:built`. The document.open re-injection shim is the SEPARATE next
 * pass and lives in test-lifecycle-docopen-shim.js (T5, still RED-gated).
 *
 * NO assertion in this file rests on an ABSOLUTE wall-clock threshold. The
 * handshake success path is EVENT-DRIVEN (ratified): the contract is "fires on
 * the creative-rendered ∧ env-ready signal, anchored to inner `window 'load'`,
 * not on a 200ms timer." That is proven RELATIVELY + CAUSALLY, never by an
 * absolute millisecond ceiling that would flake on throttled CI / low-end
 * devices:
 *
 *   T1 (L-3, HB-1) — RELATIVE anchor proof. Run the SAME markup creative under
 *      TWO subresource-load timings (fast; heavy ~500ms `?asset=1&delay=500`).
 *      The offset of `createSession` from inner `window 'load'` stays ~CONSTANT
 *      across both (does NOT grow with the added subresource delay), while its
 *      offset from DCL SCALES with that delay. That is anchoring to `load`, with
 *      no absolute threshold. A DCL+200ms anchor would shrink the load-offset by
 *      ~the headroom as the delay grows (anti-anchored) — this guards against
 *      that regression.
 *   T2 (L-3) — RELATIVE/CAUSAL. Same data, complementary cut: across the two
 *      timings the DCL→createSession offset MOVES WITH the subresource delay
 *      (load moves with delay; DCL does not), and createSession lands at/after
 *      `window 'load'` on both runs.
 *   T3 (L-4) — CAUSAL ORDERING. Heavy creative: MRAID `ready` fires AT/AFTER
 *      inner `window 'load'`. Pure ordering, no gap magnitude.
 *
 * If a numeric value appears below it is a GENEROUS, CI-safe SANITY guard
 * (clearly labeled), corroboration only — never the assertion the contract
 * rests on. The contract assertions are all relative/ordering.
 *
 * Tier: VALIDATOR (real renderer + cross-origin handshake + real `window 'load'`
 * cannot be faithfully faked in jsdom — the #321 ADR "not node-expressible"
 * finding applies). Uses test/browser/lib/lifecycle-harness.js (puppeteer-core →
 * system Chrome, server.cjs dual-origin, CDP cross-frame console capture on a
 * single monotonic timebase per line).
 */

import {
  withServer, launchBrowser, captureRun,
  BASE_URL, dump, timeOf,
} from './lib/lifecycle-harness.js';

// CI-safe SANITY bound only (corroboration, NOT the contract). A real timer is
// ≥200ms; a real anchor-drift across runs is a handful of ms. We pick a bound
// generously between them purely to label "this offset did not balloon," never
// to assert the contract. The contract is the RELATIVE comparison below.
const SANITY_DRIFT_CEILING_MS = 150;

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

async function captureCase(hostPath, captureMs) {
  const browser = await launchBrowser();
  try {
    return await captureRun(browser, url(hostPath), { captureMs });
  } finally {
    await browser.close();
  }
}

/** Extract the three anchor timestamps + a heaviness measure from a capture. */
function offsets(lines) {
  const tDCL = timeOf(lines, 'DOMContentLoaded');
  const tLoad = timeOf(lines, 'window load');
  const tCreate = timeOf(lines, 'SHARC:Creative:createSession');
  return {
    tDCL, tLoad, tCreate,
    loadMinusDcl: tLoad - tDCL,            // subresource heaviness
    createFromLoad: tCreate - tLoad,       // offset from the LOAD anchor
    createFromDcl: tCreate - tDCL,         // offset from the DCL anchor
  };
}

async function main() {
  console.log('test-lifecycle-load-anchor.js — Slice A GREEN cascade '
    + '(validator tier; relative / causal — NO absolute wall-clock gate)\n');

  await withServer(async () => {
    // ── Capture the SAME markup creative under two subresource timings ──────
    // FAST: no slow subresources (load ≈ DCL).
    // HEAVY: one ~500ms slow subresource (load lags DCL by ~500ms).
    // The renderer port + `?asset/delay` route are wired in markup-host.html.
    const fast = offsets(await captureCase('markup-host.html', 5000));
    const heavyLines = await captureCase('markup-host.html?asset=1&delay=500', 6000);
    const heavy = offsets(heavyLines);

    const bothCaptured = [fast, heavy].every((o) =>
      Number.isFinite(o.tDCL) && Number.isFinite(o.tLoad) && Number.isFinite(o.tCreate));
    const diagBase =
      `    fast:  DCL→load=${fast.loadMinusDcl.toFixed(1)}ms  `
        + `create−load=${fast.createFromLoad.toFixed(1)}ms  create−DCL=${fast.createFromDcl.toFixed(1)}ms\n`
      + `    heavy: DCL→load=${heavy.loadMinusDcl.toFixed(1)}ms  `
        + `create−load=${heavy.createFromLoad.toFixed(1)}ms  create−DCL=${heavy.createFromDcl.toFixed(1)}ms`;

    // ── T1 (L-3 / HB-1): RELATIVE — anchored to LOAD, not DCL, not a clock ──
    console.log('T1 (L-3 / HB-1) — createSession offset from inner window load is '
      + 'INVARIANT to subresource delay\n   (anchored to load); offset from DCL SCALES '
      + 'with the delay');

    // Positive controls: both runs captured, and the heavy run is genuinely
    // heavier (subresource delay actually moved `load` away from `DCL`). These
    // guard the reds below from being harness/fixture failures.
    assert(bothCaptured,
      'both fast and heavy runs captured DCL, window-load, and createSession',
      diagBase + '\n--- heavy capture ---\n' + dump(heavyLines));
    const headroom = heavy.loadMinusDcl - fast.loadMinusDcl;
    assert(Number.isFinite(headroom) && headroom > 200,
      `the heavy run is genuinely heavier: DCL→load grew by ${headroom.toFixed(1)}ms `
        + `(>200ms) vs the fast run — the subresource delay really moved the load anchor`,
      diagBase);

    // CONTRACT (relative, no absolute threshold): the LOAD-anchored offset must
    // NOT grow when the subresource delay grows. If createSession is anchored to
    // `load`, create−load is ~constant across runs; if it is anchored to
    // DCL+timer, create−load SHRINKS by ~headroom (createSession lands at
    // DCL+200, which now precedes `load`). We assert the load-offset barely
    // moved relative to the injected headroom.
    const loadOffsetDrift = Math.abs(heavy.createFromLoad - fast.createFromLoad);
    assert(Number.isFinite(loadOffsetDrift) && loadOffsetDrift < headroom / 2,
      `createSession's offset from window-load is INVARIANT to the subresource delay `
        + `(drift ${loadOffsetDrift.toFixed(1)}ms ≪ injected headroom ${headroom.toFixed(1)}ms) `
        + `⇒ anchored to load`,
      'On regression: if createSession were anchored to DCL+200ms, its offset from window-load '
        + 'would track −(load−DCL) and shift by ~the full headroom as the subresource delay grows '
        + '(anti-anchored to load).\n' + diagBase);

    // CONTRACT (relative): the DCL-anchored offset, by contrast, MUST scale with
    // the delay if the true anchor is `load` (load moved by `headroom`, DCL did
    // not). On regression: a DCL+200ms anchor pins DCL→createSession at ~+200ms
    // (the timer), independent of the delay.
    const dclOffsetGrowth = heavy.createFromDcl - fast.createFromDcl;
    assert(Number.isFinite(dclOffsetGrowth) && dclOffsetGrowth > headroom / 2,
      `createSession's offset from DCL SCALES with the subresource delay `
        + `(grew ${dclOffsetGrowth.toFixed(1)}ms with +${headroom.toFixed(1)}ms headroom) `
        + `⇒ NOT anchored to DCL`,
      'On regression: createSession = DCL + 200ms (the wall-clock timer) would keep its offset '
        + 'from DCL pinned at ~+200ms, not growing with the subresource delay.\n' + diagBase);

    // ── T2 (L-3): RELATIVE/CAUSAL — createSession at/after load on BOTH ─────
    console.log('\nT2 (L-3) — createSession lands AT/AFTER inner window load on both '
      + 'runs\n   (ordering preserved as the load anchor moves; never DCL+200ms)');

    // CONTRACT (ordering, both runs): a load-anchored handshake never precedes
    // `window 'load'`. On regression: a DCL+200ms anchor would make createSession
    // PRECEDE window-load on the heavy run (DCL+200ms before DCL+500ms).
    assert(Number.isFinite(fast.createFromLoad) && fast.createFromLoad >= 0,
      'fast run: createSession is at/after inner window load (ordering holds)',
      diagBase);
    assert(Number.isFinite(heavy.createFromLoad) && heavy.createFromLoad >= 0,
      'heavy run: createSession is at/after inner window load (ordering holds)',
      'On regression: a DCL+200ms anchor fires createSession before window-load by '
        + `~${(-heavy.createFromLoad).toFixed(1)}ms on the heavy run (anchor is DCL, not load).\n`
        + diagBase);

    // SANITY corroboration ONLY (labeled, not the contract): on the fast run,
    // where load≈DCL, the load-offset should be a small non-negative number —
    // not a ≥200ms timer gap. Generous CI-safe ceiling; the real proof is the
    // relative invariance asserted in T1.
    assert(!Number.isFinite(fast.createFromLoad) || fast.createFromLoad < SANITY_DRIFT_CEILING_MS,
      `[sanity, corroboration only] fast-run create−load = ${fast.createFromLoad.toFixed(1)}ms `
        + `< ${SANITY_DRIFT_CEILING_MS}ms (a 200ms timer would blow this generous bound)`,
      'On regression: ~200ms (the timer). This is a CI-safe sanity guard, not the contract — '
        + 'the contract is the relative invariance in T1.\n' + diagBase);

    // ── T3 (L-4): CAUSAL ORDERING — ready never precedes window load ────────
    console.log('\nT3 (L-4) — heavy creative: MRAID ready fires AT/AFTER inner window '
      + 'load (pure ordering)');
    {
      const tLoad = heavy.tLoad;
      const tReady = timeOf(heavyLines, 'mraid event: ready');
      const diag = `    heavy: window-load=${tLoad} ready=${tReady} `
        + `(load−DCL=${heavy.loadMinusDcl.toFixed(1)}ms)\n` + dump(heavyLines);

      // Reuse the heaviness positive control implicitly (asserted in T1), then
      // assert the pure CAUSAL ORDERING — no gap magnitude anywhere.
      assert(Number.isFinite(tReady) && Number.isFinite(tLoad) && tReady >= tLoad,
        'MRAID ready fires AT/AFTER inner window load (causal ordering)',
        'Markup: :rendered anchored to inner window load — if this regresses to a DCL '
          + 'anchor, ready precedes window load by '
          + `~${(tLoad - tReady).toFixed(1)}ms (ready before its own load event).\n` + diag);
    }
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
    + '— Slice A load-anchor contract (relative / causal)');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
