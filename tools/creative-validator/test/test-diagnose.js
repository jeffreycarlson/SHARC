#!/usr/bin/env node

/**
 * test-diagnose.js — creative validator bucket coverage.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyOutcome,
  isCorsConsole,
  isCspConsole,
  makeEmptyRun,
} from '../src/diagnose.js';

function makeCase(execute = true, expectations = {}) {
  return {
    expectations: {
      execute,
      declared: [],
      sniffed: [],
      skipReason: execute ? null : 'unsupported-adm-kind:native-json',
      ...expectations,
    },
    bidSignals: {
      measurement: {
        omid: {
          declaredByApi: false,
          sidecarPresent: false,
          verificationScriptCount: 0,
          sources: [],
        },
      },
    },
  };
}

function makeOmidSidecarCase() {
  const testCase = makeCase(true, { declared: ['omid'] });
  testCase.bidSignals.measurement.omid = {
    declaredByApi: true,
    sidecarPresent: true,
    verificationScriptCount: 1,
    sources: [{ path: 'bid.ext.measurement.omid', verificationScriptCount: 1 }],
  };
  return testCase;
}

function makeInlineOmidVendorCase() {
  const testCase = makeCase(true);
  testCase.bidSignals.measurement.omid = {
    declaredByApi: false,
    sidecarPresent: false,
    inlineVendorScriptPresent: true,
    inlineVendorScriptCount: 1,
    inlineVendorVendors: ['doubleverify'],
    inlineVendorScripts: [{
      vendor: 'doubleverify',
      value: 'https://cdn.doubleverify.com/dvtp_src.js',
    }],
    sources: [{ path: 'adm.script[src]', vendor: 'doubleverify' }],
  };
  return testCase;
}

function makeStaleDvScriptCase(scripts) {
  const testCase = makeCase(true);
  testCase.bidSignals.measurement.omid = {
    declaredByApi: false,
    sidecarPresent: false,
    inlineVendorScriptPresent: true,
    inlineVendorScriptCount: scripts.length,
    inlineVendorVendors: ['doubleverify'],
    inlineVendorScripts: scripts.map((path) => ({
      vendor: 'doubleverify',
      source: 'adm-script-src',
      value: `https://cdn.doubleverify.com${path}`,
      url: {
        protocol: 'https:',
        origin: 'https://cdn.doubleverify.com',
        hostname: 'cdn.doubleverify.com',
        path,
      },
    })),
    sources: [{ path: 'adm.script[src]', vendor: 'doubleverify' }],
  };
  return testCase;
}

function bucket(run, testCase = makeCase(true)) {
  return classifyOutcome(testCase, makeEmptyRun(run)).bucket;
}

test('classifyOutcome covers non-browser buckets', () => {
  assert.equal(bucket({}, makeCase(false)), 'unsupported-input');
  assert.equal(bucket({ constructionError: 'boom' }), 'sharc-runner-error');
  assert.equal(bucket({ loadError: 'boom' }), 'sharc-runner-error');
  assert.equal(bucket({ timedOut: true }), 'renderer-timeout');
  assert.equal(bucket({
    securityEvents: [{ type: 'renderer_protocol_error', details: { subtype: 'timeout' } }],
  }), 'renderer-timeout');
  assert.equal(bucket({
    securityEvents: [{ type: 'renderer_protocol_error', details: { subtype: 'integrity_failed' } }],
  }), 'renderer-integrity');
  assert.equal(bucket({ securityEvents: [{ type: 'renderer_origin_mismatch' }] }), 'renderer-origin');
  assert.equal(bucket({
    securityEvents: [{ type: 'renderer_protocol_error', details: { subtype: 'malformed_payload' } }],
  }), 'renderer-protocol');
  assert.equal(bucket({
    securityEvents: [{ type: 'renderer_protocol_error', details: { subtype: 'post_failed' } }],
  }), 'renderer-protocol');
  assert.equal(bucket({ securityEvents: [{ type: 'renderer_failed' }] }), 'renderer-protocol');
  assert.equal(bucket({ securityEvents: [{ type: 'unauthorized_navigation' }] }), 'navigation-policy');
  assert.equal(bucket({ securityEvents: [{ type: 'bridge_load_failed' }] }), 'bridge-missing');
  assert.equal(bucket({ securityEvents: [{ type: 'feature_load_failed' }] }), 'measurement-omid');
  assert.equal(bucket({
    creativeRendered: true,
    measurement: { omid: { expected: true, sidecarPresent: true, extensionPresent: false } },
  }, makeOmidSidecarCase()), 'measurement-omid');
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: false,
      },
    },
  }, makeOmidSidecarCase()), 'measurement-omid');
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        expected: true,
        sidecarPresent: true,
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: true,
      },
    },
  }, makeOmidSidecarCase()), 'passed');
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: false,
          passed: false,
        },
      },
    },
  }, makeInlineOmidVendorCase()), 'measurement-omid');
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: true,
          expectedVendorSubscriptionObserved: false,
          lifecycleNotObserved: true,
          passed: false,
        },
      },
    },
  }, makeInlineOmidVendorCase()), 'measurement-omid');
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: true,
          expectedVendorSubscriptionObserved: true,
          passed: true,
        },
      },
    },
  }, makeInlineOmidVendorCase()), 'passed');
  // #244: the service channel alone satisfies the inline-vendor gate — the
  // dvtp-shape vendor never touches omid3p, but the REAL service injected its
  // resource, the copy subscribed via the verification-service protocol, and
  // the canary observed delivery.
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        sdkMode: 'service',
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: false,
          expectedVendorSubscriptionObserved: false,
          servicePassed: true,
          deliveryChannel: 'service',
          passed: true,
        },
      },
    },
  }, makeInlineOmidVendorCase()), 'passed');
  // Service mode without service delivery still fails through the shim-channel
  // reasons.
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        sdkMode: 'service',
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: false,
          expectedVendorSubscriptionObserved: false,
          servicePassed: false,
          deliveryChannel: 'none',
          passed: false,
        },
      },
    },
  }, makeInlineOmidVendorCase()), 'measurement-omid');
  assert.equal(bucket({ creativeRendered: true, terminated: false }), 'passed');
  assert.equal(bucket({
    failedRequests: [{ url: 'https://cdn.example/script.js', errorText: 'net::ERR_FAILED' }],
  }), 'network-cors');
  assert.equal(bucket({
    failedResponses: [{ url: 'https://cdn.example/script.js', status: 404 }],
  }), 'network-cors');
  assert.equal(bucket({
    consoleMessages: [{ type: 'error', text: 'blocked by CORS policy' }],
  }), 'network-cors');
  assert.equal(bucket({
    consoleMessages: [{ type: 'error', text: 'Refused to load: Content Security Policy directive' }],
  }), 'network-cors');
  // Bare "csp"/"cors" substrings (vendor names, URLs, base64) must not trip the facet.
  assert.equal(bucket({
    consoleMessages: [{ type: 'log', text: 'loaded https://csp.example/cors-helper.js' }],
  }), 'inconclusive');
  assert.equal(bucket({ pageErrors: [{ message: 'creative threw' }] }), 'creative-broken');
  assert.equal(bucket({}), 'inconclusive');
});

// 2026-06-12 G2 holdout discover: DV product scoping + vendor fetch failures.
test('dvbs-only DV creative owes no OMID subscription', () => {
  // dvbs_src* is DV's non-OMID RTB blocking/monitoring product. Even on a
  // stale normalized case (inlineVendorScriptPresent:true written before
  // product scoping) with no harness OMID diagnostics at all, the rendered
  // creative passes.
  const testCase = makeStaleDvScriptCase(['/dvbs_src.js']);
  assert.equal(bucket({ creativeRendered: true }, testCase), 'passed');
});

test('dvtp/dvbm DV verification tags keep the unsoftened OMID expectation', () => {
  for (const path of ['/dvtp_src.js', '/dvbm.js']) {
    const testCase = makeStaleDvScriptCase([path]);
    const outcome = classifyOutcome(testCase, makeEmptyRun({
      creativeRendered: true,
      measurement: {
        omid: {
          inlineVendor: {
            expected: true,
            omid3pFound: true,
            subscriptionObserved: false,
            servicePassed: false,
            passed: false,
          },
        },
      },
    }));
    assert.equal(outcome.bucket, 'measurement-omid');
    assert.equal(outcome.reason, 'inline OMID vendor script did not subscribe to OMID');
  }
  // Mixed dvbs + dvtp keeps the expectation: one OMID product is enough.
  const mixed = makeStaleDvScriptCase(['/dvbs_src.js', '/dvtp_src.js']);
  assert.equal(bucket({ creativeRendered: true }, mixed), 'measurement-omid');
});

test('zero-byte expected-vendor fetch classifies as vendor-fetch-failed', () => {
  const testCase = makeInlineOmidVendorCase();
  // The linkedinlm dvtp signature: vendor origin looked up, zero bytes ever
  // delivered (net::ERR_ABORTED) — neither the inline tag nor the injected
  // copy received DV code. Creative/CDN-attributable, not SHARC-attributable.
  const outcome = classifyOutcome(testCase, makeEmptyRun({
    creativeRendered: true,
    measurement: {
      omid: {
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: false,
          servicePassed: false,
          passed: false,
        },
      },
    },
    scriptCache: {
      enabled: true,
      byOrigin: {
        'https://cdn.doubleverify.com': {
          lookups: 2, hits: 0, misses: 2, stores: 0, bytesFromNetwork: 0, bytesFromCache: 0,
        },
      },
    },
  }));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.bucket, 'vendor-fetch-failed');
  assert.match(outcome.reason, /vendor script fetch failed \(network\)/);
});

test('vendor-fetch-failed does not soften the subscribe check', () => {
  const testCase = makeInlineOmidVendorCase();
  const silentVendorRun = (scriptCache) => makeEmptyRun({
    creativeRendered: true,
    measurement: {
      omid: {
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: false,
          servicePassed: false,
          passed: false,
        },
      },
    },
    scriptCache,
  });
  // GUARD (discover §8 Option 2 rejection): vendor bytes arrived and the copy
  // ran but stayed silent — still the unsoftened did-not-subscribe failure.
  // This is the original 86-case defect class and must keep failing.
  const loaded = classifyOutcome(testCase, silentVendorRun({
    enabled: true,
    byOrigin: {
      'https://cdn.doubleverify.com': {
        lookups: 2, hits: 1, misses: 1, stores: 0, bytesFromNetwork: 0, bytesFromCache: 65182,
      },
    },
  }));
  assert.equal(loaded.bucket, 'measurement-omid');
  assert.equal(loaded.reason, 'inline OMID vendor script did not subscribe to OMID');

  // No script cache diagnostics at all (cache disabled): no fetch-failure
  // claim, the subscribe check stands.
  assert.equal(
    classifyOutcome(testCase, silentVendorRun(null)).bucket,
    'measurement-omid',
  );

  // Unrelated-origin fetch failures do not reclassify the vendor expectation.
  assert.equal(
    classifyOutcome(testCase, silentVendorRun({
      enabled: true,
      byOrigin: {
        'https://cdn.unrelated.example': {
          lookups: 3, hits: 0, misses: 3, stores: 0, bytesFromNetwork: 0, bytesFromCache: 0,
        },
      },
    })).bucket,
    'measurement-omid',
  );
});

// #385 review: sidecar-only delivery of a KNOWN vendor's OMID product carries
// the same expected-vendor obligation inline detection creates.
function makeSidecarVendorCase(resourceUrl) {
  const testCase = makeOmidSidecarCase();
  testCase.sharcOptions = {
    creativeMeta: {
      apis: [7],
      measurement: {
        omid: {
          verificationScripts: [{
            resourceUrl,
            vendor: 'declared-vendor-label-is-not-trusted',
            verificationParameters: 'sharc-validator-fixture',
            accessMode: 'limited',
          }],
          creativeType: 'display',
          impressionType: 'beginToRender',
          mediaType: 'display',
        },
      },
    },
  };
  return testCase;
}

function sidecarServiceRun(overrides = {}, scriptCache = undefined) {
  return makeEmptyRun({
    creativeRendered: true,
    measurement: {
      omid: {
        sdkMode: 'service',
        extensionPresent: true,
        featureAdvertised: true,
        sessionStarted: true,
        inlineVendor: { expected: false, diagnosticOutcome: 'not-run', passed: false },
        ...overrides,
      },
    },
    scriptCache,
  });
}

test('sidecar-declared known vendor with zero subscriptions never passes (#385 review repro)', () => {
  const testCase = makeSidecarVendorCase('https://q.adrta.com/s/sharcx/aa.js?cb=123456#sharcx');
  // The reviewer's repro: session started, canary delivery complete, ZERO
  // pixalate subscriptions — previously classified `passed`.
  const outcome = classifyOutcome(testCase, sidecarServiceRun());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.bucket, 'measurement-omid');
  assert.match(outcome.reason, /sidecar-declared OMID vendor script did not produce an attributed verification-service subscription/);

  // Old-harness report shape (no inlineVendor diagnostics at all) fails closed.
  const stale = sidecarServiceRun({ inlineVendor: undefined });
  assert.equal(classifyOutcome(testCase, stale).bucket, 'measurement-omid');
});

test('sidecar-declared known vendor with zero-byte origin classifies as vendor-fetch-failed (#381 path)', () => {
  const testCase = makeSidecarVendorCase('https://q.adrta.com/s/sharcx/aa.js?cb=123456#sharcx');
  const outcome = classifyOutcome(testCase, sidecarServiceRun({}, {
    enabled: true,
    byOrigin: {
      'https://q.adrta.com': {
        lookups: 2, hits: 0, misses: 2, stores: 0, bytesFromNetwork: 0, bytesFromCache: 0,
      },
    },
  }));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.bucket, 'vendor-fetch-failed');
});

test('sidecar vendor loaded-but-silent keeps the unsoftened subscribe failure', () => {
  const testCase = makeSidecarVendorCase('https://q.adrta.com/s/sharcx/aa.js?cb=123456#sharcx');
  // Vendor bytes arrived and the copy ran but stayed silent — the #381 rule
  // stands: never a pass, and not a fetch failure either.
  const outcome = classifyOutcome(testCase, sidecarServiceRun({}, {
    enabled: true,
    byOrigin: {
      'https://q.adrta.com': {
        lookups: 2, hits: 1, misses: 1, stores: 1, bytesFromNetwork: 9000, bytesFromCache: 0,
      },
    },
  }));
  assert.equal(outcome.bucket, 'measurement-omid');
});

test('sidecar vendor service subscription satisfies the expectation', () => {
  const testCase = makeSidecarVendorCase('https://q.adrta.com/s/sharcx/aa.js?cb=123456#sharcx');
  const outcome = classifyOutcome(testCase, sidecarServiceRun({
    inlineVendor: {
      expected: true,
      servicePassed: true,
      deliveryChannel: 'service',
      passed: true,
    },
  }));
  assert.equal(outcome.status, 'passed');
});

test('unknown sidecar resource URLs create no vendor expectation', () => {
  // An operator may declare anything; only what the product-scoped vendor
  // table can attribute is enforced. Non-OMID products on known vendor hosts
  // (pixalate r.js) are equally expectation-free.
  for (const url of [
    'https://verification.example/omid-verify.js',
    'https://q.adrta.com/r.js?v=24.000',
  ]) {
    const testCase = makeSidecarVendorCase(url);
    assert.equal(classifyOutcome(testCase, sidecarServiceRun()).status, 'passed');
  }
});

test('mock-mode runs carry no sidecar vendor obligation', () => {
  // The REAL service is the only channel that injects sidecar copies; a mock
  // run never delivers them, so it owes only the extension/session checks.
  const testCase = makeSidecarVendorCase('https://q.adrta.com/s/sharcx/aa.js?cb=123456#sharcx');
  const run = sidecarServiceRun();
  run.measurement.omid.sdkMode = 'mock';
  assert.equal(classifyOutcome(testCase, run).status, 'passed');
});

test('classifyOutcome buckets expected bridge probe failures', () => {
  const mraidCase = makeCase(true, { declared: ['mraid'] });
  assert.equal(bucket({
    creativeRendered: false,
    bridgeProbes: [],
  }, mraidCase), 'inconclusive');
  assert.equal(bucket({
    creativeRendered: true,
    bridgeProbes: [{ bridges: { mraid: { exists: false, methods: {} } } }],
  }, mraidCase), 'passed');

  const sniffedMraidCase = makeCase(true, { sniffed: ['mraid'] });
  assert.equal(bucket({
    creativeRendered: true,
    bridgeProbes: [{ bridges: { mraid: { exists: false, methods: {} } } }],
  }, sniffedMraidCase), 'bridge-missing');
  assert.equal(bucket({
    creativeRendered: true,
    bridgeProbes: [
      { bridges: { mraid: { exists: false, methods: {} } } },
      {
        bridges: { mraid: {
          exists: true,
          methods: { getState: { exists: true, status: 'ok', value: 'loading' } },
        } },
      },
    ],
  }, sniffedMraidCase), 'passed');
  assert.equal(bucket({
    creativeRendered: true,
    bridgeProbes: [{
      bridges: { mraid: {
        exists: true,
        methods: { getState: { exists: true, status: 'threw', error: 'boom' } },
      } },
    }],
  }, sniffedMraidCase), 'bridge-api-error');
  assert.equal(bucket({
    creativeRendered: true,
    bridgeProbes: [{
      bridges: { mraid: {
        exists: true,
        methods: { getState: { exists: true, status: 'ok', value: 'loading' } },
      } },
    }],
  }, sniffedMraidCase), 'passed');

  const safeframeCase = makeCase(true, { sniffed: ['safeframe'] });
  assert.equal(bucket({
    creativeRendered: true,
    bridgeProbes: [{ bridges: { safeframe: { exists: false, methods: {} } } }],
  }, safeframeCase), 'bridge-missing');
  assert.equal(bucket({
    creativeRendered: true,
    bridgeProbes: [{
      bridges: { safeframe: {
        exists: true,
        methods: { geom: { exists: true, status: 'threw', error: 'boom' } },
      } },
    }],
  }, safeframeCase), 'bridge-api-error');
});

test('console CORS/CSP matchers require canonical phrasings, not bare substrings', () => {
  assert.equal(isCorsConsole('Access to fetch blocked by CORS policy'), true);
  assert.equal(isCorsConsole("No 'Access-Control-Allow-Origin' header is present"), true);
  assert.equal(isCorsConsole('loaded https://cors.example/cors-helper.js'), false);
  assert.equal(isCorsConsole(''), false);
  assert.equal(isCorsConsole(undefined), false);

  assert.equal(isCspConsole('Refused to load: Content Security Policy directive'), true);
  assert.equal(isCspConsole('vendor csp.example loaded'), false);
  assert.equal(isCspConsole(null), false);
});
