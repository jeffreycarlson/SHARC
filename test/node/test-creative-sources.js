/**
 * test-creative-sources.js — issue #41 Phase A regression coverage
 *
 * Constructor-level tests for the Creative Markup payload variant.
 * Scope: constructor option additions + 8 sequenced validation rules + error
 * codes 2114-2118 + new instance properties (creativeSource, creativeInjected,
 * creativeRendered, creativeRendererUrl) + the post-Phase-B return shape of
 * `_resolvedIframeSrc()`. Iframe build, postMessage protocol, and timeouts
 * are exercised in `test-creative-sources-load.js`.
 *
 * Uses jsdom to provide window/document so each test calls
 * `new SHARCContainer({...})` for real — not via Object.create stubs.
 *
 * Mirror of test-placement-stamping.js structure.
 *
 * Spec: docs/proposals/creative-sources.md § Validation Rules
 *       and § Metadata and Observability.
 *
 * Runs in Node after `npm run build`. No browser, no test framework.
 */

import { JSDOM } from 'jsdom';

// ── Set up DOM globals BEFORE importing SHARCContainer. ───────────────────
// Constructor reads window.location for rule 7 (cross-origin check). The test
// origin is the "publisher origin" — the renderer URL must be cross-origin
// to it for rule 7 to pass.
const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html', referrer: 'https://search.example/' },
);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
// TextEncoder is needed by validation rule 8 for accurate byte counting; jsdom
// exposes it on the window, but Node 18+ also has it as a global. Either is fine.

// Pre-load protocol exports onto window.SHARC.Protocol so the bundled
// container module can resolve them (matches test-placement-stamping.js).
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer, SHARC_BUILD_MODE } = await import('../../dist/sharc-container.mjs');
const { ErrorCodes } = protoMod;
const IS_DEV_BUILD = SHARC_BUILD_MODE === 'dev';
const IS_PROD_BUILD = SHARC_BUILD_MODE === 'prod';

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
function assertThrows(fn, msgPattern, message, ErrorCtor) {
  try {
    fn();
    console.error('  ✗', message, '(no throw)');
    failures++;
  } catch (e) {
    if (ErrorCtor && !(e instanceof ErrorCtor)) {
      console.error('  ✗', message, `(threw, wrong type: ${e.constructor.name}, expected ${ErrorCtor.name})`);
      failures++;
      return;
    }
    if (msgPattern && !String(e.message).match(msgPattern)) {
      console.error('  ✗', message, `(threw, wrong message: ${e.message})`);
      failures++;
      return;
    }
    console.log('  ✓', message);
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────
const RENDERER_URL = 'https://renderer.operator.example/0.7.0/';
function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}
function urlOptions(overrides) {
  return {
    creativeUrl: 'https://ads.example/creative.html',
    placementElement: freshSlot(),
    ...overrides,
  };
}
function markupOptions(overrides) {
  return {
    creativeHtml: '<html><body>ad</body></html>',
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    ...overrides,
  };
}
function validationWindow(origin = PUBLISHER_ORIGIN) {
  return {
    location: { origin },
    top: { location: { origin } },
  };
}

console.log('test-creative-sources.js — issue #41 Phase A regression\n');

// -- 1. Error codes 2114-2118 are exposed on the protocol module ───────────
{
  console.log('1. Error codes 2114-2118 exposed on ErrorCodes');
  assert(IS_DEV_BUILD || IS_PROD_BUILD,
    `SHARC_BUILD_MODE is injected as "dev" or "prod" (got ${JSON.stringify(SHARC_BUILD_MODE)})`);
  assert(ErrorCodes.RENDERER_TIMEOUT === 2114,
    'RENDERER_TIMEOUT === 2114');
  assert(ErrorCodes.RENDERER_FAILED === 2115,
    'RENDERER_FAILED === 2115');
  assert(ErrorCodes.RENDERER_ORIGIN_MISMATCH === 2116,
    'RENDERER_ORIGIN_MISMATCH === 2116');
  assert(ErrorCodes.RENDERER_PROTOCOL_ERROR === 2117,
    'RENDERER_PROTOCOL_ERROR === 2117');
  assert(ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION === 2118,
    'RENDERER_UNAUTHORIZED_NAVIGATION === 2118');
  assert(ErrorCodes.RENDERER_INTEGRITY_FAIL === 2120,
    'RENDERER_INTEGRITY_FAIL === 2120');
}

// -- 1b. _validateCreativeSources direct unit surface (#64) ────────────────
{
  console.log('\n1b. _validateCreativeSources direct unit surface');

  const urlResult = SHARCContainer._validateCreativeSources(
    { creativeUrl: 'https://ads.example/creative.html' },
    { window: validationWindow() },
  );
  assert(typeof urlResult.placementSessionId === 'string' && urlResult.placementSessionId.length > 0,
    '_validateCreativeSources returns placementSessionId');
  assert(urlResult.parsedRendererUrl === null,
    '_validateCreativeSources returns null parsedRendererUrl for URL variant');
  assert(urlResult.hasCreativeUrl === true && urlResult.hasCreativeHtml === false && urlResult.hasRendererUrl === false,
    '_validateCreativeSources returns source presence flags for URL variant');

  const markupResult = SHARCContainer._validateCreativeSources(
    { creativeHtml: '<html></html>', creativeRendererUrl: RENDERER_URL },
    { window: validationWindow() },
  );
  assert(markupResult.parsedRendererUrl instanceof URL
    && markupResult.parsedRendererUrl.origin === 'https://renderer.operator.example',
    '_validateCreativeSources parses renderer URL for Markup variant');
  assert(markupResult.hasCreativeUrl === false && markupResult.hasCreativeHtml === true && markupResult.hasRendererUrl === true,
    '_validateCreativeSources returns source presence flags for Markup variant');

  assertThrows(
    () => SHARCContainer._validateCreativeSources(
      { creativeUrl: 'https://ads.example/creative.html', bridges: ['mraid'] },
      { window: validationWindow() },
    ),
    /bridges is only valid/,
    '_validateCreativeSources rejects Creative URL + bridges without jsdom container setup',
    TypeError,
  );

  const events = [];
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const crossOriginTopWindow = {
      location: { origin: PUBLISHER_ORIGIN },
      top: {
        get location() {
          const err = new Error('Blocked a frame with origin from accessing a cross-origin frame.');
          err.name = 'SecurityError';
          throw err;
        },
      },
    };
    const wrapperResult = SHARCContainer._validateCreativeSources(
      {
        creativeHtml: '<html></html>',
        creativeRendererUrl: RENDERER_URL,
        onSecurityEvent: (event) => events.push(event),
      },
      { window: crossOriginTopWindow },
    );
    assert(wrapperResult.placementSessionId === events[0].placementSessionId,
      '_validateCreativeSources wrapper carve-out event uses returned placementSessionId');
    if (IS_DEV_BUILD) {
      assert(warns[0] && warns[0].includes('Validation rule 7 carve-out applied'),
        '_validateCreativeSources wrapper carve-out logs warning without constructing container (dev bundle)');
    } else {
      assert(warns.length === 0,
        '_validateCreativeSources wrapper carve-out console warning is stripped in prod bundle');
    }
    assert(events[0] && events[0].type === 'wrapper_top_frame_inaccessible',
      '_validateCreativeSources wrapper carve-out emits security event');
  } finally {
    console.warn = originalWarn;
  }
}

