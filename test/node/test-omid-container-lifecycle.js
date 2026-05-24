/**
 * test-omid-container-lifecycle.js — SHARC 0.7.3 OMID container-side wiring
 *
 * Deep-dive edge-case tests for the OmidCompatBridge public API surface and
 * container-owned lifecycle. Covers:
 *
 *   A. Public API surface (getFeatureName, getFeatureDescriptor, getScriptUrls,
 *      injectScripts, injectIntoMarkup, getWrapperUrl, augmentEnvironmentData,
 *      getFeatureVersion, getFeatureFunctions)
 *   B. Container lifecycle flow: load → ready → active → error/destroy/terminated
 *      Session creation, start, loaded/impression firing, idempotent finish
 *   C. Timeout: _injectScriptWithTimeout rejects after 5 s with URL in message
 *   D. Markup injection no-op: injectScripts/injectIntoMarkup return unchanged
 *      markup; getScriptUrls compatibility order
 *   E. Bridge contract: OMID NOT in bridges array; AdCOM 7 NOT mapped;
 *      explicit ["omid"] throws
 *   F. Placement change handling; visibility signaling (visible vs notVisible)
 *   G. Edge cases: repeated teardown signals, session-finished state after
 *      destroy, SDK load failure handling
 *
 * Runs in Node after `npm run build`. No test framework.
 *
 * Branch:  feature/omid-container-lifecycle
 * Commits: dd010cb, 644a739, b243936
 */

import { JSDOM } from 'jsdom';

// ── Set up DOM globals BEFORE importing modules ───────────────────────────
const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html' },
);
global.window   = dom.window;
global.document = dom.window.document;
global.HTMLElement   = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort    = dom.window.MessagePort;

// Fake setTimeout/clearTimeout for timeout tests (overridden per-test where needed)
// Keep Node's real timers as fallback.

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');

