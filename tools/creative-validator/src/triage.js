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

function navigationDiagnostics(row) {
  return row && row.diagnostics && row.diagnostics.navigationDiagnostics
    ? row.diagnostics.navigationDiagnostics
    : {};
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
  summary.failureGroups = sortedGroups(failureGroups);
  summary.reductionCandidates = summary.failureGroups
    .filter(isReductionCandidate)
    .slice(0, 20);
  return summary;
}

export {
  triageReports,
};
