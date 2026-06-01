/**
 * test-creative-sources-load.js — issue #41 Phase B+C regression coverage
 *
 * Load-path tests for the Creative Markup variant. Phase B scope:
 *   1. Renderer-iframe build — sandbox tokens, csp, allow, referrerpolicy.
 *   2. CSPRNG fragment-nonce URL assembly + `_assertResolvedIframeSrcAllowed`
 *      runtime guard (issue #65).
 *   3. Synchronous injection of `creativeHtml` via extension `injectIntoMarkup`
 *      hooks (regardless of `useMarkupInjection`).
 *   4. SHARC:Renderer:render postMessage shape + targetOrigin.
 *   5. SHARC:Renderer:rendered envelope validation (source / origin /
 *      placementSessionId) + standard 200ms-delay → initChannel bootstrap.
 *   6. RENDERER_TIMEOUT (2114) on iframe-load and rendered-reply timeouts.
 *
 * Phase C scope (sections 11/12/13):
 *  11. SHARC:Renderer:failed receipt → RENDERER_FAILED (2115).
 *  12. Post-load origin echo on :rendered → RENDERER_ORIGIN_MISMATCH (2116);
 *      malformed-payload validation on both :rendered and :failed →
 *      RENDERER_PROTOCOL_ERROR (2117).
 *  13. close() mid-render cleanup contract — timeouts, listener detach, iframe
 *      removal, placement restoration, late-message silent-ignore.
 *
 * Phase D scope (sections 14/15/16/17):
 *  14. Load-event navigation backstop after envelope-validated `:rendered` →
 *      RENDERER_UNAUTHORIZED_NAVIGATION (2118).
 *  15. Structured `onSecurityEvent` emission across all chokepoint paths,
 *      ordered before `onError`, with discriminated-union `details` payloads
 *      (closes #62). Internal-type → spec-type mapping for the structured
 *      channel (timeout/post-failed → `renderer_protocol_error`).
 *  16. `placementSessionId` prefix in `console.error` and `console.warn`
 *      output across the chokepoint and the wrapper carve-out (Compliance
 *      Auditor F1, Phase D).
 *  17. `onSecurityEvent` error-handling contract: throwing callback is
 *      caught, container action proceeds, console.error emitted (spec
 *      § Security Model line 729). Re-entrancy guard: `_terminated` blocks
 *      a second emission.
 *
 * Phase E scope (section 18):
 *  18. Creative URL variant — load-event navigation backstop after the
 *      first (and only-expected) iframe `load` event →
 *      RENDERER_UNAUTHORIZED_NAVIGATION (2118) with `details.variant === 'url'`.
 *      Parallels section 14 (Markup variant). Closes [#70].
 *
 * Uses jsdom (no browser harness) — mirrors the test-creative-sources.js
 * pattern. Stubs `iframe.contentWindow.postMessage` to capture the render
 * message and dispatches synthetic `MessageEvent`s on `window` to simulate
 * the renderer's `:rendered` / `:failed` replies.
 *
 * Runs in Node after `npm run build`.
 */

import { JSDOM } from 'jsdom';

// ── DOM globals BEFORE importing SHARCContainer. ──────────────────────────
const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.operator.example/0.7.0/';
const RENDERER_ORIGIN = 'https://renderer.operator.example';
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
// crypto.randomUUID is required by Phase B's CSPRNG nonce. Node 19+ exposes
// it as a global; fall back to webcrypto on Node 18.
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

// Pre-load protocol exports onto window.SHARC.Protocol (matches Phase A test).
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer, SHARC_BUILD_MODE } = await import('../../dist/sharc-container.mjs');
const { ErrorCodes, SHARC_VERSION, RENDERER_PROTOCOL_VERSION, ContainerStates } = protoMod;

// ── Build-mode guard ──────────────────────────────────────────────────────
// Prod builds use terser `drop_console: true` which strips every
// `console.error`. Several Phase C log-assertion tests would vacuously pass
// against the prod bundle because `errorOutput.some(...)` returns false on an
// empty array, and a few negative-shape assertions (`!/X/.test('')`) would
// silently pass. Fail fast with a clear message instead.
{
  if (SHARC_BUILD_MODE !== 'dev') {
    console.error(
      'FATAL: dist/sharc-container.mjs build mode is '
      + JSON.stringify(SHARC_BUILD_MODE) + '. Phase C log '
      + 'assertions would vacuously pass. Re-run `npm run build` (dev mode) '
      + 'and try again.'
    );
    process.exit(1);
  }
}

// ── Cross-test timer hygiene ──────────────────────────────────────────────
// Track every SHARCContainer the test file creates so we can flush leaked
// timers between sections. Without this, the 1s `_handleFatalError` force-
// terminate and the 5s `createSession` timeout leak across blocks and
// occasionally pollute downstream `errorOutput.some(...)` assertions when
// their console.error lands during a silenced window. Test Results Analyzer
// depth-pass observed ~5% flake rate without this hygiene.
const _liveContainers = [];
function track(c) { _liveContainers.push(c); return c; }
function flushContainers() {
  while (_liveContainers.length) {
    const c = _liveContainers.pop();
    try { if (!c._terminated) c._terminate(); } catch (_) { /* ignore */ }
  }
}
process.on('beforeExit', flushContainers);

// ── Tiny assertion harness ────────────────────────────────────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}
function assertThrows(fn, msgPattern, message) {
  try {
    fn();
    console.error('  ✗', message, '(no throw)');
    failures++;
  } catch (e) {
    if (msgPattern && !String(e.message).match(msgPattern)) {
      console.error('  ✗', message, `(threw, wrong message: ${e.message})`);
      failures++;
      return;
    }
    console.log('  ✓', message);
  }
}
// Deterministic poll for an async condition. Replaces fixed setTimeout waits
// that race the crypto.subtle.digest-gated integrity preflight: the digest can
// resolve later than a fixed delay under event-loop load (the full
// test:all:built chain), so wait on the observable signal instead of a clock.
// Throws on timeout so a genuine regression surfaces loudly rather than hanging.
async function waitFor(predicate, { timeout = 2000, interval = 2, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (true) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeout}ms waiting for ${message}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────
function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}
const CREATIVE_HTML = '<html><body>creative goes here</body></html>';
function markupOptions(overrides) {
  return {
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    ...overrides,
  };
}
async function sha384Sri(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-384', bytes);
  return 'sha384-' + SHARCContainer._base64FromArrayBuffer(digest);
}

/**
 * Builds a Markup container, calls .load(), captures the SHARC:Renderer:render
 * postMessage on the iframe.contentWindow, and (optionally) dispatches a
 * synthetic SHARC:Renderer:rendered reply on window. Returns helpers and the
 * captured state for assertions.
 *
 * `respond: false` skips the rendered reply so callers can probe timeout
 * behavior. `tweakRendered` mutates the rendered payload before dispatch
 * (used to probe envelope-mismatch silent-ignore behavior).
 */
async function buildAndLoad(options = {}, opts = {}) {
  const {
    respond = true,
    rendererOrigin = RENDERER_ORIGIN,
    tweakRendered = null,
    timeouts = { rendererLoad: 50, rendererReply: 50 },
  } = opts;

  const container = track(new SHARCContainer({ ...markupOptions(options), timeouts }));
  container.load();
  await container.protocolRouter.ready('SHARC:Renderer:');
  // 0.7.7 (RTR-D10): the Markup-variant load path defers iframe.src
  // assignment behind `protocolRouter.ready('SHARC:Renderer:')`. Await it
  // here so the iframe `load` listener is attached before we dispatch the
  // synthetic load event below.
  await container.protocolRouter.ready('SHARC:Renderer:');
  const iframe = container._iframe;

  // Stub postMessage on the iframe.contentWindow so we can capture the
  // SHARC:Renderer:render payload + targetOrigin without a real cross-origin
  // postMessage round-trip.
  const captured = { posts: [] };
  // jsdom gives us a contentWindow; replace its postMessage with a spy.
  const cw = iframe.contentWindow;
  cw.postMessage = (data, targetOrigin) => {
    captured.posts.push({ data, targetOrigin });
  };

  // Manually fire the iframe 'load' event — jsdom won't actually navigate
  // the iframe to the cross-origin renderer URL, but our load handler is
  // registered and `iframe.contentWindow` is non-null, which is all the
  // protocol path needs.
  iframe.dispatchEvent(new dom.window.Event('load'));

  if (respond) {
    // Default rendered reply payload — pass envelope checks.
    // 0.7.7: the router gate requires `sharcNonce` to equal the renderer-
    // protocol-derived nonce that the container exposed via `onReady`.
    let payload = {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: container.placementSessionId,
      sharcNonce: container._rendererProtocolNonce,
      rendererOrigin: rendererOrigin,
    };
    if (typeof tweakRendered === 'function') payload = tweakRendered(payload);
    // Use MessageEvent so event.source / event.origin are settable.
    const evt = new dom.window.MessageEvent('message', {
      data: payload,
      origin: rendererOrigin,
      source: cw,
    });
    window.dispatchEvent(evt);
  }

  return { container, iframe, captured };
}

console.log('test-creative-sources-load.js — issue #41 Phase B+C regression\n');

// -- 1. Renderer iframe attributes — sandbox / csp / allow / referrerpolicy
{
  console.log('1. Renderer iframe attributes — sandbox + csp + allow + referrerpolicy');
  const { iframe } = await buildAndLoad();

  // 1a — sandbox: SafeFrame-baseline tokens with conditionals defaulting on
  // for click-through-or-measurement; off for UX-disruption surfaces.
  const sandbox = iframe.getAttribute('sandbox');
  assert(typeof sandbox === 'string' && sandbox.length > 0,
    'sandbox attribute is set');
  assert(sandbox.includes('allow-scripts'),
    'sandbox includes allow-scripts (always present)');
  assert(sandbox.includes('allow-same-origin'),
    'sandbox includes allow-same-origin (Markup variant — required for renderer origin)');
  assert(sandbox.includes('allow-forms'),
    'sandbox includes allow-forms (always present)');
  assert(sandbox.includes('allow-popups'),
    'sandbox includes allow-popups (allowPopups defaults true)');
  assert(sandbox.includes('allow-popups-to-escape-sandbox'),
    'sandbox includes allow-popups-to-escape-sandbox (bound to allowPopups, DD-21)');
  assert(sandbox.includes('allow-top-navigation-by-user-activation'),
    'sandbox includes allow-top-navigation-by-user-activation (DD-20 default)');
  assert(sandbox.includes('allow-storage-access-by-user-activation'),
    'sandbox includes allow-storage-access-by-user-activation (DD-22 default)');
  assert(!sandbox.includes('allow-modals'),
    'sandbox EXCLUDES allow-modals (DD-23 default off)');
  assert(!sandbox.includes('allow-downloads'),
    'sandbox EXCLUDES allow-downloads (DD-25 default off)');
  // The unsafe no-gesture top-nav token must NEVER appear, regardless of options.
  assert(!/\ballow-top-navigation\b(?!-by-)/.test(sandbox),
    'sandbox NEVER includes the unsafe `allow-top-navigation` token');

  // 1b — csp attribute: object-src + base-uri none (Chromium-only DiD).
  const csp = iframe.getAttribute('csp');
  assert(csp === "object-src 'none'; base-uri 'none'",
    'csp attribute exactly matches the proposal baseline (object-src + base-uri none)');

  // 1c — Permissions Policy `allow` deny-list.
  const allow = iframe.getAttribute('allow');
  for (const denied of [
    'geolocation', 'camera', 'microphone', 'payment', 'usb', 'serial',
    'clipboard-write', 'screen-wake-lock', 'accelerometer', 'gyroscope',
    'magnetometer', 'web-share', 'idle-detection', 'xr-spatial-tracking',
    'identity-credentials-get',
  ]) {
    assert(allow.includes(denied + " 'none'"),
      `allow Permissions Policy denies ${denied}`);
  }
  // DD-24: ad-tech features deliberately NOT denied.
  for (const adTechFeature of [
    'private-state-token-issuance', 'private-state-token-redemption',
    'browsing-topics', 'attribution-reporting', 'shared-storage',
  ]) {
    assert(!allow.includes(adTechFeature),
      `allow Permissions Policy does NOT deny ${adTechFeature} (DD-24)`);
  }

  // 1d — referrerpolicy.
  assert(iframe.getAttribute('referrerpolicy') === 'no-referrer',
    'referrerpolicy is no-referrer (prevents publisher URL leak to renderer)');

  // 1e — DOM stamping: data-sharc-creative-source + data-sharc-creative-rendered
  // per spec § DOM stamping additions. Both attributes are always present.
  // Markup variant: source='html'; rendered='false' at attach time, flips
  // to 'true' on envelope-valid :rendered.
  {
    const { container, iframe: f } = await buildAndLoad({}, { respond: false });
    assert(f.getAttribute('data-sharc-creative-source') === 'html',
      'Markup: iframe stamped with data-sharc-creative-source="html" at attach time');
    assert(f.getAttribute('data-sharc-creative-rendered') === 'false',
      'Markup: iframe stamped with data-sharc-creative-rendered="false" before :rendered');
    // Drive a happy-path :rendered.
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: f.contentWindow,
    });
    window.dispatchEvent(evt);
    assert(container.creativeRendered === true,
      'Markup: :rendered flips creativeRendered=true (sanity)');
    assert(f.getAttribute('data-sharc-creative-rendered') === 'true',
      'Markup: iframe data-sharc-creative-rendered flips to "true" on envelope-valid :rendered');
  }
  flushContainers();

  // 1f — 0.7.2: new accessors visible alongside existing diagnostic surface.
  // `apiFramework` reflects the picker result; `hasSharcSession` stays
  // `false` until the createSession handshake completes (jsdom's
  // MessageChannel doesn't connect, so the post-:rendered handshake doesn't
  // complete here — full hasSharcSession=true exercise lives in real-browser
  // integration). See 0.7.2 design § 15.7.
  {
    const { container } = await buildAndLoad({ creativeMeta: { apis: [6] } }, { respond: false });
    assert(container.apiFramework === 6,
      '0.7.2 regression: container.apiFramework reflects creativeMeta.apis picker result (MRAID 3.0 → 6)');
    assert(container.hasSharcSession === false,
      '0.7.2 regression: container.hasSharcSession is false before handshake completes');
    assert(container._requireSharcInit === true,
      '0.7.2 regression: container._requireSharcInit defaults to true (strict path)');
  }
  flushContainers();
}

