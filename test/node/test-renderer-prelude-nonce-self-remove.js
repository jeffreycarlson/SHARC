/**
 * test-renderer-prelude-nonce-self-remove.js — #254 regression.
 *
 * The renderer's two source-rewrite preludes (installLoadProbePrelude,
 * installOmidShimPrelude in examples/renderer/index.html) bake a per-protocol
 * nonce into an inline <script> as a JSON literal closure constant. The closure
 * makes the *variable* unreachable, but the injected <script>'s source TEXT
 * still carries the nonce literal — readable by creative code that iterates
 * `document.scripts` and reads `.textContent` / `.outerHTML`. A hostile creative
 * harvesting the renderer nonce can forge a valid `SHARC:Renderer:loadAck`.
 *
 * Fix (#254): each prelude self-removes its own <script> element as its FINAL
 * synchronous statement, AFTER the nonce is captured into the closure. The
 * closure keeps the handshake / shim working; the source text leaves the DOM
 * before any later same-document creative markup is parsed.
 *
 * This test extracts the ACTUAL shipped prelude functions from the renderer
 * file (brace-balanced source slice — the renderer is the source of truth, no
 * inlined copy), evals them in jsdom, runs each prelude's output HTML through a
 * real `document.write` so the self-removal IIFE actually executes, then:
 *   - asserts NO element in document.scripts contains the nonce literal in
 *     `.textContent` or `.outerHTML` (harvest is impossible);
 *   - asserts the nonce is not on location.hash / location.search / a global;
 *   - asserts the renderer STILL FUNCTIONS post-removal:
 *       * load-probe: a forged :loadProbe still elicits a :loadAck carrying the
 *         correct nonce;
 *       * omid-shim: installOmidShim is invoked with the correct protocolNonce.
 *
 * Fail-for-the-right-reason: a control run with the self-removal line stripped
 * out re-exposes the nonce in document.scripts — proving the harvest assertion
 * is actually gated on the removal, not on some unrelated parse quirk.
 *
 * DOMParser-fallback consumption path (#268 follow-up). The renderer has TWO
 * consumption paths for creative markup (acceptAndRender, ~L1442):
 *   1. `document.write(html)` (default), and
 *   2. `tryDomParserReplaceChildren(html)` — the DOMParser + replaceChildren
 *      fallback (proposal AC L1201/L1202), reached when `document.write`
 *      throws OR when `RENDERER_CONFIG.FORCE_DOMPARSER_FALLBACK = true`.
 * The fallback re-creates each parsed (inert) <script> as a fresh live-document
 * <script> in document order so it executes (the shipped helper's "Pass 2").
 * This area has a documented history of passing under jsdom on the
 * document.write path while breaking on the fallback path, so cases 5–8 route
 * BOTH preludes through the SHIPPED `tryDomParserReplaceChildren` (extracted by
 * the same brace-balancer) and re-assert the full harvest/handshake contract on
 * the fallback path, plus a stripped-removal control on the fallback path.
 *
 * Decoy-collision regression (#268 follow-up). A hostile creative can embed its
 * own `<script data-sharc-prelude="load-probe">` (or "omid-shim") decoy hoping
 * to shield the real prelude from the selector-based self-removal. Cases 9–10
 * assert the REAL prelude (the one whose source carries the protocol nonce) is
 * the element removed — `querySelector` matches the document-order-first node,
 * which is the real prelude forced to `head.firstChild` — so the decoy cannot
 * shield the real nonce. Run on both consumption paths (the fallback parses the
 * whole tree, including the decoy, at once).
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see examples/renderer/index.html installLoadProbePrelude / installOmidShimPrelude
 */

import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

let failures = 0;
function assert(cond, message) {
  if (cond) process.stdout.write('  ✓ ' + message + '\n');
  else { process.stderr.write('  ✗ ' + message + '\n'); failures++; }
}

console.log('test-renderer-prelude-nonce-self-remove.js — #254 prelude nonce self-removal\n');

const RENDERER_PATH = new URL('../../examples/renderer/index.html', import.meta.url);
const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');

/**
 * Slice a named `function NAME(...) { ... }` out of the renderer source by
 * balancing braces from the opening `{`. Robust against comments/strings that
 * contain braces only where balanced — adequate here (the prelude bodies are
 * well-formed JS and contain no unbalanced-brace string literals at the top
 * level of the slice; brace chars inside the built `code` strings are balanced).
 */
