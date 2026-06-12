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
      report({
        outcome: { status: 'passed', bucket: 'passed' },
        diagnostics: {
          navigationDiagnostics: {
            bridgeCalls: {
              count: 0,
              byMethod: {},
              byProtocol: {},
            },
            // #222 corpus invariant: validator self-probes must stay out of
            // creative bridge-call facets. `mraid.expand` is probe-only in
            // this fixture, so its presence below would indicate probe bleed.
            probeBridgeCalls: {
              count: 3,
              byMethod: {
                'mraid.open': 1,
                'mraid.expand': 1,
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
            scriptCache: {
              enabled: true,
              lookups: 2,
              hits: 1,
              misses: 1,
              stores: 1,
              skipped: 0,
              errors: 0,
              bytesFromNetwork: 1200,
              bytesFromCache: 1200,
              byOrigin: {
                'https://cdn.example': {
                  lookups: 2,
                  hits: 1,
                  misses: 1,
                  stores: 1,
                  bytesFromNetwork: 1200,
                  bytesFromCache: 1200,
                },
              },
            },
          },
          failedRequests: [{
            url: 'https://cdn.example/tag.js',
            resourceType: 'script',
            errorText: 'net::ERR_ABORTED',
          }],
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
              count: 4,
              byKind: {
                frame: 2,
                'frame-src': 1,
                'form-submit': 1,
              },
              byProtocol: {
                'about:': 1,
                'http:': 1,
                'https:': 1,
                unknown: 1,
              },
              byOrigin: {
                'about:blank': 1,
                'http://frame.example': 1,
                'https://click.example': 1,
                unknown: 1,
              },
              byTag: {
                iframe: 3,
                form: 1,
              },
              calls: [
                {
                  kind: 'frame',
                  tagName: 'iframe',
                  url: { present: true, protocol: 'https:', origin: 'https://click.example' },
                  srcdoc: false,
                },
                {
                  kind: 'form-submit',
                  tagName: 'form',
                  url: { present: false, protocol: null, origin: null },
                  assignedUrl: null,
                  srcdoc: false,
                },
                {
                  kind: 'frame-src',
                  tagName: 'iframe',
                  url: { present: true, protocol: 'http:', origin: 'http://frame.example' },
                  assignedUrl: { present: true, protocol: 'http:', origin: 'http://frame.example' },
                  assignment: 'property',
                  srcdoc: false,
                },
                {
                  kind: 'frame',
                  tagName: 'iframe',
                  url: { present: true, protocol: 'about:', origin: 'about:blank' },
                  srcdoc: true,
                },
              ],
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
            scriptCache: {
              enabled: true,
              lookups: 1,
              hits: 0,
              misses: 1,
              stores: 1,
              skipped: 1,
              errors: 0,
              bytesFromNetwork: 800,
              bytesFromCache: 0,
              byOrigin: {
                'https://cdn.example': {
                  lookups: 1,
                  hits: 0,
                  misses: 1,
                  stores: 1,
                  bytesFromNetwork: 800,
                  bytesFromCache: 0,
                },
              },
            },
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
    assert.equal(summary.diagnostics.navigationSources.bridgeCallByMethod['mraid.expand'], undefined);
    assert.equal(summary.diagnostics.navigationSources.bridgeCallByCount['3'], undefined);
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
    assert.deepEqual(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByClass, {
      'external-script-aborted': 1,
      'script-csp-blocked': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.scriptLoads.errorEventsByClass, {
      'external-script-aborted': 1,
      'script-csp-blocked': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.scriptLoads.errorRowsByClassAndBidder, {
      'external-script-aborted|bidder-a': 1,
      'script-csp-blocked|bidder-a': 1,
    });
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
      'frame-src': 1,
      'form-submit': 1,
      frame: 2,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByProtocol, {
      'about:': 1,
      'http:': 1,
      'https:': 1,
      unknown: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByOrigin, {
      'about:blank': 1,
      'http://frame.example': 1,
      'https://click.example': 1,
      unknown: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByTag, {
      form: 1,
      iframe: 3,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourceRowsByClass, {
      'blank-or-opaque-document': 1,
      'external-frame': 1,
      'frame-src-assignment': 1,
      'form-source': 1,
      'insecure-frame': 1,
      'observed-frame': 1,
      'secure-frame': 1,
      'srcdoc-frame': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourceEventsByClass, {
      'blank-or-opaque-document': 1,
      'external-frame': 2,
      'frame-src-assignment': 1,
      'form-source': 1,
      'insecure-frame': 1,
      'observed-frame': 2,
      'secure-frame': 1,
      'srcdoc-frame': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourceRowsByClassAndBidder, {
      'blank-or-opaque-document|bidder-a': 1,
      'external-frame|bidder-a': 1,
      'frame-src-assignment|bidder-a': 1,
      'form-source|bidder-a': 1,
      'insecure-frame|bidder-a': 1,
      'observed-frame|bidder-a': 1,
      'secure-frame|bidder-a': 1,
      'srcdoc-frame|bidder-a': 1,
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
    assert.equal(summary.corpusDiagnostics.network.scriptCache.rowsEnabled, 2);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.rowsWithHits, 1);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.rowsWithStores, 2);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.lookups, 3);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.hits, 1);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.misses, 2);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.stores, 2);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.skipped, 1);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.bytesFromNetwork, 2000);
    assert.equal(summary.corpusDiagnostics.network.scriptCache.bytesFromCache, 1200);
    assert.deepEqual(summary.corpusDiagnostics.network.scriptCache.byOrigin, {
      'https://cdn.example': {
        lookups: 3,
        hits: 1,
        misses: 2,
        stores: 2,
        bytesFromNetwork: 2000,
        bytesFromCache: 1200,
      },
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

test('triageReports covers every script error diagnostic class', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-script-classes-'));
  const reportPath = resolve(workDir, 'report.jsonl');
  const scriptDiagnostics = (overrides = {}) => ({
    network: {
      failedRequestCount: 0,
      failedResponseCount: 0,
      corsConsoleCount: 0,
      cspConsoleCount: 0,
      ...(overrides.network || {}),
    },
    navigationDiagnostics: {
      scriptLoads: {
        count: 1,
        loadedCount: 0,
        errorCount: 1,
        byProtocol: { 'https:': 1 },
        byOrigin: { 'https://cdn.example': 1 },
        byStatus: { discovered: 1, error: 1 },
        ...(overrides.scriptLoads || {}),
      },
    },
    failedRequests: overrides.failedRequests || [],
    failedResponses: overrides.failedResponses || [],
    legacyMraidLoader: overrides.legacyMraidLoader,
  });
  const scriptReport = (id, diagnostics) => report({
    case: {
      ...report().case,
      source: { ...report().case.source, bidder: 'bidder-script', rowIndex: id },
      ids: { bidId: `bid-script-${id}`, crid: `creative-script-${id}` },
    },
    outcome: { status: 'passed', bucket: 'passed' },
    diagnostics,
  });

  try {
    writeJsonl(reportPath, [
      scriptReport(1, scriptDiagnostics({
        network: { failedRequestCount: 1, cspConsoleCount: 1 },
        failedRequests: [{
          url: 'https://cdn.example/aborted.js',
          resourceType: 'script',
          errorText: 'net::ERR_ABORTED',
        }],
      })),
      scriptReport(2, scriptDiagnostics({
        network: { failedRequestCount: 1 },
        failedRequests: [{
          url: 'https://missing.example/dns.js',
          resourceType: 'script',
          errorText: 'net::ERR_NAME_NOT_RESOLVED',
        }],
      })),
      scriptReport(3, scriptDiagnostics({
        network: { failedRequestCount: 1 },
        failedRequests: [{
          url: 'https://cdn.example/transport.js',
          resourceType: 'script',
          errorText: 'net::ERR_FAILED',
        }],
      })),
      scriptReport(4, scriptDiagnostics({
        network: { failedResponseCount: 1 },
        failedResponses: [{
          url: 'https://cdn.example/missing.js',
          resourceType: 'script',
          status: 404,
        }],
      })),
      scriptReport(5, scriptDiagnostics({
        scriptLoads: {
          count: 1,
          loadedCount: 0,
          errorCount: 2,
          byProtocol: { 'http:': 1 },
          byOrigin: { 'http://localhost:18866': 1 },
          byStatus: { discovered: 1, error: 2 },
        },
        legacyMraidLoader: {
          requested: true,
          count: 1,
          loadedCount: 0,
          errorCount: 2,
          byStatus: { discovered: 1, error: 2 },
          signal: { declared: true, sniffed: true, runtimeOnly: false },
        },
      })),
      scriptReport(6, scriptDiagnostics()),
    ]);

    const classes = triageReports([reportPath]).corpusDiagnostics.scriptLoads;
    assert.deepEqual(classes.rowsWithErrorsByClass, {
      'external-script-aborted': 1,
      'external-script-dns': 1,
      'external-script-http': 1,
      'external-script-transport': 1,
      'legacy-mraid-loader': 1,
      'script-csp-blocked': 1,
      'script-load-event': 1,
    });
    assert.deepEqual(classes.errorEventsByClass, {
      'external-script-aborted': 1,
      'external-script-dns': 1,
      'external-script-http': 1,
      'external-script-transport': 1,
      'legacy-mraid-loader': 2,
      'script-csp-blocked': 1,
      'script-load-event': 1,
    });
    assert.equal(classes.errorRowsByClassAndBidder['external-script-aborted|bidder-script'], 1);
    assert.equal(classes.errorRowsByClassAndBidder['external-script-dns|bidder-script'], 1);
    assert.equal(classes.errorRowsByClassAndBidder['external-script-http|bidder-script'], 1);
    assert.equal(classes.errorRowsByClassAndBidder['external-script-transport|bidder-script'], 1);
    assert.equal(classes.errorRowsByClassAndBidder['legacy-mraid-loader|bidder-script'], 1);
    assert.equal(classes.errorRowsByClassAndBidder['script-csp-blocked|bidder-script'], 1);
    assert.equal(classes.errorRowsByClassAndBidder['script-load-event|bidder-script'], 1);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

function omidReport(omid, overrides = {}) {
  return report({
    diagnostics: { measurement: { omid } },
    ...overrides,
  });
}

test('triageReports aggregates OMID capability and sidecar outcomes', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-omid-'));
  const reportPath = resolve(workDir, 'report.jsonl');

  try {
    writeJsonl(reportPath, [
      // Capability-declared row reaching a finished session.
      omidReport({
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: true,
        sessionFinished: true,
        loadedFired: true,
        impressionFired: true,
        verificationScriptCount: 2,
        inlineVendor: {
          expected: true,
          accessMode: 'limited',
          omid3pFound: true,
          subscriptionObserved: true,
          expectedVendorSubscriptionObserved: true,
          registerSessionObserverCalls: 1,
          addEventListenerCalls: 0,
          expectedVendorRegisterSessionObserverCalls: 1,
          expectedVendorAddEventListenerCalls: 0,
          callbackEvents: 3,
          callbackEventsByType: { geometryChange: 2 },
          callsBySourceVendor: { doubleverify: 1 },
          callsBySourceOrigin: { 'https://cdn.doubleverify.com': 1 },
          unattributedCallsBySourceVendor: {},
          unattributedCallsBySourceOrigin: {},
          lifecycleObserved: true,
          lifecycleComplete: true,
          lifecycleNotObserved: false,
          passed: true,
          diagnosticOutcome: 'expected-vendor-lifecycle',
        },
      }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-a', rowIndex: 0 },
          bidSignals: {
            ...report().case.bidSignals,
            measurement: {
              omid: {
                declaredByApi: true,
                sidecarPresent: true,
                inlineVendorScriptPresent: true,
                inlineVendorScriptCount: 1,
                inlineVendorVendors: ['doubleverify'],
              },
            },
          },
        },
        outcome: { status: 'passed', bucket: 'passed', durationMs: 3000 },
        diagnostics: {
          measurement: {
            omid: {
              expected: true,
              sidecarPresent: true,
              extensionPresent: true,
              featureAdvertised: true,
              sessionStarted: true,
              sessionFinished: true,
              loadedFired: true,
              impressionFired: true,
              verificationScriptCount: 2,
              inlineVendor: {
                expected: true,
                accessMode: 'limited',
                omid3pFound: true,
                subscriptionObserved: true,
                expectedVendorSubscriptionObserved: true,
                registerSessionObserverCalls: 1,
                addEventListenerCalls: 0,
                expectedVendorRegisterSessionObserverCalls: 1,
                expectedVendorAddEventListenerCalls: 0,
                callbackEvents: 3,
                callbackEventsByType: { geometryChange: 2 },
                callsBySourceVendor: { doubleverify: 1 },
                callsBySourceOrigin: { 'https://cdn.doubleverify.com': 1 },
                unattributedCallsBySourceVendor: {},
                unattributedCallsBySourceOrigin: {},
                lifecycleObserved: true,
                lifecycleComplete: true,
                lifecycleNotObserved: false,
                passed: true,
                diagnosticOutcome: 'expected-vendor-lifecycle',
              },
            },
          },
          network: {
            scriptCache: {
              enabled: true,
              byOrigin: {
                'https://cdn.doubleverify.com': { stores: 1, bytesFromNetwork: 1000 },
              },
            },
          },
        },
      }),
      // Capability-declared row that installs the extension but never starts a session.
      omidReport({
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: false,
        sessionFinished: false,
        loadedFired: false,
        impressionFired: false,
        verificationScriptCount: 1,
        inlineVendor: {
          expected: true,
          accessMode: 'limited',
          omid3pFound: true,
          subscriptionObserved: false,
          expectedVendorSubscriptionObserved: false,
          registerSessionObserverCalls: 0,
          addEventListenerCalls: 0,
          expectedVendorRegisterSessionObserverCalls: 0,
          expectedVendorAddEventListenerCalls: 0,
          callbackEvents: 0,
          callsBySourceVendor: {},
          callsBySourceOrigin: {},
          unattributedCallsBySourceVendor: {},
          unattributedCallsBySourceOrigin: {},
          lifecycleObserved: false,
          lifecycleComplete: false,
          lifecycleNotObserved: false,
          passed: false,
          diagnosticOutcome: 'no-subscription',
        },
      }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-b', rowIndex: 1 },
          bidSignals: {
            ...report().case.bidSignals,
            measurement: {
              omid: {
                declaredByApi: true,
                sidecarPresent: true,
                inlineVendorScriptPresent: true,
                inlineVendorScriptCount: 1,
                inlineVendorVendors: ['doubleverify'],
              },
            },
          },
        },
        outcome: { status: 'failed', bucket: 'measurement-omid', durationMs: 4000 },
        diagnostics: {
          measurement: {
            omid: {
              expected: true,
              sidecarPresent: true,
              extensionPresent: true,
              featureAdvertised: true,
              sessionStarted: false,
              sessionFinished: false,
              loadedFired: false,
              impressionFired: false,
              verificationScriptCount: 1,
              inlineVendor: {
                expected: true,
                accessMode: 'limited',
                omid3pFound: true,
                subscriptionObserved: false,
                expectedVendorSubscriptionObserved: false,
                registerSessionObserverCalls: 0,
                addEventListenerCalls: 0,
                expectedVendorRegisterSessionObserverCalls: 0,
                expectedVendorAddEventListenerCalls: 0,
                callbackEvents: 0,
                callsBySourceVendor: {},
                callsBySourceOrigin: {},
                unattributedCallsBySourceVendor: {},
                unattributedCallsBySourceOrigin: {},
                lifecycleObserved: false,
                lifecycleComplete: false,
                lifecycleNotObserved: false,
                passed: false,
                diagnosticOutcome: 'no-subscription',
              },
            },
          },
          network: {
            scriptCache: {
              enabled: true,
              byOrigin: {
                'https://cdn.doubleverify.com': { hits: 1, bytesFromCache: 1000 },
              },
            },
          },
        },
      }),
      // Capability-declared row whose extension installs but never advertises the OMID feature.
      omidReport({
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: false,
        sessionStarted: false,
        sessionFinished: false,
        loadedFired: false,
        impressionFired: false,
        verificationScriptCount: 1,
      }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-e', rowIndex: 4 },
        },
        outcome: { status: 'failed', bucket: 'measurement-omid' },
      }),
      // Capability-only row with no sidecar fields beyond `expected`.
      omidReport({ expected: true }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-f', rowIndex: 5 },
        },
        outcome: { status: 'failed', bucket: 'measurement-omid' },
      }),
      // Non-capability row: present omid object but expected === false.
      omidReport({
        expected: false,
        sidecarPresent: false,
        extensionPresent: false,
        featureAdvertised: false,
        sessionStarted: false,
        sessionFinished: false,
        loadedFired: false,
        impressionFired: false,
        verificationScriptCount: 0,
        inlineVendor: {
          expected: true,
          accessMode: 'full',
          omid3pFound: true,
          subscriptionObserved: true,
          expectedVendorSubscriptionObserved: true,
          registerSessionObserverCalls: 0,
          addEventListenerCalls: 4,
          expectedVendorRegisterSessionObserverCalls: 0,
          expectedVendorAddEventListenerCalls: 1,
          callbackEvents: 0,
          lifecycleObserved: false,
          lifecycleComplete: false,
          lifecycleNotObserved: true,
          callsBySourceVendor: { unknown: 4 },
          callsBySourceOrigin: { 'https://cadmus2.script.ac': 4 },
          unattributedCallsBySourceVendor: { unknown: 4 },
          unattributedCallsBySourceOrigin: { 'https://cadmus2.script.ac': 4 },
          passed: false,
          diagnosticOutcome: 'unattributed-no-lifecycle',
        },
      }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-c', rowIndex: 2 },
          bidSignals: {
            ...report().case.bidSignals,
            measurement: {
              omid: {
                declaredByApi: false,
                sidecarPresent: false,
                inlineVendorScriptPresent: true,
                inlineVendorScriptCount: 2,
                inlineVendorVendors: ['ias', 'moat'],
              },
            },
          },
        },
        outcome: { status: 'passed', bucket: 'passed', durationMs: 6000 },
        diagnostics: {
          measurement: {
            omid: {
              expected: false,
              sidecarPresent: false,
              extensionPresent: false,
              featureAdvertised: false,
              sessionStarted: false,
              sessionFinished: false,
              loadedFired: false,
              impressionFired: false,
              verificationScriptCount: 0,
              inlineVendor: {
                expected: true,
                accessMode: 'full',
                omid3pFound: true,
                subscriptionObserved: true,
                expectedVendorSubscriptionObserved: true,
                registerSessionObserverCalls: 0,
                addEventListenerCalls: 4,
                expectedVendorRegisterSessionObserverCalls: 0,
                expectedVendorAddEventListenerCalls: 1,
                callbackEvents: 0,
                lifecycleObserved: false,
                lifecycleComplete: false,
                lifecycleNotObserved: true,
                callsBySourceVendor: { unknown: 4 },
                callsBySourceOrigin: { 'https://cadmus2.script.ac': 4 },
                unattributedCallsBySourceVendor: { unknown: 4 },
                unattributedCallsBySourceOrigin: { 'https://cadmus2.script.ac': 4 },
                passed: false,
                diagnosticOutcome: 'unattributed-no-lifecycle',
              },
            },
          },
          network: {
            scriptCache: {
              enabled: true,
              byOrigin: {
                'https://cdn.integralads.com': { stores: 1, bytesFromNetwork: 1000 },
              },
            },
          },
        },
      }),
      // Row with no measurement diagnostics at all.
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-d', rowIndex: 3 },
        },
        outcome: { status: 'passed', bucket: 'passed' },
        diagnostics: {},
      }),
      // Bidstream-declared OMID row without runtime OMID diagnostics: counts as
      // declared capability, but does not enter runtime outcome buckets.
      report({
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-g', rowIndex: 6 },
          bidSignals: {
            ...report().case.bidSignals,
            measurement: {
              omid: {
                declaredByApi: true,
                sidecarPresent: false,
                inlineVendorScriptPresent: false,
                inlineVendorScriptCount: 0,
                inlineVendorScanTruncated: true,
                inlineVendorScriptTagLimitReached: true,
              },
            },
          },
        },
        outcome: { status: 'skipped', bucket: 'unsupported-input' },
        diagnostics: {},
      }),
    ]);

    const summary = triageReports([reportPath]);
    const omid = summary.corpusDiagnostics.omid;
    assert.equal(omid.rows, 7);
    assert.equal(omid.rowsCapabilityDeclared, 5);
    assert.equal(omid.rowsInlineInstrumented, 3);
    assert.equal(omid.rowsCapabilityDeclaredInlineInstrumented, 2);
    assert.equal(omid.rowsInlineInstrumentedWithoutCapability, 1);
    assert.equal(omid.rowsAbsent, 1);
    assert.equal(omid.rowsScanTruncated, 1);
    assert.equal(omid.rowsTagLimitReached, 1);
    assert.equal(omid.rowsWithSidecar, 3);
    assert.equal(omid.rowsWithExtension, 3);
    assert.equal(omid.rowsFeatureAdvertised, 2);
    assert.equal(omid.rowsSessionStarted, 1);
    assert.equal(omid.rowsSessionFinished, 1);
    assert.equal(omid.rowsLoadedFired, 1);
    assert.equal(omid.rowsImpressionFired, 1);
    assert.deepEqual(omid.byOutcome, {
      'capability-no-sidecar': 1,
      'extension-no-feature': 1,
      'feature-no-session': 1,
      'session-finished': 1,
    });
    assert.deepEqual(omid.byInstrumentationSignal, {
      absent: 1,
      'declared-api7+inline-vendor': 2,
      'declared-api7-only': 3,
      'inline-vendor-only': 1,
    });
    assert.deepEqual(omid.byInlineVendorScriptCount, { 1: 2, 2: 1 });
    assert.deepEqual(omid.inlineVendorRowsByVendor, {
      doubleverify: 2,
      ias: 1,
      moat: 1,
    });
    assert.deepEqual(omid.inlineVendorRowsByBidder, {
      'bidder-omid-a': 1,
      'bidder-omid-b': 1,
      'bidder-omid-c': 1,
    });
    assert.deepEqual(omid.inlineVendorRowsByAccessMode, {
      full: 1,
      limited: 2,
    });
    assert.deepEqual(omid.inlineVendorRowsByRuntimeOutcome, {
      'omid3p-no-subscription': 1,
      'observed-lifecycle': 1,
      'subscribed-no-lifecycle': 1,
    });
    assert.deepEqual(omid.inlineVendorRowsByDiagnosticOutcome, {
      'expected-vendor-lifecycle': 1,
      'no-subscription': 1,
      'unattributed-no-lifecycle': 1,
    });
    assert.deepEqual(omid.inlineVendorRowsByLifecycleObservation, {
      complete: 1,
      'not-applicable': 1,
      'subscribed-none': 1,
    });
    assert.deepEqual(omid.inlineVendorRowsByExpectedAttribution, {
      'expected-vendor': 2,
      none: 1,
    });
    assert.deepEqual(omid.inlineVendorRowsByExpectedScriptCache, {
      'expected-script-cache-no-subscription': 1,
      'expected-script-cache-subscribed': 2,
    });
    assert.equal(omid.inlineVendorExpectedScriptCacheNoSubscriptionRows, 1);
    assert.deepEqual(omid.inlineVendorSubscriptionCallsBySourceVendor, {
      doubleverify: 1,
      unknown: 4,
    });
    assert.deepEqual(omid.inlineVendorSubscriptionCallsBySourceOrigin, {
      'https://cadmus2.script.ac': 4,
      'https://cdn.doubleverify.com': 1,
    });
    assert.deepEqual(omid.inlineVendorUnattributedCallsBySourceVendor, {
      unknown: 4,
    });
    assert.deepEqual(omid.inlineVendorUnattributedCallsBySourceOrigin, {
      'https://cadmus2.script.ac': 4,
    });
    assert.deepEqual(omid.inlineVendorUnattributedRowsBySourceVendor, {
      unknown: 1,
    });
    assert.deepEqual(omid.inlineVendorUnattributedRowsBySourceOrigin, {
      'https://cadmus2.script.ac': 1,
    });
    assert.deepEqual(omid.inlineVendorSubscriptionCap, {
      unit: 'cumulative-register-calls-per-session',
      rowsMeasured: 3,
      median: 1,
      p99: 4,
      max: 4,
      byCumulativeRegisterCallCount: {
        0: 1,
        1: 1,
        4: 1,
      },
    });
    assert.deepEqual(omid.inlineVendorSessionProfile, {
      rowsMeasured: 3,
      durationMs: {
        median: 4000,
        p99: 6000,
        max: 6000,
        byCount: {
          3000: 1,
          4000: 1,
          6000: 1,
        },
      },
      geometryChangeCallbacks: {
        median: 0,
        p99: 2,
        max: 2,
        byCount: {
          0: 2,
          2: 1,
        },
      },
    });
    assert.deepEqual(omid.byVerificationScriptCount, { 0: 1, 1: 2, 2: 1 });
    assert.deepEqual(omid.capabilityRowsByBidder, {
      'bidder-omid-a': 1,
      'bidder-omid-b': 1,
      'bidder-omid-e': 1,
      'bidder-omid-f': 1,
    });
    assert.deepEqual(omid.capabilityNoSidecarRowsByBidder, {
      'bidder-omid-f': 1,
    });
    assert.deepEqual(omid.sidecarRowsByBidder, {
      'bidder-omid-a': 1,
      'bidder-omid-b': 1,
      'bidder-omid-e': 1,
    });
    assert.deepEqual(omid.sessionNotStartedRowsByBidder, {
      'bidder-omid-b': 1,
      'bidder-omid-e': 1,
    });
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