// -- 2. Conditional sandbox tokens — overrides flow through to the attribute
{
  console.log('\n2. Conditional sandbox tokens — overrides flow through');

  // allowPopups: false → both popup tokens absent.
  const a = (await buildAndLoad({ allowPopups: false })).iframe.getAttribute('sandbox');
  assert(!a.includes('allow-popups'),
    'allowPopups: false strips `allow-popups`');
  assert(!a.includes('allow-popups-to-escape-sandbox'),
    'allowPopups: false also strips `allow-popups-to-escape-sandbox` (bound by DD-21)');

  // allowTopNavigationByUserActivation: false → token absent.
  const b = (await buildAndLoad({ allowTopNavigationByUserActivation: false })).iframe.getAttribute('sandbox');
  assert(!b.includes('allow-top-navigation-by-user-activation'),
    'allowTopNavigationByUserActivation: false strips token');

  // allowStorageAccessByUserActivation: false → token absent.
  const c = (await buildAndLoad({ allowStorageAccessByUserActivation: false })).iframe.getAttribute('sandbox');
  assert(!c.includes('allow-storage-access-by-user-activation'),
    'allowStorageAccessByUserActivation: false strips token');

  // allowModals: true → token present.
  const d = (await buildAndLoad({ allowModals: true })).iframe.getAttribute('sandbox');
  assert(d.includes('allow-modals'),
    'allowModals: true adds `allow-modals` token');

  // allowDownloads: true → token present.
  const e = (await buildAndLoad({ allowDownloads: true })).iframe.getAttribute('sandbox');
  assert(e.includes('allow-downloads'),
    'allowDownloads: true adds `allow-downloads` token');
  flushContainers();
}

// -- 3. Iframe src — HMAC-derived renderer-protocol nonce (0.7.7)
{
  console.log('\n3. Iframe src — HMAC-derived renderer-protocol nonce (0.7.7)');
  const { container, iframe } = await buildAndLoad();
  const src = iframe.getAttribute('src');
  assert(src.startsWith(RENDERER_URL + '#sharcNonce='),
    'iframe.src is creativeRendererUrl + "#sharcNonce=<derived>"');
  const nonce = src.split('#sharcNonce=')[1];
  // 0.7.7: derived nonce is base64url(HMAC-SHA-256 truncated to 16 bytes) = 22 chars.
  const derivedNoncePattern = /^[A-Za-z0-9_-]{22}$/;
  assert(derivedNoncePattern.test(nonce),
    'fragment nonce is 22-char base64url (HMAC-SHA-256 derived, 128 bits entropy)');
  assert(container._rendererProtocolNonce === nonce,
    'container._rendererProtocolNonce equals the URL fragment nonce (0.7.7 RTR-D3)');
  assert(container._sharcNonce && container._sharcNonce !== nonce,
    'container._sharcNonce (root) is distinct from the wire-level derived nonce (RTR-D13)');
  flushContainers();
}

// -- 4. _resolvedIframeSrc runtime guard (#65) — extension override is rejected
{
  console.log('\n4. _resolvedIframeSrc runtime guard (#65) — extension override aborts load');

  // 4a — URL variant: extension overrides _resolvedIframeSrc to return an
  // attacker-controlled URL. The runtime guard MUST throw before iframe.src
  // assignment, defending the rule-4..7 origin guarantee.
  {
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeUrl: 'https://ads.example/creative.html',
      placementElement: slot,
    }));
    c._resolvedIframeSrc = function () { return 'https://attacker.example/evil.html'; };
    assertThrows(
      () => c.load(),
      /Refusing to load/,
      'URL: extension override of _resolvedIframeSrc aborts load with clear error');
    // No iframe should be navigated to the attacker URL.
    const iframe = c._iframe;
    assert(!iframe || iframe.getAttribute('src') !== 'https://attacker.example/evil.html',
      'URL: iframe.src is NOT assigned the attacker-controlled URL');
  }

  // 4b — Markup variant: extension overrides to return a non-renderer URL.
  // 0.7.7: the Markup load path now defers behind protocolRouter.ready, so the
  // guard fires asynchronously inside the .then() callback. Capture
  // console.warn / onError emissions instead of an assertThrows on load().
  {
    const slot = freshSlot();
    const errs = [];
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      onError: (code, msg) => errs.push({ code, msg }),
    }));
    c._resolvedIframeSrc = function () { return 'https://attacker.example/evil.html'; };
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    // Wait for the deferred derivation + guard to fire.
    await c.protocolRouter.ready('SHARC:Renderer:');
    await new Promise((r) => setTimeout(r, 0));
    const iframe = c._iframe;
    assert(!iframe || iframe.getAttribute('src') !== 'https://attacker.example/evil.html',
      'Markup: iframe.src is NOT assigned the attacker-controlled URL (0.7.7 deferred guard)');
  }

  // 4c — Markup variant: extension overrides to return the renderer URL but
  // with a forged nonce. Guard catches the mismatch.
  {
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
    }));
    c._resolvedIframeSrc = function () {
      // Set the renderer-protocol nonce to a known value, so the "no nonce
      // populated" branch doesn't mask the mismatch. Simulates a sloppy
      // attacker who knows the guard checks _rendererProtocolNonce (0.7.7).
      this._rendererProtocolNonce = 'attacker-controlled-nonce';
      return RENDERER_URL + '#sharcNonce=different-nonce-than-stored';
    };
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    await new Promise((r) => setTimeout(r, 0));
    const iframe = c._iframe;
    assert(!iframe || !/different-nonce-than-stored/.test(iframe.getAttribute('src') || ''),
      'Markup: extension override returning forged nonce mismatch is rejected (0.7.7 deferred guard)');
  }
  flushContainers();
}

// -- 5. Pre-injection of creativeHtml — synchronous, regardless of useMarkupInjection
{
  console.log('\n5. Pre-injection — synchronous, regardless of useMarkupInjection');

  // 5a — No injectors registered: posted creativeHtml is the original.
  {
    const { container, captured } = await buildAndLoad();
    assert(captured.posts.length === 1,
      'exactly one postMessage was fired (SHARC:Renderer:render)');
    assert(captured.posts[0].data.creativeHtml === CREATIVE_HTML,
      'no injectors → creativeHtml passed through unchanged');
    assert(container.creativeInjected === false,
      'creativeInjected stays false when no injector returned a non-empty result');
  }

  // 5b — With injectors: each runs in registration order; final HTML is posted.
  {
    const order = [];
    const ext1 = {
      injectIntoMarkup(html) { order.push('ext1'); return html + '<!-- ext1 -->'; },
    };
    const ext2 = {
      injectIntoMarkup(html) { order.push('ext2'); return html + '<!-- ext2 -->'; },
    };
    const { container, captured } = await buildAndLoad({ extensions: [ext1, ext2] });
    assert(JSON.stringify(order) === JSON.stringify(['ext1', 'ext2']),
      'injectors run in registration order');
    assert(captured.posts[0].data.creativeHtml.endsWith('<!-- ext1 --><!-- ext2 -->'),
      'final injected HTML reflects all injectors');
    assert(container.creativeInjected === true,
      'creativeInjected is true when at least one injector returned a non-empty modification');
  }

  // 5c — Injector throws: container logs warn and continues with prior HTML.
  {
    const ext = {
      injectIntoMarkup() { throw new Error('boom'); },
    };
    const originalWarn = console.warn;
    let warnFired = false;
    console.warn = (...args) => {
      if (args.some((a) => /injectIntoMarkup threw/.test(String(a)))) warnFired = true;
    };
    try {
      const { container, captured } = await buildAndLoad({ extensions: [ext] });
      assert(captured.posts[0].data.creativeHtml === CREATIVE_HTML,
        'throwing injector → original creativeHtml is posted');
      assert(container.creativeInjected === false,
        'throwing injector → creativeInjected stays false');
    } finally {
      console.warn = originalWarn;
    }
    // Console.warn capture is dev-only signalling; permit silent-prod bundles.
    if (warnFired) {
      assert(true, 'console.warn fired for throwing injector (dev bundle)');
    }
  }

  // 5d — Markup variant ignores `useMarkupInjection`: injection runs whether
  // the flag is true or false. (Per proposal § Injection Across Variants.)
  {
    const ext = { injectIntoMarkup(html) { return html + '<!-- forced -->'; } };
    const aOff = await buildAndLoad({ extensions: [ext], useMarkupInjection: false });
    assert(aOff.captured.posts[0].data.creativeHtml.endsWith('<!-- forced -->'),
      'Markup: injection runs even when useMarkupInjection=false');
    const aOn = await buildAndLoad({ extensions: [ext], useMarkupInjection: true });
    assert(aOn.captured.posts[0].data.creativeHtml.endsWith('<!-- forced -->'),
      'Markup: injection runs when useMarkupInjection=true');
  }
  flushContainers();
}

// -- 6. SHARC:Renderer:render postMessage shape + targetOrigin
{
  console.log('\n6. SHARC:Renderer:render postMessage payload + targetOrigin');
  const { container, captured } = await buildAndLoad();
  assert(captured.posts.length === 1, 'exactly one render postMessage was fired');
  const post = captured.posts[0];
  assert(post.targetOrigin === RENDERER_ORIGIN,
    `targetOrigin === construction-time rendererOrigin (${RENDERER_ORIGIN})`);
  const data = post.data;
  assert(data.type === 'SHARC:Renderer:render',
    'render payload type === "SHARC:Renderer:render"');
  assert(typeof data.creativeHtml === 'string',
    'render payload includes creativeHtml');
  assert(data.placementSessionId === container.placementSessionId,
    'render payload placementSessionId matches container');
  assert(data.sharcNonce === container._rendererProtocolNonce,
    'render payload sharcNonce matches container._rendererProtocolNonce (0.7.7 RTR-D3)');
  assert(data.sharcNonce !== container._sharcNonce,
    'render payload sharcNonce is NOT the root _sharcNonce (RTR-D13)');
  assert(data.sharcVersion === SHARC_VERSION,
    'render payload sharcVersion matches SHARC_VERSION');
  assert(data.rendererProtocolVersion === RENDERER_PROTOCOL_VERSION,
    'render payload rendererProtocolVersion matches RENDERER_PROTOCOL_VERSION');
  assert(data.containerOrigin === PUBLISHER_ORIGIN,
    'render payload containerOrigin equals window.location.origin');
  flushContainers();
}

// -- 7. SHARC:Renderer:rendered envelope validation + bootstrap
{
  console.log('\n7. SHARC:Renderer:rendered envelope validation + bootstrap');

  // 7a — Happy path: container.creativeRendered flips to true.
  {
    const { container } = await buildAndLoad();
    assert(container.creativeRendered === true,
      'envelope-valid :rendered → container.creativeRendered === true');
  }

  // 7b — Wrong event.origin: silently ignored, container stays unrendered.
  {
    const { container } = await buildAndLoad({}, {
      respond: true,
      rendererOrigin: 'https://impostor.example',
    });
    assert(container.creativeRendered === false,
      'wrong event.origin → :rendered SILENTLY ignored, creativeRendered stays false');
  }

  // 7c — Wrong placementSessionId: silently ignored.
  {
    const { container } = await buildAndLoad({}, {
      respond: true,
      tweakRendered: (p) => ({ ...p, placementSessionId: 'forged-id' }),
    });
    assert(container.creativeRendered === false,
      'wrong placementSessionId → :rendered SILENTLY ignored');
  }

  // 7d — Wrong type: silently ignored.
  {
    const { container } = await buildAndLoad({}, {
      respond: true,
      tweakRendered: (p) => ({ ...p, type: 'SHARC:Renderer:notARealType' }),
    });
    assert(container.creativeRendered === false,
      'wrong message type → :rendered SILENTLY ignored');
  }

  // 7d2 — Wrong event.source: silently ignored. The primary
  // neighbor-frame-forgery defense — any other frame on the publisher
  // page can postMessage to window; only the source-equality check
  // against iframe.contentWindow rejects them.
  {
    const { container } = await buildAndLoad({}, { respond: false });
    // Use the publisher window (which is `global.window` here) as the
    // forged source. Envelope check should reject.
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: window, // forged — NOT iframe.contentWindow
    });
    window.dispatchEvent(evt);
    assert(container.creativeRendered === false,
      'forged event.source (publisher window) → :rendered SILENTLY ignored — neighbor-frame defense holds');
  }

  // 7d3 — Non-object event.data (primitive/null/undefined): silently
  // ignored. Defense against `typeof event.data !== 'object'` regression
  // — a refactor to `data && data.type` would silently weaken (primitives
  // auto-box and let `data.type` evaluate to undefined, then the type-string
  // check would still bail, but the explicit object check is the durable
  // shape).
  for (const badData of [null, undefined, 'string-payload', 42, true]) {
    const { container } = await buildAndLoad({}, { respond: false });
    const evt = new dom.window.MessageEvent('message', {
      data: badData,
      origin: RENDERER_ORIGIN,
      source: container._iframe.contentWindow,
    });
    let threw = false;
    try {
      window.dispatchEvent(evt);
    } catch (_) {
      threw = true;
    }
    assert(!threw,
      `primitive event.data (${typeof badData} ${String(badData)}) does NOT throw inside the listener`);
    assert(container.creativeRendered === false,
      `primitive event.data (${typeof badData} ${String(badData)}) → :rendered SILENTLY ignored`);
  }

  // 7e — initChannel scheduled after :rendered, with the standard 200ms
  // delay. Probe by spying on protocol.initChannel.
  {
    const { container } = await buildAndLoad({}, { respond: false });
    let initCalled = false;
    let initArgs = null;
    container._protocol.initChannel = (...args) => {
      initCalled = true;
      initArgs = args;
    };
    // Fire envelope-valid :rendered.
    const cw = container._iframe.contentWindow;
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: cw,
    });
    window.dispatchEvent(evt);
    assert(initCalled === false,
      'initChannel does NOT fire synchronously on :rendered (must respect 200ms bootstrap delay)');
    // 350ms — 150ms slack over the 200ms bootstrap delay so CI under load
    // doesn't flake (code-review pass-1 LOW).
    await new Promise((r) => setTimeout(r, 350));
    assert(initCalled === true,
      'initChannel fires after the 200ms bootstrap delay');
    assert(Array.isArray(initArgs) && initArgs[2] === container.placementSessionId,
      'initChannel called with placementSessionId');
    // Reviewer fix (security pass 1 HIGH): targetOrigin must be the
    // construction-time-derived rendererOrigin, NOT '*' — otherwise the
    // MessagePort + placementSessionId leak to whatever document occupies
    // the iframe at the bootstrap instant.
    assert(initArgs && initArgs[1] === RENDERER_ORIGIN,
      "initChannel targetOrigin === construction-time _rendererOrigin (not '*')");
  }
  flushContainers();
}

