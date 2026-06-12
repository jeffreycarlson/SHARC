/**
 * @file Creative validator diagnosis buckets.
 */

import { isOmidProductVendorScript, omidVendorMatchesHostname } from './normalizer.js';

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

// Match the canonical Chrome console phrasings, not bare `cors`/`csp`
// substrings (which collide with vendor names, script URLs, and base64 blobs).
function isCorsConsole(text) {
  const lower = String(text || '').toLowerCase();
  return lower.includes('cors policy') || lower.includes('access-control-allow-origin');
}

function isCspConsole(text) {
  return String(text || '').toLowerCase().includes('content security policy');
}

function hasNetworkDiagnostics(run) {
  if (run.failedRequests && run.failedRequests.length > 0) return true;
  if (run.failedResponses && run.failedResponses.length > 0) return true;
  return (run.consoleMessages || []).some((msg) => {
    const text = msg && msg.text ? msg.text : '';
    return isCorsConsole(text) || isCspConsole(text);
  });
}

function expectedBridges(testCase) {
  const values = new Set([
    ...((testCase.expectations && testCase.expectations.declared) || []),
    ...((testCase.expectations && testCase.expectations.sniffed) || []),
  ]);
  // Capability/alias set: declared OpenRTB APIs plus sniffed markup signals.
  // Validation is stricter and handled by bridgesToValidate below.
  return ['mraid', 'safeframe'].filter((bridge) => values.has(bridge));
}

function bridgesToValidate(testCase) {
  const sniffed = new Set((testCase.expectations && testCase.expectations.sniffed) || []);
  // Declared OpenRTB APIs mean the placement is capable of a bridge. They do
  // not prove the creative will use that bridge, so plain HTML ads should not
  // fail only because a declared-but-unsniffed bridge is absent from the probe.
  // If such a creative really depends on a missing bridge, runtime errors still
  // surface under creative-broken rather than the bridge-missing bucket.
  return ['mraid', 'safeframe'].filter((bridge) => sniffed.has(bridge));
}

function latestBridgeProbe(run) {
  return run.bridgeProbes && run.bridgeProbes.length > 0
    ? run.bridgeProbes[run.bridgeProbes.length - 1]
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

function omidInlineVendorExpected(testCase) {
  const omid = testCase
    && testCase.bidSignals
    && testCase.bidSignals.measurement
    && testCase.bidSignals.measurement.omid;
  if (!omid || omid.inlineVendorScriptPresent !== true) return false;
  // Product scoping (2026-06-12 G2 holdout discover): case files normalized
  // before product-scoped detection may list non-OMID vendor products (e.g.
  // DV dvbs_src*) under inlineVendorScripts. Re-derive the expectation from
  // the recorded scripts so those entries owe no OMID subscription.
  if (Array.isArray(omid.inlineVendorScripts) && omid.inlineVendorScripts.length > 0) {
    return omid.inlineVendorScripts.some((script) => isOmidProductVendorScript(script));
  }
  return true;
}

function omidRun(run) {
  return run && run.measurement && run.measurement.omid
    ? run.measurement.omid
    : null;
}

function diagnosticCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function scriptCacheOriginDeliveredBytes(values) {
  return diagnosticCount(values && values.hits) > 0
    || diagnosticCount(values && values.stores) > 0
    || diagnosticCount(values && values.bytesFromNetwork) > 0
    || diagnosticCount(values && values.bytesFromCache) > 0;
}

/**
 * True when the expected inline vendor's origin was asked for script bytes
 * and never delivered any (cache lookups with zero hits/stores/network bytes
 * — the `net::ERR_ABORTED` / dead-CDN signature). The vendor code never
 * executed, so the subscription checks would measure the network, not the
 * vendor. Creative/CDN-attributable, not SHARC-attributable.
 */
function expectedVendorScriptFetchFailed(testCase, run) {
  const omid = testCase
    && testCase.bidSignals
    && testCase.bidSignals.measurement
    && testCase.bidSignals.measurement.omid;
  const vendors = omid && Array.isArray(omid.inlineVendorVendors)
    ? omid.inlineVendorVendors
    : [];
  if (vendors.length === 0) return false;
  const byOrigin = run && run.scriptCache && run.scriptCache.byOrigin
    ? run.scriptCache.byOrigin
    : {};
  let vendorLookups = 0;
  for (const [origin, values] of Object.entries(byOrigin)) {
    let hostname;
    try {
      hostname = new URL(origin).hostname;
    } catch (_) {
      continue;
    }
    if (!vendors.some((vendor) => omidVendorMatchesHostname(vendor, hostname))) continue;
    // Any expected-vendor origin that delivered bytes disqualifies the
    // fetch-failed classification: the vendor code ran, so the unsoftened
    // subscribe checks apply.
    if (scriptCacheOriginDeliveredBytes(values)) return false;
    vendorLookups += diagnosticCount(values && values.lookups);
  }
  return vendorLookups > 0;
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

  if (omidInlineVendorExpected(testCase)) {
    const omid = omidRun(run);
    const inlineVendor = omid && omid.inlineVendor;
    // #244: two valid delivery channels (design D4). `servicePassed` means the
    // REAL `omweb-v1.js` injected the expected vendor's resource, that copy
    // subscribed through the verification-service protocol, and the validator
    // canary observed the service deliver sessionStart + impression. The
    // omid3p (0.7.8 shim) channel below stays for creative-window clients.
    const servicePassed = !!(inlineVendor && inlineVendor.servicePassed === true);
    if (!servicePassed) {
      // Distinct non-SHARC outcome: zero bytes of the expected vendor's code
      // ever arrived. This does NOT soften the subscribe checks below — a
      // vendor copy that loaded and stayed silent still fails them.
      if (expectedVendorScriptFetchFailed(testCase, run)) {
        return {
          status: 'failed',
          bucket: 'vendor-fetch-failed',
          reason: 'vendor script fetch failed (network): expected OMID vendor origin delivered zero script bytes',
        };
      }
      if (!inlineVendor || inlineVendor.omid3pFound !== true) {
        return {
          status: 'failed',
          bucket: 'measurement-omid',
          reason: 'inline OMID vendor script did not find window.omid3p',
        };
      }
      if (inlineVendor.subscriptionObserved !== true) {
        return {
          status: 'failed',
          bucket: 'measurement-omid',
          reason: 'inline OMID vendor script did not subscribe to OMID',
        };
      }
      if (inlineVendor.expectedVendorSubscriptionObserved !== true) {
        return {
          status: 'failed',
          bucket: 'measurement-omid',
          reason: 'inline OMID vendor script did not produce an attributed subscription',
        };
      }
    }
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

  const expected = bridgesToValidate(testCase);
  const probe = latestBridgeProbe(run);
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
  isCorsConsole,
  isCspConsole,
  makeEmptyRun,
};
