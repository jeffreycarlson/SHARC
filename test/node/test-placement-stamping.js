/**
 * test-placement-stamping.js — issue #40 regression coverage
 *
 * Real-construction tests for SHARCContainer's placement-element surface.
 * Uses jsdom to provide window/document/HTMLElement so each test calls
 * `new SHARCContainer({...})` for real — not via Object.create stubs.
 *
 * Covers (proposal Parts 1, 2, 4, 5, 7):
 *   - Legacy `containerEl` constructor key throws
 *   - Required-args validation (creativeUrl, placementElement)
 *   - placementSessionId is a UUID v4 and unique per instance
 *   - placementId / placementName round-trip from constructor → instance
 *   - sessionId getter is null until handshake completes
 *   - Isolation guard fires synchronously at construction (Part 7)
 *   - _attachToPlacement stamps placement element + iframe per Part 4
 *   - _stampState writes data-sharc-state on the placement element
 *   - _stampIntent writes intent / removeAttribute on null
 *   - Cleanup invariant: outerHTML byte-identical pre-attach vs post-detach
 *     (LOAD-BEARING — proposal "load-bearing cleanup contract")
 *
 * Runs in Node after `npm run build`. No browser, no test framework.
 */

import { JSDOM } from 'jsdom';

// ── Set up DOM globals BEFORE importing SHARCContainer. ───────────────────
// The constructor reaches into document.referrer / window.top.location.href
// via _derivePublisherContext(); _attachToPlacement uses real classList /
// setAttribute / outerHTML semantics that only jsdom (or a real browser)
// implements faithfully.
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: 'https://publisher.example/page.html', referrer: 'https://search.example/' },
);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;

// The bundled `dist/sharc-container.mjs` resolves SHARCContainerProtocol via
// either CommonJS `require('./sharc-protocol')` or `window.SHARC.Protocol`.
// In Node ESM neither path resolves automatically, so pre-load the protocol
// exports onto window.SHARC.Protocol before importing the container bundle.
const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../dist/sharc-container.mjs');

// ── Tiny assertion harness ────────────────────────────────────────────────
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}
function assertThrows(fn, msgPattern, message) {
  try {
    fn();
    console.error('  ✗', message, '(no throw)');
    failures++;
  } catch (e) {
    if (msgPattern && !String(e.message).match(msgPattern)) {
      console.error('  ✗', message, `(threw, wrong message: ${e.message})`);
      failures++;
    } else {
      console.log('  ✓', message);
    }
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────
function freshSlot(initialAttrs) {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  if (initialAttrs) {
    for (const [k, v] of Object.entries(initialAttrs)) el.setAttribute(k, v);
  }
  document.body.appendChild(el);
  return el;
}
function baseOptions(overrides) {
  return {
    creativeUrl: 'https://ads.example/creative.html',
    placementElement: freshSlot(),
    ...overrides,
  };
}

console.log('test-placement-stamping.js — issue #40 regression\n');

// -- 1. Required-args validation ───────────────────────────────────────────
{
  console.log('1. Required-args validation');
  assertThrows(
    () => new SHARCContainer({ placementElement: freshSlot() }),
    /creativeUrl is required/,
    'missing creativeUrl throws',
  );
  assertThrows(
    () => new SHARCContainer({ creativeUrl: 'https://x' }),
    /placementElement is required/,
    'missing placementElement throws',
  );
}

// -- 2. Legacy `containerEl` key rejection (B1 of pre-1.0 clean-break policy) ──
{
  console.log('\n2. Legacy `containerEl` key rejection');
  assertThrows(
    () => new SHARCContainer({ creativeUrl: 'https://x', containerEl: freshSlot() }),
    /containerEl.*placementElement/i,
    'containerEl key throws with migration hint',
  );
}

// -- 3. placementSessionId always present, UUID-shaped, unique ──────────────
{
  console.log('\n3. placementSessionId always present and unique');
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ids = new Set();
  let allString = true;
  let allUuid = true;
  for (let i = 0; i < 100; i++) {
    const c = new SHARCContainer(baseOptions());
    if (typeof c.placementSessionId !== 'string') allString = false;
    if (!uuidV4.test(c.placementSessionId)) allUuid = false;
    ids.add(c.placementSessionId);
  }
  assert(allString, 'placementSessionId is a string across 100 runs');
  assert(allUuid, 'placementSessionId matches UUID v4 pattern across 100 runs');
  assert(ids.size === 100, '100 generated placementSessionIds are all unique');
}

// -- 4. placementId / placementName constructor round-trip ──────────────────
{
  console.log('\n4. placementId / placementName round-trip');
  const c = new SHARCContainer(baseOptions({
    placementId: '/12345/sports/scoreboard',
    placementName: 'sidebar',
  }));
  assert(c.placementId === '/12345/sports/scoreboard',
    'placementId round-trips constructor → instance');
  assert(c.placementName === 'sidebar',
    'placementName round-trips constructor → instance');

  const cNone = new SHARCContainer(baseOptions());
  assert(cNone.placementId === null,
    'placementId defaults to null when option omitted');
  assert(cNone.placementName === null,
    'placementName defaults to null when option omitted');
}

// -- 5. sessionId getter ───────────────────────────────────────────────────
{
  console.log('\n5. sessionId getter');
  const c = new SHARCContainer(baseOptions());
  assert(c.sessionId === null,
    'sessionId is null before handshake completes');

  // Mutate the protocol's sessionId and confirm the getter passes through.
  c._protocol.sessionId = 'creative-uuid-123';
  assert(c.sessionId === 'creative-uuid-123',
    'sessionId reflects protocol sessionId once populated');
}

// -- 6. Isolation guard — synchronous throw at construction (Part 7) ───────
{
  console.log('\n6. Isolation guard at construction');
  const slot = freshSlot();
  const c1 = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: slot,
  });
  c1._iframe = document.createElement('iframe');
  c1._attachToPlacement();

  // Now slot has class="sharc-placement" and SHARC data attrs.
  assertThrows(
    () => new SHARCContainer({
      creativeUrl: 'https://ads.example/c.html',
      placementElement: slot,
    }),
    /already owned/i,
    'second SHARCContainer on same element throws synchronously at construction',
  );

  c1._detachFromPlacement();
  // After detach, the same element should be reusable.
  let secondConstructionOk = false;
  try {
    const c2 = new SHARCContainer({
      creativeUrl: 'https://ads.example/c.html',
      placementElement: slot,
    });
    secondConstructionOk = !!c2;
  } catch (e) { /* swallow */ }
  assert(secondConstructionOk,
    'after detach, the same element is reusable (no false positive)');
}

