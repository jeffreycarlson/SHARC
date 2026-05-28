/**
 * @file Creative validator diagnosis buckets.
 */

const EMPTY_RUN = Object.freeze({
  durationMs: 0,
  constructionError: null,
  loadError: null,
  timedOut: false,
  creativeRendered: false,
  creativeInjected: false,
  terminated: false,
  finalState: null,
  placementSessionId: null,
  stateHistory: [],
  securityEvents: [],
  errors: [],
  navigationEvents: [],
  interactionEvents: [],
  messages: [],
  bridgeProbes: [],
  navigationDiagnostics: null,
  measurement: { omid: null },
  consoleMessages: [],
  pageErrors: [],
  failedRequests: [],
  failedResponses: [],
});

function makeEmptyRun(overrides = {}) {
  return {
    ...EMPTY_RUN,
    stateHistory: [],
    securityEvents: [],
    errors: [],
    navigationEvents: [],
    interactionEvents: [],
    messages: [],
    bridgeProbes: [],
    navigationDiagnostics: null,
    measurement: { omid: null },
    consoleMessages: [],
    pageErrors: [],
    failedRequests: [],
    failedResponses: [],
    ...overrides,
  };
}

function hasSecurityEvent(run, type) {
  return run.securityEvents.some((event) => event && event.type === type);
}

function hasRendererSubtype(run, subtype) {
  return run.securityEvents.some((event) =>
    event
      && event.type === 'renderer_protocol_error'
      && event.details
      && event.details.subtype === subtype);
}

function hasNetworkDiagnostics(run) {
  if (run.failedRequests && run.failedRequests.length > 0) return true;
  if (run.failedResponses && run.failedResponses.length > 0) return true;
  return (run.consoleMessages || []).some((msg) => {
    const text = String(msg && msg.text ? msg.text : '').toLowerCase();
    return text.includes('cors policy')
      || text.includes('access-control-allow-origin')
      || text.includes('content security policy');
  });
}

function expectedBridges(testCase) {
  const values = new Set([
    ...((testCase.expectations && testCase.expectations.declared) || []),
    ...((testCase.expectations && testCase.expectations.sniffed) || []),
  ]);
  // Phase 3 validates renderer bridges only. OMID remains a measurement signal
  // and is handled by measurement-omid buckets.
  return ['mraid', 'safeframe'].filter((bridge) => values.has(bridge));
}

function firstBridgeProbe(run) {
  return run.bridgeProbes && run.bridgeProbes.length > 0
    ? run.bridgeProbes[0]
    : null;
}

function bridgeProbeFor(probe, bridge) {
  if (!probe || !probe.bridges) return null;
  return probe.bridges[bridge] || null;
}

function hasBridgeApiError(probe) {
  if (!probe || !probe.methods) return false;
  return Object.values(probe.methods).some((method) =>
    method && method.status === 'threw');
}

function expectedOmid(testCase) {
  const declared = (testCase.expectations && testCase.expectations.declared) || [];
  return declared.includes('omid');
}

function omidSidecarExpected(testCase) {
  const omid = testCase
    && testCase.bidSignals
    && testCase.bidSignals.measurement
    && testCase.bidSignals.measurement.omid;
  return !!(omid && omid.sidecarPresent === true);
}

function omidRun(run) {
  return run && run.measurement && run.measurement.omid
    ? run.measurement.omid
    : null;
}

function classifyOutcome(testCase, run) {
  if (!testCase.expectations || testCase.expectations.execute !== true) {
    return {
      status: 'skipped',
      bucket: 'unsupported-input',
      reason: testCase.expectations ? testCase.expectations.skipReason : 'not-executable',
    };
  }

  if (run.constructionError || run.loadError) {
    return {
      status: 'failed',
      bucket: 'sharc-runner-error',
      reason: run.constructionError || run.loadError,
    };
  }

  if (hasRendererSubtype(run, 'timeout') || run.timedOut) {
    return { status: 'failed', bucket: 'renderer-timeout', reason: 'renderer timed out' };
  }
  if (hasRendererSubtype(run, 'integrity_failed')) {
    return { status: 'failed', bucket: 'renderer-integrity', reason: 'renderer integrity failed' };
  }
  if (hasSecurityEvent(run, 'renderer_origin_mismatch')) {
    return { status: 'failed', bucket: 'renderer-origin', reason: 'renderer origin mismatch' };
  }
  if (hasRendererSubtype(run, 'malformed_payload') || hasRendererSubtype(run, 'post_failed')) {
    return { status: 'failed', bucket: 'renderer-protocol', reason: 'renderer protocol error' };
  }
  if (hasSecurityEvent(run, 'renderer_failed')) {
    return { status: 'failed', bucket: 'renderer-protocol', reason: 'renderer failed' };
  }
  if (hasSecurityEvent(run, 'unauthorized_navigation')) {
    return { status: 'failed', bucket: 'navigation-policy', reason: 'unauthorized navigation' };
  }
  if (hasSecurityEvent(run, 'bridge_load_failed')) {
    return { status: 'failed', bucket: 'bridge-missing', reason: 'bridge failed to load' };
  }
  if (hasSecurityEvent(run, 'feature_load_failed')) {
    return { status: 'failed', bucket: 'measurement-omid', reason: 'feature load failed' };
  }

  if (expectedOmid(testCase) && omidSidecarExpected(testCase)) {
    const omid = omidRun(run);
    if (!omid || omid.extensionPresent !== true) {
      return { status: 'failed', bucket: 'measurement-omid', reason: 'OMID sidecar did not install measurement extension' };
    }
    if (omid.featureAdvertised !== true || omid.sessionStarted !== true) {
      return { status: 'failed', bucket: 'measurement-omid', reason: 'OMID measurement session did not start' };
    }
  }

  const expected = expectedBridges(testCase);
  const probe = firstBridgeProbe(run);
  if (expected.length > 0 && probe) {
    for (const bridge of expected) {
      const bridgeProbe = bridgeProbeFor(probe, bridge);
      if (!bridgeProbe || bridgeProbe.exists !== true) {
        return { status: 'failed', bucket: 'bridge-missing', reason: `${bridge} bridge missing` };
      }
      if (hasBridgeApiError(bridgeProbe)) {
        return { status: 'failed', bucket: 'bridge-api-error', reason: `${bridge} bridge probe failed` };
      }
    }
  }

  if (run.creativeRendered && !run.terminated) {
    return { status: 'passed', bucket: 'passed', reason: 'creative rendered without fatal signals' };
  }

  if (hasNetworkDiagnostics(run)) {
    return {
      status: 'failed',
      bucket: 'network-cors',
      reason: 'network/CORS/CSP diagnostics before terminal success',
    };
  }

  if (run.pageErrors && run.pageErrors.length > 0) {
    return { status: 'failed', bucket: 'creative-broken', reason: 'page error before terminal success' };
  }

  return { status: 'failed', bucket: 'inconclusive', reason: 'no terminal success signal' };
}

export {
  classifyOutcome,
  expectedBridges,
  hasNetworkDiagnostics,
  makeEmptyRun,
};
