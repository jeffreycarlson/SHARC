/**
 * @file Creative validator diagnosis buckets.
 */

import {
  classifyOmidVendorResourceUrl,
  isOmidProductVendorScript,
  omidVendorMatchesHostname,
} from './normalizer.js';

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

function mraidLifecycleGateExpected(testCase) {
  return !!(testCase
    && testCase.expectations
    && testCase.expectations.mraidLifecycleGates === true);
}

function mraidErrorReplayGateExpected(testCase) {
  return !!(testCase
    && testCase.expectations
    && testCase.expectations.mraidErrorReplayGate === true);
}

function urlLifecycleGateExpected(testCase) {
  return !!(testCase
    && testCase.expectations
    && testCase.expectations.urlLifecycleGates === true);
}

function declaredApis(testCase) {
  return (testCase && testCase.expectations && testCase.expectations.declared) || [];
}

function urlMode(testCase) {
  return !!(testCase && testCase.creative && testCase.creative.mode === 'curl');
}

function mraidLifecycleDiagnostics(run) {
  const probe = latestBridgeProbe(run);
  const mraid = bridgeProbeFor(probe, 'mraid');
  return mraid && mraid.lifecycle ? mraid.lifecycle : null;
}

function urlLifecycleDiagnostics(run) {
  return run && run.urlLifecycle ? run.urlLifecycle : null;
}

function integerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function evaluateMraidLifecycleGates(run, options = {}) {
  const lifecycle = mraidLifecycleDiagnostics(run);
  const gate1 = {
    name: 'loading',
    passed: false,
    reason: 'mraid lifecycle diagnostics missing',
  };
  const gate2 = {
    name: 'ready',
    passed: false,
    reason: 'mraid lifecycle diagnostics missing',
  };
  const gate3 = {
    name: 'viewable-exposure',
    passed: false,
    reason: 'mraid lifecycle diagnostics missing',
  };
  const errorReplay = {
    name: 'error-replay',
    passed: !options.requireErrorReplay,
    reason: options.requireErrorReplay ? 'mraid lifecycle diagnostics missing' : 'not-required',
  };

  if (!lifecycle) {
    return { passed: false, failedGate: 'gate-1', gate1, gate2, gate3, errorReplay };
  }

  const parse = lifecycle.parse || {};
  gate1.passed = parse.mraidExists === true
    && parse.getStateStatus === 'ok'
    && parse.getStateValue === 'loading'
    && parse.readyDeliveredBeforeParseEnd !== true
    && parse.defaultStateChangeDeliveredBeforeParseEnd !== true;
  gate1.reason = gate1.passed
    ? 'passed'
    : 'parse-time mraid loading gate failed';

  const ready = lifecycle.ready || {};
  const stateChange = lifecycle.stateChange || {};
  const documentLoadAt = lifecycle.documentLoadAt;
  gate2.passed = ready.delivered === true
    && Number.isFinite(documentLoadAt)
    && Number.isFinite(ready.firstAt)
    && ready.firstAt >= documentLoadAt
    && ready.stateDefaultDeliveredAtOrBeforeReady === true
    && Number.isFinite(stateChange.firstDefaultAt)
    && stateChange.firstDefaultAt <= ready.firstAt
    && ready.getStateAfterReady === 'default'
    && ready.lateReplayDelivered === true
    && ready.lateReplayCount === 1
    && ready.parseListenerCountAfterLateAttach === 1;
  gate2.reason = gate2.passed
    ? 'passed'
    : 'ready delivery/replay gate failed';

  const viewable = lifecycle.viewableChange || {};
  const exposure = lifecycle.exposureChange || {};
  const exposurePercent = Number.isFinite(exposure.lastPercentage)
    ? exposure.lastPercentage
    : exposure.firstPercentage;
  gate3.passed = viewable.trueDelivered === true
    && viewable.isViewableAtTrue === true
    && exposure.delivered === true
    && integerInRange(exposurePercent, 50, 100);
  gate3.reason = gate3.passed
    ? 'passed'
    : 'viewable/exposure delivery gate failed';

  if (options.requireErrorReplay) {
    const error = lifecycle.error || {};
    errorReplay.passed = error.count > 0
      && error.lateReplayDelivered === true
      && typeof error.lateReplayMessage === 'string'
      && error.lateReplayMessage.length > 0;
    errorReplay.reason = errorReplay.passed
      ? 'passed'
      : 'error replay gate failed';
  }

  const gates = [
    ['gate-1', gate1],
    ['gate-2', gate2],
    ['gate-3', gate3],
    ['error-replay', errorReplay],
  ];
  const failed = gates.find(([, gate]) => gate.passed !== true);
  return {
    passed: !failed,
    failedGate: failed ? failed[0] : null,
    gate1,
    gate2,
    gate3,
    errorReplay,
  };
}

