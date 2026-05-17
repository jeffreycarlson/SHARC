/**
 * test-sharc-creative-injector.js — issue #97 (0.7.2 first-half PR 4)
 *
 * Unit coverage for the `SHARCCreativeInjector` reference extension.
 * Verifies the locked design from issue #97 + the 2026-05-17 doctype-edge
 * refinement: injection inserts the SDK `<script>` tag at the most
 * specific position present in the markup (head → html → doctype →
 * prepend), never BEFORE the doctype declaration (which would push the
 * browser into quirks-mode rendering).
 *
 * Coverage matrix (issue #97 § Test matrix + doctype refinement):
 *
 *   Constructor validation
 *     - creativeSdkUrl: undefined / null / '' / non-string → TypeError
 *     - creativeSdkUrl: 'https://...'                       → accepted
 *
 *   Injection-position contract
 *     - <head> present (mixed case, with attrs) → after head open tag
 *     - <html> only (no head)                   → after html open tag
 *     - <!DOCTYPE> only (no html, no head)      → after doctype (NOT before!)
 *     - true fragment                            → prepend
 *
 *   Idempotency (skipIfPresent: true default)
 *     - markup already contains `sharc-creative.js` → returned unchanged
 *     - markup contains a DIFFERENT filename        → still injects
 *     - skipIfPresent: false                        → always injects
 *
 *   Script-attr serialization
 *     - `{ async: true }`               → ` async` (bare attr)
 *     - `{ async: true, defer: true }`  → ` async defer`
 *     - `{ async: false }`              → omitted
 *     - `{ integrity: 'sha384-...' }`   → ` integrity="sha384-..."`
 *     - `{ nonce: 'a"b' }`              → HTML-escaped quote
 *
 *   Container integration
 *     - new SHARCContainer({ ..., extensions: [injector] }) →
 *       container._runMarkupInjection() returns injected markup; the
 *       `creativeInjected` flag flips true.
 *
 * Runs in Node after `npm run build` (the integration test imports the
 * built container bundle; constructor + injection tests are pure
 * string-in / string-out and don't need jsdom).
 */

import { JSDOM } from 'jsdom';

// ── Minimal DOM stub for the integration test ────────────────────────────
// SHARCContainer construction touches `document` / `HTMLIFrameElement` /
// `HTMLElement` / `MessageChannel`. Mirror the html-lifecycle-adapter
// test's setup. The injector itself doesn't need a DOM — only the
// container-integration section does.
const PUBLISHER_ORIGIN = 'https://publisher.example';
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

// IntersectionObserver stub — the container's HTML lifecycle adapter
// constructs one in attach(); the integration test never observes
// transitions but the container won't construct without the stub.
global.IntersectionObserver = class IntersectionObserverStub {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.IntersectionObserver = global.IntersectionObserver;

// Pre-load protocol exports onto window.SHARC.Protocol so the container's
// internal SHARC_VERSION lookup at construction works (matches the
// html-lifecycle-adapter test).
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCCreativeInjector } = await import('../../dist/sharc-creative-injector.mjs');
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

console.log('test-sharc-creative-injector.js — issue #97 (PR 4) coverage\n');

const SDK_URL = 'https://op.example/sharc-creative.js';

// =========================================================================
// 1. Constructor validation
// =========================================================================
{
  console.log('1. Constructor validation');

  function expectThrow(label, options) {
    let threw = null;
    try { new SHARCCreativeInjector(options); } catch (e) { threw = e; }
    assert(threw instanceof TypeError,
      `${label} → TypeError thrown`);
    assert(threw && /creativeSdkUrl/.test(String(threw.message)),
      `${label} → error message names creativeSdkUrl`);
  }

  expectThrow('creativeSdkUrl: undefined (omitted)', {});
  expectThrow('creativeSdkUrl: null', { creativeSdkUrl: null });
  expectThrow('creativeSdkUrl: empty string', { creativeSdkUrl: '' });
  expectThrow('creativeSdkUrl: number (non-string)', { creativeSdkUrl: 123 });
  expectThrow('creativeSdkUrl: object', { creativeSdkUrl: { url: 'x' } });
  expectThrow('options: undefined entirely', undefined);

  // Accepted shape.
  let injector = null;
  try {
    injector = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });
  } catch (e) {
    assert(false, 'accepted creativeSdkUrl construction threw: ' + (e && e.message));
  }
  assert(injector !== null, 'valid creativeSdkUrl → instance constructed');
  assert(injector.creativeSdkUrl === SDK_URL,
    'instance.creativeSdkUrl mirrors the constructor arg');
  assert(injector.skipIfPresent === true,
    'instance.skipIfPresent defaults to true');
  assert(injector.scriptAttrs && typeof injector.scriptAttrs === 'object',
    'instance.scriptAttrs defaults to an object');
  assert(typeof injector.injectIntoMarkup === 'function',
    'instance exposes injectIntoMarkup(html)');
  assert(typeof injector.getFeatureName === 'function',
    'instance exposes getFeatureName()');
  assert(injector.getFeatureName() === 'com.iabtechlab.sharc.creative-injector',
    'getFeatureName() returns the canonical feature string');
  assert(typeof injector.destroy === 'function',
    'instance exposes destroy() (lifecycle parity with other extensions)');
}

