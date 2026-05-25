#!/usr/bin/env node

/**
 * test-runner.js — creative validator Phase 2 runner coverage.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const cliPath = resolve('tools/creative-validator/src/cli.js');

function makeCase(overrides) {
  return {
    source: {
      sourceFile: 'synthetic-runner-test',
      rowIndex: 0,
      auctionId: 'auction-runner-test',
      auctionIndex: 0,
      bidder: 'synthetic-runner',
      mtype: 'banner',
    },
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-test',
      impId: 'imp-runner-test',
      crid: 'creative-runner-test',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><div id="ad">runner smoke</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [], sanitized: [], sources: [] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: [],
      sniffed: [],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [] },
      requireSharcInit: false,
      placementType: 'inline',
    },
    ...overrides,
  };
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('runner executes HTML cases and writes one report row per case', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const outPath = resolve(workDir, 'reports.jsonl');

  const executable = makeCase({});
  const skipped = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-native',
      impId: 'imp-runner-test',
      crid: 'creative-runner-native',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'native-json',
      html: '{"native":{"assets":[]}}',
      url: null,
      width: null,
      height: null,
      placementType: 'inline',
      transformations: [],
    },
    expectations: {
      declared: [],
      sniffed: [],
      execute: false,
      skipReason: 'unsupported-adm-kind:native-json',
    },
  });

  try {
    writeFileSync(inputPath, JSON.stringify(executable) + '\n' + JSON.stringify(skipped) + '\n');
    execFileSync('node', [
      cliPath,
      'run',
      inputPath,
      '--out',
      outPath,
      '--render-timeout-ms',
      '4000',
      '--settle-ms',
      '100',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const reports = readJsonl(outPath);
    assert.equal(reports.length, 2);

    const htmlReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-test');
    assert.ok(htmlReport);
    assert.equal(htmlReport.outcome.status, 'passed');
    assert.equal(htmlReport.outcome.bucket, 'passed');
    assert.equal(htmlReport.outcome.creativeRendered, true);
    assert.equal(htmlReport.outcome.terminated, false);
    assert.equal(htmlReport.case.creative.html, undefined);
    assert.equal(typeof htmlReport.outcome.reachedActive, 'boolean');
    assert.ok(Array.isArray(htmlReport.diagnostics.stateHistory));

    const nativeReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-native');
    assert.ok(nativeReport);
    assert.equal(nativeReport.outcome.status, 'skipped');
    assert.equal(nativeReport.outcome.bucket, 'unsupported-input');
    assert.equal(nativeReport.outcome.reason, 'unsupported-adm-kind:native-json');
    assert.equal(nativeReport.outcome.creativeRendered, false);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('runner refuses public report output by default', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-guard-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const publicOut = resolve('tools/creative-validator/fixtures/reports-leak.jsonl');

  try {
    writeFileSync(inputPath, JSON.stringify(makeCase({})) + '\n');
    assert.throws(
      () => execFileSync('node', [cliPath, 'run', inputPath, '--out', publicOut], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      /Refusing to write private creative validator output outside/,
    );
    assert.equal(existsSync(publicOut), false);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});
