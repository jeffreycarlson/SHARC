/**
 * test-bridges-detection.js — issue #82 (0.7.1) coverage
 *
 * Pure unit tests on the SHARCContainer._resolveBridges() three-layer
 * detection pipeline + the new `bridges` and `creativeMeta` constructor options.
 * jsdom-based, no Puppeteer.
 *
 * Coverage matrix (per design doc § 7.1):
 *
 *   Layer 1 (explicit `bridges` option):
 *     - null / undefined / [] / single / multi / sort-stability
 *     - invalid types (TypeError) / unknown identifiers (Error)
 *
 *   Layer 2 (`creativeMeta.apis` AdCOM codes):
 *     - empty / single 3/5/6 / dedup [3,5,6] / [7] (OMID, not a bridge) /
 *       [6,7] (MRAID + OMID) / unrecognized codes ignored
 *
 *   Layer 3 (adm scan):
 *     - mraid.js match / $sf.ext match / both / neither / bare-token
 *       non-match (false-positive defense)
 *
 *   Precedence: explicit [] overrides creativeMeta+adm-detect; creativeMeta beats
 *   adm scan; adm scan only fires when both higher layers empty.
 *
 *   Sort stability: input order doesn't matter.
 *
 *   Constructor validation: bridges type errors, unknown identifier
 *   errors, creativeMeta shape errors, container.bridges accessor (frozen).
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
const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');
const { MRAIDCompatBridge } = await import('../../dist/sharc-mraid-bridge.mjs');
const { SafeFrameCompatBridge } = await import('../../dist/sharc-safeframe-bridge.mjs');

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

function createMockOmidSdk() {
  const stats = {
    partnerArgs: null,
    verificationScripts: null,
    contentUrl: null,
    serviceScriptUrl: null,
    creativeType: null,
    impressionType: null,
    registerAdViewArg: null,
    startCalls: 0,
    finishCalls: 0,
    loadedCalls: 0,
    loadedArgs: [],
    impressionCalls: 0,
    visibilityStates: [],
    playerStates: [],
    observer: null,
  };

  class Partner {
    constructor(name, version) {
      stats.partnerArgs = [name, version];
      this.name = name;
      this.version = version;
    }
  }

  class VerificationScriptResource {
    constructor(url, vendor, verificationParameters, accessMode) {
      this.url = url;
      this.vendor = vendor;
      this.verificationParameters = verificationParameters;
      this.accessMode = accessMode;
    }
  }

  class Context {
    constructor(partner, verificationScripts) {
      this.partner = partner;
      this.verificationScripts = verificationScripts;
      stats.verificationScripts = verificationScripts;
    }
    setContentUrl(url) {
      stats.contentUrl = url;
    }
    setServiceScriptUrl(url) {
      stats.serviceScriptUrl = url;
    }
  }

  class AdSession {
    constructor(context) {
      this.context = context;
    }
    setCreativeType(value) {
      stats.creativeType = value;
    }
    setImpressionType(value) {
      stats.impressionType = value;
    }
    registerAdView(value) {
      stats.registerAdViewArg = value;
    }
    registerSessionObserver(fn) {
      stats.observer = fn;
    }
    start() {
      stats.startCalls++;
    }
    finish() {
      stats.finishCalls++;
      if (stats.observer) stats.observer({ type: 'sessionFinish' });
    }
  }

  class AdEvents {
    constructor(session) {
      this.session = session;
    }
    loaded(arg) {
      stats.loadedCalls++;
      stats.loadedArgs.push(arg);
    }
    impressionOccurred() {
      stats.impressionCalls++;
    }
    stateChange(value) {
      stats.visibilityStates.push(value);
    }
  }

  class MediaEvents {
    constructor(session) {
      this.session = session;
    }
    playerStateChange(value) {
      stats.playerStates.push(value);
    }
  }

  class VastProperties {
    constructor(isSkippable, skipOffset, isAutoPlay, position) {
      this.isSkippable = isSkippable;
      this.skipOffset = skipOffset;
      this.isAutoPlay = isAutoPlay;
      this.position = position;
    }
  }

  return {
    sdk: {
      Partner,
      VerificationScriptResource,
      Context,
      AdSession,
      AdEvents,
      MediaEvents,
      VastProperties,
    },
    stats,
  };
}

function installMockOmidSdk(mock) {
  global.OmidSessionClient = mock.sdk;
  window.OmidSessionClient = mock.sdk;
}

function uninstallMockOmidSdk() {
  delete global.OmidSessionClient;
  delete window.OmidSessionClient;
}

function createContainerStub() {
  let state = 'loading';
  return {
    _iframe: document.createElement('iframe'),
    getState() {
      return state;
    },
    setState(next) {
      state = next;
    },
  };
}

function createOmidTestContainer(omidBridge, extraOptions) {
  const c = new SHARCContainer(markupOptions({
    creativeMeta: { apis: [7] },
    extensions: [omidBridge],
    ...(extraOptions || {}),
  }));
  c._iframe = document.createElement('iframe');
  c._protocol.sendStateChange = () => {};
  return c;
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
    '_mapAdComApisToBridges([7]) → [] (OMID 1.0 — container extension only, not a bridge)');
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([6, 7]), ['mraid'],
    '_mapAdComApisToBridges([6,7]) → ["mraid"] (OMID code 7 ignored — not a bridge)');
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
  // does NOT fall through to creativeMeta or adm scan.
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bridges: [],
      creativeMeta: { apis: [5] },
      creativeHtml: '<script src="mraid.js">',
    }),
    [],
    'explicit [] short-circuits even when creativeMeta+adm would detect');

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

// -- 3. Layer 2: creativeMeta.apis AdCOM mapping with fall-through ─────────────
{
  console.log('\n3. Layer 2 — creativeMeta.apis AdCOM codes');

  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [5] } }),
    ['mraid'],
    'creativeMeta.apis=[5] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [3, 5, 6] } }),
    ['mraid'],
    'creativeMeta.apis=[3,5,6] all MRAID → ["mraid"]');

  // Empty mapping for OMID falls through to layer 3.
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      creativeMeta: { apis: [7] }, // OMID-only, container extension path
      creativeHtml: '<script src="mraid.js">',
    }),
    ['mraid'],
    'creativeMeta.apis=[7] (OMID only) → empty mapping; falls through to adm scan');

  assertDeepEqual(
    SHARCContainer._resolveBridges({
      creativeMeta: { apis: [] }, // explicitly empty
      creativeHtml: '<script src="mraid.js">',
    }),
    ['mraid'],
    'creativeMeta.apis=[] falls through to adm scan');

  // creativeMeta.apis beats adm scan when it produces a non-empty result.
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      creativeMeta: { apis: [5] },
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid'],
    'creativeMeta.apis=[5] beats adm scan even when adm has $sf.ext signal');
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
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [3] } }), ['mraid'],
    '[3] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [5] } }), ['mraid'],
    '[5] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [6] } }), ['mraid'],
    '[6] → ["mraid"]');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [3, 5, 6] } }), ['mraid'],
    '[3,5,6] → ["mraid"] (all dedup to single bridge)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [7] }, creativeHtml: 'plain' }), [],
    '[7] (OMID only) → [] (not a bridge — container extension only)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [6, 7] } }), ['mraid'],
    '[6,7] (MRAID + OMID) → ["mraid"] (OMID not a bridge)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [500] } }), [],
    '[500] (vendor-specific) → [] (ignored)');
  assertDeepEqual(
    SHARCContainer._resolveBridges({ creativeMeta: { apis: [500, 6] } }), ['mraid'],
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
    'bridges: ["omid"] throws Error — OMID is container extension only, not a bridge',
    Error,
  );
  // Unknown identifier — Error (stricter than renderer-side handling)
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: ['mraid', 'fakebridge'] })),
    /bridges\[1\] = "fakebridge".*not a recognized/,
    'bridges: ["mraid","fakebridge"] throws on the unknown identifier',
    Error,
  );
}

// -- 8. Constructor option — `creativeMeta` validation ─────────────────────────
{
  console.log('\n8. Constructor — creativeMeta validation');

  // Valid shapes
  {
    const c = new SHARCContainer(markupOptions({ creativeMeta: { apis: [5] } }));
    assertDeepEqual([...c.bridges], ['mraid'],
      'creativeMeta: { apis: [5] } → container.bridges = ["mraid"]');
  }
  {
    const c = new SHARCContainer(markupOptions({ creativeMeta: { apis: [] } }));
    assertDeepEqual([...c.bridges], [],
      'creativeMeta: { apis: [] } falls through, fixture adm scan empty → []');
  }
  {
    // creativeMeta with no apis is permitted (forward-compat for future fields)
    const c = new SHARCContainer(markupOptions({ creativeMeta: {} }));
    assertDeepEqual([...c.bridges], [],
      'creativeMeta: {} (no apis) is permitted — forward-compat bag');
  }

  // Invalid shapes
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: 'not an object' })),
    /creativeMeta must be a plain object/,
    'creativeMeta: "string" throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: [1, 2, 3] })),
    /creativeMeta must be a plain object/,
    'creativeMeta: [array] throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: { apis: 'not array' } })),
    /creativeMeta\.apis must be an array of integers/,
    'creativeMeta.apis: "string" throws TypeError',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: { apis: ['five'] } })),
    /creativeMeta\.apis\[0\] must be an integer/,
    'creativeMeta.apis: ["five"] throws TypeError (non-number element)',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: { apis: [Infinity] } })),
    /creativeMeta\.apis\[0\] must be an integer/,
    'creativeMeta.apis: [Infinity] throws TypeError (non-finite)',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: { apis: [NaN] } })),
    /creativeMeta\.apis\[0\] must be an integer/,
    'creativeMeta.apis: [NaN] throws TypeError (non-finite)',
    TypeError,
  );
  // Integer tightening (post-consolidation, 2026-05-10): AdCOM APIFramework
  // codes are documented as integers; non-integer numerics like 3.5 would
  // silently map to no bridge. Reject early instead.
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: { apis: [3.5] } })),
    /creativeMeta\.apis\[0\] must be an integer/,
    'creativeMeta.apis: [3.5] throws TypeError (non-integer)',
    TypeError,
  );
  assertThrows(
    () => new SHARCContainer(markupOptions({ creativeMeta: { apis: [0.7] } })),
    /creativeMeta\.apis\[0\] must be an integer/,
    'creativeMeta.apis: [0.7] throws TypeError (non-integer)',
    TypeError,
  );
}

// -- 8.5. Rule 3b — variant-mismatch validation ──────────────────────────────
// `bridges` and `creativeMeta` are Creative Markup variant only. The Creative URL
// variant has no bridge-loading path. Passing either alongside `creativeUrl`
// is a misconfiguration the constructor must surface, not silently drop.
{
  console.log('\n8.5. Rule 3b — bridges/creativeMeta forbidden alongside creativeUrl');

  function urlOptions(overrides) {
    return {
      creativeUrl: 'https://creatives.example.com/ad-300x250.html',
      placementElement: freshSlot(),
      ...overrides,
    };
  }

  // Sanity: bare Creative URL constructs cleanly
  {
    const c = new SHARCContainer(urlOptions({}));
    assertDeepEqual([...c.bridges], [],
      'Creative URL with no bridges/creativeMeta → container.bridges = []');
  }

  // Forbidden combinations — must throw at construction
  assertThrows(
    () => new SHARCContainer(urlOptions({ bridges: ['mraid'] })),
    /bridges and creativeMeta options are only valid alongside creativeHtml/,
    'Creative URL + bridges: ["mraid"] throws (Rule 3b — explicit bridges)',
  );
  assertThrows(
    () => new SHARCContainer(urlOptions({ bridges: [] })),
    /bridges and creativeMeta options are only valid alongside creativeHtml/,
    'Creative URL + bridges: [] throws (Rule 3b — explicit empty array still misconfig)',
  );
  assertThrows(
    () => new SHARCContainer(urlOptions({ bridges: null })),
    /bridges and creativeMeta options are only valid alongside creativeHtml/,
    'Creative URL + bridges: null throws (Rule 3b — explicit auto-detect on variant that does not detect)',
  );
  assertThrows(
    () => new SHARCContainer(urlOptions({ creativeMeta: { apis: [5] } })),
    /bridges and creativeMeta options are only valid alongside creativeHtml/,
    'Creative URL + creativeMeta: { apis: [5] } throws (Rule 3b — explicit AdCOM signal)',
  );
  assertThrows(
    () => new SHARCContainer(urlOptions({ creativeMeta: {} })),
    /bridges and creativeMeta options are only valid alongside creativeHtml/,
    'Creative URL + creativeMeta: {} throws (Rule 3b — empty forward-compat bag)',
  );
  assertThrows(
    () => new SHARCContainer(urlOptions({ bridges: ['mraid'], creativeMeta: { apis: [5] } })),
    /bridges and creativeMeta options are only valid alongside creativeHtml/,
    'Creative URL + both throws (Rule 3b)',
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
  // Broaden the match across JS engines: V8 says "Cannot add property",
  // SpiderMonkey says "can't define property", JavaScriptCore says
  // "object is not extensible". All three are valid TypeError variants
  // for frozen-array mutation. Tests run in Node (V8) today but Bun
  // (JavaScriptCore) or other runtimes are within the test envelope.
  assertThrows(
    () => c.bridges.push('safeframe'),
    /not extensible|Cannot add|can't define/i,
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

// -- 11. Layer precedence — explicit > creativeMeta > adm scan ────────────────
{
  console.log('\n11. Layer precedence — most-specific wins');

  // All three layers populated → layer 1 wins
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      bridges: ['mraid'],
      creativeMeta: { apis: [5, 6] },
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid'],
    'all three layers populated → layer 1 (explicit) wins');

  // Layer 2 + Layer 3 → layer 2 wins
  assertDeepEqual(
    SHARCContainer._resolveBridges({
      creativeMeta: { apis: [5] },
      creativeHtml: '<script src="mraid.js">$sf.ext.register</script>',
    }),
    ['mraid'],
    'no explicit bridges + creativeMeta.apis=[5] + adm has both → layer 2 wins, ["mraid"]');

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

// ===========================================================================
// 0.7.2 (issue #89) — _resolveApiFramework picker + G10 + G12 + Rule 11
// ===========================================================================

const SHARC_API_CODE = protoMod.SHARC_API_CODE;
const SAFEFRAME_API_CODE = protoMod.SAFEFRAME_API_CODE;

function makeMarkupOpts(extra) {
  // Minimal Markup-variant valid options. creativeMeta is required to
  // exercise the picker in the constructor path (Rule 3b — Markup-only).
  return Object.assign({
    creativeHtml: '<html><body>creative</body></html>',
    creativeRendererUrl: 'https://renderer.example/r.html',
    placementElement: document.createElement('div'),
  }, extra);
}

// -- 13. _resolveApiFramework picker — § 6.2 priority ladder + § 6.6 edges --
{
  console.log('\n13. _resolveApiFramework picker — priority ladder + edge cases');

  const pick = (apis) => SHARCContainer._resolveApiFramework({ apis });

  // Recognized container-runtime codes.
  assertDeepEqual(pick([6]), 6,                              'MRAID 3.0 alone → 6');
  assertDeepEqual(pick([5]), 5,                              'MRAID 2.0 alone → 5');
  assertDeepEqual(pick([3]), 3,                              'MRAID 1.0 alone → 3');
  assertDeepEqual(pick([6, 5]), 6,                           'MRAID 3.0 + 2.0 → 6 (higher MRAID wins)');
  assertDeepEqual(pick([3, 5, 6]), 6,                        'MRAID 1.0 + 2.0 + 3.0 → 6 (highest MRAID wins)');
  assertDeepEqual(pick([SHARC_API_CODE]), SHARC_API_CODE,    'SHARC alone → SHARC_API_CODE');
  assertDeepEqual(pick([SAFEFRAME_API_CODE]), SAFEFRAME_API_CODE, 'SafeFrame alone → SAFEFRAME_API_CODE');

  // Priority: SHARC > MRAID > SafeFrame.
  assertDeepEqual(pick([6, SHARC_API_CODE]), SHARC_API_CODE,
    '[MRAID 3.0, SHARC] → SHARC (priority 1 beats priority 2)');
  assertDeepEqual(pick([SAFEFRAME_API_CODE, SHARC_API_CODE]), SHARC_API_CODE,
    '[SafeFrame, SHARC] → SHARC');
  assertDeepEqual(pick([6, SAFEFRAME_API_CODE]), 6,
    '[MRAID 3.0, SafeFrame] → MRAID (priority 2 beats priority 3)');

  // OMID excluded (measurement, not container runtime).
  assertDeepEqual(pick([7]), null,                           'OMID alone → null (excluded)');
  assertDeepEqual(pick([6, 7]), 6,                           '[MRAID 3.0, OMID] → 6 (OMID excluded)');
  assertDeepEqual(pick([SHARC_API_CODE, 7]), SHARC_API_CODE, '[SHARC, OMID] → SHARC (OMID orthogonal)');

  // VPAID and SIMID — not picker targets (video-creative protocols).
  assertDeepEqual(pick([1]), null,                           'VPAID 1.0 alone → null (not picker target)');
  assertDeepEqual(pick([2]), null,                           'VPAID 2.0 alone → null (not picker target)');
  assertDeepEqual(pick([8]), null,                           'SIMID 1.0 alone → null (not picker target)');
  assertDeepEqual(pick([9]), null,                           'SIMID 1.1 alone → null (not picker target)');
  assertDeepEqual(pick([1, 2, 8, 9]), null,                  '[VPAID + SIMID] → null');
  assertDeepEqual(pick([6, 2]), 6,                           '[MRAID, VPAID] → MRAID (VPAID skipped)');

  // Vendor codes.
  assertDeepEqual(pick([503]), null,                         'Vendor code 503 → null');
  assertDeepEqual(pick([503, 6, 999]), 6,                    'Multiple unknowns + one known → 6');

  // Empty/missing.
  assertDeepEqual(pick([]), null,                            'Empty array → null');
  assertDeepEqual(SHARCContainer._resolveApiFramework(undefined), null, 'undefined creativeMeta → null');
  assertDeepEqual(SHARCContainer._resolveApiFramework(null), null,      'null creativeMeta → null');
  assertDeepEqual(SHARCContainer._resolveApiFramework({}), null,        '{} creativeMeta → null');
  assertDeepEqual(SHARCContainer._resolveApiFramework({apis: null}), null,
    '{apis:null} creativeMeta → null');
}

// -- 14. container.apiFramework accessor + G10 frozen invariant -----------
{
  console.log('\n14. container.apiFramework accessor — G10 frozen at construction');

  const c1 = new SHARCContainer(makeMarkupOpts({ creativeMeta: { apis: [6] } }));
  assert(c1.apiFramework === 6, 'container.apiFramework returns picked code (6 for MRAID 3.0)');

  const c2 = new SHARCContainer(makeMarkupOpts({ creativeMeta: { apis: [SHARC_API_CODE] } }));
  assert(c2.apiFramework === SHARC_API_CODE, 'container.apiFramework returns SHARC_API_CODE');

  const c3 = new SHARCContainer(makeMarkupOpts({ /* no creativeMeta */ }));
  assert(c3.apiFramework === null, 'container.apiFramework is null when no creativeMeta declared');

  // URL variant: creativeMeta is Markup-only per Rule 3b. apiFramework is null.
  const c4 = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: document.createElement('div'),
  });
  assert(c4.apiFramework === null, 'URL variant: apiFramework always null (Rule 3b)');

  // G10: getter is non-writable. Direct overwrite has no effect.
  const c5 = new SHARCContainer(makeMarkupOpts({ creativeMeta: { apis: [6] } }));
  let assignmentThrew = false;
  try {
    // In strict mode this throws; in sloppy mode it silently fails. Either way
    // the read-back must still return the original value.
    c5.apiFramework = 99;
  } catch (e) {
    assignmentThrew = true;
  }
  assert(c5.apiFramework === 6,
    'G10: container.apiFramework still returns original after direct assignment attempt (got ' + c5.apiFramework + ')');

  // G10: the private backing field `_apiFramework` is locked at construction
  // (Object.defineProperty with writable:false + configurable:false). A
  // write attempt is a silent no-op in sloppy mode and throws in strict;
  // either way the public accessor still returns the construction value.
  let mutationThrew = false;
  try { c5._apiFramework = 12345; } catch (e) { mutationThrew = true; }
  assert(c5._apiFramework === 6,
    'G10: locked _apiFramework is non-writable; direct mutation has no effect on the backing field');
  assert(c5.apiFramework === 6,
    'G10: container.apiFramework reads through the locked backing field and survives mutation attempt');

  // G10: private field is also non-configurable. delete is inert.
  try { delete c5._apiFramework; } catch (e) { /* strict throws */ }
  assert(c5._apiFramework === 6, 'G10: locked _apiFramework survives delete attempt');

  // G10: public accessor is non-configurable. delete fails.
  let deleteThrew = false;
  try { delete c5.apiFramework; } catch (e) { deleteThrew = true; }
  assert(c5.apiFramework === 6, 'G10: container.apiFramework survives delete attempt');

  // G10: both descriptors report configurable:false.
  const pubDesc = Object.getOwnPropertyDescriptor(c5, 'apiFramework');
  assert(pubDesc && pubDesc.configurable === false,
    'G10: public apiFramework property descriptor reports configurable: false');
  const privDesc = Object.getOwnPropertyDescriptor(c5, '_apiFramework');
  assert(privDesc && privDesc.writable === false && privDesc.configurable === false,
    'G10: private _apiFramework descriptor reports writable: false AND configurable: false');
}

