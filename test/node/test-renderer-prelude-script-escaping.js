/**
 * test-renderer-prelude-script-escaping.js — #329 regression.
 *
 * Every prelude the renderer inlines into the creative document
 * (examples/renderer/index.html) must route through ONE shared injector that
 * ALWAYS escapes `</script` in the inline-script body. Without escaping, a
 * prelude `code` string that contains a literal `</script>` token would, when
 * the renderer serializes the prelude <script> via `outerHTML` during
 * `document.write`, emit a real `</script>` that prematurely closes the
 * injected prelude — silently truncating it and dumping the rest as page text.
 *
 * #326 made this load-bearing for the MRAID/SafeFrame compat preludes (they
 * compose `dist/sharc-creative.js`, which carries 5 `</script` tokens inside
 * JSDoc comments). But the OMID shim prelude was injected WITHOUT escaping — it
 * survived only because its current source happens to contain zero `</script`
 * tokens. That is latent fragility: a future shim edit introducing one would
 * silently break prelude injection.
 *
 * #329 extracts a single always-escaping injector and routes ALL preludes
 * (OMID shim, MRAID/SafeFrame compat) through it. (ADR 2026-06-15: the
 * window-path load-probe prelude is RETIRED — the load-probe round-trip rides
 * the surviving port, not a prelude.) This test:
 *
 *   1. UNIT — feeds the shared injector a `code` body that contains a literal
 *      `</script>` token and asserts the serialized output:
 *        - contains the escaped form `<\/script` inside the prelude body,
 *        - contains NO raw `</script` that sits BEFORE the creative markup
 *          (i.e. no token that would close the prelude wrapper early), and
 *        - still parses to exactly ONE injected prelude <script> whose live
 *          textContent carries the full body (token reconstituted by the parser
 *          as the harmless string `</script>` text — not a tag).
 *
 *   2. INTEGRATION (OMID) — stubs the shim fetch to return source containing a
 *      `</script>` token, runs installOmidShimPrelude, document.writes the
 *      result, and asserts the shim STILL installs window.omid3p (equivalent
 *      execution — escaping changed serialization, not behavior).
 *
 * Source-of-truth discipline: the injector + prelude functions are extracted
 * from the shipped renderer file by the same brace-balancer used in
 * test-renderer-prelude-nonce-self-remove.js — never an inlined copy.
 *
 * Runs in Node after `npm run build`. Uses jsdom. No test framework.
 *
 * @see examples/renderer/index.html injectPreludeScript / installOmidShimPrelude
 */

import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

let failures = 0;
function assert(cond, message) {
  if (cond) process.stdout.write('  ✓ ' + message + '\n');
  else { process.stderr.write('  ✗ ' + message + '\n'); failures++; }
}

console.log('test-renderer-prelude-script-escaping.js — #329 single always-escaping injector\n');

const RENDERER_PATH = new URL('../../examples/renderer/index.html', import.meta.url);
const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');

/**
 * Slice a named `function NAME(...) { ... }` (optionally `async`) out of the
 * renderer source by balancing braces from the opening `{`. Mirrors the
 * extractor in test-renderer-prelude-nonce-self-remove.js.
 */
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

const RENDERER_ORIGIN = 'https://renderer.operator.example';
const CONTAINER_ORIGIN = 'https://publisher.example';
const PSID = 'sid-329';
const CREATIVE = '<!DOCTYPE html><html><head></head><body><div id="c">ad</div></body></html>';