// ── Assertion harness ─────────────────────────────────────────────────────
let failures = 0;
let sectionFailures = 0;
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n${name}`);
}

function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
    sectionFailures++;
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message, `\n      actual:   ${a}\n      expected: ${b}`);
    failures++;
    sectionFailures++;
  }
}

function assertThrows(fn, msgPattern, message, ErrorCtor) {
  try {
    fn();
    console.error('  ✗', message, '(no throw)');
    failures++;
    sectionFailures++;
  } catch (e) {
    if (ErrorCtor && !(e instanceof ErrorCtor)) {
      console.error('  ✗', message, `(wrong type: ${e.constructor.name})`);
      failures++;
      sectionFailures++;
      return;
    }
    if (msgPattern && !String(e.message).match(msgPattern)) {
      console.error('  ✗', message, `(wrong message: "${e.message}")`);
      failures++;
      sectionFailures++;
      return;
    }
    console.log('  ✓', message);
  }
}

// ── Mock OM SDK factory ───────────────────────────────────────────────────

function createMockOmidSdk() {
  const stats = {
    partnerName: null,
    partnerVersion: null,
    verificationScripts: null,
    contentUrl: null,
    serviceScriptUrl: null,
    creativeType: null,
    impressionType: null,
    registerAdViewArg: null,
    startCalls: 0,
    finishCalls: 0,
    loadedCalls: 0,
    loadedArgs: [],
    impressionCalls: 0,
    visibilityStates: [],
    playerStates: [],
    sessionObserver: null,
    addFriendlyObstructionCalls: [],
    removeFriendlyObstructionCalls: [],
  };

  class Partner {
    constructor(name, version) {
      stats.partnerName    = name;
      stats.partnerVersion = version;
      this.name    = name;
      this.version = version;
    }
  }

  class VerificationScriptResource {
    constructor(url, vendor, verificationParameters, accessMode) {
      this.url    = url;
      this.vendor = vendor;
      this.verificationParameters = verificationParameters;
      this.accessMode = accessMode;
    }
  }

  class Context {
    constructor(partner, verificationScripts) {
      this.partner = partner;
      this.verificationScripts = verificationScripts;
      stats.verificationScripts = verificationScripts;
    }
    setContentUrl(url)      { stats.contentUrl      = url; }
    setServiceScriptUrl(url) { stats.serviceScriptUrl = url; }
  }

  class AdSession {
    constructor(context) {
      this.context = context;
      this._observers = [];
    }
    setCreativeType(v)  { stats.creativeType  = v; }
    setImpressionType(v){ stats.impressionType = v; }
    registerAdView(v)   { stats.registerAdViewArg = v; }
    registerSessionObserver(fn) {
      stats.sessionObserver = fn;
      this._observers.push(fn);
    }
    start()  { stats.startCalls++; }
    finish() {
      stats.finishCalls++;
      this._observers.forEach(fn => fn({ type: 'sessionFinish' }));
    }
    addFriendlyObstruction(el, purpose, reason) {
      stats.addFriendlyObstructionCalls.push({ el, purpose, reason });
    }
    removeFriendlyObstruction(el) {
      stats.removeFriendlyObstructionCalls.push(el);
    }
  }

  class AdEvents {
    constructor(session) { this.session = session; }
    loaded(arg) {
      stats.loadedCalls++;
      stats.loadedArgs.push(arg);
    }
    impressionOccurred() { stats.impressionCalls++; }
    stateChange(v)       { stats.visibilityStates.push(v); }
  }

  class MediaEvents {
    constructor(session) { this.session = session; }
    playerStateChange(v) { stats.playerStates.push(v); }
  }

  class VastProperties {
    constructor(isSkippable, skipOffset, isAutoPlay, position) {
      this.isSkippable  = isSkippable;
      this.skipOffset   = skipOffset;
      this.isAutoPlay   = isAutoPlay;
      this.position     = position;
    }
  }

  return {
    sdk: { Partner, VerificationScriptResource, Context, AdSession, AdEvents, MediaEvents, VastProperties },
    stats,
  };
}

function installMockSdk(mock) {
  global.OmidSessionClient  = mock.sdk;
  window.OmidSessionClient  = mock.sdk;
}

function uninstallMockSdk() {
  delete global.OmidSessionClient;
  delete window.OmidSessionClient;
}

// ── Container helpers ─────────────────────────────────────────────────────

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

function markupOptions(overrides) {
  return {
    creativeHtml: '<html><head></head><body>ad</body></html>',
    creativeRendererUrl: 'https://renderer.example/0.7.1/',
    placementElement: freshSlot(),
    ...overrides,
  };
}

function createContainerWithOmid(omidBridge, extra) {
  const c = new SHARCContainer(markupOptions({
    creativeMeta: { apis: [7] },
    extensions: [omidBridge],
    ...(extra || {}),
  }));
  c._iframe = document.createElement('iframe');
  c._protocol.sendStateChange = () => {};
  return c;
}

// ══════════════════════════════════════════════════════════════════════════
// A. PUBLIC API SURFACE
// ══════════════════════════════════════════════════════════════════════════

console.log('test-omid-container-lifecycle.js — SHARC 0.7.3 container-side OMID wiring\n');

section('A. Public API surface — method existence and return types');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
    baseUrl: 'https://cdn.example/sharc',
    partnerName: 'TestPartner',
    partnerVersion: '1.2.3',
    contentUrl: 'https://content.example/page.html',
    creativeType: 'display',
    impressionType: 'beginToRender',
    mediaType: 'display',
    verificationScripts: [
      { url: 'https://verify.example/v.js', vendor: 'vendor.example', verificationParameters: 'p=1', accessMode: 'limited' },
    ],
  });

  // getFeatureName
  assert(typeof bridge.getFeatureName === 'function', 'getFeatureName is a function');
  assert(bridge.getFeatureName() === 'com.iabtechlab.sharc.omid', 'getFeatureName() → "com.iabtechlab.sharc.omid"');

  // getFeatureDescriptor
  assert(typeof bridge.getFeatureDescriptor === 'function', 'getFeatureDescriptor is a function');
  const desc = bridge.getFeatureDescriptor();
  assert(desc && typeof desc === 'object', 'getFeatureDescriptor() returns an object');
  assert(desc.name === 'com.iabtechlab.sharc.omid', 'descriptor.name = feature name');
  assert(typeof desc.version === 'string', 'descriptor.version is a string');
  assert(desc.capabilities && typeof desc.capabilities === 'object', 'descriptor has capabilities object');
  assert(desc.capabilities.adEvents === true, 'descriptor.capabilities.adEvents = true');
  assert(desc.capabilities.sdkInjected === true, 'descriptor.capabilities.sdkInjected = true');
  assert(desc.capabilities.creativeType === 'display', 'descriptor.capabilities.creativeType matches option');
  assert(desc.capabilities.impressionType === 'beginToRender', 'descriptor.capabilities.impressionType matches option');
  assert(desc.capabilities.mediaEvents === false, 'descriptor.capabilities.mediaEvents = false for display');

  // getFeatureVersion
  assert(typeof bridge.getFeatureVersion === 'function', 'getFeatureVersion is a function');
  assert(typeof bridge.getFeatureVersion() === 'string', 'getFeatureVersion() returns a string');

  // getFeatureFunctions
  assert(typeof bridge.getFeatureFunctions === 'function', 'getFeatureFunctions is a function');
  const fns = bridge.getFeatureFunctions();
  assert(Array.isArray(fns), 'getFeatureFunctions() returns an array');
  assert(fns.includes('startSession'), 'getFeatureFunctions includes "startSession"');
  assert(fns.includes('signalAdEvent'), 'getFeatureFunctions includes "signalAdEvent"');
  assert(fns.includes('signalMediaEvent'), 'getFeatureFunctions includes "signalMediaEvent"');
  assert(fns.includes('finishSession'), 'getFeatureFunctions includes "finishSession"');

  // getScriptUrls
  assert(typeof bridge.getScriptUrls === 'function', 'getScriptUrls is a function');
  const urls = bridge.getScriptUrls();
  assert(Array.isArray(urls), 'getScriptUrls() returns an array');
  assert(urls.length === 5, 'getScriptUrls() returns 5 entries (service, client, protocol, creative, bridge)');
  assert(urls[0] === 'https://omid.example/omweb-v1.js', 'getScriptUrls()[0] is OM SDK service script');
  assert(urls[1] === 'https://omid.example/omid-session-client-v1.js', 'getScriptUrls()[1] is OM SDK session client');
  assert(urls[2].includes('sharc-protocol'), 'getScriptUrls()[2] is sharc-protocol.js');
  assert(urls[3].includes('sharc-creative'), 'getScriptUrls()[3] is sharc-creative.js');
  assert(urls[4].includes('sharc-omid-bridge'), 'getScriptUrls()[4] is sharc-omid-bridge.js');

  // injectScripts
  assert(typeof bridge.injectScripts === 'function', 'injectScripts is a function');

  // injectIntoMarkup
  assert(typeof bridge.injectIntoMarkup === 'function', 'injectIntoMarkup is a function');

  // getWrapperUrl
  assert(typeof bridge.getWrapperUrl === 'function', 'getWrapperUrl is a function');
  const wrapperUrl = bridge.getWrapperUrl('https://creative.example/ad.html');
  assert(typeof wrapperUrl === 'string', 'getWrapperUrl() returns a string');
  assert(wrapperUrl.includes('creative.example'), 'getWrapperUrl() encodes creative URL in query param');
  assert(wrapperUrl.includes('omid-wrapper'), 'getWrapperUrl() points to omid-wrapper resource');

  // augmentEnvironmentData
  assert(typeof bridge.augmentEnvironmentData === 'function', 'augmentEnvironmentData is a function');
  const env = bridge.augmentEnvironmentData({ currentPlacement: 'inline' });
  assert(env && typeof env === 'object', 'augmentEnvironmentData() returns an object');
  assert(env.currentPlacement === 'inline', 'augmentEnvironmentData() preserves existing fields');
  assert(typeof env.omidServiceScriptUrl === 'string' && env.omidServiceScriptUrl.length > 0,
    'augmentEnvironmentData() adds omidServiceScriptUrl');
  assert(env.omidServiceScriptUrl === 'https://omid.example/omweb-v1.js',
    'augmentEnvironmentData().omidServiceScriptUrl matches omSdkServiceScriptUrl option');

  // onContainerLifecycleEvent
  assert(typeof bridge.onContainerLifecycleEvent === 'function', 'onContainerLifecycleEvent is a function');

  // onContainerStateChange
  assert(typeof bridge.onContainerStateChange === 'function', 'onContainerStateChange is a function');

  // destroy
  assert(typeof bridge.destroy === 'function', 'destroy is a function');
}

// ══════════════════════════════════════════════════════════════════════════
// B. CONTAINER LIFECYCLE: load → ready → active → error / destroy / terminated
// ══════════════════════════════════════════════════════════════════════════

section('B. Container lifecycle — load → ready → active → session signals');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({
      creativeType: 'display',
      mediaType: 'display',
      impressionType: 'beginToRender',
      contentUrl: 'https://content.example/page.html',
      omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
      verificationScripts: [
        { url: 'https://verify.example/v.js', vendor: 'vendor.example', verificationParameters: 'p=1', accessMode: 'limited' },
      ],
      partnerName: 'LifecycleTest',
      partnerVersion: '0.7.3',
    });

    const c = createContainerWithOmid(bridge);

    // 1. load event — should trigger _ensureSdkLoaded (SDK already mocked/loaded)
    bridge.onContainerLifecycleEvent({ type: 'load', container: c });
    assert(mock.stats.startCalls === 0, 'load event: AdSession NOT started yet (session deferred to ready)');

    // 2. ready → session creation
    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    assert(mock.stats.startCalls === 1, 'ready state: AdSession.start() called once');
    assert(mock.stats.partnerName === 'LifecycleTest', 'ready: Partner constructed with custom name');
    assert(mock.stats.partnerVersion === '0.7.3', 'ready: Partner constructed with custom version');
    assert(mock.stats.contentUrl === 'https://content.example/page.html', 'ready: Context.setContentUrl() called');
    assert(mock.stats.serviceScriptUrl === 'https://omid.example/omweb-v1.js', 'ready: Context.setServiceScriptUrl() called');
    assert(mock.stats.creativeType === 'display', 'ready: creativeType set on AdSession');
    assert(mock.stats.impressionType === 'beginToRender', 'ready: impressionType set on AdSession');
    assert(mock.stats.registerAdViewArg === c._iframe, 'ready: container iframe registered as ad view');
    assert(mock.stats.loadedCalls === 0, 'ready state: loaded() NOT fired yet (deferred to active)');
    assert(mock.stats.impressionCalls === 0, 'ready state: impressionOccurred() NOT fired yet');

    // 3. active → impression signals
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });
    assert(mock.stats.startCalls === 1, 'active: AdSession.start() still only 1 (no double-start)');
    assert(mock.stats.loadedCalls === 1, 'active: adEvents.loaded() called exactly once');
    assert(mock.stats.impressionCalls === 1, 'active: adEvents.impressionOccurred() called exactly once');
    assert(mock.stats.visibilityStates.length >= 1 && mock.stats.visibilityStates[mock.stats.visibilityStates.length - 1] === 'VISIBLE',
      'active: visibility signaled VISIBLE');

    // 4. Verify session started and not finished
    assert(bridge._omid.sessionStarted === true, 'internal: sessionStarted = true');
    assert(bridge._omid.sessionFinished === false, 'internal: sessionFinished = false while active');
    assert(bridge._omid.loadedFired === true, 'internal: loadedFired = true after active');
    assert(bridge._omid.impressionFired === true, 'internal: impressionFired = true after active');

    // 5. Verification scripts converted
    assert(
      mock.stats.verificationScripts && mock.stats.verificationScripts.length === 1,
      'verification scripts: 1 VerificationScriptResource constructed'
    );
    assert(
      mock.stats.verificationScripts[0] && mock.stats.verificationScripts[0].url === 'https://verify.example/v.js',
      'verification scripts: URL preserved in resource'
    );

  } finally {
    uninstallMockSdk();
  }
}

section('B2. Container lifecycle — error event terminates session idempotently');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    // Error signals finish
    c._notifyExtensionsLifecycle('error', { errorCode: 9001, errorMessage: 'test error' });
    assert(mock.stats.finishCalls === 1, 'error event: AdSession.finish() called once');
    assert(bridge._omid.sessionFinished === true, 'error event: sessionFinished = true');

    // Repeated error must NOT re-call finish
    c._notifyExtensionsLifecycle('error', { errorCode: 9001, errorMessage: 'repeated' });
    assert(mock.stats.finishCalls === 1, 'repeated error: AdSession.finish() NOT called again');

  } finally {
    uninstallMockSdk();
  }
}

section('B3. Container lifecycle — destroy event finishes session');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    c._notifyExtensionsLifecycle('destroy');
    assert(mock.stats.finishCalls === 1, 'destroy event: AdSession.finish() called once');
    assert(bridge._omid.sessionFinished === true, 'destroy event: sessionFinished = true');

    // Calling destroy() again on bridge must be idempotent
    bridge.destroy();
    assert(mock.stats.finishCalls === 1, 'bridge.destroy() after destroy event: finish NOT called again');
    assert(bridge._container === null, 'bridge.destroy(): _container reference cleared');

  } finally {
    uninstallMockSdk();
  }
}

section('B4. Container lifecycle — terminated state finishes session');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    c._notifyExtensionsLifecycle('stateChange', { newState: 'terminated', previousState: 'active' });
    assert(mock.stats.finishCalls === 1, 'terminated state: AdSession.finish() called once');
    assert(bridge._omid.sessionFinished === true, 'terminated state: sessionFinished = true');

  } finally {
    uninstallMockSdk();
  }
}

section('B5. Container lifecycle — session idempotent: ready fired twice does NOT double-start');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    // 0.7.3 cleanup (#127 sub-3d): setState() already triggers
    // _notifyExtensionsLifecycle via the state-machine onChange listener,
    // so the manual call that used to follow each setState was a redundant
    // double-fire. Dropped — the test now exercises the documented
    // "spurious duplicate" path with one explicit manual call after the
    // natural setState dispatch.
    c.setState('ready');
    // Dispatch ready again (e.g. spurious duplicate event)
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'ready' });

    assert(mock.stats.startCalls === 1, 'double-ready: AdSession.start() called exactly once');

  } finally {
    uninstallMockSdk();
  }
}

section('B6. Container lifecycle — active fired twice does NOT double-fire loaded/impression');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    // 0.7.3 cleanup (#127 sub-3d): drop redundant manual fires after each
    // setState. setState() already dispatches via the onChange listener.
    c.setState('ready');
    c.setState('active');
    // Spurious second active
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'active' });

    assert(mock.stats.loadedCalls === 1, 'double-active: loaded() fired exactly once');
    assert(mock.stats.impressionCalls === 1, 'double-active: impressionOccurred() fired exactly once');

  } finally {
    uninstallMockSdk();
  }
}

section('B7. Container lifecycle — session-finished state persists after bridge.destroy()');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    // 0.7.3 cleanup (#127 sub-3d): drop redundant manual fires after each
    // setState. setState() already dispatches via the onChange listener.
    c.setState('ready');
    c.setState('active');

    bridge.destroy();
    assert(bridge._omid.sessionStarted === false, 'after destroy: sessionStarted = false');
    assert(bridge._omid.sessionFinished === true, 'after destroy: sessionFinished = true (persists)');
    assert(bridge._omid.adSession === null, 'after destroy: adSession reference cleared');
    assert(bridge._omid.adEvents === null, 'after destroy: adEvents reference cleared');
    assert(bridge._omid.mediaEvents === null, 'after destroy: mediaEvents reference cleared');

  } finally {
    uninstallMockSdk();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// C. TIMEOUT BEHAVIOR
// ══════════════════════════════════════════════════════════════════════════

section('C. Timeout — _injectScriptWithTimeout rejects with URL in error message');
{
  const bridge = new OmidCompatBridge({});

  // Patch _injectScript to return a never-resolving promise (simulates hang)
  bridge._injectScript = function(_url) {
    return new Promise(() => {}); // never settles
  };

  // Use fake timers — patch global setTimeout/clearTimeout temporarily
  const realSetTimeout   = global.setTimeout;
  const realClearTimeout = global.clearTimeout;

  let capturedCallback = null;
  let capturedMs       = null;
  let capturedId       = 42;

  global.setTimeout = function(fn, ms) {
    capturedCallback = fn;
    capturedMs       = ms;
    return capturedId;
  };
  global.clearTimeout = function(_id) {};

  const url = 'https://omid.example/omweb-v1.js';
  const p = bridge._injectScriptWithTimeout(url, 5000);

  // Verify timeout was scheduled for 5000 ms
  assert(capturedMs === 5000, '_injectScriptWithTimeout: setTimeout called with 5000 ms');

  // Fire the timeout callback
  capturedCallback();

  let rejected = false;
  let rejectionMessage = '';
  await p.catch(err => {
    rejected = true;
    rejectionMessage = err && err.message ? err.message : String(err);
  });

  assert(rejected, '_injectScriptWithTimeout: promise rejects after timeout fires');
  assert(rejectionMessage.includes(url), '_injectScriptWithTimeout: rejection message contains the URL');
  assert(rejectionMessage.includes('5000'), '_injectScriptWithTimeout: rejection message contains timeout duration');

  // Restore real timers
  global.setTimeout   = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}

section('C2. Timeout — resolve before timeout clears the timer');
{
  const bridge = new OmidCompatBridge({});

  let resolveScript;
  bridge._injectScript = function(_url) {
    return new Promise(resolve => { resolveScript = resolve; });
  };

  const realSetTimeout   = global.setTimeout;
  const realClearTimeout = global.clearTimeout;

  let clearTimeoutId = null;
  global.setTimeout   = function(fn, ms) { return 99; };
  global.clearTimeout = function(id)     { clearTimeoutId = id; };

  const p = bridge._injectScriptWithTimeout('https://omid.example/ok.js', 5000);
  resolveScript(); // resolve before timeout

  let resolved = false;
  await p.then(() => { resolved = true; }).catch(() => {});

  assert(resolved, '_injectScriptWithTimeout: resolves when script loads before timeout');
  assert(clearTimeoutId === 99, '_injectScriptWithTimeout: clearTimeout called to cancel pending timeout');

  global.setTimeout   = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}

// ══════════════════════════════════════════════════════════════════════════
// D. MARKUP INJECTION NO-OP
// ══════════════════════════════════════════════════════════════════════════

section('D. Markup injection — injectScripts returns markup unchanged');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
    baseUrl: 'https://cdn.example/sharc',
  });

  const html = '<html><head><title>Ad</title></head><body>content</body></html>';
  const result = bridge.injectScripts(html);

  assert(result === html, 'injectScripts: returns original markup unchanged');
  assert(!result.includes('omweb-v1.js'), 'injectScripts: does not inject OM SDK service script');
  assert(!result.includes('omid-session-client-v1.js'), 'injectScripts: does not inject OM SDK session client');
  assert(!result.includes('sharc-omid-bridge.js'), 'injectScripts: does not inject SHARC OMID bridge');
}

section('D2. Markup injection — no-<head> markup remains unchanged');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
    baseUrl: 'https://cdn.example/sharc',
  });

  const html = '<div>Headless creative content</div>';
  const result = bridge.injectScripts(html);

  assert(result === html, 'injectScripts no-<head>: returns original markup unchanged');
  assert(!result.includes('<script'), 'injectScripts no-<head>: does not prepend script tags');
}

section('D3. Markup injection — injectIntoMarkup returns markup unchanged');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
    baseUrl: 'https://cdn.example/sharc',
  });

  const html = '<html><head></head><body>test</body></html>';
  assert(
    bridge.injectIntoMarkup(html) === html,
    'injectIntoMarkup(html) returns original markup unchanged'
  );
}

section('D4. getScriptUrls — compatibility order is preserved');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
    baseUrl: 'https://cdn.example/sharc',
  });

  const urls = bridge.getScriptUrls();
  // Exact index checks
  assert(urls[0] === 'https://omid.example/omweb-v1.js', 'getScriptUrls [0] = OM SDK service script (omweb-v1.js)');
  assert(urls[1] === 'https://omid.example/omid-session-client-v1.js', 'getScriptUrls [1] = OM SDK session client');
  assert(urls[2].endsWith('sharc-protocol.js'), 'getScriptUrls [2] = sharc-protocol.js');
  assert(urls[3].endsWith('sharc-creative.js'), 'getScriptUrls [3] = sharc-creative.js');
  assert(urls[4].endsWith('sharc-omid-bridge.js'), 'getScriptUrls [4] = sharc-omid-bridge.js');

  // getScriptUrls falls back to defaults when URLs not provided
  const bridgeDefaults = new OmidCompatBridge({ baseUrl: 'https://cdn.example/sharc' });
  const defUrls = bridgeDefaults.getScriptUrls();
  assert(defUrls[0].includes('omweb-v1'), 'getScriptUrls default[0] contains "omweb-v1"');
  assert(defUrls[1].includes('omid-session-client'), 'getScriptUrls default[1] contains "omid-session-client"');
}

// ══════════════════════════════════════════════════════════════════════════
// E. BRIDGE CONTRACT
// ══════════════════════════════════════════════════════════════════════════

section('E. Bridge contract — OMID NOT in bridges array; explicit ["omid"] throws');
{
  // OMID is a container-owned extension, NOT a creative bridge
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: ['omid'] })),
    /not a recognized bridge identifier/,
    'explicit bridges:["omid"] throws — OMID is not a renderer bridge',
    Error
  );

  // AdCOM 7 must NOT map to any bridge identifier
  assertDeepEqual(
    SHARCContainer._mapAdComApisToBridges([7]),
    [],
    'AdCOM APIFramework 7 (OMID) maps to [] — not a renderer bridge'
  );

  // creativeMeta.apis=[7] resolves to no renderer bridge
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [7] } }),
    [],
    'creativeMeta.apis=[7] → container.bridges = []'
  );

  // OMID + MRAID: only MRAID maps to a bridge
  assertDeepEqual(
    SHARCContainer._mapAdComApisToBridges([6, 7]),
    ['mraid'],
    'AdCOM [6 (MRAID 3.0), 7 (OMID)] → only ["mraid"] (OMID excluded)'
  );

  // A container constructed with creativeMeta.apis=[7] has empty bridges
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);
    assertDeepEqual([...c.bridges], [], 'container.bridges = [] when only AdCOM 7 declared (OMID is extension only)');
  } finally {
    uninstallMockSdk();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// F. VISIBILITY SIGNALING & PLACEMENT CHANGE
// ══════════════════════════════════════════════════════════════════════════

section('F. Visibility signaling — visible / notVisible states');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });
    // Should have VISIBLE from active
    assert(mock.stats.visibilityStates.includes('VISIBLE'), 'active → visibility = VISIBLE');

    // Transition to passive/hidden → notVisible
    c.setState('passive');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'passive', previousState: 'active' });
    const lastState = mock.stats.visibilityStates[mock.stats.visibilityStates.length - 1];
    assert(lastState === 'NON_VISIBLE', 'passive → visibility = NON_VISIBLE');

    // Back to active → visible again
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'passive' });
    const lastState2 = mock.stats.visibilityStates[mock.stats.visibilityStates.length - 1];
    assert(lastState2 === 'VISIBLE', 'active again → visibility = VISIBLE');

  } finally {
    uninstallMockSdk();
  }
}

section('F2. Visibility signaling — duplicate visibility state NOT re-signaled');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    const visibleCount1 = mock.stats.visibilityStates.filter(v => v === 'VISIBLE').length;

    // Signal visible again (duplicate)
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'active' });
    const visibleCount2 = mock.stats.visibilityStates.filter(v => v === 'VISIBLE').length;
    assert(visibleCount1 === visibleCount2, 'duplicate active→active: visibility NOT re-signaled (idempotent)');

  } finally {
    uninstallMockSdk();
  }
}

section('F3. Placement change handling — expand and resize intents');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'video', mediaType: 'video' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    // Fire placement expand
    c._notifyExtensionsLifecycle('placementChange', { intent: 'expand' });
    const expandState = mock.stats.playerStates.find(s => s === 'expanded');
    assert(expandState === 'expanded', 'placementChange expand → playerStateChange("expanded")');

    // Fire placement resize (should map to "normal")
    c._notifyExtensionsLifecycle('placementChange', { intent: 'resize' });
    const normalState = mock.stats.playerStates.find(s => s === 'normal');
    assert(normalState === 'normal', 'placementChange resize → playerStateChange("normal")');

  } finally {
    uninstallMockSdk();
  }
}

section('F4. Placement change — no-op before session started');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'video', mediaType: 'video' });
    const c = createContainerWithOmid(bridge);

    // Fire placementChange before ready/active
    c._notifyExtensionsLifecycle('placementChange', { intent: 'expand' });
    assert(mock.stats.playerStates.length === 0, 'placementChange before session: playerStateChange NOT called');

  } finally {
    uninstallMockSdk();
  }
}

section('F5. Visibility — hidden and frozen states signal notVisible');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    // hidden state → notVisible
    c._notifyExtensionsLifecycle('stateChange', { newState: 'hidden', previousState: 'active' });
    const hiddenVis = mock.stats.visibilityStates[mock.stats.visibilityStates.length - 1];
    assert(hiddenVis === 'NON_VISIBLE', 'hidden state → NON_VISIBLE');

    // Back to active, then frozen
    bridge._omid.lastVisibilityState = null; // reset to allow re-signal
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'hidden' });
    c._notifyExtensionsLifecycle('stateChange', { newState: 'frozen', previousState: 'active' });
    const frozenVis = mock.stats.visibilityStates[mock.stats.visibilityStates.length - 1];
    assert(frozenVis === 'NON_VISIBLE', 'frozen state → NON_VISIBLE');

  } finally {
    uninstallMockSdk();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// G. EDGE CASES
// ══════════════════════════════════════════════════════════════════════════

section('G. Edge cases — repeated teardown signals: finish called exactly once');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);

    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    // Fire all teardown signals in rapid succession
    c._notifyExtensionsLifecycle('error',   { errorCode: 1, errorMessage: 'e1' });
    c._notifyExtensionsLifecycle('error',   { errorCode: 1, errorMessage: 'e2' });
    c._notifyExtensionsLifecycle('destroy');
    bridge.destroy();
    c._notifyExtensionsLifecycle('stateChange', { newState: 'terminated', previousState: 'active' });

    assert(mock.stats.finishCalls === 1,
      'repeated teardown (error×2 + destroy + bridge.destroy + terminated): AdSession.finish() called exactly once');
    assert(bridge._omid.sessionStarted === false && bridge._omid.sessionFinished === true,
      'after repeated teardown: sessionStarted=false, sessionFinished=true');

  } finally {
    uninstallMockSdk();
  }
}

section('G2. Edge cases — SDK not loaded: session creation is suppressed gracefully');
{
  // No mock installed — OmidSessionClient absent
  const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
  const c = createContainerWithOmid(bridge);

  let threw = false;
  try {
    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });
  } catch (e) {
    threw = true;
  }

  assert(!threw, 'SDK not loaded: no exception thrown (graceful degradation)');
  assert(bridge._omid.sessionStarted === false, 'SDK not loaded: sessionStarted remains false');
  assert(bridge._omid.sessionFinished === false, 'SDK not loaded: sessionFinished remains false');
}

section('G3. Edge cases — SDK load failure handling');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });

  // Patch _injectScript to reject (simulate load failure)
  bridge._injectScript = function(url) {
    return Promise.reject(new Error('Failed to load ' + url));
  };

  let threw = false;
  let sdkPromise;
  try {
    sdkPromise = bridge._ensureSdkLoaded();
  } catch(e) {
    threw = true;
  }
  assert(!threw, 'SDK load failure: _ensureSdkLoaded() does not throw synchronously');
  assert(sdkPromise && typeof sdkPromise.then === 'function', '_ensureSdkLoaded returns a Promise');

  // Ensure the rejection is handled (doesn't become unhandled)
  let rejected = false;
  await sdkPromise.catch(() => { rejected = true; });
  assert(rejected, '_ensureSdkLoaded: returned promise rejects on script load failure');
}

section('G3b. Edge cases — incomplete SDK URL configuration is inert');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
  });

  let injectCalls = 0;
  bridge._injectScript = function() {
    injectCalls++;
    return Promise.resolve();
  };

  const sdkPromise = bridge._ensureSdkLoaded();
  await sdkPromise;

  assert(bridge.getFeatureName() === null,
    'incomplete SDK URLs: getFeatureName returns null');
  assert(bridge.getFeatureDescriptor() === null,
    'incomplete SDK URLs: getFeatureDescriptor returns null');
  assert(injectCalls === 0,
    'incomplete SDK URLs: _ensureSdkLoaded does not inject a partial SDK');
}

section('G4. Edge cases — onContainerLifecycleEvent with null/missing event is safe');
{
  const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
  let threw = false;
  try {
    bridge.onContainerLifecycleEvent(null);
    bridge.onContainerLifecycleEvent(undefined);
    bridge.onContainerLifecycleEvent({ type: 'unknownEventType', container: null });
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'onContainerLifecycleEvent(null/undefined/unknown): no exception thrown');
}

section('G5. Edge cases — augmentEnvironmentData with null/empty input');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
  });

  const env1 = bridge.augmentEnvironmentData(null);
  assert(env1 && typeof env1 === 'object', 'augmentEnvironmentData(null): returns object (not null)');
  assert(typeof env1.omidServiceScriptUrl === 'string', 'augmentEnvironmentData(null): omidServiceScriptUrl present');

  const env2 = bridge.augmentEnvironmentData(undefined);
  assert(env2 && typeof env2 === 'object', 'augmentEnvironmentData(undefined): returns object');
  assert(typeof env2.omidServiceScriptUrl === 'string', 'augmentEnvironmentData(undefined): omidServiceScriptUrl present');

  const env3 = bridge.augmentEnvironmentData({});
  assert(env3.omidServiceScriptUrl === 'https://omid.example/omweb-v1.js',
    'augmentEnvironmentData({}): omidServiceScriptUrl set from options');
}

section('G6. Edge cases — destroy() before any session is safe');
{
  const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
  let threw = false;
  try {
    bridge.destroy();
    bridge.destroy(); // second call also safe
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'destroy() before session: no exception thrown');
  assert(bridge._container === null, 'destroy() before session: _container = null');
}

section('G7. Edge cases — video session creates MediaEvents; display does not');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    // VIDEO session
    const bridgeVideo = new OmidCompatBridge({ creativeType: 'video', mediaType: 'video' });
    const cVideo = createContainerWithOmid(bridgeVideo);
    cVideo.setState('ready');
    cVideo._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    assert(bridgeVideo._omid.mediaEvents !== null, 'video session: MediaEvents created');
    assert(bridgeVideo._omid.isVideoSession === true, 'video session: isVideoSession = true');
  } finally {
    uninstallMockSdk();
  }

  const mock2 = createMockOmidSdk();
  installMockSdk(mock2);
  try {
    // DISPLAY session
    const bridgeDisplay = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const cDisplay = createContainerWithOmid(bridgeDisplay);
    cDisplay.setState('ready');
    cDisplay._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    assert(bridgeDisplay._omid.mediaEvents === null, 'display session: MediaEvents NOT created');
    assert(bridgeDisplay._omid.isVideoSession === false, 'display session: isVideoSession = false');
  } finally {
    uninstallMockSdk();
  }
}

section('G8. Edge cases — getWrapperUrl properly encodes creative URL');
{
  const bridge = new OmidCompatBridge({ baseUrl: 'https://cdn.example/sharc' });
  const creative = 'https://creative.example/ad.html?id=1&type=video';
  const wrapper = bridge.getWrapperUrl(creative);
  assert(wrapper.includes(encodeURIComponent(creative)), 'getWrapperUrl: creative URL is properly encoded');
  assert(!wrapper.includes('?id=1&type=video'), 'getWrapperUrl: raw query chars are encoded (& is not literal)');
}

section('G9. Edge cases — onContainerStateChange without prior load is safe');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    // Call state change without going through container (direct call)
    let threw = false;
    try {
      bridge.onContainerStateChange('ready', 'loading', null);
      bridge.onContainerStateChange('active', 'ready', null);
    } catch (e) {
      threw = true;
    }
    assert(!threw, 'onContainerStateChange with null container: no exception');
  } finally {
    uninstallMockSdk();
  }
}

section('G10. Edge cases — _buildVerificationScripts: pre-built resources pass through');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    // Pre-built VerificationScriptResource objects must pass through unchanged
    const pre = new mock.sdk.VerificationScriptResource(
      'https://verify.example/v.js', 'vendor.example', 'p=1', 'limited'
    );
    const bridge = new OmidCompatBridge({
      creativeType: 'display',
      mediaType: 'display',
      verificationScripts: [pre], // already-constructed resource
    });
    const c = createContainerWithOmid(bridge);
    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });

    // The resource passed in should be used as-is (it has a .url property, so
    // _buildVerificationScripts will try to wrap it — verify the url is preserved)
    assert(
      mock.stats.verificationScripts && mock.stats.verificationScripts.length === 1,
      '_buildVerificationScripts: exactly 1 script resource passed to Context'
    );
    assert(
      mock.stats.verificationScripts[0].url === 'https://verify.example/v.js',
      '_buildVerificationScripts: URL preserved in passed-through resource'
    );
  } finally {
    uninstallMockSdk();
  }
}

section('G10b. Edge cases — verificationScripts validation and deduplication');
{
  assertThrows(
    () => new OmidCompatBridge({ verificationScripts: [{ resourceUrl: 'http://verify.example/v.js' }] }),
    /HTTPS/,
    'verificationScripts rejects non-HTTPS resourceUrl',
    TypeError
  );
  assertThrows(
    () => new OmidCompatBridge({ verificationScripts: [{ resourceUrl: 'https://user:pass@verify.example/v.js' }] }),
    /userinfo/,
    'verificationScripts rejects userinfo in resourceUrl',
    TypeError
  );
  assertThrows(
    () => new OmidCompatBridge({ verificationScripts: [{ resourceUrl: 'data:text/javascript,alert(1)' }] }),
    /HTTPS/,
    'verificationScripts rejects data: resourceUrl',
    TypeError
  );

  const bridge = new OmidCompatBridge({
    verificationScripts: [
      { resourceUrl: 'https://verify.example/v.js', vendor: 'vendor-a' },
      { resourceUrl: 'https://verify.example/v.js', vendor: 'vendor-b' },
      { url: 'https://legacy.example/v.js', vendor: 'legacy-vendor' },
    ],
  });
  assert(bridge.options.verificationScripts.length === 2,
    'verificationScripts deduplicates by URL with first occurrence kept');
  assert(bridge.options.verificationScripts[0].vendor === 'vendor-a',
    'verificationScripts keeps first duplicate descriptor');
  assert(bridge.options.verificationScripts[1].resourceUrl === 'https://legacy.example/v.js',
    'verificationScripts normalizes legacy url alias to resourceUrl');

  // 0.7.3 cleanup (#127 sub-3b): legacy-url-alias normalization MUST NOT
  // mutate the operator's input object. Validator now pushes a shallow
  // copy with the normalized resourceUrl.
  const operatorInput = [{ url: 'https://op-input.example/v.js', vendor: 'op-vendor' }];
  new OmidCompatBridge({ verificationScripts: operatorInput });
  assert(operatorInput[0].url === 'https://op-input.example/v.js',
    'legacy-url-alias: operator input.url preserved (not mutated)');
  assert(!('resourceUrl' in operatorInput[0]),
    'legacy-url-alias: resourceUrl NOT written onto operator input object');
}

section('G10c. Edge cases — OM SDK script URLs use HTTPS validation');
{
  assertThrows(
    () => new OmidCompatBridge({ omSdkServiceScriptUrl: 'http://omid.example/omweb-v1.js' }),
    /HTTPS/,
    'omSdkServiceScriptUrl rejects non-HTTPS URLs',
    TypeError
  );
  assertThrows(
    () => new OmidCompatBridge({ omSdkSessionClientUrl: 'https://user:pass@omid.example/omid-session-client-v1.js' }),
    /userinfo/,
    'omSdkSessionClientUrl rejects userinfo',
    TypeError
  );

  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  assert(bridge.options.omSdkServiceScriptUrl === 'https://omid.example/omweb-v1.js',
    'omSdkServiceScriptUrl preserves validated HTTPS URL');
  assert(bridge.options.omSdkSessionClientUrl === 'https://omid.example/omid-session-client-v1.js',
    'omSdkSessionClientUrl preserves validated HTTPS URL');
}

// G10d. baseUrl validation (issue #140 defense-in-depth) — moved to the
// cross-bridge parity matrix in test/node/test-bridges-detection.js §19, which
// runs the same accept/reject contract against MRAID + SafeFrame +
// OmidCompatBridge in one place. Keeping the matrix in one file ensures any
// future security fix that lands in one bridge's validator can't silently
// miss the others.

section('G11. Edge cases — getFeatureDescriptor mediaEvents flag for video vs display');
{
  const sdkUrls = {
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  };

  const bridgeVideo = new OmidCompatBridge({ ...sdkUrls, mediaType: 'video' });
  assert(bridgeVideo.getFeatureDescriptor().capabilities.mediaEvents === true,
    'getFeatureDescriptor: mediaEvents = true for video');

  const bridgeAudio = new OmidCompatBridge({ ...sdkUrls, mediaType: 'audio' });
  assert(bridgeAudio.getFeatureDescriptor().capabilities.mediaEvents === true,
    'getFeatureDescriptor: mediaEvents = true for audio');

  const bridgeDisplay = new OmidCompatBridge({ ...sdkUrls, mediaType: 'display' });
  assert(bridgeDisplay.getFeatureDescriptor().capabilities.mediaEvents === false,
    'getFeatureDescriptor: mediaEvents = false for display');

  // Default (no mediaType) → video, so mediaEvents = true
  const bridgeDefault = new OmidCompatBridge(sdkUrls);
  assert(bridgeDefault.getFeatureDescriptor().capabilities.mediaEvents === true,
    'getFeatureDescriptor: mediaEvents = true by default (video)');

  const bridgeInert = new OmidCompatBridge({});
  assert(bridgeInert.getFeatureName() === null,
    'getFeatureName: returns null when OM SDK script URLs are not configured');
  assert(bridgeInert.getFeatureDescriptor() === null,
    'getFeatureDescriptor: returns null when OM SDK script URLs are not configured');
}

section('G11b. Edge cases — pending SDK load creates only one session chain');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  let thenCallbacks = 0;
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  const originalThen = pending.then.bind(pending);
  pending.then = function(onFulfilled, onRejected) {
    thenCallbacks++;
    return originalThen(onFulfilled, onRejected);
  };
  bridge._ensureSdkLoaded = function() { return pending; };

  bridge._createSessionWhenReady();
  const firstPending = bridge._sessionCreationPromise;
  bridge._createSessionWhenReady();
  bridge._createSessionWhenReady();

  assert(thenCallbacks === 1, 'pending SDK load: only one .then() session chain is attached');
  assert(bridge._sessionCreationPromise === firstPending,
    'pending SDK load: repeated calls reuse the same session creation promise');

  resolveLoad();
  await firstPending;
  assert(bridge._sessionCreationPromise === null,
    'pending SDK load: session creation promise is cleared after settlement');
}

section('G11c. Edge cases — script injection dedup handles selector-special URLs');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  const originalCreateElement = document.createElement.bind(document);
  let createdScripts = 0;
  document.body.innerHTML = '';

  const url = 'https://omid.example/omweb-v1.js?slot=[a]&quoted="yes"';
  const existing = originalCreateElement('script');
  existing.src = url;
  document.head.appendChild(existing);

  document.createElement = function(tagName) {
    if (String(tagName).toLowerCase() === 'script') createdScripts++;
    return originalCreateElement(tagName);
  };

  try {
    await bridge._injectScript(url);
    assert(createdScripts === 0,
      '_injectScript: existing script is detected without unsafe selector construction');
  } finally {
    document.createElement = originalCreateElement;
    if (existing.parentNode) existing.parentNode.removeChild(existing);
  }
}

section('G11d. Edge cases — destroy removes scripts injected by the bridge');
{
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  const script = document.createElement('script');
  script.src = 'https://omid.example/omweb-v1.js';
  document.head.appendChild(script);
  bridge._loadedScripts.push(script);

  bridge.destroy();

  assert(!script.parentNode, 'destroy(): injected OM SDK script node is removed');
  assert(bridge._loadedScripts.length === 0, 'destroy(): _loadedScripts is cleared');
}

section('G11f. Edge cases — multi-instance destroy contract (each bridge owns only what it injected)');
{
  // 0.7.3 follow-up (#127 sub-3a): when two OmidCompatBridge instances share
  // an OM SDK URL, instance B's _injectScript finds A's existing tag and
  // resolves early WITHOUT pushing to its own _loadedScripts. A.destroy()
  // removes the shared tag (it's in A's _loadedScripts); B's _loadedScripts
  // stays empty because B never owned the tag. This test documents that
  // contract so a future maintainer can't quietly change it.
  const sharedUrl = 'https://omid.example/omweb-shared.js';
  const bridgeA = new OmidCompatBridge({
    omSdkServiceScriptUrl: sharedUrl,
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  const bridgeB = new OmidCompatBridge({
    omSdkServiceScriptUrl: sharedUrl,
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });

  // A "injects" by pushing into _loadedScripts (simulates the post-onload path).
  const sharedScript = document.createElement('script');
  sharedScript.src = sharedUrl;
  document.head.appendChild(sharedScript);
  bridgeA._loadedScripts.push(sharedScript);

  // B sees the existing tag — call _injectScript and verify it resolves
  // without pushing to B's _loadedScripts (matching the production dedup
  // path inside _injectScript at sharc-omid-bridge.js:629-650).
  await bridgeB._injectScript(sharedUrl);
  assert(bridgeB._loadedScripts.length === 0,
    'B._injectScript finds existing tag → does NOT push to B._loadedScripts');

  // A.destroy() removes the shared tag.
  bridgeA.destroy();
  assert(!sharedScript.parentNode,
    'A.destroy(): A removes the shared script it owned');
  assert(bridgeB._loadedScripts.length === 0,
    'B._loadedScripts stays empty after A.destroy() (B never owned the tag)');

  // B.destroy() must not throw even though its _loadedScripts is empty.
  let bDestroyThrew = false;
  try { bridgeB.destroy(); } catch (_) { bDestroyThrew = true; }
  assert(!bDestroyThrew,
    'B.destroy() does not throw with empty _loadedScripts (clean idempotent cleanup)');
}

section('G11e. Edge cases — friendly obstruction lifecycle follows container close button changes');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({
      omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
      omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
      creativeType: 'display',
      mediaType: 'display',
    });
    const c = createContainerWithOmid(bridge);
    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });

    c._createDismissButton('top-right', { width: 320, height: 50 }, { x: 0, y: 0 });
    const firstButton = c._closeButton;
    assert(mock.stats.addFriendlyObstructionCalls.length === 1,
      'close button create: registers one friendly obstruction');
    assert(mock.stats.addFriendlyObstructionCalls[0].el === firstButton,
      'close button create: registers the rendered close button element');
    assert(mock.stats.addFriendlyObstructionCalls[0].purpose === 'closeAd',
      'close button create: uses closeAd obstruction purpose');

    c._notifyOmidObstruction(firstButton, true);
    assert(mock.stats.addFriendlyObstructionCalls.length === 1,
      're-register same button: does not duplicate friendly obstruction registration');

    c._createDismissButton('top-left', { width: 320, height: 50 }, { x: 0, y: 0 });
    const secondButton = c._closeButton;
    assert(secondButton !== firstButton, 'close button recreate: swaps to a new button element');
    assert(mock.stats.removeFriendlyObstructionCalls.length === 1,
      'close button recreate: unregisters the previous obstruction');
    assert(mock.stats.removeFriendlyObstructionCalls[0] === firstButton,
      'close button recreate: unregisters the previous button element');
    assert(mock.stats.addFriendlyObstructionCalls.length === 2,
      'close button recreate: registers the replacement obstruction');
    assert(mock.stats.addFriendlyObstructionCalls[1].el === secondButton,
      'close button recreate: registers the replacement button element');

    bridge.destroy();
    assert(mock.stats.removeFriendlyObstructionCalls.length === 2,
      'destroy(): unregisters the active friendly obstruction');
    assert(mock.stats.removeFriendlyObstructionCalls[1] === secondButton,
      'destroy(): unregisters the latest close button element');
  } finally {
    uninstallMockSdk();
  }
}

section('G12. Edge cases — VastProperties passed for video loaded() call');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({
      creativeType: 'video',
      mediaType: 'video',
      vastProperties: {
        isSkippable: true,
        skipOffset: 5,
        isAutoPlay: false,
        position: 'preroll',
      },
    });
    const c = createContainerWithOmid(bridge);
    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    assert(mock.stats.loadedCalls === 1, 'video with vastProperties: loaded() called once');
    assert(mock.stats.loadedArgs.length === 1, 'video with vastProperties: loaded() received argument');
    const vp = mock.stats.loadedArgs[0];
    assert(vp instanceof mock.sdk.VastProperties, 'video loaded() arg is VastProperties instance');
    assert(vp.isSkippable === true, 'VastProperties: isSkippable preserved');
    assert(vp.skipOffset === 5, 'VastProperties: skipOffset preserved');
    assert(vp.isAutoPlay === false, 'VastProperties: isAutoPlay preserved');
    assert(vp.position === 'preroll', 'VastProperties: position preserved');

  } finally {
    uninstallMockSdk();
  }
}

section('G13. Edge cases — display loaded() called without VastProperties argument');
{
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    const bridge = new OmidCompatBridge({ creativeType: 'display', mediaType: 'display' });
    const c = createContainerWithOmid(bridge);
    c.setState('ready');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
    c.setState('active');
    c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

    assert(mock.stats.loadedCalls === 1, 'display: loaded() called once');
    // For display, loaded() should be called without VastProperties
    // loaded() arg should be undefined (no VastProperties for display)
    assert(mock.stats.loadedArgs[0] === undefined, 'display: loaded() called without VastProperties argument');

  } finally {
    uninstallMockSdk();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// H. TERMINATION MID-LOAD (0.7.4 — issue #126)
// ══════════════════════════════════════════════════════════════════════════
//
// Coverage for the deferred-follow-up edge case from PR #122: when termination
// or destroy fires while the OM SDK script-load promise is still pending,
// the resolved promise must NOT create a session, must NOT fire late
// callbacks, and must NOT emit `feature_load_failed` (the failure path here
// is a normal teardown, not a script-load failure).
//
// All five sections (H1-H5) PASS on `main` — the implementation in PR #122
// (`destroy()` at src/sharc-omid-bridge.js:1016, with the cleanup line at
// :1026 clearing `_sessionCreationPromise`, plus the lifecycle dispatch on
// terminate-state-transition) already enforces the contract. These tests
// are coverage-add, pinning the behavior for regression protection rather
// than driving new implementation. Treat as a contract lock, not a fix.

section('H1. #126 — bridge.destroy() during pending _sessionCreationPromise: no late session start');
{
  // Setup: bridge with both OM SDK URLs configured; never load the SDK
  // (no mock installed) and stub _ensureSdkLoaded to hand back a manually
  // resolved promise so the test controls the timing.
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  bridge._ensureSdkLoaded = function () { return pending; };

  // Trigger the deferred session-creation chain (sets _sessionCreationPromise).
  bridge._createSessionWhenReady();
  assert(bridge._sessionCreationPromise && typeof bridge._sessionCreationPromise.then === 'function',
    '_createSessionWhenReady stages a pending session-creation promise');

  // Destroy BEFORE the SDK load resolves.
  bridge.destroy();

  // CONTRACT (currently NOT enforced on main): destroy must clear
  // _sessionCreationPromise so any subsequent _createSession call
  // tied to the resolved load is suppressed.
  assert(bridge._sessionCreationPromise === null,
    'destroy() during pending SDK load: _sessionCreationPromise cleared');
  assert(bridge._omid.sessionFinished === true,
    'destroy() during pending SDK load: _omid.sessionFinished is true');

  // Install the mock SDK now so _createSession would succeed if called.
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    // Resolve the in-flight load. If the destroy didn't break the chain,
    // _createSession would run here and call AdSession.start().
    resolveLoad();
    await pending.catch(() => {});
    // Drain microtasks so the .then() callback (if it ran) has a chance
    // to fire.
    await Promise.resolve();
    await Promise.resolve();

    assert(mock.stats.startCalls === 0,
      'destroy() during pending SDK load: AdSession.start() NOT called after late resolution');
    assert(bridge._omid.sessionStarted === false,
      'destroy() during pending SDK load: _omid.sessionStarted stays false after late resolution');
  } finally {
    uninstallMockSdk();
  }
}

section('H2. #126 — container._terminate() during pending _sessionCreationPromise: clean teardown');
{
  // Same shape as H1 but driven through the container's _terminate path
  // rather than bridge.destroy() directly. The lifecycle dispatch on
  // terminate-state-transition must reach the bridge with a deterministic
  // cleanup signal.
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  bridge._ensureSdkLoaded = function () { return pending; };

  const c = createContainerWithOmid(bridge);
  // Fire the 'load' lifecycle event to bind the bridge to the container
  // and kick off the SDK load.
  bridge.onContainerLifecycleEvent({ type: 'load', container: c });
  // Move to ready so _createSessionWhenReady runs.
  c.setState('ready');
  c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
  assert(bridge._sessionCreationPromise !== null,
    'ready-while-load-pending: _sessionCreationPromise is non-null');

  // Now terminate the container. The standard teardown is _terminate(),
  // which dispatches the 'destroy' lifecycle event.
  c._terminate();

  assert(bridge._sessionCreationPromise === null,
    'container._terminate() during pending SDK load: bridge._sessionCreationPromise cleared');
  assert(bridge._omid.sessionFinished === true,
    'container._terminate() during pending SDK load: bridge sessionFinished is true');

  // Resolve the pending load with mock SDK installed and verify no late session.
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    resolveLoad();
    await pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    assert(mock.stats.startCalls === 0,
      'container._terminate() during pending SDK load: AdSession.start() NOT called after late resolution');
  } finally {
    uninstallMockSdk();
  }
}

section('H3. #126 — termination-mid-load does NOT fire feature_load_failed');
{
  // Critical distinction: destroy-mid-load is a *normal* teardown, not a
  // *failed* load. The feature_load_failed variant (PR E / issue #125) is
  // reserved for actual SDK-load failures (404, network, evaluation throw,
  // timeout). When the operator (or container fatal-error) tears down the
  // container while the load happens to still be in flight, we are NOT
  // failing the load — we are abandoning it.
  //
  // This section pins the contract: no `feature_load_failed` event on
  // termination-mid-load, on either onSecurityEvent OR console.warn paths.
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  bridge._ensureSdkLoaded = function () { return pending; };

  const securityEvents = [];
  const c = new SHARCContainer(markupOptions({
    creativeMeta: { apis: [7] },
    extensions: [bridge],
    onSecurityEvent: (evt) => { securityEvents.push(evt); },
  }));
  c._iframe = document.createElement('iframe');
  c._protocol.sendStateChange = () => {};

  bridge.onContainerLifecycleEvent({ type: 'load', container: c });
  c.setState('ready');
  c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });

  // Capture console.warn while destroy + late-resolution run.
  const origWarn = console.warn;
  const warns = [];
  console.warn = (...args) => { warns.push(args.join(' ')); };
  try {
    c._terminate();
    resolveLoad();
    await pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    console.warn = origWarn;
  }

  const featureLoadFailedEvents = securityEvents.filter(
    (e) => e && e.type === 'feature_load_failed'
  );
  assert(featureLoadFailedEvents.length === 0,
    'termination-mid-load: NO feature_load_failed onSecurityEvent fired (teardown ≠ failure)');

  const featureLoadFailedWarns = warns.filter(
    (w) => /feature_load_failed/i.test(w)
  );
  assert(featureLoadFailedWarns.length === 0,
    'termination-mid-load: NO feature_load_failed console.warn fired (teardown ≠ failure)');
}

section('H4. #126 — destroy-mid-load: _loadedScripts cleanup is deterministic');
{
  // The bridge appends <script> tags during _injectScript and tracks them
  // in _loadedScripts. destroy() must remove the tags it owns even when
  // destroy() races a still-pending injection.
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  // Simulate the post-onload state: one script tag was appended and tracked
  // before destroy fires.
  const ownedScript = document.createElement('script');
  ownedScript.src = 'https://omid.example/omweb-v1.js';
  document.head.appendChild(ownedScript);
  bridge._loadedScripts.push(ownedScript);

  // Stage a pending _sessionCreationPromise.
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  bridge._ensureSdkLoaded = function () { return pending; };
  bridge._createSessionWhenReady();

  bridge.destroy();

  assert(!ownedScript.parentNode,
    'destroy()-mid-load: bridge-owned <script> tag removed from DOM');
  assert(bridge._loadedScripts.length === 0,
    'destroy()-mid-load: _loadedScripts array cleared');

  // Late resolution must NOT re-inject or re-track anything.
  resolveLoad();
  await pending.catch(() => {});
  await Promise.resolve();
  assert(bridge._loadedScripts.length === 0,
    'destroy()-mid-load: late SDK load resolution does NOT re-populate _loadedScripts');
}

section('H5. #126 — destroy then re-resolve: subsequent _createSessionWhenReady is inert');
{
  // After destroy, the bridge instance is conceptually dead. Any further
  // calls (defensively triggered by stray lifecycle dispatch from a buggy
  // host) MUST be no-ops — no session start, no late session creation,
  // no exceptions.
  const bridge = new OmidCompatBridge({
    omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
  });
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  bridge._ensureSdkLoaded = function () { return pending; };

  bridge._createSessionWhenReady();
  bridge.destroy();

  // Stray post-destroy call — should be a no-op.
  let threw = null;
  try {
    bridge._createSessionWhenReady();
  } catch (e) { threw = e; }
  assert(threw === null,
    'post-destroy _createSessionWhenReady() does not throw');

  // Install mock now to confirm no AdSession was opened.
  const mock = createMockOmidSdk();
  installMockSdk(mock);
  try {
    resolveLoad();
    await pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    assert(mock.stats.startCalls === 0,
      'post-destroy _createSessionWhenReady(): no AdSession.start() even after SDK loads');
    assert(bridge._omid.sessionStarted === false,
      'post-destroy: _omid.sessionStarted remains false');
  } finally {
    uninstallMockSdk();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// H6. EXTENSION ERROR CONTRACT (0.7.4 — issue #123)
// ══════════════════════════════════════════════════════════════════════════
//
// Extensions implementing onContainerLifecycleEvent({ type: 'error', ... })
// MUST receive a canonical { errorCode, errorMessage, source } payload from
// BOTH the creative-fatal-error path (_handleCreativeFatalError) and the
// container-fatal-error path (_handleFatalError). The field is errorMessage
// (not message) — same name as the public onError(errorCode, errorMessage)
// callback signature.
//
// Audit (against a1a6ee1):
//   - src/sharc-container.js:3394 already passes errorMessage from creative
//   - src/sharc-container.js:3960 already passes errorMessage from container
//
// The container side is ALREADY correct on main. These tests pin the
// contract so a future refactor can't quietly drop a field. PR D's
// production-code component is therefore docs-only (api-reference.md §9
// "Lifecycle hook contract" gains an event-payload column). PR D's test
// component is THIS section — coverage that the existing implementation
// keeps its promise.
//
// One sub-test (the "no stray `message` field" assertion) IS expected to
// flip if the implementation regresses. If it passes on main, that's a
// signal the implementation already matches the contract.

section('H6. #123 — extension onContainerLifecycleEvent.error receives canonical { errorCode, errorMessage, source }');
{
  // Stub extension that captures every lifecycle event it receives.
  const captured = [];
  const captureExtension = {
    getFeatureName() { return 'com.example.capture'; },
    onContainerLifecycleEvent(evt) { captured.push(evt); },
  };

  // ── Sub-test 1: creative-fatal-error path ──────────────────────────────
  {
    captured.length = 0;
    const c = new SHARCContainer(markupOptions({
      extensions: [captureExtension],
    }));
    c._iframe = document.createElement('iframe');
    c._protocol.sendStateChange = () => {};

    // Simulate the creative sending a fatalError message.
    c._handleCreativeFatalError({
      args: { errorCode: 9001, errorMessage: 'simulated creative fatal' },
    });

    const errorEvents = captured.filter((e) => e && e.type === 'error');
    assert(errorEvents.length >= 1,
      'creative-fatal: at least one error lifecycle event delivered to extension');
    if (errorEvents.length >= 1) {
      const e = errorEvents[0];
      assert(e.errorCode === 9001,
        'creative-fatal: errorCode field present and matches');
      assert(e.errorMessage === 'simulated creative fatal',
        'creative-fatal: errorMessage field present and matches (NOT `message`)');
      assert(e.source === 'creative',
        'creative-fatal: source === "creative" discriminator');
      assert(e.type === 'error',
        'creative-fatal: type === "error"');
      assert(e.container === c,
        'creative-fatal: container reference is the originating container');
      assert(typeof e.timestamp === 'number',
        'creative-fatal: timestamp field is a number');
      // Audit guard against the "two field names" alternative explicitly
      // ruled out in the 0.7.4 ADR. The canonical contract is
      // `errorMessage` only — `message` is not a synonym, not even one
      // that aliases the same value. If a future refactor adds `message`
      // back (even as an alias), this assertion fires.
      assert(!('message' in e),
        'creative-fatal: `message` field is forbidden (canonical: errorMessage only)');
    }

    // Stability pin: errorMessage MUST normalize to '' when the creative
    // omits it. Implementation at src/sharc-container.js:3411 does
    // `errorMessage: errorMessage || ''`; this assertion guards consumers
    // that rely on `.length` / string ops without an undefined check.
    c._handleCreativeFatalError({ args: { errorCode: 9002 } });
    const omittedMsgEvents = captured.filter(
      (e) => e && e.type === 'error' && e.errorCode === 9002,
    );
    assert(omittedMsgEvents.length >= 1,
      'creative-fatal (no errorMessage): error event still fires');
    if (omittedMsgEvents.length >= 1) {
      assert(omittedMsgEvents[0].errorMessage === '',
        'creative-fatal (no errorMessage): errorMessage normalizes to "" (not undefined)');
    }
  }

  // ── Sub-test 2: container-fatal-error path ─────────────────────────────
  {
    captured.length = 0;
    const c = new SHARCContainer(markupOptions({
      extensions: [captureExtension],
    }));
    c._iframe = document.createElement('iframe');
    c._protocol.sendStateChange = () => {};
    // Stub sendFatalError to avoid protocol-side noise.
    c._protocol.sendFatalError = () => Promise.resolve();

    c._handleFatalError(2117, 'simulated container fatal');

    const errorEvents = captured.filter((e) => e && e.type === 'error');
    assert(errorEvents.length >= 1,
      'container-fatal: at least one error lifecycle event delivered to extension');
    if (errorEvents.length >= 1) {
      const e = errorEvents[0];
      assert(e.errorCode === 2117,
        'container-fatal: errorCode field present and matches');
      assert(e.errorMessage === 'simulated container fatal',
        'container-fatal: errorMessage field present and matches (NOT `message`)');
      assert(e.source === 'container',
        'container-fatal: source === "container" discriminator');
      // Audit guard against the "two field names" alternative explicitly
      // ruled out in the 0.7.4 ADR. The canonical contract is
      // `errorMessage` only — `message` is not a synonym, not even one
      // that aliases the same value. The earlier `|| e.message === e.errorMessage`
      // tolerance was wrong: the ADR forbids the field outright.
      assert(!('message' in e),
        'container-fatal: `message` field is forbidden (canonical: errorMessage only)');
    }
  }

  // ── Sub-test 3: payload-shape stability across both error paths ────────
  {
    captured.length = 0;
    const c = new SHARCContainer(markupOptions({
      extensions: [captureExtension],
    }));
    c._iframe = document.createElement('iframe');
    c._protocol.sendStateChange = () => {};
    c._protocol.sendFatalError = () => Promise.resolve();

    c._handleCreativeFatalError({ args: { errorCode: 1001, errorMessage: 'creative' } });
    c._handleFatalError(2002, 'container');

    const errors = captured.filter((e) => e && e.type === 'error');
    assert(errors.length >= 2,
      'two errors fire — one per path');
    // Required field set across BOTH error events. Includes `state` because
    // the base-event shape promises it on every dispatch (see api-reference.md
    // §9 "Lifecycle event payloads"). `timestamp` is asserted separately by
    // subtests 1 and 2; `container` covers the same base-shape promise here.
    const required = ['container', 'errorCode', 'errorMessage', 'source', 'state', 'type'];
    for (let i = 0; i < errors.length; i++) {
      for (const field of required) {
        assert(field in errors[i],
          `payload-stability event[${i}]: required field "${field}" present`);
      }
    }
  }

  // ── Sub-test 4: OmidCompatBridge as the consumer — finishes session on
  //    error event regardless of which path fired the error. This is the
  //    in-tree extension that exercises the contract today.
  {
    const mock = createMockOmidSdk();
    installMockSdk(mock);
    try {
      const bridge = new OmidCompatBridge({
        omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
        omSdkSessionClientUrl: 'https://omid.example/omid-session-client-v1.js',
      });
      const c = createContainerWithOmid(bridge);
      c.setState('ready');
      c._notifyExtensionsLifecycle('stateChange', { newState: 'ready', previousState: 'loading' });
      c.setState('active');
      c._notifyExtensionsLifecycle('stateChange', { newState: 'active', previousState: 'ready' });

      // Container-fatal path → OmidCompatBridge should finish session.
      c._protocol.sendFatalError = () => Promise.resolve();
      c._handleFatalError(2117, 'renderer protocol error');
      assert(mock.stats.finishCalls >= 1,
        'container-fatal: OmidCompatBridge receives error event AND finishes AdSession');
      assert(bridge._omid.sessionFinished === true,
        'container-fatal: OmidCompatBridge sessionFinished flag set');
    } finally {
      uninstallMockSdk();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════════════════════════════
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} omid-container-lifecycle assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All omid-container-lifecycle assertions passed.');
}