// -- 8. Renderer message listener cleanup — _terminate detaches the router
//      listener (single-listener invariant preserved across termination).
{
  console.log('\n8. Renderer message listener cleanup on _terminate');
  const { container } = await buildAndLoad({}, { respond: false });
  // 0.7.7: the renderer-protocol `message` listener lives on
  // `container.protocolRouter`, not on the container. The single window
  // 'message' listener is attached at router construction.
  assert(typeof container.protocolRouter._listener === 'function',
    'router message listener is attached during the load window (0.7.7)');
  container._terminate();
  assert(container.protocolRouter._listener === null,
    'router message listener is detached on _terminate (0.7.7)');
  // After terminate, a stale :rendered must not flip creativeRendered.
  const cw = container._iframe;
  const evt = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: container.placementSessionId,
      sharcNonce: container._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: cw,
  });
  window.dispatchEvent(evt);
  assert(container.creativeRendered === false,
    'stale :rendered after _terminate is ignored (listener was detached)');
  flushContainers();
}

// -- 9. RENDERER_TIMEOUT — iframe-load and rendered-reply timeouts terminate
{
  console.log('\n9. RENDERER_TIMEOUT — iframe-load + rendered-reply termination');

  // 9a — iframe never fires 'load': rendererLoad timeout terminates with 2114.
  // We rely on jsdom NOT performing cross-origin iframe navigation (so a
  // synthetic 'load' never fires for our renderer URL). To lock in that the
  // rendererLoad timeout fired (and not, say, the rendererReply timeout that
  // would only arm if 'load' did fire), set rendererReply to a much larger
  // value than rendererLoad — only the load timeout can win the race here.
  // (Code-review pass-1 HIGH.)
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 30, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    // Suppress noisy console.error from _emitSecurityEventAndTerminate.
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      c.load();
      await c.protocolRouter.ready('SHARC:Renderer:');
      // Do NOT dispatch the iframe 'load' event — let the timeout fire.
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_TIMEOUT,
      'iframe-load timeout fires onError(RENDERER_TIMEOUT, …) (code 2114)');
    assert(c._terminated === true,
      'iframe-load timeout terminates the container');
    // Lock in that this was the rendererLoad timeout, not rendererReply.
    assert(errorOutput.some((s) => /Renderer iframe `load` event did not fire/.test(s)),
      'iframe-load timeout (NOT rendered-reply timeout) is the one that fired');
  }

  // 9b — rendered reply never arrives: rendererReply timeout terminates.
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 30 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    const originalError = console.error;
    console.error = () => {};
    try {
      c.load();
      await c.protocolRouter.ready('SHARC:Renderer:');
      // 0.7.7: await router-derivation before iframe wiring is in place.
      await c.protocolRouter.ready('SHARC:Renderer:');
      // Stub postMessage so the load handler doesn't blow up.
      c._iframe.contentWindow.postMessage = () => {};
      // Fire iframe 'load' to enter the rendered-reply waiting window;
      // do NOT dispatch :rendered.
      c._iframe.dispatchEvent(new dom.window.Event('load'));
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_TIMEOUT,
      'rendered-reply timeout fires onError(RENDERER_TIMEOUT, …) (code 2114)');
    assert(c._terminated === true,
      'rendered-reply timeout terminates the container');
  }

  // 9c — happy-path rendered before timeout: timeouts cleared, no termination.
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: c._iframe.contentWindow,
    });
    window.dispatchEvent(evt);
    // Wait past the bootstrap delay so any race surfaces.
    await new Promise((r) => setTimeout(r, 250));
    assert(errors.length === 0,
      'happy path: no onError fired');
    assert(c._terminated === false,
      'happy path: container is NOT terminated');
    assert(c.creativeRendered === true,
      'happy path: creativeRendered === true');
  }

  // 9d — postMessage throws synchronously (DataCloneError, null contentWindow):
  // fires onError(RENDERER_POST_FAILED, …) (code 2119), NOT RENDERER_TIMEOUT.
  // Locks in the OpenClaw-flagged semantic distinction: a synchronous send
  // failure is not a timeout. Also locks in the pass-2 LOW fix that the
  // rendererReply timeout is NOT armed when postMessage fails.
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      c.load();
      await c.protocolRouter.ready('SHARC:Renderer:');
      // Stub postMessage to throw a DataCloneError-shaped error.
      c._iframe.contentWindow.postMessage = () => {
        throw new dom.window.DOMException('Failed to clone', 'DataCloneError');
      };
      c._iframe.dispatchEvent(new dom.window.Event('load'));
      // Allow the async _handleFatalError → _terminate chain to settle.
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_POST_FAILED,
      'postMessage failure fires onError(RENDERER_POST_FAILED, …) (code 2119, NOT 2114)');
    assert(c._terminated === true,
      'postMessage failure terminates the container');
    assert(errorOutput.some((s) => /renderer_protocol_post_failed/.test(s)),
      'console.error includes the [renderer_protocol_post_failed] type tag (Part 3 grep-ability)');
    assert(c._timeouts['rendererReply'] === undefined,
      'postMessage failure short-circuits BEFORE arming rendererReply timeout (pass-2 LOW fix preserved)');
  }
  flushContainers();
}

// -- 10. Creative URL variant — Phase B does NOT regress the URL load path
{
  console.log('\n10. Creative URL variant — Phase B does NOT regress URL load path');
  const slot = freshSlot();
  const c = track(new SHARCContainer({
    creativeUrl: 'https://ads.example/creative.html',
    placementElement: slot,
  }));
  c.load();
  // URL variant does NOT register the renderer protocol (RTR-D9), so no
  // protocolRouter.ready('SHARC:Renderer:') await is needed.
  const iframe = c._iframe;
  assert(iframe.getAttribute('src') === 'https://ads.example/creative.html',
    'URL: iframe.src equals this.creativeUrl');
  assert(!iframe.hasAttribute('csp'),
    'URL: iframe csp attribute is NOT set (Markup-only)');
  assert(iframe.getAttribute('referrerpolicy') === null,
    'URL: iframe referrerpolicy is NOT set (Markup-only)');
  const sandbox = iframe.getAttribute('sandbox');
  assert(!sandbox.includes('allow-same-origin'),
    'URL: sandbox does NOT include allow-same-origin (SEC-001 holds)');
  assert(c.creativeRendered === false,
    'URL: creativeRendered remains false (renderer protocol is Markup-only)');
  // DOM stamping per spec § DOM stamping additions. URL variant: source='url';
  // rendered='false' (URL never flips this true — only Markup's :rendered does).
  assert(iframe.getAttribute('data-sharc-creative-source') === 'url',
    'URL: iframe stamped with data-sharc-creative-source="url"');
  assert(iframe.getAttribute('data-sharc-creative-rendered') === 'false',
    'URL: iframe stamped with data-sharc-creative-rendered="false" (URL variant never flips this true)');
  flushContainers();
}

// =========================================================================
// Phase C — sections 11/12/13
// =========================================================================

// -- 11. SHARC:Renderer:failed receipt → RENDERER_FAILED (2115)
{
  console.log('\n11. SHARC:Renderer:failed receipt → RENDERER_FAILED (2115)');

  // Helper: build + load a Markup container, stub postMessage, fire iframe
  // 'load', and return primitives the test cases below need. 0.7.7: awaits
  // `protocolRouter.ready('SHARC:Renderer:')` so the iframe-load handler is
  // attached before the synthetic `load` event fires.
  async function buildForFailedTest(opts = {}) {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, ...(opts.timeouts || {}) },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    return { container: c, iframe: c._iframe, errors };
  }

  // 11a — Happy-path :failed: terminates with RENDERER_FAILED (2115) and the
  // operator-facing message echoes the renderer-supplied reason.
  {
    const { container, iframe, errors } = await buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          reason: 'creative HTML parse error: unterminated <script>',
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      // Allow async _handleFatalError → _terminate chain to settle.
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_FAILED,
      ':failed → onError(RENDERER_FAILED, …) (code 2115)');
    assert(errors[0].code !== ErrorCodes.RENDERER_PROTOCOL_ERROR,
      ':failed with valid reason → 2115 (NOT 2117 — payload shape passed)');
    assert(/creative HTML parse error/.test(errors[0].msg),
      ':failed → onError message includes the renderer-supplied reason');
    assert(container._terminated === true,
      ':failed terminates the container');
    assert(errorOutput.some((s) => /\[renderer_failed\]/.test(s)),
      'console.error includes the [renderer_failed] type tag');
    assert(errorOutput.some((s) => /Renderer reported failure: creative HTML parse error/.test(s)),
      'console.error includes the "Renderer reported failure: <reason>" wording');
    assert(container.creativeRendered === false,
      ':failed does NOT flip creativeRendered=true (renderer never rendered)');
  }

  // 11b — Envelope source/origin mismatch on :failed: silently ignored
  //       (envelope helper is symmetric across :rendered and :failed).
  {
    const { container, iframe, errors } = await buildForFailedTest();
    // Wrong event.origin — envelope check fails, silent ignore.
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:failed',
        placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
        reason: 'should be ignored',
      },
      origin: 'https://impostor.example',
      source: iframe.contentWindow,
    });
    window.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 20));
    assert(errors.length === 0,
      ':failed with wrong event.origin → SILENTLY ignored (envelope reject), no onError fired');
    assert(container._terminated === false,
      ':failed with wrong event.origin → container NOT terminated');
  }

  // 11c — Wrong event.source on :failed: silently ignored — neighbor-frame
  //       defense (a sibling iframe forging :failed must not terminate us).
  {
    const { container, errors } = await buildForFailedTest();
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:failed',
        placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
        reason: 'forged from neighbor frame',
      },
      origin: RENDERER_ORIGIN,
      source: window, // forged — NOT iframe.contentWindow
    });
    window.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 20));
    assert(errors.length === 0,
      ':failed with forged event.source → SILENTLY ignored, no onError fired');
    assert(container._terminated === false,
      ':failed with forged event.source → container NOT terminated');
  }

  // 11d — Wrong placementSessionId on :failed: silently ignored (session
  //       correlation is symmetric across :rendered and :failed).
  {
    const { container, iframe, errors } = await buildForFailedTest();
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:failed',
        placementSessionId: 'forged-id-not-mine',
        reason: 'wrong session',
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    });
    window.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 20));
    assert(errors.length === 0,
      ':failed with wrong placementSessionId → SILENTLY ignored');
    assert(container._terminated === false,
      ':failed with wrong placementSessionId → container NOT terminated');
  }

  // 11e — :failed clears the rendererReply timeout: the re-entrancy guard
  // prevents a follow-up RENDERER_TIMEOUT from firing after a :failed,
  // regardless of whether _terminate races the timeout-clear. Even if the
  // rendererReply timeout fires before clear-all-timeouts has run, its
  // terminate path short-circuits on the _terminated guard at the
  // chokepoint helper. errors.length must stay at 1.
  {
    const { container, iframe, errors } = await buildForFailedTest({
      timeouts: { rendererLoad: 5000, rendererReply: 60 },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          reason: 'fail-fast for timeout-clear test',
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      // Wait past the rendererReply window so the timeout would fire if not
      // cleared. Errors array must contain exactly one entry — the
      // RENDERER_FAILED — not a follow-up RENDERER_TIMEOUT.
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      console.error = originalError;
    }
    assert(errors.length === 1,
      ':failed clears rendererReply — only one onError fires (no follow-up RENDERER_TIMEOUT)');
    assert(errors[0].code === ErrorCodes.RENDERER_FAILED,
      'first (and only) onError is RENDERER_FAILED, not RENDERER_TIMEOUT');
  }

  // 11f — Log-injection hardening on data.reason (security pass-1 MEDIUM-2):
  //       a :failed reason carrying CR/LF + a forged log-line prefix must be
  //       sanitized (control chars replaced with '?') before being spliced
  //       into console.error. Long reasons must be truncated to 200 chars to
  //       bound log-line length. The sanitized form is what flows through to
  //       both console.error and the onError callback (consistent surface).
  {
    const { container, iframe, errors } = await buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          reason: 'fake_error\n[SHARCContainer] [audit] forged log line',
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const failureLog = errorOutput.find((s) => /\[renderer_failed\]/.test(s)) || '';
    assert(/Renderer reported failure: fake_error\?\[SHARCContainer\] \[audit\] forged log line/.test(failureLog),
      '11f: console.error sanitizes data.reason — LF replaced with "?"');
    assert(!/fake_error\n\[SHARCContainer\] \[audit\]/.test(failureLog),
      '11f: console.error does NOT contain a literal newline followed by a forged [SHARCContainer] prefix (log-splitting blocked)');
    assert(errors.length >= 1 && /Renderer reported failure: fake_error\?\[SHARCContainer\] \[audit\] forged log line/.test(errors[0].msg),
      '11f: onError receives the same sanitized message the log saw (consistent surface)');
  }

  // 11g — Truncation hardening on data.reason (security pass-1 MEDIUM-2):
  //       reasons longer than 200 chars are sliced to 200 to bound the log
  //       line length. The truncation cut is exact — exactly 200 chars of
  //       payload appear after the "Renderer reported failure: " prefix.
  {
    const { container, iframe, errors } = await buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    const longReason = 'A'.repeat(500);
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          reason: longReason,
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1,
      '11g: long reason still routes to onError');
    const m = /Renderer reported failure: (A+)/.exec(errors[0].msg);
    assert(m && m[1].length === 200,
      '11g: data.reason is truncated to exactly 200 chars in the operator-facing message');
    assert(!/A{201}/.test(errors[0].msg),
      '11g: no run of 201+ A chars survives the truncation');
  }

  // 11h — Other C0/DEL control chars in data.reason are stripped (CR, NUL,
  //       ESC for ANSI sequences, DEL 0x7f). Spot-check the full range
  //       behavior, not just LF.
  {
    const { container, iframe, errors } = await buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          // CR + NUL + ESC[31m (ANSI red) + DEL — none should survive.
          reason: 'cr\rnul\x00esc\x1b[31mred\x1b[0mdel\x7fend',
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1,
      '11h: reason with mixed control chars still routes to onError');
    assert(!/[\x00-\x1f\x7f]/.test(errors[0].msg.split('Renderer reported failure: ')[1] || ''),
      '11h: no C0 or DEL control char survives in the post-prefix payload');
    assert(/cr\?nul\?esc\?\[31mred\?\[0mdel\?end/.test(errors[0].msg),
      '11h: each control char is replaced with "?" (ANSI escape neutralized)');
  }

  // 11i — Listener-detach idempotency (and indirect coverage of the
  // re-entrancy guard at _emitSecurityEventAndTerminate).
  //
  // Honest scope: what this test actually exercises is the listener-detach
  // contract — after the first `:failed` triggers `_terminate`, the protocol
  // router's `message` listener is removed via `router.destroy()`; a second
  // `:failed` dispatched on `window` never reaches the renderer handler.
  // The chokepoint guard
  // (`if (this._terminated) return;` at the top of
  // `_emitSecurityEventAndTerminate`) is forward-compat for Phase D, where
  // non-listener paths (e.g. load-event monitoring) may call the chokepoint
  // after `_terminated=true`. Today it isn't reached because the listener-
  // detach already short-circuits the only path. Precondition assertions
  // below pin those facts so the test doesn't silently morph into something
  // weaker if the chain ever changes (e.g. listener-detach moves later in
  // `_terminate`, or `sendFatalError` becomes 2-microtask-async).
  //
  // A direct test of the chokepoint guard belongs with Phase D's load-event
  // monitoring work — file an issue for it then.
  {
    const { container, iframe, errors } = await buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      // First :failed — should fire onError once and schedule async _terminate.
      const evt1 = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          reason: 'first failure',
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt1);

      // Drain microtasks — `_terminate` schedules via .catch(_terminate) on
      // the sendFatalError-rejected promise, which is microtask-ordered. After
      // this `await`, _terminated === true and the listener is detached.
      await Promise.resolve();
      await Promise.resolve();

      // Lock in the precondition the rest of the test depends on. Without
      // this, if the chain ever changes the second-dispatch assertion below
      // would silently become a no-op test of envelope rejection rather than
      // a test of the listener-detach / re-entrancy guard contract.
      assert(container._terminated === true,
        'guard precondition: _terminated is true after microtask drain');
      assert(container.protocolRouter._listener === null,
        'guard precondition: router message listener detached after microtask drain (0.7.7)');

      // Second :failed in the next tick. Real browsers would deliver this as
      // a separate task; we simulate that by `await`ing first.
      const evt2 = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          reason: 'second failure',
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt2);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }

    assert(errors.length === 1,
      'guard: post-microtask second :failed does NOT fire a second onError (exactly one)');
    assert(errors[0].code === ErrorCodes.RENDERER_FAILED,
      'guard: the single onError carries RENDERER_FAILED (2115), from the first :failed');
    assert(/first failure/.test(errors[0].msg) && !/second failure/.test(errors[0].msg),
      'guard: the surviving onError carries the FIRST reason (second was short-circuited)');
    assert(errorOutput.filter((s) => /\[renderer_failed\]/.test(s)).length === 1,
      'guard: exactly one [renderer_failed] console.error line was emitted');
  }

  // 11j — Surrogate-pair-safe truncation: `_sanitizeForLog` slices on UTF-16
  // code units. If the renderer's `reason` puts a supplementary-plane
  // character (here: an emoji) straddling positions 199–200, slice(0, 200)
  // would emit a lone high surrogate. The trailing-high-surrogate strip
  // ensures the output never ends with a malformed UTF-16 sequence.
  {
    const { container, iframe, errors } = await buildForFailedTest();
    const originalError = console.error;
    console.error = () => {};
    try {
      // Build a reason that places a surrogate pair across the 200-boundary.
      // 199 'A's + '😀' (a 2-code-unit surrogate pair, U+1F600) + tail. The
      // slice(0, 200) cuts mid-pair (keeps the high surrogate at index 199,
      // drops the low surrogate at 200). The trailing strip removes the high
      // surrogate, so the post-prefix payload ends in 'A' (199 As), not in a
      // lone high surrogate.
      const reason = 'A'.repeat(199) + '😀' + 'tail';
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          reason,
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1,
      '11j: surrogate-boundary reason still routes to onError');
    const payload = errors[0].msg.split('Renderer reported failure: ')[1] || '';
    assert(!/[\uD800-\uDBFF]$/.test(payload),
      '11j: post-prefix payload does NOT end with a lone high surrogate (malformed UTF-16 stripped)');
    assert(/A{199}$/.test(payload),
      '11j: payload ends with the 199 As preceding the cut surrogate (high surrogate stripped)');
  }
  flushContainers();
}