function extractFunction(src, name) {
  const decl = 'function ' + name + '(';
  let start = src.indexOf(decl);
  if (start === -1) throw new Error('function not found: ' + name);
  // Preserve a leading `async ` qualifier so async function declarations
  // (installOmidShimPrelude) extract as async, not as a sync function whose
  // body uses `await`.
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

const jsonForInlineScriptSrc = extractFunction(rendererSrc, 'jsonForInlineScript');
// #329: both prelude builders now delegate inject-and-serialize to the single
// shared, always-escaping injector. Extract its two functions so the builders
// resolve them when eval'd in isolation.
const escapeClosingScriptTokensSrc = extractFunction(rendererSrc, 'escapeClosingScriptTokens');
const injectPreludeScriptSrc = extractFunction(rendererSrc, 'injectPreludeScript');
const loadProbeSrc = extractFunction(rendererSrc, 'installLoadProbePrelude');
const omidShimPreludeSrc = extractFunction(rendererSrc, 'installOmidShimPrelude');
// The SHIPPED DOMParser + replaceChildren fallback helper (proposal AC
// L1201/L1202). Cases 5–10 route prelude+creative through this exact function
// so the fallback consumption path's Pass-2 script recreation runs the prelude
// self-removal IIFE — same source-of-truth discipline as the prelude extracts.
const tryDomParserReplaceChildrenSrc = extractFunction(rendererSrc, 'tryDomParserReplaceChildren');

assert(/self-remove|self‑remove|removeChild/.test(loadProbeSrc),
  'extracted installLoadProbePrelude contains the self-removal');
assert(/data-sharc-prelude="load-probe"/.test(loadProbeSrc),
  'load-probe prelude tags its <script> with data-sharc-prelude="load-probe"');
assert(/data-sharc-prelude="omid-shim"/.test(omidShimPreludeSrc),
  'omid-shim prelude tags its <script> with data-sharc-prelude="omid-shim"');
assert(/replaceChildren/.test(tryDomParserReplaceChildrenSrc)
  && /createElement\(['"]script['"]\)/.test(tryDomParserReplaceChildrenSrc),
  'extracted tryDomParserReplaceChildren is the shipped DOMParser+replaceChildren fallback (Pass-2 recreates scripts)');

const RENDERER_ORIGIN = 'https://renderer.operator.example';
const CONTAINER_ORIGIN = 'https://publisher.example';
const LOAD_NONCE = 'load-probe-nonce-5b2f9c-DEADBEEF';
const OMID_NONCE = 'omid-protocol-nonce-7a1e3d-CAFEF00D';
const PSID = 'sid-254';

/**
 * Boot a jsdom window, eval the extracted prelude helpers into it, return the
 * window plus bound prelude functions. A fetch stub serves the built OMID shim
 * source for installOmidShimPrelude.
 */
function bootPreludeEnv() {
  const virtualConsole = new VirtualConsole();
  ['log', 'info', 'warn', 'error', 'debug'].forEach((l) => virtualConsole.on(l, () => {}));
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/',
    runScripts: 'dangerously',
    virtualConsole,
  });
  const win = dom.window;

  // OMID shim source — served same-origin to satisfy installOmidShimPrelude's
  // same-origin guard. We use the actual built shim so installOmidShim is real.
  const shimUrl = RENDERER_ORIGIN + '/dist/sharc-omid-shim.js';
  const SHIM_PATH = new URL('../../dist/sharc-omid-shim.js', import.meta.url);
  const shimSource = fs.readFileSync(SHIM_PATH, 'utf8');
  win.fetch = async (u) => {
    if (String(u).indexOf('sharc-omid-shim.js') !== -1) {
      return { ok: true, status: 200, text: async () => shimSource };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  win.eval('this.fetch = window.fetch;');

  // RENDERER_CONFIG is referenced by installOmidShimPrelude (OMID_SHIM_URL).
  win.eval('var RENDERER_CONFIG = { TEST_ONLY: true, OMID_SHIM_URL: '
    + JSON.stringify(shimUrl) + ' };');
  win.eval(jsonForInlineScriptSrc);
  win.eval(escapeClosingScriptTokensSrc);
  win.eval(injectPreludeScriptSrc);
  win.eval(loadProbeSrc);
  win.eval(omidShimPreludeSrc);

  return {
    win,
    shimUrl,
    installLoadProbePrelude: (...a) => win.installLoadProbePrelude(...a),
    installOmidShimPrelude: (...a) => win.installOmidShimPrelude(...a),
  };
}

/**
 * Run `html` (prelude-prepended markup) through a real document.write in a
 * FRESH jsdom document so the prelude IIFE — including its synchronous
 * self-removal — actually executes. Returns the post-write window + document.
 * Optionally pre-seeds parent / message plumbing.
 */
function writeAndRun(html, opts = {}) {
  const virtualConsole = new VirtualConsole();
  ['log', 'info', 'warn', 'error', 'debug'].forEach((l) => virtualConsole.on(l, () => {}));
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/#sharcNonce=should-not-match',
    runScripts: 'dangerously',
    virtualConsole,
  });
  const win = dom.window;

  if (opts.beforeWrite) opts.beforeWrite(win);

  win.document.open();
  win.document.write(html);
  win.document.close();

  return { win, doc: win.document };
}

/**
 * Route `html` (prelude-prepended markup) through the SHIPPED
 * `tryDomParserReplaceChildren` in a FRESH jsdom document, exercising the
 * DOMParser-fallback consumption path instead of `document.write`.
 *
 * How the fallback path is invoked: there is no test seam inside
 * `tryDomParserReplaceChildren` itself — it is a plain function. The renderer
 * reaches it from `acceptAndRender` either when `document.write` throws or when
 * `RENDERER_CONFIG.FORCE_DOMPARSER_FALLBACK === true`. We invoke the same
 * shipped function directly with the live document intact (documentElement
 * present), which is precisely the FORCE_DOMPARSER_FALLBACK sub-path:
 * `document.documentElement.replaceChildren(parsed.head, parsed.body)` then the
 * Pass-2 script-recreation loop that re-creates and executes the prelude
 * <script> — including its synchronous self-removal — in document order.
 *
 * `this.__runFallback` is exposed inside the window so the function body's bare
 * `document` / `DOMParser` references resolve to the jsdom window's globals.
 */
function parseAndRunFallback(html, opts = {}) {
  const virtualConsole = new VirtualConsole();
  ['log', 'info', 'warn', 'error', 'debug'].forEach((l) => virtualConsole.on(l, () => {}));
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/#sharcNonce=should-not-match',
    runScripts: 'dangerously',
    virtualConsole,
  });
  const win = dom.window;

  if (opts.beforeRun) opts.beforeRun(win);

  win.eval(tryDomParserReplaceChildrenSrc);
  win.eval('this.__runFallback = function(h){ tryDomParserReplaceChildren(h); };');
  win.__runFallback(html);

  return { win, doc: win.document };
}

