/**
 * test-creative-sdk-injection.js — issue #89 (0.7.2 PR 4.1) coverage
 *
 * Unit coverage for the built-in `creativeSdkUrl` constructor option on
 * `SHARCContainer`. Verifies the locked design from PR 4.1: instead of a
 * standalone `SHARCCreativeInjector` extension class, the SDK auto-injection
 * is folded into the container itself as a flat constructor option (Option A
 * in the 0.7.2 design § 6.3 framing). Operators set ONE option to lift legacy
 * Markup-variant adm (plain HTML / MRAID / SafeFrame) into SHARC.
 *
 * Coverage matrix:
 *
 *   1. Constructor validation (Rule 12 TypeError contract)
 *      - creativeSdkUrl: null / '' / number / object / boolean → TypeError
 *      - creativeSdkUrl: 'https://...'                          → accepted
 *      - omitted entirely                                       → accepted, _creativeSdkUrl === null
 *
 *   2. Injection-position contract (4-step, most-specific-wins)
 *      - <head> present (mixed case, with attrs) → after head open tag
 *      - <html> only (no head)                   → after html open tag
 *      - <!DOCTYPE> only (no html, no head)      → after doctype (NOT before)
 *      - true fragment                            → prepend
 *
 *   3. Idempotency (creativeSdkSkipIfPresent)
 *      - default true + markup already has sharc-creative.js → unchanged
 *      - default true + DIFFERENT filename                    → still injects
 *      - back-to-back two containers identical output         → idempotent
 *      - creativeSdkSkipIfPresent: false                       → always injects
 *
 *   4. scriptAttrs serialization (creativeSdkScriptAttrs)
 *      - { async: true } / { async, defer } / { async: false } → bare/omitted
 *      - null / undefined values → omitted
 *      - string attr → quoted; `"` and `&` escaped
 *      - creativeSdkUrl with `&` → src value escaped
 *
 *   5. SHARCContainer integration
 *      - creativeInjected flag flips true after _runMarkupInjection()
 *      - 'com.iabtechlab.sharc.creative-injector' in _mergedSupportedFeatures
 *      - NO creativeSdkUrl → markup unchanged, feature not advertised
 *
 *   6. Multi-extension sequencing (built-in runs BEFORE operator extensions)
 *      - operator extension sees SDK already present in input
 *      - skipIfPresent dedup means no double-injection
 *
 *   7. Review-fixup regression coverage (post-PR-103 round 1)
 *      - 7a: <head> regex rejects <header> false-positive
 *      - 7b: skipIfPresent regex requires real <script src="..."> context
 *
 * Runs in Node after `npm run build`.
 */

import { JSDOM } from 'jsdom';

// ── Minimal DOM stub ─────────────────────────────────────────────────────
// Mirrors test-non-sharc-loading.js / test-sharc-creative-injector.js.
// SHARCContainer construction touches `document` / `HTMLIFrameElement` /
// `HTMLElement` / `MessageChannel`.
const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.operator.example/r/';
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html', pretendToBeVisual: true },
);
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return 'visible'; },
});
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

// IntersectionObserver stub — the HTML lifecycle adapter constructs one
// during attach(); without the stub, container construction wires the
// degraded-mode branch. We never exercise IO transitions here.
global.IntersectionObserver = class IntersectionObserverStub {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.IntersectionObserver = global.IntersectionObserver;

// Pre-load protocol exports onto window.SHARC.Protocol so the container's
// internal SHARC_VERSION lookup at construction works.
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

// ── Assertion harness ─────────────────────────────────────────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

// Container hygiene — terminate any survivors so the 5 s fatal timeout
// (and other leaked timers) don't pollute downstream assertions.
const _liveContainers = [];
function track(c) { _liveContainers.push(c); return c; }
function flushContainers() {
  while (_liveContainers.length) {
    const c = _liveContainers.pop();
    try { if (!c._terminated) c._terminate(); } catch (_) { /* ignore */ }
  }
}
process.on('beforeExit', flushContainers);

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}

function baseMarkupOpts(overrides) {
  return {
    creativeHtml: '<html><head></head><body>creative</body></html>',
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    requireSharcInit: false,
    timeouts: { createSession: 5000 },
    ...overrides,
  };
}