// -- 15. G12 SHARC supersession — _mapAdComApisToBridges --------------------
{
  console.log('\n15. G12 SHARC supersession — bridge resolver inhibits MRAID/SafeFrame when SHARC declared');

  const map = (apis) => SHARCContainer._mapAdComApisToBridges(apis);

  // Baseline (no SHARC code): unchanged from 0.7.1.
  assertDeepEqual(map([6]), ['mraid'],            'MRAID 3.0 alone → ["mraid"]');
  assertDeepEqual(map([3, 5, 6]), ['mraid'],      'MRAID family → ["mraid"] (deduped)');

  // SHARC alone: empty (SHARC is runtime, not a bridge).
  assertDeepEqual(map([SHARC_API_CODE]), [],      'SHARC alone → [] (runtime, not bridge)');

  // SHARC + MRAID → MRAID inhibited (G12).
  assertDeepEqual(map([6, SHARC_API_CODE]), [],   '[MRAID 3.0, SHARC] → [] (MRAID superseded)');
  assertDeepEqual(map([3, 5, 6, SHARC_API_CODE]), [],
    '[MRAID 1/2/3, SHARC] → [] (all MRAID variants superseded)');

  // SafeFrame alone → ['safeframe'] (Fix 3 in PR 1: completes picker↔bridge symmetry).
  assertDeepEqual(map([SAFEFRAME_API_CODE]), ['safeframe'],
    'SafeFrame alone → ["safeframe"] (ADCOM_API_TO_BRIDGE now maps SAFEFRAME_API_CODE)');

  // SHARC + SafeFrame → SafeFrame inhibited (G12).
  assertDeepEqual(map([SAFEFRAME_API_CODE, SHARC_API_CODE]), [],
    '[SafeFrame, SHARC] → [] (SafeFrame superseded)');

  // OMID is orthogonal — never superseded (measurement axis).
  // OMID code 7 is NOT a bridge mapping (container extension only).
  assertDeepEqual(map([7, SHARC_API_CODE]), [],
    '[OMID, SHARC] → [] (no OMID bridge mapping, G12 does NOT skip OMID)');

  // No SHARC code present: supersession dormant, MRAID survives.
  assertDeepEqual(map([6, 7]), ['mraid'],         '[MRAID, OMID] → ["mraid"] (no SHARC code, no supersession)');
}