function mraidLifecycleGateResult(gates, failedGate) {
  if (failedGate === 'gate-1') return gates.gate1;
  if (failedGate === 'gate-2') return gates.gate2;
  if (failedGate === 'gate-3') return gates.gate3;
  return gates.errorReplay;
}

function evaluateUrlLifecycleGates(run, options = {}) {
  const lifecycle = urlLifecycleDiagnostics(run) || {};
  const gateU1 = {
    name: 'load-render',
    passed: false,
    reason: 'url lifecycle diagnostics missing',
  };
  const gateU2 = {
    name: 'handshake-ready',
    passed: options.requireSharc !== true,
    reason: options.requireSharc === true ? 'url lifecycle diagnostics missing' : 'not-required',
  };
  const gateU3 = {
    name: 'visibility-measurement',
    passed: options.requireSharc !== true && options.requireOmid !== true,
    reason: (options.requireSharc === true || options.requireOmid === true)
      ? 'url lifecycle diagnostics missing'
      : 'not-required',
  };

  gateU1.passed = lifecycle.loaded === true && run.creativeRendered === true;
  gateU1.reason = gateU1.passed
    ? 'passed'
    : 'creative URL did not load/render';

  if (options.requireSharc === true) {
    const handshake = lifecycle.handshake || {};
    const ready = lifecycle.ready || {};
    gateU2.passed = handshake.completed === true
      && ready.delivered === true
      && Number.isFinite(lifecycle.documentLoadAt)
      && Number.isFinite(ready.firstAt)
      && ready.firstAt >= lifecycle.documentLoadAt;
    gateU2.reason = gateU2.passed
      ? 'passed'
      : 'SHARC URL handshake/ready delivery gate failed';

    const visibility = lifecycle.visibility || {};
    gateU3.passed = visibility.delivered === true
      && Number.isFinite(visibility.effectivePercent)
      && visibility.effectivePercent > 0;
    gateU3.reason = gateU3.passed
      ? 'passed'
      : 'SHARC URL visibility delivery gate failed';
  } else if (options.requireOmid === true) {
    const omid = run && run.measurement && run.measurement.omid;
    gateU3.passed = !!(omid && omid.sessionStarted === true);
    gateU3.reason = gateU3.passed
      ? 'passed'
      : 'OMID service session did not start';
  }

  const gates = [
    ['gate-U1', gateU1],
    ['gate-U2', gateU2],
    ['gate-U3', gateU3],
  ];
  const failed = gates.find(([, gate]) => gate.passed !== true);
  return {
    passed: !failed,
    failedGate: failed ? failed[0] : null,
    gateU1,
    gateU2,
    gateU3,
  };
}

function urlLifecycleGateResult(gates, failedGate) {
  if (failedGate === 'gate-U1') return gates.gateU1;
  if (failedGate === 'gate-U2') return gates.gateU2;
  return gates.gateU3;
}

function urlLoadFailed(run) {
  const lifecycle = urlLifecycleDiagnostics(run) || {};
  const kind = lifecycle.loadFailure && lifecycle.loadFailure.kind;
  if (kind === 'request-failed' || kind === 'http-error') return true;
  if ((run.failedRequests || []).some((request) => request && request.resourceType === 'document')) return true;
  return (run.failedResponses || []).some((response) =>
    response && response.resourceType === 'document' && response.status >= 400);
}

function urlLoadTimedOut(run) {
  const lifecycle = urlLifecycleDiagnostics(run) || {};
  return run.timedOut === true
    || (lifecycle.loadFailure && lifecycle.loadFailure.kind === 'timeout');
}

function hasNoCreateSessionError(run) {
  return (run.errors || []).some((error) => error && error.code === 2212);
}

