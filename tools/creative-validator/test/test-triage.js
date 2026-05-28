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
            scriptLoads: {
              count: 2,
              loadedCount: 1,
              errorCount: 1,
              byProtocol: {
                'https:': 1,
                'http:': 1,
              },
              byOrigin: {
                'https://cdn.example': 1,
                'http://127.0.0.1:18868': 1,
              },
              byStatus: {
                discovered: 2,
                loaded: 1,
                error: 1,
              },
            },
            documentSources: {
              count: 2,
              byKind: {
                frame: 1,
                'form-submit': 1,
              },
              byProtocol: {
                'https:': 1,
                unknown: 1,
              },
              byOrigin: {
                'https://click.example': 1,
                unknown: 1,
              },
              byTag: {
                iframe: 1,
                form: 1,
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
            byResourceType: {
              document: 1,
              script: 2,
            },
            byStatus: {
              404: 1,
            },
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
            scriptLoads: {
              count: 0,
              loadedCount: 0,
              errorCount: 0,
              byProtocol: {},
              byOrigin: {},
              byStatus: {},
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
          source: { ...report().case.source, bidder: 'bidder-c', rowIndex: 20 },
          ids: { bidId: 'bid-runtime-mraid', crid: 'creative-runtime-mraid' },
          creative: { admKind: 'html' },
          expectations: { declared: [], sniffed: [] },
          bidSignals: { ...report().case.bidSignals, apis: { sanitized: [] } },
        },
        outcome: { status: 'passed', bucket: 'passed' },
        diagnostics: {
          legacyMraidLoader: {
            requested: true,
            count: 1,
            loadedCount: 0,
            errorCount: 1,
            byStatus: { discovered: 1, error: 1 },
            signal: { declared: false, sniffed: false, runtimeOnly: true },
          },
        },
      }),
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, rowIndex: 21 },
          ids: { bidId: 'bid-declared-mraid', crid: 'creative-declared-mraid' },
        },
        outcome: { status: 'passed', bucket: 'passed' },
        diagnostics: {
          legacyMraidLoader: {
            requested: true,
            count: 1,
            loadedCount: 1,
            errorCount: 0,
            byStatus: { discovered: 1, loaded: 1 },
            signal: { declared: true, sniffed: false, runtimeOnly: false },
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
    assert.equal(summary.totals.reports, 9);
    assert.equal(summary.totals.passed, 3);
    assert.equal(summary.totals.failed, 4);
    assert.equal(summary.totals.skipped, 1);
    assert.equal(summary.totals.other, 1);
    assert.equal(
      summary.totals.passed + summary.totals.failed + summary.totals.skipped + summary.totals.other,
      summary.totals.reports,
    );
    assert.deepEqual(summary.byStatus, { failed: 4, passed: 3, error: 1, skipped: 1 });
    assert.equal(summary.byBucket['bridge-missing'], 4);
    assert.equal(summary.byBidder['bidder-a'], 7);
    assert.equal(summary.byMtype.banner, 9);
    assert.equal(summary.byAdmKind['html-mraid'], 7);
    assert.equal(summary.byApi['5'], 7);
    assert.equal(summary.byExpectedBridge.mraid, 7);
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
    assert.equal(summary.diagnostics.navigationSources.scriptLoadByCount['0'], 3);
    assert.equal(summary.diagnostics.navigationSources.scriptLoadByCount['2'], 1);
    assert.equal(summary.diagnostics.navigationSources.scriptLoadByLoadedCount['0'], 3);
    assert.equal(summary.diagnostics.navigationSources.scriptLoadByLoadedCount['1'], 1);
    assert.equal(summary.diagnostics.navigationSources.scriptLoadByErrorCount['0'], 3);
    assert.equal(summary.diagnostics.navigationSources.scriptLoadByErrorCount['1'], 1);
    assert.deepEqual(summary.diagnostics.navigationSources.scriptLoadByProtocol, {
      'http:': 1,
      'https:': 1,
    });
    assert.deepEqual(summary.diagnostics.navigationSources.scriptLoadByOrigin, {
      'http://127.0.0.1:18868': 1,
      'https://cdn.example': 1,
    });
    assert.deepEqual(summary.diagnostics.navigationSources.scriptLoadByStatus, {
      discovered: 2,
      error: 1,
      loaded: 1,
    });
    assert.equal(summary.diagnostics.network.byShape['request:1 response:0 cors:0 csp:1'], 1);
    assert.equal(summary.diagnostics.network.byShape['request:0 response:1 cors:1 csp:0'], 1);
    assert.equal(summary.diagnostics.network.byShape['request:0 response:0 cors:0 csp:0'], undefined);
    assert.equal(summary.diagnostics.network.byFailedRequestCount['1'], 1);
    assert.deepEqual(Object.keys(summary.diagnostics.network.byFailedRequestCount), ['0', '1', '2', '10']);
    assert.equal(summary.diagnostics.network.byFailedResponseCount['1'], 1);
    assert.deepEqual(Object.keys(summary.diagnostics.network.byFailedResponseCount), ['0', '1', '2', '10']);
    assert.equal(summary.diagnostics.network.byCorsConsoleCount['1'], 1);
    assert.equal(summary.diagnostics.network.byCspConsoleCount['1'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byPresence.present, 2);
    assert.equal(summary.diagnostics.legacyMraidLoader.byPresence.absent, 7);
    assert.equal(summary.diagnostics.legacyMraidLoader.bySignal['runtime-only'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.bySignal['declared-only'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byStatus.passed, 2);
    assert.equal(summary.diagnostics.legacyMraidLoader.byStatus.failed, undefined);
    assert.equal(summary.diagnostics.legacyMraidLoader.byBucket.passed, 2);
    assert.equal(summary.diagnostics.legacyMraidLoader.byBucket['bridge-missing'], undefined);
    assert.equal(summary.diagnostics.legacyMraidLoader.byBidder['bidder-a'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byBidder['bidder-c'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byAdmKind.html, 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byAdmKind['html-mraid'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byApi.none, 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byApi['5'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byErrorCount['0'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byErrorCount['1'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byLoadedCount['0'], 1);
    assert.equal(summary.diagnostics.legacyMraidLoader.byLoadedCount['1'], 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.rowsWithScripts, 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.rowsWithErrors, 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.rowsWithLoaded, 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByBidder['bidder-a'], 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByAdmKind['html-mraid'], 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByLegacyMraidLoader.absent, 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.byCount['2'], 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.byLoadedCount['1'], 1);
    assert.equal(summary.corpusDiagnostics.scriptLoads.byErrorCount['1'], 1);
    assert.deepEqual(summary.corpusDiagnostics.scriptLoads.byProtocol, {
      'http:': 1,
      'https:': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.scriptLoads.byOrigin, {
      'http://127.0.0.1:18868': 1,
      'https://cdn.example': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.scriptLoads.byStatus, {
      discovered: 2,
      error: 1,
      loaded: 1,
    });
    assert.equal(summary.corpusDiagnostics.network.rowsWithFailedRequests, 4);
    assert.equal(summary.corpusDiagnostics.network.rowsWithFailedResponses, 4);
    assert.equal(summary.corpusDiagnostics.network.rowsWithCorsConsole, 4);
    assert.equal(summary.corpusDiagnostics.network.rowsWithCspConsole, 4);
    assert.equal(summary.corpusDiagnostics.network.rowsWithFailedDocuments, 1);
    assert.equal(summary.corpusDiagnostics.network.rowsWithDocumentSources, 1);
    assert.equal(summary.corpusDiagnostics.network.documentSourceRowsByBidder['bidder-a'], 1);
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByKind, {
      'form-submit': 1,
      frame: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByProtocol, {
      'https:': 1,
      unknown: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByOrigin, {
      'https://click.example': 1,
      unknown: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByTag, {
      form: 1,
      iframe: 1,
    });
    assert.equal(summary.corpusDiagnostics.network.byShape['request:0 response:0 cors:0 csp:0'], 4);
    assert.equal(summary.corpusDiagnostics.network.byShape['request:10 response:10 cors:10 csp:10'], 2);
    assert.equal(summary.corpusDiagnostics.network.byFailedRequestCount['10'], 2);
    assert.equal(summary.corpusDiagnostics.network.byFailedResponseCount['10'], 2);
    assert.equal(summary.corpusDiagnostics.network.byCorsConsoleCount['10'], 2);
    assert.equal(summary.corpusDiagnostics.network.byCspConsoleCount['10'], 2);
    assert.equal(summary.corpusDiagnostics.network.failedRowsByBidder['bidder-a'], 4);
    assert.equal(summary.corpusDiagnostics.network.failedRowsByBidder['bidder-b'], 1);
    assert.equal(summary.corpusDiagnostics.network.failedRowsByAdmKind['html-mraid'], 4);
    assert.equal(summary.corpusDiagnostics.network.failedRowsByAdmKind.html, 1);
    assert.equal(summary.corpusDiagnostics.network.corsRowsByBidder['bidder-a'], 3);
    assert.equal(summary.corpusDiagnostics.network.cspRowsByBidder['bidder-a'], 3);
    assert.equal(summary.corpusDiagnostics.network.failedDocumentRowsByBidder['bidder-a'], 1);
    assert.deepEqual(summary.corpusDiagnostics.network.failedResourceType, {
      document: 1,
      script: 2,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.failedResponseStatus, {
      404: 1,
    });
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