// -- 2. Rule 1 — exactly one of creativeUrl or creativeHtml ────────────────
{
  console.log('\n2. Rule 1 — exactly one of creativeUrl or creativeHtml');
  // Neither → TypeError
  assertThrows(
    () => new SHARCContainer({ placementElement: freshSlot() }),
    /creativeUrl is required/,
    'neither creativeUrl nor creativeHtml throws TypeError',
    TypeError,
  );
  // Both → TypeError
  assertThrows(
    () => new SHARCContainer({
      creativeUrl: 'https://ads.example/c.html',
      creativeHtml: '<html></html>',
      creativeRendererUrl: RENDERER_URL,
      placementElement: freshSlot(),
    }),
    /mutually exclusive/i,
    'both creativeUrl and creativeHtml throws TypeError',
    TypeError,
  );
}

// -- 3. Rule 2 — creativeHtml requires creativeRendererUrl ─────────────────
{
  console.log('\n3. Rule 2 — creativeHtml requires creativeRendererUrl');
  assertThrows(
    () => new SHARCContainer({
      creativeHtml: '<html></html>',
      placementElement: freshSlot(),
    }),
    /creativeHtml requires creativeRendererUrl/,
    'creativeHtml without creativeRendererUrl throws TypeError',
    TypeError,
  );
}

// -- 4. Rule 3 — creativeRendererUrl forbidden alongside creativeUrl ───────
{
  console.log('\n4. Rule 3 — creativeRendererUrl is only valid with creativeHtml');
  assertThrows(
    () => new SHARCContainer({
      creativeUrl: 'https://ads.example/c.html',
      creativeRendererUrl: RENDERER_URL,
      placementElement: freshSlot(),
    }),
    /only valid alongside creativeHtml/,
    'creativeUrl + creativeRendererUrl throws TypeError',
    TypeError,
  );
}

// -- 5. Rule 4 — creativeRendererUrl must parse via new URL(...) ───────────
{
  console.log('\n5. Rule 4 — creativeRendererUrl must parse via new URL()');
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeRendererUrl: 'not-a-url' })),
    /not a parseable URL/,
    'unparseable creativeRendererUrl throws Error',
    Error,
  );
}

// -- 6. Rule 5 — creativeRendererUrl must use https: scheme ────────────────
{
  console.log('\n6. Rule 5 — creativeRendererUrl must use https: scheme');
  const badSchemes = [
    ['http://renderer.operator.example/', 'http:'],
    ['javascript:alert(1)', 'javascript:'],
    ['data:text/html,hello', 'data:'],
    ['blob:https://x/abcd', 'blob:'],
    ['file:///tmp/renderer.html', 'file:'],
    ['about:blank', 'about:'],
  ];
  for (const [bad, scheme] of badSchemes) {
    assertThrows(
      () => new SHARCContainer(markupOptions({ creativeRendererUrl: bad })),
      /must use the https: scheme/,
      `${scheme} creativeRendererUrl throws Error`,
      Error,
    );
  }

  let localHttpDevOk = false;
  const originalWindow = global.window;
  global.window = {
    location: { origin: 'http://localhost:8765' },
    top: { location: { origin: 'http://localhost:8765' } },
  };
  try {
    const c = new SHARCContainer(markupOptions({
      creativeRendererUrl: 'http://localhost:8766/examples/renderer/',
    }));
    localHttpDevOk =
      c.creativeRendererUrl === 'http://localhost:8766/examples/renderer/';
  } finally {
    global.window = originalWindow;
  }
  assert(localHttpDevOk,
    'http://localhost renderer URL is allowed when publisher origin is also local dev');

  const originalWindow2 = global.window;
  global.window = {
    location: { origin: 'https://publisher.example' },
    top: { location: { origin: 'https://publisher.example' } },
  };
  try {
    assertThrows(
      () => new SHARCContainer(markupOptions({
        creativeRendererUrl: 'http://localhost:8766/examples/renderer/',
      })),
      /http: is allowed only/,
      'http://localhost renderer URL is rejected from a non-dev publisher origin',
      Error,
    );
  } finally {
    global.window = originalWindow2;
  }
}

