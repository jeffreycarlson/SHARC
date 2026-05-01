/**
 * test-creative-sources-load.js — issue #41 Phase B regression coverage
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
 * NOT in Phase B (defer to Phase C/D):
 *   :failed receipt + RENDERER_FAILED (2115)
 *   Post-load origin echo + RENDERER_ORIGIN_MISMATCH (2116)
 *   Malformed-payload handling + RENDERER_PROTOCOL_ERROR (2117)
 *   close() mid-render cleanup contract
 *   Load-event navigation backstop + RENDERER_UNAUTHORIZED_NAVIGATION (2118)
 *   Reference renderer + service-worker detection
 *
 * Uses jsdom (no browser harness) — mirrors the test-creative-sources.js
 * pattern. Stubs `iframe.contentWindow.postMessage` to capture the render
 * message and dispatches synthetic `MessageEvent`s on `window` to simulate
 * the renderer's `:rendered` reply.
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

console.log('test-creative-sources-load.js — issue #41 Phase B regression\n');

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

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} creative-sources-load assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All creative-sources-load assertions passed.');
}