// -- 7. Attach stamps placement element correctly (Part 4) ─────────────────
{
  console.log('\n7. Attach stamps placement element per Part 4');
  const c = new SHARCContainer(baseOptions({
    placementId: 'slot-001',
    placementName: 'sidebar',
  }));
  c._iframe = document.createElement('iframe');
  c._attachToPlacement();

  const el = c.placementElement;
  assert(el.classList.contains('sharc-placement'),
    'class="sharc-placement" applied');
  assert(el.getAttribute('data-sharc-placement-session-id') === c.placementSessionId,
    'data-sharc-placement-session-id stamped with UUID');
  assert(el.getAttribute('data-sharc-placement-id') === 'slot-001',
    'data-sharc-placement-id stamped from option');
  assert(el.getAttribute('data-sharc-placement-name') === 'sidebar',
    'data-sharc-placement-name stamped from option');
  assert(el.hasAttribute('data-sharc-version'),
    'data-sharc-version stamped');
  assert(el.getAttribute('data-sharc-state') === 'loading',
    'data-sharc-state="loading" stamped at attach (initial state)');
  assert(!el.hasAttribute('data-sharc-intent'),
    'data-sharc-intent NOT stamped at attach (no active intent)');
}

// -- 8. Attach stamps iframe correctly (Part 4) ────────────────────────────
{
  console.log('\n8. Attach stamps iframe per Part 4');
  const c = new SHARCContainer(baseOptions());
  c._iframe = document.createElement('iframe');
  c._attachToPlacement();
  assert(c._iframe.classList.contains('sharc-creative'),
    'iframe gets class="sharc-creative"');
  assert(c._iframe.getAttribute('data-sharc-placement-session-id') === c.placementSessionId,
    'iframe gets data-sharc-placement-session-id back-pointer');
  // The non-spec data-sharc-creative="" attribute should NOT be present.
  assert(!c._iframe.hasAttribute('data-sharc-creative'),
    'iframe does NOT have non-spec data-sharc-creative="" attribute');
}

