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
 * NOT in Phase B+C (defer to Phase D):
 *   Load-event navigation backstop + RENDERER_UNAUTHORIZED_NAVIGATION (2118)
 *   Reference renderer + service-worker detection
 *   Structured `onSecurityEvent` payloads (#62)
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
const protoMod = await import('./dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('./dist/sharc-container.mjs');
const { ErrorCodes, SHARC_VERSION, RENDERER_PROTOCOL_VERSION } = protoMod;

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
function buildAndLoad(options = {}, opts = {}) {
  const {
    respond = true,
    rendererOrigin = RENDERER_ORIGIN,
    tweakRendered = null,
    timeouts = { rendererLoad: 50, rendererReply: 50 },
  } = opts;

  const container = new SHARCContainer({ ...markupOptions(options), timeouts });
  container.load();
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
    let payload = {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: container.placementSessionId,
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
  const { iframe } = buildAndLoad();

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
    const { container, iframe: f } = buildAndLoad({}, { respond: false });
    assert(f.getAttribute('data-sharc-creative-source') === 'html',
      'Markup: iframe stamped with data-sharc-creative-source="html" at attach time');
    assert(f.getAttribute('data-sharc-creative-rendered') === 'false',
      'Markup: iframe stamped with data-sharc-creative-rendered="false" before :rendered');
    // Drive a happy-path :rendered.
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: container.placementSessionId,
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
}

// -- 2. Conditional sandbox tokens — overrides flow through to the attribute
{
  console.log('\n2. Conditional sandbox tokens — overrides flow through');

  // allowPopups: false → both popup tokens absent.
  const a = buildAndLoad({ allowPopups: false }).iframe.getAttribute('sandbox');
  assert(!a.includes('allow-popups'),
    'allowPopups: false strips `allow-popups`');
  assert(!a.includes('allow-popups-to-escape-sandbox'),
    'allowPopups: false also strips `allow-popups-to-escape-sandbox` (bound by DD-21)');

  // allowTopNavigationByUserActivation: false → token absent.
  const b = buildAndLoad({ allowTopNavigationByUserActivation: false }).iframe.getAttribute('sandbox');
  assert(!b.includes('allow-top-navigation-by-user-activation'),
    'allowTopNavigationByUserActivation: false strips token');

  // allowStorageAccessByUserActivation: false → token absent.
  const c = buildAndLoad({ allowStorageAccessByUserActivation: false }).iframe.getAttribute('sandbox');
  assert(!c.includes('allow-storage-access-by-user-activation'),
    'allowStorageAccessByUserActivation: false strips token');

  // allowModals: true → token present.
  const d = buildAndLoad({ allowModals: true }).iframe.getAttribute('sandbox');
  assert(d.includes('allow-modals'),
    'allowModals: true adds `allow-modals` token');

  // allowDownloads: true → token present.
  const e = buildAndLoad({ allowDownloads: true }).iframe.getAttribute('sandbox');
  assert(e.includes('allow-downloads'),
    'allowDownloads: true adds `allow-downloads` token');
}

// -- 3. Iframe src — CSPRNG nonce + creativeRendererUrl assembly
{
  console.log('\n3. Iframe src — CSPRNG nonce + creativeRendererUrl assembly');
  const { container, iframe } = buildAndLoad();
  const src = iframe.getAttribute('src');
  assert(src.startsWith(RENDERER_URL + '#sharcNonce='),
    'iframe.src is creativeRendererUrl + "#sharcNonce=<uuid>"');
  const nonce = src.split('#sharcNonce=')[1];
  const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert(noncePattern.test(nonce),
    'fragment nonce is UUID v4 shape (CSPRNG, NOT Math.random)');
  assert(container._sharcNonce === nonce,
    'container._sharcNonce equals the URL fragment nonce (used in render payload)');
}

// -- 4. _resolvedIframeSrc runtime guard (#65) — extension override is rejected
{
  console.log('\n4. _resolvedIframeSrc runtime guard (#65) — extension override aborts load');

  // 4a — URL variant: extension overrides _resolvedIframeSrc to return an
  // attacker-controlled URL. The runtime guard MUST throw before iframe.src
  // assignment, defending the rule-4..7 origin guarantee.
  {
    const slot = freshSlot();
    const c = new SHARCContainer({
      creativeUrl: 'https://ads.example/creative.html',
      placementElement: slot,
    });
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
  {
    const slot = freshSlot();
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
    });
    c._resolvedIframeSrc = function () { return 'https://attacker.example/evil.html'; };
    assertThrows(
      () => c.load(),
      /Refusing to load/,
      'Markup: extension override of _resolvedIframeSrc aborts load with clear error');
    const iframe = c._iframe;
    assert(!iframe || iframe.getAttribute('src') !== 'https://attacker.example/evil.html',
      'Markup: iframe.src is NOT assigned the attacker-controlled URL');
  }

  // 4c — Markup variant: extension overrides to return the renderer URL but
  // with a forged nonce. Guard catches the mismatch.
  {
    const slot = freshSlot();
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
    });
    c._resolvedIframeSrc = function () {
      // Set _sharcNonce too, so the "no nonce populated" branch doesn't
      // mask the mismatch. This simulates a sloppy attacker who knows the
      // guard checks _sharcNonce.
      this._sharcNonce = 'attacker-controlled-nonce';
      return RENDERER_URL + '#sharcNonce=different-nonce-than-stored';
    };
    assertThrows(
      () => c.load(),
      /Refusing to load/,
      'Markup: extension override returning forged nonce mismatch is rejected');
  }
}