// -- 12. Origin echo + payload-shape validation on :rendered/:failed
{
  console.log('\n12. Post-load origin echo + payload-shape validation');

  // 12a — Post-load origin echo: :rendered with a different rendererOrigin
  //       than the construction-time `_rendererOrigin` →
  //       RENDERER_ORIGIN_MISMATCH (2116). Multi-line operator log includes
  //       both expected and actual origins.
  {
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    let errors;
    let c;
    try {
      const slot = freshSlot();
      c = track(new SHARCContainer({
        creativeHtml: CREATIVE_HTML,
        creativeRendererUrl: RENDERER_URL,
        placementElement: slot,
        timeouts: { rendererLoad: 5000, rendererReply: 5000 },
        onError: (code, msg) => (errors = errors || []).push({ code, msg }),
      }));
      errors = [];
      c.load();
      await c.protocolRouter.ready('SHARC:Renderer:');
      c._iframe.contentWindow.postMessage = () => {};
      c._iframe.dispatchEvent(new dom.window.Event('load'));
      // Envelope `event.origin` MUST match `_rendererOrigin` for the message
      // to even reach the dispatch — origin echo failures by definition come
      // from a redirect that the renderer notices server-side and reports
      // back. So `event.origin` stays the construction-time origin, but
      // `data.rendererOrigin` carries the post-redirect origin.
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:rendered',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          rendererOrigin: 'https://cdn.example.com',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }

    // Assertions live OUTSIDE the try/finally so any failure indicator (`✗`
    // line) is written to the real terminal, not into the captured
    // `errorOutput` array (which would silently mask the failure).
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_ORIGIN_MISMATCH,
      'origin echo mismatch on :rendered → onError(RENDERER_ORIGIN_MISMATCH, …) (code 2116)');
    assert(errors[0].code !== ErrorCodes.RENDERER_PROTOCOL_ERROR,
      'origin echo mismatch with valid shape → 2116 (NOT 2117 — payload shape passed)');
    assert(c._terminated === true,
      'origin echo mismatch terminates the container');
    assert(c.creativeRendered === false,
      'origin echo mismatch does NOT flip creativeRendered=true');

    // Operator-facing log: per spec § Container-side message validation
    // lines 484–491. The helper prefixes `[SHARCContainer] [<type>]`, so the
    // rendered log line is the spec-intended:
    //   [SHARCContainer] [renderer_origin_mismatch] Renderer origin mismatch — refusing to load. …
    const joined = errorOutput.join('\n');
    assert(/\[renderer_origin_mismatch\]/.test(joined),
      'console.error includes the [renderer_origin_mismatch] type tag');
    assert(/Renderer origin mismatch — refusing to load\./.test(joined),
      'console.error includes the spec wording "Renderer origin mismatch — refusing to load."');
    assert(joined.includes('Expected origin: ' + RENDERER_ORIGIN),
      'console.error names the expected origin (from creativeRendererUrl)');
    assert(/Actual origin:\s+https:\/\/cdn\.example\.com/.test(joined),
      'console.error names the actual (post-redirect) origin');
    assert(/Redirects on creativeRendererUrl are not permitted/.test(joined),
      'console.error explains why redirects are refused (spec wording)');
    assert(/api-reference\.md#10-renderer-protocol/.test(joined),
      'console.error includes the link to the api-reference Renderer Protocol section (Phase D — repointed from proposal anchor)');
  }

  // 12b — Malformed :rendered payload: missing / non-string / empty
  //       `rendererOrigin` → RENDERER_PROTOCOL_ERROR (2117). Payload shape
  //       check FIRST, before origin echo (a missing field can't meaningfully
  //       fail an origin comparison; protocol-shape is the more accurate
  //       diagnosis for the operator).
  for (const probe of [
    {
      label: 'missing rendererOrigin',
      mutate: (p) => { delete p.rendererOrigin; return p; },
    },
    {
      label: 'rendererOrigin not a string (number)',
      mutate: (p) => { p.rendererOrigin = 42; return p; },
    },
    {
      label: 'rendererOrigin not a string (null)',
      mutate: (p) => { p.rendererOrigin = null; return p; },
    },
    {
      label: 'rendererOrigin empty string',
      mutate: (p) => { p.rendererOrigin = ''; return p; },
    },
  ]) {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const payload = probe.mutate({
        type: 'SHARC:Renderer:rendered',
        placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
        rendererOrigin: RENDERER_ORIGIN,
      });
      const evt = new dom.window.MessageEvent('message', {
        data: payload,
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_PROTOCOL_ERROR,
      `:rendered with ${probe.label} → onError(RENDERER_PROTOCOL_ERROR, …) (code 2117)`);
    assert(c._terminated === true,
      `:rendered with ${probe.label} → container terminated`);
    assert(errorOutput.some((s) => /\[renderer_protocol_error\]/.test(s)),
      `:rendered with ${probe.label} → console.error tagged [renderer_protocol_error]`);
    assert(errorOutput.some((s) => /Malformed SHARC:Renderer:rendered/.test(s)),
      `:rendered with ${probe.label} → console.error names the malformed message type`);
    assert(c.creativeRendered === false,
      `:rendered with ${probe.label} → creativeRendered NOT flipped`);
  }

  // 12c — Malformed :failed payload: reason missing / non-string / empty →
  //       RENDERER_PROTOCOL_ERROR (2117), distinct from RENDERER_FAILED.
  for (const probe of [
    {
      label: 'missing reason',
      mutate: (p) => { delete p.reason; return p; },
    },
    {
      label: 'reason not a string (number)',
      mutate: (p) => { p.reason = 0; return p; },
    },
    {
      label: 'reason not a string (object)',
      mutate: (p) => { p.reason = { message: 'wrong type' }; return p; },
    },
    {
      label: 'reason empty string',
      mutate: (p) => { p.reason = ''; return p; },
    },
  ]) {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const payload = probe.mutate({
        type: 'SHARC:Renderer:failed',
        placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
        reason: 'placeholder',
      });
      const evt = new dom.window.MessageEvent('message', {
        data: payload,
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_PROTOCOL_ERROR,
      `:failed with ${probe.label} → onError(RENDERER_PROTOCOL_ERROR, …) (code 2117 — NOT 2115)`);
    assert(c._terminated === true,
      `:failed with ${probe.label} → container terminated`);
    assert(errorOutput.some((s) => /Malformed SHARC:Renderer:failed/.test(s)),
      `:failed with ${probe.label} → console.error names the malformed message type`);
  }

  // 12d — Order-of-checks: a :rendered with BOTH a malformed rendererOrigin
  //       (empty string) AND that doesn't match `_rendererOrigin` must take
  //       the RENDERER_PROTOCOL_ERROR path, not RENDERER_ORIGIN_MISMATCH.
  //       Locks in the spec-required precedence (shape before echo).
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    console.error = () => {};
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:rendered',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          rendererOrigin: '', // empty — fails shape AND fails echo comparison
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_PROTOCOL_ERROR,
      'order-of-checks: empty rendererOrigin → 2117 (shape) takes precedence over 2116 (echo)');
  }

  // 12e — Log-injection hardening on data.rendererOrigin (security pass-1
  //       MEDIUM-2): a :rendered carrying a CR + forged log-line in
  //       rendererOrigin must be sanitized before being spliced into the
  //       multi-line origin-mismatch console.error. Reaches the sanitization
  //       site because the string is non-empty (passes shape) but does not
  //       equal `_rendererOrigin` (fails echo → routes to mismatch log).
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:rendered',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          // CR splice attempt — non-empty (passes shape), differs from
          // _rendererOrigin (fails echo → reaches the mismatch log).
          rendererOrigin: 'https://impostor.example\r[SHARCContainer] [audit] forged',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const mismatchLog = errorOutput.find((s) => /\[renderer_origin_mismatch\]/.test(s)) || '';
    assert(/Actual origin:   https:\/\/impostor\.example\?\[SHARCContainer\] \[audit\] forged/.test(mismatchLog),
      '12e: console.error sanitizes data.rendererOrigin — CR replaced with "?"');
    assert(!/impostor\.example\r\[SHARCContainer\] \[audit\]/.test(mismatchLog),
      '12e: console.error does NOT contain a literal CR followed by a forged [SHARCContainer] prefix');
    assert(errors.length >= 1 && /Actual origin:   https:\/\/impostor\.example\?\[SHARCContainer\] \[audit\] forged/.test(errors[0].msg),
      '12e: onError receives the same sanitized rendererOrigin the log saw');
  }
  flushContainers();
}