console.log('test-creative-sdk-injection.js — issue #89 (0.7.2 PR 4.1) coverage\n');

const SDK_URL = 'https://op.example/sharc-creative.js';

// =========================================================================
// 1. Constructor validation (Rule 12)
// =========================================================================
{
  console.log('1. Constructor validation (Rule 12)');

  function expectThrow(label, value) {
    let threw = null;
    try {
      new SHARCContainer(baseMarkupOpts({ creativeSdkUrl: value }));
    } catch (e) { threw = e; }
    assert(threw instanceof TypeError,
      `${label} → TypeError thrown`);
    assert(threw && /creativeSdkUrl/.test(String(threw.message)),
      `${label} → error message names creativeSdkUrl`);
  }

  expectThrow('creativeSdkUrl: null', null);
  expectThrow('creativeSdkUrl: empty string', '');
  expectThrow('creativeSdkUrl: number (123)', 123);
  expectThrow('creativeSdkUrl: object', { url: 'x' });
  expectThrow('creativeSdkUrl: boolean (true)', true);
  expectThrow('creativeSdkUrl: boolean (false)', false);

  // Accepted shape: explicit URL
  {
    let c = null;
    try {
      c = track(new SHARCContainer(baseMarkupOpts({ creativeSdkUrl: SDK_URL })));
    } catch (e) {
      assert(false, 'valid creativeSdkUrl construction threw: ' + (e && e.message));
    }
    assert(c !== null, 'valid creativeSdkUrl → instance constructed');
    assert(c && c._creativeSdkUrl === SDK_URL,
      'instance._creativeSdkUrl mirrors the constructor arg');
    assert(c && c._creativeSdkSkipIfPresent === true,
      'instance._creativeSdkSkipIfPresent defaults to true');
    assert(c && c._creativeSdkScriptAttrs && typeof c._creativeSdkScriptAttrs === 'object',
      'instance._creativeSdkScriptAttrs defaults to an object');
  }

  // Accepted shape: omitted entirely → _creativeSdkUrl === null
  {
    const c = track(new SHARCContainer(baseMarkupOpts({})));
    assert(c._creativeSdkUrl === null,
      'omitted creativeSdkUrl → _creativeSdkUrl === null (no injection)');
  }

  flushContainers();
}

// =========================================================================
// 2. Injection-position contract (4-step, most-specific-wins)
// =========================================================================
{
  console.log('\n2. Injection-position contract');

  const expectedTag = '<script src="' + SDK_URL + '"></script>';

  function injectWith(html) {
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    return c._runMarkupInjection();
  }

  // 2a — markup with <head> → injected after head open tag
  {
    const html = '<!DOCTYPE html><html><head><title>Ad</title></head><body>x</body></html>';
    const out = injectWith(html);
    const expected = '<!DOCTYPE html><html><head>' + expectedTag + '<title>Ad</title></head><body>x</body></html>';
    assert(out === expected,
      '2a. <head> present → script injected immediately after <head> open tag');
  }

  // 2b — case-insensitive <HEAD>
  {
    const html = '<!DOCTYPE html><HTML><HEAD></HEAD><BODY>x</BODY></HTML>';
    const out = injectWith(html);
    assert(out.indexOf('<HEAD>' + expectedTag) !== -1,
      '2b. <HEAD> (uppercase) → matched case-insensitively, script injected after open tag');
  }

  // 2c — <head lang="en"> attrs on the tag are preserved
  {
    const html = '<html><head lang="en" class="x"></head><body></body></html>';
    const out = injectWith(html);
    assert(out.indexOf('<head lang="en" class="x">' + expectedTag) !== -1,
      '2c. <head> with attributes → script injected after full open tag (attrs preserved)');
  }

  // 2d — <html> only, no <head>
  {
    const html = '<!DOCTYPE html><html><body>x</body></html>';
    const out = injectWith(html);
    assert(out === '<!DOCTYPE html><html>' + expectedTag + '<body>x</body></html>',
      '2d. <html> present (no <head>) → script injected after <html> open tag');
  }

  // 2e — <!DOCTYPE> only (no html, no head). CRITICAL doctype-edge case:
  //      a naive injector would prepend (placing the tag BEFORE the doctype)
  //      and trigger quirks-mode rendering. Insert AFTER the declaration.
  {
    const html = '<!DOCTYPE html><body>fragment</body>';
    const out = injectWith(html);
    assert(out === '<!DOCTYPE html>' + expectedTag + '<body>fragment</body>',
      '2e. <!DOCTYPE> only → script injected AFTER doctype (regression guard against quirks-mode)');
    assert(out.indexOf(expectedTag) > out.indexOf('<!DOCTYPE'),
      '2e (sanity). script tag position is AFTER the doctype declaration, not before');
  }

  // 2f — lowercase <!doctype html>
  {
    const html = '<!doctype html><body>x</body>';
    const out = injectWith(html);
    assert(out === '<!doctype html>' + expectedTag + '<body>x</body>',
      '2f. lowercase <!doctype html> → handled, script injected AFTER declaration');
  }

  // 2g — fragment markup (no doctype, no html, no head) → prepend
  {
    const html = '<div class="ad"><img src="img.png"></div>';
    const out = injectWith(html);
    assert(out === expectedTag + html,
      '2g. fragment markup → script prepended (no anchor element present)');
  }

  flushContainers();
}

