/**
 * test-mraid-open-tel-sms-policy.js — Slice E5 (revised): MRAID tel:/sms: are
 * DECLINED as a deliberate legacy exclusion (§3), NOT operator-gated.
 *
 * Ratified contract (Jeffrey 2026-07-05, supersedes the earlier "operator opt-in"
 * model for #394):
 *   - tel:/sms: are declared UNSUPPORTED. They join the existing §3 exclusions
 *     (calendar/storePicture/inlineVideo/vpaid): ad-initiated call/text predates
 *     OS-level permission prompts + user-activation, so SHARC — a clean-slate
 *     spec — declines them outright.
 *   - supports('tel'/'sms') === false ALWAYS — hardcoded, ignoring any capability
 *     string. An operator CANNOT advertise them (lock the door).
 *   - open('tel:…'/'sms:…') rejects via the `error` event (action 'open',
 *     E1-replayable) in ALL configurations — no capability exception.
 *   - The #394 invariant now holds HONESTLY: supports(scheme) === (open honors
 *     scheme) = false === rejects, matching the container (which already rejects
 *     tel/sms). The whole system is consistent.
 *
 * KEY REGRESSION GUARD (the lock-the-door pin): supports('tel'/'sms') stays false
 *   and open('tel:'/'sms:') stays rejected EVEN WHEN the operator sets
 *   supportedFeatures: ['com.iabtechlab.sharc.tel','com.iabtechlab.sharc.sms'].
 *   On the prior (398ebb1) enable-direction code this would have reported true /
 *   navigated — this suite discriminates the revert.
 *
 * SECURITY MUST-STAY: javascript:/data:/vbscript:/file:/blob: stay rejected;
 *   https:/http: keep working — in ALL capability configurations.
 *
 * Harness mirrors test-mraid-bridge-correctness-e2.js: a fresh fake SHARC host +
 * a fresh bridge per case, driving real window.mraid paths against the built
 * bundle (cache-busting import query). The `enabledFeatures` knob feeds
 * SHARC.hasFeature so a case can attempt (futilely) to advertise tel/sms.
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
 * @param {{ enabledFeatures?: string[] }} [opts] - capability strings an operator
 *   attempts to advertise via supportedFeatures. For tel/sms these are IGNORED
 *   (the door is locked); the knob exists to prove they cannot re-enable.
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

console.log('test-mraid-open-tel-sms-policy.js — Slice E5 (revised): tel/sms declined as legacy exclusion (§3)\n');

// ═════════════════════════════════════════════════════════════════════════
// A — DEFAULT (stock, no capabilities): supports false AND open() rejects
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('A — DEFAULT (stock): supports(tel/sms)===false AND open(tel:/sms:) reject (consistent):');
  const h = await makeBridge(); // no enabledFeatures
  h.fireReady();
  await tick();

  check(h.mraid.supports('tel') === false, 'supports("tel")===false (declined §3)');
  check(h.mraid.supports('sms') === false, 'supports("sms")===false (declined §3)');

  const tel = await openAndObserve(h, 'tel:+15551234');
  check(tel.errored && !tel.navigated, 'open("tel:+15551234") rejects (error action "open", no navigation)');

  const sms = await openAndObserve(h, 'sms:+15551234');
  check(sms.errored && !sms.navigated, 'open("sms:+15551234") rejects (error action "open", no navigation)');
}

// ═════════════════════════════════════════════════════════════════════════
// B — LOCK THE DOOR (key regression guard): even WITH the operator advertising
//     com.iabtechlab.sharc.tel/.sms, supports stays false AND open() rejects.
//     This is the discriminator vs the prior enable-direction (398ebb1) code.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nB — LOCK THE DOOR: capability strings set, yet tel/sms stay declined:');
  const h = await makeBridge({ enabledFeatures: [TEL_FEATURE, SMS_FEATURE] });
  h.fireReady();
  await tick();

  check(h.mraid.supports('tel') === false,
    'supports("tel")===false EVEN WITH com.iabtechlab.sharc.tel advertised (cannot re-enable)');
  check(h.mraid.supports('sms') === false,
    'supports("sms")===false EVEN WITH com.iabtechlab.sharc.sms advertised (cannot re-enable)');

  const tel = await openAndObserve(h, 'tel:+15551234');
  check(tel.errored && !tel.navigated,
    'open("tel:…") STILL rejects (no navigation) despite the capability being set');

  const sms = await openAndObserve(h, 'sms:+15551234');
  check(sms.errored && !sms.navigated,
    'open("sms:…") STILL rejects (no navigation) despite the capability being set');
}

// ═════════════════════════════════════════════════════════════════════════
// B2 — the reject names the real reason (legacy/unsupported scheme), not the
//      misleading "requires http/https". Addresses the code-review nit.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nB2 — reject message names tel/sms as the reason (not a misleading https hint):');
  const h = await makeBridge();
  h.fireReady();
  await tick();

  const errs = [];
  h.setNavigation((req) => { req; return Promise.resolve(); });
  h.mraid.addEventListener('error', (msg, action) => errs.push({ msg, action }));
  h.mraid.open('tel:+15551234');
  await tick();
  const openErr = errs.find((e) => e.action === 'open');
  check(!!openErr, 'tel: reject fires an error with action "open"');
  const m = (openErr && openErr.msg) || '';
  check(/tel:\/sms:|tel\/sms|legacy|unsupported/i.test(m),
    `reject message names the real reason (got: ${JSON.stringify(m)})`);
}

// ═════════════════════════════════════════════════════════════════════════
// C — INVARIANT (#394 item 3, now honest): supports(scheme) === (open honors
//     scheme) — here false === rejects — for BOTH schemes, in BOTH capability
//     configurations. Matches the container's own tel/sms rejection.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nC — INVARIANT: supports(scheme) === (open honors scheme) = false === rejects, both configs:');
  for (const state of [
    { label: 'no-caps', enabled: [] },
    { label: 'caps-set', enabled: [TEL_FEATURE, SMS_FEATURE] },
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
      check(supported === false && openHonors === false && supported === openHonors,
        `[${state.label}] supports("${scheme}")===false equals open-honors===false (invariant holds honestly)`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// D — SECURITY MUST-STAY: dangerous schemes rejected in BOTH configs;
//     https/http still work in BOTH configs.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nD — SECURITY: dangerous schemes rejected in BOTH configs; https/http still honored:');
  const DANGEROUS = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://evil.example/uuid',
  ];
  const SAFE = ['https://example.com/path', 'http://example.com/path'];

  for (const state of [
    { label: 'no-caps', enabled: [] },
    { label: 'caps-set', enabled: [TEL_FEATURE, SMS_FEATURE] },
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
// E — scheme match is case-insensitive prefix-exact; a mid-string "tel:" is
//     NOT the tel scheme and stays judged by the https-only rule.
// ═════════════════════════════════════════════════════════════════════════
{
  console.log('\nE — scheme match is case-insensitive prefix-exact:');
  {
    const h = await makeBridge({ enabledFeatures: [TEL_FEATURE, SMS_FEATURE] });
    h.fireReady();
    await tick();
    const upper = await openAndObserve(h, 'TEL:+15551234');
    check(upper.errored && !upper.navigated,
      'open("TEL:…") rejected (case-insensitive scheme match) even with caps set');
  }
  {
    // A URL that merely CONTAINS "tel:" mid-string is NOT a tel: scheme; it is
    // judged by the https-only rule (rejected here — not https).
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
console.log('PASS — all tel/sms decline (§3 legacy exclusion) checks passed');