// -- 7. Rule 6 — creativeRendererUrl must not contain userinfo ─────────────
{
  console.log('\n7. Rule 6 — creativeRendererUrl must not contain userinfo');
  assertThrows(
    () => new SHARCContainer(markupOptions({
      creativeRendererUrl: 'https://user@renderer.operator.example/',
    })),
    /must not contain userinfo/,
    'creativeRendererUrl with username throws Error',
    Error,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({
      creativeRendererUrl: 'https://user:pass@renderer.operator.example/',
    })),
    /must not contain userinfo/,
    'creativeRendererUrl with username:password throws Error',
    Error,
  );
  // Percent-encoded credentials (`%75` decodes to `u`) — the URL parser
  // decodes during construction, so `username` is `'user'` by the time we
  // check. Locks in that the rule can't be bypassed via encoding.
  assertThrows(
    () => new SHARCContainer(markupOptions({
      creativeRendererUrl: 'https://%75ser@renderer.operator.example/',
    })),
    /must not contain userinfo/,
    'creativeRendererUrl with percent-encoded username throws Error',
    Error,
  );
}

// -- 8. Rule 7 — creativeRendererUrl must be cross-origin to window ────────
{
  console.log('\n8. Rule 7 — creativeRendererUrl must be cross-origin to window');
  assertThrows(
    () => new SHARCContainer(markupOptions({
      creativeRendererUrl: PUBLISHER_ORIGIN + '/renderer.html',
    })),
    /must be cross-origin to window\.location/,
    'same-origin creativeRendererUrl (vs window.location) throws Error',
    Error,
  );
  // Cross-port is a different origin in HTML's origin model — explicit + safe.
  let crossPortOk = false;
  try {
    const c = new SHARCContainer(markupOptions({
      creativeRendererUrl: 'https://publisher.example:8443/renderer.html',
    }));
    crossPortOk = c.creativeRendererUrl === 'https://publisher.example:8443/renderer.html';
  } catch (_) { /* swallow */ }
  assert(crossPortOk,
    'cross-port renderer URL is treated as cross-origin (per HTML origin model)');
}

