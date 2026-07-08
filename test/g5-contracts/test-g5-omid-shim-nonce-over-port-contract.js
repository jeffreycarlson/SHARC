#!/usr/bin/env node

/**
 * G5 red contract R3 — T2 OMID shim nonce-over-port delivery seam.
 *
 * Ratified G5 contract (OMID tier T2): a SHARC URL-tier creative self-includes
 * `sharc-omid-shim.js` next to the SDK. The OMID protocolNonce is delivered
 * over the ALREADY-ESTABLISHED SHARC MessageChannel port post-handshake —
 * the URL-path adaptation of the locked srcdoc "OMID-D2 mechanism ii"
 * (transferred-port nonce delivery, origin-agnostic; docs/design/
 * 0.7.8-omid-spec-compliant-bridge.md § 4.3). The markup path bakes the nonce
 * at renderer rewrite time; on the URL path there is no renderer, so the port
 * is the only trusted, injection-free channel.
 *
 * Designed seam (defined by this contract):
 *   - sharc-protocol.js declares ContainerMessages.OMID_SHIM_INIT
 *     ('SHARC:Container:omidShimInit') — container → creative, port-only.
 *   - SHARCCreative handles it (`_handleOmidShimInit`) and, when the creative
 *     self-included the shim (window.SHARC.installOmidShim present), installs
 *     it with { protocolNonce, placementSessionId, containerOrigin,
 *     postRegister } where postRegister rides the port (never
 *     parent.postMessage — fail-closed containerOrigin does not apply on the
 *     port path).
 *   - Latching public surface `onOmidShimInit(listener)` mirrors the
 *     effectiveVisibilityChange replay-once contract for late shim loads.
 *
 * Precondition (verified 2026-07-05): src/sharc-creative.js has ZERO
 * functional omid references — the delivery path does not exist.
 *
 * RED today: none of the seam exists.
 *
 * See ADR: ~/Obsidian/dev-team/sharc/2026-07-05-g5-url-mode-conformance.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ContainerMessages } from '../../src/sharc-protocol.js';
import { SHARCCreative } from '../../src/sharc-creative.js';
import { installOmidShim } from '../../src/sharc-omid-shim.js';

test('G5 R3: protocol declares the container→creative omidShimInit message type', () => {
  assert.equal(
    ContainerMessages.OMID_SHIM_INIT,
    'SHARC:Container:omidShimInit',
    'G5 T2 contract: sharc-protocol.js must declare '
      + "ContainerMessages.OMID_SHIM_INIT === 'SHARC:Container:omidShimInit' "
      + '(the port-only nonce-delivery envelope for the URL-tier self-included '
      + `shim) — got ${JSON.stringify(ContainerMessages.OMID_SHIM_INIT)}`,
  );
});

test('G5 R3: SHARCCreative exposes the nonce-over-port acceptance seam', () => {
  assert.equal(
    typeof SHARCCreative.prototype._handleOmidShimInit,
    'function',
    'G5 T2 contract: SHARCCreative must handle Container:omidShimInit '
      + '(_handleOmidShimInit) and hand the nonce to the self-included shim — '
      + 'no delivery path exists today (sharc-creative.js has zero omid surface)',
  );
  assert.equal(
    typeof SHARCCreative.prototype.onOmidShimInit,
    'function',
    'G5 T2 contract: SHARCCreative must expose the latching onOmidShimInit '
      + 'registration surface (replay-once for a shim that loads after the '
      + 'nonce arrived, mirroring the effectiveVisibilityChange replay contract)',
  );
});

test('G5 R3: simulated post-handshake omidShimInit wires the self-included shim with the port-delivered nonce', () => {
  const creative = new SHARCCreative();

  assert.equal(
    typeof creative._handleOmidShimInit,
    'function',
    'G5 T2 contract: _handleOmidShimInit missing — cannot simulate the '
      + 'post-handshake nonce delivery (see previous test)',
  );

  // Simulate: handshake done, container sends omidShimInit over the port.
  // The seam must surface { protocolNonce, placementSessionId, postRegister }
  // to a registered listener (the shim glue), with the nonce delivered
  // verbatim and postRegister bound to the port transport.
  const received = [];
  creative.onOmidShimInit((init) => received.push(init));
  creative._handleOmidShimInit({
    args: {
      protocolNonce: 'g5-omid-nonce-fixture',
      placementSessionId: 'g5-psid-fixture',
    },
  });

  assert.equal(received.length, 1, 'shim-init listener invoked exactly once');
  assert.equal(received[0].protocolNonce, 'g5-omid-nonce-fixture',
    'protocolNonce delivered verbatim to the shim glue');
  assert.equal(received[0].placementSessionId, 'g5-psid-fixture',
    'placementSessionId delivered alongside the nonce');
  assert.equal(typeof received[0].postRegister, 'function',
    'postRegister transport hook provided so installOmidShim posts '
      + 'SHARC:Omid:Register over the port (never parent.postMessage)');

  // The delivered init must be installable into the existing shim unchanged —
  // the shim already accepts an injectable postRegister (its URL/port seam).
  const fakeWindow = { addEventListener() {}, removeEventListener() {} };
  const handle = installOmidShim({
    protocolNonce: received[0].protocolNonce,
    placementSessionId: received[0].placementSessionId,
    containerOrigin: 'port',
    targetWindow: fakeWindow,
    parentWindow: {},
    postRegister: received[0].postRegister,
  });
  assert.equal(typeof handle.getStats, 'function',
    'port-delivered init installs the existing shim without modification');
});
