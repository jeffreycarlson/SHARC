/**
 * test-lifecycle-conjunction-gate.js — Slice A GREEN structural regression-guard
 * (node tier, STRUCTURAL).
 *
 * PRIMARY structural proof for "conjunction, not timer" (ADR
 * 2026-06-13-sharc-unified-lifecycle-ordering.md §5.2 step 2, HB-3, R-1):
 *
 *   The container MUST trigger `initChannel` (the createSession handshake) FROM
 *   the render-signal handler (the iframe `load` handler on the URL path; the
 *   `:rendered`-accept handler `_onRendererRendered` on the Markup path), with
 *   NO fixed wall-clock delay — `setTimeout(…, <constant ms>)` — on the success
 *   path between the render signal and `initChannel`. The handshake is
 *   event-driven, gated on the `creative-rendered ∧ env-ready` signal, not on a
 *   200ms clock.
 *
 * WHY STRUCTURAL, NOT TIMED: a `(t[initChannel] − t[render-signal]) < Nms`
 * assertion is a test-surface proxy — it flakes on throttled CI runners and
 * low-end devices, and it is a wall-clock gate measuring the absence of a
 * wall-clock gate. The contract is "no fixed delay on the success path," which
 * is provable by STATIC INSPECTION of the source: zero timing involved, zero
 * flake surface. This test reads `src/sharc-container.js` and proves the timer
 * is present on the path between each render signal and its `initChannel` call.
 *
 * GREEN since Slice A landed: both success paths now fire `initChannel`
 * directly off the render signal (the URL path from the iframe-`load` handler,
 * the Markup path from `_onRendererRendered`), with NO `setTimeout(…, <number>)`
 * wrapping it. This guards against a regression that reintroduces a happy-path
 * wall-clock gate (§5.0: the success path is event-driven; no replacement timer
 * may "wait for" a signal an event already provides). The develop step that
 * makes this green fires `initChannel` synchronously, on a microtask, or on any
 * non-clock task — anything but a fixed `setTimeout(…,ms)`.
 *
 * Tier: NODE (static source analysis — no jsdom, no DOM, no timers). The
 * structural form needs no runtime; it inspects the shipped source text.
 * CI-gated via `npm run test:lifecycle-conjunction-gate` in test:all:built.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../../src/sharc-container.js');
const source = readFileSync(SRC, 'utf8');

let failures = 0;
function assert(cond, message, diag) {
  if (cond) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    if (diag) console.error('   ', diag);
    failures++;
  }
}

/**
 * Lex `source` from offset `start` and return the offset just past the matching
 * close of the FIRST `(` at/after `start`, with string/comment/regex awareness
 * so a `)` inside a literal does not end the call early. Used to bound a
 * `setTimeout( … )` call's argument list precisely. Returns -1 if no balanced
 * close is found.
 */
function endOfCall(src, start) {
  let i = src.indexOf('(', start);
  if (i < 0) return -1;
  let depth = 0;
  let mode = 'code'; // 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block'
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'sq') { if (c === '\\') { i++; continue; } if (c === "'") mode = 'code'; continue; }
    if (mode === 'dq') { if (c === '\\') { i++; continue; } if (c === '"') mode = 'code'; continue; }
    if (mode === 'tpl') { if (c === '\\') { i++; continue; } if (c === '`') mode = 'code'; continue; }
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { i++; mode = 'code'; } continue; }
    // code mode
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === "'") { mode = 'sq'; continue; }
    if (c === '"') { mode = 'dq'; continue; }
    if (c === '`') { mode = 'tpl'; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** 1-based line number for a character offset. */
function lineAt(offset) {
  return source.slice(0, offset).split('\n').length;
}

/**
 * Find the SUCCESS-PATH `initChannel` call reachable from `anchorLabel` (a
 * unique source landmark for a render-signal handler) and report whether a
 * fixed-delay `setTimeout(…, <number>)` wraps it on that path.
 *
 * Returns { handlerLine, initChannelLine, timerLine, timerMs } where timerMs is
 * the numeric delay if `initChannel` sits inside a `setTimeout(fn, <number>)`
 * whose call-span contains the `initChannel` offset, else null.
 */
function analyzeSuccessPath(anchorRegex, anchorName) {
  const anchorIdx = source.search(anchorRegex);
  if (anchorIdx < 0) {
    return { found: false, anchorName };
  }
  // The `initChannel` call on this success path is the first `initChannel(`
  // at/after the anchor. Both arm sites place exactly one `initChannel` call
  // immediately after their render signal.
  const icIdx = source.indexOf('initChannel(', anchorIdx);
  if (icIdx < 0) return { found: true, anchorName, initChannelLine: null };

  // Scan every `setTimeout(` between the anchor and the initChannel call (plus
  // a small lookback, since the timer keyword precedes its callback body which
  // contains initChannel). A fixed-delay timer GATES the path iff its balanced
  // call-span contains the initChannel offset AND its final argument is a
  // numeric literal delay.
  let timerLine = null;
  let timerMs = null;
  let searchFrom = source.lastIndexOf('setTimeout', icIdx);
  // Walk backwards through candidate setTimeout calls whose span might enclose
  // icIdx (closest-enclosing first).
  while (searchFrom >= anchorIdx - 4000 && searchFrom >= 0) {
    const stIdx = source.indexOf('setTimeout', searchFrom);
    if (stIdx < 0 || stIdx > icIdx) break;
    const end = endOfCall(source, stIdx);
    if (end > icIdx) {
      // This setTimeout's argument list encloses the initChannel call.
      const callText = source.slice(stIdx, end);
      // Last numeric literal argument = the wall-clock delay (e.g. `, 200`).
      const m = callText.match(/,\s*(\d+)\s*\)\s*;?\s*$/);
      if (m) {
        timerLine = lineAt(stIdx);
        timerMs = Number(m[1]);
        break;
      }
    }
    searchFrom = stIdx - 10;
    if (searchFrom < 0) break;
    searchFrom = source.lastIndexOf('setTimeout', searchFrom);
  }

  return {
    found: true,
    anchorName,
    handlerLine: lineAt(anchorIdx),
    initChannelLine: lineAt(icIdx),
    timerLine,
    timerMs,
  };
}

