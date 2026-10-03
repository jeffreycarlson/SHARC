/**
 * test-renderer-wrapper-prelude-fetch-order.js — #463 regression.
 *
 * The MRAID and SafeFrame compatibility wrappers fetch three same-origin
 * sources (protocol, creative, bridge). Whatever the fetch strategy, it must
 * keep the semantics of the original sequential awaits:
 *
 *   T1  declaration-order errors: when every source fails, the error names
 *       the PROTOCOL source even though it is the slowest to fail.
 *   T2  concatenation order: sources completing in reverse order still land
 *       in the prelude as protocol, creative, bridge.
 *   T3  fail-fast: a protocol failure rejects promptly even while a later
 *       source never settles (a bare wait-for-all would hang until the
 *       container's renderer-reply timeout and lose the `:failed` URL).
 *
 * Plus: no unhandled rejections from sources that fail after the call has
 * already thrown.
 *
 * The functions under test are extracted from the shipped renderer and run
 * in a `vm` context with a stubbed `fetch`. Runs in Node. No test framework.
 *
 * @see examples/renderer/index.html installMraidCompatibilityWrapperPrelude
 */

import fs from 'node:fs';
import vm from 'node:vm';

let failures = 0;
function assert(cond, message) {
  if (cond) process.stdout.write('  ✓ ' + message + '\n');
  else { process.stderr.write('  ✗ ' + message + '\n'); failures++; }
}

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

console.log('test-renderer-wrapper-prelude-fetch-order.js — #463 wrapper fetch order\n');

const RENDERER_PATH = new URL('../../examples/renderer/index.html', import.meta.url);
const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');

// Same brace-balancing extractor as test-renderer-prelude-script-escaping.js.
function extractFunction(src, name) {
  const decl = 'function ' + name + '(';
  let start = src.indexOf(decl);
  if (start === -1) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  let inLine = false;
  let inBlock = false;
  let inStr = false;
  let strCh = '';
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting: ' + name);
}

const HELPERS = ['jsonForInlineScript', 'escapeClosingScriptTokens', 'injectPreludeScript',
  'fetchSameOriginRendererSource'];
const OPTIONAL_HELPERS = ['fetchWrapperPreludeSources'];

const ORIGIN = 'https://renderer.example';
const WRAPPERS = [
  { name: 'MRAID', fn: 'installMraidCompatibilityWrapperPrelude', key: 'MRAID', prefix: 'mraid' },
  { name: 'SafeFrame', fn: 'installSafeFrameCompatibilityWrapperPrelude', key: 'SAFEFRAME', prefix: 'safeframe' },
];
const PARTS = ['PROTOCOL', 'CREATIVE', 'BRIDGE'];
const urlFor = (w, part) => ORIGIN + '/dist/' + w.prefix + '-' + part.toLowerCase() + '.js';
const bodyFor = (w, part) => '/*' + w.prefix + '_' + part + '_BODY*/';

/**
 * Build a fresh context whose `fetch` follows `plan[part]`:
 *   { ms, status }  -> resolves after `ms` with that status (body = bodyFor)
 *   'hang'          -> never settles
 */
function makeWrapper(w, plan) {
  const config = { TEST_ONLY: true };
  const byUrl = {};
  for (const part of PARTS) {
    config[w.key + '_WRAPPER_' + part + '_URL'] = urlFor(w, part);
    byUrl[urlFor(w, part)] = { part, step: plan[part] };
  }
  const fetchStub = (url) => {
    const entry = byUrl[String(url)];
    if (!entry) return Promise.reject(new TypeError('unexpected fetch: ' + url));
    if (entry.step === 'hang') return new Promise(() => {});
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: entry.step.status >= 200 && entry.step.status < 300,
      status: entry.step.status,
      text: async () => bodyFor(w, entry.part),
    }), entry.step.ms));
  };
  const ctx = vm.createContext({
    URL,
    fetch: fetchStub,
    window: { location: { href: ORIGIN + '/0.7.0/', origin: ORIGIN } },
    RENDERER_CONFIG: Object.freeze(config),
  });
  for (const name of HELPERS) vm.runInContext(extractFunction(rendererSrc, name), ctx);
  for (const name of OPTIONAL_HELPERS) {
    let src = null;
    try { src = extractFunction(rendererSrc, name); } catch (_) { /* absent in sequential form */ }
    if (src) vm.runInContext(src, ctx);
  }
  vm.runInContext(extractFunction(rendererSrc, w.fn), ctx);
  return (html, psid) => ctx[w.fn](html, psid);
}

