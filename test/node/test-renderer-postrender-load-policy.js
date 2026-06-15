/**
 * test-renderer-postrender-load-policy.js — issue #321 (reframed), Decision 2.
 *
 * ADR: ~/Obsidian/dev-team/sharc/2026-06-06-renderer-lifecycle-readiness-compat-creatives.md
 *
 * POST-RENDER SECOND-LOAD POLICY (ADR Decision 2).
 *
 * Once Decision 1's idempotency guard routes every post-render iframe `load`
 * exclusively to the navigation backstop (`_armRendererBackstop`), the
 * backstop's loadProbe/loadAck round-trip is the decision point:
 *
 *   - TOLERATED: a legitimate same-origin document.open()+write() reopen
 *     re-injects the renderer prelude, which ANSWERS the loadProbe with a
 *     :loadAck → no 2118, container survives.
 *   - FLAGGED: a cross-document navigation cannot answer (different document,
 *     no prelude) → loadProbe deadline expires → RENDERER_UNAUTHORIZED_NAVIGATION
 *     (2118).
 *
 * This is the narrowly-scoped, correct version of #321's "API-specific"
 * instinct: applied to post-render NAVIGATION policy, not renderer READINESS.
 *
 * NODE-RUNNABLE: yes for the FLAGGED (2118) direction — the loadProbe deadline
 * + silence is fully expressible in jsdom and reflects current shipped
 * behavior (this assertion is GREEN today, it regression-protects Decision 2's
 * flagged half).
 *
 * The TOLERATED (ack'd reopen) direction is RED today because it is BLOCKED BY
 * THE SAME re-entry bug as test-renderer-load-reentry.js: today the re-armed
 * rendererReply kills the container even when the reopen is ack'd. Decision 1's
 * guard is the prerequisite; this file pins the policy contract that Decision 1
 * unblocks. (The tolerated assertion is the primary contract pin shared with
 * test (a); duplicated here so the policy contract reads as one unit.)
 *
 * Run after `npm run build`.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';
const RENDERER_URL = 'https://renderer.operator.example/0.7.0/';
const RENDERER_ORIGIN = 'https://renderer.operator.example';
const CREATIVE_HTML = '<html><body>ad</body></html>';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: PUBLISHER_ORIGIN + '/page.html',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else { console.error('  ✗', message); failures++; }
}

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The gate nonce a re-injected prelude would answer with for the CURRENT
// generation. C1 fresh-nonce-per-generation: after a post-render load the gate
// requires the staged next-generation (reverse-chain) nonce; before any load it
// is the current nonce. Mirrors what the renderer's chain produces.
function expectedGateNonce(c) {
  const entry = c.protocolRouter._protocols.get('SHARC:Renderer:');
  if (entry && entry._nextNonce) return entry._nextNonce; // simulate a reopen (next-gen nonce); the gate also accepts current
  return entry ? entry.protocolNonce : c._rendererProtocolNonce;
}

// Answers the most-recently-armed loadProbe by dispatching an authentic
// :loadAck envelope through the router (source/origin/nonce/placementSessionId
// match — exactly what a re-injected renderer prelude would post for the
// current generation).
function answerLoadProbe(c) {
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:loadAck',
      placementSessionId: c.placementSessionId,
      sharcNonce: expectedGateNonce(c),
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
}

async function rendered() {
  const errors = [];
  const securityEvents = [];
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    timeouts: { rendererLoad: 5000, rendererReply: 150 },
    onError: (code, msg) => errors.push({ code, msg }),
    onSecurityEvent: (ev) => securityEvents.push(ev),
  });
  c.load();
  await c.protocolRouter.ready('SHARC:Renderer:');
  c._iframe.contentWindow.postMessage = () => {};
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
  return { c, errors, securityEvents };
}

console.log('test-renderer-postrender-load-policy.js — #321 reframed, Decision 2\n');

// ────────────────────────────────────────────────────────────────────────────
// FLAGGED: a cross-document navigation (probe goes UNANSWERED) → 2118.
// This is current shipped behavior; it regression-protects the flagged half of
// the policy so Decision 1's guard does not accidentally suppress genuine
// post-render navigation detection.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('1. Cross-document post-render navigation (unanswered probe) → 2118 (FLAGGED)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // Second load with NO loadAck — a cross-document navigation has no prelude to
  // answer the probe. The 100ms backstop deadline must fire 2118.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  await sleep(300);

  const got2118 = errors.some((e) =>
    e.code === protoMod.ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION)
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(got2118,
    'unanswered post-render load is flagged RENDERER_UNAUTHORIZED_NAVIGATION (2118)');
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// TOLERATED: an ack'd same-origin reopen must NOT terminate.
// RED today — blocked by the re-entry bug (Decision 1). Pins the policy
// contract Decision 1 unblocks.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n2. Ack\'d same-origin reopen is tolerated — no fatal (TOLERATED; RED until Decision 1)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // Reopen re-injected the prelude → it answers the probe with the current
  // generation's (post-load: fresh) gate nonce.
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:loadAck',
      placementSessionId: c.placementSessionId,
      sharcNonce: expectedGateNonce(c),
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
  await sleep(300);

  const anyFatal = errors.length > 0
    || securityEvents.some((e) =>
      e.type === 'unauthorized_navigation' || e.type === 'renderer_protocol_error');
  assert(!anyFatal,
    'ack\'d same-origin reopen produces no fatal error (neither 2118 nor 2114)');
  assert(c._terminated !== true,
    'container survives an ack\'d same-origin reopen');
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Reduction #1: a SECOND post-render same-frame reopen whose prelude
// answers :loadAck must keep the container alive and emit a NON-terminating
// `renderer_load_observed` diagnostic.
//
// RED on main: the subsequent-load branch (`:4542`) fires 2118 UNCONDITIONALLY
// — the second load never gets a probe/ack round-trip, so it terminates.
// GREEN after fix: every post-render load runs the controlled-context gate;
// answered ⇒ keep-alive + `renderer_load_observed`.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n3. Second answered reopen → keep-alive + renderer_load_observed (Phase 1; RED on main)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // First post-render load — answered.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  answerLoadProbe(c);
  await sleep(150);
  assert(c._terminated !== true, 'survives first answered reopen');

  // Second post-render load — also answered. This is the corpus pattern.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  answerLoadProbe(c);
  await sleep(300);

  const got2118 = errors.some((e) =>
    e.code === protoMod.ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION)
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(!got2118, 'no 2118 on a second ANSWERED reopen');
  assert(c._terminated !== true, 'container survives a second answered reopen');

  const observed = securityEvents.filter((e) => e.type === 'renderer_load_observed');
  assert(observed.length >= 1,
    'emits non-terminating renderer_load_observed for the kept-alive load');
  if (observed.length >= 1) {
    const ev = observed[observed.length - 1];
    assert(typeof ev.details?.msSinceRender === 'number',
      'renderer_load_observed carries details.msSinceRender');
    assert(typeof ev.details?.loadKind === 'string',
      'renderer_load_observed carries a details.loadKind hint');
    assert(ev.errorCode === undefined,
      'renderer_load_observed is non-terminating (no errorCode)');
    assert(ev.details?.code === protoMod.ErrorCodes.RENDERER_LOAD_OBSERVED,
      'renderer_load_observed carries details.code === 2121 for numeric telemetry symmetry (NOT promoted to top-level errorCode)');
  }
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// 2118 DIAGNOSTIC SPLIT (do-not-delete-2118): a subsequent load whose probe is
// UNANSWERED still terminates with unauthorized_navigation / 2118.
// GREEN both ways — pins that the genuinely-fatal lost-control case survives the
// split. The narrowed 2118 must still fire for lost control.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n4. Subsequent UNANSWERED reopen still terminates 2118 (lost control; split-guard)');
  const { c, errors, securityEvents } = await rendered();
  assert(c.creativeRendered === true, 'precondition: rendered');

  // First post-render load — answered, ad kept alive.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  answerLoadProbe(c);
  await sleep(150);
  assert(c._terminated !== true, 'survives first answered reopen');

  // Second post-render load — NO ack (controlled document replaced by an
  // uncontrolled external webpage with no prelude). Must terminate.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // 100ms probe deadline + _handleFatalError's async sendFatalError tail; the
  // stubbed protocol channel falls back to the 1s force-terminate, so wait past
  // it to observe the terminal flag deterministically.
  await sleep(1200);

  const got2118 = errors.some((e) =>
    e.code === protoMod.ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION)
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(got2118,
    'unanswered subsequent reopen still terminates unauthorized_navigation/2118');
  assert(c._terminated === true, 'lost-control subsequent load terminates the container');
  if (!c._terminated) c._terminate();
}

// ────────────────────────────────────────────────────────────────────────────
// URL VARIANT (fail-closed) — Phase 1 changes NOTHING for the Creative URL
// variant. A plain creative-URL document has no SHARC prelude to answer a
// probe, so `_armRendererBackstop()` is armed WITHOUT `verifyFirstLoad`
// (gateEveryLoad === false). In that branch the backstop never runs a
// probe/ack round-trip: any subsequent post-render load terminates IMMEDIATELY
// with 2118 unauthorized_navigation (fail-closed). The gate-every-load model
// (sections 3–4 above) is Markup-only; this section pins that the URL branch's
// pre-existing fail-closed contract is untouched by Phase 1.
//
// The policy file's `rendered()` helper builds Markup-variant containers only,
// so this section uses its own URL-variant harness (mirrors `buildPostUrlLoad`
// in test-creative-sources-load.js section 18): a `creativeUrl` container whose
// first iframe `load` arms the backstop without verifyFirstLoad, exercising the
// `gateEveryLoad === false` path directly in this policy-focused file.
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n5. URL variant: subsequent post-render load terminates 2118 immediately (fail-closed; gateEveryLoad === false)');
  const errors = [];
  const securityEvents = [];
  const c = new SHARCContainer({
    creativeUrl: 'https://ads.example/creative.html',
    placementElement: freshSlot(),
    onError: (code, msg) => errors.push({ code, msg }),
    onSecurityEvent: (ev) => securityEvents.push(ev),
  });
  c.load();
  // URL variant wires MessageChannel 200ms after load into the real
  // contentWindow; stub postMessage so that deferral is inert under test.
  c._iframe.contentWindow.postMessage = () => {};
  // First iframe load: the URL variant's load listener arms the backstop
  // synchronously WITHOUT verifyFirstLoad ⇒ gateEveryLoad === false.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  await sleep(10);

  assert(c.creativeSource === 'url',
    'precondition: URL variant (creativeSource === "url")');
  assert(typeof c._rendererBackstopHandler === 'function',
    'precondition: backstop armed after first URL-variant load');

  // Second post-render load. No loadProbe is posted for the URL variant — the
  // backstop's gateEveryLoad === false branch fires 2118 directly.
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  // Slice A (ADR 2026-06-13 §5.2) wires the protocol transport synchronously at
  // the render anchor (event-driven handshake, no 200ms timer), so by the 2118
  // fire `sendFatalError` posts into the no-op-stubbed creative and its ack
  // never arrives — `_terminate` fires via the deterministic 1s force-terminate
  // net in `_handleFatalError`. Poll the observable signal rather than a fixed
  // sub-second clock.
  for (let i = 0; i < 600 && !c._terminated; i++) await sleep(5);

  const got2118 = errors.some((e) =>
    e.code === protoMod.ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION)
    || securityEvents.some((e) => e.type === 'unauthorized_navigation');
  assert(got2118,
    'URL variant subsequent post-render load terminates 2118 (fail-closed, no probe)');
  assert(c._terminated === true,
    'URL variant container terminates on the subsequent load (gateEveryLoad === false path)');
  // Meaningfulness pin: a probe/ack round-trip was NOT used — no pending probe
  // and the per-cycle latch was never touched, distinguishing the fail-closed
  // URL path from the Markup gate-every-load path (sections 3–4).
  assert(c._pendingLoadProbe == null,
    'URL variant never armed a loadProbe (no controlled-context gate on this branch)');
  const navEvent = securityEvents.find((e) => e.type === 'unauthorized_navigation');
  assert(navEvent && navEvent.details && navEvent.details.variant === 'url',
    'URL variant 2118 carries details.variant === "url" (distinct from Markup gate path)');
  if (!c._terminated) c._terminate();
}

if (failures === 0) {
  console.log('\n✓ All post-render-load-policy assertions passed.');
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} post-render-load-policy assertion(s) failed.`);
  process.exit(1);
}
