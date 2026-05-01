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
const protoMod = await import('./dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('./dist/sharc-container.mjs');
const { ErrorCodes } = protoMod;

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

console.log('test-creative-sources.js — issue #41 Phase A regression\n');

// -- 1. Error codes 2114-2118 are exposed on the protocol module ───────────
{
  console.log('1. Error codes 2114-2118 exposed on ErrorCodes');
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
    // Console output is dev-channel signalling only; prod bundles
    // (`NODE_ENV=production`) strip it via terser `drop_console: true`. The
    // structured-event channel below is the durable contract. Skip the console
    // probe when no output was captured (signature of a prod bundle).
    if (warned.length > 0) {
      assert(warned.some((w) => /Validation rule 7 carve-out/.test(w)),
        'console.warn fires once with carve-out message (dev bundle)');
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
    // Same dev-vs-prod console caveat as 9a above.
    if (errored.length > 0) {
      assert(errored.some((e) => /Validation rule 7 carve-out/.test(e)),
        'console.error fires with carve-out message (dev bundle)');
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
// Phase A guarded "Markup not supported" with two throws (in `_createIframe`
// and `_resolvedIframeSrc`). Phase B replaces both with the renderer-URL
// assembly: `creativeRendererUrl + '#sharcNonce=' + crypto.randomUUID()`.
// This block locks in the post-Phase-B return shape; the deeper load-path
// behavior (sandbox, postMessage protocol, timeouts) lives in
// `test-creative-sources-load.js`.
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

  // 17b — Creative Markup: returns creativeRendererUrl + '#sharcNonce=' + uuid;
  // calling twice produces two different nonces (each call generates a fresh
  // CSPRNG nonce — by design; iframe.src is assigned exactly once per
  // `_createIframe()` call).
  const markupContainer = new SHARCContainer(markupOptions());
  const first = markupContainer._resolvedIframeSrc();
  const second = markupContainer._resolvedIframeSrc();
  assert(typeof first === 'string' && first.startsWith(RENDERER_URL + '#sharcNonce='),
    'Creative Markup: _resolvedIframeSrc returns creativeRendererUrl + "#sharcNonce=<uuid>"');
  // UUID v4 shape after the prefix.
  const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const firstNonce = first.split('#sharcNonce=')[1];
  assert(noncePattern.test(firstNonce),
    'Creative Markup: assembled nonce is a UUID-shaped string (CSPRNG, no Math.random)');
  assert(typeof second === 'string' && second !== first,
    'Creative Markup: _resolvedIframeSrc generates a fresh nonce on each call');
  assert(markupContainer._sharcNonce && markupContainer._sharcNonce === second.split('#sharcNonce=')[1],
    'Creative Markup: this._sharcNonce reflects the most recent _resolvedIframeSrc() call');
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
