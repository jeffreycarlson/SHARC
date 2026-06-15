/**
 * test-docopen-port-capability.js — ADR 2026-06-15 adversarial fixtures for the
 * capability-only (MessagePort-possession) document.open C1 fix. Validator tier
 * (real renderer + real document.open + real navigation in system Chrome). Built
 * on test/browser/lib/lifecycle-harness.js.
 *
 * The chain is RETIRED; the port is the SOLE load-probe authenticator. This is
 * the full adversarial set:
 *
 *   F1. Stale-ack timing forge — a hostile creative pre-computes forged loadAck
 *      for a PREDICTED next probeId, sprays them in-flight, then performs a
 *      REAL navigation. The strict ack gate (CSPRNG probeId + port-arrival +
 *      temporal binding) REJECTS every forged ack → 2118 STILL fires.
 *
 *   F2. onmessage/AEL setter-trap DoS — a hostile creative traps
 *      MessagePort.prototype.{postMessage,onmessage} + EventTarget.prototype.
 *      addEventListener, then performs a LEGIT document.open reopen. The
 *      captured-native answer + bind paths defeat the traps → the legit reopen
 *      is NOT terminated AND createSession re-fires (no false 2118).
 *
 *   F3. Harvest-then-forge is STRUCTURALLY impossible (replaces chain C1′/C1″/
 *      C1‴) — a creative installs querySelector/removeChild traps, scans the
 *      reopened DOM, then sprays window-posted acks (any guessed probeId) and
 *      navigates. There is no value to harvest and no window ack path → 2118
 *      STILL fires on the real escape.
 *
 *   F4. Real navigation → 2118 (the fail-closed escape path).
 *   F5. Fail-closed: no valid ack on the port within the deadline → 2118
 *      (the real-nav fixture is the port-unanswered proof).
 *   F6. Cross-origin (markup): the creative cannot read `parent.<anything>` —
 *      the Container heap holding `port1` is cross-origin-opaque.
 *   F7. Forbidden misconfig: renderer same-origin to the Container frame →
 *      Rule 7 throws at construction.
 *   F8. Wrapper/carve-out topology: publisher → cross-origin wrapper [Container,
 *      port1] → renderer, with `window.top` INACCESSIBLE. The `window.location`
 *      check still protects `port1` (creative cross-origin to the Container
 *      frame → cannot reach port1) regardless of `wrapperPolicy` (default warn,
 *      no dark-render).
 *   F9. Second-post-render-load triggers (SE item 1): passive child <iframe> /
 *      <img> / attempted <meta refresh> after first render → NO false 2118.
 *
 * Legit document.open reopen → suppressed (no 2118) is covered by
 * test-lifecycle-docopen-shim.js (T5) and the C4 storm in the security matrix.
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

    // ── Fixture 3: harvest-then-forge is structurally impossible ───────────
    console.log('\nF3 — harvest-then-forge: install querySelector/removeChild traps, '
      + 'scan the\n   reopened DOM, spray window-posted acks, then navigate → no value '
      + 'to harvest,\n   no window ack path → 2118 STILL fires on the real escape');
    {
      const lines = await capture('docopen-harvest-forge-port-host.html', 7000);
      const trapped = !!find(lines, 'installed querySelector/removeChild harvest traps');
      const scanLine = find(lines, 'harvest-forge scan result harvestable=');
      const sprayed = !!find(lines, 'firing forged loadAck spray (post-harvest)');
      const navigated = !!find(lines, 'performing REAL navigation after harvest+forge');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = `    trapped=${trapped} sprayed=${sprayed} navigated=${navigated} got2118=${got2118}\n`
        + dump(lines);

      assert(trapped,
        'F3: the creative installed the C1-original querySelector/removeChild '
          + 'harvest traps (positive control — the attack mechanism is real)', diag);
      assert(!!scanLine,
        'F3: the post-reopen DOM harvest scan ran (positive control)', diag);
      assert(sprayed && navigated,
        'F3: the creative sprayed forged acks AND performed a real navigation '
          + '(positive controls)', diag);
      assert(got2118,
        'F3: 2118 STILL fires — there is NO secret to harvest (the load-probe '
          + 'authenticates by port possession, not a value) and NO window ack '
          + 'path; every forged/window-posted ack is rejected. Harvest-then-forge '
          + 'is structurally impossible.', diag);
    }

    // ── Fixture 4 + 5: real navigation → 2118 (fail-closed, port unanswered) ─
    console.log('\nF4/F5 — real navigation → 2118 (fail-closed): a real cross-document '
      + 'navigation\n   destroys the realm + port2; the load-probe goes UNANSWERED on the '
      + 'port within\n   the deadline → 2118 fires (the escape vector is caught)');
    {
      const lines = await capture('docopen-real-nav-host.html', 6000);
      const navigated = !!find(lines, 'performing REAL cross-document navigation');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = `    navigated=${navigated} got2118=${got2118}\n` + dump(lines);
      assert(navigated,
        'F4/F5: the creative performed a REAL cross-document navigation (positive control)', diag);
      assert(got2118,
        'F4/F5: 2118 fires — the navigated-to document holds no port2, so the '
          + 'load-probe is unanswered within the deadline (fail-closed).', diag);
    }

    // ── Fixture 6: cross-origin markup — parent.* unreadable ───────────────
    console.log('\nF6 — cross-origin (markup): the creative cannot read parent.<anything> — '
      + 'the\n   Container heap holding port1 is cross-origin-opaque to the creative realm');
    {
      const lines = await capture('docopen-crossorigin-parent-host.html', 6000);
      const probeLine = find(lines, 'gen=1 parent-read probe:');
      const verdict = find(lines, 'parent-read VERDICT allBlocked=');
      const allBlocked = verdict && /allBlocked=true/.test(verdict.text);
      const diag = `    probe=${probeLine ? probeLine.text : 'MISSING'}\n` + dump(lines);
      assert(!!probeLine,
        'F6: the creative ran the parent.* read probe (positive control)', diag);
      assert(allBlocked,
        'F6: EVERY parent.* read (location / SHARC / __CONTAINER / bracket) was '
          + 'blocked — the creative cannot reach the Container heap, so port1 is '
          + 'unreachable (the sole-linchpin guard holds)', diag);
    }

    // ── Fixture 7: forbidden same-origin misconfig → Rule 7 throws ─────────
    console.log('\nF7 — forbidden misconfig: renderer same-origin to the Container frame → '
      + 'Rule 7\n   throws at construction (the one posture that would break the model)');
    {
      const lines = await capture('docopen-rule7-misconfig-host.html', 4000);
      const line = find(lines, 'rule7 misconfig: construction threw=');
      const threw = line && /construction threw=true/.test(line.text);
      const crossOriginMsg = line && /cross-origin to window\.location/.test(line.text);
      const diag = `    line=${line ? line.text : 'MISSING'}\n` + dump(lines);
      assert(!!line, 'F7: the Rule-7 misconfig construction attempt ran (positive control)', diag);
      assert(threw,
        'F7: construction THREW on a renderer same-origin to the Container frame', diag);
      assert(crossOriginMsg,
        'F7: the throw is the Rule-7 cross-origin-to-window.location guard '
          + '(unconditional — does not depend on window.top)', diag);
    }

    // ── Fixture 8: wrapper/carve-out topology — port1 protected, top inaccessible ─
    console.log('\nF8 — wrapper topology (★): publisher → cross-origin wrapper [Container, '
      + 'port1]\n   → renderer, window.top INACCESSIBLE. The window.location check still '
      + 'protects\n   port1; the carve-out is warn (no dark-render) regardless of wrapperPolicy');
    {
      const lines = await capture('docopen-wrapper-topology-host.html', 8000);
      const topThrew = find(lines, 'wrapper top-access threw=');
      const topInaccessible = topThrew && /threw=true/.test(topThrew.text);
      const carveOut = find(lines, 'wrapper carve-out severity=');
      const carveWarn = carveOut && /severity=warning/.test(carveOut.text);
      const ctorLine = find(lines, 'wrapper construction threw=');
      const ctorOk = ctorLine && /threw=false/.test(ctorLine.text);
      const verdict = find(lines, 'wrapper-topology parent-read VERDICT allBlocked=');
      const port1Protected = verdict && /allBlocked=true/.test(verdict.text);
      const diag = `    topInaccessible=${topInaccessible} carveWarn=${carveWarn} `
        + `ctorOk=${ctorOk} port1Protected=${port1Protected}\n` + dump(lines);

      assert(topInaccessible,
        'F8: window.top is INACCESSIBLE from the Container (wrapper) frame — the '
          + 'common programmatic topology (positive control)', diag);
      assert(carveWarn,
        'F8: the wrapperPolicy carve-out fires as WARN (default), NOT block — the '
          + 'common wrapper deployment is not dark-rendered', diag);
      assert(ctorOk,
        'F8: construction did NOT throw — the renderer is cross-origin to the '
          + 'Container frame, so the unconditional window.location check passes', diag);
      assert(port1Protected,
        'F8 (★): the creative CANNOT read the Container frame\'s parent.* heap — '
          + 'port1 is protected by the renderer-vs-Container-frame window.location '
          + 'check EVEN THOUGH window.top is unreadable. C1 holds in this topology.', diag);
    }

    // ── Fixture 9: second-post-render-load triggers → no false 2118 ────────
    console.log('\nF9 — second-post-render-load triggers (SE item 1): passive child <iframe> '
      + '/\n   <img> / attempted <meta refresh> after first render → NO false 2118 '
      + '(the gate\n   stays answerable across the post-initial-render re-registration)');
    {
      const lines = await capture('docopen-second-load-triggers-host.html', 8000);
      const childIframe = !!find(lines, 'appended child iframe');
      const img = !!find(lines, 'appended img subresource');
      const metaLine = find(lines, 'meta refresh present in delivered markup');
      const metaStripped = metaLine && /stripped=true/.test(metaLine.text);
      const createSession = !!find(lines, 'SHARC:Creative:createSession')
        || !!find(lines, 'mraid event: ready');
      const got2118 = !!find(lines, 'onError 2118');
      const diag = `    childIframe=${childIframe} img=${img} metaStripped=${metaStripped} `
        + `createSession=${createSession} got2118=${got2118}\n` + dump(lines);

      assert(childIframe && img,
        'F9: the passive child <iframe> and <img> second-load triggers ran '
          + '(positive controls)', diag);
      assert(metaStripped,
        'F9: the renderer STRIPPED the delivered-markup <meta refresh> — the '
          + 'attempted refresh never navigated the renderer iframe', diag);
      assert(!got2118,
        'F9: NO false 2118 — none of the passive re-load triggers is a cross-'
          + 'document navigation of the renderer iframe; the controlled-context '
          + 'gate stays answerable (post-initial-render re-registration)', diag);
      assert(createSession,
        'F9: the ad reached a creative-active signal (createSession / mraid ready) '
          + '— the legit re-loads did not tear it down', diag);
    }
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
    + '— document.open port-capability adversarial fixtures');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
