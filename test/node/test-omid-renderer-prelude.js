/**
 * test-omid-renderer-prelude.js — 0.7.8 renderer OMID error/validation paths.
 *
 * Exercises the ACTUAL shipped renderer inline script in
 * `examples/renderer/index.html` (extracted and eval'd in jsdom — the same
 * harness pattern as `test-renderer-domparser-fallback.js`), NOT a source-grep
 * and NOT an inlined copy of the prelude. We drive a real `:render` envelope and
 * observe the `:failed` reply the renderer posts to its parent.
 *
 * Covered (design § 4.3 mechanism i, the OMID failure modes):
 *   - non-ok `fetch` of the shim source  → `:failed` reason `omid_shim_inject_failed`
 *   - cross-origin `OMID_SHIM_URL`        → `:failed` reason `omid_shim_inject_failed`
 *     (the prelude throws `omid_shim_url_cross_origin`; the renderer maps every
 *      prelude throw to the fatal `omid_shim_inject_failed` :failed reason and
 *      logs the specific cause via customSecurityLog — asserted on the log.)
 *   - `omid: true` with NO `omidProtocolNonce`      → `:failed` reason `invalid_omid_field`
 *   - `omid: true` with wrong-type `omidProtocolNonce` → `:failed` reason `invalid_omid_field`
 *   - `omid: 'yes'` (non-boolean `omid`)               → `:failed` reason `invalid_omid_field`
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see docs/design/0.7.8-omid-spec-compliant-bridge.md §4.3 / §5.x
 */

import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

let failures = 0;
function assert(cond, message) {
  if (cond) process.stdout.write('  ✓ ' + message + '\n');
  else { process.stderr.write('  ✗ ' + message + '\n'); failures++; }
}

console.log('test-omid-renderer-prelude.js — 0.7.8 renderer OMID error/validation paths\n');

const RENDERER_PATH = new URL('../../examples/renderer/index.html', import.meta.url);
const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');

// Extract the main inline script (LONGEST <script>...</script>) — same approach
// as test-renderer-domparser-fallback.js; the renderer is the source of truth.
function extractInlineScript(src) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let match; let longest = '';
  while ((match = re.exec(src)) !== null) {
    if (match[1].length > longest.length) longest = match[1];
  }
  return longest;
}
const inlineScript = extractInlineScript(rendererSrc);
assert(inlineScript.length > 1000, 'extracted renderer inline script (' + inlineScript.length + ' chars)');
assert(/installOmidShimPrelude/.test(inlineScript), 'extracted script contains installOmidShimPrelude');
assert(/invalid_omid_field/.test(inlineScript), 'extracted script contains the invalid_omid_field reason');
assert(/omid_shim_inject_failed/.test(inlineScript), 'extracted script contains the omid_shim_inject_failed reason');

const RENDERER_ORIGIN = 'https://renderer.operator.example';
const CONTAINER_ORIGIN = 'https://publisher.example';
const NONCE = 'render-nonce-omid';
const PSID = 'sid-omid-prelude';

/**
 * Boots a fresh renderer instance in jsdom, optionally with a
 * `sharcTestOmidShimUrl` query knob and a custom global `fetch` stub, then
 * dispatches a `:render` envelope and returns every message posted to the
 * (stubbed) parent.
 *
 * @param {{ shimUrl?: string, fetchImpl?: Function, renderData: object }} opts
 * @returns {Promise<Array<{msg: any, origin: string}>>}
 */
