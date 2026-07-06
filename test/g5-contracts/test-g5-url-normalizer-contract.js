#!/usr/bin/env node

/**
 * G5 red contract R1 — validator normalizer executes Creative URL rows.
 *
 * Ratified G5 contract: the Creative URL variant is a conformance-eligible
 * input. A cleaned-corpus row whose bid carries `curl` (creative.mode 'curl')
 * must normalize to an EXECUTABLE case carrying the URL-mode staged-gate
 * expectation (`expectations.urlLifecycleGates === true`), not skip as
 * unsupported input.
 *
 * RED today: `resolveExecution` in tools/creative-validator/src/normalizer.js
 * returns `{ execute: false, skipReason: 'creative-url-mode-not-supported-v0' }`
 * for mode 'curl'.
 *
 * See ADR: ~/Obsidian/dev-team/sharc/2026-07-05-g5-url-mode-conformance.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCleanedCorpus } from '../../tools/creative-validator/src/normalizer.js';

function urlModeCorpusRow({ apis = [7, 10], curl = 'https://creatives.example/g5/sharc-native.html' } = {}) {
  return [
    {
      id: 'g5-url-row-1',
      auction: [
        {
          bidder: 'g5-synthetic',
          mtype: 'banner',
          bid_request: {
            id: 'g5-request-1',
            imp: [
              {
                id: 'g5-imp-1',
                instl: 0,
                secure: 1,
                banner: { w: 300, h: 250, api: apis },
              },
            ],
          },
          bid_response: {
            id: 'g5-response-1',
            seatbid: [
              {
                bid: [
                  {
                    id: 'g5-bid-1',
                    impid: 'g5-imp-1',
                    crid: 'g5-creative-1',
                    curl,
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  ];
}

test('G5 R1: creative.mode "curl" row normalizes to execute:true (URL rows are conformance inputs, not unsupported-input skips)', () => {
  const cases = normalizeCleanedCorpus(urlModeCorpusRow(), { sourceFile: 'g5-synthetic.json' });
  assert.equal(cases.length, 1, 'synthetic corpus row yields one normalized case');
  const testCase = cases[0];

  assert.equal(testCase.creative.mode, 'curl', 'row normalizes as URL mode');
  assert.equal(
    testCase.creative.url,
    'https://creatives.example/g5/sharc-native.html',
    'creative.url carries the bid curl',
  );

  assert.equal(
    testCase.expectations.execute,
    true,
    'G5 URL-mode contract: a curl row must be EXECUTABLE '
      + '(today the normalizer skips it with creative-url-mode-not-supported-v0; '
      + `got execute=${testCase.expectations.execute}, skipReason=${testCase.expectations.skipReason})`,
  );
  assert.equal(
    testCase.expectations.skipReason,
    null,
    'G5 URL-mode contract: executable URL rows carry no skipReason',
  );
});

test('G5 R1: executable URL row carries the urlLifecycleGates expectation for staged-gate evaluation', () => {
  const cases = normalizeCleanedCorpus(urlModeCorpusRow(), { sourceFile: 'g5-synthetic.json' });
  const testCase = cases[0];

  assert.equal(
    testCase.expectations.urlLifecycleGates,
    true,
    'G5 URL-mode contract: normalized URL cases must carry '
      + 'expectations.urlLifecycleGates === true so diagnose.js routes them '
      + 'through the URL staged gates (gate-U1 load/render, gate-U2 handshake+ready, '
      + 'gate-U3 visibility/measurement delivery) instead of the bridge-specific '
      + `MRAID gates (got: ${testCase.expectations.urlLifecycleGates})`,
  );
});
