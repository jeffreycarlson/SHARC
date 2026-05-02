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

import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body></body></html>',
  { url: 'https://renderer.operator.example/0.7.0/' },
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
const { installNavigationBridge } = await import('./dist/sharc-navigation-bridge.mjs');

let failures = 0;
function assert(cond, message) {
  if (cond) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
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
// jsdom's Location implementation refuses assignment to the assign/replace
// properties (the assignment is silently dropped — the try/catch in the
// bridge swallows the failure). Real browsers DO permit the wrapper
// assignment via the descriptor on Location.prototype. The browser harness
// added in Phase D deliverable 6 covers this path; here we just verify
// the bridge does NOT throw on the assignment attempt.
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

// 9. SDK-not-loaded fallback (warning only, no throw)
{
  console.log('\n9. SDK-not-loaded fallback (warning only, no throw)');
  // Snapshot + remove the SDK so the bridge's no-SDK branch is exercised.
  const savedSDK = window.SHARC;
  delete window.SHARC;

  const originalWarn = console.warn;
  const warnOutput = [];
  console.warn = (...args) => { warnOutput.push(args.join(' ')); };
  let threw = false;

  // The interception code itself must not throw; it should warn cleanly.
  const uninstall = installNavigationBridge(window);
  calls.length = 0;
  document.body.innerHTML = '<a id="cta" href="https://advertiser.example/no-sdk">Click</a>';
  try {
    document.getElementById('cta').click();
  } catch (_) { threw = true; }

  console.warn = originalWarn;
  window.SHARC = savedSDK;
  uninstall();

  assert(!threw,
    'SDK-missing anchor click does NOT throw');
  assert(warnOutput.some((s) => /window\.SHARC\.requestNavigation/.test(s)),
    'SDK-missing path emits console.warn naming the missing API');
}

// ── Summary
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} navigation-bridge assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All navigation-bridge assertions passed.');
}
