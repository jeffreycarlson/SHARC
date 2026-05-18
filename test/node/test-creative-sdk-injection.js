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
 *      - 3f–3k: round-1 regex tightening — unquoted src, filename collisions,
 *               query / fragment boundary cases (PR #105 review Fix 2)
 *      - 3l–3p: round-2 attribute-name boundary — `data-src`, `xsrc`, `1src`
 *               do NOT trigger skipIfPresent (negative lookbehind closes the
 *               `\b` false-positive on `-` and other non-word boundaries);
 *               whitespace and quoted-attr context before `src=` still DO
 *               (PR #105 round-2 Fix 1)
 *      - 3q–3r: round-3 attribute-name boundary — `data.src` and `xml:src`
 *               do NOT trigger skipIfPresent (`.` and `:` added to lookbehind
 *               exclusion class; both are valid HTML5 attribute-name continuation
 *               chars, so browsers tokenize them as single attributes)
 *               (PR #105 round-3 Fix M-1)
 *      - 3s: round-4 query-string slash bypass — `loader.js?next=/sharc-creative.js`
 *            does NOT trigger skipIfPresent (path prefix excludes `?` and `#`,
 *            so embedded slashes inside a query string can't reach the literal
 *            filename match)
 *            (PR #105 round-4 Fix HIGH)
 *
 *   4. scriptAttrs serialization (creativeSdkScriptAttrs)
 *      - { async: true } / { async, defer } / { async: false } → bare/omitted
 *      - null / undefined values → omitted
 *      - string attr → quoted; `"` and `&` escaped
 *      - creativeSdkUrl with `&` → src value escaped
 *      - 4i–4k: round-1 attribute-name validation (PR #105 review Fix 3)
 *      - 4l–4m: round-1 adversarial creativeSdkUrl content escape
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
 *   8. URL-variant capability honesty (PR #105 review Fix 1)
 *      - URL-variant container with creativeSdkUrl → _creativeSdkUrl === null
 *      - URL-variant container does NOT advertise the creative-injector feature
 *      - URL-variant construction with creativeSdkUrl does NOT throw
 *      - Negative control: Markup variant + creativeSdkUrl still advertises
 *
 *   9. Built-in injection throw-tolerance (PR #105 review Fix 4)
 *      - _injectCreativeSdk throwing does NOT propagate out of _runMarkupInjection
 *      - markup falls back unchanged + creativeInjected stays false
 *      - throw-tolerance console.warn fires with the expected shape
 *      - 9c: round-2 — operator extensions still run AFTER a swallowed
 *            built-in throw (try/catch is locally scoped to the built-in
 *            call; extension loop continues unaffected)
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

// console.warn capture — used by sections 4 and 9 to assert the
// throw-tolerance / invalid-attribute-name warnings fire with the
// expected shape. Replace and restore around each capturing block.
function captureWarn(fn) {
  const captured = [];
  const original = console.warn;
  console.warn = function (...args) { captured.push(args); };
  try { fn(); } finally { console.warn = original; }
  return captured;
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

// URL-variant base options (Fix 1 / section 8). URL variant doesn't need
// creativeRendererUrl — the renderer protocol is Markup-only.
function baseUrlOpts(overrides) {
  return {
    creativeUrl: 'https://ads.example/creative.html',
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

  // ─── PR #105 review Fix 2: skipIfPresent regex tightening ─────────────
  // The previous regex (`["'][^"']*sharc-creative\.js`) had two gaps:
  //   (1) required a quote → missed unquoted `src=URL` (legal HTML, common
  //       in minified ad markup — the exact use case this PR targets).
  //   (2) no boundary after `.js` + greedy `[^"']*` → false-skipped on
  //       filename collisions like `notsharc-creative.js`,
  //       `sharc-creative.js.map`, or `foo?next=sharc-creative.js`.
  // The new regex closes both: optional quote + non-greedy path prefix
  // ending in `/` + lookahead `(?=[?#"'\s>]|$)` for the filename boundary.

  // 3f — unquoted src → skipIfPresent fires (no injection)
  {
    const html = '<head><script src=https://cdn/sharc-creative.js></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '3f. unquoted src=URL (legal HTML) → skipIfPresent fires, markup unchanged');
  }

  // 3g — filename-collision `notsharc-creative.js` → skipIfPresent does NOT fire
  {
    const html = '<head><script src="https://cdn/notsharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3g. notsharc-creative.js → skipIfPresent does NOT fire (filename collision rejected by leading-slash boundary)');
  }

  // 3h — extension-collision `sharc-creative.js.map` → skipIfPresent does NOT fire
  {
    const html = '<head><script src="sharc-creative.js.map"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3h. sharc-creative.js.map → skipIfPresent does NOT fire (trailing-boundary lookahead rejects)');
  }

  // 3i — query-string `sharc-creative.js?v=2` → skipIfPresent fires
  {
    const html = '<head><script src="https://cdn/sharc-creative.js?v=2"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '3i. sharc-creative.js?v=2 → skipIfPresent fires (query-string boundary allowed)');
  }

  // 3j — fragment `sharc-creative.js#frag` → skipIfPresent fires
  {
    const html = '<head><script src="https://cdn/sharc-creative.js#frag"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '3j. sharc-creative.js#frag → skipIfPresent fires (fragment boundary allowed)');
  }

  // 3k — substring inside another src's query string → skipIfPresent does NOT fire
  //      `foo?next=sharc-creative.js` is NOT a sharc-creative.js script src,
  //      it's a different filename whose query string mentions sharc-creative.js.
  {
    const html = '<head><script src="foo?next=sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3k. foo?next=sharc-creative.js → skipIfPresent does NOT fire (sharc-creative.js is in the query, not the filename)');
  }

  // ─── PR #105 round-2 Fix 1: attribute-name boundary (negative lookbehind) ───
  // The round-1 regex used `\bsrc\s*=`. Because `-` is a non-word char, `\b`
  // fires AFTER it — so `data-src=` matched `src=` and a markup like
  // `<script src="ok.js" data-src="…sharc-creative.js">` false-positive-
  // skipped injection (the SDK is not actually loaded; only the operator-
  // controlled data-src attribute happens to mention the filename). The
  // round-2 fix replaces `\bsrc` with negative lookbehind `(?<![\w-])src`
  // so any character ending in a word-char or hyphen disqualifies the match.

  // 3l — `data-src` carrying the filename → skipIfPresent does NOT fire
  //      The real `src="ok.js"` is a different filename; data-src is not a
  //      script load. Built-in must still inject the SDK.
  {
    const html = '<head><script src="ok.js" data-src="https://cdn/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3l. data-src="…sharc-creative.js" → skipIfPresent does NOT fire (lookbehind rejects `-` boundary; built-in still injects)');
  }

  // 3m — `xsrc` attribute carrying the filename → skipIfPresent does NOT fire
  //      `xsrc` is a made-up attribute, not `src`. The previous `\b` form
  //      didn't fire here (since `xs` is word-internal), but make it explicit.
  {
    const html = '<head><script xsrc="https://cdn/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3m. xsrc="…sharc-creative.js" → skipIfPresent does NOT fire (xsrc is not src)');
  }

  // 3n — `1src` attribute carrying the filename → skipIfPresent does NOT fire
  //      Digits are word chars, so the lookbehind blocks this as well.
  {
    const html = '<head><script 1src="https://cdn/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3n. 1src="…sharc-creative.js" → skipIfPresent does NOT fire (digit boundary blocked by `\\w` in lookbehind)');
  }

  // 3o — positive control: whitespace before `src=` (newline) → skipIfPresent fires
  //      Common real-world formatting; lookbehind only blocks `[\w-]`, so
  //      whitespace passes.
  {
    const html = '<head><script\nsrc="https://cdn/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '3o. <script\\nsrc="…sharc-creative.js"> → skipIfPresent fires (whitespace before src passes lookbehind)');
  }

  // 3p — positive control: quoted prior attribute then space then `src=` →
  //      skipIfPresent fires. The character before `src` is a space, which
  //      isn't `[\w-]`, so the lookbehind passes. Regression guard against
  //      over-tightening.
  {
    const html = '<head><script onload="x" src="https://cdn/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out === html,
      '3p. <script onload="x" src="…sharc-creative.js"> → skipIfPresent fires (space-after-quoted-attr before src is valid context)');
  }

  // 3q — round-3: `data.src=` MUST NOT trigger skipIfPresent. `.` is a valid
  //      HTML5 attribute-name continuation char; browsers tokenize `data.src`
  //      as a single attribute. The round-2 form `(?<![\w-])src` passed the
  //      lookbehind on `.` (not in `[\w-]`) and matched the trailing `src` →
  //      false-skip. Round-3 lookbehind `(?<![\w.:-])src` rejects this.
  {
    const html = '<head><script src="ok.js" data.src="https://cdn/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out !== html,
      '3q. data.src="…sharc-creative.js" → skipIfPresent does NOT fire (round-3 lookbehind rejects `.` boundary; built-in still injects)');
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3q (sanity). SDK script tag is present in injected output');
  }

  // 3r — round-3: `xml:src=` MUST NOT trigger skipIfPresent. `:` is a valid
  //      HTML5/XML attribute-name continuation char (namespaces). Browsers
  //      parse `xml:src` as a single attribute. Same root cause + fix as 3q.
  {
    const html = '<head><script src="ok.js" xml:src="https://cdn/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out !== html,
      '3r. xml:src="…sharc-creative.js" → skipIfPresent does NOT fire (round-3 lookbehind rejects `:` boundary; built-in still injects)');
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3r (sanity). SDK script tag is present in injected output');
  }

  // 3s — round-4: query-string slash bypass. `<script src="loader.js?next=/sharc-creative.js">`
  //      previously matched because the path prefix `[^"'\s>]*?\/` happily
  //      consumed `loader.js?next=/` (the `?` and `=` weren't in the exclusion
  //      class). The real load is `loader.js`; `sharc-creative.js` only appears
  //      in the query value. Round-4 restricts the prefix to `[^"'\s>?#]*?\/`
  //      — only URL-path characters, no query or fragment chars — so the
  //      prefix can't reach the embedded `/` in the query and the regex
  //      correctly does NOT match.
  {
    const html = '<head><script src="https://cdn/loader.js?next=/sharc-creative.js"></script></head><body>x</body>';
    const c = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: html,
      creativeSdkUrl: SDK_URL,
    })));
    const out = c._runMarkupInjection();
    assert(out !== html,
      '3s. src="loader.js?next=/sharc-creative.js" → skipIfPresent does NOT fire (round-4 prefix excludes `?` and `#`; embedded query-string slash cannot reach the literal filename)');
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '3s (sanity). SDK script tag is present in injected output');
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

  // ─── PR #105 review Fix 3: attribute-name validation ──────────────────
  // The previous serializer HTML-escaped values but emitted attribute names
  // verbatim. A hostile key like `'></script><img src=x onerror=alert(1)'`
  // would break out of the <script> tag despite value escaping. The fix
  // validates each name against the HTML5 attribute-name grammar
  // (/^[a-zA-Z][a-zA-Z0-9_:.-]*$/) and skip+warn on anything else.

  // 4i — invalid attribute name containing space + `=` → skipped, console.warn
  {
    let out = null;
    const warns = captureWarn(() => {
      out = injectWithAttrs({ 'x onerror=alert(1)': 'foo' });
    });
    assert(out !== null && out.indexOf('onerror') === -1,
      '4i. invalid attribute name "x onerror=alert(1)" → omitted from output (no `onerror` substring)');
    const matched = warns.some((args) => /Skipping invalid attribute name/.test(String(args[0])));
    assert(matched,
      '4i (sanity). console.warn fired with "Skipping invalid attribute name" message');
  }

  // 4j — invalid attribute name with `>` and `<` (script-break payload) → skipped
  {
    let out = null;
    captureWarn(() => {
      out = injectWithAttrs({ '></script><img': 'x' });
    });
    assert(out !== null && out.indexOf('<img') === -1,
      '4j. invalid attribute name with `<img` payload → omitted from output (no `<img` substring)');
    assert(out !== null && out.indexOf('</script>') !== -1
      && out.indexOf('</script><img') === -1,
      '4j (sanity). only the closing </script> from the injected tag is present, not the payload');
  }

  // 4k — valid namespaced names (data-*, aria-*) pass through. Regression
  //      guard against over-tightening the name regex.
  {
    const out = injectWithAttrs({ 'data-rtb-id': 'foo', 'aria-label': 'Ad' });
    assert(out.indexOf('data-rtb-id="foo"') !== -1,
      '4k. data-rtb-id passes through unchanged (namespaced name allowed)');
    assert(out.indexOf('aria-label="Ad"') !== -1,
      '4k (sanity). aria-label passes through unchanged (namespaced name allowed)');
  }

  // ─── PR #105 review: adversarial creativeSdkUrl content ───────────────
  // The src= attribute value is also operator-controlled and may carry
  // RTB-macro-substituted content. Confirm _escapeAttrValue covers `"`
  // (4l) and `<` (4m) — closing the attribute-injection path on src too.

  // 4l — creativeSdkUrl containing `"` and `<script>` payload → escaped
  {
    const out = injectWithAttrs(undefined, 'https://op/sdk?v="><script>alert(1)</script>');
    assert(out.indexOf('&quot;') !== -1,
      '4l. creativeSdkUrl containing `"` → escaped to `&quot;` in src attribute');
    // The injected tag uses double-quoted src, so a raw `"` inside the
    // src value would prematurely close the attribute. The escape pass
    // converts it to `&quot;` — verify the raw `"` does NOT appear inside
    // the src value (only as the surrounding boundary).
    assert(out.indexOf('src="https://op/sdk?v="') === -1,
      '4l (sanity). raw `"` is NOT present inside the src value (would break attribute)');
    // The opening `<` of the injection payload must be entity-escaped.
    // `>` is intentionally NOT escaped — inside a double-quoted attribute
    // value, `>` is harmless (the attribute ends at the next `"`). The
    // escape contract is `&`/`"`/`<` only (verbatim from PR #103); the
    // breakout vector is `"`, which 4l above already verifies is blocked.
    assert(out.indexOf('&lt;script') !== -1,
      '4l (further). `<script` opening tag escaped to `&lt;script` (breaks the injection payload)');
  }

  // 4m — creativeSdkUrl containing `<` → HTML-escaped
  {
    const out = injectWithAttrs(undefined, 'https://op/sdk?x=<b>');
    assert(out.indexOf('&lt;b') !== -1,
      '4m. creativeSdkUrl containing `<b>` → `<` escaped to `&lt;` in src attribute');
    // `>` left unescaped is intentional and harmless inside a `"`-quoted attribute.
    assert(out.indexOf('src="https://op/sdk?x=<b>"') === -1,
      '4m (sanity). raw `<` is NOT present in the src attribute value');
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
// 8. URL-variant capability honesty (PR #105 review Fix 1)
// =========================================================================
// The previous storage line `this._creativeSdkUrl = creativeSdkUrl === undefined
// ? null : creativeSdkUrl;` accepted the option on URL-variant containers
// and then advertised the `com.iabtechlab.sharc.creative-injector` feature
// from _handleCreateSession. But injection only fires from _runMarkupInjection
// (Markup variant only) — a SHARC-aware creative trusting the feature flag
// would skip its own SDK bootstrap and fail to handshake. Silent-ignore on
// URL variant (no throw — operators commonly share constructor config across
// Markup and URL bid variants and shouldn't have to know per-bid).
{
  console.log('\n8. URL-variant capability honesty (PR #105 review Fix 1)');

  // 8a — URL-variant container with creativeSdkUrl → _creativeSdkUrl === null
  {
    const c = track(new SHARCContainer(baseUrlOpts({ creativeSdkUrl: SDK_URL })));
    assert(c._creativeSdkUrl === null,
      '8a. URL-variant container with creativeSdkUrl → _creativeSdkUrl === null (storage gated on Markup variant)');
    assert(c.creativeSource === 'url',
      '8a (sanity). container.creativeSource === "url" — confirming URL variant');
  }

  // 8b — URL-variant container does NOT advertise the creative-injector feature
  {
    const c = track(new SHARCContainer(baseUrlOpts({ creativeSdkUrl: SDK_URL })));
    if (c._protocol) {
      c._protocol.acceptSession = function () {
        c._protocol.sessionId = 'test-session-id';
      };
      c._protocol.sendInit = function () { return new Promise(() => {}); };
      try {
        c._handleCreateSession({ args: { version: '0.7.1' } });
      } catch (_) { /* ignore */ }
    }
    const cached = c._mergedSupportedFeatures;
    assert(Array.isArray(cached) && !cached.includes('com.iabtechlab.sharc.creative-injector'),
      '8b. URL-variant + creativeSdkUrl → feature NOT advertised (no capability lie)');
  }

  // 8c — URL-variant construction with creativeSdkUrl does NOT throw
  //      (silent-ignore contract — operators share constructor config across
  //      Markup and URL bid variants without per-bid awareness).
  {
    let threw = null;
    try {
      track(new SHARCContainer(baseUrlOpts({ creativeSdkUrl: SDK_URL })));
    } catch (e) { threw = e; }
    assert(threw === null,
      '8c. URL-variant + creativeSdkUrl construction does NOT throw (silent-ignore, not error)');
  }

  // 8d — Negative control: Markup variant + creativeSdkUrl STILL advertises
  //      the feature. Regression guard against over-correcting Fix 1.
  {
    const c = track(new SHARCContainer(baseMarkupOpts({ creativeSdkUrl: SDK_URL })));
    assert(c._creativeSdkUrl === SDK_URL,
      '8d (sanity). Markup variant + creativeSdkUrl → _creativeSdkUrl stored');
    if (c._protocol) {
      c._protocol.acceptSession = function () {
        c._protocol.sessionId = 'test-session-id';
      };
      c._protocol.sendInit = function () { return new Promise(() => {}); };
      try {
        c._handleCreateSession({ args: { version: '0.7.1' } });
      } catch (_) { /* ignore */ }
    }
    const cached = c._mergedSupportedFeatures;
    assert(Array.isArray(cached) && cached.includes('com.iabtechlab.sharc.creative-injector'),
      '8d. Markup variant + creativeSdkUrl → feature STILL advertised (no over-correction)');
  }

  flushContainers();
}

// =========================================================================
// 9. Built-in injection throw-tolerance (PR #105 review Fix 4)
// =========================================================================
// The built-in injection call in _runMarkupInjection() was NOT wrapped in
// try/catch, while the operator-extension loop below it WAS. If
// _creativeSdkScriptAttrs contains a throwing getter or a value whose
// toString throws, the exception would propagate up through the iframe load
// event handler and break the entire load. Self-DOS only (operator passes
// hostile config to themselves), but an asymmetric gap. The fix mirrors the
// extension-loop pattern: swallow + console.warn, return original markup.
{
  console.log('\n9. Built-in injection throw-tolerance (PR #105 review Fix 4)');

  // Easier setup than fighting a defineProperty getter: monkey-patch
  // _injectCreativeSdk on the instance to throw. The contract is "the
  // try/catch in _runMarkupInjection swallows any error from the built-in
  // injection call" — exactly what this exercises.
  const originalMarkup = '<!DOCTYPE html><html><head></head><body>x</body></html>';
  const c = track(new SHARCContainer(baseMarkupOpts({
    creativeHtml: originalMarkup,
    creativeSdkUrl: SDK_URL,
  })));
  c._injectCreativeSdk = function () {
    throw new Error('synthetic injection failure');
  };

  let result = null;
  let threwOut = null;
  const warns = captureWarn(() => {
    try {
      result = c._runMarkupInjection();
    } catch (e) {
      threwOut = e;
    }
  });

  // 9a — does NOT throw, returns original markup unchanged, creativeInjected stays false
  assert(threwOut === null,
    '9a. _runMarkupInjection() does NOT propagate the synthetic injection error');
  assert(result === originalMarkup,
    '9a (sanity). markup falls back to the original (unchanged) input');
  assert(c.creativeInjected !== true,
    '9a (further). creativeInjected stays false after swallowed throw');

  // 9b — throw-tolerance warning fires with expected shape
  {
    const matched = warns.some((args) =>
      /Built-in SDK injection threw/.test(String(args[0])));
    assert(matched,
      '9b. console.warn fires with "Built-in SDK injection threw; continuing with original HTML."');
  }

  // ─── PR #105 round-2 Fix 3: operator extensions still run after built-in throw ───
  // The try/catch wrapping the built-in call is locally scoped (sharc-container.js
  // ~lines 2480-2488). After a swallowed built-in throw, the operator-extension
  // loop must still iterate. Without this guarantee, a hostile getter on
  // creativeSdkScriptAttrs could DOS the entire extension pipeline. Round-1
  // verified non-propagation; round-2 verifies extension liveness.
  {
    let extensionCalled = false;
    let extensionSawInput = null;
    const taggingExtension = {
      getFeatureName() { return 'com.example.post-builtin-throw'; },
      injectIntoMarkup(html) {
        extensionCalled = true;
        extensionSawInput = html;
        return html + '<!-- ext-marker -->';
      },
    };

    const originalMarkup2 = '<!DOCTYPE html><html><head></head><body>x</body></html>';
    const c2 = track(new SHARCContainer(baseMarkupOpts({
      creativeHtml: originalMarkup2,
      creativeSdkUrl: SDK_URL,
      extensions: [taggingExtension],
    })));
    c2._injectCreativeSdk = function () {
      throw new Error('synthetic built-in failure');
    };

    let result2 = null;
    captureWarn(() => {
      result2 = c2._runMarkupInjection();
    });

    // 9c — extension still invoked after built-in throw is swallowed
    assert(extensionCalled === true,
      '9c. operator extension is invoked AFTER built-in injection throws (try/catch is locally scoped)');
    // The extension sees the ORIGINAL markup (built-in's throw fell through
    // without mutating html — exactly the round-1 § 9 contract).
    assert(extensionSawInput === originalMarkup2,
      '9c (sanity). extension sees the original (un-injected) markup as input');
    // The extension's mutation IS reflected in the final output → loop didn't
    // bail after the swallowed throw.
    assert(result2 !== null && result2.indexOf('<!-- ext-marker -->') !== -1,
      '9c (further). extension mutation is present in the returned markup (proves the loop progressed past the swallowed throw)');
    // creativeInjected flips true because the extension produced a different
    // string from its input — same contract as § 6 etc.
    assert(c2.creativeInjected === true,
      '9c (further). creativeInjected flag flips true when an extension mutates after a built-in throw');
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
