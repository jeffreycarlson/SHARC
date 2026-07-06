#!/usr/bin/env node

/**
 * test-url-lifecycle-gates.js — G5 Creative URL validator execution gates.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  classifyOutcome,
  evaluateUrlLifecycleGates,
  makeEmptyRun,
} from '../src/diagnose.js';
import { normalizeCleanedCorpus } from '../src/normalizer.js';

const cliPath = resolve('tools/creative-validator/src/cli.js');
const fixturePath = resolve(
  'tools/creative-validator/fixtures/url-lifecycle-gates/cleaned-corpus.fixture.json',
);

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function runCli(args) {
  const result = spawnSync('node', [cliPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.status,
    0,
    `CLI failed: node ${cliPath} ${args.join(' ')}\n${result.stderr || result.stdout}`,
  );
  assert.equal(result.stderr, '', `CLI wrote unexpected stderr: ${result.stderr}`);
  return result.stdout;
}

function urlCase({ declared = [], requireSharcInit = true } = {}) {
  return {
    creative: { mode: 'curl', url: 'https://creatives.example/g5/x.html', admKind: 'unknown' },
    expectations: {
      execute: true,
      skipReason: null,
      declared,
      sniffed: [],
      urlLifecycleGates: true,
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

test('G5 R1: creative.mode "curl" rows normalize to executable URL lifecycle cases', () => {
  const corpus = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const cases = normalizeCleanedCorpus(corpus, { sourceFile: fixturePath });
  assert.equal(cases.length, 3);

  for (const testCase of cases) {
    assert.equal(testCase.creative.mode, 'curl');
    assert.equal(testCase.expectations.execute, true);
    assert.equal(testCase.expectations.skipReason, null);
    assert.equal(testCase.expectations.urlLifecycleGates, true);
  }

  const byBid = Object.fromEntries(cases.map((testCase) => [testCase.ids.bidId, testCase]));
  assert.deepEqual(byBid['bid-url-sharc-pass'].expectations.declared, ['sharc']);
  assert.equal(byBid['bid-url-sharc-pass'].sharcOptions.requireSharcInit, true);
  assert.equal(byBid['bid-url-load-failed'].sharcOptions.requireSharcInit, false);
});

test('G5 R2: diagnose.js exposes URL-mode staged gates and ratified bucket vocabulary', () => {
  assert.equal(typeof evaluateUrlLifecycleGates, 'function');

  assert.equal(classifyOutcome(urlCase({ declared: ['mraid'], requireSharcInit: false }), makeEmptyRun({
    creativeRendered: true,
    urlLifecycle: {
      loaded: true,
      handshake: { completed: false },
      visibility: { delivered: false },
      declaredApiProbe: { mraid: false },
    },
  })).bucket, 'url-declared-api-unsupported');

  assert.equal(classifyOutcome(urlCase({ declared: ['sharc'] }), makeEmptyRun({
    creativeRendered: true,
    terminated: true,
    errors: [{ code: 2212, message: 'createSession timeout' }],
    urlLifecycle: {
      loaded: true,
      handshake: { completed: false, timedOut: true },
      visibility: { delivered: false },
    },
  })).bucket, 'declared-sharc-no-handshake');

  assert.equal(classifyOutcome(urlCase({ requireSharcInit: false }), makeEmptyRun({
    creativeRendered: false,
    failedRequests: [{ url: 'https://creatives.example/g5/x.html', resourceType: 'document' }],
    urlLifecycle: {
      loaded: false,
      loadFailure: { kind: 'request-failed' },
      handshake: { completed: false },
      visibility: { delivered: false },
    },
  })).bucket, 'url-load-failed');

  assert.equal(classifyOutcome(urlCase({ requireSharcInit: false }), makeEmptyRun({
    creativeRendered: false,
    timedOut: true,
    urlLifecycle: {
      loaded: false,
      loadFailure: { kind: 'timeout' },
      handshake: { completed: false },
      visibility: { delivered: false },
    },
  })).bucket, 'url-load-timeout');

  assert.equal(classifyOutcome(urlCase({ requireSharcInit: false }), makeEmptyRun({
    creativeRendered: true,
    terminated: true,
    errors: [{ code: 2118, message: 'unauthorized navigation' }],
    securityEvents: [{ type: 'unauthorized_navigation', errorCode: 2118, details: { variant: 'url' } }],
    urlLifecycle: {
      loaded: true,
      handshake: { completed: false },
      visibility: { delivered: false },
    },
  })).bucket, 'navigation-policy');
});

test('G5 URL-mode synthetic fixture runs third-origin and classifies exact buckets', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-url-lifecycle-gates-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const reportPath = resolve(workDir, 'report.jsonl');

  try {
    runCli(['normalize', fixturePath, '--out', inputPath]);
    runCli([
      'run',
      inputPath,
      '--out',
      reportPath,
      '--port',
      '18865',
      '--renderer-port',
      '18866',
      '--creative-port',
      '18867',
      '--render-timeout-ms',
      '2000',
      '--settle-ms',
      '1000',
    ]);

    const reports = readJsonl(reportPath);
    assert.equal(reports.length, 3);
    const byBid = Object.fromEntries(reports.map((row) => [row.case.ids.bidId, row]));

    const passing = byBid['bid-url-sharc-pass'];
    assert.equal(passing.outcome.status, 'passed');
    assert.equal(passing.outcome.bucket, 'passed');
    assert.equal(passing.outcome.creativeRendered, true);
    assert.equal(passing.diagnostics.urlLifecycle.loaded, true);
    assert.equal(passing.diagnostics.urlLifecycle.handshake.completed, true);
    assert.equal(passing.diagnostics.urlLifecycle.ready.delivered, true);
    assert.equal(
      passing.diagnostics.urlLifecycle.ready.firstAt >= passing.diagnostics.urlLifecycle.documentLoadAt,
      true,
      'URL SHARC ready is document-load anchored',
    );
    assert.equal(passing.diagnostics.urlLifecycle.visibility.delivered, true);
    assert.equal(passing.diagnostics.urlLifecycle.visibility.effectivePercent > 0, true);
    assert.equal(passing.outcome.creativeInjected, false, 'URL mode uses zero injection');

    const noHandshake = byBid['bid-url-sharc-no-handshake'];
    assert.equal(noHandshake.outcome.status, 'failed');
    assert.equal(noHandshake.outcome.bucket, 'declared-sharc-no-handshake');
    assert.equal(noHandshake.diagnostics.urlLifecycle.loaded, true);
    assert.equal(noHandshake.diagnostics.urlLifecycle.handshake.completed, false);

    const loadFailed = byBid['bid-url-load-failed'];
    assert.equal(loadFailed.outcome.status, 'failed');
    assert.equal(loadFailed.outcome.bucket, 'url-load-failed');
    assert.equal(loadFailed.diagnostics.urlLifecycle.loaded, false);
    assert.equal(loadFailed.diagnostics.urlLifecycle.loadFailure.kind, 'http-error');
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});