// ── Structural assertions: the single shared injector exists and is used ─────
console.log('1. structure — one shared always-escaping injector, every prelude routed through it');
{
  // The shared injector function must exist by name.
  let injectorSrc = null;
  try { injectorSrc = extractFunction(rendererSrc, 'injectPreludeScript'); } catch (_) { /* asserted below */ }
  assert(injectorSrc !== null,
    'renderer defines a shared injectPreludeScript helper');

  // The escaping transform lives in exactly one place (the escape helper), and
  // the shared injector invokes it on the inline body.
  let escapeSrc = null;
  try { escapeSrc = extractFunction(rendererSrc, 'escapeClosingScriptTokens'); } catch (_) { /* asserted below */ }
  assert(escapeSrc !== null && /<\\\/script/.test(escapeSrc),
    'the </script> escape transform lives in escapeClosingScriptTokens');
  assert(injectorSrc !== null && /escapeClosingScriptTokens\s*\(/.test(injectorSrc),
    'the shared injector routes the inline body through the escape transform');

  // The Fallback-suffixed name is gone (it was a misnomer on the primary path).
  assert(!/escapeScriptSourceForFallback/.test(rendererSrc),
    'escapeScriptSourceForFallback has been renamed (no lingering references)');

  // Each prelude builder delegates to the shared injector rather than
  // open-coding its own DOMParser+outerHTML inject/serialize tail. (ADR
  // 2026-06-15: installLoadProbePrelude is retired — the load-probe round-trip
  // rides the surviving port, not a window-message prelude.)
  for (const fn of ['installOmidShimPrelude',
    'installMraidCompatibilityWrapperPrelude', 'installSafeFrameCompatibilityWrapperPrelude']) {
    const body = extractFunction(rendererSrc, fn);
    assert(/injectPreludeScript\s*\(/.test(body),
      fn + ' routes its prelude through the shared injectPreludeScript');
  }
}

// ── 2. UNIT: a </script>-bearing body is escaped, wrapper not closed early ───
console.log('\n2. unit — injector escapes a </script> token in the body');
{
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/',
    runScripts: 'dangerously',
  });
  const win = dom.window;
  win.eval(extractFunction(rendererSrc, 'escapeClosingScriptTokens'));
  win.eval(extractFunction(rendererSrc, 'injectPreludeScript'));

  // A prelude body that, unescaped, would serialize a real </script> and close
  // the wrapper. The substring `</script>` is the exact hazard #326 fixed.
  const HAZARD = '*/ var x = "</script><b>pwned</b>"; /*';
  const body = '(function(){/* ' + HAZARD + ' */ window.__escapeProbe329 = 1;}());';

  const out = win.injectPreludeScript(CREATIVE, 'escape-probe', body);

  // The injected wrapper has exactly ONE legitimate close: its own `</script>`.
  // If the body's `</script>` token were NOT escaped, the serializer would emit
  // a SECOND raw `</script>` inside the body, closing the wrapper early. So the
  // contract is: between the wrapper's opening tag and the creative markup there
  // is exactly ONE raw `</script` (the wrapper's own close), and the body
  // carries the hazard token only in its escaped, inert form.
  const openIdx = out.indexOf('data-sharc-prelude="escape-probe"');
  const creativeIdx = out.indexOf('id="c"');
  assert(openIdx !== -1, 'serialized output contains the injected prelude <script>');
  assert(creativeIdx !== -1 && creativeIdx > openIdx,
    'creative markup follows the injected prelude');
  const between = out.slice(openIdx, creativeIdx);
  const rawCloses = (between.match(/<\/script/gi) || []).length;
  assert(rawCloses === 1,
    'exactly ONE raw </script appears before the creative — the wrapper'
    + ' own close; the body token did NOT add a premature close (got ' + rawCloses + ')');
  assert(/<\\\/script/i.test(between),
    'the escaped form <\\/script is present in the serialized prelude body');

  // And it must parse to exactly one prelude script whose live textContent
  // carries the full body (the parser turns the escaped token back into the
  // harmless literal text `</script>` inside the script body).
  const parsed = new win.DOMParser().parseFromString(out, 'text/html');
  const preludes = parsed.querySelectorAll('script[data-sharc-prelude="escape-probe"]');
  assert(preludes.length === 1, 'exactly one prelude <script> parsed (not split by an early close)');
  // The HTML parser reads the escaped `<\/script>` as inert script text — the
  // backslash is preserved (it is a no-op JS escape at runtime: `<\/script>`
  // executes identically to `</script>`). So the body text carries the escaped
  // form, and crucially the parser did NOT treat it as a closing tag.
  assert(preludes.length === 1 && preludes[0].textContent.indexOf('<\\/script>') !== -1,
    'the prelude body round-trips the </script> token as inert (escaped) text inside the script');
}