// -- 9. Rule 7 carve-out — wrapper-cross-origin top frame inaccessible ────
{
  console.log('\n9. Rule 7 carve-out — wrapper-cross-origin top frame inaccessible');

  // Simulate cross-origin top by swapping `global.window` for a Proxy that
  // intercepts `.top` and returns an object whose `.location.origin` access
  // throws — mirroring how browsers block cross-origin top.location reads from
  // inside a wrapper iframe. The container reads `window` as a free global,
  // so reassigning `global.window` for the duration of the test is sufficient.
  // jsdom's `window.top` getter is non-configurable, so we cannot stub it
  // in place — wrap the whole window instead.
  const originalWindow = global.window;
  function installCrossOriginTopStub() {
    const throwingTop = new Proxy({}, {
      get() {
        throw new DOMException(
          'Blocked a frame with origin "' + PUBLISHER_ORIGIN + '" from accessing a cross-origin frame.',
          'SecurityError',
        );
      },
    });
    global.window = new Proxy(originalWindow, {
      get(target, prop, receiver) {
        if (prop === 'top') return throwingTop;
        return Reflect.get(target, prop, receiver);
      },
    });
  }
  function restoreTop() {
    global.window = originalWindow;
  }

  // 9a — default 'warn' policy: emits console.warn + onSecurityEvent, proceeds.
  installCrossOriginTopStub();
  try {
    const events = [];
    const warned = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warned.push(args.join(' ')); };
    let constructed = null;
    try {
      constructed = new SHARCContainer(markupOptions({
        onSecurityEvent: (ev) => events.push(ev),
      }));
    } finally {
      console.warn = originalWarn;
    }
    assert(constructed instanceof SHARCContainer,
      "default wrapperPolicy='warn' proceeds with construction");
    // Console output is dev-channel signalling only; prod bundles strip it via
    // terser `drop_console: true`. The build-mode constant makes that explicit
    // so a dev bundle that fails to warn cannot masquerade as a prod bundle.
    if (IS_DEV_BUILD) {
      assert(warned.some((w) => /Validation rule 7 carve-out/.test(w)),
        'console.warn fires once with carve-out message (dev bundle)');
    } else {
      assert(warned.length === 0,
        'console.warn is stripped from wrapper carve-out path in prod bundle');
    }
    assert(events.length === 1 && events[0].type === 'wrapper_top_frame_inaccessible',
      'onSecurityEvent fires with type=wrapper_top_frame_inaccessible');
    assert(events[0] && events[0].severity === 'warning',
      'onSecurityEvent severity === "warning" under wrapperPolicy="warn"');
    assert(events[0] && typeof events[0].timestamp === 'number',
      'onSecurityEvent payload includes numeric timestamp');
    assert(events[0] && typeof events[0].placementSessionId === 'string'
      && events[0].placementSessionId.length > 0,
      'onSecurityEvent payload includes placementSessionId');
    // Correlation guarantee: the event's placementSessionId MUST equal the
    // constructed instance's placementSessionId. Reviewers (security, code,
    // architect) all flagged that an earlier draft generated a throwaway UUID
    // here; this regression probe locks the fix in place.
    assert(events[0] && constructed
      && events[0].placementSessionId === constructed.placementSessionId,
      'onSecurityEvent.placementSessionId === instance.placementSessionId (correlation)');
    assert(events[0] && events[0].details
      && events[0].details.wrapperOrigin === PUBLISHER_ORIGIN,
      'onSecurityEvent details.wrapperOrigin === window.location.origin');
    assert(events[0] && events[0].details
      && events[0].details.creativeRendererUrl === RENDERER_URL,
      'onSecurityEvent details.creativeRendererUrl matches input');
  } finally {
    restoreTop();
  }

  // 9b — wrapperPolicy='block': console.error + onSecurityEvent + throws.
  installCrossOriginTopStub();
  try {
    const events = [];
    const errored = [];
    const originalError = console.error;
    console.error = (...args) => { errored.push(args.join(' ')); };
    let threw = false;
    try {
      new SHARCContainer(markupOptions({
        wrapperPolicy: 'block',
        onSecurityEvent: (ev) => events.push(ev),
      }));
    } catch (e) {
      threw = /Validation rule 7 carve-out/.test(e.message);
    } finally {
      console.error = originalError;
    }
    assert(threw, "wrapperPolicy='block' throws synchronously at construction");
    // Same explicit dev-vs-prod console assertion as 9a above.
    if (IS_DEV_BUILD) {
      assert(errored.some((e) => /Validation rule 7 carve-out/.test(e)),
        'console.error fires with carve-out message (dev bundle)');
    } else {
      assert(errored.length === 0,
        'console.error is stripped from wrapperPolicy="block" carve-out path in prod bundle');
    }
    assert(events.length === 1 && events[0].severity === 'error',
      "onSecurityEvent fires with severity='error' before throw");
  } finally {
    restoreTop();
  }

  // 9c — onSecurityEvent throwing inside callback does NOT propagate.
  installCrossOriginTopStub();
  try {
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
    let constructed = false;
    try {
      const c = new SHARCContainer(markupOptions({
        onSecurityEvent: () => { throw new Error('callback boom'); },
      }));
      constructed = c instanceof SHARCContainer;
    } catch (_) { /* should not happen */ }
    console.warn = originalWarn;
    console.error = originalError;
    assert(constructed,
      "throwing onSecurityEvent does NOT propagate under wrapperPolicy='warn'");
  } finally {
    restoreTop();
  }

  // 9d — non-SecurityError throws on `window.top` access MUST propagate
  // (narrowed catch — security review medium finding). Earlier drafts used
  // a bare `catch (_)` that silently routed any throw into the carve-out
  // path, fail-open under default 'warn'. Wrap window so `.top` access
  // throws a plain TypeError; expect the constructor to re-throw, NOT
  // silently apply the carve-out.
  {
    const throwingTopWindow = new Proxy(originalWindow, {
      get(target, prop, receiver) {
        if (prop === 'top') {
          throw new TypeError('window.top is poisoned (not a SecurityError)');
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    global.window = throwingTopWindow;
    let propagatedError = null;
    try {
      new SHARCContainer(markupOptions());
    } catch (e) { propagatedError = e; }
    global.window = originalWindow;
    assert(propagatedError instanceof TypeError
      && /poisoned/.test(propagatedError.message),
      'non-SecurityError on window.top access propagates (does NOT fall into carve-out)');
  }
}

// -- 9.5 KNOWN_TEST_RENDERERS production-block guard (issue #55, Phase F) ──
//
// Operators MUST self-host in production. Pointing creativeRendererUrl at the
// SHARC project's reference deployment from a non-dev origin is treated as a
// misconfiguration and throws synchronously at construction. The guard fires
// AFTER rule 7 (cross-origin), so the operator only sees this throw when the
// URL would otherwise pass validation.
//
// Strategy: stub `global.window` with a Proxy that intercepts `.location` to
// return a configurable origin per case. The renderer URL itself is the
// canonical fork-hosted reference URL (jeffreycarlson.github.io/SHARC/
// renderer/) — this is the single entry in `KNOWN_TEST_RENDERERS` for the
// fork; an upstream addition is gated on contribution to IABTechLab.
{
  console.log('\n9.5 KNOWN_TEST_RENDERERS production-block guard (issue #55)');

  const KNOWN_RENDERER = 'https://jeffreycarlson.github.io/SHARC/renderer/';

  const originalWindow = global.window;
  function withWindowOrigin(origin, fn) {
    // Wrap the real jsdom window so the constructor's reads of unrelated
    // window properties (top, etc.) still work. Only `location.origin` is
    // overridden — the rest passes through.
    const stubLocation = new Proxy(originalWindow.location, {
      get(target, prop, receiver) {
        if (prop === 'origin') return origin;
        return Reflect.get(target, prop, receiver);
      },
    });
    global.window = new Proxy(originalWindow, {
      get(target, prop, receiver) {
        if (prop === 'location') return stubLocation;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      return fn();
    } finally {
      global.window = originalWindow;
    }
  }

  // Each entry: [origin, shouldSucceed, label]
  const devOrigins = [
    ['http://localhost:8765', true, 'http://localhost:8765 (publisher dev port)'],
    ['http://127.0.0.1:3000', true, 'http://127.0.0.1:3000'],
    ['http://my-app.localhost:8080', true, 'http://my-app.localhost:8080 (subdomain)'],
    ['http://app.test:4000', true, 'http://app.test:4000 (.test TLD)'],
    ['http://app.local', true, 'http://app.local (.local TLD)'],
    ['http://[::1]', true, 'http://[::1] (IPv6 loopback)'],
    ['http://0.0.0.0:9000', true, 'http://0.0.0.0:9000'],
  ];
  for (const [origin, _ok, label] of devOrigins) {
    let constructedOk = false;
    withWindowOrigin(origin, () => {
      try {
        const c = new SHARCContainer(markupOptions({
          creativeRendererUrl: KNOWN_RENDERER,
        }));
        constructedOk = c.creativeRendererUrl === KNOWN_RENDERER;
      } catch (_) { /* fall through */ }
    });
    assert(constructedOk,
      'known test renderer + dev origin succeeds: ' + label);
  }

  // Non-dev origins: throw with the diagnostic message.
  const nonDevOrigins = [
    'https://example.com',
    'https://prod.example.org',
  ];
  for (const origin of nonDevOrigins) {
    let captured = null;
    withWindowOrigin(origin, () => {
      try {
        new SHARCContainer(markupOptions({
          creativeRendererUrl: KNOWN_RENDERER,
        }));
      } catch (e) { captured = e; }
    });
    assert(captured instanceof Error
      && /known SHARC reference test renderer/.test(captured.message),
      'known test renderer + non-dev origin "' + origin + '" throws Error');
    assert(captured && captured.message.indexOf(KNOWN_RENDERER) !== -1,
      'error message names the rejected URL ("' + origin + '")');
    assert(captured && /localhost \/ 127\.0\.0\.1/.test(captured.message),
      'error message lists recognized dev-origin patterns ("' + origin + '")');
  }

  // Operator-controlled URL is NOT in the known list, so the guard never
  // fires regardless of origin. (The fixture's RENDERER_URL points at a
  // fictitious operator.example domain.)
  let operatorOk = false;
  withWindowOrigin('https://prod.example.org', () => {
    try {
      const c = new SHARCContainer(markupOptions({
        creativeRendererUrl: 'https://renderer.example.com/0.7.0/',
      }));
      operatorOk = c.creativeRendererUrl === 'https://renderer.example.com/0.7.0/';
    } catch (_) { /* fall through */ }
  });
  assert(operatorOk,
    'operator-controlled creativeRendererUrl succeeds from a non-dev origin');

  // -- 9.5(a) URL-variant negative cases ──────────────────────────────────
  // The guard must canonicalize on origin+pathname so trailing-slash,
  // query, fragment, and under-prefix variants ALL trip the production
  // block from a non-dev origin. Pages 301-redirects the slashless variant
  // to the canonical URL, so a typo there would otherwise silently load
  // the SDK-reference renderer in production while the guard sat quiet.
  const urlVariants = [
    ['https://jeffreycarlson.github.io/SHARC/renderer',     'no trailing slash'],
    ['https://jeffreycarlson.github.io/SHARC/renderer?foo=bar', 'query string'],
    ['https://jeffreycarlson.github.io/SHARC/renderer#frag',    'fragment'],
    ['https://jeffreycarlson.github.io/SHARC/renderer/sub/',    'under-prefix path'],
  ];
  for (const [variantUrl, label] of urlVariants) {
    let captured = null;
    withWindowOrigin('https://example.com', () => {
      try {
        new SHARCContainer(markupOptions({
          creativeRendererUrl: variantUrl,
        }));
      } catch (e) { captured = e; }
    });
    assert(captured instanceof Error
      && captured.message.indexOf('known SHARC reference') !== -1,
      'URL-variant guard trips: ' + label + ' ("' + variantUrl + '")');
  }

  // -- 9.5(b) Suffix-spoof negative cases for DEV_ORIGIN_PATTERNS anchors ─
  // The dev-origin regexes are anchored with ^…$. These cases pin the
  // anchors against future regression — each origin is NOT a dev origin
  // (despite resembling one), so loading the canonical reference renderer
  // from there must throw the production-block error.
  const suffixSpoofOrigins = [
    'https://notlocalhost.example',
    'https://localhost.evil.com',
    'https://app.test.attacker.io',
    'https://app.local.evil.io',
  ];
  for (const origin of suffixSpoofOrigins) {
    let captured = null;
    withWindowOrigin(origin, () => {
      try {
        new SHARCContainer(markupOptions({
          creativeRendererUrl: KNOWN_RENDERER,
        }));
      } catch (e) { captured = e; }
    });
    assert(captured instanceof Error
      && captured.message.indexOf('known SHARC reference') !== -1,
      'suffix-spoof origin "' + origin + '" is not a dev origin (guard trips)');
  }

  // -- 9.5(c) Rule-7-vs-guard ordering invariant ──────────────────────────
  // When the page origin matches the renderer origin, rule 7 (cross-origin)
  // must throw FIRST — before the production-block guard fires. This
  // invariant matters because a same-origin renderer collapses the sandbox,
  // and that diagnostic is more actionable than the production-block one.
  {
    let captured = null;
    withWindowOrigin('https://jeffreycarlson.github.io', () => {
      try {
        new SHARCContainer(markupOptions({
          creativeRendererUrl: KNOWN_RENDERER,
        }));
      } catch (e) { captured = e; }
    });
    assert(captured instanceof Error
      && captured.message.indexOf('cross-origin to window.location') !== -1,
      'rule 7 fires before the production-block guard at same origin');
  }

  // -- 9.5(d) Genuine non-test renderer at the same origin host ───────────
  // The prefix match must not over-broaden: a different path under the
  // same host is NOT in KNOWN_TEST_RENDERERS, so the guard must let it
  // through even from a non-dev origin.
  {
    let constructedOk = false;
    withWindowOrigin('https://example.com', () => {
      try {
        const c = new SHARCContainer(markupOptions({
          creativeRendererUrl: 'https://jeffreycarlson.github.io/SHARC/something-else/',
        }));
        constructedOk = c.creativeRendererUrl
          === 'https://jeffreycarlson.github.io/SHARC/something-else/';
      } catch (_) { /* fall through */ }
    });
    assert(constructedOk,
      'non-test path under the same host succeeds (prefix match does not over-broaden)');
  }
}

// -- 10. Rule 8 — creativeHtml size cap (256 KiB at construction) ──────────
{
  console.log('\n10. Rule 8 — creativeHtml size cap (256 KiB)');
  const MAX = 256 * 1024;
  // Just under the cap is fine.
  const justUnder = 'a'.repeat(MAX - 1);
  let underOk = false;
  try {
    const c = new SHARCContainer(markupOptions({ creativeHtml: justUnder }));
    underOk = c.creativeSource === 'html';
  } catch (_) { /* swallow */ }
  assert(underOk, 'creativeHtml at MAX-1 bytes constructs successfully');

  // Over the cap throws.
  const justOver = 'a'.repeat(MAX + 1);
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeHtml: justOver })),
    /exceeds 256 KiB/,
    'creativeHtml > 256 KiB throws Error',
    Error,
  );
}

// -- 11. Validation rule ordering — shape errors precede value errors ─────
{
  console.log('\n11. Validation rule ordering — TypeError (shape) before Error (value)');
  // Both shape (rule 3) and value (rule 5) violations present;
  // rule 3 fires first with TypeError, never reaches the http: scheme check.
  assertThrows(
    () => new SHARCContainer({
      creativeUrl: 'https://ads.example/c.html',
      creativeRendererUrl: 'http://insecure.renderer.example/',
      placementElement: freshSlot(),
    }),
    /only valid alongside creativeHtml/,
    'shape error (rule 3) thrown before value error (rule 5)',
    TypeError,
  );

  // Rule 4 (parseable) precedes rule 5 (https:); unparseable URL hits rule 4.
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeRendererUrl: '!!!' })),
    /not a parseable URL/,
    'rule 4 (parseable) thrown before rule 5 (https:)',
    Error,
  );

  assertThrows(
    () => new SHARCContainer(urlOptions({ creativeRendererIntegrity: 'sha384-abc=' })),
    /creativeRendererIntegrity is only valid/,
    'creativeRendererIntegrity with Creative URL throws TypeError',
    TypeError,
  );

  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeRendererIntegrity: 'sha256-abc=' })),
    /creativeRendererIntegrity must be an SRI-style SHA-384/,
    'creativeRendererIntegrity rejects non-sha384 algorithm',
    TypeError,
  );

  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeRendererIntegrity: 123 })),
    /creativeRendererIntegrity must be an SRI-style SHA-384/,
    'creativeRendererIntegrity rejects non-string value',
    TypeError,
  );
}

