#!/usr/bin/env node
/**
 * test-docopen-security-matrix.js — the SE-required C1–C6 security matrix for
 * the document.open self-rewrite shim (ADR 2026-06-13-document-open-shim-
 * mechanism.md). These are the conditions a Security Engineer review verifies.
 *
 * Validator tier (real renderer + real document.open in system Chrome — the
 * contract is not node-expressible; same limitation #321 records). Uses
 * test/browser/lib/lifecycle-harness.js.
 *
 * Matrix:
 *   C1 nonce-harvest    — post-reopen creative cannot recover ackNonce / OMID
 *                         protocolNonce from the re-injected harness DOM.
 *   C2 injection-race   — creative pollutes Array/Object/postMessage BEFORE the
 *                         harness; harness still completes (it runs FIRST and
 *                         closed over native globals).
 *   C3 real-navigation  — a real cross-document navigation after first render
 *                         still fires 2118 (the shim does not vouch for it).
 *   C4 rewrite-storm    — streaming writes (one cycle) + successive cycles stay
 *                         ALIVE (gate answered each load; #332 throttle, no
 *                         2118 termination).
 *   C5 un-shim          — delete/reassign document.open/write/close is defeated
 *                         (shim is non-configurable/non-writable); reopen still
 *                         intercepted + harness re-injected (reaches active).
 *
 * NOTE: forged-loadAck-post-rewrite is covered by the node suite
 * (test-renderer-out-of-phase.js: replayed/forged :rendered and :loadAck →
 * unauthorized_protocol; _loadAckConsumed single-consume latch) and the router
 * gate-step-7 nonce check; it is not re-driven here.
 *
 * No assertion rests on an absolute wall-clock threshold.
 */

import {
  withServer, launchBrowser, captureRun,
  BASE_URL, dump, find,
} from './lib/lifecycle-harness.js';

let failures = 0;
function assert(cond, message, diag) {
  if (cond) { console.log('  ✓', message); }
  else { console.error('  ✗', message); if (diag) console.error(diag); failures++; }
}

const url = (p) => `${BASE_URL}/test/browser/fixtures/lifecycle/${p}`;

async function capture(hostPath, captureMs) {
  const browser = await launchBrowser();
  try {
    return await captureRun(browser, url(hostPath), { captureMs });
  } finally { await browser.close(); }
}

function lineValue(lines, needle, regex) {
  const l = find(lines, needle);
  if (!l) return null;
  const m = l.text.match(regex);
  return m ? m[1] : null;
}

async function main() {
  console.log('test-docopen-security-matrix.js — document.open shim C1–C6 matrix '
    + '(validator tier)\n');

  await withServer(async () => {
    // ── C1: nonce-harvest ────────────────────────────────────────────────
    console.log('C1 — post-reopen nonce-harvest: harness leaves no recoverable '
      + 'nonce material in the reopened DOM');
    {
      const lines = await capture('docopen-nonce-harvest-host.html', 6000);
      const reopened = !!find(lines, 'gen=2 nonce-harvest result');
      const suspicious = lineValue(lines, 'gen=2 nonce-harvest result', /suspiciousTokens=(\d+)/);
      const diag = dump(lines);
      assert(reopened, 'reopen happened and harvest probe ran (positive control)', diag);
      assert(suspicious === '0',
        'C1: ZERO harvestable high-entropy nonce tokens in the reopened document '
          + '(re-injected preludes self-removed their source)',
        `    suspiciousTokens=${suspicious}\n` + diag);
    }

    // ── C2: injection-order race ─────────────────────────────────────────
    console.log('\nC2 — injection race: harness wins despite creative polluting '
      + 'Array/Object/postMessage');
    {
      const lines = await capture('docopen-unshim-race-host.html', 6000);
      const polluted = !!find(lines, 'gen=2 polluted globals before harness');
      const createSession = !!find(lines, 'SHARC:Creative:createSession');
      const terminated = !!find(lines, 'onError 2118');
      const diag = dump(lines);
      assert(polluted, 'creative polluted globals before the harness (positive control)', diag);
      assert(!terminated, 'C2: the reopen is NOT terminated (no 2118)', diag);
      // The race-win proof: the harness ran FIRST (prepended ahead of the
      // creative's pollution) and closed over the NATIVE globals it captured at
      // first render, so its createSession handshake completes even though the
      // creative has since clobbered Array.prototype.map / Object.assign /
      // window.postMessage. (Note: a creative that destroys its OWN runtime
      // this way cannot itself complete the post-handshake Container:init — it
      // sabotaged the methods its own init handler needs. That self-harm is
      // expected and is NOT a shim failure; the shim guarantee is that the
      // HARNESS wins the injection race, which createSession reaching the
      // container proves.)
      assert(createSession,
        'C2: harness WON the injection race — createSession completed despite the '
          + 'creative clobbering Array/Object/postMessage (harness ran first, over '
          + 'captured native globals)', diag);
    }

    // ── C5: un-shim (same fixture: gen=1 attempted un-shim before reopen) ─
    console.log('\nC5 — un-shim attempt: delete/reassign document.open/write/close '
      + 'is defeated');
    {
      const lines = await capture('docopen-unshim-race-host.html', 6000);
      const r = find(lines, 'gen=1 unshim result');
      const diag = dump(lines);
      assert(!!r, 'un-shim probe ran (positive control)', diag);
      // The probe reports true when the property is NO LONGER shim-owned.
      const openEscaped = r && /open=true/.test(r.text);
      const writeEscaped = r && /write=true/.test(r.text);
      const closeEscaped = r && /close=true/.test(r.text);
      assert(r && !openEscaped,
        'C5: document.open stayed shim-owned (non-configurable) — delete defeated', diag);
      assert(r && !writeEscaped,
        'C5: document.write stayed shim-owned (non-writable) — reassign defeated', diag);
      assert(r && !closeEscaped,
        'C5: document.close stayed shim-owned (non-writable) — reassign defeated', diag);
    }

    // ── C3: real-navigation negative control ─────────────────────────────
    console.log('\nC3 — real cross-document navigation after render still fires 2118');
    {
      const lines = await capture('docopen-real-nav-host.html', 6000);
      const got2118 = !!find(lines, 'onError 2118');
      const diag = dump(lines);
      assert(got2118,
        'C3: a real window.location navigation (no prelude, no nonce) → 2118 '
          + 'RENDERER_UNAUTHORIZED_NAVIGATION still fires (escape vector caught)', diag);
    }

    // ── C4: rewrite-storm ────────────────────────────────────────────────
    console.log('\nC4 — rewrite storm: streaming writes + successive cycles stay alive');
    {
      const lines = await capture('docopen-storm-host.html', 7000);
      const stormDone = !!find(lines, 'storm done');
      const createSession = !!find(lines, 'SHARC:Creative:createSession');
      const terminated2118 = !!find(lines, 'onError 2118');
      const diag = dump(lines);
      assert(stormDone, 'storm ran all cycles (positive control)', diag);
      assert(!terminated2118,
        'C4: the rewrite storm did NOT terminate with 2118 (gate answered each '
          + 'reopen; #332 throttle keeps the ad alive)', diag);
      assert(createSession,
        'C4: harness re-injected across the storm — createSession reached', diag);
    }
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
    + '— document.open shim security matrix (C1–C6)');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
