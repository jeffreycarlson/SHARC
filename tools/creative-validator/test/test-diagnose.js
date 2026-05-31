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
          lifecycleNotObserved: true,
          passed: false,
        },
      },
    },
  }, makeInlineOmidVendorCase()), 'passed');
  assert.equal(bucket({
    creativeRendered: true,
    measurement: {
      omid: {
        inlineVendor: {
          expected: true,
          omid3pFound: true,
          subscriptionObserved: true,
          passed: true,
        },
      },
    },
  }, makeInlineOmidVendorCase()), 'passed');
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