// -- 12. Creative URL variant — instance properties ────────────────────────
{
  console.log('\n12. Creative URL variant — instance properties');
  const c = new SHARCContainer(urlOptions());
  assert(c.creativeUrl === 'https://ads.example/creative.html',
    'creativeUrl is preserved on the instance');
  assert(c.creativeRendererUrl === null,
    'creativeRendererUrl is null in URL variant');
  assert(c.creativeSource === 'url',
    "creativeSource === 'url' in URL variant");
  assert(c.creativeRendered === false,
    'creativeRendered === false at construction in URL variant (load-time concern)');
  assert(c.creativeInjected === false,
    'creativeInjected === false at construction (load-time concern)');
  // 0.7.1 (issue #82): URL variant has no renderer protocol → bridges = [].
  assert(Array.isArray(c.bridges) && c.bridges.length === 0,
    'container.bridges = [] in URL variant (no renderer protocol)');
}

// -- 13. Creative Markup variant — instance properties ────────────────────
{
  console.log('\n13. Creative Markup variant — instance properties');
  const c = new SHARCContainer(markupOptions());
  assert(c.creativeUrl === null,
    'creativeUrl is null in Markup variant');
  assert(c.creativeRendererUrl === RENDERER_URL,
    'creativeRendererUrl is preserved on the instance');
  assert(c.creativeSource === 'html',
    "creativeSource === 'html' in Markup variant");
  // creativeRendered is a load-time fact: true only after the renderer
  // protocol's ':rendered' reply is envelope-validated. At construction
  // it is FALSE for both variants; the variant in use is reflected by
  // creativeSource, not by this flag. (Architect review fix.)
  assert(c.creativeRendered === false,
    'creativeRendered === false at construction in Markup variant (set true on :rendered)');
  assert(c.creativeInjected === false,
    'creativeInjected === false at construction (load-time concern)');
  assert(typeof c.placementSessionId === 'string' && c.placementSessionId.length > 0,
    'placementSessionId is generated for Markup variant (parity with URL)');
  // 0.7.1 (issue #82): container.bridges accessor — frozen array set at
  // construction. Default fixture has no mraid.js / $sf.ext signal, so
  // adm scan yields []. Deeper coverage lives in test-bridges-detection.js.
  assert(Array.isArray(c.bridges) && Object.isFrozen(c.bridges),
    'container.bridges is a frozen array (0.7.1)');
  assert(c.bridges.length === 0,
    'container.bridges = [] for fixture creativeHtml without bridge signals');

  const integrity = 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const withIntegrity = new SHARCContainer(markupOptions({ creativeRendererIntegrity: integrity }));
  assert(withIntegrity._creativeRendererIntegrity === integrity,
    'creativeRendererIntegrity is preserved privately for Markup variant');
}