// ── 3. UNIT: equivalent execution — escaped body runs unchanged ─────────────
console.log('\n3. unit — the escaped prelude executes identically (document.write)');
{
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/',
    runScripts: 'dangerously',
  });
  const win = dom.window;
  win.eval(extractFunction(rendererSrc, 'escapeClosingScriptTokens'));
  win.eval(extractFunction(rendererSrc, 'injectPreludeScript'));

  const body = '(function(){/* </script> hazard inside comment */ '
    + 'window.__escapeExec329 = "ok";}());';
  const out = win.injectPreludeScript(CREATIVE, 'escape-exec', body);

  const run = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/',
    runScripts: 'dangerously',
  });
  run.window.document.open();
  run.window.document.write(out);
  run.window.document.close();
  assert(run.window.__escapeExec329 === 'ok',
    'the prelude IIFE executed despite the </script> token in its body (no early close)');
  assert(!!run.window.document.getElementById('c'),
    'the creative markup parsed intact after the escaped prelude');
}

// ── 4. INTEGRATION (OMID): shim source carrying </script> still installs ─────
console.log('\n4. integration — installOmidShimPrelude escapes a </script>-bearing shim source');
{
  const virtualConsole = new VirtualConsole();
  ['log', 'info', 'warn', 'error', 'debug'].forEach((l) => virtualConsole.on(l, () => {}));
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/',
    runScripts: 'dangerously',
    virtualConsole,
  });
  const win = dom.window;

  // Real built shim source, with a benign comment carrying a </script> token
  // appended — proves the OMID path stays correct even if a future shim edit
  // introduces one. The token sits inside a line comment so it is inert JS.
  const SHIM_PATH = new URL('../../dist/sharc-omid-shim.js', import.meta.url);
  const shimSource = fs.readFileSync(SHIM_PATH, 'utf8')
    + '\n// edge: a </script> token sneaks into the shim source\n';
  const shimUrl = RENDERER_ORIGIN + '/dist/sharc-omid-shim.js';

  win.fetch = async (u) => {
    if (String(u).indexOf('sharc-omid-shim.js') !== -1) {
      return { ok: true, status: 200, text: async () => shimSource };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  win.eval('this.fetch = window.fetch;');
  win.eval('var RENDERER_CONFIG = { TEST_ONLY: true, OMID_SHIM_URL: '
    + JSON.stringify(shimUrl) + ' };');
  win.eval(extractFunction(rendererSrc, 'jsonForInlineScript'));
  win.eval(extractFunction(rendererSrc, 'escapeClosingScriptTokens'));
  win.eval(extractFunction(rendererSrc, 'injectPreludeScript'));
  win.eval(extractFunction(rendererSrc, 'installOmidShimPrelude'));

  const OMID_NONCE = 'omid-nonce-329';
  const out = await win.installOmidShimPrelude(CREATIVE, OMID_NONCE, PSID, CONTAINER_ORIGIN);

  // The serialized prelude must not close early: no raw </script before creative.
  const openIdx = out.indexOf('data-sharc-prelude="omid-shim"');
  const creativeIdx = out.indexOf('id="c"');
  assert(openIdx !== -1 && creativeIdx > openIdx,
    'omid-shim prelude precedes the creative markup');
  // Exactly ONE raw </script before the creative — the wrapper's own close. The
  // </script> token planted in the shim source must have been escaped (else a
  // second raw </script would close the prelude early).
  const omidCloses = (out.slice(openIdx, creativeIdx).match(/<\/script/gi) || []).length;
  assert(omidCloses === 1,
    'exactly ONE raw </script (wrapper close) before the creative — the shim'
    + ' </script> token was escaped (got ' + omidCloses + ')');

  // document.write it and assert the shim still installs window.omid3p.
  const run = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: RENDERER_ORIGIN + '/0.7.0/',
    runScripts: 'dangerously',
    virtualConsole,
  });
  const fakeParent = { postMessage: () => {} };
  Object.defineProperty(run.window, 'parent', { configurable: true, get: () => fakeParent });
  run.window.document.open();
  run.window.document.write(out);
  run.window.document.close();
  assert(run.window.omid3p
    && typeof run.window.omid3p.registerSessionObserver === 'function',
    'window.omid3p installed (shim executed intact despite the </script> token)');
}

// NOTE (ADR 2026-06-15): the load-probe integration case (formerly 5) is
// RETIRED with the window-path `installLoadProbePrelude`. The load-probe
// round-trip is carried over the surviving `port2` and never builds a
// window-message prelude, so there is no escaping-injector path to exercise for
// it. The OMID integration case (4) covers the shared-injector contract.

// ── Done ────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(failures + ' assertion failure(s)');
  process.exit(1);
}
console.log('All prelude script-escaping assertions passed.');