function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'timeout' }), ms);
  });
  return Promise.race([
    promise.then((value) => ({ state: 'fulfilled', value }),
      (error) => ({ state: 'rejected', error })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

const CREATIVE = '<!DOCTYPE html><html><head></head><body><div id="c">ad</div></body></html>';

for (const w of WRAPPERS) {
  const protocolPrefix = w.prefix + '_wrapper_protocol_fetch_failed';

  console.log(w.name + ' T1 — all three 404, protocol slowest: error is the protocol source');
  {
    const run = makeWrapper(w, {
      PROTOCOL: { ms: 40, status: 404 },
      CREATIVE: { ms: 20, status: 404 },
      BRIDGE: { ms: 0, status: 404 },
    });
    const r = await settleWithin(run(CREATIVE, 'psid-463'), 1000);
    assert(r.state === 'rejected', 'call rejects (got ' + r.state + ')');
    const msg = r.error && String(r.error.message);
    assert(r.state === 'rejected' && msg.indexOf(protocolPrefix) === 0,
      'message starts with ' + protocolPrefix + ' (got ' + msg + ')');
    assert(r.state === 'rejected' && r.error.url === urlFor(w, 'PROTOCOL'),
      '.url is the protocol URL (got ' + (r.error && r.error.url) + ')');
  }

  console.log(w.name + ' T2 — all succeed in reverse completion order: prelude keeps declaration order');
  {
    const run = makeWrapper(w, {
      PROTOCOL: { ms: 40, status: 200 },
      CREATIVE: { ms: 20, status: 200 },
      BRIDGE: { ms: 0, status: 200 },
    });
    const r = await settleWithin(run(CREATIVE, 'psid-463'), 1000);
    assert(r.state === 'fulfilled', 'call resolves (got ' + r.state + ')');
    const out = r.state === 'fulfilled' ? String(r.value) : '';
    const idx = PARTS.map((part) => out.indexOf(bodyFor(w, part)));
    assert(idx.every((i) => i !== -1), 'prelude contains all three bodies');
    assert(idx[0] < idx[1] && idx[1] < idx[2],
      'bodies appear as protocol, creative, bridge (indices ' + idx.join(', ') + ')');
  }

  console.log(w.name + ' T3 — protocol 404s immediately, creative hangs: fails fast');
  {
    const run = makeWrapper(w, {
      PROTOCOL: { ms: 0, status: 404 },
      CREATIVE: 'hang',
      BRIDGE: { ms: 50, status: 404 },
    });
    const started = Date.now();
    const r = await settleWithin(run(CREATIVE, 'psid-463'), 200);
    const elapsed = Date.now() - started;
    assert(r.state === 'rejected', 'call rejects within 200 ms (got ' + r.state
      + ' after ' + elapsed + ' ms)');
    assert(r.state === 'rejected' && String(r.error.message).indexOf(protocolPrefix) === 0
      && r.error.url === urlFor(w, 'PROTOCOL'),
      'rejection is the protocol error with the protocol URL');
  }
  console.log('');
}

// Let late-failing sources (T3's bridge at 50 ms) settle before counting.
await new Promise((resolve) => setTimeout(resolve, 100));
console.log('Unhandled rejections');
assert(unhandled.length === 0, 'no unhandled rejections (got ' + unhandled.length
  + (unhandled.length ? ': ' + unhandled.map((e) => e && e.message).join('; ') : '') + ')');

console.log('');
if (failures > 0) {
  console.error(failures + ' assertion failure(s)');
  process.exit(1);
}
console.log('All wrapper prelude fetch-order assertions passed.');