// -- 13. close() mid-render cleanup contract
{
  console.log('\n13. close() mid-render cleanup contract');

  // Helper: build, load, fire iframe 'load' (so the render postMessage goes
  // out and the message listener is attached) — but do NOT dispatch any
  // :rendered/:failed reply. Container is now in the mid-render window.
  // closeSequence is set short so the close-induced terminate (which goes
  // through the .catch() → _terminate path because no port exists yet)
  // doesn't slow the test even if some future change re-routes it through
  // the closeSequence timeout.
  async function buildMidRender(opts = {}) {
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: {
        rendererLoad: 5000,
        rendererReply: 5000,
        closeSequence: 50, // belt-and-suspenders — see comment above
      },
      ...opts,
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    return { container: c, iframe: c._iframe, slot };
  }

  // 13a — close() during mid-render reaches _terminate. Per `_initiateClose`
  //       at sharc-container.js:2509–2526: `_protocol.sendClose()` rejects
  //       synchronously with "No MessagePort available" because no
  //       MessageChannel handshake has happened yet, the .catch branch fires,
  //       and _terminate runs. (closeSequence is the 2s backstop only.)
  {
    const { container, iframe } = await buildMidRender();
    // Snapshot pre-close state — listener is attached, iframe is in the DOM,
    // rendererReply timeout is armed, placement carries the SHARC stamps.
    assert(typeof container.protocolRouter._listener === 'function',
      'pre-close: router message listener IS attached during mid-render window (0.7.7)');
    assert(container._timeouts['rendererReply'] != null,
      'pre-close: rendererReply timeout IS armed during mid-render window');
    assert(iframe.parentNode != null,
      'pre-close: iframe IS attached to the DOM during mid-render window');
    assert(iframe.getAttribute('data-sharc-creative-source') === 'html',
      'pre-close: iframe carries data-sharc-creative-source="html"');
    assert(iframe.getAttribute('data-sharc-creative-rendered') === 'false',
      'pre-close: iframe carries data-sharc-creative-rendered="false"');

    container.close();
    // _initiateClose's .catch fires on the next microtask; allow it to settle.
    await new Promise((r) => setTimeout(r, 80));

    assert(container._terminated === true,
      'mid-render close → _terminate runs (sendClose rejects, .catch path fires)');

    // 13a.i — rendererReply timeout cancelled (sub-bullet a of the spec
    // contract). _terminate's `Object.keys(this._timeouts).forEach(_clearTimeout)`
    // covers this; locking it in here.
    assert(container._timeouts['rendererReply'] === undefined,
      'mid-render close: rendererReply timeout cancelled (spec sub-bullet a)');

    // 13a.ii — renderer message listener removed (sub-bullet b). 0.7.7: the
    // listener lives on the protocol router; check it's been destroyed.
    assert(container.protocolRouter._listener === null,
      'mid-render close: router message listener detached (spec sub-bullet b, 0.7.7)');

    // 13a.iii — iframe removed from DOM (sub-bullet c).
    assert(container._iframe === null,
      'mid-render close: container._iframe is nulled (spec sub-bullet c)');
    assert(iframe.parentNode === null,
      'mid-render close: iframe is detached from the DOM (spec sub-bullet c)');
  }

  // 13b — Placement element restored to pre-load state (sub-bullet d).
  //       _detachFromPlacement is the existing implementation. Test checks
  //       the SHARC-stamped attributes are gone after close. Pass an explicit
  //       placementId so the data-sharc-placement-id round-trip (set → cleared)
  //       is locked in — without it the post-close === null check is vacuous
  //       (TRA depth-pass BLOCKER-2).
  {
    const { container, slot } = await buildMidRender({ placementId: 'pid-test-13b' });
    // Pre-close: slot carries SHARC placement stamps (the placement-stamping
    // proposal already lands `data-sharc-placement-session-id` on the slot).
    assert(slot.getAttribute('data-sharc-placement-session-id') === container.placementSessionId,
      'pre-close: placement element carries data-sharc-placement-session-id');
    assert(slot.getAttribute('data-sharc-placement-id') === 'pid-test-13b',
      'pre-close: placement element carries data-sharc-placement-id (set from constructor option)');
    assert(slot.getAttribute('data-sharc-state') !== null,
      'pre-close: placement element carries data-sharc-state');

    container.close();
    await new Promise((r) => setTimeout(r, 80));

    assert(slot.getAttribute('data-sharc-placement-session-id') === null,
      'mid-render close: data-sharc-placement-session-id removed from placement (spec sub-bullet d)');
    assert(slot.getAttribute('data-sharc-placement-id') === null,
      'mid-render close: data-sharc-placement-id removed from placement');
    assert(slot.getAttribute('data-sharc-state') === null,
      'mid-render close: data-sharc-state removed from placement');
    // The iframe (which carried the data-sharc-creative-source/rendered stamps)
    // is detached entirely; the placement no longer contains a SHARC iframe.
    assert(slot.querySelector('iframe.sharc-creative') === null,
      'mid-render close: placement no longer contains a SHARC creative iframe');
  }

  // 13c — Late :rendered after close-mid-render: silently ignored. The
  //       message listener has been detached, so dispatching a synthetic
  //       :rendered on window is a no-op for this container.
  {
    const { container, iframe } = await buildMidRender();
    container.close();
    await new Promise((r) => setTimeout(r, 80));

    // Fabricate a :rendered that *would* have been envelope-valid pre-close.
    // The listener is gone; container.creativeRendered must stay false.
    // (We need a `source` reference; `iframe.contentWindow` is still around
    //  because we captured it pre-close.)
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    });
    window.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 20));

    assert(container.creativeRendered === false,
      'late :rendered after close-mid-render → SILENTLY ignored (listener detached, spec line 501)');
    assert(container._terminated === true,
      'late :rendered after close-mid-render → container stays terminated');
  }

  // 13d — Late :failed after close-mid-render: silently ignored (same path
  //       as 13c — listener detach is symmetric across :rendered and :failed).
  //       Locks in that Phase B's listener-detach in _terminate covers
  //       :failed too, as the proposal § close() mid-render cleanup line 501
  //       implies ("Late `rendered` or `failed` messages…").
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const cwSnapshot = c._iframe.contentWindow;
    c.close();
    await new Promise((r) => setTimeout(r, 80));

    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:failed',
        placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
        reason: 'late failure after close',
      },
      origin: RENDERER_ORIGIN,
      source: cwSnapshot,
    });
    window.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 20));

    assert(errors.length === 0,
      'late :failed after close-mid-render → SILENTLY ignored (no onError fires)');
    assert(c._terminated === true,
      'late :failed after close-mid-render → container stays terminated');
  }

  // 13e — Idempotency: close() called twice during mid-render is a no-op on
  //       the second call. (Already covered by `_closeRequested` guard at
  //       sharc-container.js:866; locking it in via an `onClose` spy so the
  //       observable side effect — the publisher callback firing — is
  //       counted exactly once.)
  {
    let closeCalls = 0;
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onClose: () => { closeCalls++; },
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    c.close();
    await new Promise((r) => setTimeout(r, 80));
    // Second close — no throw, no double-terminate side effects.
    let threw = false;
    try { c.close(); } catch (_) { threw = true; }
    await new Promise((r) => setTimeout(r, 20));
    assert(!threw,
      'mid-render close() called twice does not throw');
    assert(closeCalls === 1,
      'mid-render close() called twice fires onClose exactly once (idempotency)');
  }
}

