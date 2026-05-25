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
  consoleMessages: [],
  pageErrors: [],
  failedRequests: [],
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
    consoleMessages: [],
    pageErrors: [],
    failedRequests: [],
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
  return (run.consoleMessages || []).some((msg) => {
    const text = String(msg && msg.text ? msg.text : '').toLowerCase();
    return text.includes('cors')
      || text.includes('cross-origin')
      || text.includes('content security policy')
      || text.includes('csp');
  });
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
  hasNetworkDiagnostics,
  makeEmptyRun,
};
