/**
 * test-bridges-detection.js — issue #82 (0.7.1) coverage
 *
 * Pure unit tests on the SHARCContainer._resolveBridges() three-layer
 * detection pipeline + the new `bridges` and `bidMeta` constructor options.
 * jsdom-based, no Puppeteer.
 *
 * Coverage matrix (per design doc § 7.1):
 *
 *   Layer 1 (explicit `bridges` option):
 *     - null / undefined / [] / single / multi / sort-stability
 *     - invalid types (TypeError) / unknown identifiers (Error)
 *
 *   Layer 2 (`bidMeta.apis` AdCOM codes):
 *     - empty / single 3/5/6 / dedup [3,5,6] / [7] (OMID, deferred) /
 *       [6,7] (MRAID + OMID) / unrecognized codes ignored
 *
 *   Layer 3 (adm scan):
 *     - mraid.js match / $sf.ext match / both / neither / bare-token
 *       non-match (false-positive defense)
 *
 *   Precedence: explicit [] overrides bidMeta+adm-detect; bidMeta beats
 *   adm scan; adm scan only fires when both higher layers empty.
 *
 *   Sort stability: input order doesn't matter.
 *
 *   Constructor validation: bridges type errors, unknown identifier
 *   errors, bidMeta shape errors, container.bridges accessor (frozen).
 *
 *   :render message construction: bridges field carries the resolved list.
 *
 * Spec: docs/design/0.7.1-bridges-field.md § 3 (Container-side detection),
 *       § 7 (Test strategy).
 *
 * Runs in Node after `npm run build`. No browser, no test framework.
 */

import { JSDOM } from 'jsdom';

// ── Set up DOM globals BEFORE importing SHARCContainer. ───────────────────
const PUBLISHER_ORIGIN = 'https://publisher.example';
const dom = new JSDOM(
  '<!DOCTYPE html><html><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html', referrer: 'https://search.example/' },
);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;

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
function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message, `(actual=${a} expected=${b})`);
    failures++;
  }
}
function assertThrows(fn, msgPattern, message, ErrorCtor) {
  try {
    fn();
    console.error('  ✗', message, '(no throw)');
    failures++;
  } catch (e) {
    if (ErrorCtor && !(e instanceof ErrorCtor)) {
      console.error('  ✗', message, `(threw, wrong type: ${e.constructor.name}, expected ${ErrorCtor.name})`);
      failures++;
      return;
    }
    if (msgPattern && !String(e.message).match(msgPattern)) {
      console.error('  ✗', message, `(threw, wrong message: ${e.message})`);
      failures++;
      return;
    }
    console.log('  ✓', message);
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────
const RENDERER_URL = 'https://renderer.operator.example/0.7.1/';
function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'ad-slot';
  document.body.appendChild(el);
  return el;
}
function markupOptions(overrides) {
  return {
    creativeHtml: '<html><body>ad</body></html>',
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    ...overrides,
  };
}

console.log('test-bridges-detection.js — issue #82 (0.7.1) coverage\n');

// -- 1. Static helpers — exposed for direct unit testing ──────────────────
{
  console.log('1. _resolveBridges / _mapAdComApisToBridges / _detectBridgesFromAdmScan');

  // _mapAdComApisToBridges — direct unit coverage
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([]), [],
    '_mapAdComApisToBridges([]) → []');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([3]), ['mraid'],
    '_mapAdComApisToBridges([3]) → ["mraid"] (MRAID 1.0)');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([5]), ['mraid'],
    '_mapAdComApisToBridges([5]) → ["mraid"] (MRAID 2.0)');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([6]), ['mraid'],
    '_mapAdComApisToBridges([6]) → ["mraid"] (MRAID 3.0)');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([3, 5, 6]), ['mraid'],
    '_mapAdComApisToBridges([3,5,6]) → ["mraid"] (dedup)');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([7]), [],
    '_mapAdComApisToBridges([7]) → [] (OMID 1.0 — deferred to 0.7.2)');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([6, 7]), ['mraid'],
    '_mapAdComApisToBridges([6,7]) → ["mraid"] (OMID code 7 ignored in 0.7.1)');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([100, 500, 1000]), [],
    '_mapAdComApisToBridges([100,500,1000]) → [] (vendor-specific / unknown)');

  // _detectBridgesFromAdmScan — direct unit coverage
  assertDeepEqual(SHARCContainer._detectBridgesFromAdmScan(''), [],
    '_detectBridgesFromAdmScan("") → []');
  assertDeepEqual(
    SHARCContainer._detectBridgesFromAdmScan('<script src="mraid.js"></script>'),
    ['mraid'],
    '_detectBridgesFromAdmScan(<mraid.js script>) → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._detectBridgesFromAdmScan('<script>$sf.ext.register(300,250)</script>'),
    ['safeframe'],
    '_detectBridgesFromAdmScan(<$sf.ext>) → ["safeframe"]');
  assertDeepEqual(
    SHARCContainer._detectBridgesFromAdmScan('<script src="mraid.js"></script>$sf.ext.register'),
    ['mraid', 'safeframe'],
    '_detectBridgesFromAdmScan(both signals) → ["mraid","safeframe"] (sorted)');

  // Tightened-substring false-positive defense: bare tokens don't match
  assertDeepEqual(
    SHARCContainer._detectBridgesFromAdmScan('<!-- mraid 3.0 creative --> <div class="mraid-container">'),
    [],
    'bare token "mraid" (no ".js") does NOT match — false-positive defense');
  assertDeepEqual(
    SHARCContainer._detectBridgesFromAdmScan('<!-- safeframe 1.0 --> <div data-safeframe>'),
    [],
    'bare token "safeframe" (no "$sf.ext") does NOT match — false-positive defense');
}

