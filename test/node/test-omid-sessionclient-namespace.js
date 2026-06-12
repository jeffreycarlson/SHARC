/**
 * test-omid-sessionclient-namespace.js — #244 D6 seam: versioned
 * OmidSessionClient namespace resolution.
 *
 * The REAL `omid-session-client-v1.js` does not export `AdSession`/`Partner`/…
 * flat on `window.OmidSessionClient`; it exports a version-keyed map plus the
 * documented `'default'` alias (`OmidSessionClient['default'].AdSession`).
 * `getOmidSessionClient()` is the single seam (#244 design D6) that absorbs
 * the namespace shape: versioned maps unwrap through `'default'`, flat
 * namespaces (test stubs, prebundled integrations) pass through unchanged.
 *
 * Pins both shapes by driving `OmidCompatBridge._createSession()` against
 * each and asserting a session starts.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;

const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');

let failures = 0;
function section(name) { console.log('\n' + name); }
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { failures += 1; console.error('  ✗', message); }
}

function makeSessionClientApi(log) {
  function Partner(name, version) { this.name = name; this.version = version; }
  function VerificationScriptResource(url, vendor, params, accessMode) {
    this.url = url; this.vendor = vendor; this.params = params; this.accessMode = accessMode;
  }
  function Context(partner, verificationScripts) {
    this.partner = partner;
    this.verificationScripts = verificationScripts || [];
  }
  Context.prototype.setContentUrl = function () {};
  Context.prototype.setServiceScriptUrl = function () {};
  function AdSession(context) { this.context = context; }
  AdSession.prototype.setCreativeType = function () {};
  AdSession.prototype.setImpressionType = function () {};
  AdSession.prototype.registerSessionObserver = function () {};
  AdSession.prototype.start = function () { log.started = true; };
  AdSession.prototype.finish = function () {};
  function AdEvents() {}
  return { Partner, VerificationScriptResource, Context, AdSession, AdEvents };
}

function makeBridge() {
  return new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js',
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    creativeType: 'display',
    impressionType: 'beginToRender',
    mediaType: 'display',
  });
}

section('versioned namespace (real omid-session-client-v1.js shape) unwraps via default');
{
  const log = {};
  const api = makeSessionClientApi(log);
  window.OmidSessionClient = {
    '1.6.6-iab457': api,
    'default': api,
  };
  const bridge = makeBridge();
  bridge._createSession();
  assert(log.started === true, 'AdSession.start() called through the default-keyed namespace');
  assert(bridge._omid.sessionStarted === true, 'bridge records sessionStarted');
  delete window.OmidSessionClient;
}

section('flat namespace (stub/prebundled shape) passes through unchanged');
{
  const log = {};
  window.OmidSessionClient = makeSessionClientApi(log);
  const bridge = makeBridge();
  bridge._createSession();
  assert(log.started === true, 'AdSession.start() called through the flat namespace');
  assert(bridge._omid.sessionStarted === true, 'bridge records sessionStarted');
  delete window.OmidSessionClient;
}

section('no namespace: session does not start');
{
  const bridge = makeBridge();
  bridge._createSession();
  assert(bridge._omid.sessionStarted !== true, 'no session without OmidSessionClient');
}

if (failures > 0) {
  console.error('\n' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nAll assertions passed');
