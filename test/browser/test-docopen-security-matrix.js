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
    // ── C1: nonce-harvest (DEFENSE-IN-DEPTH check) ───────────────────────
    // Self-removal of the prelude <script> is now DEFENSE-IN-DEPTH, not the
    // confidentiality control. The binding C1 spec is the harvest-then-FORGE
    // chain below (C1′/C1″/C1‴): even a SUCCESSFULLY harvested nonce must be
    // unweaponizable (fresh-nonce-per-generation). This case still asserts the
    // belt — that a post-self-removal DOM scan finds no nonce literal — to catch
    // a regression where self-removal silently stops running.
    console.log('C1 — post-reopen nonce scan (defense-in-depth): self-removal '
      + 'leaves no nonce literal in the reopened DOM after it completes');
    {
      const lines = await capture('docopen-nonce-harvest-host.html', 6000);
      const reopened = !!find(lines, 'gen=2 nonce-harvest result');
      const suspicious = lineValue(lines, 'gen=2 nonce-harvest result', /suspiciousTokens=(\d+)/);
      const diag = dump(lines);
      assert(reopened, 'reopen happened and harvest probe ran (positive control)', diag);
      assert(suspicious === '0',
        'C1: ZERO harvestable high-entropy nonce tokens in the reopened document '
          + 'AFTER self-removal (defense-in-depth belt; the during-removal trap '
          + 'harvest is covered by C1′)',
        `    suspiciousTokens=${suspicious}\n` + diag);
    }

    // ── C1′: harvest-then-FORGE (the binding spec) ───────────────────────
    // The shipped C1 (above) only proves no nonce literal is left in the DOM
    // AFTER self-removal. The real attack reads the nonce DURING self-removal
    // (Document.prototype.querySelector / Node.prototype.removeChild traps that
    // SURVIVE document.open), then weaponizes it. The binding spec is the full
    // chain: harvest generation N's nonce → the ad advances to a later
    // generation (a further legit reopen) → forge a nonce-authenticated loadAck
    // against a REAL post-render navigation using the STALE harvested nonce →
    // that forged ack MUST be rejected so 2118 still fires. With a SESSION-STABLE
    // nonce the harvested value never goes stale, so the forge succeeds and 2118
    // is suppressed (RED). Fresh-nonce-per-generation (reverse hash chain) makes
    // the harvested generation-N nonce DEAD for generation N+1's gate (GREEN):
    // the chain only reveals preimages, so neither the raw harvested value nor
    // its forward hash can authenticate a later generation.
    console.log('\nC1′ — harvest-then-forge (ackNonce): trap during self-removal, '
      + 'advance a generation, then forge with the stale nonce on a real navigation');
    {
      const lines = await capture('docopen-harvest-forge-host.html', 7000);
      const harvested = find(lines, 'gen=2 harvest result');
      const harvestedNonce = harvested && /harvestedNonce=present/.test(harvested.text);
      const forged = !!find(lines, 'forge-payload posted forged loadAck');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = dump(lines);
      // Positive controls: the exploit must actually run (harvest succeeded,
      // a real navigation happened, the forge fired) — otherwise a green 2118
      // would be vacuous (2118 from a failed reopen, not a rejected forge).
      assert(!!harvested, 'C1′: harvest stage ran (positive control)', diag);
      assert(harvestedNonce,
        'C1′: the renderer nonce WAS harvested during self-removal '
          + '(prototype-trap exploit works — proves the attack is real)', diag);
      assert(forged,
        'C1′: the renderer-origin payload posted a forged loadAck with the '
          + 'harvested nonce (forge attempt fired against the real navigation)', diag);
      assert(got2118,
        'C1′: 2118 STILL fires on the real navigation — the forged loadAck is '
          + 'REJECTED because the harvested nonce is dead for the post-navigation '
          + 'gate (fresh-nonce-per-generation). A session-stable nonce would '
          + 'suppress 2118 here.', diag);
    }

    // ── C1″: removeChild-neuter variant ──────────────────────────────────
    console.log('\nC1″ — removeChild-neuter: prelude <script> survives '
      + '(removeChild no-op), nonce harvested + forged');
    {
      const lines = await capture('docopen-removechild-neuter-host.html', 7000);
      const harvested = find(lines, 'gen=2 neuter harvest result');
      const harvestedNonce = harvested && /harvestedNonce=present/.test(harvested.text);
      const forged = !!find(lines, 'forge-payload posted forged loadAck');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = dump(lines);
      assert(!!harvested, 'C1″: neuter harvest stage ran (positive control)', diag);
      assert(harvestedNonce,
        'C1″: the nonce WAS harvested from the surviving prelude <script> '
          + '(removeChild no-op defeats self-removal entirely)', diag);
      assert(forged,
        'C1″: forged loadAck posted with the harvested nonce', diag);
      assert(got2118,
        'C1″: 2118 STILL fires — forged loadAck rejected (rotation), even '
          + 'though the nonce literal stayed in the DOM permanently', diag);
    }

    // ── C1‴: OMID protocolNonce variant ──────────────────────────────────
    console.log('\nC1‴ — OMID prelude harvest-then-forge (omid:true): same '
      + 'baked-literal+self-removal surface');
    {
      const lines = await capture('docopen-omid-harvest-forge-host.html', 8000);
      const harvested = find(lines, 'gen=2 omid harvest result');
      const harvestedRenderer = harvested && /rendererNonce=present/.test(harvested.text);
      const harvestedOmid = harvested && /omidNonce=present/.test(harvested.text);
      const forged = !!find(lines, 'forge-payload posted forged loadAck');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = dump(lines);
      assert(!!harvested, 'C1‴: OMID harvest stage ran (positive control)', diag);
      assert(harvestedOmid,
        'C1‴: the OMID protocolNonce WAS harvested from the OMID shim prelude '
          + '(the OMID prelude IS a harvest surface — positive control)', diag);
      assert(harvestedRenderer,
        'C1‴: the renderer nonce was harvested from the OMID/load-probe prelude', diag);
      assert(forged,
        'C1‴: forged loadAck posted with the harvested renderer nonce', diag);
      assert(got2118,
        'C1‴: 2118 STILL fires — the OMID-prelude-harvested nonce is rotated '
          + 'out before the next gate; OMID protocolNonce rotation is covered too', diag);
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