// =========================================================================
// 2. Injection-position contract
// =========================================================================
{
  console.log('\n2. Injection-position contract');

  const injector = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });
  const expectedTag = '<script src="' + SDK_URL + '"></script>';

  // 2a — markup with <head> → injected after head open tag
  {
    const html = '<!DOCTYPE html><html><head><title>Ad</title></head><body>x</body></html>';
    const out = injector.injectIntoMarkup(html);
    const expected = '<!DOCTYPE html><html><head>' + expectedTag + '<title>Ad</title></head><body>x</body></html>';
    assert(out === expected,
      '2a. <head> present → script injected immediately after <head> open tag');
  }

  // 2b — case-insensitive <HEAD>
  {
    const html = '<!DOCTYPE html><HTML><HEAD></HEAD><BODY>x</BODY></HTML>';
    const out = injector.injectIntoMarkup(html);
    assert(out.indexOf('<HEAD>' + expectedTag) !== -1,
      '2b. <HEAD> (uppercase) → matched case-insensitively, script injected after open tag');
  }

  // 2c — <head lang="en"> attrs on the tag
  {
    const html = '<html><head lang="en" class="x"></head><body></body></html>';
    const out = injector.injectIntoMarkup(html);
    assert(out.indexOf('<head lang="en" class="x">' + expectedTag) !== -1,
      '2c. <head> with attributes → script injected after full open tag (attrs preserved)');
  }

  // 2d — <html> only, no <head>
  {
    const html = '<!DOCTYPE html><html><body>x</body></html>';
    const out = injector.injectIntoMarkup(html);
    assert(out === '<!DOCTYPE html><html>' + expectedTag + '<body>x</body></html>',
      '2d. <html> present (no <head>) → script injected after <html> open tag');
  }

  // 2e — <!DOCTYPE> only (no html, no head). The CRITICAL doctype-edge case:
  //      a naive injector would prepend (placing the tag BEFORE the doctype)
  //      and trigger quirks-mode rendering. The injector MUST insert AFTER
  //      the doctype declaration.
  {
    const html = '<!DOCTYPE html><body>fragment</body>';
    const out = injector.injectIntoMarkup(html);
    assert(out === '<!DOCTYPE html>' + expectedTag + '<body>fragment</body>',
      '2e. <!DOCTYPE> only → script injected AFTER doctype (regression guard against quirks-mode)');
    assert(out.indexOf(expectedTag) > out.indexOf('<!DOCTYPE'),
      '2e (sanity). script tag position is AFTER the doctype declaration, not before');
  }

  // 2f — lowercase <!doctype html>. Quirks-mode handling must also catch
  //      the lowercase variant.
  {
    const html = '<!doctype html><body>x</body>';
    const out = injector.injectIntoMarkup(html);
    assert(out === '<!doctype html>' + expectedTag + '<body>x</body>',
      '2f. lowercase <!doctype html> → handled, script injected AFTER declaration');
  }

  // 2g — fragment markup (no doctype, no html, no head) → prepend
  {
    const html = '<div class="ad"><img src="img.png"></div>';
    const out = injector.injectIntoMarkup(html);
    assert(out === expectedTag + html,
      '2g. fragment markup → script prepended (no anchor element present)');
  }

  // 2h — non-string input passes through (defensive contract)
  {
    const out = injector.injectIntoMarkup(null);
    assert(out === null,
      '2h. non-string input → returned unchanged (defensive — contract is string-in/string-out)');
  }
}

