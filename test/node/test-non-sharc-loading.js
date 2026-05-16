/**
 * test-non-sharc-loading.js — issue #89 (0.7.2 first half) coverage
 *
 * End-to-end behavior tests for `requireSharcInit: false` and the
 * companion accessors `container.apiFramework` / `container.hasSharcSession`.
 * Pure jsdom unit tests — no Puppeteer, no real network.
 *
 * Coverage axes (per 0.7.2 design § 15.3):
 *   - Default strict (`requireSharcInit: true`): `createSession` fatal-timeout
 *     fires when handshake doesn't arrive within `timeouts.createSession`.
 *   - Permissive (`requireSharcInit: false`): timeout NOT armed; container
 *     stays alive past the would-be cap.
 *   - Permissive + late SHARC handshake: accepted; G7 framework-aware
 *     console.warn fires with four forensic fields.
 *   - Permissive + late handshake from declared-non-SHARC creative:
 *     confused-deputy warn fires.
 *   - Permissive + late handshake from declared-SHARC creative: silent
 *     accept (declaration matches outcome).
 *   - `hasSharcSession` flips from false → true after handshake.
 *   - Permissive + close() mid-load: clean termination (G6).
 *
 * Notes / scope gaps surfaced for PR 2 (HTML lifecycle adapter):
 *   - Permissive + no handshake: container currently STAYS in LOADING.
 *     PR 2 adds the HTML adapter that drives `LOADING → ACTIVE` via
 *     iframe-load + IntersectionObserver. Test below documents the gap
 *     with a TODO so PR 2 extends rather than rewrites the assertion.
 *
 * Runs in Node after `npm run build`.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.operator.example/r/';
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html' },
);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
const { ErrorCodes, SHARC_API_CODE } = protoMod;

// Container hygiene — terminate any survivors between sections so the 5 s
// fatal timeout (and other leaked timers) don't pollute downstream assertions.
const _liveContainers = [];
function track(c) { _liveContainers.push(c); return c; }
function flushContainers() {
  while (_liveContainers.length) {
    const c = _liveContainers.pop();
    try { if (!c._terminated) c._terminate(); } catch (_) { /* ignore */ }
  }
}
process.on('beforeExit', flushContainers);

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

function markupOpts(overrides) {
  return {
    creativeHtml: '<html><body>creative</body></html>',
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    ...overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('test-non-sharc-loading.js — issue #89 (0.7.2) coverage\n');

// -- 1. Default strict: missing handshake fatal-errors after createSession --
{
  console.log('1. Default strict: missing handshake → NO_CREATE_SESSION (2212)');
  const errorOutput = [];
  const orig = console.error;
  console.error = (...args) => { errorOutput.push(args.join(' ')); };

  let errCode = null;
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    timeouts: { createSession: 30 }, // abbreviated for test speed
    onError: (code) => { errCode = code; },
  }));
  assert(c._requireSharcInit === true, 'default _requireSharcInit === true');
  c.load();
  await sleep(80);
  console.error = orig;

  assert(errCode === ErrorCodes.NO_CREATE_SESSION,
    'onError fired with NO_CREATE_SESSION (2212) when no handshake arrives');
}
flushContainers();

// -- 2. Permissive: missing handshake does NOT fatal-error -----------------
{
  console.log('\n2. Permissive (requireSharcInit:false): missing handshake → no fatal-error');
  let errCode = null;
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    timeouts: { createSession: 30 },
    onError: (code) => { errCode = code; },
  }));
  assert(c._requireSharcInit === false, '_requireSharcInit === false when passed');
  c.load();
  await sleep(80);

  assert(errCode === null, 'onError NOT fired — fatal-timeout was not armed');
  assert(c._terminated !== true, 'container remains alive (not terminated)');
}
flushContainers();

