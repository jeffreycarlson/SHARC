/**
 * test-mraid-open-tel-sms-policy.js — Slice E5: MRAID open() tel:/sms: scheme
 * policy (#394 item 2 + item 3 invariant). The trim/type-guard portion (item 1)
 * landed in E2; this suite owns ONLY the scheme policy.
 *
 * Ratified contract (#394, Jeffrey 2026-06-12 / reconfirmed 2026-07-05):
 *   - tel:/sms: DEFAULT OFF. Operator opt-in rides the SAME capability-string
 *     transport supports() already mirrors: the `supportedFeatures` constructor
 *     option adds `com.iabtechlab.sharc.sms` / `.tel`, which reaches the creative
 *     via Container:init and is queried by SHARC.hasFeature(). The bridge's
 *     supports('sms'/'tel') already delegates to hasFeature — so the "operator
 *     flag" is that feature string, not a new boolean option.
 *   - supports(scheme) MUST equal "open() will honor this scheme" for BOTH gated
 *     schemes in BOTH flag states (#394 item 3 invariant). Today supports()
 *     returns true (via hasFeature) while open()'s https-only allowlist rejects
 *     tel:/sms: unconditionally — supports() LIES. Fix: gate a narrow tel:/sms:
 *     allowlist exception on the SAME hasFeature signal.
 *
 * SECURITY MUST-STAY: enabling tel/sms does NOT weaken any dangerous-scheme
 *   rejection. javascript:/data:/vbscript:/file:/blob: stay rejected in BOTH
 *   flag states; https:/http: keep working in BOTH states. The tel/sms exception
 *   is scheme-exact (tel:/sms: prefix, case-insensitive) and flag-gated — nothing
 *   more.
 *
 * Harness mirrors test-mraid-bridge-correctness-e2.js: a fresh fake SHARC host +
 * a fresh bridge per case, driving real window.mraid paths against the built
 * bundle (cache-busting import query). The ONE harness delta vs E2 is a
 * per-feature-controllable hasFeature so a single bridge can model flag ON/OFF.
 */

const BRIDGE_URL = '../../dist/sharc-mraid-bridge.mjs';

const TEL_FEATURE = 'com.iabtechlab.sharc.tel';
const SMS_FEATURE = 'com.iabtechlab.sharc.sms';

let nonce = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

const DEFAULT_ENV = {
  currentPlacement: {
    initialDefaultSize: { width: 320, height: 50 },
    maxExpandSize: { width: 1024, height: 768 },
    viewportSize: { width: 1024, height: 768 },
  },
  initialPosition: { x: 0, y: 0, width: 320, height: 50 },
  data: { placement: { instl: 0 }, app: { bundle: 'test-app' } },
  isMuted: false,
  volume: 1,
};

/**
 * @param {{ enabledFeatures?: string[] }} [opts] - capability strings the
 *   operator opted into via supportedFeatures. Omit/empty ⇒ flag OFF (default).
 */
async function makeBridge(opts) {
  const enabled = new Set((opts && opts.enabledFeatures) || []);
  const readyCallbacks = [];
  const eventListeners = {};
  let navigated = null;

  const SHARC = {
    onReady(cb) { readyCallbacks.push(cb); },
    onStart() {},
    on(name, cb) {
      eventListeners[name] = eventListeners[name] || [];
      eventListeners[name].push(cb);
    },
    hasFeature(name) { return enabled.has(name); },
    requestNavigation(req) { navigated = req; return Promise.resolve(); },
    requestPlacementChange() { return Promise.resolve(); },
    requestClose() { return Promise.resolve(); },
  };

  globalThis.location = { protocol: 'http:', hostname: 'localhost' };
  globalThis.window = {
    __sharcMraidBridgeAutoInstall: true,
    SHARC,
    innerWidth: 375,
    innerHeight: 667,
    document: { readyState: 'complete' },
  };

  await import(`${BRIDGE_URL}?e5=${Date.now()}-${nonce++}`);

  const win = globalThis.window;
  return {
    mraid: win.mraid,
    SHARC,
    fireReady: (env) => readyCallbacks[0](env || DEFAULT_ENV),
    getNavigated: () => navigated,
    setNavigation: (fn) => { SHARC.requestNavigation = fn; },
  };
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.error('  ✗', msg); failures++; }
}

/**
 * Drives open(url) and reports { navigated, errored }: whether the scheme
 * reached the container navigation path vs. fired an MRAID `error` (action
 * 'open'). Mutually exclusive by design — a honored scheme navigates and does
 * not error; a rejected scheme errors and does not navigate.
 */
async function openAndObserve(h, url) {
  let navigated = null;
  const errs = [];
  h.setNavigation((req) => { navigated = req; return Promise.resolve(); });
  h.mraid.addEventListener('error', (msg, action) => errs.push({ msg, action }));
  h.mraid.open(url);
  await tick();
  return {
    navigated,
    errored: errs.some((e) => e.action === 'open'),
  };
}

console.log('test-mraid-open-tel-sms-policy.js — Slice E5: open() tel/sms scheme policy (#394 item 2/3)\n');

// ═════════════════════════════════════════════════════════════════════════
// A — DEFAULT (flag OFF / unset): supports false AND open() rejects
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('A — DEFAULT OFF: supports(tel/sms)===false AND open(tel:/sms:) reject (consistent):');
  const h = await makeBridge(); // no enabledFeatures ⇒ operator did not opt in
  h.fireReady();
  await tick();

  check(h.mraid.supports('tel') === false, 'supports("tel")===false when operator did not opt in');
  check(h.mraid.supports('sms') === false, 'supports("sms")===false when operator did not opt in');

  const tel = await openAndObserve(h, 'tel:+15551234');
  check(tel.errored && !tel.navigated, 'open("tel:+15551234") rejects (error action "open", no navigation) when OFF');

  const sms = await openAndObserve(h, 'sms:+15551234');
  check(sms.errored && !sms.navigated, 'open("sms:+15551234") rejects (error action "open", no navigation) when OFF');
}