// -- 14. Load-event navigation backstop → RENDERER_UNAUTHORIZED_NAVIGATION (2118)
{
  console.log('\n14. Load-event navigation backstop → RENDERER_UNAUTHORIZED_NAVIGATION (2118)');

  // Helper: build, load, fire iframe 'load', dispatch a valid `:rendered`,
  // wait for the post-:rendered DOM stamp + backstop attachment to settle.
  // Returns the wired-up container ready for backstop probes.
  async function buildPostRender(opts = {}) {
    const slot = freshSlot();
    const errors = [];
    const securityEvents = [];
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: (code, msg) => errors.push({ code, msg }),
      onSecurityEvent: (event) => securityEvents.push(event),
      ...opts,
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: c._iframe.contentWindow,
    });
    window.dispatchEvent(evt);
    // Wait for `_onRendererRendered` to stamp `data-sharc-creative-rendered`
    // and attach the backstop.
    await new Promise((r) => setTimeout(r, 30));
    return { container: c, slot, errors, securityEvents };
  }

  // Helper: wraps `_dispatchRendererLoadAck` to count BOTH router-arrival
  // (`dispatched`) and probe-resolution (`resolved` — true only when a real
  // `_pendingLoadProbe` callback was waiting at dispatch time). Asserting on
  // `resolved` catches the routed-but-inert failure mode (e.g. broken
  // `_armRendererBackstop`) that a dispatch-only spy would miss, since the
  // 100ms probe timeout produces byte-identical terminal state to a real ack.
  function spyLoadAckDispatch(container) {
    let dispatched = 0;
    let resolved = 0;
    const originalDispatch = container._dispatchRendererLoadAck.bind(container);
    container._dispatchRendererLoadAck = function () {
      dispatched += 1;
      if (typeof container._pendingLoadProbe === 'function') {
        resolved += 1;
      }
      return originalDispatch();
    };
    return () => ({ dispatched, resolved });
  }

  // 14a — Backstop is attached after `:rendered` accept. Probe the private
  //       field directly (the backstop's existence is the contract; firing
  //       it is 14b).
  {
    const { container } = await buildPostRender();
    assert(typeof container._rendererBackstopHandler === 'function',
      'post-:rendered: load-event backstop is attached');
    assert(container.creativeRendered === true,
      'post-:rendered: creativeRendered === true (sanity)');
  }

  // 14b — Markup consumes the expected document.write load after :rendered;
  //       the following load event → 2118 + onSecurityEvent fires with
  //       type=`unauthorized_navigation`, details carries
  //       variant: 'markup' (Phase E will extend with variant: 'url').
  //       console.error includes `[unauthorized_navigation]` and
  //       `[<placementSessionId>]`.
  {
    const { container, errors, securityEvents } = await buildPostRender();
    const iframe = container._iframe;
    const loadAckSpy = spyLoadAckDispatch(container);
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      // Markup's normal document.write completion can fire after :rendered
      // because the renderer replies at DOMContentLoaded. That expected load
      // must not be treated as navigation when the renderer answers the
      // load-probe.
      iframe.dispatchEvent(new dom.window.Event('load'));
      window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:loadAck',
          sharcNonce: container._rendererProtocolNonce,
          placementSessionId: container.placementSessionId,
          rendererOrigin: RENDERER_ORIGIN,
        },
        origin: RENDERER_ORIGIN,
        source: iframe.contentWindow,
      }));
      await new Promise((r) => setTimeout(r, 10));
      const ackCounts = loadAckSpy();
      assert(ackCounts.dispatched === 1,
        'first post-:rendered loadAck traverses the router → _dispatchRendererLoadAck invoked exactly once');
      assert(ackCounts.resolved === 1,
        'first post-:rendered loadAck resolved a pending probe (rules out routed-but-inert: broken backstop arming)');
      assert(errors.length === 0,
        'first post-:rendered Markup load is verified as document.write completion');
      assert(securityEvents.length === 0,
        'first post-:rendered Markup load does not emit unauthorized_navigation');
      // Now simulate the renderer iframe navigating: dispatch the next `load`
      // event. (jsdom never actually navigates the cross-origin iframe; we
      // synthesize the event the browser would have fired.)
      iframe.dispatchEvent(new dom.window.Event('load'));
      // Allow the chokepoint's onSecurityEvent + console.error + handleFatalError
      // to drain.
      await new Promise((r) => setTimeout(r, 140));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION,
      'subsequent iframe `load` post-render → onError(RENDERER_UNAUTHORIZED_NAVIGATION) (code 2118)');
    assert(container._terminated === true,
      'subsequent iframe `load` post-render → container terminated');
    assert(errorOutput.some((s) => /\[unauthorized_navigation\]/.test(s)),
      'subsequent iframe `load` post-render → console.error tagged [unauthorized_navigation]');
    assert(errorOutput.some((s) => /Renderer iframe navigated post-render/.test(s)),
      'subsequent iframe `load` post-render → console.error names the spec-aligned reason');

    // onSecurityEvent fired with the discriminated payload — spec event
    // type is `unauthorized_navigation`, NOT the granular internal-type
    // string (which is the same here, but the mapping is what matters).
    const navEvent = securityEvents.find((e) => e.type === 'unauthorized_navigation');
    assert(navEvent != null,
      'subsequent iframe `load` post-render → onSecurityEvent fires with type=unauthorized_navigation');
    assert(navEvent && navEvent.severity === 'error',
      'unauthorized_navigation event severity === "error"');
    assert(navEvent && navEvent.errorCode === ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION,
      'unauthorized_navigation event errorCode === 2118');
    assert(navEvent && navEvent.details && navEvent.details.variant === 'markup',
      'unauthorized_navigation event.details.variant === "markup" (Phase E will extend with "url" without re-shaping)');
    // Phase D round-4 SRE HIGH-1: details.msSinceRender is the wall-clock
    // delay between :rendered accept and the post-render load event. The
    // helper waits ~30ms after :rendered before firing the second load, so
    // msSinceRender lands in the 0–~200ms range; we assert non-negative
    // number rather than a tight upper bound (jsdom timer scheduling is
    // not deterministic enough for a tighter assertion).
    assert(navEvent && navEvent.details && typeof navEvent.details.msSinceRender === 'number',
      'unauthorized_navigation event.details.msSinceRender is a number (Phase D round-4 SRE HIGH-1)');
    assert(navEvent && navEvent.details && navEvent.details.msSinceRender >= 0,
      'unauthorized_navigation event.details.msSinceRender is >= 0 (no clock-skew negative)');
    // The new console.error message includes the timing in the body.
    assert(errorOutput.some((s) => /Renderer iframe navigated post-render after \d+ms/.test(s)),
      'subsequent iframe `load` post-render → console.error names msSinceRender in the timing-aware message');
    assert(errorOutput.some((s) => /redirect-injection patterns/.test(s)),
      'subsequent iframe `load` post-render → console.error names redirect-injection diagnostic hint');
    assert(navEvent && navEvent.placementSessionId === container.placementSessionId,
      'unauthorized_navigation event.placementSessionId correlates back to container');
    assert(navEvent && typeof navEvent.timestamp === 'number',
      'unauthorized_navigation event.timestamp is a number (Date.now)');
  }

  // 14c — If a second iframe load arrives while the first-load probe is
  //       still pending, latch it and classify it as unauthorized after the
  //       expected document.write load is verified.
  {
    const { container, errors, securityEvents } = await buildPostRender();
    const iframe = container._iframe;
    const loadAckSpy = spyLoadAckDispatch(container);
    iframe.dispatchEvent(new dom.window.Event('load'));
    iframe.dispatchEvent(new dom.window.Event('load'));
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:loadAck',
        sharcNonce: container._rendererProtocolNonce,
        placementSessionId: container.placementSessionId,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    }));
    await new Promise((r) => setTimeout(r, 140));
    const ackCounts = loadAckSpy();
    assert(ackCounts.dispatched === 1,
      'latched-load ack traverses the router → _dispatchRendererLoadAck invoked exactly once');
    assert(ackCounts.resolved === 1,
      'latched-load ack resolved a pending probe → emits unauthorized_navigation via the ack-driven path, not the 100ms timeout');
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION,
      'load during first-load probe → classified as RENDERER_UNAUTHORIZED_NAVIGATION after ack');
    assert(securityEvents.some((e) => e.type === 'unauthorized_navigation'),
      'load during first-load probe → emits unauthorized_navigation');
    assert(container._terminated === true,
      'load during first-load probe → container terminated');
  }

  // 14d — Backstop detached on _terminate. The iframe is removed from the
  //       DOM by _terminate (so further events would be impossible anyway),
  //       but explicit detach is still verified — the field is nulled.
  {
    const { container } = await buildPostRender();
    assert(container._rendererBackstopHandler !== null,
      'pre-terminate: backstop handler is non-null');
    container.close();
    await new Promise((r) => setTimeout(r, 80));
    assert(container._rendererBackstopHandler === null,
      'post-terminate: backstop handler is nulled out (defense-in-depth detach)');
  }

  // 14e — Re-entrancy: a backstop fire on an ALREADY-terminated container
  //       is a no-op (the chokepoint's `_terminated` guard short-circuits).
  //       Probe by manually invoking the saved backstop handler after
  //       termination — expect: no double-fire of onError or
  //       onSecurityEvent.
  {
    const { container, errors, securityEvents } = await buildPostRender();
    const handler = container._rendererBackstopHandler;
    // Force a clean fatal so _terminated flips to true via the chokepoint.
    container._emitSecurityEventAndTerminate(
      'renderer_failed',
      ErrorCodes.RENDERER_FAILED,
      'baseline failure for re-entrancy probe',
      { reason: 'baseline' }
    );
    await new Promise((r) => setTimeout(r, 60));
    const errorsBefore = errors.length;
    const eventsBefore = securityEvents.length;
    // Now invoke the saved backstop handler directly (the iframe is gone, so
    // dispatchEvent('load') wouldn't reach it; we exercise the chokepoint's
    // re-entrancy guard, not the listener wiring).
    if (typeof handler === 'function') handler(new dom.window.Event('load'));
    await new Promise((r) => setTimeout(r, 30));
    assert(errors.length === errorsBefore,
      'backstop fire on terminated container → onError NOT re-fired (chokepoint _terminated guard)');
    assert(securityEvents.length === eventsBefore,
      'backstop fire on terminated container → onSecurityEvent NOT re-fired (chokepoint _terminated guard)');
  }

  // ── #269: single-consume `:loadAck` latch (defense-in-depth) ──────────────
  // Once the first-load probe has been resolved by a `loadAck`, every later
  // `loadAck` must be explicitly dropped at `_dispatchRendererLoadAck` — true
  // by intent (`_loadAckConsumed`), not merely inert because the probe pointer
  // is null. A forged / replayed / late second ack cannot re-resolve a probe,
  // alter the first-load verification, or suppress the navigation backstop,
  // regardless of router phase.

  // Helper: fire the expected document.write load (arms + resolves the probe)
  // and deliver the legitimate FIRST loadAck. Returns the spy accessor.
  async function verifyFirstLoadProbe(container) {
    const iframe = container._iframe;
    const spy = spyLoadAckDispatch(container);
    iframe.dispatchEvent(new dom.window.Event('load'));
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:loadAck',
        sharcNonce: container._rendererProtocolNonce,
        placementSessionId: container.placementSessionId,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    }));
    await new Promise((r) => setTimeout(r, 10));
    return spy;
  }

  // 14f — A SECOND loadAck after the first-load probe is verified is
  //       explicitly ignored: does NOT re-invoke the probe callback, does NOT
  //       alter the consumed latch, and does NOT suppress the
  //       unauthorized-navigation backstop on a later real navigation.
  {
    const { container, errors, securityEvents } = await buildPostRender();
    const iframe = container._iframe;
    const spy = await verifyFirstLoadProbe(container);
    assert(spy().resolved === 1,
      '14f: legitimate first loadAck resolved the probe (baseline)');
    assert(container._loadAckConsumed === true,
      '14f: first loadAck latched _loadAckConsumed === true');
    assert(container._pendingLoadProbe === null,
      '14f: probe pointer cleared after first ack');
    assert(errors.length === 0 && securityEvents.length === 0,
      '14f: first ack is clean (no error, no security event)');

    // Replay a second loadAck — same well-formed envelope the router accepts.
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:loadAck',
        sharcNonce: container._rendererProtocolNonce,
        placementSessionId: container.placementSessionId,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    }));
    await new Promise((r) => setTimeout(r, 10));
    const counts = spy();
    assert(counts.dispatched === 2,
      '14f: second loadAck still traverses the router → handler invoked twice');
    assert(counts.resolved === 1,
      '14f: second loadAck does NOT re-resolve a probe (latch dropped it before the pointer check)');
    assert(container._terminated === false,
      '14f: second loadAck did not terminate the container');
    assert(errors.length === 0 && securityEvents.length === 0,
      '14f: second loadAck altered no state — still no error, no security event');

    // The backstop must still bite on a genuine post-render navigation.
    iframe.dispatchEvent(new dom.window.Event('load'));
    await new Promise((r) => setTimeout(r, 140));
    assert(errors.some((e) => e.code === ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION),
      '14f: a real navigation after the consumed ack STILL fires 2118 (ack did not disarm the backstop)');
    assert(container._terminated === true,
      '14f: real navigation after consumed ack terminates the container');
  }

  // 14g — A stray / forged loadAck arriving while the router is in
  //       `creative-active` with NO probe pending is inert: no probe to
  //       resolve, latch untouched, no state change. (The router accepts the
  //       phase by design — `creative-active` is retained in the loadAck phase
  //       list because a legitimate FIRST ack can land there in permissive
  //       mode; see 14i. The single-consume + null-pointer handler is what
  //       neutralizes the stray.)
  {
    const { container, errors, securityEvents } = await buildPostRender();
    const iframe = container._iframe;
    // Drive the router into the steady-state phase without firing an iframe
    // load (so no first-load probe is ever armed).
    container.protocolRouter.transitionTo('creative-active');
    assert(container.protocolRouter.getPhase() === 'creative-active',
      '14g: router is in creative-active (sanity)');
    assert(container._pendingLoadProbe === null,
      '14g: no probe pending (no iframe load fired)');
    const spy = spyLoadAckDispatch(container);
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:loadAck',
        sharcNonce: container._rendererProtocolNonce,
        placementSessionId: container.placementSessionId,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    }));
    await new Promise((r) => setTimeout(r, 10));
    const counts = spy();
    assert(counts.dispatched === 1,
      '14g: stray creative-active loadAck traverses the router (phase is accepted by design)');
    assert(counts.resolved === 0,
      '14g: stray loadAck resolved no probe (none pending) → inert');
    assert(container._loadAckConsumed === false,
      '14g: stray loadAck (no probe) did NOT latch _loadAckConsumed — leaves the real first ack able to consume later');
    assert(container._terminated === false && errors.length === 0 && securityEvents.length === 0,
      '14g: stray creative-active loadAck changed no state');
  }

  // 14h — The legitimate first-load handshake still works AND the late-but-
  //       first ack (arriving within the 100ms probe window) still resolves.
  //       Here we delay the ack ~70ms (< 100ms timeout) after the load that
  //       arms the probe, then confirm it resolves rather than timing out.
  {
    const { container, errors, securityEvents } = await buildPostRender();
    const iframe = container._iframe;
    const spy = spyLoadAckDispatch(container);
    // Fire the expected document.write load → arms + posts the probe.
    iframe.dispatchEvent(new dom.window.Event('load'));
    assert(typeof container._pendingLoadProbe === 'function',
      '14h: probe armed after the post-:rendered load');
    // Late, but still inside the 100ms probe window.
    await new Promise((r) => setTimeout(r, 70));
    assert(typeof container._pendingLoadProbe === 'function',
      '14h: probe still pending at 70ms (inside the 100ms window — has not timed out)');
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:loadAck',
        sharcNonce: container._rendererProtocolNonce,
        placementSessionId: container.placementSessionId,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    }));
    await new Promise((r) => setTimeout(r, 10));
    const counts = spy();
    assert(counts.resolved === 1,
      '14h: late-but-first loadAck (70ms) STILL resolves the probe — single-consume guard does not reject the legitimate first ack');
    assert(container._loadAckConsumed === true,
      '14h: late-but-first loadAck latched _loadAckConsumed');
    assert(container._terminated === false && errors.length === 0 && securityEvents.length === 0,
      '14h: late-but-first ack is the clean document.write completion (no 2118, no timeout)');
  }

  // 14i — Fail-for-the-right-reason: with the single-consume latch defeated,
  //       a second loadAck WOULD wrongly re-resolve a (re-armed) probe. We
  //       prove the test in 14f is load-bearing by simulating the
  //       pre-#269 behavior: re-arm `_pendingLoadProbe` after the first ack
  //       and dispatch a second ack BOTH with and without the latch.
  {
    const { container } = await buildPostRender();
    const iframe = container._iframe;
    await verifyFirstLoadProbe(container);
    assert(container._loadAckConsumed === true,
      '14i: latch set after first ack (precondition)');

    // Re-arm a probe (a refactor or replay could leave a probe pointer set).
    let reResolved = 0;
    container._pendingLoadProbe = () => { reResolved += 1; };

    // WITH the latch in place: the guard drops the ack before the pointer check.
    container._dispatchRendererLoadAck();
    assert(reResolved === 0,
      '14i: WITH _loadAckConsumed latch — re-armed probe is NOT re-resolved (the guard under test)');
    assert(container._pendingLoadProbe !== null,
      '14i: WITH latch — re-armed probe pointer left untouched');

    // Defeat the latch (the pre-#269 state) and dispatch again — now the
    // re-armed probe WOULD be re-resolved. This is exactly the regression the
    // latch prevents; the assertion bites if the guard is removed from
    // `_dispatchRendererLoadAck`.
    container._loadAckConsumed = false;
    container._dispatchRendererLoadAck();
    assert(reResolved === 1,
      '14i: WITHOUT the latch — a second loadAck DOES re-resolve a re-armed probe (proves the latch is load-bearing)');
  }

  // 14j — Positive complement to 14g: a LEGITIMATE first-load `loadAck` that
  //       arrives while the router phase is `creative-active` RESOLVES the
  //       probe. This is the exact property that justifies leaving
  //       `creative-active` in the loadAck phase list (PR #272 deliberately
  //       did NOT narrow the gate). 14g pins that a *stray* ack in
  //       `creative-active` is inert; here a *pending-probe* ack in
  //       `creative-active` is honored.
  //
  //       Establishing the precondition (permissive mode, `requireSharcInit:
  //       false`):
  //         1. `:rendered` → `_onRendererRendered` pokes the HtmlAdapter's
  //            `_maybeAdvanceToActive`, which (permissive mode + iframe-load
  //            seen) fires `setState(ACTIVE)` → router `creative-active`.
  //         2. The document.write-completion iframe `load` arms + posts the
  //            first-load probe. That same load re-runs the renderer-protocol
  //            load handler, which `transitionTo('attaching-renderer')` — so
  //            the probe is armed in `attaching-renderer`, NOT `creative-active`.
  //         3. The creative scrolls out and back into view: an ACTIVE → PASSIVE
  //            → ACTIVE round-trip re-fires `setState(ACTIVE)`, which
  //            re-transitions the router to `creative-active` WHILE the probe
  //            is still pending. (A bare re-`setState(ACTIVE)` is a no-op once
  //            already ACTIVE — the demotion/promotion is what re-fires the
  //            `creative-active` transition.)
  //         4. The renderer's first `loadAck` now lands in `creative-active`.
  //       We assert the phase precondition at the dispatch point so the test
  //       cannot pass for the wrong reason (e.g. resolving in
  //       `attaching-renderer`).
  {
    const { container, errors, securityEvents } = await buildPostRender({
      requireSharcInit: false,
    });
    const iframe = container._iframe;
    // Permissive mode advanced the container to ACTIVE during `:rendered`.
    assert(container.getState() === ContainerStates.ACTIVE,
      '14j: permissive mode advanced the container to ACTIVE on :rendered');
    assert(container.protocolRouter.getPhase() === 'creative-active',
      '14j: router is in creative-active after :rendered (permissive-mode precondition)');

    const spy = spyLoadAckDispatch(container);
    // document.write-completion load arms + posts the first-load probe. This
    // load also re-runs the renderer-protocol load handler → attaching-renderer.
    iframe.dispatchEvent(new dom.window.Event('load'));
    assert(typeof container._pendingLoadProbe === 'function',
      '14j: first-load probe armed by the document.write-completion load');
    assert(container.protocolRouter.getPhase() === 'attaching-renderer',
      '14j: arming load re-set the router to attaching-renderer (probe armed there, not creative-active)');

    // Creative scrolls out and back into view: ACTIVE → PASSIVE → ACTIVE
    // re-fires setState(ACTIVE) → router back to creative-active, probe still
    // pending. This is the legitimate in-protocol path that lands a first
    // loadAck in creative-active.
    container.setState(ContainerStates.PASSIVE);
    container.setState(ContainerStates.ACTIVE);
    assert(container.protocolRouter.getPhase() === 'creative-active',
      '14j: visibility round-trip re-entered creative-active while the probe is pending (precondition pinned)');
    assert(typeof container._pendingLoadProbe === 'function',
      '14j: probe is STILL pending at the moment the router is creative-active (not yet resolved)');
    assert(container._loadAckConsumed === false,
      '14j: latch not yet set — the legitimate first ack has not arrived');

    // Deliver a VALID first loadAck while the router is in creative-active.
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:loadAck',
        sharcNonce: container._rendererProtocolNonce,
        placementSessionId: container.placementSessionId,
        rendererOrigin: RENDERER_ORIGIN,
      },
      origin: RENDERER_ORIGIN,
      source: iframe.contentWindow,
    }));
    await new Promise((r) => setTimeout(r, 10));
    const counts = spy();
    assert(counts.resolved === 1,
      '14j: legitimate first loadAck in creative-active RESOLVES the probe (the property that keeps creative-active in the phase list)');
    assert(container._loadAckConsumed === true,
      '14j: the creative-active first loadAck latched _loadAckConsumed === true');
    assert(container._pendingLoadProbe === null,
      '14j: probe pointer cleared after the creative-active ack resolved it');
    assert(container._terminated === false && errors.length === 0 && securityEvents.length === 0,
      '14j: the creative-active first ack is clean (no 2118, no timeout, no termination)');
  }

  flushContainers();
}