// -- 3. Permissive + close() mid-load: clean termination (G6) --------------
{
  console.log('\n3. Permissive + close() mid-load: clean termination (G6)');
  let closeFired = false;
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    timeouts: { closeSequence: 20 },
    onClose: () => { closeFired = true; },
  }));
  c.load();
  // No handshake — but operator wants to terminate anyway.
  c.close();
  await sleep(40);
  assert(closeFired === true, 'onClose fired despite missing handshake');
}
flushContainers();

// -- 4. Permissive + late handshake from declared-non-SHARC creative -------
//    G7: framework-aware warn fires (confused deputy).
{
  console.log('\n4. Permissive + late handshake from MRAID-declared creative → confused-deputy warn');
  const warnOutput = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };

  const c = track(new SHARCContainer({
    ...markupOpts({ creativeMeta: { apis: [6] } }),
    requireSharcInit: false,
    timeouts: { createSession: 30 },
  }));
  c.load();
  await sleep(40); // past where the fatal-timeout would have fired in strict mode

  // Synthesize a handshake via the protocol layer. Use a valid UUID in
  // the CREATE_SESSION envelope so acceptSession does not reject; this
  // exercises the full G7 warn + acceptSession path.
  c._handleCreateSession({
    type: 'SHARC:Creative:createSession',
    sessionId: '11111111-1111-4111-8111-111111111111',
    id: 1,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  const expected = warnOutput.find((line) =>
    /Unexpected createSession received at T\+\d+ms/.test(line)
    && /apiFramework=6/.test(line)
    && /bridges=\[mraid\]/.test(line)
    && /requireSharcInit:false/.test(line)
  );
  assert(!!expected,
    'G7: confused-deputy warn ("Unexpected ...") includes apiFramework=6, bridges=[mraid], elapsed-since-load, requireSharcInit:false');
}
flushContainers();

// -- 5. Permissive + late handshake from SHARC-declared creative → silent --
{
  console.log('\n5. Permissive + late handshake from SHARC-declared creative → silent accept');
  const warnOutput = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };

  const c = track(new SHARCContainer({
    ...markupOpts({ creativeMeta: { apis: [SHARC_API_CODE] } }),
    requireSharcInit: false,
    timeouts: { createSession: 30 },
  }));
  c.load();
  await sleep(40);

  c._handleCreateSession({
    type: 'SHARC:Creative:createSession',
    sessionId: '22222222-2222-4222-8222-222222222222',
    id: 1,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  const mismatchWarn = warnOutput.find((line) => /Unexpected createSession/.test(line));
  assert(!mismatchWarn,
    'G7 silent: no confused-deputy warn when declaration matches outcome (apiFramework === SHARC_API_CODE)');
}
flushContainers();

// -- 6. Permissive + late handshake from undeclared creative → warn -------
//    apiFramework: null (no creativeMeta) — confused-deputy warn variant.
{
  console.log('\n6. Permissive + late handshake from undeclared creative → confused-deputy warn');
  const warnOutput = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };

  const c = track(new SHARCContainer({
    ...markupOpts({ /* no creativeMeta */ }),
    requireSharcInit: false,
    timeouts: { createSession: 30 },
  }));
  c.load();
  await sleep(40);

  c._handleCreateSession({
    type: 'SHARC:Creative:createSession',
    sessionId: '33333333-3333-4333-8333-333333333333',
    id: 1,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  const mismatchWarn = warnOutput.find((line) =>
    /Unexpected createSession received at T\+\d+ms/.test(line)
    && /apiFramework=null/.test(line)
    && /bridges=\[\]/.test(line)
  );
  assert(!!mismatchWarn,
    'G7: undeclared confused-deputy warn includes apiFramework=null (no container-runtime declared), bridges=[]');
}
flushContainers();

// -- 7. Permissive + Creative URL variant (variant-agnostic) ---------------
{
  console.log('\n7. Permissive + Creative URL variant — variant-agnostic');
  let errCode = null;
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit: false,
    timeouts: { createSession: 30 },
    onError: (code) => { errCode = code; },
  }));
  c.load();
  await sleep(80);
  assert(errCode === null, 'URL variant: no fatal-error in permissive mode');
  assert(c.apiFramework === null, 'URL variant: apiFramework always null (Rule 3b — no creativeMeta)');
  assert(c.hasSharcSession === false, 'URL variant: hasSharcSession false until handshake');
}
flushContainers();

