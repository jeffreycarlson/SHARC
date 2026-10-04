#!/usr/bin/env node

/**
 * G3 real-binary gate (#486), OPERATOR-RUN. Not in CI: the pinned omweb-v1.js
 * is portal-gated and never committed (tools/creative-validator/VENDORED.md).
 *
 *   SHARC_OMSDK_VENDOR_DIR=/path/to/private/vendor npm run test:g3-omweb-real
 *
 * Default vendor dir: tools/creative-validator/private/vendor. Both files must
 * match the SHA-256 pins in VENDORED.md, or the gate fails (an unpinned binary
 * proves nothing). With no binaries present every case SKIPS loudly; a skip is
 * never G3 evidence.
 *
 * What only this gate proves (the CI stand-in cannot): the REAL omweb-v1 1.5.2
 * measures the SHARC creative iframe through the real session client 1.6.6 and
 * the shipped OmidCompatBridge, and a SERVICE-injected verification script
 * (the DV / Pixalate channel) receives geometryChange with a correct adView.
 * It also checks the CI stand-in has not drifted from the real client surface.
 *
 * Page: 800x600 viewport, a 300x250 slot at y=100, the bridge driven through
 * its container lifecycle hooks (the same seam SHARCContainer uses).
 *
 * RED on main 655cab5 (no slot element, no bounds): 0 service geometryChange.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RECORDED_SURFACE } from './omsdk-web-standin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENDOR_DIR = process.env.SHARC_OMSDK_VENDOR_DIR
  || path.join(ROOT, 'tools/creative-validator/private/vendor');
const OMWEB = path.join(VENDOR_DIR, 'omweb-v1.js');
const CLIENT = path.join(VENDOR_DIR, 'omid-session-client-v1.js');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HAVE_BINARIES = fs.existsSync(OMWEB) && fs.existsSync(CLIENT);
const SKIP = HAVE_BINARIES ? false
  : 'SKIPPED, NOT EVIDENCE: pinned OM SDK binaries not found in ' + VENDOR_DIR;

function pins() {
  const manifest = fs.readFileSync(path.join(ROOT, 'tools/creative-validator/VENDORED.md'), 'utf8');
  const row = (name) => new RegExp('`private/vendor/' + name.replace('.', '\\.') + '`[^|]*\\|[^|]*\\|\\s*`([0-9a-f]{64})`').exec(manifest)[1];
  return { [OMWEB]: row('omweb-v1.js'), [CLIENT]: row('omid-session-client-v1.js') };
}

// Service-injected verification script: subscribes over the service channel,
// exactly like a service-path vendor.
const SERVICE_VENDOR = `(function(){
  var p = window.omidVerificationProperties || {}; var sw = p.serviceWindow || window.parent; var inj = p.injectionId || '';
  var pend = {}, seq = 0;
  function rep(x){ try { window.top.postMessage({ __gate: 1, x: x }, '*'); } catch(_){} }
  function send(m,a,cb){ var g='gate-'+(++seq); pend[g]=cb; sw.postMessage({omid_message_guid:g,omid_message_method:m,omid_message_version:'1.0.3',omid_message_args:a},'*'); }
  window.addEventListener('message', function(ev){ var d=ev.data; if(!d||d.omid_message_method!=='response')return; var cb=pend[d.omid_message_guid]; if(!cb)return; var a=d.omid_message_args; if(typeof a==='string'){try{a=JSON.parse(a)}catch(_){a=[]}} cb.apply(null,a||[]); });
  send('VerificationService.addSessionListener',['gate',inj],function(e){ rep({type:e&&e.type,adSessionId:e&&e.adSessionId,data:e&&e.data}); });
  ['impression','loaded','geometryChange'].forEach(function(t){ send('VerificationService.addEventListener',[t,inj],function(e){ rep({type:t,adSessionId:e&&e.adSessionId,data:e&&e.data}); }); });
})();`;

function page(omweb, client, sameTask) {
  return `<!doctype html><html><body style="margin:0;height:3000px">
<div id="slot" style="position:relative;width:300px;height:250px;margin-top:100px"><iframe id="ad" srcdoc="<p>ad</p>" style="width:100%;height:100%;border:0;display:block"></iframe></div>
<script>${omweb}</script><script>${client}</script>
<script type="module">
window.__svc = [];
window.addEventListener('message', function (e) { if (e.data && e.data.__gate) window.__svc.push(e.data.x); });
const { OmidCompatBridge } = await import('/src/sharc-omid-bridge.js');
const iframe = document.getElementById('ad');
const container = {
  placementSessionId: 'gate-placement-session', _iframe: iframe, _rendererOrigin: null,
  environmentData: { publisherContext: { pageUrl: 'https://publisher.example/', domain: 'publisher.example', bundleId: '', platform: 'web' } },
  protocolRouter: { buildOutbound(p, t, x) { return Object.assign({ type: p + t }, x); } },
  getState() { return window.__state; }, _onOmidLifecycleSignal() {},
};
const bridge = new OmidCompatBridge({ partnerName: 'sharc', partnerVersion: '0.7.14', creativeType: 'htmlDisplay',
  impressionType: 'beginToRender', mediaType: 'display',
  verificationScripts: [{ resourceUrl: 'https://vendor.example/service-vendor.js', vendor: 'gate', accessMode: 'limited' }] });
window.__bridge = bridge;
const ev = (type, extra) => bridge.onContainerLifecycleEvent(Object.assign({ type, container }, extra || {}));
window.__state = 'ready'; ev('stateChange', { newState: 'ready', previousState: 'loading' });
ev('effectiveVisibilityChange', { payload: { effectivePercent: 100, reason: null, visibleRectangle: null } });
// ACTIVE follows READY by a layout/IO tick in a real placement (ACTIVE needs the
// iframe load + an intersection report); omweb measures from its own observer,
// which also needs that tick. The same-task case is the late-SDK-load
// catch-up, covered by the impression-timing case below.
const activate = function () { window.__state = 'active'; ev('stateChange', { newState: 'active', previousState: 'ready' }); };
if (${sameTask ? 'true' : 'false'}) activate(); else setTimeout(activate, 500);
window.__clientSurface = (function () {
  const O = window.OmidSessionClient['default'];
  const names = (C) => Object.getOwnPropertyNames(C.prototype).filter((n) => n !== 'constructor' && !n.endsWith('_')).sort();
  return { Context: names(O.Context), AdSession: names(O.AdSession), AdEvents: names(O.AdEvents), MediaEvents: names(O.MediaEvents) };
})();
window.__resize = function () { document.getElementById('slot').style.height = '600px'; ev('placementChange', { intent: 'resize' }); };
window.__ready = true;
</script></body></html>`;
}

async function runGate({ sameTask = false } = {}) {
  const omweb = fs.readFileSync(OMWEB, 'utf8');
  const client = fs.readFileSync(CLIENT, 'utf8');
  const { default: puppeteer } = await import('puppeteer-core');
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/src/')) {
      res.setHeader('content-type', 'text/javascript');
      res.end(fs.readFileSync(path.join(ROOT, req.url)));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(page(omweb, client, sameTask));
  });
  await new Promise((r) => server.listen(0, r));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const pg = await browser.newPage();
    await pg.setViewport({ width: 800, height: 600 });
    await pg.setRequestInterception(true);
    pg.on('request', (r) => (r.url().startsWith('https://vendor.example/')
      ? r.respond({ status: 200, contentType: 'text/javascript', body: SERVICE_VENDOR })
      : r.continue()));
    await pg.goto(`http://localhost:${server.address().port}/`);
    await pg.waitForFunction('window.__ready === true', { timeout: 10000 });
    const snap = async (ms) => { await new Promise((r) => setTimeout(r, ms)); return pg.evaluate(() => window.__svc.slice()); };
    const atStart = await snap(1500);
    await pg.evaluate(() => window.__resize());
    const afterResize = await snap(1200);
    await pg.evaluate(() => window.scrollTo(0, 400));
    const afterScroll = await snap(1200);
    const info = await pg.evaluate(() => ({
      surface: window.__clientSurface,
      relayId: window.__bridge._omidAdSessionId(),
      sdkId: window.__bridge._omid.adSession ? window.__bridge._omid.adSession.getAdSessionId() : null,
    }));
    return { atStart, afterResize, afterScroll, info, pageUrl: pg.url() };
  } finally {
    await browser.close();
    server.close();
  }
}

let resultPromise = null;
const result = () => (resultPromise ||= runGate());
let sameTaskPromise = null;
const sameTaskResult = () => (sameTaskPromise ||= runGate({ sameTask: true }));
const geo = (evs) => evs.filter((e) => e.type === 'geometryChange');
const lastPct = (evs) => { const g = geo(evs).at(-1); return g ? g.data.adView.percentageInView : null; };

test('G3 real gate: pinned binaries match VENDORED.md', { skip: SKIP }, () => {
  for (const [file, pin] of Object.entries(pins())) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(actual, pin, 'unpinned binary at ' + file + ' proves nothing; re-pin and rerun the corpus');
  }
});

test('G3 real gate: CI stand-in surface has not drifted from the real session client', { skip: SKIP }, async () => {
  const { surface } = (await result()).info;
  // Context's recorded list also carries its real instance fields, so only
  // the prototype direction is checked there; the other classes must match.
  const contextMethods = RECORDED_SURFACE.Context.filter((n) => n.startsWith('set'));
  assert.deepEqual(surface.Context, contextMethods.sort(), 'Context prototype drifted from RECORDED_SURFACE');
  for (const k of ['AdSession', 'AdEvents', 'MediaEvents']) {
    assert.deepEqual(surface[k], [...RECORDED_SURFACE[k]].sort(), k + ' prototype drifted from RECORDED_SURFACE');
  }
});

test('G3 real gate: service-path vendor gets geometryChange with a correct adView at session start', { skip: SKIP }, async () => {
  const { atStart } = await result();
  assert.ok(geo(atStart).length > 0,
    'G3 #486: real omweb sent 0 geometryChange to the service-path vendor (no slot element / bounds registered)');
  const g = geo(atStart).at(-1).data.adView;
  assert.equal(g.percentageInView, 100);
  assert.deepEqual([g.geometry.x, g.geometry.y, g.geometry.width, g.geometry.height], [0, 100, 300, 250]);
});

test('G3 real gate: service-path impression carries adView (clid)', { skip: SKIP }, async () => {
  const { afterScroll } = await result();
  const imp = afterScroll.find((e) => e.type === 'impression');
  assert.ok(imp && imp.data && imp.data.adView,
    'real omweb impression has no adView (got ' + JSON.stringify(imp && imp.data) + ')');
});

test('G3 real gate: geometry follows resize (bounds update) and scroll', { skip: SKIP }, async () => {
  const { afterResize, afterScroll } = await result();
  assert.equal(lastPct(afterResize), 83, '300x600 at y=100 in a 600px viewport is 83% in view');
  assert.equal(lastPct(afterScroll), 50, 'scrolled 400px: 300 of 600 rows in view');
});

test('G3 real gate: omid3p adSessionId equals the SDK id on service events', { skip: SKIP }, async () => {
  const { atStart, info } = await result();
  const ids = [...new Set(atStart.map((e) => e.adSessionId))];
  assert.deepEqual(ids, [info.sdkId], 'stand-in sanity on the real binary');
  assert.equal(info.relayId, info.sdkId, 'the bridge relays getAdSessionId(), not placementSessionId');
});

test('G3 real gate: contentUrl follows publisherContext.pageUrl, never the page URL', { skip: SKIP }, async () => {
  const { atStart, pageUrl } = await result();
  const ss = atStart.find((e) => e.type === 'sessionStart');
  assert.ok(ss, 'service sessionStart observed');
  assert.notEqual(ss.data.contentUrl, pageUrl);
  assert.equal(ss.data.contentUrl, 'https://publisher.example/');
});

// Late-SDK-load catch-up: the session starts in the same task as the ACTIVE
// catch-up (_createSessionWhenReady -> _signalActiveStateIfNeeded), before
// omweb's IntersectionObserver has delivered. The designed rule: on the web
// path, impressionOccurred() waits for the first IntersectionObserver delivery
// for the slot after start() (W3C IntersectionObserver: observers are notified
// in creation order, so a SHARC observer created after omweb's fires after it).
test('G3 real gate: impression signalled in the session-start task still carries adView', { skip: SKIP }, async () => {
  const { atStart } = await sameTaskResult();
  const imp = atStart.find((e) => e.type === 'impression');
  assert.ok(imp && imp.data && imp.data.adView,
    'late-SDK-load catch-up: service impression has no adView because it was signalled before omweb measured (got '
    + JSON.stringify(imp && imp.data) + ')');
});