function nonceInScripts(doc, nonce) {
  const scripts = doc.scripts || doc.getElementsByTagName('script');
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    const text = s.textContent || '';
    const outer = s.outerHTML || '';
    if (text.indexOf(nonce) !== -1 || outer.indexOf(nonce) !== -1) return true;
  }
  return false;
}

function nonceInGlobals(win, nonce) {
  // Heuristic global scan for the literal (covers a prelude leaking it onto
  // window). The preludes hold it in closure only; this must come back false.
  try {
    const keys = Object.getOwnPropertyNames(win);
    for (let i = 0; i < keys.length; i++) {
      const v = win[keys[i]];
      if (typeof v === 'string' && v.indexOf(nonce) !== -1) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

const CREATIVE = '<!DOCTYPE html><html><head></head><body><div id="c">ad</div></body></html>';

// ── 1. load-probe prelude: harvest impossible, handshake still works ────────
console.log('\n1. load-probe prelude — nonce not harvestable, :loadAck still works');
{
  const env = bootPreludeEnv();
  const html = env.installLoadProbePrelude(CREATIVE, PSID, CONTAINER_ORIGIN, LOAD_NONCE);

  // Sanity: the produced markup string DOES contain the nonce (it is the inline
  // <script> source) — the protection is the runtime self-removal, not omission.
  assert(html.indexOf(LOAD_NONCE) !== -1,
    'pre-write markup string contains the nonce literal (baked inline script)');

  const acks = [];
  const { win, doc } = writeAndRun(html, {
    beforeWrite: (w) => {
      const fakeParent = { postMessage: (msg) => acks.push(msg) };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      w.__fakeParent = fakeParent;
    },
  });

  // Harvest assertions.
  assert(!nonceInScripts(doc, LOAD_NONCE),
    'no document.scripts element exposes the nonce in textContent/outerHTML (self-removed)');
  assert((win.location.hash || '').indexOf(LOAD_NONCE) === -1,
    'nonce is not on location.hash');
  assert((win.location.search || '').indexOf(LOAD_NONCE) === -1,
    'nonce is not on location.search');
  assert(!nonceInGlobals(win, LOAD_NONCE),
    'nonce is not exposed on any window global');

  // Functionality: forge a :loadProbe from the parent at the container origin;
  // the closure-held listener must still answer with the correct nonce.
  const probe = new win.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:loadProbe',
      placementSessionId: PSID,
    },
    origin: CONTAINER_ORIGIN,
    source: win.__fakeParent,
  });
  win.dispatchEvent(probe);

  const ack = acks.find((m) => m && m.type === 'SHARC:Renderer:loadAck');
  assert(!!ack, ':loadProbe still elicits a :loadAck after self-removal');
  assert(!!ack && ack.sharcNonce === LOAD_NONCE,
    ':loadAck carries the correct closure-held nonce (handshake intact post-removal)');
  assert(!!ack && ack.placementSessionId === PSID,
    ':loadAck carries the correct placementSessionId');
}