// =========================================================================
// 3. Idempotency (creativeSdkSkipIfPresent)
// =========================================================================
{
  console.log('\n3. Idempotency — creativeSdkSkipIfPresent contract');

  // 3a — default true: markup already containing sharc-creative.js is unchanged
  {
    const html = '<html><head><script src="https://prior-cdn/sharc-creative.js"></script></head><body>x</body></html>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '3a. skipIfPresent default true + sharc-creative.js already present → returned unchanged');
    assert(c.creativeInjected !== true,
      '3a (sanity). creativeInjected flag NOT flipped when injection is a no-op');
  }

  // 3b — default true: markup with a DIFFERENT filename still gets injected
  //      (presence check is filename-substring, not generic "any script")
  {
    const html = '<html><head><script src="https://cdn/some-other-thing.js"></script></head><body></body></html>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out !== html,
      '3b. skipIfPresent default true + DIFFERENT filename present → still injects (substring is filename-specific)');
    assert(out.indexOf(SDK_URL) !== -1,
      '3b (sanity). injected script src matches the configured creativeSdkUrl');
  }

  // 3c — back-to-back: two separate containers produce identical output
  //      (idempotency across instances). One container per call because
  //      creativeInjected flips after the first call.
  {
    const html = '<html><head></head><body></body></html>';
    const c1 = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html, creativeSdkUrl: SDK_URL,
    })));
    const c2 = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html, creativeSdkUrl: SDK_URL,
    })));
    const once = c1._runMarkupInjection();
    const twice = c2._runMarkupInjection();
    assert(once === twice,
      '3c. two separate containers with same input produce identical injected output');
    const matches = (once.match(/sharc-creative\.js/g) || []).length;
    assert(matches === 1,
      '3c (sanity). exactly one sharc-creative.js script tag present per pass');
  }

  // 3d — passing already-injected markup back through is a no-op (single
  //      container, second pass over previously-injected output)
  {
    const html = '<html><head></head><body></body></html>';
    const c1 = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html, creativeSdkUrl: SDK_URL,
    })));
    const once = c1._runMarkupInjection();
    const c2 = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: once, creativeSdkUrl: SDK_URL,
    })));
    const twice = c2._runMarkupInjection();
    assert(once === twice,
      '3d. second container fed previously-injected markup → output is identical (skipIfPresent fires)');
  }

  // 3e — creativeSdkSkipIfPresent: false → always injects
  {
    const html = '<html><head><script src="sharc-creative.js"></script></head><body></body></html>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
      creativeSdkSkipIfPresent: false,
    })));
    const out = c._runMarkupInjection();
    assert(out !== html,
      '3e. creativeSdkSkipIfPresent: false → injects even when sharc-creative.js already present');
    const matches = (out.match(/sharc-creative\.js/g) || []).length;
    assert(matches === 2,
      '3e (sanity). creativeSdkSkipIfPresent: false → two sharc-creative.js script tags present after force-inject');
  }

  flushContainers();
}

