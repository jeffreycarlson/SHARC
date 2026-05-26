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
      report({
        diagnostics: {
          securityEvents: [{
            type: 'unauthorized_navigation',
            details: { variant: 'markup', msSinceRender: 125 },
          }],
          network: {
            failedRequestCount: 1,
            failedResponseCount: 0,
            corsConsoleCount: 0,
            cspConsoleCount: 1,
          },
          navigationDiagnostics: {
            documentWrite: {
              count: 2,
              patterns: {
                iframe: 1,
                location: 1,
                metaRefresh: 0,
              },
            },
            windowOpen: {
              count: 1,
              calls: [{
                url: { protocol: 'https:', origin: 'https://click.example' },
              }],
            },
            bridgeCalls: {
              count: 2,
              byMethod: {
                'mraid.open': 1,
                'sharc.requestNavigation': 1,
              },
              byProtocol: {
                'https:': 2,
              },
            },
          },
        },
      }),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, rowIndex: 1 },
          ids: { bidId: 'bid-2', crid: 'creative-2' },
        },
        diagnostics: {
          securityEvents: [
            {
              type: 'bridge_load_failed',
              details: { bridge: 'mraid' },
            },
            {
              type: 'renderer_failed',
              details: {},
            },
            {
              type: 'renderer_failed',
              details: {},
            },
          ],
          network: {
            failedRequestCount: 0,
            failedResponseCount: 1,
            corsConsoleCount: 1,
            cspConsoleCount: 0,
          },
          navigationDiagnostics: {
            documentWrite: {
              count: 0,
              patterns: {},
            },
            windowOpen: {
              count: 0,
              calls: [],
            },
            bridgeCalls: {
              count: 0,
              byMethod: {},
              byProtocol: {},
            },
          },
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
        diagnostics: {
          securityEvents: [{
            type: 'unauthorized_navigation',
            details: { variant: 'markup', msSinceRender: 250 },
          }],
          network: {
            failedRequestCount: 10,
            failedResponseCount: 10,
            corsConsoleCount: 10,
            cspConsoleCount: 10,
          },
        },
      }),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, rowIndex: 3 },
          ids: { bidId: 'bid-4', crid: 'creative-4' },
        },
        outcome: { status: 'error', bucket: 'unknown' },
      }),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, rowIndex: 4 },
          ids: { bidId: 'bid-5', crid: 'creative-5' },
        },
        diagnostics: {
          securityEvents: [],
          network: {
            failedRequestCount: 2,
            failedResponseCount: 2,
            corsConsoleCount: 2,
            cspConsoleCount: 2,
          },
        },
      }),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, rowIndex: 5 },
          ids: { bidId: 'bid-6', crid: 'creative-6' },
        },
        diagnostics: {
          securityEvents: [],
          network: {
            failedRequestCount: 10,
            failedResponseCount: 10,
            corsConsoleCount: 10,
            cspConsoleCount: 10,
          },
        },
      }),
    ]);

    const summary = triageReports([reportPath]);
    assert.equal(summary.totals.reports, 7);
    assert.equal(summary.totals.passed, 1);
    assert.equal(summary.totals.failed, 4);
    assert.equal(summary.totals.skipped, 1);
    assert.equal(summary.totals.other, 1);
    assert.equal(
      summary.totals.passed + summary.totals.failed + summary.totals.skipped + summary.totals.other,
      summary.totals.reports,
    );
    assert.deepEqual(summary.byStatus, { failed: 4, error: 1, passed: 1, skipped: 1 });
    assert.equal(summary.byBucket['bridge-missing'], 4);
    assert.equal(summary.byBidder['bidder-a'], 6);
    assert.equal(summary.byMtype.banner, 7);
    assert.equal(summary.byAdmKind['html-mraid'], 6);
    assert.equal(summary.byApi['5'], 6);
    assert.equal(summary.byExpectedBridge.mraid, 6);
    assert.equal(summary.diagnostics.bySecurityEvent.unauthorized_navigation, 1);
    assert.equal(summary.diagnostics.bySecurityEvent.bridge_load_failed, 1);
    assert.equal(summary.diagnostics.bySecurityEvent.renderer_failed, 2);
    assert.equal(summary.diagnostics.bySecurityEventSet.unauthorized_navigation, 1);
    assert.equal(summary.diagnostics.bySecurityEventSet['bridge_load_failed,renderer_failed'], 1);
    assert.equal(summary.diagnostics.bySecurityEventSet.none, 2);
    assert.equal(summary.diagnostics.unauthorizedNavigation.byVariant.markup, 1);
    assert.equal(summary.diagnostics.unauthorizedNavigation.byMsSinceRender['100-499ms'], 1);
    assert.equal(summary.diagnostics.navigationSources.documentWriteByCount['0'], 3);
    assert.equal(summary.diagnostics.navigationSources.documentWriteByCount['2'], 1);
    assert.deepEqual(summary.diagnostics.navigationSources.documentWriteByPattern, {
      iframe: 1,
      location: 1,
    });
    assert.equal(summary.diagnostics.navigationSources.windowOpenByCount['0'], 3);
    assert.equal(summary.diagnostics.navigationSources.windowOpenByCount['1'], 1);
    assert.deepEqual(summary.diagnostics.navigationSources.windowOpenByProtocol, { 'https:': 1 });
    assert.equal(summary.diagnostics.navigationSources.bridgeCallByCount['0'], 3);
    assert.equal(summary.diagnostics.navigationSources.bridgeCallByCount['2'], 1);
    assert.deepEqual(summary.diagnostics.navigationSources.bridgeCallByMethod, {
      'mraid.open': 1,
      'sharc.requestNavigation': 1,
    });
    assert.deepEqual(summary.diagnostics.navigationSources.bridgeCallByProtocol, { 'https:': 2 });
    assert.equal(summary.diagnostics.network.byShape['request:1 response:0 cors:0 csp:1'], 1);
    assert.equal(summary.diagnostics.network.byShape['request:0 response:1 cors:1 csp:0'], 1);
    assert.equal(summary.diagnostics.network.byShape['request:0 response:0 cors:0 csp:0'], undefined);
    assert.equal(summary.diagnostics.network.byFailedRequestCount['1'], 1);
    assert.deepEqual(Object.keys(summary.diagnostics.network.byFailedRequestCount), ['0', '1', '2', '10']);
    assert.equal(summary.diagnostics.network.byFailedResponseCount['1'], 1);
    assert.deepEqual(Object.keys(summary.diagnostics.network.byFailedResponseCount), ['0', '1', '2', '10']);
    assert.equal(summary.diagnostics.network.byCorsConsoleCount['1'], 1);
    assert.equal(summary.diagnostics.network.byCspConsoleCount['1'], 1);
    assert.equal(summary.failureGroups.length, 1);
    assert.equal(summary.failureGroups[0].bucket, 'bridge-missing');
    assert.equal(summary.failureGroups[0].count, 4);
    assert.equal(summary.failureGroups[0].samples.length, 4);
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
