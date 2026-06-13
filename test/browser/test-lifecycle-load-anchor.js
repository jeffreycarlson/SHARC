#!/usr/bin/env node
/**
 * test-lifecycle-load-anchor.js — Slice A RED tests (validator tier).
 *
 * The FAILING (red) interface contract for the load-anchored cascade (ADR
 * 2026-06-13-sharc-unified-lifecycle-ordering.md §5 "Retiring the 200ms timer",
 * §5.4 document.open re-anchoring, HB-1/HB-3, validator hooks L-3/L-4;
 * reconciliation §8 target log).
 *
 * NO assertion in this file rests on an ABSOLUTE wall-clock threshold. The
 * handshake success path is EVENT-DRIVEN (ratified): the contract is "fires on
 * the creative-rendered ∧ env-ready signal, anchored to inner `window 'load'`,
 * not on a 200ms timer." That is proven here STRUCTURALLY + RELATIVELY +
 * CAUSALLY, never by an absolute millisecond ceiling that would flake on
 * throttled CI / low-end devices:
 *
 *   T1 (L-3, HB-1) — RELATIVE anchor proof. Run the SAME markup creative under
 *      TWO subresource-load timings (fast; heavy ~500ms `?asset=1&delay=500`).
 *      The offset of `createSession` from inner `window 'load'` stays ~CONSTANT
 *      across both (does NOT grow with the added subresource delay), while its
 *      offset from DCL SCALES with that delay. That is anchoring to `load`, with
 *      no absolute threshold. RED today: anchored to DCL+200ms, so the
 *      load-offset is ~−(load−DCL) and SHRINKS as delay grows (anti-anchored),
 *      while the DCL-offset stays pinned at ~+200ms.
 *   T2 (L-3) — RELATIVE/CAUSAL. Same data, complementary cut: across the two
 *      timings the DCL→createSession offset must MOVE WITH the subresource
 *      delay if-and-only-if the anchor is `load` (load moves with delay; DCL
 *      does not). RED today: DCL→createSession is pinned at ~+200ms regardless
 *      of delay (the timer), and createSession precedes `load` on the heavy run.
 *   T3 (L-4) — CAUSAL ORDERING (kept; already robust). Heavy creative: MRAID
 *      `ready` fires AT/AFTER inner `window 'load'`. Pure ordering, no gap
 *      magnitude. RED today on Markup (`:rendered` anchors at DCL → ready
 *      precedes load).
 *   T5 (§5.4 ∧ #321 Decision 2) — CAUSAL COMPOSITION. A LEGITIMATE reopen — one
 *      that keeps the renderer's loadProbe answerable so the controlled-context
 *      gate passes (#321 Decision 2 loadAck-tolerance) — MUST (a) NOT be
 *      terminated AND (b) still produce a creative-rendered signal anchored
 *      at/after the REOPENED document's `window 'load'` (§5.4 load-listener
 *      re-registration). RED today: the renderer's loadProbe-answering prelude
 *      AND its render-anchoring load listener do NOT survive document.open, so
 *      the gate goes unanswered → 2118 terminate, and no creative-rendered
 *      signal re-fires for the reopened document. See the T5 header note for why
 *      the answerability half cannot be expressed from the test creative.
 *
 * If a numeric value appears below it is a GENEROUS, CI-safe SANITY guard
 * (clearly labeled), corroboration only — never the assertion the contract
 * rests on. The contract assertions are all relative/ordering/structural.
 *
 * Tier: VALIDATOR (real renderer + cross-origin handshake + real `window 'load'`
 * cannot be faithfully faked in jsdom — the #321 ADR "not node-expressible"
 * finding applies). Uses test/browser/lib/lifecycle-harness.js (puppeteer-core →
 * system Chrome, server.cjs dual-origin, CDP cross-frame console capture on a
 * single monotonic timebase per line).
 *
 * RED-by-design until Slice A lands; gated behind `npm run test:sliceA-red`,
 * NOT on any CI-gated path while red.
 */