function classifyUrlLifecycleOutcome(testCase, run) {
  const declared = declaredApis(testCase);
  const lifecycle = urlLifecycleDiagnostics(run) || {};

  if (hasSecurityEvent(run, 'unauthorized_navigation')) {
    return { status: 'failed', bucket: 'navigation-policy', reason: 'unauthorized navigation' };
  }
  if (urlLoadFailed(run)) {
    return { status: 'failed', bucket: 'url-load-failed', reason: 'creative URL failed to load' };
  }
  if (urlLoadTimedOut(run)) {
    return { status: 'failed', bucket: 'url-load-timeout', reason: 'creative URL load timed out' };
  }
  if (declared.includes('mraid') || declared.includes('safeframe')) {
    return {
      status: 'failed',
      bucket: 'url-declared-api-unsupported',
      reason: 'declared bridge API is unsupported on Creative URL variant',
    };
  }
  if (declared.includes('sharc')
      && (!lifecycle.handshake || lifecycle.handshake.completed !== true || hasNoCreateSessionError(run))) {
    return {
      status: 'failed',
      bucket: 'declared-sharc-no-handshake',
      reason: 'declared SHARC Creative URL did not establish a session',
    };
  }

  const gates = evaluateUrlLifecycleGates(run, {
    requireSharc: declared.includes('sharc'),
    requireOmid: expectedOmid(testCase) && omidSidecarExpected(testCase),
  });
  if (gates.passed !== true) {
    const gate = urlLifecycleGateResult(gates, gates.failedGate);
    return {
      status: 'failed',
      bucket: 'creative-broken',
      reason: `${gates.failedGate} failed: ${gate.reason}`,
    };
  }
  return null;
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

function omidSidecarVerificationScripts(testCase) {
  const omid = testCase
    && testCase.sharcOptions
    && testCase.sharcOptions.creativeMeta
    && testCase.sharcOptions.creativeMeta.measurement
    && testCase.sharcOptions.creativeMeta.measurement.omid;
  return omid && Array.isArray(omid.verificationScripts)
    ? omid.verificationScripts
    : [];
}

/**
 * Vendors a sidecar (`bid.ext` measurement) delivery owes a subscription for:
 * declared `VerificationScriptResource` URLs that the product-scoped vendor
 * table can attribute. Sidecar-only delivery previously carried no vendor
 * obligation, so a broken vendor CDN still classified `passed` (#385 review).
 * Derived from the recorded sidecar — not from normalizer-time flags — so case
 * files normalized before this rule gain the expectation on rerun. Unknown
 * resource URLs create NO expectation.
 */
function omidSidecarVendorsExpected(testCase) {
  const vendors = new Set();
  for (const script of omidSidecarVerificationScripts(testCase)) {
    const vendor = classifyOmidVendorResourceUrl(script && script.resourceUrl);
    if (vendor) vendors.add(vendor);
  }
  return [...vendors].sort();
}

function omidServiceModeRun(run) {
  const omid = run && run.measurement && run.measurement.omid;
  return !!(omid && omid.sdkMode === 'service');
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
function expectedVendorScriptFetchFailed(testCase, run, sidecarVendors = []) {
  const omid = testCase
    && testCase.bidSignals
    && testCase.bidSignals.measurement
    && testCase.bidSignals.measurement.omid;
  const inlineVendors = omid && Array.isArray(omid.inlineVendorVendors)
    ? omid.inlineVendorVendors
    : [];
  const vendors = [...new Set([...inlineVendors, ...sidecarVendors])];
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

  if (urlMode(testCase) && urlLifecycleGateExpected(testCase)) {
    const urlOutcome = classifyUrlLifecycleOutcome(testCase, run);
    if (urlOutcome) return urlOutcome;
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

  const inlineVendorExpected = omidInlineVendorExpected(testCase);
  // Sidecar-declared known-vendor resources carry the same expected-vendor
  // obligation inline detection creates (#385 review). The REAL verification
  // service is the only channel that delivers sidecar copies, so the
  // obligation exists only on service-mode runs; mock runs never inject them.
  const sidecarVendorsExpected = omidServiceModeRun(run)
    ? omidSidecarVendorsExpected(testCase)
    : [];
  if (inlineVendorExpected || sidecarVendorsExpected.length > 0) {
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
      if (expectedVendorScriptFetchFailed(testCase, run, sidecarVendorsExpected)) {
        return {
          status: 'failed',
          bucket: 'vendor-fetch-failed',
          reason: 'vendor script fetch failed (network): expected OMID vendor origin delivered zero script bytes',
        };
      }
      // Sidecar-only expectation: service-injected copies never touch the
      // creative window's omid3p shim, so the verification-service protocol is
      // their only subscription channel. Loaded-but-silent fails here — the
      // #381 rule is not softened.
      if (!inlineVendorExpected) {
        return {
          status: 'failed',
          bucket: 'measurement-omid',
          reason: 'sidecar-declared OMID vendor script did not produce an attributed verification-service subscription',
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

  if (mraidLifecycleGateExpected(testCase)) {
    const gates = evaluateMraidLifecycleGates(run, {
      requireErrorReplay: mraidErrorReplayGateExpected(testCase),
    });
    if (gates.passed !== true) {
      return {
        status: 'failed',
        bucket: 'mraid-lifecycle-gate',
        reason: `${gates.failedGate} failed: ${mraidLifecycleGateResult(gates, gates.failedGate).reason}`,
      };
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
  evaluateMraidLifecycleGates,
  evaluateUrlLifecycleGates,
  expectedBridges,
  hasNetworkDiagnostics,
  isCorsConsole,
  isCspConsole,
  makeEmptyRun,
};