// -- 16. requireSharcInit Rule 11 validation --------------------------------
{
  console.log('\n16. requireSharcInit (Rule 11) — strict boolean validation');

  // Accepted shapes.
  const cTrue = new SHARCContainer(makeMarkupOpts({ requireSharcInit: true }));
  assert(cTrue._requireSharcInit === true,                 'requireSharcInit: true accepted');
  const cFalse = new SHARCContainer(makeMarkupOpts({ requireSharcInit: false }));
  assert(cFalse._requireSharcInit === false,               'requireSharcInit: false accepted');
  const cUndef = new SHARCContainer(makeMarkupOpts({ /* omit */ }));
  assert(cUndef._requireSharcInit === true,                'omitted requireSharcInit → defaults to true');
  const cExplicitUndef = new SHARCContainer(makeMarkupOpts({ requireSharcInit: undefined }));
  assert(cExplicitUndef._requireSharcInit === true,        'requireSharcInit: undefined → defaults to true');

  // Rejected shapes — Rule 11 throws TypeError. No truthy/falsy coercion.
  assertThrows(
    () => new SHARCContainer(makeMarkupOpts({ requireSharcInit: null })),
    /requireSharcInit must be a boolean.*null/,
    'requireSharcInit: null → TypeError (no coercion to true)',
    TypeError
  );
  assertThrows(
    () => new SHARCContainer(makeMarkupOpts({ requireSharcInit: 0 })),
    /requireSharcInit must be a boolean.*number/,
    'requireSharcInit: 0 → TypeError (no truthy/falsy coercion)',
    TypeError
  );
  assertThrows(
    () => new SHARCContainer(makeMarkupOpts({ requireSharcInit: 1 })),
    /requireSharcInit must be a boolean.*number/,
    'requireSharcInit: 1 → TypeError',
    TypeError
  );
  assertThrows(
    () => new SHARCContainer(makeMarkupOpts({ requireSharcInit: '' })),
    /requireSharcInit must be a boolean.*string/,
    'requireSharcInit: "" → TypeError',
    TypeError
  );
  assertThrows(
    () => new SHARCContainer(makeMarkupOpts({ requireSharcInit: 'false' })),
    /requireSharcInit must be a boolean.*string/,
    'requireSharcInit: "false" → TypeError',
    TypeError
  );
  assertThrows(
    () => new SHARCContainer(makeMarkupOpts({ requireSharcInit: {} })),
    /requireSharcInit must be a boolean.*object/,
    'requireSharcInit: {} → TypeError',
    TypeError
  );

  // Accepted alongside both variants.
  const cUrl = new SHARCContainer({
    creativeUrl: 'https://ads.example/c.html',
    placementElement: document.createElement('div'),
    requireSharcInit: false,
  });
  assert(cUrl._requireSharcInit === false,                 'requireSharcInit accepted in Creative URL variant (variant-agnostic)');
}