// -- 15. Structured onSecurityEvent emission across chokepoint paths
{
  console.log('\n15. Structured onSecurityEvent emission across chokepoint paths');

  // Helper: build a Markup container with onSecurityEvent + onError spies.
  function buildSpyContainer(opts = {}) {
    const slot = freshSlot();
    const errors = [];
    const securityEvents = [];
    const ordering = []; // tracks 'security'/'error' fire order
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 50, rendererReply: 50, closeSequence: 50 },
      onError: (code, msg) => {
        errors.push({ code, msg });
        ordering.push('error');
      },
      onSecurityEvent: (event) => {
        securityEvents.push(event);
        ordering.push('security');
      },
      ...opts,
    }));
    return { container: c, errors, securityEvents, ordering };
  }

  // 15a — `:failed` → onSecurityEvent({ type: 'renderer_failed', ... }) fires
  //       BEFORE onError. The RAW renderer-supplied reason flows through to
  //       details.reason (sanitization is dev-channel-only).
  {
    const { container, errors, securityEvents, ordering } = buildSpyContainer({
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
    });
    container.load();
    await container.protocolRouter.ready('SHARC:Renderer:');
    container._iframe.contentWindow.postMessage = () => {};
    container._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    console.error = () => {};
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          // Include a control-char to verify the dev-channel sanitizes it but
          // the structured channel preserves it (RAW per Phase D contract).
          reason: 'creative_blocked\nby_policy',
        },
        origin: RENDERER_ORIGIN,
        source: container._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const securityEvent = securityEvents.find((e) => e.type === 'renderer_failed');
    assert(securityEvent != null,
      ':failed → onSecurityEvent fires with type=renderer_failed');
    assert(securityEvent && securityEvent.severity === 'error',
      'renderer_failed event severity === "error"');
    assert(securityEvent && securityEvent.errorCode === ErrorCodes.RENDERER_FAILED,
      'renderer_failed event errorCode === 2115');
    assert(securityEvent && securityEvent.details
      && securityEvent.details.reason === 'creative_blocked\nby_policy',
      'renderer_failed event.details.reason is RAW (control-char preserved — operators get fidelity)');
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_FAILED,
      ':failed → onError still fires with RENDERER_FAILED (2115)');
    // Spec ordering: onSecurityEvent BEFORE onError.
    assert(ordering[0] === 'security' && ordering[1] === 'error',
      'spec ordering: onSecurityEvent fires BEFORE onError (proposal § Security Model line 734)');
  }

  // 15b — Origin echo mismatch → onSecurityEvent({ type: 'renderer_origin_mismatch',
  //       errorCode: 2116, details.{expectedOrigin,actualOrigin} }).
  //       Verifies the renderer-supplied actualOrigin is preserved RAW.
  {
    const { container, securityEvents } = buildSpyContainer({
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
    });
    container.load();
    await container.protocolRouter.ready('SHARC:Renderer:');
    container._iframe.contentWindow.postMessage = () => {};
    container._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    console.error = () => {};
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:rendered',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          rendererOrigin: 'https://cdn.example.com',
        },
        origin: RENDERER_ORIGIN,
        source: container._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const securityEvent = securityEvents.find((e) => e.type === 'renderer_origin_mismatch');
    assert(securityEvent != null,
      'origin echo mismatch → onSecurityEvent fires with type=renderer_origin_mismatch');
    assert(securityEvent && securityEvent.errorCode === ErrorCodes.RENDERER_ORIGIN_MISMATCH,
      'renderer_origin_mismatch event errorCode === 2116');
    assert(securityEvent && securityEvent.details.expectedOrigin === RENDERER_ORIGIN,
      'renderer_origin_mismatch event.details.expectedOrigin === construction-time origin');
    assert(securityEvent && securityEvent.details.actualOrigin === 'https://cdn.example.com',
      'renderer_origin_mismatch event.details.actualOrigin === renderer-reported origin (RAW)');
  }

  // 15c — Malformed `:rendered` → onSecurityEvent({ type: 'renderer_protocol_error',
  //       errorCode: 2117, details: { subtype: 'malformed_payload', reason: ... }}).
  {
    const { container, securityEvents } = buildSpyContainer({
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
    });
    container.load();
    await container.protocolRouter.ready('SHARC:Renderer:');
    container._iframe.contentWindow.postMessage = () => {};
    container._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    console.error = () => {};
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:rendered',
          placementSessionId: container.placementSessionId,
        sharcNonce: container._rendererProtocolNonce,
          // Missing rendererOrigin → malformed payload.
        },
        origin: RENDERER_ORIGIN,
        source: container._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const securityEvent = securityEvents.find((e) => e.type === 'renderer_protocol_error');
    assert(securityEvent != null,
      'malformed :rendered → onSecurityEvent fires with type=renderer_protocol_error');
    assert(securityEvent && securityEvent.errorCode === ErrorCodes.RENDERER_PROTOCOL_ERROR,
      'renderer_protocol_error event errorCode === 2117');
    assert(securityEvent && securityEvent.details.subtype === 'malformed_payload',
      'renderer_protocol_error event.details.subtype === "malformed_payload"');
    assert(securityEvent && securityEvent.details.reason === 'rendered_missing_renderer_origin',
      'renderer_protocol_error event.details.reason names the specific malformed-shape failure');
  }

  // 15d — Internal-type → spec-type mapping: a `renderer_protocol_timeout`
  //       internal failure (rendererLoad timeout) must surface on the
  //       structured channel as type=`renderer_protocol_error` (the spec's
  //       five-event vocabulary doesn't include `timeout` as a distinct
  //       type — proposal § Security Model line 715–723). The `details`
  //       carries a subtype to distinguish.
  {
    const { container, securityEvents } = buildSpyContainer({
      timeouts: { rendererLoad: 30, rendererReply: 30, closeSequence: 50 },
    });
    container.load();
    await container.protocolRouter.ready('SHARC:Renderer:');
    container._iframe.contentWindow.postMessage = () => {};
    // Do NOT fire iframe 'load' — the rendererLoad timeout will fire.
    const originalError = console.error;
    console.error = () => {};
    try {
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      console.error = originalError;
    }
    const securityEvent = securityEvents.find((e) => e.type === 'renderer_protocol_error'
      && e.details && e.details.subtype === 'timeout');
    assert(securityEvent != null,
      'rendererLoad timeout → structured-channel type maps to "renderer_protocol_error" (spec vocabulary)');
    assert(securityEvent && securityEvent.errorCode === ErrorCodes.RENDERER_TIMEOUT,
      'rendererLoad timeout structured event errorCode === 2114 (RENDERER_TIMEOUT — distinct from 2117)');
    assert(securityEvent && securityEvent.details.reason === 'iframe_load',
      'rendererLoad timeout structured event details.reason === "iframe_load"');
  }

  // 15e — `renderer_protocol_post_failed` (postMessage threw) also maps to
  //       `renderer_protocol_error` on the structured channel, with
  //       details.subtype === 'post_failed' and errorCode === 2119. (We
  //       trigger it by stubbing contentWindow.postMessage to throw.)
  {
    const { container, securityEvents } = buildSpyContainer({
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
    });
    container.load();
    await container.protocolRouter.ready('SHARC:Renderer:');
    container._iframe.contentWindow.postMessage = () => {
      throw new Error('synthetic DataCloneError');
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      container._iframe.dispatchEvent(new dom.window.Event('load'));
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const securityEvent = securityEvents.find((e) => e.type === 'renderer_protocol_error'
      && e.details && e.details.subtype === 'post_failed');
    assert(securityEvent != null,
      'postMessage throw → structured-channel type === "renderer_protocol_error" (subtype="post_failed")');
    assert(securityEvent && securityEvent.errorCode === ErrorCodes.RENDERER_POST_FAILED,
      'postMessage throw structured event errorCode === 2119 (RENDERER_POST_FAILED)');
    assert(securityEvent && securityEvent.details.reason === 'synthetic DataCloneError',
      'postMessage throw structured event details.reason === underlying error message');
  }
  flushContainers();
}

// -- 16. placementSessionId prefix in console.error / console.warn (F1)
{
  console.log('\n16. placementSessionId prefix in console.error / console.warn (F1)');

  // 16a — Renderer-protocol terminate path: the chokepoint emits
  //       `[SHARCContainer] [<placementSessionId>] [<internalType>] <message>`.
  //       Locks in the Phase D F1 prefix change.
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          reason: 'banner_404',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const sid = c.placementSessionId;
    const failureLog = errorOutput.find((s) => /\[renderer_failed\]/.test(s)) || '';
    assert(failureLog.includes('[' + sid + ']'),
      'console.error includes the [<placementSessionId>] segment (Phase D F1)');
    // Order matters for greppability — `[SHARCContainer] [<sid>] [<type>]`.
    assert(/\[SHARCContainer\] \[[a-f0-9-]+\] \[renderer_failed\]/.test(failureLog),
      'console.error format: [SHARCContainer] [<placementSessionId>] [<internalType>] (order locked in)');
  }

  // 16b — Multi-line origin-mismatch log: every prefix-tagged console.error
  //       line under the chokepoint inherits the same `[<placementSessionId>]`
  //       segment. The origin-mismatch log is the most visible multi-line
  //       case (Expected/Actual origin lines + see-link); locks in that
  //       the [<sid>] prefix lands on the chokepoint's emit, not on every
  //       log line of the multi-line message body.
  {
    const errors = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: (code, msg) => errors.push({ code, msg }),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:rendered',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          rendererOrigin: 'https://cdn.example.com',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const sid = c.placementSessionId;
    const mismatchLog = errorOutput.find((s) => /\[renderer_origin_mismatch\]/.test(s)) || '';
    assert(/\[SHARCContainer\] \[[a-f0-9-]+\] \[renderer_origin_mismatch\]/.test(mismatchLog),
      'origin-mismatch console.error format: [SHARCContainer] [<sid>] [<type>] (order locked in)');
    assert(mismatchLog.includes('[' + sid + ']'),
      'origin-mismatch console.error includes the SAME placementSessionId in the prefix');
  }
  flushContainers();
}

// -- 17. onSecurityEvent error-handling contract + re-entrancy
{
  console.log('\n17. onSecurityEvent error-handling contract + re-entrancy');

  // 17a — Throwing onSecurityEvent callback does NOT prevent termination.
  //       Per spec § Security Model line 729, the container catches, logs
  //       via console.error, and proceeds with its planned action. onError
  //       MUST still fire.
  {
    const errors = [];
    let securityCallbackCalls = 0;
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: (code, msg) => errors.push({ code, msg }),
      onSecurityEvent: (event) => {
        securityCallbackCalls++;
        void event;
        throw new Error('synthetic handler failure');
      },
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          reason: 'baseline_failure',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(securityCallbackCalls === 1,
      'throwing handler still received the call (one invocation)');
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_FAILED,
      'throwing onSecurityEvent does NOT prevent onError firing — container action proceeds');
    assert(c._terminated === true,
      'throwing onSecurityEvent does NOT prevent termination — container ends up terminated');
    assert(errorOutput.some((s) => /onSecurityEvent callback threw; continuing/.test(s)),
      'throwing onSecurityEvent → console.error reports the handler failure');
  }

  // 17b — Spec § Security Model line 729: the catch log must NOT include
  //       the original event payload (defense against a malicious throwing
  //       handler exfiltrating into adjacent error-tracking pipelines).
  {
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: () => {},
      onSecurityEvent: () => { throw new Error('handler failure'); },
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          // A unique sentinel string the test will verify is NOT
          // surfaced in the catch log.
          reason: 'SENTINEL_REASON_DO_NOT_LOG',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const catchLog = errorOutput.find((s) => /onSecurityEvent callback threw/.test(s)) || '';
    assert(catchLog.length > 0, 'catch log was emitted (precondition for the next assertion)');
    assert(!catchLog.includes('SENTINEL_REASON_DO_NOT_LOG'),
      'catch log does NOT include the original event details payload (spec line 729)');
  }

  // 17c — Re-entrancy: a second chokepoint call AFTER the first sets
  //       `_terminated=true` is a no-op. onSecurityEvent + onError fire
  //       exactly ONCE despite two terminating events arriving for the
  //       same container.
  {
    const errors = [];
    const securityEvents = [];
    const slot = freshSlot();
    const c = track(new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: (code, msg) => errors.push({ code, msg }),
      onSecurityEvent: (event) => securityEvents.push(event),
    }));
    c.load();
    await c.protocolRouter.ready('SHARC:Renderer:');
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    console.error = () => {};
    try {
      // First terminating event
      window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: c.placementSessionId,
        sharcNonce: c._rendererProtocolNonce,
          reason: 'first_failure',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      }));
      await new Promise((r) => setTimeout(r, 60));
      // Second terminating event AFTER `_terminated` flips. The chokepoint
      // _terminated guard must short-circuit; structured event must NOT
      // double-fire.
      c._emitSecurityEventAndTerminate(
        'renderer_origin_mismatch',
        ErrorCodes.RENDERER_ORIGIN_MISMATCH,
        'second event after termination',
        { expectedOrigin: RENDERER_ORIGIN, actualOrigin: 'https://impostor.example' }
      );
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      console.error = originalError;
    }
    assert(errors.length === 1,
      're-entrancy: onError fires exactly once despite two terminating events');
    assert(securityEvents.length === 1,
      're-entrancy: onSecurityEvent fires exactly once despite two terminating events');
    assert(securityEvents[0].type === 'renderer_failed',
      're-entrancy: only the FIRST event landed (renderer_failed); second was suppressed by _terminated guard');
  }
  flushContainers();
}

// =========================================================================
// Phase E — section 18 (Creative URL load-event backstop)
// =========================================================================

