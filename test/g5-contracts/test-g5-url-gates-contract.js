#!/usr/bin/env node

/**
 * G5 red contract R2 — diagnose.js URL-mode staged gates + bucket vocabulary.
 *
 * Ratified G5 contract: URL-mode rows get their own staged-gate evaluation
 * (`evaluateUrlLifecycleGates`, mirroring #419's `evaluateMraidLifecycleGates`
 * shape) and a URL bucket vocabulary so the negative fixture shapes classify
 * to NAMED, attribution-polarized buckets instead of `inconclusive`:
 *
 *   F5-NEG  mraid-expecting URL creative  → 'url-declared-api-unsupported' (creative/operator-attributable)
 *   F7-NEG  declared SHARC, no handshake  → 'declared-sharc-no-handshake'  (creative-attributable)
 *   F8-NEG  URL fetch 404/refused         → 'url-load-failed'              (operator/network-attributable)
 *   F8-NEG  slow load past timeout        → 'url-load-timeout'             (operator/network-attributable)
 *   F9-NEG  post-load navigation/redirect → 'navigation-policy'            (existing bucket — the 2118
 *                                           unauthorized_navigation backstop IS the verdict)
 *
 * Synthetic run objects mirror the #419 test pattern (makeEmptyRun overrides).
 *
 * RED today: diagnose.js exports no evaluateUrlLifecycleGates and
 * classifyOutcome has no URL-mode leg — URL rows cannot even reach it
 * (normalizer skips them, see R1).
 *
 * See ADR: ~/Obsidian/dev-team/sharc/2026-07-05-g5-url-mode-conformance.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as diagnose from '../../tools/creative-validator/src/diagnose.js';

const { makeEmptyRun, classifyOutcome } = diagnose;

const MISSING_EVALUATOR =
  'G5 URL-mode contract: diagnose.js must export evaluateUrlLifecycleGates '
  + '(URL staged gates U1 load/render, U2 handshake+ready, U3 visibility/'
  + 'measurement delivery — the #419 MRAID gates are bridge-specific and do '
  + 'not apply to the no-injection URL path)';

function urlCase({ declared = [], urlLifecycleGates = true, requireSharcInit = true } = {}) {
  return {
    creative: { mode: 'curl', url: 'https://creatives.example/g5/x.html', admKind: 'unknown' },
    expectations: {
      execute: true,
      skipReason: null,
      declared,
      sniffed: [],
      urlLifecycleGates,
    },
    bidSignals: {
      measurement: {
        omid: {
          declaredByApi: declared.includes('omid'),
          sidecarPresent: false,
          inlineVendorScriptPresent: false,
          verificationScriptCount: 0,
        },
      },
    },
    sharcOptions: { requireSharcInit },
  };
}

test('G5 R2: diagnose.js exposes the URL-mode staged-gate evaluator', () => {
  assert.equal(typeof diagnose.evaluateUrlLifecycleGates, 'function', MISSING_EVALUATOR);
});

test('G5 R2 (F5-NEG): mraid-expecting URL creative classifies to url-declared-api-unsupported, never hangs into inconclusive', () => {
  assert.equal(typeof diagnose.evaluateUrlLifecycleGates, 'function', MISSING_EVALUATOR);
  // URL variant loads no bridges by construction (Rule 3b) — window.mraid
  // stays undefined. The creative renders but its declared API never appears.
  const run = makeEmptyRun({
    creativeRendered: true,
    urlLifecycle: {
      loaded: true,
      handshake: { completed: false },
      visibility: { delivered: false },
      declaredApiProbe: { mraid: false },
    },
  });
  const outcome = classifyOutcome(urlCase({ declared: ['mraid'], requireSharcInit: false }), run);
  assert.equal(
    outcome.bucket,
    'url-declared-api-unsupported',
    'G5 URL-mode contract: declared-mraid URL creative must classify to the '
      + 'named url-declared-api-unsupported bucket (MRAID is structurally '
      + `excluded on the no-injection URL path) — got '${outcome.bucket}'`,
  );
});

test('G5 R2 (F7-NEG): declared SHARC but plain HTML (requireSharcInit default) classifies to declared-sharc-no-handshake', () => {
  assert.equal(typeof diagnose.evaluateUrlLifecycleGates, 'function', MISSING_EVALUATOR);
  // NO_CREATE_SESSION (2212) fatal after the createSession timeout — an
  // attributable creative defect (claimed the feature tier, never handshook).
  const run = makeEmptyRun({
    creativeRendered: true,
    terminated: true,
    errors: [{ code: 2212, message: 'createSession timeout' }],
    urlLifecycle: {
      loaded: true,
      handshake: { completed: false, timedOut: true },
      visibility: { delivered: false },
    },
  });
  const outcome = classifyOutcome(urlCase({ declared: ['sharc'] }), run);
  assert.equal(
    outcome.bucket,
    'declared-sharc-no-handshake',
    'G5 URL-mode contract: declared-SHARC creative that never handshakes must '
      + 'classify to declared-sharc-no-handshake (clean attributable fatal, '
      + `not inconclusive) — got '${outcome.bucket}'`,
  );
});

test('G5 R2 (F8-NEG, refused/404): URL load failure classifies to url-load-failed', () => {
  assert.equal(typeof diagnose.evaluateUrlLifecycleGates, 'function', MISSING_EVALUATOR);
  const run = makeEmptyRun({
    creativeRendered: false,
    failedRequests: [{ url: 'https://creatives.example/g5/x.html', failure: 'net::ERR_CONNECTION_REFUSED' }],
    urlLifecycle: {
      loaded: false,
      loadFailure: { kind: 'request-failed' },
      handshake: { completed: false },
      visibility: { delivered: false },
    },
  });
  const outcome = classifyOutcome(urlCase({ requireSharcInit: false }), run);
  assert.equal(
    outcome.bucket,
    'url-load-failed',
    'G5 URL-mode contract: a refused/404 creative URL must classify to the '
      + `named url-load-failed bucket — got '${outcome.bucket}'`,
  );
});

test('G5 R2 (F8-NEG, slow load): load past timeout classifies to url-load-timeout, never hangs', () => {
  assert.equal(typeof diagnose.evaluateUrlLifecycleGates, 'function', MISSING_EVALUATOR);
  const run = makeEmptyRun({
    creativeRendered: false,
    timedOut: true,
    urlLifecycle: {
      loaded: false,
      loadFailure: { kind: 'timeout' },
      handshake: { completed: false },
      visibility: { delivered: false },
    },
  });
  const outcome = classifyOutcome(urlCase({ requireSharcInit: false }), run);
  assert.equal(
    outcome.bucket,
    'url-load-timeout',
    'G5 URL-mode contract: a creative URL that never finishes loading must '
      + `classify to the named url-load-timeout bucket — got '${outcome.bucket}'`,
  );
});

test('G5 R2 (F9-NEG): post-load navigation surfaces the 2118 backstop as the verdict (navigation-policy bucket)', () => {
  assert.equal(typeof diagnose.evaluateUrlLifecycleGates, 'function', MISSING_EVALUATOR);
  const run = makeEmptyRun({
    creativeRendered: true,
    terminated: true,
    errors: [{ code: 2118, message: 'unauthorized navigation' }],
    securityEvents: [{ type: 'unauthorized_navigation', errorCode: 2118, details: { variant: 'url' } }],
    urlLifecycle: {
      loaded: true,
      handshake: { completed: false },
      visibility: { delivered: false },
    },
  });
  const outcome = classifyOutcome(urlCase({ requireSharcInit: false }), run);
  assert.equal(
    outcome.bucket,
    'navigation-policy',
    'G5 URL-mode contract: a post-load redirect on the URL path must surface '
      + 'the RENDERER_UNAUTHORIZED_NAVIGATION (2118) backstop as the verdict '
      + `(existing navigation-policy bucket) — got '${outcome.bucket}'`,
  );
});