// ── 2. load-probe CONTROL: removal stripped → nonce IS harvestable ──────────
console.log('\n2. load-probe CONTROL — self-removal stripped re-exposes the nonce');
{
  const env = bootPreludeEnv();
  let html = env.installLoadProbePrelude(CREATIVE, PSID, CONTAINER_ORIGIN, LOAD_NONCE);
  // Strip the self-removal statement from the *generated* markup to prove the
  // harvest assertion is gated on the removal (fail-for-the-right-reason).
  const before = html;
  html = html.replace(
    /try\{var __s=document\.querySelector\([^)]*data-sharc-prelude="load-probe"[^)]*\);if\(__s&&__s\.parentNode\)__s\.parentNode\.removeChild\(__s\);\}catch\(_\)\{\}/,
    '');
  assert(html !== before, 'control: successfully stripped the self-removal statement');

  const { doc } = writeAndRun(html, {
    beforeWrite: (w) => {
      const fakeParent = { postMessage: () => {} };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
    },
  });
  assert(nonceInScripts(doc, LOAD_NONCE),
    'CONTROL: without self-removal the nonce IS readable from document.scripts '
    + '(confirms the test fails for the right reason)');
}

// ── 3. omid-shim prelude: harvest impossible, installOmidShim still runs ────
console.log('\n3. omid-shim prelude — nonce not harvestable, installOmidShim still receives it');
{
  const env = bootPreludeEnv();
  const html = await env.installOmidShimPrelude(
    CREATIVE, OMID_NONCE, PSID, CONTAINER_ORIGIN);

  assert(html.indexOf(OMID_NONCE) !== -1,
    'pre-write markup string contains the OMID nonce literal (baked inline script)');

  // Let the REAL built shim install (the prelude routes to
  // window.SHARC.installOmidShim, which the bundled shim self-attaches). We
  // prove the shim is functional post-removal end-to-end: window.omid3p is
  // live, and a vendor registration → sessionStart flushes a Register envelope
  // back to parent SIGNED with the closure-held protocolNonce. That Register's
  // sharcNonce === OMID_NONCE is the functional proof the nonce reached the
  // working shim after the prelude <script> removed itself.
  const parentMessages = [];
  const { win, doc } = writeAndRun(html, {
    beforeWrite: (w) => {
      const fakeParent = { postMessage: (msg) => parentMessages.push(msg) };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      w.__fakeParent = fakeParent;
    },
  });

  assert(!nonceInScripts(doc, OMID_NONCE),
    'no document.scripts element exposes the OMID nonce (self-removed)');
  assert((win.location.hash || '').indexOf(OMID_NONCE) === -1,
    'OMID nonce is not on location.hash');
  assert((win.location.search || '').indexOf(OMID_NONCE) === -1,
    'OMID nonce is not on location.search');
  assert(!nonceInGlobals(win, OMID_NONCE),
    'OMID nonce is not exposed on any window global');

  assert(win.omid3p && typeof win.omid3p.registerSessionObserver === 'function',
    'the OMID shim installed window.omid3p successfully AFTER self-removal');

  // Vendor registers a session observer (Register deferred until sessionStart).
  win.omid3p.registerSessionObserver(function () {}, 'vendor-1.0');
  // Parent dispatches a sessionStart Event signed with the protocol nonce —
  // this is the only way to flip the session live and flush the Register.
  const sessionStart = new win.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: OMID_NONCE,
      placementSessionId: PSID,
      event: { adSessionId: PSID, type: 'sessionStart', data: {} },
    },
    origin: CONTAINER_ORIGIN,
    source: win.__fakeParent,
  });
  win.dispatchEvent(sessionStart);

  const register = parentMessages.find((m) => m && m.type === 'SHARC:Omid:Register');
  assert(!!register,
    'a SHARC:Omid:Register flushed to parent after sessionStart (shim functional post-removal)');
  assert(!!register && register.sharcNonce === OMID_NONCE,
    'the flushed Register is signed with the correct closure-held protocolNonce');
}

