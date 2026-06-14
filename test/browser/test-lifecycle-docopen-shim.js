#!/usr/bin/env node
/**
 * test-lifecycle-docopen-shim.js — Slice A T5 RED test (validator tier).
 *
 * The FAILING (red) interface contract for the document.open re-injection shim
 * (ADR 2026-06-13-sharc-unified-lifecycle-ordering.md §5.4 ∧ #321 Decision 2).
 * This is the SEPARATE next pass after the load-anchored cascade (T1–T4) lands;
 * it is kept RED-gated behind `npm run test:sliceA-red` and is NOT on any
 * CI-gated path while red.
 *
 * T5 (§5.4 ∧ #321 Decision 2) — CAUSAL COMPOSITION. A LEGITIMATE reopen — one
 * that keeps the renderer's loadProbe answerable so the controlled-context gate
 * passes (#321 Decision 2 loadAck-tolerance) — MUST (a) NOT be terminated AND
 * (b) still produce a creative-rendered signal anchored at/after the REOPENED
 * document's `window 'load'` (§5.4 load-listener re-registration). RED today:
 * the renderer's loadProbe-answering prelude AND its render-anchoring load
 * listener do NOT survive document.open, so the gate goes unanswered → 2118
 * terminate, and no creative-rendered signal re-fires for the reopened
 * document.
 *
 * WHY THE TEST CREATIVE CANNOT EXPRESS THE ANSWERABILITY HALF: the loadProbe is
 * answered with `sharcNonce: <renderer ackNonce>`, and the renderer CLEARS that
 * nonce from location.hash BEFORE document.write
 * (examples/renderer/index.html:1367) precisely so the creative cannot harvest
 * it. The renderer's loadProbe-answering prelude listener does NOT survive
 * document.open (empirically: the loadProbe REACHES the reopened window — a
 * plain window listener survives — but the gate still goes unanswered → 2118 at
 * ~102ms, because the prelude listener holding the nonce closure was wiped). So
 * §5.4 conformance is a RENDERER responsibility: the renderer must RE-REGISTER,
 * across its own document.open, BOTH (i) the loadProbe-answering listener
 * (re-arming the nonce closure) AND (ii) the render-anchored `window 'load'`
 * listener that re-posts `:rendered`. The test creative cannot stand in for the
 * renderer here — it has no nonce. The fixture therefore drives a
 * renderer-mediated reopen and asserts the OBSERVABLE contract (survives +
 * re-anchored signal); the harness needs the reference renderer to gain §5.4
 * re-registration for this to go green (tracked as the Slice A renderer
 * document.open-shim work item).
 *
 * NO assertion in this file rests on an ABSOLUTE wall-clock threshold — the
 * contract is asserted by ordering (index + timestamp) and composition, never
 * by an absolute millisecond ceiling that would flake on throttled CI.
 *
 * Tier: VALIDATOR (real renderer + cross-origin handshake + real document.open
 * cannot be faithfully faked in jsdom). Uses test/browser/lib/lifecycle-harness.js.
 *
 * RED-by-design until the document.open shim lands; gated behind
 * `npm run test:sliceA-red`, NOT on any CI-gated path while red.
 */

import {
  withServer, launchBrowser, captureRun,
  BASE_URL, dump, timeOf, indexOf, find,
} from './lib/lifecycle-harness.js';

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

async function main() {
  console.log('test-lifecycle-docopen-shim.js — Slice A T5 RED contract '
    + '(validator tier; causal composition — NO absolute wall-clock gate)\n');

  await withServer(async () => {
    // ── T5 (§5.4 ∧ #321 Decision 2): legitimate reopen stays controlled ─────
    console.log('T5 (§5.4 ∧ #321 Decision 2) — legitimate reopen: NOT terminated '
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
    + '— Slice A T5 document.open-shim contract (causal composition)');
  if (failures > 0) {
    console.log('\nNOTE: these failures are EXPECTED until the document.open re-injection '
      + 'shim lands (RED-by-design; the SEPARATE next pass after the load-anchored cascade). '
      + 'Every contract assertion is ordering (index + timestamp) or composition — none rests '
      + 'on an absolute wall-clock threshold.');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