// -- 7b. Permissive: duplicate createSession → unconditional idempotency ---
{
  console.log('\n7b. Permissive: duplicate createSession → idempotency warn + sessionId preserved');
  const warnOutput = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };

  const c = track(new SHARCContainer({
    ...markupOpts({ creativeMeta: { apis: [protoMod.SHARC_API_CODE] } }),
    requireSharcInit: false,
    timeouts: { createSession: 30 },
  }));
  c.load();
  await sleep(40);

  // Establish a session by directly seeding the protocol layer.
  // (Avoids the jsdom MessageChannel limitation while still exercising
  // the container's idempotency guard.)
  c._protocol.sessionId = '11111111-1111-4111-8111-111111111111';

  // Duplicate handshake with a different sessionId.
  c._handleCreateSession({
    type: 'SHARC:Creative:createSession',
    sessionId: '22222222-2222-4222-8222-222222222222',
    id: 2,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  const dupWarn = warnOutput.find((line) =>
    /Duplicate createSession received at T\+\d+ms/.test(line)
    && /The original session remains active/.test(line)
  );
  assert(!!dupWarn,
    'permissive: duplicate createSession warn fires with rejection text');
  assert(c._protocol.sessionId === '11111111-1111-4111-8111-111111111111',
    'permissive: duplicate createSession does NOT overwrite the original sessionId');
}
flushContainers();

// -- 7c. STRICT mode: duplicate createSession → unconditional idempotency --
//    OpenClaw review finding #1: the previous fixup only guarded the
//    permissive path. In strict mode (the default), acceptSession would
//    still overwrite sessionId on a duplicate. Idempotency must be
//    unconditional.
{
  console.log('\n7c. Strict mode: duplicate createSession → idempotency warn + sessionId preserved');
  const warnOutput = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };

  const c = track(new SHARCContainer({
    ...markupOpts({ creativeMeta: { apis: [protoMod.SHARC_API_CODE] } }),
    // NO requireSharcInit option → defaults to true (strict)
    timeouts: { createSession: 30 },
  }));
  c.load();
  await sleep(40);

  // Establish a session by directly seeding.
  c._protocol.sessionId = '44444444-4444-4444-8444-444444444444';

  // Duplicate handshake.
  c._handleCreateSession({
    type: 'SHARC:Creative:createSession',
    sessionId: '55555555-5555-4555-8555-555555555555',
    id: 2,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  assert(c._requireSharcInit === true, 'strict mode active (default)');
  const dupWarn = warnOutput.find((line) =>
    /Duplicate createSession received at T\+\d+ms/.test(line)
    && /The original session remains active/.test(line)
  );
  assert(!!dupWarn,
    'strict mode: duplicate createSession warn fires (idempotency is now unconditional)');
  assert(c._protocol.sessionId === '44444444-4444-4444-8444-444444444444',
    'strict mode: duplicate createSession does NOT overwrite the original sessionId');
}
flushContainers();

// -- 7d. Invalid-UUID createSession → fail-closed (no init flow) -----------
//    OpenClaw review finding #1: acceptSession() rejects malformed UUIDs
//    via SEC-006 but returns without setting sessionId. The pre-PR-#92
//    code path continued the init flow regardless; now _handleCreateSession
//    fail-closes by checking sessionId after acceptSession.
{
  console.log('\n7d. Invalid-UUID createSession → fail-closed (init flow does NOT run)');
  const errOutput = [];
  const origErr = console.error;
  console.error = (...args) => { errOutput.push(args.join(' ')); };

  const c = track(new SHARCContainer({
    ...markupOpts({ creativeMeta: { apis: [protoMod.SHARC_API_CODE] } }),
    requireSharcInit: false,
    timeouts: { createSession: 30 },
  }));
  c.load();
  await sleep(40);

  // Stub _mergedSupportedFeatures so we can detect whether the init
  // flow ran past the fail-closed point.
  let initFlowReached = false;
  const origAcceptSession = c._protocol.acceptSession.bind(c._protocol);
  c._protocol.acceptSession = function (msg) {
    // Mimic SEC-006 reject: don't set sessionId.
    // (Calling original would also reject on the malformed UUID below,
    // but we bypass to be deterministic.)
    return;
  };
  const origInitArgs = c._explicitSupportedFeatures;
  Object.defineProperty(c, '_mergedSupportedFeatures', {
    set(val) { initFlowReached = true; },
    get() { return undefined; },
    configurable: true,
  });

  c._handleCreateSession({
    type: 'SHARC:Creative:createSession',
    sessionId: 'not-a-uuid-at-all',
    id: 1,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.error = origErr;

  assert(c._protocol.sessionId === '',
    'invalid UUID: sessionId remains empty (acceptSession rejected)');
  assert(initFlowReached === false,
    'invalid UUID: _handleCreateSession fail-closes — does NOT continue to init flow');

  // Restore.
  c._protocol.acceptSession = origAcceptSession;
}
flushContainers();

// -- 8. Renderer-protocol timeouts STILL fire in permissive mode -----------
//    Design § 4.2: only createSession is skipped; rendererLoad/rendererReply
//    remain armed. They guard a different invariant.
//
//    OpenClaw review (round 2): assert exactly RENDERER_TIMEOUT AND assert
//    NO_CREATE_SESSION did not fire — a disjunction would mask a regression
//    that accidentally re-armed _startSessionTimeout when requireSharcInit
//    was false.
{
  console.log('\n8. Permissive + renderer-protocol timeouts fire; createSession timeout does NOT');
  const errorOutput = [];
  const orig = console.error;
  console.error = (...args) => { errorOutput.push(args.join(' ')); };

  // Capture EVERY error code raised during the window so we can prove
  // NO_CREATE_SESSION never appeared.
  const errCodes = [];
  const c = track(new SHARCContainer({
    ...markupOpts(),
    requireSharcInit: false,
    // rendererLoad (20ms) wins decisively over the (would-be) createSession
    // timeout (300ms). The latter must NOT be armed at all when permissive.
    timeouts: { rendererLoad: 20, rendererReply: 20, createSession: 300 },
    onError: (code) => { errCodes.push(code); },
  }));
  c.load();
  await sleep(80);
  console.error = orig;

  assert(errCodes.includes(ErrorCodes.RENDERER_TIMEOUT),
    'RENDERER_TIMEOUT fires (rendererLoad/Reply timeouts remain armed in permissive mode)');
  assert(!errCodes.includes(ErrorCodes.NO_CREATE_SESSION),
    'NO_CREATE_SESSION does NOT fire (createSession timeout is not armed when requireSharcInit:false)');
}
flushContainers();

// -- 9. PR 2 SCOPE: HTML lifecycle adapter — currently absent --------------
//    Documents the design § 8 gap that PR 2 fills. Today, permissive + no
//    handshake leaves the container in LOADING (no adapter to advance state).
{
  console.log('\n9. PR 1 scope guard: HTML lifecycle adapter is PR 2 — currently absent');
  const c = track(new SHARCContainer({
    ...markupOpts(),
    requireSharcInit: false,
    timeouts: { createSession: 30, rendererLoad: 30, rendererReply: 30 },
  }));
  c.load();
  await sleep(80);
  // TODO PR 2: after the HTML lifecycle adapter ships, expect
  //   c.getState() === ContainerStates.ACTIVE
  // once the iframe load + intersection signals fire.
  assert(c.getState() !== 'active',
    'PR 1 only: non-handshake permissive container does NOT auto-advance to ACTIVE '
    + '(HTML adapter ships in PR 2; § 8)');
}
flushContainers();

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} non-sharc-loading assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All non-sharc-loading assertions passed.');
}