// ── 4. omid-shim CONTROL: removal stripped → nonce IS harvestable ───────────
console.log('\n4. omid-shim CONTROL — self-removal stripped re-exposes the nonce');
{
  const env = bootPreludeEnv();
  let html = await env.installOmidShimPrelude(
    CREATIVE, OMID_NONCE, PSID, CONTAINER_ORIGIN);
  const before = html;
  html = html.replace(
    /try\{var __s=document\.querySelector\([^)]*data-sharc-prelude="omid-shim"[^)]*\);if\(__s&&__s\.parentNode\)__s\.parentNode\.removeChild\(__s\);\}catch\(_\)\{\}/,
    '');
  assert(html !== before, 'control: successfully stripped the self-removal statement');

  const { doc } = writeAndRun(html, {
    beforeWrite: (w) => {
      const fakeParent = { postMessage: () => {} };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      w.SHARC = { installOmidShim: () => {} };
    },
  });
  assert(nonceInScripts(doc, OMID_NONCE),
    'CONTROL: without self-removal the OMID nonce IS readable from document.scripts');
}

// ── 5. load-probe prelude via DOMParser fallback — harvest impossible ───────
console.log('\n5. load-probe prelude (DOMParser fallback path) — nonce not harvestable, :loadAck still works');
{
  const env = bootPreludeEnv();
  const html = env.installLoadProbePrelude(CREATIVE, PSID, CONTAINER_ORIGIN, LOAD_NONCE);

  const acks = [];
  const { win, doc } = parseAndRunFallback(html, {
    beforeRun: (w) => {
      const fakeParent = { postMessage: (msg) => acks.push(msg) };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      w.__fakeParent = fakeParent;
    },
  });

  assert(!nonceInScripts(doc, LOAD_NONCE),
    'FALLBACK: no document.scripts element exposes the nonce (Pass-2 ran the self-removal)');
  assert((win.location.hash || '').indexOf(LOAD_NONCE) === -1,
    'FALLBACK: nonce is not on location.hash');
  assert((win.location.search || '').indexOf(LOAD_NONCE) === -1,
    'FALLBACK: nonce is not on location.search');
  assert(!nonceInGlobals(win, LOAD_NONCE),
    'FALLBACK: nonce is not exposed on any window global');

  const probe = new win.MessageEvent('message', {
    data: { type: 'SHARC:Renderer:loadProbe', placementSessionId: PSID },
    origin: CONTAINER_ORIGIN,
    source: win.__fakeParent,
  });
  win.dispatchEvent(probe);

  const ack = acks.find((m) => m && m.type === 'SHARC:Renderer:loadAck');
  assert(!!ack, 'FALLBACK: :loadProbe still elicits a :loadAck after fallback self-removal');
  assert(!!ack && ack.sharcNonce === LOAD_NONCE,
    'FALLBACK: :loadAck carries the correct closure-held nonce (handshake intact on fallback path)');
  assert(!!ack && ack.placementSessionId === PSID,
    'FALLBACK: :loadAck carries the correct placementSessionId');
}