// =========================================================================
// 4. scriptAttrs serialization (creativeSdkScriptAttrs)
// =========================================================================
{
  console.log('\n4. creativeSdkScriptAttrs serialization');

  function injectWithAttrs(attrs, url) {
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: '<html><head></head></html>',
      creativeSdkUrl: url || SDK_URL,
      creativeSdkScriptAttrs: attrs,
    })));
    return c._runMarkupInjection();
  }

  // 4a — { async: true } → bare attr
  {
    const out = injectWithAttrs({ async: true });
    assert(out.indexOf('<script src="' + SDK_URL + '" async></script>') !== -1,
      '4a. { async: true } → emitted as bare attribute (no `="true"`)');
  }

  // 4b — { async: true, defer: true } → both bare
  {
    const out = injectWithAttrs({ async: true, defer: true });
    assert(out.indexOf('<script src="' + SDK_URL + '" async defer></script>') !== -1,
      '4b. { async: true, defer: true } → both rendered as bare attributes');
  }

  // 4c — { async: false } → omitted
  {
    const out = injectWithAttrs({ async: false });
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '4c. { async: false } → attribute omitted entirely');
    assert(out.indexOf('async') === -1,
      '4c (sanity). no `async` substring anywhere in the injected tag');
  }

  // 4d — null / undefined attr values → omitted; only truthy attrs render
  {
    const out = injectWithAttrs({ defer: null, nomodule: undefined, async: true });
    assert(out.indexOf('<script src="' + SDK_URL + '" async></script>') !== -1,
      '4d. null / undefined attr values → omitted; only truthy attrs render');
  }

  // 4e — string attr value (quoted)
  {
    const out = injectWithAttrs({ integrity: 'sha384-XYZ' });
    assert(out.indexOf('<script src="' + SDK_URL + '" integrity="sha384-XYZ"></script>') !== -1,
      '4e. { integrity: "sha384-XYZ" } → rendered as quoted attribute');
  }

  // 4f — string attr containing `"` → HTML-escaped
  {
    const out = injectWithAttrs({ nonce: 'a"b' });
    assert(out.indexOf('nonce="a&quot;b"') !== -1,
      '4f. attribute value containing `"` → escaped to `&quot;` (defense against attribute-injection)');
    assert(out.indexOf('nonce="a"b"') === -1,
      '4f (sanity). raw unescaped value is NOT present in output');
  }

  // 4g — string attr containing `&` → HTML-escaped
  {
    const out = injectWithAttrs({ 'data-rtb': 'a&b' });
    assert(out.indexOf('data-rtb="a&amp;b"') !== -1,
      '4g. attribute value containing `&` → escaped to `&amp;` (entity-correctness)');
  }

  // 4h — creativeSdkUrl with `&` → src value HTML-escaped
  {
    const out = injectWithAttrs(undefined, 'https://op.example/sdk.js?v=1&hash=abc');
    assert(out.indexOf('src="https://op.example/sdk.js?v=1&amp;hash=abc"') !== -1,
      '4h. creativeSdkUrl with `&` → src value HTML-escaped (entity-correctness)');
  }

  flushContainers();
}

