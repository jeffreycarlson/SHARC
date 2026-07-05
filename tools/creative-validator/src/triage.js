/**
 * @file Creative validator report triage.
 *
 * Converts private runner report JSONL into aggregate summaries for manual
 * issue filing and synthetic-reduction planning. The summary intentionally
 * avoids raw creative markup and keeps sample identifiers bounded.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { omidVendorMatchesHostname } from './normalizer.js';

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
        documentSourceRowsByClass: {},
        documentSourceEventsByClass: {},
        documentSourceRowsByClassAndBidder: {},
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
        scriptCache: {
          rowsEnabled: 0,
          rowsWithHits: 0,
          rowsWithStores: 0,
          lookups: 0,
          hits: 0,
          misses: 0,
          stores: 0,
          skipped: 0,
          errors: 0,
          bytesFromNetwork: 0,
          bytesFromCache: 0,
          byOrigin: {},
        },
      },
      mraidLifecycleGates: {
        rowsWithDiagnostics: 0,
        rowsExpected: 0,
        byGate1: {},
        byGate2: {},
        byGate3: {},
        byErrorReplay: {},
        byFailedGate: {},
        expectedRowsByStatus: {},
        expectedRowsByBucket: {},
      },
      omid: {
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
        // #244 / #211B: real-OM-SDK service-path facets. `rowsBySdkMode`
        // separates real-service rows from legacy-mock rows; the delivery-
        // channel facet attributes each inline-vendor row to the channel that
        // carried its measurement; the resource-count distribution is the D7
        // `MAX_OMID_VERIFICATION_RESOURCES` evidence (distinct service-
        // injected vendor resources per session — validator canary excluded).
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
        // G3 teardown probe: the harness drives `container.close()` before the
        // diagnostics snapshot so sessionFinish delivery is exercised through
        // the real chain. Evidence-only — finish receipt does not gate any
        // verdict bucket (a future strictness bump may change that).
        teardownProbe: {
          rowsProbed: 0,
          rowsCloseRequested: 0,
          rowsWaitTimedOut: 0,
          rowsSessionFinished: 0,
          rowsCanarySessionFinish: 0,
          rowsOmid3pSessionFinish: 0,
        },
        // Per inline-vendor row: which channel(s) demonstrably received the
        // teardown sessionFinish — 'omid3p' (attributed creative-window
        // callback), 'service-canary' (the canary, subscribed through the
        // identical verification-service protocol, received the service's
        // dispatch), 'both', 'none', or 'not-probed'.
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

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function finalizeDistribution(facet, byCountKey = 'byCount') {
  const values = [];
  for (const [rawCount, rows] of Object.entries(facet[byCountKey])) {
    const count = Number(rawCount);
    if (!Number.isFinite(count)) continue;
    for (let i = 0; i < rows; i += 1) values.push(count);
  }
  facet.median = percentile(values, 50);
  facet.p99 = percentile(values, 99);
  facet.max = values.length > 0 ? Math.max(...values) : 0;
  facet[byCountKey] = sortEntries(facet[byCountKey], { numericKeys: true });
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

function latestBridgeProbe(row) {
  const probes = row && row.diagnostics && Array.isArray(row.diagnostics.bridgeProbes)
    ? row.diagnostics.bridgeProbes
    : [];
  return probes.length > 0 ? probes[probes.length - 1] : null;
}

function mraidLifecycleDiagnostics(row) {
  const probe = latestBridgeProbe(row);
  const mraid = probe && probe.bridges && probe.bridges.mraid;
  return mraid && mraid.lifecycle ? mraid.lifecycle : null;
}

function mraidLifecycleExpected(row) {
  return !!(row
    && row.case
    && row.case.expectations
    && row.case.expectations.mraidLifecycleGates === true);
}

function gateKey(passed) {
  return passed === true ? 'passed' : 'failed';
}

function evaluateMraidLifecycleDiagnostics(row) {
  const lifecycle = mraidLifecycleDiagnostics(row);
  if (!lifecycle) {
    return {
      gate1: false,
      gate2: false,
      gate3: false,
      errorReplay: null,
      failedGate: 'missing-diagnostics',
    };
  }
  const parse = lifecycle.parse || {};
  const ready = lifecycle.ready || {};
  const stateChange = lifecycle.stateChange || {};
  const viewable = lifecycle.viewableChange || {};
  const exposure = lifecycle.exposureChange || {};
  const error = lifecycle.error || {};
  const exposurePercent = Number.isFinite(exposure.lastPercentage)
    ? exposure.lastPercentage
    : exposure.firstPercentage;
  const gate1 = parse.mraidExists === true
    && parse.getStateStatus === 'ok'
    && parse.getStateValue === 'loading'
    && parse.readyDeliveredBeforeParseEnd !== true
    && parse.defaultStateChangeDeliveredBeforeParseEnd !== true;
  const gate2 = ready.delivered === true
    && Number.isFinite(lifecycle.documentLoadAt)
    && Number.isFinite(ready.firstAt)
    && ready.firstAt >= lifecycle.documentLoadAt
    && ready.stateDefaultDeliveredAtOrBeforeReady === true
    && Number.isFinite(stateChange.firstDefaultAt)
    && stateChange.firstDefaultAt <= ready.firstAt
    && ready.getStateAfterReady === 'default'
    && ready.lateReplayDelivered === true
    && ready.lateReplayCount === 1
    && ready.parseListenerCountAfterLateAttach === 1;
  const gate3 = viewable.trueDelivered === true
    && viewable.isViewableAtTrue === true
    && exposure.delivered === true
    && Number.isInteger(exposurePercent)
    && exposurePercent >= 50
    && exposurePercent <= 100;
  const errorReplay = error.count > 0 && error.lateReplayDelivered === true;
  const failedGate = !gate1 ? 'gate-1' : !gate2 ? 'gate-2' : !gate3 ? 'gate-3' : null;
  return { gate1, gate2, gate3, errorReplay, failedGate };
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

function scriptCacheDiagnostics(row) {
  const network = networkDiagnostics(row);
  return network && network.scriptCache ? network.scriptCache : {};
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

function omidBidSignals(row) {
  return row
    && row.case
    && row.case.bidSignals
    && row.case.bidSignals.measurement
    && row.case.bidSignals.measurement.omid
    ? row.case.bidSignals.measurement.omid
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

function omidInstrumentationSignalKey(declaredByApi, inlineInstrumented) {
  if (declaredByApi && inlineInstrumented) return 'declared-api7+inline-vendor';
  if (declaredByApi) return 'declared-api7-only';
  if (inlineInstrumented) return 'inline-vendor-only';
  return 'absent';
}

function scriptCacheOriginHasLoadedBytes(values) {
  return networkCount(values && values.hits) > 0
    || networkCount(values && values.stores) > 0
    || networkCount(values && values.bytesFromNetwork) > 0
    || networkCount(values && values.bytesFromCache) > 0;
}

function expectedInlineVendorScriptCacheObserved(row, bidOmid) {
  const vendors = Array.isArray(bidOmid.inlineVendorVendors)
    ? bidOmid.inlineVendorVendors
    : [];
  if (vendors.length === 0) return false;
  const byOrigin = scriptCacheDiagnostics(row).byOrigin || {};
  for (const [origin, values] of Object.entries(byOrigin)) {
    if (!scriptCacheOriginHasLoadedBytes(values)) continue;
    let hostname = null;
    try {
      hostname = new URL(origin).hostname;
    } catch (_) {
      hostname = null;
    }
    if (vendors.some((vendor) => omidVendorMatchesHostname(vendor, hostname))) {
      return true;
    }
  }
  return false;
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

function documentSourceClasses(documentSources) {
  const rows = new Set();
  const events = {};
  const add = (name, count = 1) => {
    // Row classes are idempotent; event counts preserve repeated observations.
    rows.add(name);
    increment(events, name, count);
  };
  const calls = documentSources && Array.isArray(documentSources.calls)
    ? documentSources.calls
    : [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const url = call.url || {};
    const protocol = normalizeKey(url.protocol || (call.assignedUrl && call.assignedUrl.protocol));
    const isFrameLike = call.kind === 'frame' || call.kind === 'frame-src';
    if (call.kind === 'frame-src') add('frame-src-assignment');
    if (call.kind === 'frame') add('observed-frame');
    if (call.kind === 'form' || call.kind === 'form-submit') add('form-source');
    if (call.srcdoc === true) add('srcdoc-frame');
    if (protocol === 'http:' || protocol === 'https:') {
      add('external-frame');
    }
    if (protocol === 'https:') add('secure-frame');
    if (protocol === 'http:') add('insecure-frame');
    if (isFrameLike && (protocol === 'about:' || protocol === 'unknown')) {
      add('blank-or-opaque-document');
    }
  }

  // Older reports may not include bounded calls. Fall back to aggregate facets
  // so the class fields remain useful when triaging mixed report generations.
  // The aggregate fallback cannot correlate kind and protocol; current reports
  // with bounded calls are authoritative for blank/opaque frame classification.
  if (calls.length === 0) {
    const byKind = documentSources && documentSources.byKind ? documentSources.byKind : {};
    const byProtocol = documentSources && documentSources.byProtocol ? documentSources.byProtocol : {};
    for (const [kind, count] of Object.entries(byKind)) {
      const n = networkCount(count);
      if (n === 0) continue;
      if (kind === 'frame-src') add('frame-src-assignment', n);
      if (kind === 'frame') add('observed-frame', n);
      if (kind === 'form' || kind === 'form-submit') add('form-source', n);
    }
    for (const [protocol, count] of Object.entries(byProtocol)) {
      const n = networkCount(count);
      if (n === 0) continue;
      if (protocol === 'http:' || protocol === 'https:') add('external-frame', n);
      if (protocol === 'https:') add('secure-frame', n);
      if (protocol === 'http:') add('insecure-frame', n);
      if (protocol === 'about:' || protocol === 'unknown') add('blank-or-opaque-document', n);
    }
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
  // Intentionally aggregate only creative-initiated bridgeCalls here.
  // probeBridgeCalls are validator self-check traffic; runner tests assert they
  // stay separated so corpus triage can read bridgeCall facets as creative
  // behavior without subtracting a probe baseline.
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

function addMraidLifecycleGateFacets(summary, row, fields) {
  const lifecycle = mraidLifecycleDiagnostics(row);
  const expected = mraidLifecycleExpected(row);
  if (!lifecycle && !expected) return;
  const facet = summary.corpusDiagnostics.mraidLifecycleGates;
  if (lifecycle) facet.rowsWithDiagnostics += 1;
  if (expected) {
    facet.rowsExpected += 1;
    increment(facet.expectedRowsByStatus, fields.status);
    increment(facet.expectedRowsByBucket, fields.bucket);
  }
  const gates = evaluateMraidLifecycleDiagnostics(row);
  increment(facet.byGate1, gateKey(gates.gate1));
  increment(facet.byGate2, gateKey(gates.gate2));
  increment(facet.byGate3, gateKey(gates.gate3));
  if (gates.errorReplay !== null) {
    increment(facet.byErrorReplay, gateKey(gates.errorReplay));
  }
  if (gates.failedGate) {
    increment(facet.byFailedGate, gates.failedGate);
  }
}

function addRuntimeCorpusFacets(summary, row, fields) {
  const navigation = navigationDiagnostics(row);
  const scriptLoads = navigation.scriptLoads || {};
  const legacy = legacyMraidLoaderDiagnostics(row);
  const scriptCache = scriptCacheDiagnostics(row);
  if (scriptCache.enabled === true) {
    const cacheFacet = summary.corpusDiagnostics.network.scriptCache;
    const lookups = networkCount(scriptCache.lookups);
    const hits = networkCount(scriptCache.hits);
    const misses = networkCount(scriptCache.misses);
    const stores = networkCount(scriptCache.stores);
    const skipped = networkCount(scriptCache.skipped);
    const errors = networkCount(scriptCache.errors);
    const bytesFromNetwork = networkCount(scriptCache.bytesFromNetwork);
    const bytesFromCache = networkCount(scriptCache.bytesFromCache);
    cacheFacet.rowsEnabled += 1;
    if (hits > 0) cacheFacet.rowsWithHits += 1;
    if (stores > 0) cacheFacet.rowsWithStores += 1;
    cacheFacet.lookups += lookups;
    cacheFacet.hits += hits;
    cacheFacet.misses += misses;
    cacheFacet.stores += stores;
    cacheFacet.skipped += skipped;
    cacheFacet.errors += errors;
    cacheFacet.bytesFromNetwork += bytesFromNetwork;
    cacheFacet.bytesFromCache += bytesFromCache;
    for (const [origin, values] of Object.entries(scriptCache.byOrigin || {})) {
      if (!cacheFacet.byOrigin[origin]) {
        cacheFacet.byOrigin[origin] = {
          lookups: 0,
          hits: 0,
          misses: 0,
          stores: 0,
          bytesFromNetwork: 0,
          bytesFromCache: 0,
        };
      }
      cacheFacet.byOrigin[origin].lookups += networkCount(values && values.lookups);
      cacheFacet.byOrigin[origin].hits += networkCount(values && values.hits);
      cacheFacet.byOrigin[origin].misses += networkCount(values && values.misses);
      cacheFacet.byOrigin[origin].stores += networkCount(values && values.stores);
      cacheFacet.byOrigin[origin].bytesFromNetwork += networkCount(values && values.bytesFromNetwork);
      cacheFacet.byOrigin[origin].bytesFromCache += networkCount(values && values.bytesFromCache);
    }
  }
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
    const classes = documentSourceClasses(documentSources);
    for (const name of classes.rows) {
      increment(summary.corpusDiagnostics.network.documentSourceRowsByClass, name);
      increment(
        summary.corpusDiagnostics.network.documentSourceRowsByClassAndBidder,
        `${name}|${fields.bidder}`,
      );
    }
    for (const [name, count] of Object.entries(classes.events)) {
      increment(summary.corpusDiagnostics.network.documentSourceEventsByClass, name, count);
    }
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
  const bidOmid = omidBidSignals(row);
  const facet = summary.corpusDiagnostics.omid;
  const declaredByApi = omid.expected === true || bidOmid.declaredByApi === true;
  const inlineInstrumented = bidOmid.inlineVendorScriptPresent === true
    || networkCount(bidOmid.inlineVendorScriptCount) > 0;
  const inlineScriptCount = networkCount(bidOmid.inlineVendorScriptCount);
  facet.rows += 1;
  if (bidOmid.inlineVendorScanTruncated === true) facet.rowsScanTruncated += 1;
  if (bidOmid.inlineVendorScriptTagLimitReached === true) facet.rowsTagLimitReached += 1;

  // #244 / #211B: real-OM-SDK service-path facets, fed by the runner's
  // `diagnostics.measurement.omid.sdkMode` / `.service` signals.
  if (omid.expected === true || inlineInstrumented) {
    increment(facet.rowsBySdkMode, omid.sdkMode || 'mock');
  }
  const service = omid.service && typeof omid.service === 'object' ? omid.service : null;
  if (service && service.sdkMode === 'service') {
    const resourceCount = networkCount(service.injectedResourceCount);
    const resourceFacet = facet.serviceInjectedResourceCount;
    resourceFacet.rowsMeasured += 1;
    increment(resourceFacet.byResourceCount, resourceCount);
    for (const vendor of Object.keys(service.subscriptionsByVendor || {})) {
      increment(facet.serviceSubscriptionRowsByVendor, vendor);
    }
    const canary = service.canary || {};
    const canaryRows = facet.serviceCanaryRows;
    if (canary.injected === true) canaryRows.injected += 1;
    if (canary.loaded === true) canaryRows.loaded += 1;
    if (canary.sessionStart === true) canaryRows.sessionStart += 1;
    if (canary.impression === true) canaryRows.impression += 1;
    if (canary.sessionFinish === true) canaryRows.sessionFinish += 1;
    if (canary.deliveryComplete === true) canaryRows.deliveryComplete += 1;
  }
  const teardown = omid.teardown && typeof omid.teardown === 'object' ? omid.teardown : null;
  const teardownProbed = !!(teardown && teardown.probed === true);
  const canarySessionFinish = !!(service && service.canary
    && service.canary.sessionFinish === true);
  const omid3pSessionFinish = !!(omid.inlineVendor
    && omid.inlineVendor.lifecycle
    && omid.inlineVendor.lifecycle.sessionFinish === true);
  if (teardownProbed) {
    facet.teardownProbe.rowsProbed += 1;
    if (teardown.closeRequested === true) facet.teardownProbe.rowsCloseRequested += 1;
    if (teardown.waitTimedOut === true) facet.teardownProbe.rowsWaitTimedOut += 1;
    if (omid.sessionFinished === true) facet.teardownProbe.rowsSessionFinished += 1;
    if (canarySessionFinish) facet.teardownProbe.rowsCanarySessionFinish += 1;
    if (omid3pSessionFinish) facet.teardownProbe.rowsOmid3pSessionFinish += 1;
  }
  increment(facet.byInstrumentationSignal, omidInstrumentationSignalKey(declaredByApi, inlineInstrumented));
  if (!declaredByApi && !inlineInstrumented) facet.rowsAbsent += 1;
  if (inlineInstrumented) {
    facet.rowsInlineInstrumented += 1;
    increment(facet.byInlineVendorScriptCount, inlineScriptCount);
    increment(facet.inlineVendorRowsByBidder, fields.bidder);
    const vendors = Array.isArray(bidOmid.inlineVendorVendors)
      ? bidOmid.inlineVendorVendors
      : [];
    for (const vendor of vendors) increment(facet.inlineVendorRowsByVendor, vendor);
    if (declaredByApi) facet.rowsCapabilityDeclaredInlineInstrumented += 1;
    else facet.rowsInlineInstrumentedWithoutCapability += 1;

    const inlineVendor = omid.inlineVendor || {};
    increment(facet.inlineVendorRowsByAccessMode, inlineVendor.accessMode || 'not-run');
    if (inlineVendor.expected === true) {
      const cumulativeRegisterCalls =
        networkCount(inlineVendor.registerSessionObserverCalls)
        + networkCount(inlineVendor.addEventListenerCalls);
      const cap = facet.inlineVendorSubscriptionCap;
      cap.rowsMeasured += 1;
      increment(cap.byCumulativeRegisterCallCount, cumulativeRegisterCalls);
      const profile = facet.inlineVendorSessionProfile;
      const durationMs = networkCount(row.outcome && row.outcome.durationMs);
      const geometryChangeCallbacks = networkCount(
        inlineVendor.callbackEventsByType && inlineVendor.callbackEventsByType.geometryChange,
      );
      profile.rowsMeasured += 1;
      increment(profile.durationMs.byCount, durationMs);
      increment(profile.geometryChangeCallbacks.byCount, geometryChangeCallbacks);

      let runtimeOutcome = 'omid3p-missing';
      if (inlineVendor.omid3pFound === true
          && inlineVendor.expectedVendorSubscriptionObserved === true) {
        runtimeOutcome = inlineVendor.passed === true ? 'observed-lifecycle' : 'subscribed-no-lifecycle';
      } else if (inlineVendor.omid3pFound === true && inlineVendor.subscriptionObserved === true) {
        runtimeOutcome = 'unattributed-subscription';
      } else if (inlineVendor.omid3pFound === true) {
        runtimeOutcome = 'omid3p-no-subscription';
      }
      increment(facet.inlineVendorRowsByRuntimeOutcome, runtimeOutcome);
      increment(facet.inlineVendorRowsByDiagnosticOutcome, inlineVendor.diagnosticOutcome || runtimeOutcome);
      // #244: which channel carried the attributed measurement for this row —
      // 'omid3p' (0.7.8 shim), 'service' (real omweb-v1 injected copy),
      // 'both', or 'none'.
      increment(facet.inlineVendorRowsByDeliveryChannel, inlineVendor.deliveryChannel || 'none');
      // G3 teardown probe: per-row sessionFinish receipt column. Evidence
      // only — does not feed the runtime/diagnostic outcome buckets above.
      let sessionFinishReceipt = 'not-probed';
      if (teardownProbed) {
        sessionFinishReceipt = omid3pSessionFinish && canarySessionFinish
          ? 'both'
          : omid3pSessionFinish
            ? 'omid3p'
            : canarySessionFinish
              ? 'service-canary'
              : 'none';
      }
      increment(facet.inlineVendorRowsBySessionFinishReceipt, sessionFinishReceipt);
      increment(
        facet.inlineVendorRowsByExpectedAttribution,
        inlineVendor.expectedVendorSubscriptionObserved === true ? 'expected-vendor' : 'none',
      );
      const expectedScriptCacheObserved = expectedInlineVendorScriptCacheObserved(row, bidOmid);
      const scriptCacheKey = expectedScriptCacheObserved
        ? (inlineVendor.subscriptionObserved === true ? 'expected-script-cache-subscribed' : 'expected-script-cache-no-subscription')
        : 'expected-script-cache-not-observed';
      increment(facet.inlineVendorRowsByExpectedScriptCache, scriptCacheKey);
      if (scriptCacheKey === 'expected-script-cache-no-subscription') {
        facet.inlineVendorExpectedScriptCacheNoSubscriptionRows += 1;
      }
      for (const [vendor, count] of Object.entries(inlineVendor.callsBySourceVendor || {})) {
        increment(facet.inlineVendorSubscriptionCallsBySourceVendor, vendor, networkCount(count));
      }
      for (const [origin, count] of Object.entries(inlineVendor.callsBySourceOrigin || {})) {
        increment(facet.inlineVendorSubscriptionCallsBySourceOrigin, origin, networkCount(count));
      }
      for (const [vendor, count] of Object.entries(inlineVendor.unattributedCallsBySourceVendor || {})) {
        const n = networkCount(count);
        increment(facet.inlineVendorUnattributedCallsBySourceVendor, vendor, n);
        if (n > 0) increment(facet.inlineVendorUnattributedRowsBySourceVendor, vendor);
      }
      for (const [origin, count] of Object.entries(inlineVendor.unattributedCallsBySourceOrigin || {})) {
        const n = networkCount(count);
        increment(facet.inlineVendorUnattributedCallsBySourceOrigin, origin, n);
        if (n > 0) increment(facet.inlineVendorUnattributedRowsBySourceOrigin, origin);
      }

      let lifecycleOutcome = 'not-applicable';
      if (inlineVendor.lifecycleComplete === true) lifecycleOutcome = 'complete';
      else if (inlineVendor.lifecycleObserved === true) lifecycleOutcome = 'partial';
      else if (inlineVendor.lifecycleNotObserved === true) lifecycleOutcome = 'subscribed-none';
      increment(facet.inlineVendorRowsByLifecycleObservation, lifecycleOutcome);
    } else {
      increment(facet.inlineVendorRowsByRuntimeOutcome, 'not-run');
      increment(facet.inlineVendorRowsByDiagnosticOutcome, 'not-run');
      increment(facet.inlineVendorRowsByLifecycleObservation, 'not-run');
      increment(facet.inlineVendorRowsByExpectedAttribution, 'not-run');
      increment(facet.inlineVendorRowsByExpectedScriptCache, 'not-run');
      increment(facet.inlineVendorRowsByDeliveryChannel, 'not-run');
      increment(facet.inlineVendorRowsBySessionFinishReceipt, 'not-run');
    }
  }
  if (omid.sidecarPresent === true) facet.rowsWithSidecar += 1;
  if (omid.extensionPresent === true) facet.rowsWithExtension += 1;
  if (omid.featureAdvertised === true) facet.rowsFeatureAdvertised += 1;
  if (omid.sessionStarted === true) facet.rowsSessionStarted += 1;
  if (omid.sessionFinished === true) facet.rowsSessionFinished += 1;
  if (omid.loadedFired === true) facet.rowsLoadedFired += 1;
  if (omid.impressionFired === true) facet.rowsImpressionFired += 1;

  // Lifecycle evidence cross-tab: declared-by-API capability vs observed runtime
  // session, keyed by bidder. Aggregate-only — counts/buckets, no per-creative
  // identifiers — mirroring the #206 corpusDiagnostics by-bidder facets.
  const lifecycle = facet.lifecycle;
  const runtimeObserved = omid.sessionStarted === true;
  increment(
    lifecycle.byDeclaredVsRuntime,
    declaredByApi
      ? (runtimeObserved ? 'declared+runtime' : 'declared-no-runtime')
      : (runtimeObserved ? 'runtime-no-declared' : 'neither'),
  );
  if (omid.loadedFired === true) increment(lifecycle.loadedFiredRowsByBidder, fields.bidder);
  if (omid.impressionFired === true) increment(lifecycle.impressionFiredRowsByBidder, fields.bidder);
  if (omid.sessionFinished === true) increment(lifecycle.sessionFinishedRowsByBidder, fields.bidder);

  // Session-start outcome and declared-but-incomplete attribution only apply to
  // rows that actually ran an OMID runtime pass, matching the byOutcome gating.
  if (declaredByApi && omid.expected === true) {
    increment(
      lifecycle.bySessionStartOutcome,
      omid.sessionStarted === true ? 'started' : 'not-started',
    );
    if (omid.loadedFired !== true) increment(lifecycle.declaredNoLoadedRowsByBidder, fields.bidder);
    if (omid.sessionFinished !== true) {
      increment(lifecycle.declaredNoSessionFinishedRowsByBidder, fields.bidder);
    }
  }

  if (!declaredByApi) return;

  facet.rowsCapabilityDeclared += 1;

  // Runtime outcome buckets are based on diagnostics emitted by a runner pass.
  // Bidstream API 7 still counts as declared capability above, but rows without
  // OMID runtime diagnostics should not inflate "capability-no-sidecar".
  if (omid.expected !== true) return;

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

function sortObjectKeys(map) {
  return Object.fromEntries(Object.entries(map || {}).sort(([a], [b]) => a.localeCompare(b)));
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
      addMraidLifecycleGateFacets(summary, row, fields);
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
  summary.corpusDiagnostics.network.documentSourceRowsByClass =
    sortEntries(summary.corpusDiagnostics.network.documentSourceRowsByClass);
  summary.corpusDiagnostics.network.documentSourceEventsByClass =
    sortEntries(summary.corpusDiagnostics.network.documentSourceEventsByClass);
  summary.corpusDiagnostics.network.documentSourceRowsByClassAndBidder =
    sortEntries(summary.corpusDiagnostics.network.documentSourceRowsByClassAndBidder);
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
  summary.corpusDiagnostics.network.scriptCache.byOrigin =
    sortObjectKeys(summary.corpusDiagnostics.network.scriptCache.byOrigin);
  const mraidLifecycleGates = summary.corpusDiagnostics.mraidLifecycleGates;
  mraidLifecycleGates.byGate1 = sortEntries(mraidLifecycleGates.byGate1);
  mraidLifecycleGates.byGate2 = sortEntries(mraidLifecycleGates.byGate2);
  mraidLifecycleGates.byGate3 = sortEntries(mraidLifecycleGates.byGate3);
  mraidLifecycleGates.byErrorReplay = sortEntries(mraidLifecycleGates.byErrorReplay);
  mraidLifecycleGates.byFailedGate = sortEntries(mraidLifecycleGates.byFailedGate);
  mraidLifecycleGates.expectedRowsByStatus = sortEntries(mraidLifecycleGates.expectedRowsByStatus);
  mraidLifecycleGates.expectedRowsByBucket = sortEntries(mraidLifecycleGates.expectedRowsByBucket);
  summary.corpusDiagnostics.omid.byOutcome =
    sortEntries(summary.corpusDiagnostics.omid.byOutcome);
  summary.corpusDiagnostics.omid.byInstrumentationSignal =
    sortEntries(summary.corpusDiagnostics.omid.byInstrumentationSignal);
  summary.corpusDiagnostics.omid.byInlineVendorScriptCount =
    sortEntries(summary.corpusDiagnostics.omid.byInlineVendorScriptCount, { numericKeys: true });
  summary.corpusDiagnostics.omid.inlineVendorRowsByVendor =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByVendor);
  summary.corpusDiagnostics.omid.inlineVendorRowsByBidder =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByBidder);
  summary.corpusDiagnostics.omid.inlineVendorRowsByAccessMode =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByAccessMode);
  summary.corpusDiagnostics.omid.inlineVendorRowsByRuntimeOutcome =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByRuntimeOutcome);
  summary.corpusDiagnostics.omid.inlineVendorRowsByDiagnosticOutcome =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByDiagnosticOutcome);
  summary.corpusDiagnostics.omid.inlineVendorRowsByLifecycleObservation =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByLifecycleObservation);
  summary.corpusDiagnostics.omid.inlineVendorRowsByExpectedAttribution =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByExpectedAttribution);
  summary.corpusDiagnostics.omid.inlineVendorRowsByExpectedScriptCache =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByExpectedScriptCache);
  summary.corpusDiagnostics.omid.inlineVendorSubscriptionCallsBySourceVendor =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorSubscriptionCallsBySourceVendor);
  summary.corpusDiagnostics.omid.inlineVendorSubscriptionCallsBySourceOrigin =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorSubscriptionCallsBySourceOrigin);
  summary.corpusDiagnostics.omid.inlineVendorUnattributedCallsBySourceVendor =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorUnattributedCallsBySourceVendor);
  summary.corpusDiagnostics.omid.inlineVendorUnattributedCallsBySourceOrigin =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorUnattributedCallsBySourceOrigin);
  summary.corpusDiagnostics.omid.inlineVendorUnattributedRowsBySourceVendor =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorUnattributedRowsBySourceVendor);
  summary.corpusDiagnostics.omid.inlineVendorUnattributedRowsBySourceOrigin =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorUnattributedRowsBySourceOrigin);
  finalizeDistribution(
    summary.corpusDiagnostics.omid.inlineVendorSubscriptionCap,
    'byCumulativeRegisterCallCount',
  );
  summary.corpusDiagnostics.omid.rowsBySdkMode =
    sortEntries(summary.corpusDiagnostics.omid.rowsBySdkMode);
  summary.corpusDiagnostics.omid.inlineVendorRowsByDeliveryChannel =
    sortEntries(summary.corpusDiagnostics.omid.inlineVendorRowsByDeliveryChannel);
  summary.corpusDiagnostics.omid.serviceSubscriptionRowsByVendor =
    sortEntries(summary.corpusDiagnostics.omid.serviceSubscriptionRowsByVendor);
  finalizeDistribution(
    summary.corpusDiagnostics.omid.serviceInjectedResourceCount,
    'byResourceCount',
  );
  const profile = summary.corpusDiagnostics.omid.inlineVendorSessionProfile;
  finalizeDistribution(profile.durationMs);
  finalizeDistribution(profile.geometryChangeCallbacks);
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
  const omidLifecycle = summary.corpusDiagnostics.omid.lifecycle;
  omidLifecycle.byDeclaredVsRuntime = sortEntries(omidLifecycle.byDeclaredVsRuntime);
  omidLifecycle.bySessionStartOutcome = sortEntries(omidLifecycle.bySessionStartOutcome);
  omidLifecycle.loadedFiredRowsByBidder = sortEntries(omidLifecycle.loadedFiredRowsByBidder);
  omidLifecycle.impressionFiredRowsByBidder = sortEntries(omidLifecycle.impressionFiredRowsByBidder);
  omidLifecycle.sessionFinishedRowsByBidder = sortEntries(omidLifecycle.sessionFinishedRowsByBidder);
  omidLifecycle.declaredNoLoadedRowsByBidder = sortEntries(omidLifecycle.declaredNoLoadedRowsByBidder);
  omidLifecycle.declaredNoSessionFinishedRowsByBidder =
    sortEntries(omidLifecycle.declaredNoSessionFinishedRowsByBidder);
  summary.failureGroups = sortedGroups(failureGroups);
  summary.reductionCandidates = summary.failureGroups
    .filter(isReductionCandidate)
    .slice(0, 20);
  return summary;
}

export {
  triageReports,
};
