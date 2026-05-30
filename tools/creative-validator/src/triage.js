/**
 * @file Creative validator report triage.
 *
 * Converts private runner report JSONL into aggregate summaries for manual
 * issue filing and synthetic-reduction planning. The summary intentionally
 * avoids raw creative markup and keeps sample identifiers bounded.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';

const SAMPLE_LIMIT = 5;

function emptySummary(files) {
  return {
    generatedAt: new Date().toISOString(),
    sourceFiles: files.map((file) => basename(file)),
    totals: {
      reports: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      other: 0,
    },
    byStatus: {},
    byBucket: {},
    byBidder: {},
    byMtype: {},
    byAdmKind: {},
    byApi: {},
    byExpectedBridge: {},
    diagnostics: {
      bySecurityEvent: {},
      bySecurityEventSet: {},
      unauthorizedNavigation: {
        byVariant: {},
        byMsSinceRender: {},
      },
      navigationSources: {
        documentWriteByCount: {},
        documentWriteByPattern: {},
        windowOpenByCount: {},
        windowOpenByProtocol: {},
        bridgeCallByCount: {},
        bridgeCallByMethod: {},
        bridgeCallByProtocol: {},
        scriptLoadByCount: {},
        scriptLoadByLoadedCount: {},
        scriptLoadByErrorCount: {},
        scriptLoadByProtocol: {},
        scriptLoadByOrigin: {},
        scriptLoadByStatus: {},
      },
      network: {
        byShape: {},
        byFailedRequestCount: {},
        byFailedResponseCount: {},
        byCorsConsoleCount: {},
        byCspConsoleCount: {},
      },
      legacyMraidLoader: {
        byPresence: {},
        bySignal: {},
        byStatus: {},
        byBucket: {},
        byBidder: {},
        byAdmKind: {},
        byApi: {},
        byErrorCount: {},
        byLoadedCount: {},
      },
    },
    corpusDiagnostics: {
      scriptLoads: {
        rowsWithScripts: 0,
        rowsWithErrors: 0,
        rowsWithLoaded: 0,
        rowsWithErrorsByClass: {},
        rowsWithErrorsByBidder: {},
        rowsWithErrorsByAdmKind: {},
        rowsWithErrorsByLegacyMraidLoader: {},
        errorEventsByClass: {},
        errorRowsByClassAndBidder: {},
        byCount: {},
        byLoadedCount: {},
        byErrorCount: {},
        byProtocol: {},
        byOrigin: {},
        byStatus: {},
      },
      network: {
        rowsWithFailedRequests: 0,
        rowsWithFailedResponses: 0,
        rowsWithCorsConsole: 0,
        rowsWithCspConsole: 0,
        rowsWithFailedDocuments: 0,
        rowsWithDocumentSources: 0,
        documentSourcesByKind: {},
        documentSourcesByProtocol: {},
        documentSourcesByOrigin: {},
        documentSourcesByTag: {},
        documentSourceRowsByBidder: {},
        byShape: {},
        byFailedRequestCount: {},
        byFailedResponseCount: {},
        byCorsConsoleCount: {},
        byCspConsoleCount: {},
        failedRowsByBidder: {},
        failedRowsByAdmKind: {},
        corsRowsByBidder: {},
        cspRowsByBidder: {},
        failedDocumentRowsByBidder: {},
        failedResourceType: {},
        failedResponseStatus: {},
      },
      omid: {
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
      },
    },
    failureGroups: [],
    reductionCandidates: [],
  };
}

function increment(map, key, amount = 1) {
  const normalized = normalizeKey(key);
  map[normalized] = (map[normalized] || 0) + amount;
}

function normalizeKey(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  return String(value);
}

function apiKey(row) {
  const values = row
    && row.case
    && row.case.bidSignals
    && row.case.bidSignals.apis
    && row.case.bidSignals.apis.sanitized;
  return Array.isArray(values) && values.length > 0 ? values.join(',') : 'none';
}

function expectedBridgeKeys(row) {
  const declared = (row.case && row.case.expectations && row.case.expectations.declared) || [];
  const sniffed = (row.case && row.case.expectations && row.case.expectations.sniffed) || [];
  const set = new Set([...declared, ...sniffed]);
  return set.size > 0 ? [...set].sort() : ['none'];
}

function securityEvents(row) {
  return row && row.diagnostics && Array.isArray(row.diagnostics.securityEvents)
    ? row.diagnostics.securityEvents
    : [];
}

function networkDiagnostics(row) {
  return row && row.diagnostics && row.diagnostics.network
    ? row.diagnostics.network
    : {};
}

function failedRequests(row) {
  return row && row.diagnostics && Array.isArray(row.diagnostics.failedRequests)
    ? row.diagnostics.failedRequests
    : [];
}

function failedResponses(row) {
  return row && row.diagnostics && Array.isArray(row.diagnostics.failedResponses)
    ? row.diagnostics.failedResponses
    : [];
}

function navigationDiagnostics(row) {
  return row && row.diagnostics && row.diagnostics.navigationDiagnostics
    ? row.diagnostics.navigationDiagnostics
    : {};
}

function legacyMraidLoaderDiagnostics(row) {
  return row && row.diagnostics && row.diagnostics.legacyMraidLoader
    ? row.diagnostics.legacyMraidLoader
    : {};
}

function omidDiagnostics(row) {
  return row
    && row.diagnostics
    && row.diagnostics.measurement
    && row.diagnostics.measurement.omid
    ? row.diagnostics.measurement.omid
    : {};
}

function omidOutcomeKey(omid) {
  if (omid.sidecarPresent !== true) return 'capability-no-sidecar';
  if (omid.extensionPresent !== true) return 'sidecar-no-extension';
  if (omid.featureAdvertised !== true) return 'extension-no-feature';
  if (omid.sessionStarted !== true) return 'feature-no-session';
  if (omid.sessionFinished !== true) return 'session-started';
  return 'session-finished';
}

function msSinceRenderBin(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 100) return '0-99ms';
  if (value < 500) return '100-499ms';
  if (value < 1000) return '500-999ms';
  if (value < 2000) return '1000-1999ms';
  return '2000ms+';
}

function networkCount(value) {
  // Treat malformed runner counters as zero so private summaries remain stable.
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function networkShape(network) {
  return [
    `request:${networkCount(network.failedRequestCount)}`,
    `response:${networkCount(network.failedResponseCount)}`,
    `cors:${networkCount(network.corsConsoleCount)}`,
    `csp:${networkCount(network.cspConsoleCount)}`,
  ].join(' ');
}

function scriptErrorClasses(row, scriptLoads, legacy) {
  const rows = new Set();
  const events = {};
  const add = (name, count = 1) => {
    rows.add(name);
    increment(events, name, count);
  };
  const calls = scriptLoads && Array.isArray(scriptLoads.calls) ? scriptLoads.calls : [];
  const legacyErrorCalls = calls.filter((call) =>
    call && call.status === 'error' && call.url && call.url.legacyMraidLoader === true);
  if (networkCount(legacy && legacy.errorCount) > 0 || legacyErrorCalls.length > 0) {
    add('legacy-mraid-loader', Math.max(networkCount(legacy && legacy.errorCount), legacyErrorCalls.length));
  }

  let scriptFailureEvents = 0;
  for (const request of failedRequests(row)) {
    if (!request || request.resourceType !== 'script') continue;
    scriptFailureEvents += 1;
    const text = String(request.errorText || '').toLowerCase();
    if (text.includes('name_not_resolved')) {
      add('external-script-dns');
    } else if (text.includes('err_aborted')) {
      add('external-script-aborted');
    } else {
      add('external-script-transport');
    }
  }
  for (const response of failedResponses(row)) {
    if (!response || response.resourceType !== 'script') continue;
    scriptFailureEvents += 1;
    add('external-script-http');
  }

  // The runner currently reports CSP as console-message counts rather than
  // resource-typed events, so this is an intentionally approximate row-level
  // class: it means a row had both script load errors and CSP-like console
  // output, not that every CSP message was proven to target a script.
  if (networkCount(networkDiagnostics(row).cspConsoleCount) > 0 && networkCount(scriptLoads && scriptLoads.errorCount) > 0) {
    add('script-csp-blocked', networkCount(networkDiagnostics(row).cspConsoleCount));
  }

  // A row can belong to multiple classes. event counts are diagnostic events,
  // not a partition of scriptLoads.errorCount.
  const knownEvents = Object.values(events).reduce((sum, count) => sum + count, 0);
  const unknownScriptErrors = Math.max(0, networkCount(scriptLoads && scriptLoads.errorCount) - knownEvents);
  if (unknownScriptErrors > 0 && scriptFailureEvents === 0) {
    add('script-load-event', unknownScriptErrors);
  }

  return { rows, events };
}

function addDiagnosticFacets(summary, row) {
  const events = securityEvents(row);
  const eventTypes = events.map((event) => normalizeKey(event && event.type)).sort();
  const eventSet = eventTypes.length > 0 ? [...new Set(eventTypes)].join(',') : 'none';
  increment(summary.diagnostics.bySecurityEventSet, eventSet);

  for (const event of events) {
    const type = normalizeKey(event && event.type);
    increment(summary.diagnostics.bySecurityEvent, type);
    if (type === 'unauthorized_navigation') {
      const details = (event && event.details) || {};
      increment(summary.diagnostics.unauthorizedNavigation.byVariant, details.variant);
      increment(
        summary.diagnostics.unauthorizedNavigation.byMsSinceRender,
        msSinceRenderBin(details.msSinceRender),
      );
    }
  }

  const network = networkDiagnostics(row);
  increment(summary.diagnostics.network.byShape, networkShape(network));
  increment(summary.diagnostics.network.byFailedRequestCount, networkCount(network.failedRequestCount));
  increment(summary.diagnostics.network.byFailedResponseCount, networkCount(network.failedResponseCount));
  increment(summary.diagnostics.network.byCorsConsoleCount, networkCount(network.corsConsoleCount));
  increment(summary.diagnostics.network.byCspConsoleCount, networkCount(network.cspConsoleCount));

  const navigation = navigationDiagnostics(row);
  const documentWrite = navigation.documentWrite || {};
  const windowOpen = navigation.windowOpen || {};
  const bridgeCalls = navigation.bridgeCalls || {};
  const scriptLoads = navigation.scriptLoads || {};
  increment(
    summary.diagnostics.navigationSources.documentWriteByCount,
    networkCount(documentWrite.count),
  );
  increment(
    summary.diagnostics.navigationSources.windowOpenByCount,
    networkCount(windowOpen.count),
  );
  const patterns = documentWrite.patterns || {};
  for (const [name, count] of Object.entries(patterns)) {
    if (networkCount(count) > 0) {
      increment(summary.diagnostics.navigationSources.documentWriteByPattern, name);
    }
  }
  const openCalls = Array.isArray(windowOpen.calls) ? windowOpen.calls : [];
  for (const call of openCalls) {
    increment(
      summary.diagnostics.navigationSources.windowOpenByProtocol,
      call && call.url && call.url.protocol,
    );
  }
  increment(
    summary.diagnostics.navigationSources.bridgeCallByCount,
    networkCount(bridgeCalls.count),
  );
  const bridgeByMethod = bridgeCalls.byMethod || {};
  for (const [method, count] of Object.entries(bridgeByMethod)) {
    if (networkCount(count) > 0) {
      increment(summary.diagnostics.navigationSources.bridgeCallByMethod, method, networkCount(count));
    }
  }
  const bridgeByProtocol = bridgeCalls.byProtocol || {};
  for (const [protocol, count] of Object.entries(bridgeByProtocol)) {
    if (networkCount(count) > 0) {
      increment(summary.diagnostics.navigationSources.bridgeCallByProtocol, protocol, networkCount(count));
    }
  }
  increment(
    summary.diagnostics.navigationSources.scriptLoadByCount,
    networkCount(scriptLoads.count),
  );
  increment(
    summary.diagnostics.navigationSources.scriptLoadByLoadedCount,
    networkCount(scriptLoads.loadedCount),
  );
  increment(
    summary.diagnostics.navigationSources.scriptLoadByErrorCount,
    networkCount(scriptLoads.errorCount),
  );
  const scriptByProtocol = scriptLoads.byProtocol || {};
  for (const [protocol, count] of Object.entries(scriptByProtocol)) {
    if (networkCount(count) > 0) {
      increment(summary.diagnostics.navigationSources.scriptLoadByProtocol, protocol, networkCount(count));
    }
  }
  const scriptByOrigin = scriptLoads.byOrigin || {};
  for (const [origin, count] of Object.entries(scriptByOrigin)) {
    if (networkCount(count) > 0) {
      increment(summary.diagnostics.navigationSources.scriptLoadByOrigin, origin, networkCount(count));
    }
  }
  const scriptByStatus = scriptLoads.byStatus || {};
  for (const [status, count] of Object.entries(scriptByStatus)) {
    if (networkCount(count) > 0) {
      increment(summary.diagnostics.navigationSources.scriptLoadByStatus, status, networkCount(count));
    }
  }
}

function legacyMraidSignalKey(legacy) {
  const signal = legacy && legacy.signal ? legacy.signal : {};
  if (signal.declared === true && signal.sniffed === true) return 'declared+sniffed';
  if (signal.declared === true) return 'declared-only';
  if (signal.sniffed === true) return 'sniffed-only';
  if (signal.runtimeOnly === true) return 'runtime-only';
  return 'unknown';
}

function addCorpusFacets(summary, row, fields) {
  const legacy = legacyMraidLoaderDiagnostics(row);
  const requested = legacy.requested === true;
  increment(summary.diagnostics.legacyMraidLoader.byPresence, requested ? 'present' : 'absent');
  if (!requested) return;

  increment(summary.diagnostics.legacyMraidLoader.bySignal, legacyMraidSignalKey(legacy));
  increment(summary.diagnostics.legacyMraidLoader.byStatus, fields.status);
  increment(summary.diagnostics.legacyMraidLoader.byBucket, fields.bucket);
  increment(summary.diagnostics.legacyMraidLoader.byBidder, fields.bidder);
  increment(summary.diagnostics.legacyMraidLoader.byAdmKind, fields.admKind);
  increment(summary.diagnostics.legacyMraidLoader.byApi, fields.api);
  increment(summary.diagnostics.legacyMraidLoader.byErrorCount, networkCount(legacy.errorCount));
  increment(summary.diagnostics.legacyMraidLoader.byLoadedCount, networkCount(legacy.loadedCount));
}

function addRuntimeCorpusFacets(summary, row, fields) {
  const navigation = navigationDiagnostics(row);
  const scriptLoads = navigation.scriptLoads || {};
  const legacy = legacyMraidLoaderDiagnostics(row);
  const scriptCount = networkCount(scriptLoads.count);
  const scriptErrorCount = networkCount(scriptLoads.errorCount);
  const scriptLoadedCount = networkCount(scriptLoads.loadedCount);
  if (scriptCount > 0) {
    summary.corpusDiagnostics.scriptLoads.rowsWithScripts += 1;
    increment(summary.corpusDiagnostics.scriptLoads.byCount, scriptCount);
    increment(summary.corpusDiagnostics.scriptLoads.byLoadedCount, scriptLoadedCount);
    increment(summary.corpusDiagnostics.scriptLoads.byErrorCount, scriptErrorCount);
    if (scriptErrorCount > 0) {
      summary.corpusDiagnostics.scriptLoads.rowsWithErrors += 1;
      increment(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByBidder, fields.bidder);
      increment(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByAdmKind, fields.admKind);
      increment(
        summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByLegacyMraidLoader,
        legacy.requested === true ? 'present' : 'absent',
      );
      const classes = scriptErrorClasses(row, scriptLoads, legacy);
      for (const name of classes.rows) {
        increment(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByClass, name);
        increment(
          summary.corpusDiagnostics.scriptLoads.errorRowsByClassAndBidder,
          `${name}|${fields.bidder}`,
        );
      }
      for (const [name, count] of Object.entries(classes.events)) {
        increment(summary.corpusDiagnostics.scriptLoads.errorEventsByClass, name, count);
      }
    }
    if (scriptLoadedCount > 0) {
      summary.corpusDiagnostics.scriptLoads.rowsWithLoaded += 1;
    }
  }
  const scriptByProtocol = scriptLoads.byProtocol || {};
  for (const [protocol, count] of Object.entries(scriptByProtocol)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.scriptLoads.byProtocol, protocol, networkCount(count));
    }
  }
  const scriptByOrigin = scriptLoads.byOrigin || {};
  for (const [origin, count] of Object.entries(scriptByOrigin)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.scriptLoads.byOrigin, origin, networkCount(count));
    }
  }
  const scriptByStatus = scriptLoads.byStatus || {};
  for (const [status, count] of Object.entries(scriptByStatus)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.scriptLoads.byStatus, status, networkCount(count));
    }
  }

  const documentSources = navigation.documentSources || {};
  if (networkCount(documentSources.count) > 0) {
    summary.corpusDiagnostics.network.rowsWithDocumentSources += 1;
    increment(summary.corpusDiagnostics.network.documentSourceRowsByBidder, fields.bidder);
  }
  const documentSourceByKind = documentSources.byKind || {};
  for (const [kind, count] of Object.entries(documentSourceByKind)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.network.documentSourcesByKind, kind, networkCount(count));
    }
  }
  const documentSourceByProtocol = documentSources.byProtocol || {};
  for (const [protocol, count] of Object.entries(documentSourceByProtocol)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.network.documentSourcesByProtocol, protocol, networkCount(count));
    }
  }
  const documentSourceByOrigin = documentSources.byOrigin || {};
  for (const [origin, count] of Object.entries(documentSourceByOrigin)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.network.documentSourcesByOrigin, origin, networkCount(count));
    }
  }
  const documentSourceByTag = documentSources.byTag || {};
  for (const [tag, count] of Object.entries(documentSourceByTag)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.network.documentSourcesByTag, tag, networkCount(count));
    }
  }

  const network = networkDiagnostics(row);
  const failedRequestCount = networkCount(network.failedRequestCount);
  const failedResponseCount = networkCount(network.failedResponseCount);
  const corsConsoleCount = networkCount(network.corsConsoleCount);
  const cspConsoleCount = networkCount(network.cspConsoleCount);
  increment(summary.corpusDiagnostics.network.byShape, networkShape(network));
  increment(summary.corpusDiagnostics.network.byFailedRequestCount, failedRequestCount);
  increment(summary.corpusDiagnostics.network.byFailedResponseCount, failedResponseCount);
  increment(summary.corpusDiagnostics.network.byCorsConsoleCount, corsConsoleCount);
  increment(summary.corpusDiagnostics.network.byCspConsoleCount, cspConsoleCount);
  if (failedRequestCount > 0) summary.corpusDiagnostics.network.rowsWithFailedRequests += 1;
  if (failedResponseCount > 0) summary.corpusDiagnostics.network.rowsWithFailedResponses += 1;
  if (failedRequestCount > 0 || failedResponseCount > 0) {
    increment(summary.corpusDiagnostics.network.failedRowsByBidder, fields.bidder);
    increment(summary.corpusDiagnostics.network.failedRowsByAdmKind, fields.admKind);
  }
  if (corsConsoleCount > 0) {
    summary.corpusDiagnostics.network.rowsWithCorsConsole += 1;
    increment(summary.corpusDiagnostics.network.corsRowsByBidder, fields.bidder);
  }
  if (cspConsoleCount > 0) {
    summary.corpusDiagnostics.network.rowsWithCspConsole += 1;
    increment(summary.corpusDiagnostics.network.cspRowsByBidder, fields.bidder);
  }
  const failedResourceType = network.byResourceType || {};
  for (const [resourceType, count] of Object.entries(failedResourceType)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.network.failedResourceType, resourceType, networkCount(count));
    }
  }
  if (networkCount(failedResourceType.document) > 0) {
    summary.corpusDiagnostics.network.rowsWithFailedDocuments += 1;
    increment(summary.corpusDiagnostics.network.failedDocumentRowsByBidder, fields.bidder);
  }
  const failedResponseStatus = network.byStatus || {};
  for (const [status, count] of Object.entries(failedResponseStatus)) {
    if (networkCount(count) > 0) {
      increment(summary.corpusDiagnostics.network.failedResponseStatus, status, networkCount(count));
    }
  }
}

function addOmidCorpusFacets(summary, row, fields) {
  const omid = omidDiagnostics(row);
  const facet = summary.corpusDiagnostics.omid;
  facet.rows += 1;
  if (omid.sidecarPresent === true) facet.rowsWithSidecar += 1;
  if (omid.extensionPresent === true) facet.rowsWithExtension += 1;
  if (omid.featureAdvertised === true) facet.rowsFeatureAdvertised += 1;
  if (omid.sessionStarted === true) facet.rowsSessionStarted += 1;
  if (omid.sessionFinished === true) facet.rowsSessionFinished += 1;
  if (omid.loadedFired === true) facet.rowsLoadedFired += 1;
  if (omid.impressionFired === true) facet.rowsImpressionFired += 1;

  if (omid.expected !== true) return;

  facet.rowsCapabilityDeclared += 1;
  increment(facet.byOutcome, omidOutcomeKey(omid));
  increment(facet.byVerificationScriptCount, networkCount(omid.verificationScriptCount));
  increment(facet.capabilityRowsByBidder, fields.bidder);

  if (omid.sidecarPresent !== true) {
    increment(facet.capabilityNoSidecarRowsByBidder, fields.bidder);
    return;
  }

  increment(facet.sidecarRowsByBidder, fields.bidder);
  if (omid.sessionStarted !== true) {
    increment(facet.sessionNotStartedRowsByBidder, fields.bidder);
  }
}

function reportFields(row) {
  const source = (row.case && row.case.source) || {};
  const creative = (row.case && row.case.creative) || {};
  const bidSignals = (row.case && row.case.bidSignals) || {};
  const outcome = row.outcome || {};
  return {
    status: normalizeKey(outcome.status),
    bucket: normalizeKey(outcome.bucket),
    bidder: normalizeKey(source.bidder),
    mtype: normalizeKey(bidSignals.mtype || source.mtype),
    admKind: normalizeKey(creative.admKind),
    api: apiKey(row),
  };
}

function sampleId(row) {
  const ids = (row.case && row.case.ids) || {};
  const source = (row.case && row.case.source) || {};
  const sourceFile = normalizeKey(source.sourceFile);
  return {
    bidId: normalizeKey(ids.bidId),
    crid: normalizeKey(ids.crid),
    sourceFile: sourceFile === 'unknown' ? 'unknown' : basename(sourceFile),
    rowIndex: source.rowIndex === undefined ? null : source.rowIndex,
  };
}

function addFailureGroup(groups, row) {
  const fields = reportFields(row);
  const key = [
    fields.bucket,
    fields.bidder,
    fields.mtype,
    fields.admKind,
    fields.api,
  ].join('\u001f');
  let group = groups.get(key);
  if (!group) {
    group = {
      bucket: fields.bucket,
      bidder: fields.bidder,
      mtype: fields.mtype,
      admKind: fields.admKind,
      api: fields.api,
      count: 0,
      samples: [],
    };
    groups.set(key, group);
  }
  group.count += 1;
  if (group.samples.length < SAMPLE_LIMIT) {
    group.samples.push(sampleId(row));
  }
}

function sortEntries(map, options = {}) {
  const { numericKeys = false } = options;
  return Object.fromEntries(Object.entries(map)
    .sort((a, b) =>
      b[1] - a[1]
      || (numericKeys
        ? Number(a[0]) - Number(b[0])
        : a[0].localeCompare(b[0]))));
}

function sortedGroups(groups) {
  return [...groups.values()].sort((a, b) =>
    b.count - a.count
    || a.bucket.localeCompare(b.bucket)
    || a.bidder.localeCompare(b.bidder)
    || a.mtype.localeCompare(b.mtype)
    || a.admKind.localeCompare(b.admKind)
    || a.api.localeCompare(b.api));
}

function isReductionCandidate(group) {
  return group.bucket !== 'passed'
    && group.bucket !== 'unsupported-input'
    && group.count > 0;
}

function readReportJsonl(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`Failed to parse ${basename(file)} line ${index + 1}: ${err.message}`);
    }
  });
}

function triageReports(files) {
  const summary = emptySummary(files);
  const failureGroups = new Map();

  for (const file of files) {
    for (const row of readReportJsonl(file)) {
      const fields = reportFields(row);
      summary.totals.reports += 1;
      increment(summary.byStatus, fields.status);
      increment(summary.byBucket, fields.bucket);
      increment(summary.byBidder, fields.bidder);
      increment(summary.byMtype, fields.mtype);
      increment(summary.byAdmKind, fields.admKind);
      increment(summary.byApi, fields.api);
      for (const bridge of expectedBridgeKeys(row)) {
        increment(summary.byExpectedBridge, bridge);
      }
      addCorpusFacets(summary, row, fields);
      addRuntimeCorpusFacets(summary, row, fields);
      addOmidCorpusFacets(summary, row, fields);

      if (fields.status === 'passed') summary.totals.passed += 1;
      else if (fields.status === 'skipped') summary.totals.skipped += 1;
      else if (fields.status === 'failed') {
        summary.totals.failed += 1;
        addDiagnosticFacets(summary, row);
        addFailureGroup(failureGroups, row);
      } else {
        summary.totals.other += 1;
      }
    }
  }

  summary.byStatus = sortEntries(summary.byStatus);
  summary.byBucket = sortEntries(summary.byBucket);
  summary.byBidder = sortEntries(summary.byBidder);
  summary.byMtype = sortEntries(summary.byMtype);
  summary.byAdmKind = sortEntries(summary.byAdmKind);
  summary.byApi = sortEntries(summary.byApi);
  summary.byExpectedBridge = sortEntries(summary.byExpectedBridge);
  summary.diagnostics.bySecurityEvent = sortEntries(summary.diagnostics.bySecurityEvent);
  summary.diagnostics.bySecurityEventSet = sortEntries(summary.diagnostics.bySecurityEventSet);
  summary.diagnostics.unauthorizedNavigation.byVariant =
    sortEntries(summary.diagnostics.unauthorizedNavigation.byVariant);
  summary.diagnostics.unauthorizedNavigation.byMsSinceRender =
    sortEntries(summary.diagnostics.unauthorizedNavigation.byMsSinceRender);
  summary.diagnostics.navigationSources.documentWriteByCount =
    sortEntries(summary.diagnostics.navigationSources.documentWriteByCount, { numericKeys: true });
  summary.diagnostics.navigationSources.documentWriteByPattern =
    sortEntries(summary.diagnostics.navigationSources.documentWriteByPattern);
  summary.diagnostics.navigationSources.windowOpenByCount =
    sortEntries(summary.diagnostics.navigationSources.windowOpenByCount, { numericKeys: true });
  summary.diagnostics.navigationSources.windowOpenByProtocol =
    sortEntries(summary.diagnostics.navigationSources.windowOpenByProtocol);
  summary.diagnostics.navigationSources.bridgeCallByCount =
    sortEntries(summary.diagnostics.navigationSources.bridgeCallByCount, { numericKeys: true });
  summary.diagnostics.navigationSources.bridgeCallByMethod =
    sortEntries(summary.diagnostics.navigationSources.bridgeCallByMethod);
  summary.diagnostics.navigationSources.bridgeCallByProtocol =
    sortEntries(summary.diagnostics.navigationSources.bridgeCallByProtocol);
  summary.diagnostics.navigationSources.scriptLoadByCount =
    sortEntries(summary.diagnostics.navigationSources.scriptLoadByCount, { numericKeys: true });
  summary.diagnostics.navigationSources.scriptLoadByLoadedCount =
    sortEntries(summary.diagnostics.navigationSources.scriptLoadByLoadedCount, { numericKeys: true });
  summary.diagnostics.navigationSources.scriptLoadByErrorCount =
    sortEntries(summary.diagnostics.navigationSources.scriptLoadByErrorCount, { numericKeys: true });
  summary.diagnostics.navigationSources.scriptLoadByProtocol =
    sortEntries(summary.diagnostics.navigationSources.scriptLoadByProtocol);
  summary.diagnostics.navigationSources.scriptLoadByOrigin =
    sortEntries(summary.diagnostics.navigationSources.scriptLoadByOrigin);
  summary.diagnostics.navigationSources.scriptLoadByStatus =
    sortEntries(summary.diagnostics.navigationSources.scriptLoadByStatus);
  summary.diagnostics.network.byShape = sortEntries(summary.diagnostics.network.byShape);
  summary.diagnostics.network.byFailedRequestCount =
    sortEntries(summary.diagnostics.network.byFailedRequestCount, { numericKeys: true });
  summary.diagnostics.network.byFailedResponseCount =
    sortEntries(summary.diagnostics.network.byFailedResponseCount, { numericKeys: true });
  summary.diagnostics.network.byCorsConsoleCount =
    sortEntries(summary.diagnostics.network.byCorsConsoleCount, { numericKeys: true });
  summary.diagnostics.network.byCspConsoleCount =
    sortEntries(summary.diagnostics.network.byCspConsoleCount, { numericKeys: true });
  summary.diagnostics.legacyMraidLoader.byPresence =
    sortEntries(summary.diagnostics.legacyMraidLoader.byPresence);
  summary.diagnostics.legacyMraidLoader.bySignal =
    sortEntries(summary.diagnostics.legacyMraidLoader.bySignal);
  summary.diagnostics.legacyMraidLoader.byStatus =
    sortEntries(summary.diagnostics.legacyMraidLoader.byStatus);
  summary.diagnostics.legacyMraidLoader.byBucket =
    sortEntries(summary.diagnostics.legacyMraidLoader.byBucket);
  summary.diagnostics.legacyMraidLoader.byBidder =
    sortEntries(summary.diagnostics.legacyMraidLoader.byBidder);
  summary.diagnostics.legacyMraidLoader.byAdmKind =
    sortEntries(summary.diagnostics.legacyMraidLoader.byAdmKind);
  summary.diagnostics.legacyMraidLoader.byApi =
    sortEntries(summary.diagnostics.legacyMraidLoader.byApi);
  summary.diagnostics.legacyMraidLoader.byErrorCount =
    sortEntries(summary.diagnostics.legacyMraidLoader.byErrorCount, { numericKeys: true });
  summary.diagnostics.legacyMraidLoader.byLoadedCount =
    sortEntries(summary.diagnostics.legacyMraidLoader.byLoadedCount, { numericKeys: true });
  summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByBidder =
    sortEntries(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByBidder);
  summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByAdmKind =
    sortEntries(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByAdmKind);
  summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByLegacyMraidLoader =
    sortEntries(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByLegacyMraidLoader);
  summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByClass =
    sortEntries(summary.corpusDiagnostics.scriptLoads.rowsWithErrorsByClass);
  summary.corpusDiagnostics.scriptLoads.errorEventsByClass =
    sortEntries(summary.corpusDiagnostics.scriptLoads.errorEventsByClass);
  summary.corpusDiagnostics.scriptLoads.errorRowsByClassAndBidder =
    sortEntries(summary.corpusDiagnostics.scriptLoads.errorRowsByClassAndBidder);
  summary.corpusDiagnostics.scriptLoads.byCount =
    sortEntries(summary.corpusDiagnostics.scriptLoads.byCount, { numericKeys: true });
  summary.corpusDiagnostics.scriptLoads.byLoadedCount =
    sortEntries(summary.corpusDiagnostics.scriptLoads.byLoadedCount, { numericKeys: true });
  summary.corpusDiagnostics.scriptLoads.byErrorCount =
    sortEntries(summary.corpusDiagnostics.scriptLoads.byErrorCount, { numericKeys: true });
  summary.corpusDiagnostics.scriptLoads.byProtocol =
    sortEntries(summary.corpusDiagnostics.scriptLoads.byProtocol);
  summary.corpusDiagnostics.scriptLoads.byOrigin =
    sortEntries(summary.corpusDiagnostics.scriptLoads.byOrigin);
  summary.corpusDiagnostics.scriptLoads.byStatus =
    sortEntries(summary.corpusDiagnostics.scriptLoads.byStatus);
  summary.corpusDiagnostics.network.byShape =
    sortEntries(summary.corpusDiagnostics.network.byShape);
  summary.corpusDiagnostics.network.byFailedRequestCount =
    sortEntries(summary.corpusDiagnostics.network.byFailedRequestCount, { numericKeys: true });
  summary.corpusDiagnostics.network.byFailedResponseCount =
    sortEntries(summary.corpusDiagnostics.network.byFailedResponseCount, { numericKeys: true });
  summary.corpusDiagnostics.network.byCorsConsoleCount =
    sortEntries(summary.corpusDiagnostics.network.byCorsConsoleCount, { numericKeys: true });
  summary.corpusDiagnostics.network.byCspConsoleCount =
    sortEntries(summary.corpusDiagnostics.network.byCspConsoleCount, { numericKeys: true });
  summary.corpusDiagnostics.network.documentSourcesByKind =
    sortEntries(summary.corpusDiagnostics.network.documentSourcesByKind);
  summary.corpusDiagnostics.network.documentSourcesByProtocol =
    sortEntries(summary.corpusDiagnostics.network.documentSourcesByProtocol);
  summary.corpusDiagnostics.network.documentSourcesByOrigin =
    sortEntries(summary.corpusDiagnostics.network.documentSourcesByOrigin);
  summary.corpusDiagnostics.network.documentSourcesByTag =
    sortEntries(summary.corpusDiagnostics.network.documentSourcesByTag);
  summary.corpusDiagnostics.network.documentSourceRowsByBidder =
    sortEntries(summary.corpusDiagnostics.network.documentSourceRowsByBidder);
  summary.corpusDiagnostics.network.failedRowsByBidder =
    sortEntries(summary.corpusDiagnostics.network.failedRowsByBidder);
  summary.corpusDiagnostics.network.failedRowsByAdmKind =
    sortEntries(summary.corpusDiagnostics.network.failedRowsByAdmKind);
  summary.corpusDiagnostics.network.corsRowsByBidder =
    sortEntries(summary.corpusDiagnostics.network.corsRowsByBidder);
  summary.corpusDiagnostics.network.cspRowsByBidder =
    sortEntries(summary.corpusDiagnostics.network.cspRowsByBidder);
  summary.corpusDiagnostics.network.failedDocumentRowsByBidder =
    sortEntries(summary.corpusDiagnostics.network.failedDocumentRowsByBidder);
  summary.corpusDiagnostics.network.failedResourceType =
    sortEntries(summary.corpusDiagnostics.network.failedResourceType);
  summary.corpusDiagnostics.network.failedResponseStatus =
    sortEntries(summary.corpusDiagnostics.network.failedResponseStatus, { numericKeys: true });
  summary.corpusDiagnostics.omid.byOutcome =
    sortEntries(summary.corpusDiagnostics.omid.byOutcome);
  summary.corpusDiagnostics.omid.byVerificationScriptCount =
    sortEntries(summary.corpusDiagnostics.omid.byVerificationScriptCount, { numericKeys: true });
  summary.corpusDiagnostics.omid.capabilityRowsByBidder =
    sortEntries(summary.corpusDiagnostics.omid.capabilityRowsByBidder);
  summary.corpusDiagnostics.omid.capabilityNoSidecarRowsByBidder =
    sortEntries(summary.corpusDiagnostics.omid.capabilityNoSidecarRowsByBidder);
  summary.corpusDiagnostics.omid.sidecarRowsByBidder =
    sortEntries(summary.corpusDiagnostics.omid.sidecarRowsByBidder);
  summary.corpusDiagnostics.omid.sessionNotStartedRowsByBidder =
    sortEntries(summary.corpusDiagnostics.omid.sessionNotStartedRowsByBidder);
  summary.failureGroups = sortedGroups(failureGroups);
  summary.reductionCandidates = summary.failureGroups
    .filter(isReductionCandidate)
    .slice(0, 20);
  return summary;
}

export {
  triageReports,
};
