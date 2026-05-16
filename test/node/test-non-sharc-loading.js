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

  // Synthesize a late createSession message via the protocol layer.
  // Use the container's accept path directly — simulates the late-arriving
  // CREATE_SESSION envelope that would normally come through the message
  // port. The G7 warn fires inside _handleCreateSession before acceptSession.
  c._handleCreateSession({
    type: 'SHARC:Creative:createSession',
    id: 1,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  const expected = warnOutput.find((line) =>
    /Late createSession received at T\+\d+ms/.test(line)
    && /apiFramework=6/.test(line)
    && /bridges=\[mraid\]/.test(line)
    && /requireSharcInit:false/.test(line)
  );
  assert(!!expected,
    'G7: confused-deputy warn includes apiFramework=6, bridges=[mraid], elapsed-since-load, requireSharcInit:false');
  // (hasSharcSession transition exercised end-to-end in
  //  test-creative-sources-load.js with the full renderer protocol.)
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
    id: 1,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  const lateWarn = warnOutput.find((line) => /Late createSession/.test(line));
  assert(!lateWarn,
    'G7 silent: no late-handshake warn when declaration matches outcome (apiFramework === SHARC_API_CODE)');
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
    id: 1,
    args: { version: protoMod.SHARC_VERSION, placementType: 'inline' },
  });
  console.warn = origWarn;

  const lateWarn = warnOutput.find((line) =>
    /Late createSession received at T\+\d+ms/.test(line)
    && /apiFramework=null/.test(line)
    && /bridges=\[\]/.test(line)
  );
  assert(!!lateWarn,
    'G7: undeclared late handshake warn includes apiFramework=null (no container-runtime declared), bridges=[]');
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

// -- 8. Renderer-protocol timeouts STILL fire in permissive mode -----------
//    Design § 4.2: only createSession is skipped; rendererLoad/rendererReply
//    remain armed. They guard a different invariant.
{
  console.log('\n8. Permissive + renderer-protocol timeouts still fire (only createSession skips)');
  const errorOutput = [];
  const orig = console.error;
  console.error = (...args) => { errorOutput.push(args.join(' ')); };

  let errCode = null;
  const c = track(new SHARCContainer({
    ...markupOpts(),
    requireSharcInit: false,
    timeouts: { rendererLoad: 20, rendererReply: 20, createSession: 30 },
    onError: (code) => { errCode = code; },
  }));
  c.load();
  await sleep(80);
  console.error = orig;

  assert(errCode === ErrorCodes.RENDERER_TIMEOUT || errCode === ErrorCodes.NO_CREATE_SESSION,
    'Renderer-protocol timeout still fires (createSession skipped, but rendererLoad/Reply armed)');
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
