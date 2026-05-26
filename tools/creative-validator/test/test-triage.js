#!/usr/bin/env node

/**
 * test-triage.js — creative validator Phase 6 triage coverage.
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
import { triageReports } from '../src/triage.js';

const cliPath = resolve('tools/creative-validator/src/cli.js');

function report(overrides = {}) {
  return {
    case: {
      source: {
        sourceFile: 'synthetic-report.jsonl',
        rowIndex: 0,
        bidder: 'bidder-a',
        mtype: 'banner',
      },
      ids: {
        bidId: 'bid-1',
        crid: 'creative-1',
      },
      creative: {
        admKind: 'html-mraid',
      },
      expectations: {
        declared: ['mraid'],
        sniffed: [],
      },
      bidSignals: {
        apis: { sanitized: [5] },
        mtype: 'banner',
        measurement: { omid: { declaredByApi: false, sidecarPresent: false } },
      },
    },
    outcome: {
      status: 'failed',
      bucket: 'bridge-missing',
    },
    diagnostics: {},
    ...overrides,
  };
}

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('triageReports groups private report rows by failure dimensions', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-'));
  const reportPath = resolve(workDir, 'report.jsonl');

  try {
    writeJsonl(reportPath, [
      report({ outcome: { status: 'passed', bucket: 'passed' } }),
      report(),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, rowIndex: 1 },
          ids: { bidId: 'bid-2', crid: 'creative-2' },
        },
      }),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-b', rowIndex: 2 },
          ids: { bidId: 'bid-3', crid: 'creative-3' },
          creative: { admKind: 'html' },
          expectations: { declared: [], sniffed: [] },
          bidSignals: { ...report().case.bidSignals, apis: { sanitized: [] } },
        },
        outcome: { status: 'skipped', bucket: 'unsupported-input' },
      }),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, rowIndex: 3 },
          ids: { bidId: 'bid-4', crid: 'creative-4' },
        },
        outcome: { status: 'error', bucket: 'unknown' },
      }),
    ]);

    const summary = triageReports([reportPath]);
    assert.equal(summary.totals.reports, 5);
    assert.equal(summary.totals.passed, 1);
    assert.equal(summary.totals.failed, 2);
    assert.equal(summary.totals.skipped, 1);
    assert.equal(summary.totals.other, 1);
    assert.equal(
      summary.totals.passed + summary.totals.failed + summary.totals.skipped + summary.totals.other,
      summary.totals.reports,
    );
    assert.deepEqual(summary.byStatus, { failed: 2, error: 1, passed: 1, skipped: 1 });
    assert.equal(summary.byBucket['bridge-missing'], 2);
    assert.equal(summary.byBidder['bidder-a'], 4);
    assert.equal(summary.byMtype.banner, 5);
    assert.equal(summary.byAdmKind['html-mraid'], 4);
    assert.equal(summary.byApi['5'], 4);
    assert.equal(summary.byExpectedBridge.mraid, 4);
    assert.equal(summary.failureGroups.length, 1);
    assert.equal(summary.failureGroups[0].bucket, 'bridge-missing');
    assert.equal(summary.failureGroups[0].count, 2);
    assert.equal(summary.failureGroups[0].samples.length, 2);
    assert.equal(summary.reductionCandidates.length, 1);
    assert.equal(summary.reductionCandidates[0].bucket, 'bridge-missing');
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('triage CLI writes private summary and rejects public output by default', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-cli-'));
  const reportPath = resolve(workDir, 'report.jsonl');
  const outPath = resolve(workDir, 'summary.json');
  const publicOut = resolve('tools/creative-validator/fixtures/triage-summary.json');

  try {
    writeJsonl(reportPath, [report()]);
    execFileSync('node', [cliPath, 'triage', reportPath, '--out', outPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const summary = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(summary.totals.reports, 1);
    assert.equal(summary.failureGroups[0].bucket, 'bridge-missing');

    assert.throws(
      () => execFileSync('node', [cliPath, 'triage', reportPath, '--out', publicOut], {
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