// -- 17. container.hasSharcSession accessor --------------------------------
{
  console.log('\n17. container.hasSharcSession — outcome-driven boolean accessor');

  const c = new SHARCContainer(makeMarkupOpts({ creativeMeta: { apis: [6] } }));
  assert(c.hasSharcSession === false,
    'hasSharcSession is false before any handshake (no session established)');
  assert(typeof c.hasSharcSession === 'boolean',
    'hasSharcSession returns a primitive boolean (not null/undefined)');

  // Declaration vs outcome — apiFramework and hasSharcSession are independent.
  assert(c.apiFramework === 6, 'apiFramework = 6 (declaration)');
  assert(c.hasSharcSession === false, 'hasSharcSession = false (no outcome yet)');
}

// -- 18. OMID container-owned lifecycle ------------------------------------
{
  console.log('\n18. OMID container-owned lifecycle — extension-owned, not renderer bridge');

  // Render/init path: the container dispatches lifecycle events to the OMID
  // extension. The extension creates and starts the OM SDK Session Client,
  // then fires loaded + impression once the container becomes active.
  {
    const mock = createMockOmidSdk();
    installMockOmidSdk(mock);
    try {
      const omid = new OmidCompatBridge({
        partnerName: 'TestPublisher',
        partnerVersion: '1.2.3',
        creativeType: 'display',
        mediaType: 'display',
        impressionType: 'beginToRender',
        contentUrl: 'https://content.example/ad.html',
        omSdkServiceScriptUrl: 'https://omid.example/omweb-v1.js',
        verificationScripts: [{
          url: 'https://verify.example/omid.js',
          vendor: 'vendor-key',
          verificationParameters: 'params',
          accessMode: 'limited',
        }],
      });
      const c = createOmidTestContainer(omid);
      const lifecycleStates = [];
      const originalLifecycleHook = omid.onContainerLifecycleEvent.bind(omid);
      omid.onContainerLifecycleEvent = (event) => {
        if (event && event.type === 'stateChange') {
          lifecycleStates.push([event.previousState, event.newState]);
        }
        return originalLifecycleHook(event);
      };

      if (typeof c._notifyExtensionsLifecycle === 'function') {
        c._notifyExtensionsLifecycle('load');
      }
      c.setState('ready');
      c.setState('active');

      assertDeepEqual(mock.stats.partnerArgs, ['TestPublisher', '1.2.3'],
        'OMID render/init: Partner constructed from extension options');
      assert(mock.stats.verificationScripts && mock.stats.verificationScripts.length === 1,
        'OMID render/init: verification scripts converted for OM SDK Context');
      assert(mock.stats.contentUrl === 'https://content.example/ad.html',
        'OMID render/init: Context contentUrl set from extension options');
      assert(mock.stats.serviceScriptUrl === 'https://omid.example/omweb-v1.js',
        'OMID render/init: Context serviceScriptUrl set from extension options');
      assert(mock.stats.creativeType === 'display',
        'OMID render/init: creativeType configured before session start');
      assert(mock.stats.impressionType === 'beginToRender',
        'OMID render/init: impressionType configured before session start');
      assert(mock.stats.registerAdViewArg === c._iframe,
        'OMID render/init: container iframe registered as OMID ad view');
      assert(mock.stats.startCalls === 1,
        'OMID render/init: AdSession.start() called once');
      assert(mock.stats.loadedCalls === 1,
        'OMID render/init: adEvents.loaded() fired once');
      assert(mock.stats.impressionCalls === 1,
        'OMID render/init: adEvents.impressionOccurred() fired once');
      assertDeepEqual(mock.stats.visibilityStates, ['VISIBLE'],
        'OMID render/init: active state signals visible once');
      assertDeepEqual(lifecycleStates, [['loading', 'ready'], ['ready', 'active']],
        'OMID render/init: container setState propagates stateChange lifecycle events to extension');
      assertDeepEqual([...c.bridges], [],
        'OMID render/init: AdCOM 7 does not add "omid" to renderer bridges');
    } finally {
      uninstallMockOmidSdk();
    }
  }

  // Teardown/error path: error/destroy/terminated lifecycle events may arrive
  // in close succession. The OMID session finish must remain idempotent.
  {
    const mock = createMockOmidSdk();
    installMockOmidSdk(mock);
    try {
      const omid = new OmidCompatBridge({
        creativeType: 'display',
        mediaType: 'display',
      });
      const c = createOmidTestContainer(omid);

      c.setState('ready');
      c.setState('active');
      c._notifyExtensionsLifecycle('error', { errorCode: 1234, errorMessage: 'synthetic' });
      c._notifyExtensionsLifecycle('error', { errorCode: 1234, errorMessage: 'synthetic again' });
      c._notifyExtensionsLifecycle('destroy');
      omid.destroy();

      assert(mock.stats.startCalls === 1,
        'OMID teardown/error: session started before teardown');
      assert(mock.stats.finishCalls === 1,
        'OMID teardown/error: AdSession.finish() called exactly once across repeated teardown signals');
      assert(omid._omid.sessionStarted === false && omid._omid.sessionFinished === true,
        'OMID teardown/error: extension state remains finished after repeated teardown');
    } finally {
      uninstallMockOmidSdk();
    }
  }

  // Lock the negative bridge contract next to the lifecycle tests: OMID is
  // container-owned measurement, not a creative-side renderer bridge.
  assertThrows(
    () => new SHARCContainer(markupOptions({ bridges: ['omid'] })),
    /not a recognized bridge identifier/,
    'OMID bridge contract: explicit bridges ["omid"] remains invalid',
    Error,
  );
  assertDeepEqual(SHARCContainer._mapAdComApisToBridges([7]), [],
    'OMID bridge contract: AdCOM APIFramework 7 remains unmapped to renderer bridges');
  assertDeepEqual(SHARCContainer._resolveBridges({ creativeMeta: { apis: [7] }, creativeHtml: 'plain' }), [],
    'OMID bridge contract: creativeMeta.apis=[7] resolves to no renderer bridge');
}