// =========================================================================
// 3. Idempotency (skipIfPresent)
// =========================================================================
{
  console.log('\n3. Idempotency — skipIfPresent contract');

  // 3a — default true: markup already containing `sharc-creative.js` is unchanged
  {
    const injector = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });
    const html = '<html><head><script src="https://prior-cdn/sharc-creative.js"></script></head><body>x</body></html>';
    const out = injector.injectIntoMarkup(html);
    assert(out === html,
      '3a. skipIfPresent default true + sharc-creative.js already present → returned unchanged');
  }

  // 3b — default true: markup with a DIFFERENT filename still gets injected
  //      (presence check is filename-substring, not generic "any script")
  {
    const injector = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });
    const html = '<html><head><script src="https://cdn/some-other-thing.js"></script></head><body></body></html>';
    const out = injector.injectIntoMarkup(html);
    assert(out !== html,
      '3b. skipIfPresent default true + DIFFERENT filename present → still injects (substring is filename-specific)');
    assert(out.indexOf(SDK_URL) !== -1,
      '3b (sanity). injected script src matches the configured creativeSdkUrl');
  }

  // 3c — back-to-back injection through the same instance is idempotent
  {
    const injector = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });
    const html = '<html><head></head><body></body></html>';
    const once = injector.injectIntoMarkup(html);
    const twice = injector.injectIntoMarkup(once);
    assert(once === twice,
      '3c. back-to-back injection through the same instance is a no-op on the second pass');
    // Count <script> occurrences to confirm there's exactly one.
    const matches = (once.match(/sharc-creative\.js/g) || []).length;
    assert(matches === 1,
      '3c. exactly one sharc-creative.js script tag present after two injection passes');
  }

  // 3d — skipIfPresent: false → always injects
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      skipIfPresent: false,
    });
    const html = '<html><head><script src="sharc-creative.js"></script></head><body></body></html>';
    const out = injector.injectIntoMarkup(html);
    assert(out !== html,
      '3d. skipIfPresent: false → injects even when sharc-creative.js already present');
    // Two occurrences total now.
    const matches = (out.match(/sharc-creative\.js/g) || []).length;
    assert(matches === 2,
      '3d. skipIfPresent: false → two sharc-creative.js script tags present after force-inject');
  }
}

// =========================================================================
// 4. Script-attr serialization
// =========================================================================
{
  console.log('\n4. scriptAttrs serialization');

  // 4a — { async: true } → bare attr
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      scriptAttrs: { async: true },
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('<script src="' + SDK_URL + '" async></script>') !== -1,
      '4a. { async: true } → emitted as bare attribute (no `="true"`)');
  }

  // 4b — { async: true, defer: true } → both bare
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      scriptAttrs: { async: true, defer: true },
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('<script src="' + SDK_URL + '" async defer></script>') !== -1,
      '4b. { async: true, defer: true } → both rendered as bare attributes');
  }

  // 4c — { async: false } → omitted
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      scriptAttrs: { async: false },
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '4c. { async: false } → attribute omitted entirely');
    assert(out.indexOf('async') === -1,
      '4c (sanity). no `async` substring anywhere in the injected tag');
  }

  // 4d — null / undefined attr values → omitted
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      scriptAttrs: { defer: null, nomodule: undefined, async: true },
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('<script src="' + SDK_URL + '" async></script>') !== -1,
      '4d. null / undefined attr values → omitted; only truthy attrs render');
  }

  // 4e — string attr value
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      scriptAttrs: { integrity: 'sha384-XYZ' },
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('<script src="' + SDK_URL + '" integrity="sha384-XYZ"></script>') !== -1,
      '4e. { integrity: "sha384-XYZ" } → rendered as quoted attribute');
  }

  // 4f — string attr containing double-quote → HTML-escaped
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      scriptAttrs: { nonce: 'a"b' },
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('nonce="a&quot;b"') !== -1,
      '4f. attribute value containing `"` → escaped to `&quot;` (defense against attribute-injection)');
    assert(out.indexOf('nonce="a"b"') === -1,
      '4f (sanity). raw unescaped value is NOT present in output');
  }

  // 4g — string attr containing `&` → HTML-escaped
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: SDK_URL,
      scriptAttrs: { 'data-rtb': 'a&b' },
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('data-rtb="a&amp;b"') !== -1,
      '4g. attribute value containing `&` → escaped to `&amp;` (entity-correctness)');
  }

  // 4h — creativeSdkUrl containing `&` (RTB-macro-like) → escaped in src
  {
    const injector = new SHARCCreativeInjector({
      creativeSdkUrl: 'https://op.example/sdk.js?v=1&hash=abc',
    });
    const out = injector.injectIntoMarkup('<html><head></head></html>');
    assert(out.indexOf('src="https://op.example/sdk.js?v=1&amp;hash=abc"') !== -1,
      '4h. creativeSdkUrl with `&` → src value HTML-escaped (entity-correctness)');
  }
}