// -- 5. Pre-injection of creativeHtml — synchronous, regardless of useMarkupInjection
{
  console.log('\n5. Pre-injection — synchronous, regardless of useMarkupInjection');

  // 5a — No injectors registered: posted creativeHtml is the original.
  {
    const { container, captured } = buildAndLoad();
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
    const { container, captured } = buildAndLoad({ extensions: [ext1, ext2] });
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
      const { container, captured } = buildAndLoad({ extensions: [ext] });
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
    const aOff = buildAndLoad({ extensions: [ext], useMarkupInjection: false });
    assert(aOff.captured.posts[0].data.creativeHtml.endsWith('<!-- forced -->'),
      'Markup: injection runs even when useMarkupInjection=false');
    const aOn = buildAndLoad({ extensions: [ext], useMarkupInjection: true });
    assert(aOn.captured.posts[0].data.creativeHtml.endsWith('<!-- forced -->'),
      'Markup: injection runs when useMarkupInjection=true');
  }
}

// -- 6. SHARC:Renderer:render postMessage shape + targetOrigin
{
  console.log('\n6. SHARC:Renderer:render postMessage payload + targetOrigin');
  const { container, captured } = buildAndLoad();
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
  assert(data.sharcNonce === container._sharcNonce,
    'render payload sharcNonce matches container._sharcNonce (and URL fragment)');
  assert(data.sharcVersion === SHARC_VERSION,
    'render payload sharcVersion matches SHARC_VERSION');
  assert(data.rendererProtocolVersion === RENDERER_PROTOCOL_VERSION,
    'render payload rendererProtocolVersion matches RENDERER_PROTOCOL_VERSION');
  assert(data.containerOrigin === PUBLISHER_ORIGIN,
    'render payload containerOrigin equals window.location.origin');
}

// -- 7. SHARC:Renderer:rendered envelope validation + bootstrap
{
  console.log('\n7. SHARC:Renderer:rendered envelope validation + bootstrap');

  // 7a — Happy path: container.creativeRendered flips to true.
  {
    const { container } = buildAndLoad();
    assert(container.creativeRendered === true,
      'envelope-valid :rendered → container.creativeRendered === true');
  }

  // 7b — Wrong event.origin: silently ignored, container stays unrendered.
  {
    const { container } = buildAndLoad({}, {
      respond: true,
      rendererOrigin: 'https://impostor.example',
    });
    assert(container.creativeRendered === false,
      'wrong event.origin → :rendered SILENTLY ignored, creativeRendered stays false');
  }

  // 7c — Wrong placementSessionId: silently ignored.
  {
    const { container } = buildAndLoad({}, {
      respond: true,
      tweakRendered: (p) => ({ ...p, placementSessionId: 'forged-id' }),
    });
    assert(container.creativeRendered === false,
      'wrong placementSessionId → :rendered SILENTLY ignored');
  }

  // 7d — Wrong type: silently ignored.
  {
    const { container } = buildAndLoad({}, {
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
    const { container } = buildAndLoad({}, { respond: false });
    // Use the publisher window (which is `global.window` here) as the
    // forged source. Envelope check should reject.
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: container.placementSessionId,
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
    const { container } = buildAndLoad({}, { respond: false });
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
    const { container } = buildAndLoad({}, { respond: false });
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
}

// -- 8. Renderer message listener cleanup — _terminate detaches the handler
{
  console.log('\n8. Renderer message listener cleanup on _terminate');
  const { container } = buildAndLoad({}, { respond: false });
  assert(typeof container._rendererMessageHandler === 'function',
    'message listener is attached during the load window');
  container._terminate();
  assert(container._rendererMessageHandler === null,
    'message listener is detached on _terminate');
  // After terminate, a stale :rendered must not flip creativeRendered.
  const cw = container._iframe;
  // _iframe is null after terminate; just dispatch on window to confirm no-op.
  const evt = new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: container.placementSessionId,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: cw,
  });
  window.dispatchEvent(evt);
  assert(container.creativeRendered === false,
    'stale :rendered after _terminate is ignored (listener was detached)');
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 30, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    // Suppress noisy console.error from _emitSecurityEventAndTerminate.
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      c.load();
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 30 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      c.load();
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    c.load();
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:rendered',
        placementSessionId: c.placementSessionId,
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      c.load();
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
}

// -- 10. Creative URL variant — Phase B does NOT regress the URL load path
{
  console.log('\n10. Creative URL variant — Phase B does NOT regress URL load path');
  const slot = freshSlot();
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/creative.html',
    placementElement: slot,
  });
  c.load();
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
}