// -- 18. Creative URL variant — load-event navigation backstop → 2118 ('url')
{
  console.log('\n18. Creative URL variant — load-event backstop → RENDERER_UNAUTHORIZED_NAVIGATION (2118, variant=url)');

  // Helper: build a Creative URL container, fire the initial iframe `load`
  // event, wait for the post-load arm-backstop seam to settle. Returns the
  // wired-up container ready for second-load probes. Mirrors the Markup
  // variant's `buildPostRender` helper from section 14.
  async function buildPostUrlLoad(opts = {}) {
    const slot = freshSlot();
    const errors = [];
    const securityEvents = [];
    const c = track(new SHARCContainer({
      creativeUrl: 'https://ads.example/creative.html',
      placementElement: slot,
      onError: (code, msg) => errors.push({ code, msg }),
      onSecurityEvent: (event) => securityEvents.push(event),
      ...opts,
    }));
    c.load();
    // URL variant doesn't register the renderer protocol.
    // Stub postMessage so the deferred initChannel doesn't fire into a real
    // contentWindow during the test (the URL variant wires MessageChannel
    // 200ms after load — irrelevant to the backstop assertions).
    c._iframe.contentWindow.postMessage = () => {};
    // First (and only-expected) iframe load: arms the backstop synchronously
    // in the URL variant's load listener.
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    // Yield so the arm-on-first-load handler completes.
    await new Promise((r) => setTimeout(r, 5));
    return { container: c, slot, errors, securityEvents };
  }

  // 18a — Backstop is armed after the FIRST load event in the URL variant.
  //       The render-anchor timestamp (`_renderedAt`) is also stamped so
  //       msSinceRender will be a number on subsequent fires.
  {
    const { container } = await buildPostUrlLoad();
    assert(typeof container._rendererBackstopHandler === 'function',
      'URL: post-initial-load: load-event backstop is attached');
    assert(typeof container._renderedAt === 'number',
      'URL: post-initial-load: _renderedAt stamped (Date.now timestamp)');
    assert(container.creativeSource === 'url',
      'URL: creativeSource === "url" (sanity — variant detection in backstop fire)');
    assert(container.creativeRendered === false,
      'URL: creativeRendered remains false (renderer protocol is Markup-only)');
  }

  // 18b — Subsequent load event after the initial → 2118 + onSecurityEvent
  //       fires with type=`unauthorized_navigation`, details.variant === 'url',
  //       details.msSinceRender >= 0. console.error includes
  //       `[unauthorized_navigation]` and the URL-variant phrasing.
  {
    const { container, errors, securityEvents } = await buildPostUrlLoad();
    const iframe = container._iframe;
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      // Simulate the iframe navigating: dispatch a second `load` event.
      // (jsdom never actually navigates the cross-origin iframe; we
      // synthesize the event the browser would have fired.)
      iframe.dispatchEvent(new dom.window.Event('load'));
      // Allow the chokepoint's onSecurityEvent + console.error +
      // handleFatalError to drain.
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION,
      'URL: second iframe `load` post-initial-load → onError(RENDERER_UNAUTHORIZED_NAVIGATION) (code 2118)');
    assert(container._terminated === true,
      'URL: second iframe `load` post-initial-load → container terminated');
    assert(errorOutput.some((s) => /\[unauthorized_navigation\]/.test(s)),
      'URL: second iframe `load` post-initial-load → console.error tagged [unauthorized_navigation]');
    assert(errorOutput.some((s) => /Creative URL iframe navigated post-render/.test(s)),
      'URL: second iframe `load` post-initial-load → console.error names URL-variant phrasing');

    // onSecurityEvent fired with the discriminated payload — Phase E
    // widens the variant to 'markup' | 'url' (typedef + consumer probe).
    const navEvent = securityEvents.find((e) => e.type === 'unauthorized_navigation');
    assert(navEvent != null,
      'URL: second iframe `load` post-initial-load → onSecurityEvent fires with type=unauthorized_navigation');
    assert(navEvent && navEvent.severity === 'error',
      'URL: unauthorized_navigation event severity === "error"');
    assert(navEvent && navEvent.errorCode === ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION,
      'URL: unauthorized_navigation event errorCode === 2118');
    assert(navEvent && navEvent.details && navEvent.details.variant === 'url',
      'URL: unauthorized_navigation event.details.variant === "url" (Phase E widening)');
    // msSinceRender semantics: Markup anchors on `:rendered` accept; URL
    // anchors on the initial iframe `load`. Field name preserved across
    // variants for grep-stable operator dashboards.
    assert(navEvent && navEvent.details && typeof navEvent.details.msSinceRender === 'number',
      'URL: unauthorized_navigation event.details.msSinceRender is a number');
    assert(navEvent && navEvent.details && navEvent.details.msSinceRender >= 0,
      'URL: unauthorized_navigation event.details.msSinceRender is >= 0 (no clock-skew negative)');
    assert(errorOutput.some((s) => /Creative URL iframe navigated post-render after \d+ms/.test(s)),
      'URL: console.error names msSinceRender in the timing-aware message');
    assert(errorOutput.some((s) => /redirect-injection patterns/.test(s)),
      'URL: console.error names redirect-injection diagnostic hint');
    assert(navEvent && navEvent.placementSessionId === container.placementSessionId,
      'URL: unauthorized_navigation event.placementSessionId correlates back to container');
    assert(navEvent && typeof navEvent.timestamp === 'number',
      'URL: unauthorized_navigation event.timestamp is a number (Date.now)');
  }

  // 18c — Backstop detached on _terminate (URL variant). Mirrors 14c.
  {
    const { container } = await buildPostUrlLoad();
    assert(container._rendererBackstopHandler !== null,
      'URL: pre-terminate: backstop handler is non-null');
    container.close();
    await new Promise((r) => setTimeout(r, 80));
    assert(container._rendererBackstopHandler === null,
      'URL: post-terminate: backstop handler is nulled out (defense-in-depth detach)');
  }

  // 18d — Re-entrancy: a backstop fire on an already-terminated URL
  //       container is a no-op (the chokepoint's `_terminated` guard
  //       short-circuits). Mirrors 14d.
  {
    const { container, errors, securityEvents } = await buildPostUrlLoad();
    const handler = container._rendererBackstopHandler;
    container._emitSecurityEventAndTerminate(
      'renderer_failed',
      ErrorCodes.RENDERER_FAILED,
      'baseline failure for URL-variant re-entrancy probe',
      { reason: 'baseline' }
    );
    await new Promise((r) => setTimeout(r, 60));
    const errorsBefore = errors.length;
    const eventsBefore = securityEvents.length;
    if (typeof handler === 'function') handler(new dom.window.Event('load'));
    await new Promise((r) => setTimeout(r, 30));
    assert(errors.length === errorsBefore,
      'URL: backstop fire on terminated container → onError NOT re-fired');
    assert(securityEvents.length === eventsBefore,
      'URL: backstop fire on terminated container → onSecurityEvent NOT re-fired');
  }

  // 18e — The arm-on-first-load handler is one-shot — a stray duplicate
  //       initial `load` (rare; some hosts double-fire on cache hits)
  //       does NOT re-arm, re-stamp `_renderedAt`, or fire 2118. The
  //       second load goes through the backstop (which is what fires).
  //       This locks in the `initialLoadHandled` flag's idempotency.
  {
    const slot = freshSlot();
    const errors = [];
    const securityEvents = [];
    const c = track(new SHARCContainer({
      creativeUrl: 'https://ads.example/creative.html',
      placementElement: slot,
      onError: (code, msg) => errors.push({ code, msg }),
      onSecurityEvent: (event) => securityEvents.push(event),
    }));
    c.load();
    // URL variant — no renderer protocol registered.
    c._iframe.contentWindow.postMessage = () => {};
    // First load: arms backstop, stamps _renderedAt.
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    await new Promise((r) => setTimeout(r, 5));
    const stampedAt = c._renderedAt;
    assert(typeof stampedAt === 'number',
      'URL: first load stamped _renderedAt');
    // Second load: this is the unauthorized navigation — should fire 2118
    // with msSinceRender computed against the FIRST load's stamp, not
    // re-stamped against this load.
    const originalError = console.error;
    console.error = () => {};
    try {
      // Wait long enough that any wrong "re-stamp" would zero msSinceRender.
      await new Promise((r) => setTimeout(r, 20));
      c._iframe.dispatchEvent(new dom.window.Event('load'));
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.error = originalError;
    }
    const navEvent = securityEvents.find((e) => e.type === 'unauthorized_navigation');
    assert(navEvent != null,
      'URL: idempotency probe — second load fires 2118 (sanity)');
    assert(navEvent && navEvent.details.msSinceRender >= 20,
      'URL: idempotency probe — msSinceRender reflects FIRST load anchor (>=20ms), not re-stamped on second load');
    // Defensive: only one nav event fired (the second-load fire), even
    // though the backstop is still armed if the chokepoint races.
    assert(securityEvents.filter((e) => e.type === 'unauthorized_navigation').length === 1,
      'URL: idempotency probe — exactly one unauthorized_navigation event fired');
  }
  flushContainers();
}

// -- 19. creativeRendererIntegrity preflight (#24) ────────────────────────
{
  console.log('\n19. creativeRendererIntegrity preflight');
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const rendererDoc = '<!doctype html><html><body>renderer v1</body></html>';
  const validIntegrity = await sha384Sri(rendererDoc);

  function mockFetchWith(body, responseOverrides = {}) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: RENDERER_URL,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      ...responseOverrides,
    });
  }

  try {
    // Positive path: no iframe navigation and no render post happen until the
    // preflight fetch + SHA-384 comparison succeeds.
    {
      mockFetchWith(rendererDoc);
      const captured = { posts: [] };
      const c = track(new SHARCContainer(markupOptions({
        creativeRendererIntegrity: validIntegrity,
        timeouts: { rendererLoad: 50, rendererReply: 50 },
      })));
      c.load();
      await c.protocolRouter.ready('SHARC:Renderer:');
      const iframe = c._iframe;
      iframe.contentWindow.postMessage = (data, targetOrigin) => {
        captured.posts.push({ data, targetOrigin });
      };
      assert(iframe.getAttribute('src') === null,
        'integrity positive: iframe.src is not assigned synchronously');
      // Wait on the real signal — production assigns iframe.src only after the
      // crypto.subtle.digest preflight resolves (sharc-container.js
      // _loadVerifiedRendererIframe), so a non-empty src means the render path
      // is wired. Polling this instead of a fixed delay removes the digest race.
      await waitFor(() => c._iframe && c._iframe.getAttribute('src'),
        { message: 'integrity-positive iframe.src assignment' });
      assert(iframe.getAttribute('src') && iframe.getAttribute('src').startsWith(RENDERER_URL + '#sharcNonce='),
        'integrity positive: iframe.src assigned after digest match');
      iframe.contentWindow.postMessage = (data, targetOrigin) => {
        captured.posts.push({ data, targetOrigin });
      };
      iframe.dispatchEvent(new dom.window.Event('load'));
      assert(captured.posts.length === 1,
        'integrity positive: SHARC:Renderer:render posts after verified load');
      assert(captured.posts[0].data.type === 'SHARC:Renderer:render',
        'integrity positive: posted message is renderer render');
      flushContainers();
    }

    // Negative path: mismatch terminates before iframe.src assignment, so the
    // renderer never receives SHARC:Renderer:render.
    {
      mockFetchWith(rendererDoc + '<!-- tampered -->');
      const errors = [];
      const securityEvents = [];
      const captured = { posts: [] };
      console.error = () => {};
      const c = track(new SHARCContainer(markupOptions({
        creativeRendererIntegrity: validIntegrity,
        timeouts: { rendererLoad: 50, rendererReply: 50 },
        onError: (code, msg) => errors.push({ code, msg }),
        onSecurityEvent: (event) => securityEvents.push(event),
      })));
      c.load();
      await c.protocolRouter.ready('SHARC:Renderer:');
      const iframe = c._iframe;
      iframe.contentWindow.postMessage = (data, targetOrigin) => {
        captured.posts.push({ data, targetOrigin });
      };
      // Same digest race as the positive block: the preflight digest resolves
      // and rejects on mismatch, firing onError. iframe.src stays null here, so
      // the deterministic signal is the error callback, not src.
      await waitFor(() => errors.length > 0,
        { message: 'integrity-mismatch onError' });
      assert(errors.length === 1 && errors[0].code === ErrorCodes.RENDERER_INTEGRITY_FAIL,
        'integrity mismatch: onError receives RENDERER_INTEGRITY_FAIL (2120)');
      assert(securityEvents[0] && securityEvents[0].type === 'renderer_protocol_error',
        'integrity mismatch: onSecurityEvent maps to renderer_protocol_error');
      assert(securityEvents[0] && securityEvents[0].details.subtype === 'integrity_failed',
        'integrity mismatch: security event details.subtype === integrity_failed');
      assert(captured.posts.length === 0,
        'integrity mismatch: SHARC:Renderer:render is never posted');
      assert(iframe.getAttribute('src') === null,
        'integrity mismatch: iframe.src is never assigned');
      flushContainers();
    }

    // Stalled verification fetch: the preflight shares the rendererLoad budget
    // so integrity-enabled placements cannot remain loading forever before the
    // normal iframe-load timeout has a chance to arm.
    {
      globalThis.fetch = () => new Promise(() => {});
      const errors = [];
      const securityEvents = [];
      const captured = { posts: [] };
      console.error = () => {};
      const c = track(new SHARCContainer(markupOptions({
        creativeRendererIntegrity: validIntegrity,
        timeouts: { rendererLoad: 30, rendererReply: 50 },
        onError: (code, msg) => errors.push({ code, msg }),
        onSecurityEvent: (event) => securityEvents.push(event),
      })));
      c.load();
      await c.protocolRouter.ready('SHARC:Renderer:');
      const iframe = c._iframe;
      iframe.contentWindow.postMessage = (data, targetOrigin) => {
        captured.posts.push({ data, targetOrigin });
      };
      // The container's preflight timeout fires at 30ms; waitFor on the error
      // callback is deterministic regardless of event-loop load.
      await waitFor(() => errors.length > 0,
        { timeout: 2000, message: 'integrity-stalled-fetch onError' });
      assert(errors.length === 1 && errors[0].code === ErrorCodes.RENDERER_INTEGRITY_FAIL,
        'integrity stalled fetch: onError receives RENDERER_INTEGRITY_FAIL (2120)');
      assert(errors[0] && /timed out after 30ms/.test(errors[0].msg),
        'integrity stalled fetch: error message names the preflight timeout');
      assert(securityEvents[0] && securityEvents[0].details.subtype === 'integrity_failed',
        'integrity stalled fetch: security event details.subtype === integrity_failed');
      assert(captured.posts.length === 0,
        'integrity stalled fetch: SHARC:Renderer:render is never posted');
      assert(iframe.getAttribute('src') === null,
        'integrity stalled fetch: iframe.src is never assigned');
      flushContainers();
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} creative-sources-load assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All creative-sources-load assertions passed.');
  flushContainers();
}