async function runRender(opts) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    virtualConsole.on(level, () => {});
  });

  let url = RENDERER_ORIGIN + '/0.7.0/#sharcNonce=' + NONCE;
  if (opts.shimUrl !== undefined) {
    url = RENDERER_ORIGIN + '/0.7.0/?sharcTestOmidShimUrl='
      + encodeURIComponent(opts.shimUrl) + '#sharcNonce=' + NONCE;
  }

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url,
    runScripts: 'dangerously',
    virtualConsole,
  });
  const win = dom.window;

  // Capture customSecurityLog calls so we can assert the specific cause is
  // logged (the :failed reason is coarse; the cross-origin distinction lives
  // in the structured log).
  const securityLogs = [];

  const parentMessages = [];
  const fakeParent = {
    postMessage: (msg, origin) => { parentMessages.push({ msg, origin }); },
  };
  Object.defineProperty(win, 'parent', { configurable: true, get: () => fakeParent });

  // Stub fetch on the jsdom window/global if the test provides one.
  if (typeof opts.fetchImpl === 'function') {
    win.fetch = opts.fetchImpl;
    win.eval('this.fetch = window.fetch;');
  }

  win.__sharcRenderer = {
    installNavigationBridge: () => {},
  };

  win.eval(inlineScript);

  // Wrap customSecurityLog AFTER the inline script defines it.
  if (win.__sharcRenderer && typeof win.__sharcRenderer.customSecurityLog === 'function') {
    const orig = win.__sharcRenderer.customSecurityLog;
    win.__sharcRenderer.customSecurityLog = function (message, meta) {
      securityLogs.push({ message, meta });
      try { return orig.call(this, message, meta); } catch (_) { /* ignore */ }
    };
  }

  await Promise.resolve();
  await Promise.resolve();

  const renderMessage = Object.assign({
    type: 'SHARC:Renderer:render',
    placementSessionId: PSID,
    containerOrigin: CONTAINER_ORIGIN,
    sharcNonce: NONCE,
    sharcVersion: '0.7.0',
    rendererProtocolVersion: '1',
    creativeHtml:
      '<!DOCTYPE html><html><head></head><body><div id="c">ad</div></body></html>',
  }, opts.renderData || {});

  const renderEvent = new win.MessageEvent('message', {
    data: renderMessage,
    origin: CONTAINER_ORIGIN,
    source: fakeParent,
  });
  win.dispatchEvent(renderEvent);

  // Flush the async :render handler (swCheckPromise + acceptAndRender + the
  // awaited installOmidShimPrelude).
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) await Promise.resolve();

  return { parentMessages, securityLogs };
}

function failedReplies(parentMessages) {
  return parentMessages.filter((m) => m.msg && m.msg.type === 'SHARC:Renderer:failed');
}

// ── 1. non-ok fetch of the shim source → omid_shim_inject_failed ────────────
console.log('\n1. non-ok shim fetch → :failed (omid_shim_inject_failed)');
{
  // Point the shim URL same-origin so the cross-origin guard passes and the
  // fetch is actually attempted; the stub returns a non-ok response.
  const { parentMessages } = await runRender({
    shimUrl: RENDERER_ORIGIN + '/dist/sharc-omid-shim.js',
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    renderData: { omid: true, omidProtocolNonce: 'omid-nonce-abc' },
  });
  const failed = failedReplies(parentMessages);
  assert(failed.length === 1, 'a single :failed reply was posted');
  assert(failed.length === 1 && failed[0].msg.reason === 'omid_shim_inject_failed',
    ':failed reason is omid_shim_inject_failed (fetch !ok is fatal — no silent render)');
  const ok = failedReplies(parentMessages).every((m) => m.origin === CONTAINER_ORIGIN);
  assert(ok, ':failed targetOrigin is the validated containerOrigin');
}

// ── 2. cross-origin OMID_SHIM_URL → omid_shim_inject_failed (+logged cause) ──
console.log('\n2. cross-origin OMID_SHIM_URL → :failed (omid_shim_inject_failed)');
{
  const { parentMessages, securityLogs } = await runRender({
    shimUrl: 'https://evil.cdn.example/sharc-omid-shim.js',
    // fetch should NEVER be called — the same-origin guard throws first.
    fetchImpl: async () => { throw new Error('fetch must not run for cross-origin URL'); },
    renderData: { omid: true, omidProtocolNonce: 'omid-nonce-abc' },
  });
  const failed = failedReplies(parentMessages);
  assert(failed.length === 1 && failed[0].msg.reason === 'omid_shim_inject_failed',
    'cross-origin shim URL → :failed omid_shim_inject_failed');
  const sawCrossOrigin = securityLogs.some((l) =>
    l.message && /omid_shim_url_cross_origin/.test(String(l.message)));
  assert(sawCrossOrigin,
    'the specific cross-origin cause (omid_shim_url_cross_origin) is recorded in customSecurityLog');
}

// ── 3. omid:true with NO omidProtocolNonce → invalid_omid_field ─────────────
console.log('\n3. omid:true without omidProtocolNonce → :failed (invalid_omid_field)');
{
  const { parentMessages } = await runRender({
    renderData: { omid: true /* no omidProtocolNonce */ },
  });
  const failed = failedReplies(parentMessages);
  assert(failed.length === 1 && failed[0].msg.reason === 'invalid_omid_field',
    'omid:true without a nonce is rejected as invalid_omid_field BEFORE any fetch');
}

// ── 4. omid:true with wrong-type omidProtocolNonce → invalid_omid_field ─────
console.log('\n4. omid:true with wrong-type omidProtocolNonce → :failed (invalid_omid_field)');
{
  const { parentMessages } = await runRender({
    renderData: { omid: true, omidProtocolNonce: 12345 /* number, not string */ },
  });
  const failed = failedReplies(parentMessages);
  assert(failed.length === 1 && failed[0].msg.reason === 'invalid_omid_field',
    'wrong-type omidProtocolNonce is rejected as invalid_omid_field');
}