console.log('test-lifecycle-conjunction-gate.js — Slice A GREEN regression-guard '
  + '(node tier, STRUCTURAL)\n');

console.log('T4 (R-1 / HB-3) — initChannel is invoked event-driven from the '
  + 'render-signal handler,\n   with NO fixed wall-clock setTimeout(…,ms) on the '
  + 'success path (no 200ms timer)');

// ── URL path: render signal = the iframe `load` handler ────────────────────
{
  const r = analyzeSuccessPath(
    /Phase E deliverable 1: arm the load-event navigation backstop/,
    'URL path (iframe `load` handler)',
  );

  // Sanity (positive control): the landmark + the success-path initChannel call
  // both exist, so a RED below is a real contract failure, not a stale-anchor
  // typo. If these flip, the structural probe lost its mooring — fix the anchor.
  assert(r.found, 'URL: render-signal handler landmark located in source',
    `searched for the iframe-load backstop-arming handler in ${SRC}`);
  assert(Number.isInteger(r.initChannelLine),
    'URL: a success-path initChannel call exists after the render signal',
    `handler@${r.handlerLine} initChannel@${r.initChannelLine}`);

  // CONTRACT: no fixed-delay setTimeout between the render signal and
  // initChannel. On regression — the call would be wrapped in setTimeout(…,200).
  assert(r.timerMs === null,
    'URL: NO fixed wall-clock setTimeout(…,ms) gates the success path between '
      + 'the iframe-load render signal and initChannel — the handshake is '
      + 'event-driven',
    r.timerMs !== null
      ? `handshake invoked via setTimeout(…,${r.timerMs}) at sharc-container.js:${r.timerLine} `
        + `(wrapping initChannel@${r.initChannelLine}) — the success path must be event-driven, `
        + `gated on the render signal, not a ${r.timerMs}ms wall-clock`
      : undefined);
}

// ── Markup path: render signal = `_onRendererRendered` (`:rendered` accept) ─
{
  const r = analyzeSuccessPath(
    /_onRendererRendered\s*\(\s*\)\s*\{/,
    'Markup path (`_onRendererRendered` / `:rendered` accept)',
  );

  assert(r.found, 'Markup: render-signal handler (_onRendererRendered) located in source',
    `searched for _onRendererRendered() in ${SRC}`);
  assert(Number.isInteger(r.initChannelLine),
    'Markup: a success-path initChannel call exists after the `:rendered` accept',
    `handler@${r.handlerLine} initChannel@${r.initChannelLine}`);

  // CONTRACT: no fixed-delay setTimeout between the `:rendered` accept and
  // initChannel. On regression — the call would be wrapped in setTimeout(…,200).
  assert(r.timerMs === null,
    'Markup: NO fixed wall-clock setTimeout(…,ms) gates the success path between '
      + 'the `:rendered` render signal and initChannel — the handshake is '
      + 'event-driven',
    r.timerMs !== null
      ? `handshake invoked via setTimeout(…,${r.timerMs}) at sharc-container.js:${r.timerLine} `
        + `(wrapping initChannel@${r.initChannelLine}) — the success path must be event-driven, `
        + `gated on the :rendered signal, not a ${r.timerMs}ms wall-clock`
      : undefined);
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILING assertion(s)'} `
  + '— Slice A conjunction-gate contract (structural)');
if (failures > 0) {
  console.log('\nNOTE: a failure here means a happy-path wall-clock gate was reintroduced '
    + 'between the render signal and initChannel (§5.0 forbids it — the success path is '
    + 'event-driven). Fire initChannel directly off the render signal (synchronously, a '
    + 'microtask, or a non-clock task), never via setTimeout(…,ms). No assertion here rests '
    + 'on a wall-clock measurement — the proof is purely structural (source inspection).');
}
process.exit(failures === 0 ? 0 : 1);