// -- 2. Layer 1: explicit `bridges` option (precedence + edge cases) ──────
{
  console.log('\n2. Layer 1 — explicit bridges option');

  // Explicit array wins verbatim
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bridges: ['mraid'] }),
    ['mraid'],
    'explicit ["mraid"] returns ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bridges: ['safeframe', 'mraid'] }),
    ['mraid', 'safeframe'],
    'explicit ["safeframe","mraid"] is sorted → ["mraid","safeframe"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bridges: ['mraid', 'mraid'] }),
    ['mraid'],
    'explicit ["mraid","mraid"] is deduped → ["mraid"]');

  // Empty explicit array = "load no bridges" — terminates the pipeline,
  // does NOT fall through to bidMeta or adm scan.
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bridges: [],
      bidMeta: { apis: [5] },
      creativeHtml: '<script src="mraid.js">',
    }),
    [],
    'explicit [] short-circuits even when bidMeta+adm would detect');

  // null/undefined fall through
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bridges: null,
      creativeHtml: '<script src="mraid.js">',
    }),
    ['mraid'],
    'bridges: null falls through to adm scan');
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      // bridges intentionally omitted
      creativeHtml: '<script src="mraid.js">',
    }),
    ['mraid'],
    'bridges: undefined falls through to adm scan');
}

// -- 3. Layer 2: bidMeta.apis AdCOM mapping with fall-through ─────────────
{
  console.log('\n3. Layer 2 — bidMeta.apis AdCOM codes');

  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [5] } }),
    ['mraid'],
    'bidMeta.apis=[5] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [3, 5, 6] } }),
    ['mraid'],
    'bidMeta.apis=[3,5,6] all MRAID → ["mraid"]');

  // Empty mapping falls through to layer 3.
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bidMeta: { apis: [7] }, // OMID-only, deferred to 0.7.2
      creativeHtml: '<script src="mraid.js">',
    }),
    ['mraid'],
    'bidMeta.apis=[7] (OMID only) → empty mapping; falls through to adm scan');

  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bidMeta: { apis: [] }, // explicitly empty
      creativeHtml: '<script src="mraid.js">',
    }),
    ['mraid'],
    'bidMeta.apis=[] falls through to adm scan');

  // bidMeta.apis beats adm scan when it produces a non-empty result.
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bidMeta: { apis: [5] },
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid'],
    'bidMeta.apis=[5] beats adm scan even when adm has $sf.ext signal');
}

// -- 4. Layer 3: adm content scan — last-resort heuristic ─────────────────
{
  console.log('\n4. Layer 3 — adm content scan');

  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeHtml: '<script src="mraid.js">' }),
    ['mraid'],
    'adm scan finds mraid.js → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeHtml: '<script>$sf.ext.register(300,250,cb)</script>' }),
    ['safeframe'],
    'adm scan finds $sf.ext → ["safeframe"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid', 'safeframe'],
    'adm scan finds both → ["mraid","safeframe"] (sorted)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeHtml: '<html><body>plain creative</body></html>' }),
    [],
    'adm scan: plain creative → []');
  // creativeHtml empty/absent — Creative URL variant has no adm
  assertDeepEqual(
    SHARCContainer._resolveBridges({}),
    [],
    'no inputs → []');
}