// -- 9. _stampState writes to placement element ────────────────────────────
{
  console.log('\n9. _stampState writes to placement element');
  const c = new SHARCContainer(baseOptions());
  c._iframe = document.createElement('iframe');
  c._attachToPlacement();

  c._stampState('active');
  assert(c.placementElement.getAttribute('data-sharc-state') === 'active',
    '_stampState updates placement element');
  // And NOT the iframe.
  assert(c._iframe.getAttribute('data-sharc-state') === null,
    '_stampState does NOT write to iframe');
}

// -- 10. _stampIntent — writes when set, removeAttribute on null ───────────
{
  console.log('\n10. _stampIntent semantics');
  const c = new SHARCContainer(baseOptions());
  c._iframe = document.createElement('iframe');
  c._attachToPlacement();

  c._stampIntent('expand');
  assert(c.placementElement.getAttribute('data-sharc-intent') === 'expand',
    '_stampIntent writes data-sharc-intent="expand"');

  c._stampIntent(null);
  assert(!c.placementElement.hasAttribute('data-sharc-intent'),
    '_stampIntent(null) REMOVES the attribute (not sets it to "")');

  c._stampIntent('fullscreen');
  assert(c.placementElement.getAttribute('data-sharc-intent') === 'fullscreen',
    '_stampIntent re-applies after a removal');
}

// -- 11. LOAD-BEARING: outerHTML byte-equality pre-attach vs post-detach ───
//
// Per proposal lines 680-698: "After `container.close()` completes, the
// placement element MUST be byte-identical to its pre-`load()` state…"
// This is the named load-bearing invariant of issue #40 / 0.6.0.
{
  console.log('\n11. LOAD-BEARING cleanup invariant — outerHTML byte-equality');

  // Case 11a: bare element (no class, no style attrs).
  {
    const c = new SHARCContainer(baseOptions({
      placementId: 'slot-001',
      placementName: 'sidebar',
    }));
    const before = c.placementElement.outerHTML;
    c._iframe = document.createElement('iframe');
    c._attachToPlacement();
    c._stampState('active');
    c._stampIntent('expand');
    c._stampState('passive');
    c._stampIntent(null);
    c._detachFromPlacement();
    assert(c.placementElement.outerHTML === before,
      'bare element: outerHTML byte-equal pre-attach vs post-detach');
    if (c.placementElement.outerHTML !== before) {
      console.error('    before:', JSON.stringify(before));
      console.error('    after :', JSON.stringify(c.placementElement.outerHTML));
    }
  }

  // Case 11b: element with publisher class + inline style.
  {
    const c = new SHARCContainer({
      creativeUrl: 'https://ads.example/c.html',
      placementElement: freshSlot({
        class: 'pub-class another-class',
        style: 'background: red; padding: 10px;',
      }),
    });
    const before = c.placementElement.outerHTML;
    c._iframe = document.createElement('iframe');
    c._attachToPlacement();
    c._stampState('active');
    c._stampIntent('resize');
    // Simulate the close-button mutation: SHARC writes style.position.
    c.placementElement.style.position = 'relative';
    c._stampIntent(null);
    c._detachFromPlacement();
    assert(c.placementElement.outerHTML === before,
      'element with publisher class + style: byte-equal pre-attach vs post-detach');
    if (c.placementElement.outerHTML !== before) {
      console.error('    before:', JSON.stringify(before));
      console.error('    after :', JSON.stringify(c.placementElement.outerHTML));
    }
  }

  // Case 11c: element with empty class="" attribute (preserve as-is).
  {
    const c = new SHARCContainer({
      creativeUrl: 'https://ads.example/c.html',
      placementElement: freshSlot({ class: '' }),
    });
    const before = c.placementElement.outerHTML;
    c._iframe = document.createElement('iframe');
    c._attachToPlacement();
    c._detachFromPlacement();
    assert(c.placementElement.outerHTML === before,
      'element with class="" preserved (vs collapsed to no class attr)');
  }
}

// -- 12. Constructor side-effects are minimal ──────────────────────────────
//
// Constructing a SHARCContainer should NOT mutate placementElement or attach
// to the DOM — that's load()'s job. Construction must be safe enough to use
// in test setup / SSR without side effects.
{
  console.log('\n12. Constructor does not mutate placement element');
  const slot = freshSlot();
  const before = slot.outerHTML;
  new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: slot,
    placementId: 'x',
    placementName: 'y',
  });
  assert(slot.outerHTML === before,
    'placementElement.outerHTML unchanged after construction (no implicit attach)');
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} placement-stamping assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All placement-stamping assertions passed.');
}