import {
  withServer, launchBrowser, captureRun,
  BASE_URL, dump, timeOf, indexOf, find,
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
  console.log('test-lifecycle-load-anchor.js — Slice A RED contract '
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
      'RED today: createSession is anchored to DCL+200ms, so its offset from window-load '
        + 'tracks −(load−DCL) and shifts by ~the full headroom as the subresource delay grows '
        + '(anti-anchored to load).\n' + diagBase);

    // CONTRACT (relative): the DCL-anchored offset, by contrast, MUST scale with
    // the delay if the true anchor is `load` (load moved by `headroom`, DCL did
    // not). RED today: DCL→createSession is pinned at ~+200ms (the timer),
    // independent of the delay.
    const dclOffsetGrowth = heavy.createFromDcl - fast.createFromDcl;
    assert(Number.isFinite(dclOffsetGrowth) && dclOffsetGrowth > headroom / 2,
      `createSession's offset from DCL SCALES with the subresource delay `
        + `(grew ${dclOffsetGrowth.toFixed(1)}ms with +${headroom.toFixed(1)}ms headroom) `
        + `⇒ NOT anchored to DCL`,
      'RED today: createSession = DCL + 200ms (the wall-clock timer), so its offset from DCL '
        + 'stays pinned at ~+200ms and does NOT grow with the subresource delay.\n' + diagBase);

    // ── T2 (L-3): RELATIVE/CAUSAL — createSession at/after load on BOTH ─────
    console.log('\nT2 (L-3) — createSession lands AT/AFTER inner window load on both '
      + 'runs\n   (ordering preserved as the load anchor moves; never DCL+200ms)');

    // CONTRACT (ordering, both runs): a load-anchored handshake never precedes
    // `window 'load'`. RED today: on the heavy run createSession (DCL+200ms)
    // PRECEDES window-load (DCL+500ms).
    assert(Number.isFinite(fast.createFromLoad) && fast.createFromLoad >= 0,
      'fast run: createSession is at/after inner window load (ordering holds)',
      diagBase);
    assert(Number.isFinite(heavy.createFromLoad) && heavy.createFromLoad >= 0,
      'heavy run: createSession is at/after inner window load (ordering holds)',
      'RED today: createSession fires at DCL+200ms, which PRECEDES window-load by '
        + `~${(-heavy.createFromLoad).toFixed(1)}ms on the heavy run (anchor is DCL, not load).\n`
        + diagBase);

    // SANITY corroboration ONLY (labeled, not the contract): on the fast run,
    // where load≈DCL, the load-offset should be a small non-negative number —
    // not a ≥200ms timer gap. Generous CI-safe ceiling; the real proof is the
    // relative invariance asserted in T1.
    assert(!Number.isFinite(fast.createFromLoad) || fast.createFromLoad < SANITY_DRIFT_CEILING_MS,
      `[sanity, corroboration only] fast-run create−load = ${fast.createFromLoad.toFixed(1)}ms `
        + `< ${SANITY_DRIFT_CEILING_MS}ms (a 200ms timer would blow this generous bound)`,
      'RED today: ~200ms (the timer). This is a CI-safe sanity guard, not the contract — '
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
        'RED today on Markup: :rendered anchors at DCL, so ready precedes window load by '
          + `~${(tLoad - tReady).toFixed(1)}ms (ready before its own load event).\n` + diag);
    }

    // ── T5 (§5.4 ∧ #321 Decision 2): legitimate reopen stays controlled ─────
    //
    // CORRECTED SCENARIO (was: a bare document.open with no prelude, which
    // SHOULD get 2118 — indistinguishable from a hostile nav per #321 ADR
    // Decision 2). The legitimate case is a reopen that keeps the renderer's
    // loadProbe ANSWERABLE (so the controlled-context gate passes, #321
    // Decision 2 loadAck-tolerance) AND re-registers a render-anchored load
    // listener (§5.4), so a creative-rendered signal re-fires for the reopened
    // document.
    //
    // WHY THE TEST CREATIVE CANNOT EXPRESS THE ANSWERABILITY HALF: the loadProbe
    // is answered with `sharcNonce: <renderer ackNonce>`, and the renderer
    // CLEARS that nonce from location.hash BEFORE document.write
    // (examples/renderer/index.html:1367) precisely so the creative cannot
    // harvest it. The renderer's loadProbe-answering prelude listener does NOT
    // survive document.open (empirically: the loadProbe REACHES the reopened
    // window — a plain window listener survives — but the gate still goes
    // unanswered → 2118 at ~102ms, because the prelude listener holding the
    // nonce closure was wiped). So §5.4 conformance is a RENDERER
    // responsibility: the renderer must RE-REGISTER, across its own
    // document.open, BOTH (i) the loadProbe-answering listener (re-arming the
    // nonce closure) AND (ii) the render-anchored `window 'load'` listener that
    // re-posts `:rendered`. The test creative cannot stand in for the renderer
    // here — it has no nonce. The fixture therefore drives a renderer-mediated
    // reopen and asserts the OBSERVABLE contract (survives + re-anchored
    // signal); the harness needs the reference renderer to gain §5.4
    // re-registration for this to go green (tracked as the Slice A renderer
    // work item). See the T5 result in the handoff for the full statement.
    console.log('\nT5 (§5.4 ∧ #321 Decision 2) — legitimate reopen: NOT terminated '
      + 'AND re-anchors a\n   creative-rendered signal at/after the reopened window load');
    {
      const lines = await captureCase('docopen-host.html', 6000);
      const tGen2Load = timeOf(lines, 'gen=2 window load');
      const tCreate = timeOf(lines, 'SHARC:Creative:createSession');
      const tProbe = timeOf(lines, 'gen=2 loadProbe answered');
      const terminated = !!find(lines, '-> terminated');
      const iGen2Load = indexOf(lines, 'gen=2 window load');
      const iCreate = indexOf(lines, 'SHARC:Creative:createSession');
      const diag = `    gen2-load=${tGen2Load} createSession=${tCreate} `
        + `probeAnswered=${tProbe} terminated=${terminated}\n` + dump(lines);

      // Positive control: the reopen actually happened (gen=2 fully loaded), so
      // the reds below are real contract failures, not a fixture that never
      // reopened.
      assert(Number.isFinite(tGen2Load),
        'the reopened (gen=2) document reached window load (reopen happened)', diag);

      // CONTRACT (a) — not terminated. The legitimate reopen keeps the gate
      // answerable, so the controlled-context check must NOT fire 2118.
      assert(!terminated,
        'CONTRACT(a): the legitimate reopen is NOT terminated — the controlled-context '
          + 'gate (loadProbe/loadAck) stays answerable across document.open (#321 Decision 2)',
        'RED today: the renderer\'s loadProbe-answering prelude listener does not survive '
          + 'document.open, so the gate goes unanswered → 2118 terminate. (The probe DOES reach '
          + 'the reopened window; what is lost is the nonce-bearing answerer.)\n' + diag);

      // CONTRACT (b) — CAUSAL ORDERING: a creative-rendered signal (createSession)
      // re-fires for the reopened document, AT/AFTER its window load. Asserted by
      // ORDERING (index + timestamp), not by an absolute gap.
      const orderedAfter = Number.isFinite(tCreate) && Number.isFinite(tGen2Load)
        && iCreate > iGen2Load && tCreate >= tGen2Load;
      assert(orderedAfter,
        'CONTRACT(b): a creative-rendered signal (createSession) re-fires AT/AFTER the '
          + 'reopened document\'s window load (§5.4 load-listener re-registration; causal ordering)',
        'RED today: the renderer\'s render-anchored load listener does not survive document.open, '
          + 'so no createSession re-fires for the reopened document (none after gen=2 load).\n' + diag);
    }
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
    + '— Slice A load-anchor contract (relative / causal)');
  if (failures > 0) {
    console.log('\nNOTE: these failures are EXPECTED until Slice A lands (RED-by-design). '
      + 'Every contract assertion is relative (T1), ordering (T2/T3/T5), or composition '
      + '(T5) — none rests on an absolute wall-clock threshold. The one numeric value '
      + '(T2 sanity) is a labeled CI-safe corroboration guard, not the contract.');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