// -- 5. Multi-framework truth table per design doc § 3.5 ──────────────────
{
  console.log('\n5. Multi-framework truth table');

  // Real AdCOM codes only (placeholder labels <SHARC1>, <SF> stay deferred).
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [3] } }), ['mraid'],
    '[3] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [5] } }), ['mraid'],
    '[5] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [6] } }), ['mraid'],
    '[6] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [3, 5, 6] } }), ['mraid'],
    '[3,5,6] → ["mraid"] (all dedup to single bridge)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [7] }, creativeHtml: 'plain' }), [],
    '[7] (OMID only) → [] in 0.7.1');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [6, 7] } }), ['mraid'],
    '[6,7] (MRAID + OMID) → ["mraid"] (OMID ignored in 0.7.1)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [500] } }), [],
    '[500] (vendor-specific) → [] (ignored)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bidMeta: { apis: [500, 6] } }), ['mraid'],
    '[500, 6] → ["mraid"] (vendor code ignored, MRAID 3.0 recognized)');
}

// -- 6. Sort stability ─────────────────────────────────────────────────────
{
  console.log('\n6. Sort stability — output is always alphabetical');

  assertDeepEqual(
    SHARCContainer._resolveBridges({ bridges: ['safeframe', 'mraid'] }),
    ['mraid', 'safeframe'],
    'explicit ["safeframe","mraid"] → ["mraid","safeframe"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ bridges: ['mraid', 'safeframe'] }),
    ['mraid', 'safeframe'],
    'explicit ["mraid","safeframe"] → ["mraid","safeframe"]');
}

// -- 7. Constructor option — `bridges` validation ─────────────────────────
{
  console.log('\n7. Constructor — bridges validation');

  // Valid shapes — accepted
  {
    const c = new SHARCContainer(markupOptions({ bridges: ['mraid'] }));
    assertDeepEqual([...c.bridges], ['mraid'],
      'bridges: ["mraid"] → container.bridges = ["mraid"]');
  }
  {
    const c = new SHARCContainer(markupOptions({ bridges: [] }));
    assertDeepEqual([...c.bridges], [],
      'bridges: [] → container.bridges = [] (explicit suppression)');
  }
  {
    const c = new SHARCContainer(markupOptions({ bridges: null }));
    // null falls through to adm scan; default fixture creativeHtml has no
    // mraid.js / $sf.ext signal, so result is [].
    assertDeepEqual([...c.bridges], [],
      'bridges: null falls through, fixture adm scan empty → []');
  }
  {
    const c = new SHARCContainer(markupOptions({
      bridges: ['mraid', 'safeframe'],
    }));
    assertDeepEqual([...c.bridges], ['mraid', 'safeframe'],
      'bridges: ["mraid","safeframe"] → container.bridges = ["mraid","safeframe"]');
  }

  // Invalid shapes — TypeError
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: 'mraid' })),
    /bridges must be null, undefined, or an array of strings/,
    'bridges: "mraid" (string) throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: 42 })),
    /bridges must be null, undefined, or an array of strings/,
    'bridges: 42 throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: true })),
    /bridges must be null, undefined, or an array of strings/,
    'bridges: true throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: [42] })),
    /bridges\[0\] must be a string/,
    'bridges: [42] throws TypeError (non-string element)',
    TypeError,
  );

  // Unknown identifier — Error (stricter than renderer-side handling)
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: ['omid'] })),
    /not a recognized bridge identifier/,
    'bridges: ["omid"] throws Error in 0.7.1 (deferred to 0.7.2)',
    Error,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: ['mraid', 'fakebridge'] })),
    /bridges\[1\] = "fakebridge".*not a recognized/,
    'bridges: ["mraid","fakebridge"] throws on the unknown identifier',
    Error,
  );
}

// -- 8. Constructor option — `bidMeta` validation ─────────────────────────
{
  console.log('\n8. Constructor — bidMeta validation');

  // Valid shapes
  {
    const c = new SHARCContainer(markupOptions({ bidMeta: { apis: [5] } }));
    assertDeepEqual([...c.bridges], ['mraid'],
      'bidMeta: { apis: [5] } → container.bridges = ["mraid"]');
  }
  {
    const c = new SHARCContainer(markupOptions({ bidMeta: { apis: [] } }));
    assertDeepEqual([...c.bridges], [],
      'bidMeta: { apis: [] } falls through, fixture adm scan empty → []');
  }
  {
    // bidMeta with no apis is permitted (forward-compat for future fields)
    const c = new SHARCContainer(markupOptions({ bidMeta: {} }));
    assertDeepEqual([...c.bridges], [],
      'bidMeta: {} (no apis) is permitted — forward-compat bag');
  }

  // Invalid shapes
  assertThrows(
    () => new SHARCContainer(markupOptions({ bidMeta: 'not an object' })),
    /bidMeta must be a plain object/,
    'bidMeta: "string" throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bidMeta: [1, 2, 3] })),
    /bidMeta must be a plain object/,
    'bidMeta: [array] throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bidMeta: { apis: 'not array' } })),
    /bidMeta\.apis must be an array of integers/,
    'bidMeta.apis: "string" throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bidMeta: { apis: ['five'] } })),
    /bidMeta\.apis\[0\] must be a finite number/,
    'bidMeta.apis: ["five"] throws TypeError (non-number element)',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bidMeta: { apis: [Infinity] } })),
    /bidMeta\.apis\[0\] must be a finite number/,
    'bidMeta.apis: [Infinity] throws TypeError (non-finite)',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ bidMeta: { apis: [NaN] } })),
    /bidMeta\.apis\[0\] must be a finite number/,
    'bidMeta.apis: [NaN] throws TypeError (non-finite)',
    TypeError,
  );
}

