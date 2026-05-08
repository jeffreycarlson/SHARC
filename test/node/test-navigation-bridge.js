/**
 * test-navigation-bridge.js — Phase D deliverable 4 unit coverage
 *
 * jsdom-based smoke tests for `src/sharc-navigation-bridge.js`. Verifies
 * the interceptors route through `window.SHARC.requestNavigation()` for
 * the navigation patterns the proposal specifies (anchor click, form
 * submit, window.open, location.assign, location.replace, meta refresh
 * stripping).
 *
 * Browser-level interception is best-effort — the bridge is layered above
 * the container-side load-event backstop (`RENDERER_UNAUTHORIZED_NAVIGATION`
 * 2118) per spec § Click-through enforcement. These tests lock in the
 * happy paths; adversarial-defeat scenarios are out of scope (the spec
 * acknowledges them as a fundamental limitation; the backstop catches
 * them).
 */

import { JSDOM, VirtualConsole } from 'jsdom';

// Quiet jsdom's default echo of uncaught listener exceptions to stderr.
// The Phase D round-4 throw contract intentionally fires SHARCNavigationError
// from anchor / form / location.* handlers; without a custom VirtualConsole,
// jsdom's default `'jsdomError'` listener prints those throws to stderr,
// polluting the test runner output even though the tests deliberately
// captured them via `window.error`. We swallow `'jsdomError'` and forward
// other levels to the regular console.
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => { /* suppressed — SHARC throw contract */ });
['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
  virtualConsole.on(level, (...args) => { console[level].apply(console, args); });
});

const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body></body></html>',
  { url: 'https://renderer.operator.example/0.7.0/', virtualConsole },
);
global.window = dom.window;
global.document = dom.window.document;

// Stub a SHARC.requestNavigation we can spy on.
const calls = [];
window.SHARC = {
  requestNavigation: (args) => {
    calls.push(args);
    return Promise.resolve();
  },
};

// Auto-install is opt-in via `__sharcNavBridgeAutoInstall = true` (default
// off). Tests don't set the flag, so the module loads cleanly without
// installing — each section installs explicitly and uninstalls when done.
const { installNavigationBridge, SHARCNavigationError }
  = await import('../../dist/sharc-navigation-bridge.mjs');