// -- 14. Sandbox / policy options — defaults and overrides ────────────────
{
  console.log('\n14. Sandbox / policy options — defaults match spec');
  const c = new SHARCContainer(markupOptions());
  assert(c._sandboxConfig.allowPopups === true,
    'allowPopups defaults to true (DD-12, DD-17)');
  assert(c._sandboxConfig.allowTopNavigationByUserActivation === true,
    'allowTopNavigationByUserActivation defaults to true (DD-20)');
  assert(c._sandboxConfig.allowStorageAccessByUserActivation === true,
    'allowStorageAccessByUserActivation defaults to true (DD-22)');
  assert(c._sandboxConfig.allowModals === false,
    'allowModals defaults to false (DD-23 — UX-disruption surface)');
  assert(c._sandboxConfig.allowDownloads === false,
    'allowDownloads defaults to false (DD-25 — UX-disruption surface)');
  assert(c._sandboxConfig.wrapperPolicy === 'warn',
    "wrapperPolicy defaults to 'warn' (DD-19)");

  const overridden = new SHARCContainer(markupOptions({
    allowPopups: false,
    allowTopNavigationByUserActivation: false,
    allowStorageAccessByUserActivation: false,
    allowModals: true,
    allowDownloads: true,
    wrapperPolicy: 'block',
  }));
  assert(overridden._sandboxConfig.allowPopups === false,
    'allowPopups: false flows through');
  assert(overridden._sandboxConfig.allowTopNavigationByUserActivation === false,
    'allowTopNavigationByUserActivation: false flows through');
  assert(overridden._sandboxConfig.allowStorageAccessByUserActivation === false,
    'allowStorageAccessByUserActivation: false flows through');
  assert(overridden._sandboxConfig.allowModals === true,
    'allowModals: true flows through');
  assert(overridden._sandboxConfig.allowDownloads === true,
    'allowDownloads: true flows through');
  assert(overridden._sandboxConfig.wrapperPolicy === 'block',
    "wrapperPolicy: 'block' flows through");

  // Unknown wrapperPolicy values fall back to 'warn' (defensive default).
  const fallback = new SHARCContainer(markupOptions({ wrapperPolicy: 'lenient' }));
  assert(fallback._sandboxConfig.wrapperPolicy === 'warn',
    "unknown wrapperPolicy falls back to 'warn'");
}