// ═════════════════════════════════════════════════════════════════════════
// B — FLAG ON: supports true AND open() passes the scheme through
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nB — FLAG ON: supports(tel/sms)===true AND open(tel:/sms:) reach the navigation path:');
  const h = await makeBridge({ enabledFeatures: [TEL_FEATURE, SMS_FEATURE] });
  h.fireReady();
  await tick();

  check(h.mraid.supports('tel') === true, 'supports("tel")===true when operator opted in');
  check(h.mraid.supports('sms') === true, 'supports("sms")===true when operator opted in');

  const tel = await openAndObserve(h, 'tel:+15551234');
  check(tel.navigated && tel.navigated.url === 'tel:+15551234' && !tel.errored,
    'open("tel:…") passes the scheme to requestNavigation (no error) when ON');

  const sms = await openAndObserve(h, 'sms:+15551234');
  check(sms.navigated && sms.navigated.url === 'sms:+15551234' && !sms.errored,
    'open("sms:…") passes the scheme to requestNavigation (no error) when ON');
}

// ═════════════════════════════════════════════════════════════════════════
// B2 — asymmetric opt-in: tel ON, sms OFF gates each scheme independently
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nB2 — asymmetric opt-in (tel ON, sms OFF): each scheme gated independently:');
  const h = await makeBridge({ enabledFeatures: [TEL_FEATURE] });
  h.fireReady();
  await tick();

  check(h.mraid.supports('tel') === true, 'supports("tel")===true (tel opted in)');
  check(h.mraid.supports('sms') === false, 'supports("sms")===false (sms NOT opted in)');

  const tel = await openAndObserve(h, 'tel:+15551234');
  check(tel.navigated && !tel.errored, 'open("tel:…") honored (tel ON)');

  const sms = await openAndObserve(h, 'sms:+15551234');
  check(sms.errored && !sms.navigated, 'open("sms:…") rejected (sms OFF) even though tel is ON');
}

// ═════════════════════════════════════════════════════════════════════════
// C — INVARIANT (#394 item 3): supports(scheme) === "open() honors scheme"
//     for BOTH schemes in BOTH flag states, BOTH directions.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nC — INVARIANT: supports(scheme) === (open honors scheme), both schemes, both states:');
  for (const state of [
    { label: 'OFF', enabled: [] },
    { label: 'ON', enabled: [TEL_FEATURE, SMS_FEATURE] },
  ]) {
    for (const [scheme, url] of [
      ['tel', 'tel:+15551234'],
      ['sms', 'sms:+15551234'],
    ]) {
      const h = await makeBridge({ enabledFeatures: state.enabled });
      h.fireReady();
      await tick();
      const supported = h.mraid.supports(scheme);
      const res = await openAndObserve(h, url);
      const openHonors = !!res.navigated && !res.errored;
      check(supported === openHonors,
        `[${state.label}] supports("${scheme}")===${supported} equals open-honors===${openHonors} (invariant holds)`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// D — SECURITY MUST-STAY: dangerous schemes rejected in BOTH flag states;
//     https/http still work in BOTH states. Enabling tel/sms opened no hole.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nD — SECURITY: dangerous schemes rejected in BOTH states; https/http still honored:');
  const DANGEROUS = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://evil.example/uuid',
  ];
  const SAFE = ['https://example.com/path', 'http://example.com/path'];

  for (const state of [
    { label: 'OFF', enabled: [] },
    { label: 'ON', enabled: [TEL_FEATURE, SMS_FEATURE] },
  ]) {
    for (const bad of DANGEROUS) {
      const h = await makeBridge({ enabledFeatures: state.enabled });
      h.fireReady();
      await tick();
      const res = await openAndObserve(h, bad);
      check(res.errored && !res.navigated,
        `[${state.label}] open(${JSON.stringify(bad)}) REJECTS (no navigation) — dangerous scheme stays closed`);
    }
    for (const ok of SAFE) {
      const h = await makeBridge({ enabledFeatures: state.enabled });
      h.fireReady();
      await tick();
      const res = await openAndObserve(h, ok);
      check(res.navigated && res.navigated.url === ok && !res.errored,
        `[${state.label}] open(${JSON.stringify(ok)}) still navigates — https/http unaffected`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// E — case-insensitive scheme match; not-a-prefix substrings stay rejected.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nE — scheme match is case-insensitive prefix-exact (ON state):');
  {
    const h = await makeBridge({ enabledFeatures: [TEL_FEATURE, SMS_FEATURE] });
    h.fireReady();
    await tick();
    const upper = await openAndObserve(h, 'TEL:+15551234');
    check(upper.navigated && !upper.errored, 'open("TEL:…") honored (case-insensitive scheme) when ON');
  }
  {
    // A URL that merely CONTAINS "tel:" mid-string is NOT a tel: scheme and must
    // still be judged by the https-only rule (rejected here — not https).
    const h = await makeBridge({ enabledFeatures: [TEL_FEATURE, SMS_FEATURE] });
    h.fireReady();
    await tick();
    const notScheme = await openAndObserve(h, 'httptel:+15551234');
    check(notScheme.errored && !notScheme.navigated,
      'open("httptel:…") rejected — "tel:" mid-string is not the tel scheme (prefix-exact)');
  }
}

console.log('');
if (failures > 0) {
  console.error(`FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('PASS — all tel/sms open() scheme-policy checks passed');