// ── 6. load-probe CONTROL on the FALLBACK path: removal stripped → harvestable
console.log('\n6. load-probe CONTROL (DOMParser fallback path) — self-removal stripped re-exposes the nonce');
{
  const env = bootPreludeEnv();
  let html = env.installLoadProbePrelude(CREATIVE, PSID, CONTAINER_ORIGIN, LOAD_NONCE);
  const before = html;
  html = html.replace(
    /try\{var __s=document\.querySelector\([^)]*data-sharc-prelude="load-probe"[^)]*\);if\(__s&&__s\.parentNode\)__s\.parentNode\.removeChild\(__s\);\}catch\(_\)\{\}/,
    '');
  assert(html !== before, 'control: successfully stripped the self-removal statement');

  const { doc } = parseAndRunFallback(html, {
    beforeRun: (w) => {
      const fakeParent = { postMessage: () => {} };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
    },
  });
  assert(nonceInScripts(doc, LOAD_NONCE),
    'FALLBACK CONTROL: without self-removal the nonce IS readable from document.scripts '
    + '(confirms the fallback-path harvest assertion fails for the right reason)');
}

// ── 7. omid-shim prelude via DOMParser fallback — harvest impossible ────────
console.log('\n7. omid-shim prelude (DOMParser fallback path) — nonce not harvestable, installOmidShim still receives it');
{
  const env = bootPreludeEnv();
  const html = await env.installOmidShimPrelude(
    CREATIVE, OMID_NONCE, PSID, CONTAINER_ORIGIN);

  const parentMessages = [];
  const { win, doc } = parseAndRunFallback(html, {
    beforeRun: (w) => {
      const fakeParent = { postMessage: (msg) => parentMessages.push(msg) };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      w.__fakeParent = fakeParent;
    },
  });

  assert(!nonceInScripts(doc, OMID_NONCE),
    'FALLBACK: no document.scripts element exposes the OMID nonce (Pass-2 ran the self-removal)');
  assert((win.location.hash || '').indexOf(OMID_NONCE) === -1,
    'FALLBACK: OMID nonce is not on location.hash');
  assert((win.location.search || '').indexOf(OMID_NONCE) === -1,
    'FALLBACK: OMID nonce is not on location.search');
  assert(!nonceInGlobals(win, OMID_NONCE),
    'FALLBACK: OMID nonce is not exposed on any window global');

  assert(win.omid3p && typeof win.omid3p.registerSessionObserver === 'function',
    'FALLBACK: the OMID shim installed window.omid3p successfully AFTER fallback self-removal');

  win.omid3p.registerSessionObserver(function () {}, 'vendor-1.0');
  const sessionStart = new win.MessageEvent('message', {
    data: {
      type: 'SHARC:Omid:Event',
      sharcNonce: OMID_NONCE,
      placementSessionId: PSID,
      event: { adSessionId: PSID, type: 'sessionStart', data: {} },
    },
    origin: CONTAINER_ORIGIN,
    source: win.__fakeParent,
  });
  win.dispatchEvent(sessionStart);

  const register = parentMessages.find((m) => m && m.type === 'SHARC:Omid:Register');
  assert(!!register,
    'FALLBACK: a SHARC:Omid:Register flushed to parent after sessionStart (shim functional on fallback path)');
  assert(!!register && register.sharcNonce === OMID_NONCE,
    'FALLBACK: the flushed Register is signed with the correct closure-held protocolNonce');
}

// ── 8. omid-shim CONTROL on the FALLBACK path: removal stripped → harvestable
console.log('\n8. omid-shim CONTROL (DOMParser fallback path) — self-removal stripped re-exposes the nonce');
{
  const env = bootPreludeEnv();
  let html = await env.installOmidShimPrelude(
    CREATIVE, OMID_NONCE, PSID, CONTAINER_ORIGIN);
  const before = html;
  html = html.replace(
    /try\{var __s=document\.querySelector\([^)]*data-sharc-prelude="omid-shim"[^)]*\);if\(__s&&__s\.parentNode\)__s\.parentNode\.removeChild\(__s\);\}catch\(_\)\{\}/,
    '');
  assert(html !== before, 'control: successfully stripped the self-removal statement');

  const { doc } = parseAndRunFallback(html, {
    beforeRun: (w) => {
      const fakeParent = { postMessage: () => {} };
      Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      w.SHARC = { installOmidShim: () => {} };
    },
  });
  assert(nonceInScripts(doc, OMID_NONCE),
    'FALLBACK CONTROL: without self-removal the OMID nonce IS readable from document.scripts');
}

