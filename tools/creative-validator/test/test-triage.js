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
              count: 3,
              byKind: {
                frame: 1,
                'frame-src': 1,
                'form-submit': 1,
              },
              byProtocol: {
                'http:': 1,
                'https:': 1,
                unknown: 1,
              },
              byOrigin: {
                'http://frame.example': 1,
                'https://click.example': 1,
                unknown: 1,
              },
              byTag: {
                iframe: 2,
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
      frame: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByProtocol, {
      'http:': 1,
      'https:': 1,
      unknown: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByOrigin, {
      'http://frame.example': 1,
      'https://click.example': 1,
      unknown: 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourcesByTag, {
      form: 1,
      iframe: 2,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourceRowsByClass, {
      'blank-or-opaque-document': 1,
      'external-frame': 1,
      'frame-src-assignment': 1,
      'form-source': 1,
      'insecure-frame': 1,
      'observed-frame': 1,
      'secure-frame': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourceEventsByClass, {
      'blank-or-opaque-document': 1,
      'external-frame': 2,
      'frame-src-assignment': 1,
      'form-source': 1,
      'insecure-frame': 1,
      'observed-frame': 1,
      'secure-frame': 1,
    });
    assert.deepEqual(summary.corpusDiagnostics.network.documentSourceRowsByClassAndBidder, {
      'blank-or-opaque-document|bidder-a': 1,
      'external-frame|bidder-a': 1,
      'frame-src-assignment|bidder-a': 1,
      'form-source|bidder-a': 1,
      'insecure-frame|bidder-a': 1,
      'observed-frame|bidder-a': 1,
      'secure-frame|bidder-a': 1,
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
      }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-a', rowIndex: 0 },
        },
        outcome: { status: 'passed', bucket: 'passed' },
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
      }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-b', rowIndex: 1 },
        },
        outcome: { status: 'failed', bucket: 'measurement-omid' },
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
      }, {
        case: {
          ...report().case,
          source: { ...report().case.source, bidder: 'bidder-omid-c', rowIndex: 2 },
        },
        outcome: { status: 'passed', bucket: 'passed' },
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
    ]);

    const summary = triageReports([reportPath]);
    const omid = summary.corpusDiagnostics.omid;
    assert.equal(omid.rows, 6);
    assert.equal(omid.rowsCapabilityDeclared, 4);
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
      rowsWithSidecar: 0,
      rowsWithExtension: 0,
      rowsFeatureAdvertised: 0,
      rowsSessionStarted: 0,
      rowsSessionFinished: 0,
      rowsLoadedFired: 0,
      rowsImpressionFired: 0,
      byOutcome: {},
      byVerificationScriptCount: {},
      capabilityRowsByBidder: {},
      capabilityNoSidecarRowsByBidder: {},
      sidecarRowsByBidder: {},
      sessionNotStartedRowsByBidder: {},
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
