#!/usr/bin/env node

/**
 * test-diagnose.js — creative validator bucket coverage.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOutcome, makeEmptyRun } from '../src/diagnose.js';

function makeCase(execute = true) {
  return {
    expectations: {
      execute,
      skipReason: execute ? null : 'unsupported-adm-kind:native-json',
    },
  };
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
  assert.equal(bucket({ creativeRendered: true, terminated: false }), 'passed');
  assert.equal(bucket({
    failedRequests: [{ url: 'https://cdn.example/script.js', errorText: 'net::ERR_FAILED' }],
  }), 'network-cors');
  assert.equal(bucket({
    consoleMessages: [{ type: 'error', text: 'blocked by CORS policy' }],
  }), 'network-cors');
  assert.equal(bucket({ pageErrors: [{ message: 'creative threw' }] }), 'creative-broken');
  assert.equal(bucket({}), 'inconclusive');
});