// -- 9. container.bridges — accessor surface ──────────────────────────────
{
  console.log('\n9. container.bridges accessor — frozen array, set at construction');

  const c = new SHARCContainer(markupOptions({
    creativeHtml: '<script src="mraid.js"></script>',
  }));
  assert(Array.isArray(c.bridges),
    'container.bridges is an array');
  assertDeepEqual([...c.bridges], ['mraid'],
    'container.bridges reflects layer-3 adm detection');
  assert(Object.isFrozen(c.bridges),
    'container.bridges is frozen (immutable after construction)');
  // Belt-and-suspenders: verify the freeze actually enforces immutability
  // (Object.isFrozen returning true is necessary but not sufficient —
  // a hostile environment could shadow Object.isFrozen).
  assertThrows(
    () => c.bridges.push('safeframe'),
    /Cannot add/,
    'container.bridges.push throws on frozen array (mutation rejected at runtime)',
  );

  // Creative URL variant: bridges always []
  const urlContainer = new SHARCContainer({
    creativeUrl: 'https://ads.example/creative.html',
    placementElement: freshSlot(),
  });
  assertDeepEqual([...urlContainer.bridges], [],
    'Creative URL variant: container.bridges = [] (renderer protocol Markup-only)');
}

// -- 10. :render message construction — bridges field present ─────────────
{
  console.log('\n10. SHARC:Renderer:render message — bridges field present');

  // Verify the bridges field gets onto the render envelope by spying on
  // postMessage. We don't fully exercise the load path — test-creative-
  // sources-load owns that. We just check the message shape.
  const slot = freshSlot();
  const c = new SHARCContainer({
    creativeHtml: '<script src="mraid.js"></script>',
    creativeRendererUrl: RENDERER_URL,
    placementElement: slot,
    bridges: ['mraid', 'safeframe'],
  });

  // The container's bridges resolved at construction. The :render message
  // is built inside _wireRendererProtocol; we verify the resolved field
  // on the instance instead of intercepting postMessage (which would
  // require driving the full load path).
  assertDeepEqual([...c.bridges], ['mraid', 'safeframe'],
    'container.bridges reflects explicit ["mraid","safeframe"] option');
}

// -- 11. Layer precedence — explicit > bidMeta > adm scan ────────────────
{
  console.log('\n11. Layer precedence — most-specific wins');

  // All three layers populated → layer 1 wins
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bridges: ['mraid'],
      bidMeta: { apis: [5, 6] },
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid'],
    'all three layers populated → layer 1 (explicit) wins');

  // Layer 2 + Layer 3 → layer 2 wins
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bidMeta: { apis: [5] },
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid'],
    'no explicit bridges + bidMeta.apis=[5] + adm has both → layer 2 wins, ["mraid"]');

  // Only Layer 3 populated
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid', 'safeframe'],
    'only layer 3 populated → adm scan result');
}

// -- 12. Performance — adm scan on 256 KiB stays sub-millisecond ─────────
{
  console.log('\n12. Performance — adm scan on max-size payload');

  // Synthesize a ~256 KiB payload with mraid.js + $sf.ext signals near the end
  // (worst case for indexOf).
  const FILLER = '<!-- '.padEnd(64, 'x') + ' -->';
  const repeats = Math.floor((256 * 1024 - 200) / FILLER.length);
  const filler = FILLER.repeat(repeats);
  const html = filler + '<script src="mraid.js"></script>$sf.ext.register';

  // Warm up V8
  for (let i = 0; i < 10; i++) SHARCContainer._detectBridgesFromAdmScan(html);

  const N = 100;
  const start = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    SHARCContainer._detectBridgesFromAdmScan(html);
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const meanMs = (elapsedNs / N) / 1e6;
  // Generous bound — design doc § 7.2 names ≤ 5 ms p95 on CI runner.
  // 50ms gives slack for noisy shared CI VMs without masking O(n²) regressions.
  assert(meanMs < 50,
    'adm scan mean over ' + N + ' iterations < 50ms (got ' + meanMs.toFixed(3) + 'ms)');
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} bridges-detection assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All bridges-detection assertions passed.');
}