// ── 5. non-boolean omid → invalid_omid_field ────────────────────────────────
console.log('\n5. non-boolean omid → :failed (invalid_omid_field)');
{
  const { parentMessages } = await runRender({
    renderData: { omid: 'yes' /* string, not boolean */, omidProtocolNonce: 'n' },
  });
  const failed = failedReplies(parentMessages);
  assert(failed.length === 1 && failed[0].msg.reason === 'invalid_omid_field',
    'non-boolean omid is rejected as invalid_omid_field');
}

// ── 6. inner installOmidShim() runtime THROW → surfaced to container (#249) ──
//
// The outer `installOmidShimPrelude` succeeds (URL resolves, fetch ok, source
// parses) — but the shim's `installOmidShim(config)` call THROWS at runtime
// inside the inline <script> during `document.write` (a half-install: a
// pre-existing `window.omid3p`, a listener-attach failure, a new install-time
// throw). Before #249 this throw was caught inside the creative iframe and only
// `console.error`'d — INVISIBLE to the container. The renderer's :rendered
// reply still fired, four green gates missed it, and the shim was half-installed
// (window.omid3p present, listener unattached). This asserts the catch now
// SURFACES the failure to the container as a `:failed` reply with reason
// `omid_shim_install_failed` (an existing wire shape — `reason` is opaque-string
// passthrough; the container routes it to onSecurityEvent renderer_failed).
console.log('\n6. inner installOmidShim() throw → :failed (omid_shim_install_failed) (#249)');
{
  // A shim source that PARSES fine and self-attaches installOmidShim, but the
  // install THROWS at runtime — modelling a half-install (e.g. the §11.3
  // pre-existing-omid3p loud-fail, or a listener-attach error).
  const throwingShimSource =
    'window.SHARC = window.SHARC || {};'
    + 'window.SHARC.installOmidShim = function () {'
    + '  window.omid3p = { __halfInstalled: true };'  // partial state set …
    + '  throw new Error("simulated half-install: listener attach failed");'  // … then throws
    + '};';
  const { parentMessages } = await runRender({
    shimUrl: RENDERER_ORIGIN + '/dist/sharc-omid-shim.js',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => throwingShimSource }),
    renderData: { omid: true, omidProtocolNonce: 'omid-nonce-abc' },
  });
  const failed = failedReplies(parentMessages);
  const installFailed = failed.filter((m) => m.msg.reason === 'omid_shim_install_failed');
  assert(installFailed.length >= 1,
    'a half-installed shim surfaces a :failed reply (was a swallowed console.error pre-#249)');
  assert(installFailed.length >= 1 && installFailed[0].msg.reason === 'omid_shim_install_failed',
    ':failed reason is omid_shim_install_failed — the container can observe the half-install');
  assert(installFailed.length >= 1 && installFailed[0].msg.sharcNonce === NONCE,
    ':failed echoes the renderer-protocol nonce so the container router accepts it (attaching-renderer phase)');
  assert(installFailed.length >= 1 && installFailed[0].msg.placementSessionId === PSID,
    ':failed echoes the placementSessionId so the container correlates the envelope');
  assert(installFailed.every((m) => m.origin === CONTAINER_ORIGIN),
    ':failed targetOrigin is the validated containerOrigin (not a wildcard)');
}

// ── 7. SUCCESSFUL install → NO false-positive failure signal (#249) ──────────
//
// Guards against a false positive: a shim whose installOmidShim() returns
// cleanly must NOT trigger any `omid_shim_install_failed` :failed reply. The
// successful-install path must be byte-for-byte the pre-#249 behaviour.
console.log('\n7. successful installOmidShim() → NO omid_shim_install_failed reply (#249 no false positive)');
{
  const cleanShimSource =
    'window.SHARC = window.SHARC || {};'
    + 'window.SHARC.installOmidShim = function () {'
    + '  window.omid3p = { registerSessionObserver: function () {}, sendMessage: function () {} };'
    + '};';
  const { parentMessages } = await runRender({
    shimUrl: RENDERER_ORIGIN + '/dist/sharc-omid-shim.js',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => cleanShimSource }),
    renderData: { omid: true, omidProtocolNonce: 'omid-nonce-abc' },
  });
  const installFailed = failedReplies(parentMessages)
    .filter((m) => m.msg.reason === 'omid_shim_install_failed');
  assert(installFailed.length === 0,
    'a clean install posts NO omid_shim_install_failed reply (successful path unchanged)');
}

// ── Done ────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(failures + ' assertion failure(s)');
  process.exit(1);
}
console.log('All omid-renderer-prelude assertions passed.');