// -- 15. Constructor is side-effect-free on success path ───────────────────
//
// Construction must NOT mutate the placement element or attach to the DOM —
// load() owns those mutations. Same invariant as Creative URL.
{
  console.log('\n15. Markup constructor does not mutate placement element');
  const slot = freshSlot();
  const before = slot.outerHTML;
  new SHARCContainer({
    creativeHtml: '<html><body>ad</body></html>',
    creativeRendererUrl: RENDERER_URL,
    placementElement: slot,
  });
  assert(slot.outerHTML === before,
    'placementElement.outerHTML unchanged after Markup construction');
}

// -- 16. Backward compatibility — Creative URL construction unchanged ─────
{
  console.log('\n16. Backward compatibility — Creative URL behavior preserved');
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/creative.html',
    placementElement: freshSlot(),
    placementId: 'slot-001',
    placementName: 'sidebar',
  });
  assert(c.creativeUrl === 'https://ads.example/creative.html',
    'Creative URL: creativeUrl preserved');
  assert(c.placementId === 'slot-001',
    'Creative URL: placementId round-trip preserved');
  assert(c.placementName === 'sidebar',
    'Creative URL: placementName round-trip preserved');
  assert(c.creativeSource === 'url',
    'Creative URL: creativeSource defaults to "url"');
}