// ── Decoy-collision helpers ─────────────────────────────────────────────────
// A hostile creative embeds its own <script data-sharc-prelude="..."> decoy
// trying to shield the real prelude from the selector-based self-removal. The
// real prelude is forced to head.firstChild, so it is document-order-first and
// `querySelector` matches IT, not the decoy. The decoy carries a distinct
// marker (NOT the protocol nonce — a creative can't "harvest" a nonce it
// already knows), so its survival proves the REAL prelude was the one removed.
const LOAD_DECOY_MARKER = '__sharc_load_decoy_marker_268__';
const OMID_DECOY_MARKER = '__sharc_omid_decoy_marker_268__';
const LOAD_DECOY_CREATIVE = '<!DOCTYPE html><html><head></head><body>'
  + '<script data-sharc-prelude="load-probe">window.' + LOAD_DECOY_MARKER + '=1;</script>'
  + '<div id="c">ad</div></body></html>';
const OMID_DECOY_CREATIVE = '<!DOCTYPE html><html><head></head><body>'
  + '<script data-sharc-prelude="omid-shim">window.' + OMID_DECOY_MARKER + '=1;</script>'
  + '<div id="c">ad</div></body></html>';

function scriptWithSourceSubstr(doc, substr) {
  const scripts = doc.scripts || doc.getElementsByTagName('script');
  for (let i = 0; i < scripts.length; i++) {
    if ((scripts[i].textContent || '').indexOf(substr) !== -1) return scripts[i];
  }
  return null;
}

// ── 9. load-probe decoy collision — real prelude removed, decoy survives ────
console.log('\n9. load-probe decoy collision — real prelude is the one removed (both consumption paths)');
{
  const runners = [
    { name: 'document.write', run: (h) => writeAndRun(h, {
      beforeWrite: (w) => {
        const fakeParent = { postMessage: () => {} };
        Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      },
    }) },
    { name: 'DOMParser fallback', run: (h) => parseAndRunFallback(h, {
      beforeRun: (w) => {
        const fakeParent = { postMessage: () => {} };
        Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      },
    }) },
  ];
  for (const r of runners) {
    const env = bootPreludeEnv();
    const html = env.installLoadProbePrelude(
      LOAD_DECOY_CREATIVE, PSID, CONTAINER_ORIGIN, LOAD_NONCE);
    assert(html.indexOf(LOAD_NONCE) !== -1 && html.indexOf(LOAD_DECOY_MARKER) !== -1,
      r.name + ': pre-consumption markup carries both the real nonce and the decoy marker');
    const { doc } = r.run(html);
    assert(!nonceInScripts(doc, LOAD_NONCE),
      r.name + ': the REAL prelude (nonce-carrying) is gone — decoy did not shield it');
    assert(scriptWithSourceSubstr(doc, 'SHARC:Renderer:loadAck') === null,
      r.name + ': no surviving <script> carries the real load-probe prelude source');
    assert(scriptWithSourceSubstr(doc, LOAD_DECOY_MARKER) !== null,
      r.name + ': the decoy <script> survives (querySelector removed the document-order-first REAL prelude)');
  }
}

// ── 10. omid-shim decoy collision — real prelude removed, decoy survives ────
console.log('\n10. omid-shim decoy collision — real prelude is the one removed (both consumption paths)');
{
  const runners = [
    { name: 'document.write', run: (h) => writeAndRun(h, {
      beforeWrite: (w) => {
        const fakeParent = { postMessage: () => {} };
        Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      },
    }) },
    { name: 'DOMParser fallback', run: (h) => parseAndRunFallback(h, {
      beforeRun: (w) => {
        const fakeParent = { postMessage: () => {} };
        Object.defineProperty(w, 'parent', { configurable: true, get: () => fakeParent });
      },
    }) },
  ];
  for (const r of runners) {
    const env = bootPreludeEnv();
    const html = await env.installOmidShimPrelude(
      OMID_DECOY_CREATIVE, OMID_NONCE, PSID, CONTAINER_ORIGIN);
    assert(html.indexOf(OMID_NONCE) !== -1 && html.indexOf(OMID_DECOY_MARKER) !== -1,
      r.name + ': pre-consumption markup carries both the real OMID nonce and the decoy marker');
    const { doc } = r.run(html);
    assert(!nonceInScripts(doc, OMID_NONCE),
      r.name + ': the REAL OMID prelude (nonce-carrying) is gone — decoy did not shield it');
    assert(scriptWithSourceSubstr(doc, OMID_DECOY_MARKER) !== null,
      r.name + ': the decoy <script> survives (querySelector removed the document-order-first REAL prelude)');
  }
}

// ── Done ────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(failures + ' assertion failure(s)');
  process.exit(1);
}
console.log('All prelude nonce self-removal assertions passed.');