// ── Build-mode guard ──────────────────────────────────────────────────────
// Mirror of the FATAL guard in test-creative-sources-load.js:80–95. Prod
// builds (`terser drop_console: true`) strip every console.warn/error, so
// the SDK-missing assertions below would either vacuously fail (warn-only
// branch) or silently misreport (the new throw-AND-warn contract). Probe
// dist for `console.warn` AND `console.error` presence — both must exist
// in dev build because the new contract: throw + warn on `<a>` / form /
// `location.*` paths, return null + console.error on `window.open`.
{
  const fs = await import('node:fs');
  const distSrc = fs.readFileSync('./dist/sharc-navigation-bridge.mjs', 'utf8');
  // Match the call form `console.warn(` / `console.error(` rather than the
  // bare property reference. Prod builds (terser `drop_console: true`) leave
  // dead-code property references like `"undefined"!=typeof console&&console
  // .warn,...` after stripping the call expressions; matching `console.warn`
  // alone would let the prod build slip past the guard, and the test would
  // run and produce vacuous assertion failures (TRA HIGH-1, round-5 fix).
  if (!/console\.warn\(/.test(distSrc) || !/console\.error\(/.test(distSrc)) {
    console.error(
      'FATAL: dist/sharc-navigation-bridge.mjs is missing console.warn() or '
      + 'console.error() calls — this is a production build (terser '
      + 'drop_console=true). Phase D nav-bridge log assertions would '
      + 'vacuously pass. Re-run `npm run build` (dev mode) and try again.'
    );
    process.exit(1);
  }
}

let failures = 0;
// Assertion markers (`✓` / `✗`) write directly to `process.stdout` /
// `process.stderr` rather than `console.log` / `console.error`. The
// `withSDKMissing` helper below redirects `console.error` to capture the
// SDK-missing path's diagnostic output; without bypassing the redirect,
// assertion-failure markers inside that helper would land in the captured
// buffer instead of stderr, leaving operators with a "✗ N failed" summary
// and no indication of WHICH assertions failed (TRA HIGH-2, round-5 fix).
function assert(cond, message) {
  if (cond) {
    process.stdout.write('  ✓ ' + message + '\n');
  } else {
    process.stderr.write('  ✗ ' + message + '\n');
    failures++;
  }
}

console.log('test-navigation-bridge.js — Phase D deliverable 4 (#41)\n');

// 1. Install + meta-refresh strip (defense-in-depth)
{
  console.log('1. Install + meta-refresh strip (defense-in-depth)');
  // Inject a meta refresh AFTER the auto-install reset. This isolates the
  // strip-on-install behavior under test from the module's auto-install.
  const meta = document.createElement('meta');
  meta.setAttribute('http-equiv', 'refresh');
  meta.setAttribute('content', '5;url=https://evil.example/redirect');
  document.head.appendChild(meta);
  assert(document.querySelector('meta[http-equiv="refresh"]') != null,
    'pre-install: <meta http-equiv="refresh"> exists in document');

  const uninstall = installNavigationBridge(window);
  assert(typeof uninstall === 'function',
    'installNavigationBridge returns an uninstall function');
  assert(window.__sharcNavBridgeInstalled === true,
    'install sets the __sharcNavBridgeInstalled flag (idempotency guard)');
  // Bridge strips meta refresh on install (defense-in-depth — the renderer
  // page should also strip before document.write per spec).
  assert(document.querySelector('meta[http-equiv="refresh"]') == null,
    'install strips <meta http-equiv="refresh"> from the document');

  // Idempotency: second install is a no-op.
  const secondUninstall = installNavigationBridge(window);
  assert(typeof secondUninstall === 'function',
    'second install returns a no-op uninstall (idempotent)');

  uninstall();
  assert(window.__sharcNavBridgeInstalled === undefined,
    'uninstall clears the __sharcNavBridgeInstalled flag');

  // 1b — Entity-encoded http-equiv variant. A naive regex on the literal
  // token `refresh` would let `&#114;efresh` slip through, but the browser's
  // HTML parser decodes the entity before exposing the attribute. The
  // bridge's `getAttribute('http-equiv').toLowerCase() === 'refresh'`
  // comparison sees the decoded value, so this is caught by the same code
  // path as the literal variant. Locks in the spec-pass-1 Security M-1
  // contract (entity-encoding bypass not viable at the bridge surface).
  document.head.innerHTML = '<meta http-equiv="&#114;efresh" content="0;url=https://attacker.example">';
  // Sanity: the parser decoded the entity so the attribute reads as `refresh`.
  const decoded = document.querySelector('meta[http-equiv="refresh"]');
  assert(decoded != null,
    'pre-install: HTML parser decodes &#114;efresh entity → http-equiv="refresh"');

  const uninstall1b = installNavigationBridge(window);
  assert(document.querySelector('meta[http-equiv="refresh"]') == null,
    'install strips entity-encoded <meta http-equiv="&#114;efresh"> (DOMParser-equivalent path)');
  uninstall1b();
}

// 2. Anchor click delegate
{
  console.log('\n2. Anchor click delegate');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<a id="cta" href="https://advertiser.example/landing">Click</a>';
  const a = document.getElementById('cta');
  // Simulate a click. jsdom's MouseEvent dispatch invokes the capture-phase
  // listener the bridge registered.
  a.click();
  assert(calls.length === 1
    && calls[0].url === 'https://advertiser.example/landing'
    && calls[0].target === 'clickthrough',
    'anchor click → SHARC.requestNavigation({ url, target: "clickthrough" })');
  // Defensive rel="noopener noreferrer" applied.
  const rel = a.getAttribute('rel') || '';
  assert(rel.indexOf('noopener') !== -1 && rel.indexOf('noreferrer') !== -1,
    'anchor click → rel="noopener noreferrer" applied defensively');
  uninstall();
}

// 3. Anchor click delegate — ignores hash links
{
  console.log('\n3. Anchor click delegate — ignores hash links');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<a id="hash" href="#section">jump</a>';
  document.getElementById('hash').click();
  assert(calls.length === 0,
    'hash-only anchor click → NOT routed (in-document jump, not navigation)');
  uninstall();
}

// 4. Anchor click — nested elements walk up to <a>
{
  console.log('\n4. Anchor click — nested elements walk up');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML
    = '<a id="cta" href="https://advertiser.example/cta">'
    + '<span><img id="creative-img"></span>'
    + '</a>';
  // Click the inner img. The capture-phase listener walks up to find <a>.
  const img = document.getElementById('creative-img');
  img.click();
  assert(calls.length === 1
    && calls[0].url === 'https://advertiser.example/cta',
    'nested click target → walks up to nearest <a> ancestor and routes');
  uninstall();
}

// 4b. Anchor click — javascript: URL is left to native behavior
{
  console.log('\n4b. Anchor click — javascript: URL ignored');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<a id="js" href="javascript:void(0)">noop</a>';
  document.getElementById('js').click();
  assert(calls.length === 0,
    'javascript: anchor click → NOT routed (in-page script invocation, not a navigation)');
  // Whitespace + mixed-case variant — same regex must catch it.
  document.body.innerHTML = '<a id="js2" href="  JavaScript:alert(1)">noop</a>';
  document.getElementById('js2').click();
  assert(calls.length === 0,
    'leading-whitespace / mixed-case javascript: anchor → NOT routed (regex case-insensitive)');
  uninstall();
}

// 4c. Anchor click — anchor inside shadow DOM
//     Web Components with a hidden <a> inside an open shadow root would
//     bypass a parentNode-only walk-up (event.target retargets to the host).
//     The bridge uses event.composedPath() to cross shadow boundaries and
//     find the anchor.
//
//     jsdom version dependency: jsdom 22+ implements `event.composedPath()`
//     and the retargeting model spec-compliantly enough for this test. The
//     repo pins a known-good jsdom in package.json. If a future bump
//     regresses composedPath, the assertion fails loud rather than silently
//     passing — the prior `routed || true` swallow was vacuous (Phase D
//     round-4 Reality Checker + TRA M3 fix). Browser harness + Puppeteer
//     CI (issue #69) remain the load-bearing real-browser coverage; this
//     jsdom assertion is the unit-tier regression catch.
{
  console.log('\n4c. Anchor click — anchor inside shadow DOM (composedPath walk-up)');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  const shadowAnchor = document.createElement('a');
  shadowAnchor.setAttribute('href', 'https://advertiser.example/shadow-cta');
  shadowAnchor.textContent = 'click';
  shadow.appendChild(shadowAnchor);
  // Click the inner shadow-DOM anchor. The composed path includes the
  // shadow anchor; the parentNode-walk fallback would not (target retargets
  // to the host element when crossing shadow boundaries).
  const evt = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  shadowAnchor.dispatchEvent(evt);
  assert(calls.length === 1
    && calls[0].url === 'https://advertiser.example/shadow-cta',
    'shadow-DOM anchor click → composedPath finds anchor and routes');
  uninstall();
}

// 5. Form submit delegate
{
  console.log('\n5. Form submit delegate');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<form id="form" action="https://advertiser.example/submit"></form>';
  const form = document.getElementById('form');
  // jsdom's form.submit() navigates instead of dispatching submit; use a
  // synthetic submit Event so the bridge's capture-phase listener fires.
  const evt = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(evt);
  assert(calls.length === 1
    && calls[0].url === 'https://advertiser.example/submit',
    'form submit → SHARC.requestNavigation({ url: form.action, target: "clickthrough" })');
  uninstall();
}

// 5b. Form submit — no explicit action attribute → native (no route).
//     `form.action` IDL falls back to current page URL when the attribute
//     is omitted; routing that as outbound is a false positive.
{
  console.log('\n5b. Form submit — missing action attribute (no route)');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<form id="form-noaction"></form>';
  const form = document.getElementById('form-noaction');
  const evt = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(evt);
  assert(calls.length === 0,
    'form WITHOUT action attribute → NOT routed (same-page submit, not outbound)');
  uninstall();
}

// 5c. Form submit — empty action="" attribute → native (no route).
//     Treated identically to a missing attribute.
{
  console.log('\n5c. Form submit — empty action="" attribute (no route)');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<form id="form-emptyaction" action=""></form>';
  const form = document.getElementById('form-emptyaction');
  const evt = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(evt);
  assert(calls.length === 0,
    'form WITH empty action="" → NOT routed (same as missing attribute)');
  uninstall();
}

// 5d. Form submit — button[formaction] overrides empty form action.
//     Per HTML5, a submitter's `formaction` overrides the form's `action`
//     attribute. The bridge must route the BUTTON URL through the audit
//     path, not the (empty) form URL. Without this, an attacker creative
//     could bypass the bridge entirely with `<form><button formaction="...">`.
{
  console.log('\n5d. Form submit — button[formaction] overrides empty form action');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML
    = '<form id="form-fa-empty">'
    + '<button id="btn-fa" type="submit" formaction="https://advertiser.example/from-button">go</button>'
    + '</form>';
  const form = document.getElementById('form-fa-empty');
  const button = document.getElementById('btn-fa');
  const evt = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  // Synthesize the `submitter` field on the event — jsdom's Event constructor
  // doesn't populate it from a SubmitEvent dict on synthetic dispatches, so
  // we set it directly. Real browsers populate `submitter` on user-initiated
  // form submissions.
  Object.defineProperty(evt, 'submitter', { value: button, configurable: true });
  form.dispatchEvent(evt);
  assert(calls.length === 1
    && calls[0].url === 'https://advertiser.example/from-button',
    'button[formaction] with empty form action → routes BUTTON URL through requestNavigation');
  uninstall();
}

// 5e. Form submit — button[formaction] overrides set form action.
//     Per HTML5, the submitter's `formaction` wins over the form's own
//     `action`. Bridge must route the button URL, NOT the form URL.
{
  console.log('\n5e. Form submit — button[formaction] overrides set form action');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML
    = '<form id="form-fa-set" action="https://advertiser.example/from-form">'
    + '<button id="btn-fa-set" type="submit" formaction="https://advertiser.example/from-button-2">go</button>'
    + '</form>';
  const form = document.getElementById('form-fa-set');
  const button = document.getElementById('btn-fa-set');
  const evt = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'submitter', { value: button, configurable: true });
  form.dispatchEvent(evt);
  assert(calls.length === 1
    && calls[0].url === 'https://advertiser.example/from-button-2',
    'button[formaction] with set form action → routes BUTTON URL (not form URL)');
  uninstall();
}

// 6. window.open
{
  console.log('\n6. window.open');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  const result = window.open('https://advertiser.example/popup', '_blank');
  assert(calls.length === 1
    && calls[0].url === 'https://advertiser.example/popup',
    'window.open → SHARC.requestNavigation({ url, target: "clickthrough" })');
  assert(result === null,
    'window.open returns null (bridge consumed the call; creative falls back to SDK)');
  uninstall();
}

// 7+8. location.assign / replace — jsdom-incompatible.
//
// jsdom's Location properties are non-configurable, so the bridge's
// `win.location.assign = ...` wrapper assignment silently fails (the
// try/catch in the bridge swallows the descriptor refusal). Real browsers
// DO permit the descriptor swap. Browser-harness coverage of `location.*`
// interception is DEFERRED to issue #69 (Puppeteer CI integration). In the
// interim, `location.*` interception is verified only by manual testing in
// the Phase D `test/browser/test-creative-sources.html` harness — the
// harness loads the renderer (which auto-installs the bridge as of Phase D
// round-4) but does not yet exercise `location.assign/replace` in an
// asserted way. Here we just verify the bridge does NOT throw on the
// assignment attempt.
{
  console.log('\n7+8. location.assign / replace — jsdom-incompatible (no-throw only)');
  const uninstall = installNavigationBridge(window);
  let threw = false;
  try {
    void window.location.assign;
    void window.location.replace;
  } catch (_) { threw = true; }
  assert(!threw,
    'location.assign / replace lookup does NOT throw post-install (jsdom-safe)');
  uninstall();
}

// 9. SDK-not-loaded contract (Phase D round-4 — fail-loud-to-creative).
//
// Behavior changed from warn-only to throw + warn for `<a>` / form / `location.*`
// paths. `window.open` keeps the IAB popup-blocker pattern (return null +
// console.error, NOT throw) — defensive creatives use `var w = window.open();
// if (w) { ... }` to detect popup blockers, and a synchronous throw would
// break that idiom. Per OpenClaw MEDIUM-3.
{
  console.log('\n9. SDK-not-loaded contract — fail-loud-to-creative via throw');

  // Helper: temporarily delete window.SHARC, capture console.warn /.error,
  // run the body with a fresh bridge install, then restore everything.
  // Also captures window 'error' events — jsdom (and real browsers per the
  // WHATWG DOM "report the exception" algorithm) dispatch the `error` event
  // SYNCHRONOUSLY during the original `dispatchEvent`. The exception itself
  // does not propagate out of `a.click()` / `form.dispatchEvent(submit)`,
  // but the `'error'` event fires synchronously inside that call frame.
  // Capturing via `window.addEventListener('error', ...)` is therefore
  // deterministic — by the time `a.click()` returns, the listener has already
  // pushed the error into `errorEvents` (TRA MEDIUM-3 round-5 fix —
  // prior comment incorrectly claimed asynchronous reporting).
  function withSDKMissing(body) {
    const savedSDK = window.SHARC;
    delete window.SHARC;
    const originalWarn = console.warn;
    const originalError = console.error;
    const warnOutput = [];
    const errorOutput = [];
    const errorEvents = [];
    console.warn = (...args) => { warnOutput.push(args.join(' ')); };
    console.error = (...args) => { errorOutput.push(args.join(' ')); };
    const onWinError = (e) => {
      errorEvents.push(e.error || e.message);
      // Prevent jsdom from re-logging the error via virtualConsole.
      e.preventDefault && e.preventDefault();
    };
    window.addEventListener('error', onWinError);
    const uninstall = installNavigationBridge(window);
    try {
      body({ warnOutput, errorOutput, errorEvents });
    } finally {
      window.removeEventListener('error', onWinError);
      console.warn = originalWarn;
      console.error = originalError;
      window.SHARC = savedSDK;
      uninstall();
    }
  }

  // 9b — Anchor click with SDK absent throws SHARCNavigationError. jsdom
  //      routes listener-throws to window.error rather than synchronously
  //      rethrowing out of `a.click()`; the test inspects errorEvents.
  //      Real browsers route to window.onerror identically — operator
  //      monitoring (`window.addEventListener('error')`) is the documented
  //      capture surface either way.
  {
    console.log('  9b. anchor click → throws SHARCNavigationError');
    withSDKMissing(({ warnOutput, errorEvents }) => {
      calls.length = 0;
      document.body.innerHTML = '<a id="cta" href="https://advertiser.example/no-sdk">Click</a>';
      const a = document.getElementById('cta');
      a.click();
      const navErr = errorEvents.find((e) => e instanceof SHARCNavigationError);
      assert(navErr instanceof SHARCNavigationError,
        'SDK-missing anchor click → throws SHARCNavigationError (captured via window error event)');
      assert(navErr && navErr.code === 'SDK_UNAVAILABLE',
        'SHARCNavigationError.code === "SDK_UNAVAILABLE"');
      assert(navErr && navErr.name === 'SHARCNavigationError',
        'SHARCNavigationError.name === "SHARCNavigationError"');
      assert(warnOutput.some((s) => /window\.SHARC\.requestNavigation/.test(s)),
        'SDK-missing path emits console.warn naming the missing API (alongside the throw)');
    });
  }

  // 9c — Form submit with SDK absent throws SHARCNavigationError (same
  //      window.error capture pattern as 9b).
  {
    console.log('  9c. form submit → throws SHARCNavigationError');
    withSDKMissing(({ errorEvents }) => {
      document.body.innerHTML = '<form id="form" action="https://advertiser.example/submit"></form>';
      const form = document.getElementById('form');
      const evt = new dom.window.Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(evt);
      const navErr = errorEvents.find((e) => e instanceof SHARCNavigationError);
      assert(navErr instanceof SHARCNavigationError,
        'SDK-missing form submit → throws SHARCNavigationError (captured via window error event)');
      assert(navErr && navErr.code === 'SDK_UNAVAILABLE',
        'SDK-missing form submit → SHARCNavigationError.code === "SDK_UNAVAILABLE"');
    });
  }

  // 9d / 9e / 9f — location.assign / location.replace / location.href setter
  //      throw contract. jsdom's Location is non-configurable, so the bridge's
  //      wrapper-assign is silently swallowed by its own try/catch and the
  //      bridge throw cannot be verified at the unit tier. Source-level
  //      enforcement is implemented in `src/sharc-navigation-bridge.js`;
  //      browser-harness coverage (which can verify the actual descriptor
  //      swap + throw end-to-end) is tracked in issue #69 (Puppeteer CI).
  //
  //      Round-5 fix (TRA MEDIUM-2): prior `assert(true, ...)` calls
  //      inflated the test count by 3 and produced vacuous "passes" that
  //      would have masked real regressions. Replaced with explicit
  //      skip-marker logs that the summary tracks separately. Asserted
  //      coverage drops from 37 → 34, with 3 documentation-only deferrals.
  let deferredCount = 0;
  console.log('  9d. location.assign — DEFERRED to issue #69 (jsdom Location non-configurable; source-level throw verified in src/sharc-navigation-bridge.js)');
  deferredCount++;
  console.log('  9e. location.replace — DEFERRED to issue #69 (jsdom Location non-configurable; source-level throw verified in src/sharc-navigation-bridge.js)');
  deferredCount++;
  console.log('  9f. location.href setter — DEFERRED to issue #69 (jsdom Location.prototype non-configurable; source-level throw verified in src/sharc-navigation-bridge.js)');
  deferredCount++;
  // Stash the deferred count for the summary line.
  global.__navBridgeDeferred = (global.__navBridgeDeferred || 0) + deferredCount;

  // 9g — window.open KEEPS the IAB popup-blocker pattern: returns null +
  //      console.error, does NOT throw. Locked in by tests to defend
  //      against accidental future "consistency" changes that would break
  //      defensive creatives' `var w = window.open(); if (w) { ... }` idiom.
  {
    console.log('  9g. window.open → returns null + console.error (NOT throw — IAB pattern)');
    withSDKMissing(({ errorOutput }) => {
      let result;
      let threw = false;
      try {
        result = window.open('https://advertiser.example/popup', '_blank');
      } catch (_) { threw = true; }
      assert(!threw,
        'SDK-missing window.open → does NOT throw (IAB popup-blocker pattern preserved)');
      assert(result === null,
        'SDK-missing window.open → returns null (popup-blocker idiom)');
      assert(errorOutput.some((s) => /window\.open could not be audited/.test(s)),
        'SDK-missing window.open → emits console.error naming the audit failure');
    });
  }

}

// 10. Propagation contract — creative-side handlers run after bridge intercept.
//     Originally filed as `9h` inside the SDK-missing section, but this test
//     does NOT use `withSDKMissing` — it runs with the default `window.SHARC`
//     stub still installed. Lifted to its own section in round-5 (TRA LOW-1)
//     so the section 9 grouping reflects what's actually being tested.
//
//     Proves the bridge no longer calls `event.stopPropagation()` — Phase D
//     round-4 OpenClaw MEDIUM-2 fix. Creative-installed click handlers
//     (analytics, validation, custom UI) must continue to fire after the
//     bridge intercepts.
{
  console.log('\n10. Propagation contract — creative-side click handler runs after bridge intercept (no stopPropagation)');
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<a id="cta" href="https://advertiser.example/propagation">click</a>';
  const a = document.getElementById('cta');
  let creativeHandlerFired = false;
  a.addEventListener('click', () => { creativeHandlerFired = true; });
  a.click();
  assert(calls.length === 1,
    'bridge still routes the click through requestNavigation');
  assert(creativeHandlerFired,
    'creative-side click handler ALSO fires (bridge does not stopPropagation — analytics / validation handlers still run)');
  uninstall();
}

// ── Summary
console.log('');
const deferred = global.__navBridgeDeferred || 0;
const deferredSuffix = deferred > 0
  ? ` (${deferred} additional case${deferred === 1 ? '' : 's'} deferred to issue #69)`
  : '';
if (failures > 0) {
  process.stderr.write(`✗ ${failures} navigation-bridge assertion(s) failed${deferredSuffix}.\n`);
  process.exit(1);
} else {
  console.log(`✓ All navigation-bridge assertions passed${deferredSuffix}.`);
}
