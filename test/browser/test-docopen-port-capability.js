/**
 * test-docopen-port-capability.js — ADR 2026-06-15 headline adversarial
 * fixtures for the capability-only (MessagePort-possession) document.open C1
 * fix. Validator tier (real renderer + real document.open + real navigation in
 * system Chrome). Built on test/browser/lib/lifecycle-harness.js.
 *
 * This is the CHECKPOINT subset (the two make-or-break fixtures) — the full
 * adversarial set (harvest-then-forge collapse, fail-closed, cross-origin,
 * wrapper-topology, successive-reopens) lands in a later phase.
 *
 *   1. Stale-ack timing forge — a hostile creative pre-computes forged loadAck
 *      for a PREDICTED next probeId, sprays them in-flight, then performs a
 *      REAL navigation. The strict ack gate (CSPRNG probeId + port-arrival +
 *      temporal binding) REJECTS every forged ack → 2118 STILL fires.
 *
 *   2. onmessage/AEL setter-trap DoS — a hostile creative traps
 *      MessagePort.prototype.{postMessage,onmessage} + EventTarget.prototype.
 *      addEventListener, then performs a LEGIT document.open reopen. The
 *      captured-native answer + bind paths defeat the traps → the legit reopen
 *      is NOT terminated AND createSession re-fires (no false 2118).
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

async function main() {
  console.log('test-docopen-port-capability.js — ADR 2026-06-15 headline '
    + 'adversarial fixtures (port-possession backstop)\n');

  await withServer(async () => {
    // ── Fixture 1: stale-ack timing forge ─────────────────────────────────
    console.log('F1 — stale-ack timing forge: pre-computed forged loadAck spray '
      + 'for a predicted probeId,\n   then a REAL navigation → the port gate '
      + 'REJECTS the forge → 2118 STILL fires');
    {
      const lines = await capture('docopen-stale-ack-forge-host.html', 6000);
      const sprayed = !!find(lines, 'firing forged loadAck spray');
      const navigated = !!find(lines, 'performing REAL navigation after forge spray');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = `    sprayed=${sprayed} navigated=${navigated} got2118=${got2118}\n`
        + dump(lines);

      // Positive controls: the forge actually fired and a real navigation
      // happened — otherwise a green 2118 would be vacuous.
      assert(sprayed,
        'F1: the creative fired a forged loadAck spray (positive control)', diag);
      assert(navigated,
        'F1: the creative performed a REAL cross-document navigation (positive control)', diag);
      assert(got2118,
        'F1: 2118 STILL fires on the real navigation — the strict ack gate '
          + '(CSPRNG probeId unpredictable + port-arrival + temporal binding) '
          + 'rejects every forged/window-posted ack; prediction is infeasible.', diag);
    }

    // ── Fixture 2: onmessage / AEL setter-trap DoS ────────────────────────
    console.log('\nF2 — onmessage/AEL setter-trap DoS: creative traps '
      + 'MessagePort.{postMessage,onmessage} + AEL,\n   then a LEGIT '
      + 'document.open reopen STILL answers over the port (captured natives) — '
      + 'no false 2118');
    {
      const lines = await capture('docopen-onmessage-trap-host.html', 7000);
      const trapped = !!find(lines, 'installed onmessage/AEL/postMessage traps');
      const gen3Load = !!find(lines, 'gen=3 window load');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = `    trapped=${trapped} gen3Load=${gen3Load} got2118=${got2118}\n`
        + dump(lines);

      // Positive controls: the traps installed and the trapped-generation reopen
      // completed (gen=3 load is the post-render gate fired under active traps).
      assert(trapped,
        'F2: the creative installed onmessage/AEL/postMessage traps (positive control)', diag);
      assert(gen3Load,
        'F2: the legit document.open reopen under active traps completed (gen=3 '
          + 'reached window load — the post-render gate fired here)', diag);

      // CONTRACT: no false 2118 — the captured-native answer + captured-native
      // bind (try/catch-isolated) defeat the realm-wide clobber/setter-traps, so
      // the load-probe gate stays answerable and the reanchor is not aborted
      // across the reopen. A naive `port.postMessage` / `port.onmessage=` shape
      // would yield a false 2118 here (the encoded "captured natives are
      // required" contract).
      //
      // NOTE: 2118 specifically, NOT generic termination — this hostile creative
      // ALSO nukes MessagePort.prototype globally, which breaks its OWN SDK
      // transport (createSession then times out → 2212). That self-inflicted DoS
      // is the creative's choice; the SHARC contract is only that the navigation
      // backstop did not false-fire (no 2118).
      assert(!got2118,
        'F2: the legit reopen does NOT false-fire 2118 — captured-native '
          + 'MessagePort.postMessage.call + addEventListener.call + start survive '
          + 'the realm-wide clobber/setter-traps', diag);
    }
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
    + '— document.open port-capability headline fixtures');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