// =========================================================================
// 5. Container integration — extension hook fires from SHARCContainer
// =========================================================================
{
  console.log('\n5. SHARCContainer integration');

  // Build a placement element so the container construction doesn't bail.
  document.body.innerHTML = '';
  const slot = document.createElement('div');
  slot.id = 'ad-slot';
  document.body.appendChild(slot);

  const creativeHtml = '<!DOCTYPE html><html><head></head><body><h1>Ad</h1></body></html>';
  const injector = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });

  let container = null;
  try {
    container = new SHARCContainer({
      creativeHtml,
      creativeRendererUrl: 'https://renderer.example/0.7.1/index.html',
      placementElement: slot,
      requireSharcInit: false,
      extensions: [injector],
      timeouts: { createSession: 5000 },
    });
  } catch (e) {
    assert(false, '5. SHARCContainer construction with extensions: [injector] threw: ' + (e && e.message));
  }

  if (container) {
    // 5a — container collected the extension
    assert(Array.isArray(container._extensions) && container._extensions.length === 1
      && container._extensions[0] === injector,
      '5a. container._extensions registers the injector instance');

    // 5b — running the injection pipe directly returns the modified markup
    const injected = container._runMarkupInjection();
    assert(injected.indexOf('<script src="' + SDK_URL + '"></script>') !== -1,
      '5b. container._runMarkupInjection() returns markup containing the SDK script tag');
    assert(container.creativeInjected === true,
      '5c. container.creativeInjected flag flipped true after injection');

    // 5d — getFeatureName() collected into supportedFeatures contributions.
    //      Direct check against the injector's reported name (the merge into
    //      Container:init happens at handshake time; here we verify the
    //      surface the merge will see).
    assert(typeof injector.getFeatureName() === 'string'
      && injector.getFeatureName() === 'com.iabtechlab.sharc.creative-injector',
      '5d. injector.getFeatureName() advertises com.iabtechlab.sharc.creative-injector');

    // 5e — destroy() is callable without throwing (lifecycle parity).
    let destroyThrew = false;
    try { injector.destroy(); } catch (_) { destroyThrew = true; }
    assert(!destroyThrew,
      '5e. injector.destroy() is callable without throwing');

    // Cleanup so the process can exit cleanly.
    try { container._terminate(); } catch (_) { /* ignore */ }
  }
}

// =========================================================================
// 6. Multi-extension sequencing — injector is idempotent across passes
// =========================================================================
{
  console.log('\n6. Multi-extension sequencing — back-to-back injectors do not double-inject');

  const inj1 = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });
  const inj2 = new SHARCCreativeInjector({ creativeSdkUrl: SDK_URL });
  const html = '<html><head></head><body></body></html>';

  const afterFirst = inj1.injectIntoMarkup(html);
  const afterSecond = inj2.injectIntoMarkup(afterFirst);

  assert(afterFirst === afterSecond,
    '6. second injector pass over already-injected markup is a no-op (skipIfPresent dedup)');
  const matches = (afterSecond.match(/sharc-creative\.js/g) || []).length;
  assert(matches === 1,
    '6 (sanity). exactly one sharc-creative.js tag present after two injector passes');
}

// =========================================================================
// Summary
// =========================================================================
console.log('');
if (failures > 0) {
  process.stderr.write(`✗ ${failures} sharc-creative-injector assertion(s) failed.\n`);
  process.exit(1);
} else {
  console.log('✓ All sharc-creative-injector assertions passed.');
}