// -- 19. baseUrl validation — defense-in-depth (issue #140) ──────────────────
console.log('\n19. baseUrl validation — defense-in-depth on MRAID / SafeFrame / OMID bridges');
{
  // Cross-bridge parity: all three bridges must enforce identical baseUrl
  // contract. Iterating here (rather than copy-pasting the matrix into
  // test-omid-container-lifecycle.js §G10d) ensures any future security fix
  // that lands in one validator can't silently miss the others.
  const cases = [
    { ctor: MRAIDCompatBridge,     label: 'MRAIDCompatBridge' },
    { ctor: SafeFrameCompatBridge, label: 'SafeFrameCompatBridge' },
    { ctor: OmidCompatBridge,      label: 'OmidCompatBridge' },
  ];

  for (const { ctor, label } of cases) {
    // -- Scheme-based rejections ---------------------------------------------
    assertThrows(
      () => new ctor({ baseUrl: 'javascript:alert(1)//' }),
      /javascript: scheme/,
      `${label}: rejects javascript: baseUrl`,
      TypeError,
    );
    assertThrows(
      () => new ctor({ baseUrl: 'data:text/html,<script>alert(1)</script>' }),
      /data: scheme/,
      `${label}: rejects data: baseUrl`,
      TypeError,
    );
    assertThrows(
      () => new ctor({ baseUrl: 'vbscript:msgbox("x")' }),
      /vbscript: scheme/,
      `${label}: rejects vbscript: baseUrl`,
      TypeError,
    );
    // Direct file:/blob: scheme rejection — covered by the validator's
    // dangerousSchemes set, asserted explicitly here so the contract is
    // visible at the test layer (not just inferred from the rule docs).
    assertThrows(
      () => new ctor({ baseUrl: 'file:///etc/passwd' }),
      /file: scheme/,
      `${label}: rejects file: baseUrl`,
      TypeError,
    );
    assertThrows(
      () => new ctor({ baseUrl: 'blob:https://example/uuid' }),
      /blob: scheme/,
      `${label}: rejects blob: baseUrl`,
      TypeError,
    );

    // -- Userinfo / non-HTTPS / non-string -----------------------------------
    assertThrows(
      () => new ctor({ baseUrl: 'https://user:pw@cdn.example/' }),
      /userinfo/,
      `${label}: rejects userinfo in absolute baseUrl`,
      TypeError,
    );
    assertThrows(
      () => new ctor({ baseUrl: 'http://cdn.example/' }),
      /HTTPS/,
      `${label}: rejects non-HTTPS absolute baseUrl`,
      TypeError,
    );
    assertThrows(
      () => new ctor({ baseUrl: 42 }),
      /must be a string/,
      `${label}: rejects non-string baseUrl`,
      TypeError,
    );

    // -- Leading-whitespace scheme bypass ------------------------------------
    // WHATWG URL parser strips C0+space, so `'\tjavascript:alert(1)'` would
    // otherwise parse as javascript:.
    assertThrows(
      () => new ctor({ baseUrl: '\tjavascript:alert(1)' }),
      /javascript: scheme/,
      `${label}: rejects leading-tab javascript: bypass`,
      TypeError,
    );
    // Null-byte leading-whitespace variant — locks the same contract for the
    // \x00 case that the existing trim regex (`[\x00-\x20]`) already covers.
    assertThrows(
      () => new ctor({ baseUrl: '\x00javascript:alert(1)' }),
      /javascript: scheme/,
      `${label}: rejects leading-null-byte javascript: bypass`,
      TypeError,
    );

    // -- Embedded-whitespace scheme bypass (must-fix #2) ---------------------
    // After trim, embedded tab/control chars must be rejected — otherwise a
    // future WHATWG-parser sink strips them and rehydrates as javascript:.
    assertThrows(
      () => new ctor({ baseUrl: 'jav\tascript:alert(1)' }),
      /embedded control characters/,
      `${label}: rejects embedded-tab scheme bypass`,
      TypeError,
    );
    assertThrows(
      () => new ctor({ baseUrl: 'Java\tScript:alert(1)' }),
      /embedded control characters/,
      `${label}: rejects embedded-tab + case-variant scheme bypass`,
      TypeError,
    );

    // -- Protocol-relative URLs (must-fix #1) --------------------------------
    // `//host/…` resolves against the page protocol in an href/srcdoc sink,
    // fetching from attacker-controlled origin.
    assertThrows(
      () => new ctor({ baseUrl: '//evil.example/sharc' }),
      /protocol-relative/,
      `${label}: rejects protocol-relative // baseUrl`,
      TypeError,
    );
    // Backslash-prefix variant — browsers normalize backslashes to forward
    // slashes in special-scheme contexts.
    assertThrows(
      () => new ctor({ baseUrl: '\\\\evil.test/x' }),
      /protocol-relative/,
      `${label}: rejects protocol-relative \\\\ baseUrl`,
      TypeError,
    );

    // -- Whitespace-only baseUrl (must-fix #3) -------------------------------
    // `'   '` trims to empty; without the empty-check it would bypass scheme
    // detection and be returned verbatim, propagating whitespace into the URL.
    assertThrows(
      () => new ctor({ baseUrl: '   ' }),
      /empty or whitespace/,
      `${label}: rejects whitespace-only baseUrl`,
      TypeError,
    );

    // -- Acceptance cases — must not throw -----------------------------------
    let ok = true;
    try { new ctor(); }                                              catch (e) { ok = false; }
    try { new ctor({}); }                                            catch (e) { ok = false; }
    try { new ctor({ baseUrl: undefined }); }                        catch (e) { ok = false; }
    try { new ctor({ baseUrl: null }); }                             catch (e) { ok = false; }
    try { new ctor({ baseUrl: '/sharc' }); }                         catch (e) { ok = false; }
    try { new ctor({ baseUrl: '/custom/path' }); }                   catch (e) { ok = false; }
    try { new ctor({ baseUrl: 'sharc' }); }                          catch (e) { ok = false; }
    try { new ctor({ baseUrl: './sharc' }); }                        catch (e) { ok = false; }
    try { new ctor({ baseUrl: 'https://cdn.example/sharc' }); }      catch (e) { ok = false; }
    assert(ok, `${label}: accepts undefined / null / path-relative / valid HTTPS baseUrl`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} bridges-detection assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All bridges-detection assertions passed.');
}