// =========================================================================
// Phase C — sections 11/12/13
// =========================================================================

// -- 11. SHARC:Renderer:failed receipt → RENDERER_FAILED (2115)
{
  console.log('\n11. SHARC:Renderer:failed receipt → RENDERER_FAILED (2115)');

  // Helper: build + load a Markup container, stub postMessage, fire iframe
  // 'load', and return primitives the test cases below need.
  function buildForFailedTest(opts = {}) {
    const errors = [];
    const slot = freshSlot();
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, ...(opts.timeouts || {}) },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    c.load();
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    return { container: c, iframe: c._iframe, errors };
  }

  // 11a — Happy-path :failed: terminates with RENDERER_FAILED (2115) and the
  // operator-facing message echoes the renderer-supplied reason.
  {
    const { container, iframe, errors } = buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
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
    const { container, iframe, errors } = buildForFailedTest();
    // Wrong event.origin — envelope check fails, silent ignore.
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:failed',
        placementSessionId: container.placementSessionId,
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
    const { container, errors } = buildForFailedTest();
    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:failed',
        placementSessionId: container.placementSessionId,
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
    const { container, iframe, errors } = buildForFailedTest();
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

  // 11e — :failed clears the rendererReply timeout (no double-terminate from
  //       the timeout firing after the :failed-induced termination).
  //
  // Timing dependency note (pass-1 code review M2): this assertion relies on
  // _terminate running before the rendererReply timeout fires. The chain is:
  // :failed → _emitSecurityEventAndTerminate → _handleFatalError →
  // sendFatalError() rejects synchronously (no MessagePort mid-render) →
  // .catch(_terminate) on next microtask → listener-detach + clear-all
  // timeouts + _terminated=true. All of that completes within microtasks of
  // the dispatch, well before the 60ms rendererReply timeout. The 120ms
  // await then proves the timeout did NOT fire (errors.length stays at 1).
  //
  // If sendFatalError's rejection were ever made async (e.g. queued on a
  // macrotask), this test would race — the rendererReply timeout could
  // fire at 60ms before the terminate-induced clearTimeout ran. Either
  // restore the microtask-rejection invariant or rewrite this test to drive
  // both the :failed dispatch and the timeout assertion inside the same
  // sync block.
  //
  // Note: with Fix 1 (re-entrancy guard at _emitSecurityEventAndTerminate),
  // this test is now ROBUST against the race even if the listener weren't
  // detached in time — the second terminate path (the timeout) would
  // short-circuit on the _terminated guard at the chokepoint. The comment
  // above documents the path future readers should expect; Fix 1 hardens
  // it, but the documented invariant (microtask-sync rejection) is still
  // the cleaner contract to preserve.
  {
    const { container, iframe, errors } = buildForFailedTest({
      timeouts: { rendererLoad: 5000, rendererReply: 60 },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
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
    const { container, iframe, errors } = buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
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
    const { container, iframe, errors } = buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    const longReason = 'A'.repeat(500);
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
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
    const { container, iframe, errors } = buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
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

  // 11i — Re-entrancy guard at _emitSecurityEventAndTerminate.
  // The guard is post-microtask-idempotent: it protects against the realistic
  // case where the browser delivers a second terminating renderer message
  // AFTER microtasks have drained (which is when _terminate's listener-detach
  // and `_terminated = true` would have run). It does NOT claim coverage for
  // synchronous double-dispatch — cross-origin postMessage cannot deliver
  // two messages synchronously, so that scenario doesn't occur in real
  // browser environments.
  //
  // Without this guard: the second :failed would fire `_onError` a second
  // time before the listener was detached. With it: the second message is
  // short-circuited at the chokepoint helper, exactly one `_onError` fires,
  // and Phase D's structured `onSecurityEvent` emission (when wired here)
  // inherits the idempotency contract for free.
  {
    console.log('\n11i. Re-entrancy guard at _emitSecurityEventAndTerminate (post-microtask idempotency)');
    const { container, iframe, errors } = buildForFailedTest();
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      // First :failed — should fire onError once and schedule async _terminate.
      const evt1 = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
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

      // Second :failed in the next tick. Real browsers would deliver this as
      // a separate task; we simulate that by `await`ing first.
      const evt2 = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:failed',
          placementSessionId: container.placementSessionId,
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
    const { container, iframe, errors } = buildForFailedTest();
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
    try {
      const slot = freshSlot();
      const c = new SHARCContainer({
        creativeHtml: CREATIVE_HTML,
        creativeRendererUrl: RENDERER_URL,
        placementElement: slot,
        timeouts: { rendererLoad: 5000, rendererReply: 5000 },
        onError: (code, msg) => (errors = errors || []).push({ code, msg }),
      });
      errors = [];
      c.load();
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
          rendererOrigin: 'https://cdn.example.com',
        },
        origin: RENDERER_ORIGIN,
        source: c._iframe.contentWindow,
      });
      window.dispatchEvent(evt);
      await new Promise((r) => setTimeout(r, 60));

      assert(errors.length >= 1 && errors[0].code === ErrorCodes.RENDERER_ORIGIN_MISMATCH,
        'origin echo mismatch on :rendered → onError(RENDERER_ORIGIN_MISMATCH, …) (code 2116)');
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
      assert(/api-reference\.md#renderer-protocol/.test(joined),
        'console.error includes the api-reference link to the renderer-protocol section');
    } finally {
      console.error = originalError;
    }
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    c.load();
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const payload = probe.mutate({
        type: 'SHARC:Renderer:rendered',
        placementSessionId: c.placementSessionId,
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    c.load();
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    const errorOutput = [];
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    try {
      const payload = probe.mutate({
        type: 'SHARC:Renderer:failed',
        placementSessionId: c.placementSessionId,
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    c.load();
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const originalError = console.error;
    console.error = () => {};
    try {
      const evt = new dom.window.MessageEvent('message', {
        data: {
          type: 'SHARC:Renderer:rendered',
          placementSessionId: c.placementSessionId,
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    c.load();
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
  function buildMidRender() {
    const slot = freshSlot();
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: {
        rendererLoad: 5000,
        rendererReply: 5000,
        closeSequence: 50, // belt-and-suspenders — see comment above
      },
    });
    c.load();
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
    const { container, iframe } = buildMidRender();
    // Snapshot pre-close state — listener is attached, iframe is in the DOM,
    // rendererReply timeout is armed, placement carries the SHARC stamps.
    assert(typeof container._rendererMessageHandler === 'function',
      'pre-close: renderer message listener IS attached during mid-render window');
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

    // 13a.ii — renderer message listener removed (sub-bullet b).
    assert(container._rendererMessageHandler === null,
      'mid-render close: renderer message listener detached (spec sub-bullet b)');

    // 13a.iii — iframe removed from DOM (sub-bullet c).
    assert(container._iframe === null,
      'mid-render close: container._iframe is nulled (spec sub-bullet c)');
    assert(iframe.parentNode === null,
      'mid-render close: iframe is detached from the DOM (spec sub-bullet c)');
  }

  // 13b — Placement element restored to pre-load state (sub-bullet d).
  //       _detachFromPlacement is the existing implementation. Test checks
  //       the SHARC-stamped attributes are gone after close.
  {
    const { container, slot } = buildMidRender();
    // Pre-close: slot carries SHARC placement stamps (the placement-stamping
    // proposal already lands `data-sharc-placement-session-id` on the slot).
    assert(slot.getAttribute('data-sharc-placement-session-id') === container.placementSessionId,
      'pre-close: placement element carries data-sharc-placement-session-id');

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
    const { container, iframe } = buildMidRender();
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
    const c = new SHARCContainer({
      creativeHtml: CREATIVE_HTML,
      creativeRendererUrl: RENDERER_URL,
      placementElement: slot,
      timeouts: { rendererLoad: 5000, rendererReply: 5000, closeSequence: 50 },
      onError: (code, msg) => errors.push({ code, msg }),
    });
    c.load();
    c._iframe.contentWindow.postMessage = () => {};
    c._iframe.dispatchEvent(new dom.window.Event('load'));
    const cwSnapshot = c._iframe.contentWindow;
    c.close();
    await new Promise((r) => setTimeout(r, 80));

    const evt = new dom.window.MessageEvent('message', {
      data: {
        type: 'SHARC:Renderer:failed',
        placementSessionId: c.placementSessionId,
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
  //       sharc-container.js:866; locking it in.)
  {
    const { container } = buildMidRender();
    container.close();
    await new Promise((r) => setTimeout(r, 80));
    const terminatedAfterFirst = container._terminated;
    // Second close — no throw, no double-terminate side effects.
    let threw = false;
    try { container.close(); } catch (_) { threw = true; }
    assert(!threw,
      'mid-render close() called twice does not throw');
    assert(container._terminated === terminatedAfterFirst,
      'mid-render close() called twice does not re-run terminate side effects');
  }
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} creative-sources-load assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All creative-sources-load assertions passed.');
}
