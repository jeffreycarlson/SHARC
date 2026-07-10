#!/usr/bin/env node

/**
 * G6 red contract R-C — OmidCompatBridge in-app service mode.
 *
 * Designed contract (G6 design doc, Decision 1): in-app the WebView runs the
 * NATIVE OM SDK's own JS service (omsdk-v1.js, injected by the host
 * integration per OMID API v1.5 pp.13-14) — SHARC must NOT boot omweb-v1.js,
 * and the two never coexist. The bridge therefore gains an operator-declared
 * `serviceMode` constructor option:
 *
 *   - enum 'web' (default) | 'native'; anything else throws TypeError at
 *     construction (Rule-11/13 house pattern — strict enum, no coercion).
 *   - 'native' + omSdkServiceScriptUrl is a contradictory authority
 *     declaration ("native provides the service" + "here is a service to
 *     inject") and throws TypeError at construction.
 *   - In 'native' mode the feature is advertised on the session-client URL
 *     alone (native provides the service; _hasSdkInjectionUrls' both-URLs
 *     requirement is a web-mode rule).
 *
 * RED today: the constructor ignores `serviceMode` entirely (verified
 * 2026-07-08: 'banana' accepted, default undefined, client-only getFeatureName
 * returns null).
 *
 * See ADR: ~/Obsidian/dev-team/sharc/2026-07-08-g6-omid-in-app-design.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { OmidCompatBridge } from '../../src/sharc-omid-bridge.js';

const SESSION_CLIENT_URL = 'https://cdn.example/omid/omid-session-client-v1.js';
const SERVICE_URL = 'https://cdn.example/omid/omweb-v1.js';

test('G6 R-C: serviceMode defaults to web (explicit, not undefined)', () => {
  const bridge = new OmidCompatBridge({});
  assert.equal(
    bridge.options.serviceMode,
    'web',
    'G6 in-app contract: OmidCompatBridge must normalize the serviceMode '
      + 'option to an explicit default of \'web\' so the in-app mode is an '
      + 'operator declaration, never an ambient undefined — got '
      + JSON.stringify(bridge.options.serviceMode),
  );
});

// NOTE: GREEN today by construction (the constructor currently passes unknown
// options through untouched). Kept deliberately as a baseline pin: once the
// strict enum validation lands, this guards that 'native' stays INSIDE the
// accepted enum — the natural regression when someone tightens validation.
test('G6 R-C: serviceMode accepts the native enum value (baseline pin — green today)', () => {
  const bridge = new OmidCompatBridge({
    serviceMode: 'native',
    omSdkSessionClientUrl: SESSION_CLIENT_URL,
  });
  assert.equal(
    bridge.options.serviceMode,
    'native',
    'G6 in-app contract: serviceMode:\'native\' declares that the host '
      + 'integration injected the OM SDK JS service (omsdk-v1.js) into the '
      + 'WebView and SHARC must not boot omweb-v1.js',
  );
});

test('G6 R-C: serviceMode outside the enum throws TypeError at construction', () => {
  assert.throws(
    () => new OmidCompatBridge({ serviceMode: 'banana' }),
    TypeError,
    'G6 in-app contract (Rule-11/13 pattern): serviceMode is a strict enum '
      + "['web','native'] — an unknown value is a config bug that silently "
      + 'forks measurement authority and must throw TypeError at construction',
  );
});

test('G6 R-C: native mode + omSdkServiceScriptUrl is contradictory and throws', () => {
  assert.throws(
    () => new OmidCompatBridge({
      serviceMode: 'native',
      omSdkServiceScriptUrl: SERVICE_URL,
      omSdkSessionClientUrl: SESSION_CLIENT_URL,
    }),
    TypeError,
    'G6 in-app contract: serviceMode:\'native\' with omSdkServiceScriptUrl '
      + 'declares two service authorities at once (native-injected omsdk-v1 '
      + 'AND a SHARC-injected service script) — injecting omweb next to the '
      + 'native service is the harmful act itself, so this fails loud at '
      + 'construction before any script moves',
  );
});

test('G6 R-C: native mode advertises the OMID feature on the session-client URL alone', () => {
  const bridge = new OmidCompatBridge({
    serviceMode: 'native',
    omSdkSessionClientUrl: SESSION_CLIENT_URL,
  });
  assert.equal(
    bridge.getFeatureName(),
    'com.iabtechlab.sharc.omid',
    'G6 in-app contract: in native mode the service is host-provided, so '
      + 'feature advertisement requires only omSdkSessionClientUrl — the '
      + 'both-URLs _hasSdkInjectionUrls rule is web-mode-only. getFeatureName() '
      + 'must return the OMID feature name, got '
      + JSON.stringify(bridge.getFeatureName()),
  );
});