// =========================================================================
// 5. SHARCContainer integration
// =========================================================================
{
  console.log('\n5. SHARCContainer integration');

  // 5a — creativeInjected flag flips true after _runMarkupInjection()
  {
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: '<!DOCTYPE html><html><head></head><body><h1>Ad</h1></body></html>',
      creativeSdkUrl: SDK_URL,
    })));
    const injected = c._runMarkupInjection();
    assert(injected.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '5a. container._runMarkupInjection() returns markup containing the SDK script tag');
    assert(c.creativeInjected === true,
      '5b. container.creativeInjected flag flipped true after injection');
  }

  // 5c — when NO creativeSdkUrl is set, _runMarkupInjection() returns markup
  //      unchanged AND the feature is not advertised
  {
    const html = '<!DOCTYPE html><html><head></head><body>x</body></html>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      // no creativeSdkUrl
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '5c. no creativeSdkUrl → _runMarkupInjection() returns markup unchanged');
    assert(c.creativeInjected !== true,
      '5c (sanity). creativeInjected flag NOT flipped when no injection happens');
    assert(c._creativeSdkUrl === null,
      '5c (sanity). _creativeSdkUrl === null when omitted');
  }

  // 5d — feature 'com.iabtechlab.sharc.creative-injector' surfaces in the
  //      merged supportedFeatures list. Drive _handleCreateSession with a
  //      synthetic msg; stub _protocol.acceptSession + sendInit so the merge
  //      path runs without needing a real port pair or a real UUID v4.
  {
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: '<!DOCTYPE html><html><head></head><body>x</body></html>',
      creativeSdkUrl: SDK_URL,
    })));
    if (c._protocol) {
      c._protocol.acceptSession = function () {
        // Bypass UUID v4 check + actual port resolve. Setting sessionId to a
        // non-empty string lets _handleCreateSession proceed past the
        // "if (sessionId === '') return;" early-bail at line ~2898.
        c._protocol.sessionId = 'test-session-id';
      };
      // Return a never-settling promise so _handleInitResolved doesn't
      // cascade into _sendStartCreative after the container is terminated.
      c._protocol.sendInit = function () { return new Promise(() => {}); };
      try {
        c._handleCreateSession({ args: { version: '0.7.1' } });
      } catch (_) { /* ignore handler-internal errors after merge */ }
    }
    const cached = c._mergedSupportedFeatures;
    assert(Array.isArray(cached) && cached.includes('com.iabtechlab.sharc.creative-injector'),
      '5d. com.iabtechlab.sharc.creative-injector appears in _mergedSupportedFeatures');
  }

  // 5e — when NO creativeSdkUrl is set, the built-in feature is NOT advertised
  {
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: '<!DOCTYPE html><html><head></head><body>x</body></html>',
      // no creativeSdkUrl
    })));
    if (c._protocol) {
      c._protocol.acceptSession = function () {
        c._protocol.sessionId = 'test-session-id';
      };
      // Return a never-settling promise so _handleInitResolved doesn't
      // cascade into _sendStartCreative after the container is terminated.
      c._protocol.sendInit = function () { return new Promise(() => {}); };
      try {
        c._handleCreateSession({ args: { version: '0.7.1' } });
      } catch (_) { /* ignore */ }
    }
    const cached = c._mergedSupportedFeatures;
    assert(Array.isArray(cached) && !cached.includes('com.iabtechlab.sharc.creative-injector'),
      '5e. NO creativeSdkUrl → built-in feature is NOT advertised');
  }

  flushContainers();
}

// =========================================================================
// 6. Multi-extension sequencing — built-in runs BEFORE operator extensions
// =========================================================================
{
  console.log('\n6. Multi-extension sequencing — built-in runs BEFORE operator extensions');

  // 6a — operator extension's injectIntoMarkup() sees markup with the SDK
  //      script tag ALREADY present (proves built-in runs first)
  {
    let recordedInput = null;
    const recordingExtension = {
      getFeatureName() { return 'com.example.recorder'; },
      injectIntoMarkup(html) {
        recordedInput = html;
        return html; // pass through unchanged
      },
    };

    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: '<!DOCTYPE html><html><head></head><body>x</body></html>',
      creativeSdkUrl: SDK_URL,
      extensions: [recordingExtension],
    })));
    c._runMarkupInjection();

    assert(recordedInput !== null,
      '6a (sanity). operator extension was invoked');
    assert(recordedInput && recordedInput.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '6a. operator extension sees markup with SDK script tag ALREADY present');
  }

  // 6b — operator extension that ALSO injects the SDK does not produce
  //      double-injection (skipIfPresent dedup applies on its pass too —
  //      but the dedup is on the built-in's regex pass, not on the operator
  //      extension. If the operator extension is sloppy, the built-in CAN'T
  //      help. So this test is really: built-in is idempotent against its
  //      OWN re-pass via skipIfPresent, but ALSO doesn't itself double-inject.
  //      Two consecutive _runMarkupInjection() calls on the same container
  //      can't be exercised directly because the public API is "call once
  //      per load." Cover that case via 3d above. Here, prove that an
  //      operator extension passing through unchanged doesn't cause the
  //      built-in to re-fire.)
  {
    const passThroughExtension = {
      getFeatureName() { return 'com.example.passthrough'; },
      injectIntoMarkup(html) { return html; },
    };

    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: '<!DOCTYPE html><html><head></head><body>x</body></html>',
      creativeSdkUrl: SDK_URL,
      extensions: [passThroughExtension],
    })));
    const out = c._runMarkupInjection();
    const matches = (out.match(/sharc-creative\.js/g) || []).length;
    assert(matches === 1,
      '6b. exactly one sharc-creative.js tag after built-in + pass-through extension');
  }

  flushContainers();
}