function omidLifecycleReport(bidder, omid, declaredByApi) {
  const base = report();
  return omidReport(omid, {
    case: {
      ...base.case,
      source: { ...base.case.source, bidder },
      bidSignals: {
        ...base.case.bidSignals,
        measurement: { omid: { declaredByApi, sidecarPresent: omid.sidecarPresent === true } },
      },
    },
    outcome: { status: 'failed', bucket: 'omid-lifecycle' },
  });
}

test('triageReports aggregates OMID lifecycle evidence by declared-vs-runtime and bidder (#211 Part B)', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-omid-lifecycle-'));
  const reportPath = resolve(workDir, 'report.jsonl');

  try {
    writeJsonl(reportPath, [
      // Declared via API, ran, full lifecycle observed.
      omidLifecycleReport('bidder-omid-a', {
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: true,
        sessionFinished: true,
        loadedFired: true,
        impressionFired: true,
        verificationScriptCount: 1,
      }, true),
      // Declared via API, ran, session started but never finished and never fired loaded.
      omidLifecycleReport('bidder-omid-b', {
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: true,
        sessionFinished: false,
        loadedFired: false,
        impressionFired: false,
        verificationScriptCount: 1,
      }, true),
      // Declared via API, ran, session never started (lifecycle stall).
      omidLifecycleReport('bidder-omid-b', {
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: false,
        sessionFinished: false,
        loadedFired: false,
        impressionFired: false,
        verificationScriptCount: 1,
      }, true),
      // Runtime lifecycle observed without an API declaration or runner expectation.
      omidLifecycleReport('bidder-omid-c', {
        expected: false,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: true,
        sessionFinished: true,
        loadedFired: true,
        impressionFired: true,
        verificationScriptCount: 0,
      }, false),
      // No OMID evidence at all.
      omidLifecycleReport('bidder-omid-d', {
        expected: false,
        sidecarPresent: false,
        extensionPresent: false,
        featureAdvertised: false,
        sessionStarted: false,
        sessionFinished: false,
        loadedFired: false,
        impressionFired: false,
        verificationScriptCount: 0,
      }, false),
    ]);

    const summary = triageReports([reportPath]);
    const lifecycle = summary.corpusDiagnostics.omid.lifecycle;

    assert.deepEqual(lifecycle.byDeclaredVsRuntime, {
      'declared+runtime': 2,
      'declared-no-runtime': 1,
      'runtime-no-declared': 1,
      neither: 1,
    });
    // Session-start outcome only counts declared-capability rows that ran an
    // OMID pass, so the runtime-no-declared row (bidder-omid-c) is excluded.
    assert.deepEqual(lifecycle.bySessionStartOutcome, {
      started: 2,
      'not-started': 1,
    });
    assert.deepEqual(lifecycle.loadedFiredRowsByBidder, {
      'bidder-omid-a': 1,
      'bidder-omid-c': 1,
    });
    assert.deepEqual(lifecycle.impressionFiredRowsByBidder, {
      'bidder-omid-a': 1,
      'bidder-omid-c': 1,
    });
    assert.deepEqual(lifecycle.sessionFinishedRowsByBidder, {
      'bidder-omid-a': 1,
      'bidder-omid-c': 1,
    });
    assert.deepEqual(lifecycle.declaredNoLoadedRowsByBidder, {
      'bidder-omid-b': 2,
    });
    assert.deepEqual(lifecycle.declaredNoSessionFinishedRowsByBidder, {
      'bidder-omid-b': 2,
    });

    // Aggregate-only: no raw markup, URLs, or per-creative identifiers leak in.
    const serialized = JSON.stringify(lifecycle);
    assert.ok(!serialized.includes('bid-1'), 'lifecycle facet must not leak bidId');
    assert.ok(!serialized.includes('creative-1'), 'lifecycle facet must not leak crid');
    assert.ok(!serialized.includes('synthetic-report.jsonl'), 'lifecycle facet must not leak source file');
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('triageReports computes OMID cap p99 independently from max at n >= 100', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-omid-cap-p99-'));
  const reportPath = resolve(workDir, 'report.jsonl');

  function inlineVendorReport(rowIndex, registerSessionObserverCalls) {
    return omidReport({
      expected: false,
      inlineVendor: {
        expected: true,
        accessMode: 'limited',
        omid3pFound: true,
        subscriptionObserved: registerSessionObserverCalls > 0,
        expectedVendorSubscriptionObserved: registerSessionObserverCalls > 0,
        registerSessionObserverCalls,
        addEventListenerCalls: 0,
        expectedVendorRegisterSessionObserverCalls: registerSessionObserverCalls,
        expectedVendorAddEventListenerCalls: 0,
        callbackEvents: 0,
        callbackEventsByType: {},
        lifecycleObserved: false,
        lifecycleComplete: false,
        lifecycleNotObserved: registerSessionObserverCalls > 0,
        passed: false,
      },
    }, {
      case: {
        ...report().case,
        source: {
          ...report().case.source,
          bidder: 'bidder-omid-percentile',
          rowIndex,
        },
        bidSignals: {
          ...report().case.bidSignals,
          measurement: {
            omid: {
              declaredByApi: false,
              sidecarPresent: false,
              inlineVendorScriptPresent: true,
              inlineVendorScriptCount: 1,
              inlineVendorVendors: ['doubleverify'],
            },
          },
        },
      },
      outcome: { status: 'failed', bucket: 'measurement-omid', durationMs: 3000 },
    });
  }

  try {
    writeJsonl(reportPath, [
      ...Array.from({ length: 99 }, (_, index) => inlineVendorReport(index, 1)),
      inlineVendorReport(99, 1000),
    ]);

    const cap = triageReports([reportPath])
      .corpusDiagnostics.omid.inlineVendorSubscriptionCap;
    assert.deepEqual(cap, {
      unit: 'cumulative-register-calls-per-session',
      rowsMeasured: 100,
      median: 1,
      p99: 1,
      max: 1000,
      byCumulativeRegisterCallCount: {
        1: 99,
        1000: 1,
      },
    });
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('triageReports emits a stable empty OMID facet for a zero-row corpus', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-omid-empty-'));
  const reportPath = resolve(workDir, 'report.jsonl');

  try {
    writeFileSync(reportPath, '');
    const summary = triageReports([reportPath]);
    assert.deepEqual(summary.corpusDiagnostics.omid, {
      rows: 0,
      rowsCapabilityDeclared: 0,
      rowsInlineInstrumented: 0,
      rowsCapabilityDeclaredInlineInstrumented: 0,
      rowsInlineInstrumentedWithoutCapability: 0,
      rowsAbsent: 0,
      rowsScanTruncated: 0,
      rowsTagLimitReached: 0,
      rowsWithSidecar: 0,
      rowsWithExtension: 0,
      rowsFeatureAdvertised: 0,
      rowsSessionStarted: 0,
      rowsSessionFinished: 0,
      rowsLoadedFired: 0,
      rowsImpressionFired: 0,
      byInstrumentationSignal: {},
      byInlineVendorScriptCount: {},
      inlineVendorRowsByVendor: {},
      inlineVendorRowsByBidder: {},
      inlineVendorRowsByAccessMode: {},
      inlineVendorRowsByRuntimeOutcome: {},
      inlineVendorRowsByDiagnosticOutcome: {},
      inlineVendorRowsByLifecycleObservation: {},
      inlineVendorRowsByExpectedAttribution: {},
      inlineVendorRowsByExpectedScriptCache: {},
      inlineVendorExpectedScriptCacheNoSubscriptionRows: 0,
      inlineVendorSubscriptionCallsBySourceVendor: {},
      inlineVendorSubscriptionCallsBySourceOrigin: {},
      inlineVendorUnattributedCallsBySourceVendor: {},
      inlineVendorUnattributedCallsBySourceOrigin: {},
      inlineVendorUnattributedRowsBySourceVendor: {},
      inlineVendorUnattributedRowsBySourceOrigin: {},
      inlineVendorSubscriptionCap: {
        unit: 'cumulative-register-calls-per-session',
        rowsMeasured: 0,
        median: 0,
        p99: 0,
        max: 0,
        byCumulativeRegisterCallCount: {},
      },
      rowsBySdkMode: {},
      inlineVendorRowsByDeliveryChannel: {},
      serviceSubscriptionRowsByVendor: {},
      serviceCanaryRows: {
        injected: 0,
        loaded: 0,
        sessionStart: 0,
        impression: 0,
        sessionFinish: 0,
        deliveryComplete: 0,
      },
      teardownProbe: {
        rowsProbed: 0,
        rowsCloseRequested: 0,
        rowsWaitTimedOut: 0,
        rowsSessionFinished: 0,
        rowsCanarySessionFinish: 0,
        rowsOmid3pSessionFinish: 0,
      },
      inlineVendorRowsBySessionFinishReceipt: {},
      serviceInjectedResourceCount: {
        unit: 'distinct-service-injected-vendor-resources-per-session',
        rowsMeasured: 0,
        median: 0,
        p99: 0,
        max: 0,
        byResourceCount: {},
      },
      inlineVendorSessionProfile: {
        rowsMeasured: 0,
        durationMs: {
          median: 0,
          p99: 0,
          max: 0,
          byCount: {},
        },
        geometryChangeCallbacks: {
          median: 0,
          p99: 0,
          max: 0,
          byCount: {},
        },
      },
      byOutcome: {},
      byVerificationScriptCount: {},
      capabilityRowsByBidder: {},
      capabilityNoSidecarRowsByBidder: {},
      sidecarRowsByBidder: {},
      sessionNotStartedRowsByBidder: {},
      lifecycle: {
        byDeclaredVsRuntime: {},
        bySessionStartOutcome: {},
        loadedFiredRowsByBidder: {},
        impressionFiredRowsByBidder: {},
        sessionFinishedRowsByBidder: {},
        declaredNoLoadedRowsByBidder: {},
        declaredNoSessionFinishedRowsByBidder: {},
      },
    });
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

test('select CLI rebuilds targeted rerun inputs from original normalized cases', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-select-cli-'));
  const casesPath = resolve(workDir, 'cases.jsonl');
  const reportPath = resolve(workDir, 'report.jsonl');
  const outPath = resolve(workDir, 'selected.jsonl');

  const firstCase = {
    ...report().case,
    source: { ...report().case.source, rowIndex: 0 },
    ids: { bidId: 'bid-select-1', crid: 'creative-select-1' },
    creative: {
      mode: 'markup',
      admKind: 'html',
      html: '<script src="https://cdn.doubleverify.com/dvtp_src.js"></script>',
    },
  };
  const secondCase = {
    ...report().case,
    source: { ...report().case.source, rowIndex: 1 },
    ids: { bidId: 'bid-select-2', crid: 'creative-select-2' },
    creative: {
      mode: 'markup',
      admKind: 'html',
      html: '<script src="https://cdn.example.test/other.js"></script>',
    },
  };

  try {
    writeJsonl(casesPath, [firstCase, secondCase]);
    writeJsonl(reportPath, [
      report({
        case: {
          ...firstCase,
          creative: {
            mode: firstCase.creative.mode,
            admKind: firstCase.creative.admKind,
          },
        },
        outcome: { status: 'failed', bucket: 'measurement-omid' },
        diagnostics: {
          measurement: {
            omid: {
              inlineVendor: { diagnosticOutcome: 'no-subscription' },
            },
          },
        },
      }),
      report({
        case: {
          ...secondCase,
          creative: {
            mode: secondCase.creative.mode,
            admKind: secondCase.creative.admKind,
          },
        },
        outcome: { status: 'passed', bucket: 'passed' },
        diagnostics: {
          measurement: {
            omid: {
              inlineVendor: { diagnosticOutcome: 'expected-vendor-lifecycle' },
            },
          },
        },
      }),
    ]);

    execFileSync('node', [
      cliPath,
      'select',
      casesPath,
      '--report',
      reportPath,
      '--diagnostic-outcome',
      'no-subscription',
      '--out',
      outPath,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const selected = readFileSync(outPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].ids.bidId, 'bid-select-1');
    assert.equal(selected[0].creative.html, firstCase.creative.html);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('select CLI enforces private output boundary', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-select-boundary-'));
  const casesPath = resolve(workDir, 'cases.jsonl');
  const reportPath = resolve(workDir, 'report.jsonl');
  const publicOut = resolve('tools/creative-validator/fixtures/select-leak.jsonl');

  try {
    const testCase = {
      ...report().case,
      creative: { mode: 'markup', admKind: 'html', html: '<div>selected</div>' },
    };
    writeJsonl(casesPath, [testCase]);
    writeJsonl(reportPath, [
      report({
        case: testCase,
        diagnostics: {
          measurement: { omid: { inlineVendor: { diagnosticOutcome: 'no-subscription' } } },
        },
      }),
    ]);

    assert.throws(
      () => execFileSync('node', [
        cliPath,
        'select',
        casesPath,
        '--report',
        reportPath,
        '--diagnostic-outcome',
        'no-subscription',
        '--out',
        publicOut,
      ], {
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

test('select CLI fails zero-match selections before writing output', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-select-empty-'));
  const casesPath = resolve(workDir, 'cases.jsonl');
  const reportPath = resolve(workDir, 'report.jsonl');
  const outPath = resolve(workDir, 'selected.jsonl');

  try {
    const testCase = {
      ...report().case,
      creative: { mode: 'markup', admKind: 'html', html: '<div>not selected</div>' },
    };
    writeJsonl(casesPath, [testCase]);
    writeJsonl(reportPath, [
      report({
        case: testCase,
        diagnostics: {
          measurement: { omid: { inlineVendor: { diagnosticOutcome: 'expected-vendor-lifecycle' } } },
        },
      }),
    ]);

    assert.throws(
      () => execFileSync('node', [
        cliPath,
        'select',
        casesPath,
        '--report',
        reportPath,
        '--diagnostic-outcome',
        'no-subscription',
        '--out',
        outPath,
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      /Selection matched zero report rows/,
    );
    assert.equal(existsSync(outPath), false);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('select CLI fails unmatched report rows before writing output', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-select-unmatched-'));
  const casesPath = resolve(workDir, 'cases.jsonl');
  const reportPath = resolve(workDir, 'report.jsonl');
  const outPath = resolve(workDir, 'selected.jsonl');

  try {
    const testCase = {
      ...report().case,
      ids: { bidId: 'bid-present', crid: 'creative-present' },
      creative: { mode: 'markup', admKind: 'html', html: '<div>present</div>' },
    };
    const unmatchedReportCase = {
      ...testCase,
      ids: { bidId: 'bid-missing', crid: 'creative-missing' },
    };
    writeJsonl(casesPath, [testCase]);
    writeJsonl(reportPath, [
      report({
        case: unmatchedReportCase,
        diagnostics: {
          measurement: { omid: { inlineVendor: { diagnosticOutcome: 'no-subscription' } } },
        },
      }),
    ]);

    assert.throws(
      () => execFileSync('node', [
        cliPath,
        'select',
        casesPath,
        '--report',
        reportPath,
        '--diagnostic-outcome',
        'no-subscription',
        '--out',
        outPath,
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      /does not match any normalized case: .*bid-missing/,
    );
    assert.equal(existsSync(outPath), false);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('select CLI deduplicates report rows and honors limit', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-select-limit-'));
  const casesPath = resolve(workDir, 'cases.jsonl');
  const reportPath = resolve(workDir, 'report.jsonl');
  const outPath = resolve(workDir, 'selected.jsonl');

  const makeCase = (index) => ({
    ...report().case,
    source: { ...report().case.source, rowIndex: index },
    ids: { bidId: `bid-limit-${index}`, crid: `creative-limit-${index}` },
    creative: { mode: 'markup', admKind: 'html', html: `<div>${index}</div>` },
  });

  try {
    const cases = [makeCase(0), makeCase(1), makeCase(2)];
    writeJsonl(casesPath, cases);
    writeJsonl(reportPath, [
      cases[0],
      cases[0],
      cases[1],
      cases[2],
    ].map((testCase) => report({
      case: {
        ...testCase,
        creative: {
          mode: testCase.creative.mode,
          admKind: testCase.creative.admKind,
        },
      },
      diagnostics: {
        measurement: { omid: { inlineVendor: { diagnosticOutcome: 'no-subscription' } } },
      },
    })));

    execFileSync('node', [
      cliPath,
      'select',
      casesPath,
      '--report',
      reportPath,
      '--diagnostic-outcome',
      'no-subscription',
      '--limit',
      '2',
      '--out',
      outPath,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const selected = readFileSync(outPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(selected.map((item) => item.ids.bidId), ['bid-limit-0', 'bid-limit-1']);
    assert.deepEqual(selected.map((item) => item.creative.html), ['<div>0</div>', '<div>1</div>']);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

// #244 / #211B: real-OM-SDK service-path facets — sdk mode split, delivery
// channel attribution, per-vendor service subscriptions, canary delivery, and
// the D7 distinct-resource distribution.
test('triageReports aggregates OMID service-path facets (#244)', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-omid-service-'));
  const reportPath = resolve(workDir, 'report.jsonl');

  const inlineBidSignals = {
    ...report().case.bidSignals,
    measurement: {
      omid: {
        declaredByApi: true,
        sidecarPresent: false,
        inlineVendorScriptPresent: true,
        inlineVendorScriptCount: 1,
        inlineVendorVendors: ['doubleverify'],
      },
    },
  };

  function serviceRow(bidder, service, inlineVendorOverrides) {
    return omidReport({
      expected: true,
      sidecarPresent: false,
      sdkMode: service ? 'service' : 'mock',
      extensionPresent: true,
      featureAdvertised: true,
      sessionStarted: true,
      verificationScriptCount: 1,
      service,
      inlineVendor: {
        expected: true,
        accessMode: 'limited',
        omid3pFound: true,
        subscriptionObserved: false,
        expectedVendorSubscriptionObserved: false,
        registerSessionObserverCalls: 0,
        addEventListenerCalls: 0,
        expectedVendorRegisterSessionObserverCalls: 0,
        expectedVendorAddEventListenerCalls: 0,
        callbackEvents: 0,
        callbackEventsByType: {},
        callsBySourceVendor: {},
        callsBySourceOrigin: {},
        unattributedCallsBySourceVendor: {},
        unattributedCallsBySourceOrigin: {},
        lifecycleObserved: false,
        lifecycleComplete: false,
        lifecycleNotObserved: false,
        ...inlineVendorOverrides,
      },
    }, {
      case: {
        ...report().case,
        source: { ...report().case.source, bidder, rowIndex: 0 },
        bidSignals: inlineBidSignals,
      },
      outcome: { status: 'passed', bucket: 'passed', durationMs: 2100 },
    });
  }

  try {
    writeJsonl(reportPath, [
      serviceRow('bidder-service-a', {
        sdkMode: 'service',
        injectedResourceCount: 1,
        injectedVendors: ['doubleverify'],
        subscriptionMessages: 45,
        subscriptionsByMethod: { addSessionListener: 3, addEventListener: 42 },
        subscriptionsByVendor: { doubleverify: 45 },
        subscriptionEventTypes: { impression: 5 },
        expectedVendorServiceSubscriptionObserved: true,
        canary: {
          injected: true,
          loaded: true,
          hasInjectionId: true,
          sessionStart: true,
          sessionFinish: false,
          impression: true,
          loadedEvent: true,
          geometryChangeCount: 0,
          deliveryComplete: true,
        },
      }, {
        servicePassed: true,
        omid3pPassed: false,
        passed: true,
        deliveryChannel: 'service',
        diagnosticOutcome: 'expected-vendor-service-delivery',
      }),
      serviceRow('bidder-service-b', {
        sdkMode: 'service',
        injectedResourceCount: 3,
        injectedVendors: ['doubleverify', 'ias'],
        subscriptionMessages: 0,
        subscriptionsByMethod: {},
        subscriptionsByVendor: {},
        subscriptionEventTypes: {},
        expectedVendorServiceSubscriptionObserved: false,
        canary: {
          injected: true,
          loaded: true,
          hasInjectionId: true,
          sessionStart: true,
          sessionFinish: false,
          impression: false,
          loadedEvent: false,
          geometryChangeCount: 0,
          deliveryComplete: false,
        },
      }, {
        servicePassed: false,
        omid3pPassed: false,
        passed: false,
        deliveryChannel: 'none',
        diagnosticOutcome: 'no-subscription',
        subscriptionObserved: false,
      }),
      // Legacy mock-mode row: no service block at all.
      serviceRow('bidder-mock-c', null, {
        servicePassed: false,
        omid3pPassed: true,
        passed: true,
        deliveryChannel: 'omid3p',
        diagnosticOutcome: 'expected-vendor-lifecycle',
        subscriptionObserved: true,
        expectedVendorSubscriptionObserved: true,
        registerSessionObserverCalls: 1,
        expectedVendorRegisterSessionObserverCalls: 1,
        callbackEvents: 2,
        lifecycleObserved: true,
      }),
    ]);

    const summary = triageReports([reportPath]);
    const facet = summary.corpusDiagnostics.omid;
    assert.deepEqual(facet.rowsBySdkMode, { service: 2, mock: 1 });
    assert.deepEqual(facet.inlineVendorRowsByDeliveryChannel, {
      service: 1,
      none: 1,
      omid3p: 1,
    });
    assert.deepEqual(facet.serviceSubscriptionRowsByVendor, { doubleverify: 1 });
    assert.deepEqual(facet.serviceCanaryRows, {
      injected: 2,
      loaded: 2,
      sessionStart: 2,
      impression: 1,
      sessionFinish: 0,
      deliveryComplete: 1,
    });
    // Rows without a teardown probe land in 'not-probed' and never count
    // toward the probe facet.
    assert.deepEqual(facet.inlineVendorRowsBySessionFinishReceipt, { 'not-probed': 3 });
    assert.equal(facet.teardownProbe.rowsProbed, 0);
    assert.equal(facet.serviceInjectedResourceCount.rowsMeasured, 2);
    assert.equal(facet.serviceInjectedResourceCount.max, 3);
    assert.equal(facet.serviceInjectedResourceCount.median, 1);
    assert.deepEqual(
      facet.serviceInjectedResourceCount.byResourceCount,
      { 1: 1, 3: 1 },
    );
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('triageReports aggregates the OMID teardown probe facet (#G3 sessionFinish)', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-triage-omid-teardown-'));
  const reportPath = resolve(workDir, 'report.jsonl');

  const inlineBidSignals = {
    ...report().case.bidSignals,
    measurement: {
      omid: {
        declaredByApi: true,
        sidecarPresent: false,
        inlineVendorScriptPresent: true,
        inlineVendorScriptCount: 1,
        inlineVendorVendors: ['ias'],
      },
    },
  };

  function teardownRow(bidder, { sessionFinished, lifecycle, canarySessionFinish, teardown }) {
    return omidReport({
      expected: true,
      sidecarPresent: false,
      sdkMode: 'service',
      extensionPresent: true,
      featureAdvertised: true,
      sessionStarted: true,
      sessionFinished,
      verificationScriptCount: 1,
      service: {
        sdkMode: 'service',
        injectedResourceCount: 1,
        injectedVendors: ['ias'],
        subscriptionMessages: 10,
        subscriptionsByMethod: { addSessionListener: 2, addEventListener: 8 },
        subscriptionsByVendor: { ias: 10 },
        subscriptionEventTypes: { impression: 2 },
        expectedVendorServiceSubscriptionObserved: true,
        canary: {
          injected: true,
          loaded: true,
          hasInjectionId: true,
          sessionStart: true,
          sessionFinish: canarySessionFinish,
          impression: true,
          loadedEvent: true,
          geometryChangeCount: 1,
          deliveryComplete: true,
        },
      },
      inlineVendor: {
        expected: true,
        accessMode: 'limited',
        omid3pFound: true,
        subscriptionObserved: true,
        expectedVendorSubscriptionObserved: true,
        registerSessionObserverCalls: 1,
        addEventListenerCalls: 2,
        expectedVendorRegisterSessionObserverCalls: 1,
        expectedVendorAddEventListenerCalls: 2,
        callbackEvents: 4,
        callbackEventsByType: { sessionStart: 1, loaded: 1, impression: 1, sessionFinish: 1 },
        sessionFinishCallbacks: lifecycle.sessionFinish === true ? 1 : 0,
        sessionFinishCallbacksByVendor: lifecycle.sessionFinish === true ? { ias: 1 } : {},
        callsBySourceVendor: { ias: 3 },
        callsBySourceOrigin: { 'https://pixel.adsafeprotected.com': 3 },
        unattributedCallsBySourceVendor: {},
        unattributedCallsBySourceOrigin: {},
        lifecycle,
        lifecycleObserved: true,
        lifecycleComplete: true,
        lifecycleNotObserved: false,
        servicePassed: true,
        omid3pPassed: true,
        passed: true,
        deliveryChannel: 'both',
        diagnosticOutcome: 'expected-vendor-lifecycle',
      },
      teardown,
    }, {
      case: {
        ...report().case,
        source: { ...report().case.source, bidder, rowIndex: 0 },
        bidSignals: inlineBidSignals,
      },
      outcome: { status: 'passed', bucket: 'passed', durationMs: 2500 },
    });
  }

  try {
    writeJsonl(reportPath, [
      // Probed row: finish received on BOTH channels.
      teardownRow('bidder-finish-both', {
        sessionFinished: true,
        lifecycle: { sessionStart: true, loaded: true, impression: true, sessionFinish: true },
        canarySessionFinish: true,
        teardown: {
          probed: true,
          closeRequested: true,
          closeError: null,
          alreadyTerminated: false,
          terminated: true,
          waitTimedOut: false,
        },
      }),
      // Probed row: finish landed on the service channel only, and the
      // omid3p wait timed out.
      teardownRow('bidder-finish-service-only', {
        sessionFinished: true,
        lifecycle: { sessionStart: true, loaded: true, impression: true, sessionFinish: false },
        canarySessionFinish: true,
        teardown: {
          probed: true,
          closeRequested: true,
          closeError: null,
          alreadyTerminated: false,
          terminated: true,
          waitTimedOut: true,
        },
      }),
      // Unprobed row (e.g. pre-probe report): receipt column stays explicit.
      teardownRow('bidder-not-probed', {
        sessionFinished: false,
        lifecycle: { sessionStart: true, loaded: true, impression: true, sessionFinish: false },
        canarySessionFinish: false,
        teardown: { probed: false },
      }),
    ]);

    const summary = triageReports([reportPath]);
    const facet = summary.corpusDiagnostics.omid;
    assert.deepEqual(facet.teardownProbe, {
      rowsProbed: 2,
      rowsCloseRequested: 2,
      rowsWaitTimedOut: 1,
      rowsSessionFinished: 2,
      rowsCanarySessionFinish: 2,
      rowsOmid3pSessionFinish: 1,
    });
    assert.deepEqual(facet.inlineVendorRowsBySessionFinishReceipt, {
      'both': 1,
      'service-canary': 1,
      'not-probed': 1,
    });
    assert.equal(facet.serviceCanaryRows.sessionFinish, 2);
    assert.equal(facet.rowsSessionFinished, 2);
    // Verdict conservativeness: finish presence/absence never moved a bucket.
    assert.equal(summary.totals.passed, 3);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});