// -- 17. _resolvedIframeSrc shape — both variants ────────────────────────
//
// 0.7.7 updates the Markup-variant return shape: the fragment value is the
// renderer-protocol-derived nonce (HMAC-SHA-256 over root `_sharcNonce` +
// `'SHARC:Renderer:'` + placementSessionId), base64url-encoded to 22 chars.
// The root `_sharcNonce` no longer appears on the wire (RTR-D13).
//
// Markup-variant `_resolvedIframeSrc()` is now deferred behind
// `protocolRouter.ready('SHARC:Renderer:')`; callers MUST await that promise
// before invoking the method. Pre-await invocation throws explicitly.
{
  console.log('\n17. _resolvedIframeSrc shape — Creative URL + Creative Markup');

  // 17a — Creative URL: returns this.creativeUrl unchanged.
  const urlContainer = new SHARCContainer(urlOptions());
  let urlResolved;
  try {
    urlResolved = urlContainer._resolvedIframeSrc();
  } catch (_) {
    urlResolved = null;
  }
  assert(urlResolved === 'https://ads.example/creative.html',
    'Creative URL: _resolvedIframeSrc returns this.creativeUrl');

  // 17b — Creative Markup: returns creativeRendererUrl + '#sharcNonce=<derived>'
  // post-0.7.7. The derived nonce is deterministic per
  // (rootNonce, prefix, placementSessionId), so successive calls within the
  // same impression return the same value — fundamentally different from the
  // pre-0.7.7 fresh-UUID-per-call shape (RTR-D3).
  const markupContainer = new SHARCContainer(markupOptions());
  await markupContainer.protocolRouter.ready('SHARC:Renderer:');
  const first = markupContainer._resolvedIframeSrc();
  const second = markupContainer._resolvedIframeSrc();
  assert(typeof first === 'string' && first.startsWith(RENDERER_URL + '#sharcNonce='),
    'Creative Markup: _resolvedIframeSrc returns creativeRendererUrl + "#sharcNonce=<derived>"');
  const derivedNoncePattern = /^[A-Za-z0-9_-]{22}$/;
  const firstNonce = first.split('#sharcNonce=')[1];
  assert(derivedNoncePattern.test(firstNonce),
    'Creative Markup: assembled nonce is a 22-char base64url string (HMAC-SHA-256 truncated)');
  assert(typeof second === 'string' && second === first,
    'Creative Markup: _resolvedIframeSrc is deterministic across calls within an impression (0.7.7)');
  assert(markupContainer._rendererProtocolNonce === firstNonce,
    'Creative Markup: _rendererProtocolNonce reflects the derived nonce delivered via onReady');
  assert(markupContainer._sharcNonce
    && markupContainer._sharcNonce !== firstNonce,
    'Creative Markup: root _sharcNonce is distinct from the wire-level derived nonce (RTR-D13)');
}

// -- 18. Input-shape edge cases — lock in URL parser + coercion behavior ──
//
// Code-review pass-1 LOW finding: several real-world input shapes weren't
// probed. These assertions lock in current parser behavior so a future
// change can't silently break them.
{
  console.log('\n18. Input-shape edge cases');

  // 18a — `creativeRendererUrl` accepts a `URL` object (real-world DSP code
  // routinely passes parsed URLs). `new URL(URL)` constructs from the
  // stringified form, so this should round-trip cleanly.
  const urlObject = new URL(RENDERER_URL);
  let urlObjectOk = false;
  try {
    const c = new SHARCContainer(markupOptions({ creativeRendererUrl: urlObject }));
    urlObjectOk = c.creativeRendererUrl === urlObject;
  } catch (_) { /* swallow */ }
  assert(urlObjectOk,
    'creativeRendererUrl accepts a URL object input');

  // 18b — Trailing-whitespace creativeRendererUrl: per the WHATWG URL spec
  // the parser silently strips leading/trailing C0-control + ASCII-space
  // characters before parsing, so rule 4 does NOT throw. Lock in the
  // pass-through behavior so a future stricter-input check can't regress it
  // without a deliberate code change. (Code-review pass-1 expected a throw;
  // probe corrected to match documented spec behavior.)
  let trailingOk = false;
  try {
    const c = new SHARCContainer(markupOptions({
      creativeRendererUrl: 'https://renderer.operator.example/   ',
    }));
    trailingOk = c.creativeSource === 'html';
  } catch (_) { /* swallow */ }
  assert(trailingOk,
    'trailing-whitespace creativeRendererUrl is normalized by URL parser (no rule 4 throw)');

  // 18c — Uppercase scheme `'HTTPS://'`: URL parser normalizes `protocol` to
  // lowercase, so rule 5's `=== 'https:'` check passes. Lock this in so a
  // future strict-equal-on-the-input-string check can't regress it.
  let httpsUppercaseOk = false;
  try {
    const c = new SHARCContainer(markupOptions({
      creativeRendererUrl: 'HTTPS://renderer.operator.example/0.7.0/',
    }));
    httpsUppercaseOk = c.creativeSource === 'html';
  } catch (_) { /* swallow */ }
  assert(httpsUppercaseOk,
    'uppercase HTTPS scheme is normalized and accepted (rule 5)');

  // 18d — `wrapperPolicy: undefined` (explicit) behaves identically to a
  // missing key; destructuring default applies in both cases.
  const explicitUndefined = new SHARCContainer(markupOptions({ wrapperPolicy: undefined }));
  assert(explicitUndefined._sandboxConfig.wrapperPolicy === 'warn',
    "explicit wrapperPolicy: undefined → defaults to 'warn'");

  // 18e — Non-string `creativeHtml`: the documented contract is `string`.
  // Passing a number coerces inside TextEncoder.encode (which calls toString
  // internally), so byte counting works and validation proceeds. Documented
  // contract violated, but no crash. Operators relying on this behavior
  // are off-spec; the test locks in "doesn't blow up" not "is supported."
  let numericHtmlOk = false;
  try {
    const c = new SHARCContainer(markupOptions({ creativeHtml: 42 }));
    numericHtmlOk = c.creativeSource === 'html';
  } catch (_) { /* swallow */ }
  assert(numericHtmlOk,
    'non-string creativeHtml (number) constructs without crash (off-spec but stable)');
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} creative-sources assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All creative-sources assertions passed.');
}