// =========================================================================
// 7. Review-fixup regression coverage (post-PR-103 round 1)
// =========================================================================

// 7a — `<head[^>]*>` regex must NOT match `<header>`. Before the lookahead
//      fix, Bootstrap/Tailwind landing-page creatives using `<header>` would
//      have the SDK script injected inside the header element rather than
//      the document head. Fix is `(?=[\s>])` lookahead.
{
  console.log('\n7a. <head> regex rejects <header> false-positive');

  // Pure-`<header>` markup — should fall through to position 4 (prepend),
  // NOT match position 1's <head> branch.
  {
    const html = '<header class="top">welcome</header><main>body</main>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.startsWith('<script src="' + SDK_URL + '"></script><header'),
      '7a-1. <header>-only markup: SDK script prepended (position 4), not injected inside <header>');
    assert(out.indexOf('<header class="top"><script') === -1,
      '7a-2. <header>-only markup: NOT injected inside <header> element');
  }

  // Mixed markup with `<header>` BEFORE `<head>`. The regex must still
  // correctly find `<head>` and skip the `<header>` false-positive.
  {
    const html = '<!DOCTYPE html><html><body><header>nav</header></body><head><title>x</title></head></html>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<head><script src="' + SDK_URL + '"></script><title>') !== -1,
      '7a-3. mixed <header> + <head> markup: SDK lands in <head>, not <header>');
    assert(out.indexOf('<header><script') === -1,
      '7a-4. mixed markup: NOT injected inside <header>');
  }

  flushContainers();
}

// 7b — `skipIfPresent` regex must require real `<script src="…">` context,
//      not a bare substring. Pre-fix: bare substring match would match a
//      `<!-- sharc-creative.js -->` comment and skip injection, producing
//      a silent no-op.
{
  console.log('\n7b. skipIfPresent regex requires real <script src="..."> context');

  // Substring in HTML comment — must NOT skip.
  {
    const html = '<head><!-- sharc-creative.js was loaded by the gateway --></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '7b-1. comment containing "sharc-creative.js" substring: SDK still injected (skipIfPresent does not fire on comment)');
  }

  // Substring in <meta content="..."> — must NOT skip.
  {
    const html = '<head><meta name="modules" content="sharc-creative.js, foo.js"></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '7b-2. <meta> with substring "sharc-creative.js": SDK still injected');
  }

  // Substring in inline script TEXT (not src) — must NOT skip.
  {
    const html = '<head><script>console.log("sharc-creative.js not found")</script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('src="' + SDK_URL + '"></script>') !== -1,
      '7b-3. inline <script> string mentioning "sharc-creative.js": SDK still injected');
  }

  // Positive control: a real `<script src="...sharc-creative.js">` SHOULD
  // trigger the skip.
  {
    const html = '<head><script src="https://cdn.operator/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '7b-4. positive control: real <script src="…sharc-creative.js"> already present → skipIfPresent triggers, returned unchanged');
  }

  flushContainers();
}

// =========================================================================
// Summary
// =========================================================================
console.log('');
if (failures > 0) {
  process.stderr.write(`✗ ${failures} creative-sdk-injection assertion(s) failed.\n`);
  process.exit(1);
} else {
  console.log('✓ All creative-sdk-injection assertions passed.');
}
